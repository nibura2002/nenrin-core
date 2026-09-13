import { GENESIS, eventHash } from './chain.js';
import { verifyHex } from './keys.js';
import { verifyReceipt } from './mockAnchor.js';

// 検証は2系統に分けて報告する:
//   内部整合性 = チェーン構造・ハッシュ・本人署名 (ローカルだけで再計算できる)
//   外部突合   = アンカー受領証とサーバー記録の一致 (これが「事後改ざん不可」の本体)
// opts.verifyReceipt で受領証の検証関数を差し替え可能(既定はモックHMAC。実サーバーはEd25519)
// 端末時計の許容ズレ。ack の ts_wall はサーバー応答を受け取った直後に打たれるので、
// 正常時の差は往復遅延ぶん(実測 27〜55ms)しかない。分単位で外れていたら端末時計が狂っている。
const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;
const ZERO_SHA = /^(sha256:)?0+$/i;

export function verifyWork(meta, events, serverRecords, opts = {}) {
  const checkReceipt = opts.verifyReceipt ?? verifyReceipt;
  const skewTolerance = opts.clockSkewToleranceMs ?? CLOCK_SKEW_TOLERANCE_MS;
  const t0 = performance.now();
  const errors = {
    structure: [], hashes: [], checkpoints: [], ack_vs_chain: [], ack_vs_server: [], server_sig: [], export: [], clock: [],
  };

  let prev = GENESIS;
  const ackSeen = new Map();

  events.forEach((e, i) => {
    if (e.seq !== i + 1) errors.structure.push(`seq不連続: index ${i} で seq=${e.seq}`);
    if (e.prev !== prev) errors.structure.push(`リンク切れ: seq=${e.seq}`);
    const recomputed = eventHash(e.prev, {
      v: e.v, seq: e.seq, ts_wall: e.ts_wall, ts_mono: e.ts_mono, type: e.type, payload: e.payload, prev: e.prev,
    });
    if (recomputed !== e.hash) errors.hashes.push(`ハッシュ不一致: seq=${e.seq} (${e.type})`);
    prev = e.hash;

    if (e.type === 'core.checkpoint') {
      const expectedHead = i > 0 ? events[i - 1].hash : GENESIS;
      if (e.payload.head !== expectedHead) errors.checkpoints.push(`checkpoint headずれ: seq=${e.seq}`);
      if (!verifyHex(meta.public_key_der_hex, e.payload.head, e.payload.sig))
        errors.checkpoints.push(`本人署名が無効: seq=${e.seq}`);
    }

    if (e.type === 'core.anchor_ack') {
      const p = e.payload;
      if (i === 0 || p.chain_head !== events[i - 1].hash)
        errors.ack_vs_chain.push(`ackのchain_headが直前イベントと不一致: seq=${e.seq}`);
      ackSeen.set(p.anchor_id, p);
      const rec = serverRecords.find((r) => r.anchor_id === p.anchor_id);
      if (!rec) {
        errors.ack_vs_server.push(`サーバーに存在しないanchor_id: ${p.anchor_id} (seq=${e.seq})`);
      } else {
        if (rec.chain_head !== p.chain_head)
          errors.ack_vs_server.push(`チェーン先頭がサーバー記録と不一致: ${p.anchor_id} (seq=${e.seq})`);
        if (rec.received_at !== p.received_at)
          errors.ack_vs_server.push(`受領時刻がサーバー記録と不一致: ${p.anchor_id}`);
      }
      if (!checkReceipt(p)) errors.server_sig.push(`サーバー受領証の署名が無効: ${p.anchor_id} (seq=${e.seq})`);

      // 端末時計 vs サーバー受領時刻。狂った時計で記録された絶対時刻を PASS させない。
      const skew = Date.parse(e.ts_wall) - Date.parse(p.received_at);
      if (!Number.isFinite(skew)) {
        errors.clock.push(`時刻を解釈できない: ${p.anchor_id} (seq=${e.seq})`);
      } else if (Math.abs(skew) > skewTolerance) {
        errors.clock.push(`端末時計がサーバー受領時刻と乖離: ${p.anchor_id} (${Math.round(skew / 1000)}秒)`);
      }
    }
  });

  for (const rec of serverRecords) {
    if (!ackSeen.has(rec.anchor_id))
      errors.ack_vs_server.push(`サーバー記録 ${rec.anchor_id} がチェーンに現れない`);
  }

  // 成果物の実在性。イベントの有無だけでは「作品ファイルを1件も捕捉できなかった記録」が
  // ゼロハッシュのまま PASS してしまう(監視フォルダを外していると実際に起きる)。
  const exports = events.filter((e) => e.type === 'core.export');
  if (!exports.length) {
    errors.export.push('core.export イベントが存在しない');
  } else {
    for (const e of exports) {
      const sha = e.payload?.sha256;
      if (!sha) errors.export.push(`core.export にハッシュが無い (seq=${e.seq})`);
      else if (ZERO_SHA.test(sha)) errors.export.push(`core.export のハッシュが空 = 作品ファイル未捕捉 (seq=${e.seq})`);
    }
  }

  const ms = performance.now() - t0;
  const internalOk = !errors.structure.length && !errors.hashes.length && !errors.checkpoints.length && !errors.ack_vs_chain.length;
  const externalOk = !errors.ack_vs_server.length && !errors.server_sig.length && !errors.clock.length;
  return {
    internal_ok: internalOk,
    external_ok: externalOk,
    ok: internalOk && externalOk && !errors.export.length,
    errors,
    stats: { events: events.length, anchors: serverRecords.length, verify_ms: Math.round(ms), events_per_sec: Math.round(events.length / (ms / 1000)) },
  };
}

export function formatReport(name, r) {
  const mark = (ok) => (ok ? '✓' : '✗');
  const lines = [];
  lines.push(`━━ 検証レポート: ${name}`);
  lines.push(`  [内部整合性] ${mark(r.internal_ok)}  構造 ${mark(!r.errors.structure.length)} / ハッシュ再計算 ${mark(!r.errors.hashes.length)} / 本人署名 ${mark(!r.errors.checkpoints.length)} / ack整合 ${mark(!r.errors.ack_vs_chain.length)}`);
  lines.push(`  [外部突合]   ${mark(r.external_ok)}  サーバー記録との一致 ${mark(!r.errors.ack_vs_server.length)} / 受領証署名 ${mark(!r.errors.server_sig.length)} / 端末時計 ${mark(!r.errors.clock.length)}`);
  lines.push(`  [成果物]     ${mark(!r.errors.export.length)}  export イベントと作品ハッシュ`);
  lines.push(`  総合: ${r.ok ? 'PASS' : 'FAIL'}   (${r.stats.events.toLocaleString()} イベント / 検証 ${r.stats.verify_ms}ms / ${r.stats.events_per_sec.toLocaleString()} ev/s / アンカー ${r.stats.anchors})`);
  const all = Object.entries(r.errors).flatMap(([k, v]) => v.map((m) => `    - [${k}] ${m}`));
  if (all.length) {
    lines.push(`  検出された問題 (先頭${Math.min(all.length, 6)}件/${all.length}件):`);
    lines.push(...all.slice(0, 6));
  }
  return lines.join('\n');
}

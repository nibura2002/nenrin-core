// 提出されたチェーンのサーバー側検証(loop-poc/verify.js の発行API向け移植)。
// loop-pocとの差分: 「サーバーの全アンカーがチェーンに現れる」チェックは行わない
// (長寿命の鍵は複数作品にまたがるため、ackが受領記録の正当な部分集合であることを検証する)。
import { createHash } from 'node:crypto';
import { canonical, edVerify } from './crypto';

export type ChainEvent = {
  v: number; seq: number; ts_wall: string; ts_mono: number;
  type: string; payload: Record<string, unknown>; prev: string; hash: string;
};

export type AnchorRecord = {
  anchor_id: string; key_id: string; seq: number; chain_head: string; received_at: string; server_sig: string;
};

const GENESIS = 'sha256:' + '0'.repeat(64);
// 端末時計の許容ズレ。ackのts_wallとサーバー受領時刻の差は正常時 往復遅延ぶん(実測27〜55ms)。
const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;
const ZERO_SHA = /^(sha256:)?0+$/i;

function eventHash(prev: string, env: Omit<ChainEvent, 'hash'>): string {
  const h = createHash('sha256');
  h.update(prev);
  h.update(canonical(env));
  return 'sha256:' + h.digest('hex');
}

export type VerifyResult = {
  internal_ok: boolean;
  external_ok: boolean;
  ok: boolean;
  errors: Record<string, string[]>;
  stats: { events: number; anchors_checked: number };
  anchors_used: AnchorRecord[];
};

export function verifySubmittedChain(
  events: ChainEvent[],
  clientPubDerHex: string,
  anchorsById: Map<string, AnchorRecord>,
  serverPubDerHex: string,
  expectedKeyId: string,
): VerifyResult {
  const errors: Record<string, string[]> = {
    structure: [], hashes: [], checkpoints: [], ack_vs_chain: [], ack_vs_server: [], server_sig: [], export: [], clock: [],
  };
  const anchorsUsed: AnchorRecord[] = [];
  let prev = GENESIS;

  events.forEach((e, i) => {
    if (e.seq !== i + 1) errors.structure.push(`seq不連続: index ${i}`);
    if (e.prev !== prev) errors.structure.push(`リンク切れ: seq=${e.seq}`);
    const recomputed = eventHash(e.prev, {
      v: e.v, seq: e.seq, ts_wall: e.ts_wall, ts_mono: e.ts_mono, type: e.type, payload: e.payload, prev: e.prev,
    });
    if (recomputed !== e.hash) errors.hashes.push(`ハッシュ不一致: seq=${e.seq}`);
    prev = e.hash;

    if (e.type === 'core.checkpoint') {
      const p = e.payload as { head?: string; sig?: string };
      const expectedHead = i > 0 ? events[i - 1].hash : GENESIS;
      if (p.head !== expectedHead) errors.checkpoints.push(`checkpoint headずれ: seq=${e.seq}`);
      if (!p.head || !p.sig || !edVerify(clientPubDerHex, p.head, p.sig))
        errors.checkpoints.push(`本人署名が無効: seq=${e.seq}`);
    }

    if (e.type === 'core.anchor_ack') {
      const p = e.payload as { anchor_id?: string; chain_head?: string; received_at?: string; server_sig?: string };
      if (i === 0 || p.chain_head !== events[i - 1].hash)
        errors.ack_vs_chain.push(`ackのchain_headが直前イベントと不一致: seq=${e.seq}`);
      const rec = p.anchor_id ? anchorsById.get(p.anchor_id) : undefined;
      if (!rec) {
        errors.ack_vs_server.push(`受領記録なし: ${p.anchor_id}`);
      } else {
        if (rec.chain_head !== p.chain_head || rec.received_at !== p.received_at || rec.key_id !== expectedKeyId)
          errors.ack_vs_server.push(`受領記録と不一致: ${p.anchor_id}`);
        anchorsUsed.push(rec);
      }
      if (!p.anchor_id || !edVerify(serverPubDerHex, `${p.anchor_id}|${p.chain_head}|${p.received_at}`, p.server_sig ?? ''))
        errors.server_sig.push(`受領証署名が無効: ${p.anchor_id}`);

      // 端末時計 vs サーバー受領時刻。ackのts_wallはサーバー応答の直後に打たれるため、
      // 正常時の差は往復遅延ぶんしかない。分単位で外れていたら記録された絶対時刻が信用できない。
      const skew = Date.parse(e.ts_wall) - Date.parse(p.received_at ?? '');
      if (!Number.isFinite(skew)) errors.clock.push(`時刻を解釈できない: ${p.anchor_id}`);
      else if (Math.abs(skew) > CLOCK_SKEW_TOLERANCE_MS)
        errors.clock.push(`端末時計がサーバー受領時刻と乖離: ${p.anchor_id} (${Math.round(skew / 1000)}秒)`);
    }
  });

  // 成果物の実在性。イベントの有無だけでは、作品ファイルを1件も捕捉できなかった記録が
  // ゼロハッシュのまま PASS してしまう(記録側が監視フォルダを外していると実際に起きる)。
  const exports = events.filter((e) => e.type === 'core.export');
  if (!exports.length) {
    errors.export.push('core.export イベントが存在しない');
  } else {
    for (const e of exports) {
      const sha = (e.payload as { sha256?: string } | undefined)?.sha256;
      if (!sha) errors.export.push(`core.export にハッシュが無い (seq=${e.seq})`);
      else if (ZERO_SHA.test(sha)) errors.export.push(`core.export のハッシュが空 = 作品ファイル未捕捉 (seq=${e.seq})`);
    }
  }

  const internal_ok = !errors.structure.length && !errors.hashes.length && !errors.checkpoints.length && !errors.ack_vs_chain.length;
  const external_ok = !errors.ack_vs_server.length && !errors.server_sig.length && !errors.clock.length && anchorsUsed.length > 0;
  return {
    internal_ok,
    external_ok,
    ok: internal_ok && external_ok && !errors.export.length,
    errors,
    stats: { events: events.length, anchors_checked: anchorsUsed.length },
    anchors_used: anchorsUsed,
  };
}

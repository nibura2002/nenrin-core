import { randomUUID } from 'node:crypto';
import { ChainWriter } from '../chain.js';
import { generateKeys, signHex, privateKeyToPem } from '../keys.js';
import { MockAnchorServer } from '../mockAnchor.js';
import { makeRng } from '../rng.js';

const MIN = 60e3;
const JST = 9 * 3600e3;
const iso = (ms) => new Date(ms + JST).toISOString().replace('Z', '+09:00');

export const PROFILES = {
  // 長期コツコツ型(Tier A: 意味的イベントが取れるツールを想定)
  steady: { tier: 'A', title: '藍の午後', tool: 'paint-tool (simulated / Tier A)', seed: 11, days: 9, sessionCount: 14, sessionMinutes: [60, 150] },
  // 短期集中型(Tier A)
  sprint: { tier: 'A', title: '週末の全力', tool: 'paint-tool (simulated / Tier A)', seed: 22, days: 2, sessionCount: 4, sessionMinutes: [180, 300] },
  // CSPの現実形態(Tier B: セッション+保存スナップショット+入力活動のみ)
  tierb: {
    tier: 'B', title: '海と手紙', tool: 'clip-studio-paint (simulated / Tier B)', seed: 33, days: 7, sessionCount: 10, sessionMinutes: [50, 140],
    timelapse: { frames_at_first_save: 28, frames_at_export: 2600 },
  },
  // 途中参加+未観測ギャップ(Tier B): 既存ファイルを監視開始時に発見(=ベースライン固定)し、
  // 中盤に監視停止期間を挟んで再発見時に再固定する。カバレッジモデル(coverage_model_v01)の年輪表現検証用。
  midstart: {
    tier: 'B', title: '灯下の写生帖', tool: 'clip-studio-paint (simulated / Tier B)', seed: 44,
    days: 6, sessionCount: 8, sessionMinutes: [50, 130],
    preexisting: { timelapse_frames: 1240, file_age_days: 12 },
    gap: { afterSession: 4, days: 3, timelapse_frames_at_rediscovery: 2210 },
    timelapse: { frames_at_export: 3400 },
  },
};

function pickTool(rng, progress) {
  const table =
    progress < 0.3
      ? [['pencil', 0.68], ['eraser', 0.15], ['pen', 0.1], ['other', 0.07]]
      : progress < 0.55
        ? [['pen', 0.62], ['eraser', 0.18], ['pencil', 0.08], ['brush', 0.07], ['other', 0.05]]
        : [['brush', 0.58], ['pen', 0.16], ['eraser', 0.16], ['other', 0.1]];
  let x = rng.f();
  for (const [k, w] of table) if ((x -= w) < 0) return k;
  return 'other';
}

export function simulate(profileName) {
  const P = PROFILES[profileName];
  if (!P) throw new Error('unknown profile: ' + profileName);
  const rng = makeRng(P.seed);
  const keys = generateKeys();
  const chain = new ChainWriter();
  const server = new MockAnchorServer();
  const workId = randomUUID();

  const dayZero = Date.parse('2026-08-01T00:00:00+09:00');
  // セッション開始スロット(13:00〜21:00の間で日をまたいで分散)。gap指定があれば以降のセッションを後ろへずらす
  const slots = [];
  for (let i = 0; i < P.sessionCount; i++) {
    let day = Math.floor((i * P.days) / P.sessionCount);
    if (P.gap && i >= P.gap.afterSession) day += P.gap.days;
    slots.push(dayZero + day * 86400e3 + rng.int(13 * 60, 21 * 60) * MIN + rng.int(0, 59) * 1000);
  }
  slots.sort((a, b) => a - b);

  const workStart = slots[0] - 1 * MIN;
  const mono = (ms) => ms - workStart;
  const append = (type, payload, tMs) => chain.append(type, payload, iso(tMs), mono(tMs));

  const meta = {
    schema: 'loop-poc/1',
    work_id: workId,
    title: P.title,
    profile: profileName,
    tier: P.tier,
    tool: P.tool,
    handle: '@haruno_sample',
    started_at: iso(workStart),
    key_id: keys.keyId,
    public_key_der_hex: keys.publicDerHex,
  };

  // checkpoint(本人署名)→ サーバーへ預け入れ → 受領証をチェーンに編み込む
  const anchorNow = (tMs) => {
    const head = chain.head();
    const cp = append('core.checkpoint', { head, key_id: keys.keyId, sig: signHex(keys.privateKey, head) }, tMs);
    const sentHead = chain.head(); // == cp.hash
    const receivedAt = iso(tMs + rng.int(200, 1400));
    const record = server.receive({ key_id: keys.keyId, seq: cp.seq, chain_head: sentHead }, receivedAt);
    append(
      'core.anchor_ack',
      { anchor_id: record.anchor_id, chain_head: sentHead, received_at: record.received_at, server_sig: record.server_sig },
      tMs + rng.int(1500, 1900),
    );
  };

  append('core.work_start', {
    work_id: workId, tool: P.tool, tool_version: '4.0.0-sim', plugin_version: '0.0.1-poc', key_id: keys.keyId, schema_v: 1,
  }, workStart);

  // ベースライン固定(coverage_model_v01): 全記録の必須イベント。初回観測(監視開始時に既存ファイルを
  // 発見 / 監視下で初回保存を観測)と再発見時に、その時点のファイル状態をアンカーし「存在証明」として固定する。
  // 「作成から観測した」という二値の主張はせず、初回観測時点の状態(ほぼ空か、大きいか)を事実として示す。
  const baselineAt = (tMs, reason, extra = {}) => {
    append('core.baseline', {
      reason, sha256: rng.hex(64), bytes: 5_000_000 + rng.int(0, 9_000_000), ...extra,
    }, tMs);
    anchorNow(tMs + 2000);
  };
  let fileSeen = false;
  if (P.preexisting) {
    baselineAt(workStart + 5000, 'watch_start', {
      timelapse_frame_count: P.preexisting.timelapse_frames,
      file_mtime_wall: iso(workStart - P.preexisting.file_age_days * 86400e3),
    });
    fileSeen = true;
  }

  const plannedTotal = P.sessionCount * ((P.sessionMinutes[0] + P.sessionMinutes[1]) / 2) * MIN;
  let activeSoFar = 0;
  let cursor = 0;
  let lastEnd = workStart;

  for (let s = 0; s < P.sessionCount; s++) {
    const startT = Math.max(slots[s], cursor + 30 * MIN);
    const durMin = rng.int(P.sessionMinutes[0], P.sessionMinutes[1]);
    const endT = startT + durMin * MIN;
    let t = startT;

    // 未観測期間明けの再発見: 最後に知っている状態と異なるハッシュ=ギャップ中のファイル変更として検知される
    if (P.gap && s === P.gap.afterSession) {
      baselineAt(startT - 2 * MIN, 'rediscovery', {
        timelapse_frame_count: P.gap.timelapse_frames_at_rediscovery,
      });
    }

    append('core.session_start', { session_id: 's' + String(s + 1).padStart(2, '0') }, t);
    anchorNow(t + 2000);
    t += 5000;

    let nextAnchor = t + 10 * MIN;
    let nextSnap = t + rng.int(8, 12) * MIN;
    let pauseAt = durMin > 40 && rng.chance(0.4) ? startT + rng.int(15, durMin - 20) * MIN : null;

    while (t < endT) {
      const dt = rng.chance(0.12) ? rng.int(25e3, 110e3) : rng.int(2100, 15000);
      t += dt;
      if (t >= endT) break;

      if (pauseAt && t >= pauseAt) {
        append('core.pause', {}, t);
        t += rng.int(8, 25) * MIN;
        append('core.resume', {}, t);
        pauseAt = null;
        nextSnap = t + rng.int(8, 12) * MIN;
        nextAnchor = Math.max(nextAnchor, t + 2 * MIN);
        continue;
      }

      if (P.tier === 'A') {
        activeSoFar += dt;
        append('sim.stroke', {
          tool_class: pickTool(rng, activeSoFar / plannedTotal),
          duration_ms: rng.int(120, 2600),
          point_count: rng.int(15, 520),
        }, t);
      } else {
        // Tier B: 60秒ごとのアクティビティ・ハートビートのみ(入力の有無と量)
        activeSoFar += dt;
        if (dt < 55e3) {
          t += rng.int(45e3, 60e3) - dt > 0 ? 0 : 0;
        }
        append('sim.activity', { input_count: rng.int(40, 220) }, t);
        t += rng.int(45e3, 75e3); // 次のハートビートまで
      }

      if (t >= nextSnap) {
        // 初回保存 = ファイルの初回観測。スナップショットに先立ちベースラインを固定する
        // (アンカー受領までを保存時刻より前に収め、ts単調性を保つ)
        if (!fileSeen) {
          baselineAt(t - 6000, 'file_first_seen',
            P.timelapse?.frames_at_first_save != null ? { timelapse_frame_count: P.timelapse.frames_at_first_save } : {});
          fileSeen = true;
        }
        append('core.snapshot', { sha256: rng.hex(64), bytes: 5_000_000 + rng.int(0, 9_000_000) }, t);
        nextSnap = t + rng.int(8, 12) * MIN;
      }
      if (t >= nextAnchor) {
        anchorNow(t);
        nextAnchor = t + 10 * MIN;
      }
    }

    append('core.session_end', {}, endT);
    anchorNow(endT + 2000);
    cursor = endT;
    lastEnd = endT;
  }

  const exportT = lastEnd + 5 * MIN;
  append('core.export', {
    sha256: rng.hex(64), format: 'png', bytes: 3_000_000 + rng.int(0, 5_000_000),
    ...(P.timelapse?.frames_at_export != null ? { timelapse_frame_count: P.timelapse.frames_at_export } : {}),
  }, exportT);
  anchorNow(exportT + 2000);

  return {
    meta,
    events: chain.events,
    anchors: server.records,
    privateKeyPem: privateKeyToPem(keys.privateKey),
  };
}

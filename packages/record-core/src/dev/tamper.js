import { eventHash } from '../chain.js';
import { signHex, privateKeyFromPem } from '../keys.js';

// 攻撃デモ。攻撃者 = 本人(鍵とローカルデータを完全に掌握している)を想定する。
//   edit:      過去のイベントを書き換えるだけ(ハッシュ再計算なし) → 内部検証で即検知
//   recompute: 書き換え後にチェーン全体を再計算し、本人署名もやり直す(本人には可能)。
//              内部整合性は完全に取り戻せるが、サーバーが保持する受領証の
//              chain_head は書き換えられないため、外部突合で検知される。
export function tamper(events, mode, privateKeyPem) {
  const out = events.map((e) => ({ ...e, payload: { ...e.payload } }));
  const idx = out.findIndex((e, i) => i > out.length * 0.4 && (e.type === 'sim.stroke' || e.type === 'sim.activity'));
  if (idx < 0) throw new Error('改ざん対象イベントが見つからない');

  // 「作業時間を盛る」改ざん: ストローク時間を100倍にする
  const target = out[idx];
  if (target.type === 'sim.stroke') target.payload.duration_ms = target.payload.duration_ms * 100;
  else target.payload.input_count = target.payload.input_count * 100;

  if (mode === 'edit') return { events: out, tamperedSeq: target.seq };

  if (mode === 'recompute') {
    const priv = privateKeyFromPem(privateKeyPem);
    let prev = idx > 0 ? out[idx - 1].hash : out[0].prev;
    for (let i = idx; i < out.length; i++) {
      const e = out[i];
      e.prev = prev;
      if (e.type === 'core.checkpoint') {
        e.payload.head = prev;
        e.payload.sig = signHex(priv, prev); // 本人は再署名できてしまう
      }
      if (e.type === 'core.anchor_ack') {
        e.payload.chain_head = prev; // 内部整合は取れるが、受領証(server_sig)は偽造できない
      }
      e.hash = eventHash(prev, { v: e.v, seq: e.seq, ts_wall: e.ts_wall, ts_mono: e.ts_mono, type: e.type, payload: e.payload, prev: e.prev });
      prev = e.hash;
    }
    return { events: out, tamperedSeq: target.seq };
  }

  throw new Error('unknown mode: ' + mode);
}

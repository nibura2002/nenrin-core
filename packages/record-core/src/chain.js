import { createHash } from 'node:crypto';
import { canonical } from './canonical.js';

export const GENESIS = 'sha256:' + '0'.repeat(64);

// hash = SHA-256( prev || canonical(envelope without `hash`) )  — record_schema_v01 §3
export function eventHash(prev, envelopeSansHash) {
  const h = createHash('sha256');
  h.update(prev);
  h.update(canonical(envelopeSansHash));
  return 'sha256:' + h.digest('hex');
}

// events: 既存チェーン(events.jsonl から読み戻したもの)。末尾から seq / prev を復元して続きを積む。
// onAppend: イベント確定ごとに呼ばれる(記録側はここでディスクへ追記する)。
export class ChainWriter {
  constructor({ events = [], onAppend = null } = {}) {
    this.events = events;
    const last = events.length ? events[events.length - 1] : null;
    this.seq = last ? last.seq : 0;
    this.prev = last ? last.hash : GENESIS;
    this.onAppend = onAppend;
  }

  append(type, payload, tsWall, tsMono) {
    this.seq += 1;
    const env = { v: 1, seq: this.seq, ts_wall: tsWall, ts_mono: tsMono, type, payload, prev: this.prev };
    const hash = eventHash(this.prev, env);
    const full = { ...env, hash };
    this.prev = hash;
    this.events.push(full);
    if (this.onAppend) this.onAppend(full);
    return full;
  }

  head() {
    return this.prev;
  }
}

// events.jsonl のテキストをイベント配列に戻す。
// 末尾の壊れた行(書き込み途中で電源が落ちた等)は捨てて `dropped` に返す。途中の行が壊れている
// (=末尾以外)場合はチェーンとして使えないので投げる。リンクの検証はここではしない(verify.js の仕事)。
export function parseEventLog(text) {
  const lines = text.split('\n');
  const events = [];
  let dropped = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      const rest = lines.slice(i + 1).some((l) => l.trim());
      if (rest) throw new Error(`events.jsonl の途中(${i + 1}行目)が壊れています`);
      dropped = 1;
      break;
    }
  }
  return { events, dropped };
}

// 実行: npm test(packages/record-core で。単体なら node --test test/chain.test.mjs)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChainWriter, parseEventLog, GENESIS, eventHash } from '../src/chain.js';

const build = (n) => {
  const w = new ChainWriter();
  for (let i = 0; i < n; i++) w.append('sim.activity', { input_count: 1 }, new Date(i * 1000).toISOString(), i * 1000);
  return w;
};

test('resumed writer continues seq/prev from the last event and keeps hashes linked', () => {
  const first = build(3);
  const appended = [];
  const resumed = new ChainWriter({ events: first.events.slice(), onAppend: (e) => appended.push(e) });
  assert.equal(resumed.seq, 3);
  assert.equal(resumed.head(), first.events[2].hash);
  const e4 = resumed.append('core.restart', { reason: 'app_start' }, new Date(0).toISOString(), 0);
  assert.equal(e4.seq, 4);
  assert.equal(e4.prev, first.events[2].hash);
  assert.equal(appended.length, 1);
  // 全イベントのリンクとハッシュが再計算で一致する(verify.js と同じ規則)
  let prev = GENESIS;
  for (const e of resumed.events) {
    assert.equal(e.prev, prev);
    const { hash, ...env } = e;
    assert.equal(eventHash(e.prev, env), hash);
    prev = hash;
  }
});

test('empty writer starts from GENESIS (backward compatible)', () => {
  const w = new ChainWriter();
  assert.equal(w.seq, 0);
  assert.equal(w.head(), GENESIS);
});

test('parseEventLog drops a truncated last line and reports it', () => {
  const w = build(3);
  const text = w.events.map((e) => JSON.stringify(e)).join('\n') + '\n' + '{"v":1,"seq":4,"ts_wa';
  const { events, dropped } = parseEventLog(text);
  assert.equal(events.length, 3);
  assert.equal(dropped, 1);
});

test('parseEventLog accepts a clean file with trailing newline', () => {
  const w = build(2);
  const { events, dropped } = parseEventLog(w.events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  assert.equal(events.length, 2);
  assert.equal(dropped, 0);
});

test('parseEventLog throws when a middle line is corrupt', () => {
  const w = build(3);
  const lines = w.events.map((e) => JSON.stringify(e));
  lines[1] = lines[1].slice(0, 20);
  assert.throws(() => parseEventLog(lines.join('\n') + '\n'), /途中/);
});

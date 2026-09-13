// 実行: npm test(packages/record-core で)
//
// Logic Pro アダプタのエンジン単位テスト(daw_adapter_v01 §7 D1 の完了条件):
// 前面アプリが Logic Pro のセッション中に .logicx パッケージが保存されると、スナップショット・公開候補・
// 発行(core.export の format='logicx-project')が CSP と同じ経路で成立する。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeys, signHex } from '../src/keys.js';

const HOME = mkdtempSync(join(tmpdir(), 'nenrin-logic-home-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
const { createRecorder } = await import('../src/engine.js');

// ── アンカー/発行サーバーのスタブ。受領証は実際に ed25519 で署名する
// (verify.js が署名を検証するので、HMAC のモックでは publish が通らない)。
const serverKeys = generateKeys();
let anchors = [];
let httpServer = null;
let SERVER = '';

function startStubServer() {
  return new Promise((resolve) => {
    httpServer = createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const send = (obj) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const body = [];
      req.on('data', (c) => body.push(c));
      req.on('end', () => {
        const json = body.length ? JSON.parse(Buffer.concat(body).toString('utf8')) : {};
        if (url.pathname === '/health') return send({ ok: true });
        if (url.pathname === '/keys') return send({ ok: true });
        if (url.pathname === '/pubkey') return send({ public_key_der_hex: serverKeys.publicDerHex });
        if (url.pathname === '/anchors' && req.method === 'POST') {
          const anchor_id = 'a' + String(anchors.length + 1).padStart(4, '0');
          const received_at = new Date().toISOString();
          const rec = {
            anchor_id, key_id: json.key_id, seq: json.seq, chain_head: json.chain_head, received_at,
            server_sig: signHex(serverKeys.privateKey, `${anchor_id}|${json.chain_head}|${received_at}`),
          };
          anchors.push(rec);
          return send(rec);
        }
        if (url.pathname === '/anchors') return send({ anchors });
        if (url.pathname === '/publish') {
          return send({ url: 'https://example.invalid/w/deadbeef', certificate: { stub: true }, has_thumb: false });
        }
        res.writeHead(404); res.end('{}');
      });
    });
    httpServer.listen(0, '127.0.0.1', () => {
      SERVER = `http://127.0.0.1:${httpServer.address().port}`;
      resolve();
    });
  });
}

before(startStubServer);
after(() => {
  httpServer?.close();
  rmSync(HOME, { recursive: true, force: true });
});


const waitFor = async (predicate, timeoutMs = 8000) => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) { if (predicate()) return true; await new Promise((r) => setTimeout(r, 50)); }
  return false;
};
const saveLogic = (root, version) => {
  mkdirSync(join(root, 'Alternatives', '000'), { recursive: true });
  mkdirSync(join(root, 'Resources'), { recursive: true });
  writeFileSync(join(root, 'Alternatives', '000', 'ProjectData'), 'PD-' + version);
  writeFileSync(join(root, 'Alternatives', '000', 'MetaData.plist'), 'meta');
  writeFileSync(join(root, 'Alternatives', '000', 'DisplayState.plist'), 'ui-' + Math.random());
  writeFileSync(join(root, 'Resources', 'ProjectInformation.plist'), 'info');
};

test('Logic Pro のセッションで .logicx の保存が記録され、logicx-project として発行できる', { timeout: 30000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'nenrin-logic-'));
  const worksDir = join(root, 'works');
  const watchDir = join(root, 'watch');
  mkdirSync(watchDir, { recursive: true });
  const platform = { frontmostApp: () => 'Logic Pro', idleSeconds: () => 0 };
  const rec = createRecorder({ server: SERVER, worksDir, roots: [watchDir], platform, intervalSec: 0.05, anchorIntervalSec: 3600, sessionEndGraceSec: 0.05, onLog: () => {} });
  await rec.start();
  try {
  assert.ok(await waitFor(() => rec.status().sessionActive), 'Logic Pro が前面ならセッションが開く');
  assert.equal(rec.status().sessionTool, 'logic-pro');

  // 保存 1 回目(パッケージ内の複数ファイルが短時間に書かれる → 1 回のスナップショットに)
  const pkg = join(watchDir, 'Song.logicx');
  saveLogic(pkg, 1);
  assert.ok(await waitFor(() => rec.status().snapshotCount === 1), '保存でスナップショットが 1 つ積まれる');
  const c1 = rec.listCandidates();
  assert.equal(c1.length, 1);
  assert.equal(c1[0].path, pkg);
  assert.equal(c1[0].tool, 'logic-pro');
  assert.equal(c1[0].toolName, 'Logic Pro');
  // UI 状態だけの変更は保存ではない
  writeFileSync(join(pkg, 'Alternatives', '000', 'DisplayState.plist'), 'ui-only');
  await new Promise((r) => setTimeout(r, 2600));
  assert.equal(rec.status().snapshotCount, 1, 'DisplayState の変更ではスナップショットが増えない');
  // 保存 2 回目
  saveLogic(pkg, 2);
  assert.ok(await waitFor(() => rec.status().snapshotCount === 2), '2 回目の保存');
  assert.equal(rec.listCandidates()[0].snapshots, 2);

  // 書き出し音源: セッション中に記録するフォルダへ新しくできた wav が候補になる
  writeFileSync(join(watchDir, 'bounce.wav'), 'RIFF....WAVEfake');
  assert.ok(await waitFor(() => rec.listArtifacts().length === 1), '書き出し候補が 1 件');
  assert.equal(rec.listArtifacts()[0].name, 'bounce.wav');
  const r = await rec.publish({ publish: true, disclosure: 2, artifactPath: join(watchDir, 'bounce.wav') });
  assert.equal(r.ok, true, '検証 PASS');
  assert.equal(r.published?.url, 'https://example.invalid/w/deadbeef');
  const events = JSON.parse('[' + readFileSync(join(rec.status().workDir, 'events.jsonl'), 'utf8').trim().split('\n').join(',') + ']');
  const exp = events.find((e) => e.type === 'core.export');
  assert.equal(exp.payload.format, 'logicx-project');
  assert.equal(exp.payload.tool, 'logic-pro');
  assert.equal(exp.payload.artifact.name, 'bounce.wav');
  assert.equal(exp.payload.artifact.format, 'wav');
  assert.equal(exp.payload.artifact.bytes, 'RIFF....WAVEfake'.length);
  const snaps = events.filter((e) => e.type === 'core.snapshot');
  assert.equal(snaps[0].payload.tool_stats.alternatives, 1, 'スナップショットに統計が載る');
  const summary = JSON.parse(readFileSync(join(r.outDir, 'summary.json'), 'utf8'));
  assert.equal(summary.tool, 'logic-pro');
  assert.equal(summary.export_artifact.name, 'bounce.wav');
  assert.equal(summary.tool_stats_last.alternatives, 1);
  assert.equal(events.find((e) => e.type === 'core.session_start').payload.tool, 'logic-pro');
  assert.equal(events.filter((e) => e.type === 'core.snapshot').every((e) => e.payload.tool === 'logic-pro'), true);
  const meta = JSON.parse(readFileSync(join(rec.status().workDir, 'meta.json'), 'utf8'));
  assert.equal(meta.tool, 'logic-pro');
  assert.equal(meta.title, 'Song.logicx');
  assert.deepEqual(meta.tools_enabled, ['clip-studio-paint', 'logic-pro']);
  } finally {
    await rec.stop(); // 失敗時も監視とタイマーを閉じる(開いたままだと node --test が終わらない)
    rmSync(root, { recursive: true, force: true });
  }
});


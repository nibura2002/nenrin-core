// 実行: npm test(packages/record-core で。単体なら node --test test/lifecycle.test.mjs)
//
// 作品ライフサイクル(l2_lifecycle_v01 §2.2 / §3.2)のエンジン単位テスト。
// 狙いは「発行 → 再起動」の順序で、同じ作品が再開されること。
// この順序でしか出ないバグを 2026-08-18 に Windows 実機で踏んだ(発行が meta.status を
// 'published' に書き換え、次回起動が再開対象を見つけられず別の作品を始めていた)。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeys, signHex } from '../src/keys.js';

// 本人鍵(identity.pem)は HOME/USERPROFILE 配下に作られる。実ユーザーの鍵を触らないよう隔離する。
const HOME = mkdtempSync(join(tmpdir(), 'nenrin-lifecycle-home-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
// 環境変数を読むのはモジュール読み込み時なので、差し替えたあとで import する
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

// 前面アプリとアイドル秒は実行環境に依存するので固定する。これでセッションが決定的に開く。
const platform = { frontmostApp: () => 'TestApp', idleSeconds: () => 0 };

function makeRecorder(worksDir, watchDir) {
  return createRecorder({
    server: SERVER, worksDir, roots: [watchDir], platform,
    targetApp: 'TestApp', intervalSec: 0.05, anchorIntervalSec: 3600, sessionEndGraceSec: 0.05,
    onLog: () => {},
  });
}

const waitFor = async (predicate, timeoutMs = 8000) => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

const readMeta = (worksDir) => {
  const dirs = readdirSync(worksDir);
  assert.equal(dirs.length, 1, `works/ の作品は1本のはず (実際: ${dirs.join(', ')})`);
  return JSON.parse(readFileSync(join(worksDir, dirs[0], 'meta.json'), 'utf8'));
};

test('発行しても記録は同じ作品として続き、再起動でその作品を再開する', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nenrin-lifecycle-'));
  const worksDir = join(root, 'works');
  const watchDir = join(root, 'watch');
  mkdirSync(watchDir, { recursive: true });

  // ── 1回目の起動: 記録して発行する
  const r1 = makeRecorder(worksDir, watchDir);
  await r1.start();
  assert.equal(r1.status().resumed, false, '初回は新規の作品から始まる');
  const workId = r1.status().workId;

  // 作品ファイルの保存を1回起こす(export に載せるハッシュが要る)。
  // 中身は .clip でなくてよい — extractClipStats / extractCanvasPreviewB64 は解析できなければ null を返す
  writeFileSync(join(watchDir, 'work.clip'), Buffer.from('not-a-real-clip-file'));
  assert.ok(await waitFor(() => r1.status().snapshotCount > 0), 'snapshot が積まれない');

  const published = await r1.publish({ publish: true, disclosure: 2 });
  assert.ok(published.ok, '発行時の検証が通らない: ' + JSON.stringify(published.result?.errors));
  assert.ok(published.published?.url, '証明書URLが返らない');

  // 発行は記録の終わりではない。status は動かさず、発行の事実は履歴に積む
  const metaAfterPublish = readMeta(worksDir);
  assert.equal(metaAfterPublish.status, 'recording', '発行が status を書き換えている');
  assert.equal(metaAfterPublish.publications.length, 1);
  assert.equal(metaAfterPublish.publications[0].url, 'https://example.invalid/w/deadbeef');
  assert.match(metaAfterPublish.publications[0].dir, /^published\//);

  await r1.stop();

  // ── 2回目の起動: 発行済みでも同じ作品を再開する(ここが回帰点)
  const r2 = makeRecorder(worksDir, watchDir);
  await r2.start();
  assert.equal(r2.status().resumed, true, '発行済みの作品が再開されていない');
  assert.equal(r2.status().workId, workId, '別の作品として記録が始まっている');
  assert.ok(r2.status().eventCount > published.result.stats.events, '再開後にイベントが積み増されていない');

  // 2回目の発行も通り、履歴が積み上がる
  const second = await r2.publish({ publish: true, disclosure: 2 });
  assert.ok(second.ok, '2回目の発行の検証が通らない');
  assert.equal(readMeta(worksDir).publications.length, 2);

  await r2.stop();
  assert.equal(readdirSync(worksDir).length, 1, '作品ディレクトリが増えている');
  rmSync(root, { recursive: true, force: true });
});

test('作品ファイル未捕捉の発行はチェーンを汚さない(空の core.export を積まない)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nenrin-lifecycle-'));
  const worksDir = join(root, 'works');
  const watchDir = join(root, 'watch');
  mkdirSync(watchDir, { recursive: true });

  const r = makeRecorder(worksDir, watchDir);
  await r.start();
  const before = r.status().eventCount;

  const attempt = await r.publish({ publish: true, disclosure: 2 });
  assert.equal(attempt.ok, false);
  assert.equal(attempt.noUserFile, true);
  assert.equal(attempt.published, null);
  assert.equal(r.status().eventCount, before, '発行できないのにイベントが積まれている');

  // 保存してから発行すれば通る。空の export が残っていればここが FAIL になる
  writeFileSync(join(watchDir, 'work.clip'), Buffer.from('not-a-real-clip-file'));
  assert.ok(await waitFor(() => r.status().snapshotCount > 0), 'snapshot が積まれない');
  const ok = await r.publish({ publish: true, disclosure: 2 });
  assert.ok(ok.ok, '未捕捉での発行のあと、保存してからの発行が通らない: ' + JSON.stringify(ok.result?.errors));

  await r.stop();
  rmSync(root, { recursive: true, force: true });
});

test('停止しても status は recording のままで、次回起動が読み戻す', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nenrin-lifecycle-'));
  const worksDir = join(root, 'works');
  const watchDir = join(root, 'watch');
  mkdirSync(watchDir, { recursive: true });

  const r1 = makeRecorder(worksDir, watchDir);
  await r1.start();
  const workId = r1.status().workId;
  await r1.stop();
  assert.equal(readMeta(worksDir).status, 'recording', '停止が status を書き換えている');

  const r2 = makeRecorder(worksDir, watchDir);
  await r2.start();
  assert.equal(r2.status().resumed, true);
  assert.equal(r2.status().workId, workId);
  await r2.stop();
  rmSync(root, { recursive: true, force: true });
});

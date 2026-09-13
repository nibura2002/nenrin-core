// 記録エンジン — record.js から切り出したライブラリ版。CLI(record.js)とElectron(desktop-poc)が共用する。
// createRecorder(options) → { start(), publish({disclosure, chosenPath}), stop(), finalize(), status(), listCandidates() }
//
// 記録の永続化(l2_lifecycle_v01 §2): イベントは確定のたびに works/<work_id>/events.jsonl へ追記し、
// 起動時に読み戻して続きから積む。「発行するまでメモリにしかない」状態を作らない。
import { execFileSync } from 'node:child_process';
import { watch, readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, basename } from 'node:path';
import { ChainWriter, parseEventLog } from './chain.js';
import { signHex, verifyHex } from './keys.js';
import { verifyWork, formatReport } from './verify.js';
import { deriveSummary } from './summary.js';
import { renderCard } from './card.js';
import { loadOrCreateIdentity, loadSession } from './identity.js';
import { ADAPTERS as REGISTRY, adapterById, matchApp, matchWork } from './adapters/index.js';
import { frontmostApp, idleSeconds, userFolders } from './platform.js';

// 端末時計がサーバー受領時刻からこれ以上ずれていたら警告する(実測の往復遅延は数十ms)。
const CLOCK_SKEW_WARN_MS = 5 * 60 * 1000;
// 終了時のアンカーはこれ以上待たない(オフラインでも終了をブロックしない。穴は次回起動の restart アンカーが塞ぐ)
const STOP_ANCHOR_TIMEOUT_MS = 3000;

// works/ 配下で再開すべき作品(status: 'recording')を探す。設計上は高々1本だが、複数あれば最新を採る。
// status は記録のライフサイクルだけを表す。発行しても 'recording' のまま(発行は記録の終わりではない)。
function findResumableWork(worksDir) {
  if (!existsSync(worksDir)) return null;
  const found = [];
  for (const d of readdirSync(worksDir)) {
    const dir = join(worksDir, d);
    const metaPath = join(dir, 'meta.json');
    if (!existsSync(metaPath)) continue;
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
      if (meta.status === 'recording') found.push({ dir, meta });
    } catch { /* 壊れた meta は無視 */ }
  }
  found.sort((a, b) => String(b.meta.started_at ?? '').localeCompare(String(a.meta.started_at ?? '')));
  return found[0] ?? null;
}

export function createRecorder(options = {}) {
  const SERVER = options.server ?? 'https://nenrinapp.com';
  // 対象ツールはアダプタ登録簿(adapters/)。options.adapters で差し替え可。options.targetApp は互換(テスト用):
  // CSP アダプタのアプリ名だけを置き換える
  const ADAPTERS = options.adapters
    ?? (options.targetApp ? REGISTRY.map((a) => (a.id === 'clip-studio-paint' ? { ...a, appNames: [options.targetApp] } : a)) : REGISTRY);
  const INTERVAL = (options.intervalSec ?? 5) * 1000;
  const IDLE_THRESHOLD = options.idleThresholdSec ?? 120;
  const ANCHOR_INTERVAL = (options.anchorIntervalSec ?? 60) * 1000;
  // 前面から外れてもすぐには session_end にしない猶予。資料を数秒見ただけでセッションが
  // 割れると年輪の区切りが実態とずれる(実測: 6分で10セッション、うち3つが実質0.1秒)。
  const SESSION_END_GRACE = (options.sessionEndGraceSec ?? 45) * 1000;
  // 監視ルートは OS に解決させる(Windows は OneDrive の既知フォルダー移動で %USERPROFILE% 配下から外れる)
  let ROOTS = options.roots ?? userFolders(); // setRoots() で差し替え可(記録するフォルダの明示選択)
  // セッション検知シグナルの差し替え口。既定は platform.js の OS アダプタで、テストだけが差し替える
  // (前面アプリとアイドル秒は実行環境に依存するので、これが無いとライフサイクルを自動テストできない)。
  const PLATFORM = { frontmostApp, idleSeconds, ...(options.platform ?? {}) };
  // 保存先: <worksDir>/<work_id>/{meta.json, events.jsonl, state.json, published/<ts>/}(record_schema_v01 §10)
  const WORKS = options.worksDir ?? join(options.outDir ?? 'out', 'works');
  const log = options.onLog ?? ((msg) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`));

  mkdirSync(WORKS, { recursive: true });

  const keys = loadOrCreateIdentity();
  // 発行者名義はログイン中のアカウントから。未ログインは匿名(サーバーが handle_verified=false にする)。
  // 鍵がアカウントに紐付いていれば、サーバーは meta.handle を無視して認証済みハンドルを刻む。
  const session = options.session ?? loadSession();

  // ── 作品ディレクトリの解決: 記録途中の作品があれば読み戻し、なければ新規
  const resumed = findResumableWork(WORKS);
  let workDir;
  let meta;
  let loadedEvents = [];
  let droppedTail = 0;
  if (resumed) {
    workDir = resumed.dir;
    meta = resumed.meta;
    const eventsPath = join(workDir, 'events.jsonl');
    if (existsSync(eventsPath)) {
      const parsed = parseEventLog(readFileSync(eventsPath, 'utf8'));
      loadedEvents = parsed.events;
      droppedTail = parsed.dropped;
      // 壊れた末尾行は捨てて、ファイルも整合した状態に書き戻す(以後の追記が正しい prev に繋がる)
      if (droppedTail) writeFileSync(eventsPath, loadedEvents.map((e) => JSON.stringify(e)).join('\n') + (loadedEvents.length ? '\n' : ''));
    }
  } else {
    const workId = randomUUID();
    workDir = join(WORKS, workId);
    mkdirSync(workDir, { recursive: true });
    meta = {
      schema: 'loop-poc/1',
      work_id: workId,
      title: 'live-recording',
      profile: 'record-poc',
      tier: 'B',
      tool: null, // 発行時に、選んだ作品のアダプタ id が入る(daw_adapter_v01 §5)
      tools_enabled: ADAPTERS.map((a) => a.id),
      handle: session?.handle ? '@' + session.handle : '(匿名)',
      disclaimer: '実記録(NENRIN recorder)',
      started_at: new Date().toISOString(),
      key_id: keys.keyId,
      public_key_der_hex: keys.publicDerHex,
      // 記録のライフサイクルのみ。0.0.2 では 'recording' から遷移させる操作を持たない
      // (作品を締める/切り替える操作は l2_lifecycle_v01 §5.2 の第二段で決める)。
      status: 'recording',
      publications: [],
    };
  }
  // 発行履歴。正はチェーンの core.export で、これは URL を持つローカルのUI用インデックス
  // (発行URLは core.export の時点では未確定なのでチェーンに載らない)。
  meta.publications ??= [];
  const workId = meta.work_id;
  // meta だけあってイベントが1件も無い作品(初回起動直後の異常終了)は、新規と同じく work_start から始める
  const isResume = !!resumed && loadedEvents.length > 0;
  const eventsPath = join(workDir, 'events.jsonl');
  const statePath = join(workDir, 'state.json');
  const saveMeta = () => writeFileSync(join(workDir, 'meta.json'), JSON.stringify(meta, null, 2));
  saveMeta();

  // 確定したイベントはその場で追記する。fsync はしない(イベントは秒オーダーでしか出ない。
  // 電源断で末尾が欠けても起動時の parseEventLog が切り捨てて整合を保つ)。
  const chain = new ChainWriter({
    events: loadedEvents,
    onAppend: (ev) => appendFileSync(eventsPath, JSON.stringify(ev) + '\n'),
  });

  // ── ローカル状態(チェーンには載せないもの: ファイルパス等)。state.json に保存し、再起動をまたいで持つ。
  // チェーン側にはハッシュしか積まないので、公開候補やベースライン済みファイルの照合にはこちらが要る。
  let state = { candidates: {}, baselinedPaths: [], artifacts: {} };
  if (existsSync(statePath)) {
    try { state = { ...state, ...JSON.parse(readFileSync(statePath, 'utf8')) }; } catch { /* 初期値で続行 */ }
  }
  const saveState = () => {
    try { writeFileSync(statePath, JSON.stringify(state)); } catch (e) { log('state.json 保存失敗: ' + e.message); }
  };

  // チェーン直列化(アンカーHTTP往復中の割り込み防止)
  let chainLock = Promise.resolve();
  const withChain = (fn) => {
    chainLock = chainLock.then(fn).catch((e) => log('chain error: ' + e.message));
    return chainLock;
  };
  // ts_mono はプロセス起動からの相対値。再開後は新しい単調区間として 0 から始まる(record_schema §7 の用途を損なわない)。
  const t0 = Date.now();
  const appendEvent = (type, payload) => {
    const now = Date.now();
    return chain.append(type, payload, new Date(now).toISOString(), now - t0);
  };

  const post = async (path, body) => {
    const res = await fetch(SERVER + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${path} → ${res.status}: ${await res.text()}`);
    return res.json();
  };

  // 読み戻したチェーンから表示用カウンタを復元
  let anchorCount = chain.events.filter((e) => e.type === 'core.anchor_ack').length;
  let snapshotCount = chain.events.filter((e) => e.type === 'core.snapshot').length;
  let sessionNo = chain.events.filter((e) => e.type === 'core.session_start').length;
  // UI 向けの目安。sim.activity は活動中に INTERVAL ごとに 1 件積まれるので、件数 × INTERVAL を
  // 実作業のおおよその累計として使う(通知の閾値にだけ使う。表示・証明の正は summary.js)。
  let activityTicks = chain.events.filter((e) => e.type === 'sim.activity').length;
  // 直近の発行(core.export)より後に積まれた保存の数。0 なら発行済みの状態から進んでいない。
  const snapshotsSinceExport = () => {
    let n = 0;
    for (let i = chain.events.length - 1; i >= 0; i--) {
      const t = chain.events[i].type;
      if (t === 'core.export') break;
      if (t === 'core.snapshot') n += 1;
    }
    return n;
  };
  let clockSkewMs = 0;
  const anchorNow = (label) =>
    withChain(async () => {
      const head = chain.head();
      const cp = appendEvent('core.checkpoint', { head, key_id: keys.keyId, sig: signHex(keys.privateKey, head) });
      const sent = chain.head();
      const receipt = await post('/anchors', {
        key_id: keys.keyId, seq: cp.seq, chain_head: sent, client_sig: signHex(keys.privateKey, sent),
      });
      appendEvent('core.anchor_ack', {
        anchor_id: receipt.anchor_id, chain_head: sent, received_at: receipt.received_at, server_sig: receipt.server_sig,
      });
      anchorCount += 1;
      // サーバー受領時刻は信頼できる外部時計。端末時計が狂っていると証明書の絶対時刻が狂うので、
      // 気づける形にしておく(TLSも巻き添えで壊れるため、早期発見の価値が大きい)。
      const skewMs = Date.now() - Date.parse(receipt.received_at);
      if (Number.isFinite(skewMs) && Math.abs(skewMs) > CLOCK_SKEW_WARN_MS) {
        clockSkewMs = skewMs;
        log(`⚠ 端末時計がサーバーと ${Math.round(skewMs / 1000)}秒 ずれています(記録される時刻が不正確になります)`);
      }
      log(`⚓ anchor ${receipt.anchor_id} (${label})`);
    });

  // ファイル監視(再帰・自動発見・デデュープ)。キーは作品ルート(ファイル、または .logicx のようなパッケージ)
  const files = new Map();
  let lastFile = null;

  // work_pub候補: root -> { sha, bytes, mtime, snapshots, frames, tool }。state.json から復元し、更新のたびに保存。
  // tool が無い旧エントリ(0.0.3 以前)は CSP
  const candidates = new Map(Object.entries(state.candidates).map(([p, c]) => [p, { tool: 'clip-studio-paint', ...c }]));
  for (const [path, c] of candidates) {
    files.set(path, { lastSha: c.sha });
    if (!lastFile || (c.mtime ?? 0) > (candidates.get(lastFile)?.mtime ?? 0)) { lastFile = path; }
  }
  const persistCandidates = () => {
    state.candidates = Object.fromEntries(candidates);
    saveState();
  };
  // ベースライン済みのユーザーファイル。過去の実行で観測済みなら、このプロセスでの初回観測は
  // 「未観測期間明けの再発見」(coverage_model_v01: reason=rediscovery)として刻む。
  const baselinedPaths = new Set(state.baselinedPaths);
  const seenThisRun = new Set();
  function snapshot(adapter, path) {
    const st = files.get(path) ?? {};
    try {
      // アダプタがハッシュを決める(CSP: ファイルの sha256、Logic: パッケージ内の構成ファイルを連結)。未保存なら null
      const h = adapter.hashWork(path);
      if (!h) return;
      const sha = h.sha256;
      const bytes = h.bytes;
      if (sha === st.lastSha) return;
      files.set(path, { lastSha: sha });
      // 過程の証拠としては対象ツールの全ファイルを記録するが、公開候補はユーザーの作品だけ
      if (adapter.isUserWork(path)) {
        // 証拠ペアの整合: フレーム数は sha256 と同じ読み取りから取る(アダプタ側で保証)
        const frames = h.frames ?? null;
        // 初回観測のベースライン固定(coverage_model_v01)。このファイルの過程はここから観測された、
        // より前の過程は「この状態がこの時点に存在した」という存在証明に縮退する(主張の再スコープ)。
        // タイムラプス規模は、観測開始前にどれだけの過程が既に存在したかの証拠になる。
        // 制約: チェーンは記録ストリームごとに1本なので、複数作品を並行編集した場合の summary 側の
        // ベースライン帰属は先頭ファイル優先になる(record_schema §11 の work_id 追従ルールが未決)。
        if (!seenThisRun.has(path)) {
          seenThisRun.add(path);
          const reason = baselinedPaths.has(path) ? 'rediscovery' : 'file_first_seen';
          baselinedPaths.add(path);
          state.baselinedPaths = [...baselinedPaths];
          withChain(() => appendEvent('core.baseline', {
            reason, sha256: sha, bytes, tool: adapter.id,
            ...(frames != null ? { timelapse_frame_count: frames } : {}),
            ...(h.stats && Object.keys(h.stats).length ? { tool_stats: h.stats } : {}),
          }));
          anchorNow('baseline');
          log(`◎ baseline ${basename(path)} (${reason})${frames != null ? ` (timelapse ${frames}f)` : ''}`);
        }
        const c = candidates.get(path) ?? { snapshots: 0 };
        candidates.set(path, { sha, bytes, mtime: Date.now(), snapshots: c.snapshots + 1, frames, tool: adapter.id });
        persistCandidates();
        lastFile = path;
      }
      snapshotCount += 1;
      // tool_stats: 件数と数値だけ(daw_adapter_v01 §4。名前・中身は入れない)
      withChain(() => appendEvent('core.snapshot', {
        sha256: sha, bytes, tool: adapter.id,
        ...(h.stats && Object.keys(h.stats).length ? { tool_stats: h.stats } : {}),
      }));
      log(`★ snapshot ${basename(path)} ${bytes.toLocaleString()}B (${adapter.id})`);
    } catch {
      st.retries = (st.retries ?? 0) + 1;
      files.set(path, st);
      if (st.retries <= 3) setTimeout(() => snapshot(adapter, path), 700);
    }
  }
  // セッション外のファイル変更は証拠に採らない。監視ルートはユーザーのドキュメント全体なので、
  // クラウド同期・別デバイス・他アプリ由来の .clip がチェーンに混入しうる(実測: OneDrive の
  // 脱水/再水和だけで1ファイルに5回の change が発火)。触っていない作品のハッシュを公開証明に
  // 載せるのは製品原則2(ローカルファースト)に反するし、公開候補として誤選択される危険もある。
  // 書き出し音源(バウンス)の候補: セッション中に記録するフォルダ内へ新しくできた音声ファイル(daw_adapter_v01 §4・§5)。
  // ハッシュは発行時に取る(書き出し中の途中状態を固定しないため)。名前・パスはローカルの state.json にだけ持つ
  const artifacts = new Map(Object.entries(state.artifacts ?? {}));
  const persistArtifacts = () => { state.artifacts = Object.fromEntries(artifacts); saveState(); };
  function onArtifactEvent(path) {
    if (!sessionActive || !sessionTool) return;
    const adapter = adapterById(ADAPTERS, sessionTool);
    const ext = (path.split('.').pop() ?? '').toLowerCase();
    if (!adapter?.artifactExtensions?.includes(ext)) return;
    if (artifacts.has(path)) return;
    try {
      const st = statSync(path);
      if (!st.isFile() || Date.now() - st.mtimeMs > 60e3) return; // 既存ファイルの検知(監視開始直後など)は候補にしない
    } catch { return; }
    artifacts.set(path, { first_seen: new Date().toISOString(), tool: adapter.id });
    persistArtifacts();
    log(`♪ 書き出し候補 ${basename(path)} (${adapter.id})`);
  }
  // 発行時に選べる書き出し音源。存在しなくなったものは落とす。新しい順
  function listArtifacts() {
    const out = [];
    for (const [path, a] of artifacts) {
      try {
        const st = statSync(path);
        out.push({ path, name: basename(path), bytes: st.size, mtime: st.mtimeMs, tool: a.tool, toolName: adapterById(ADAPTERS, a.tool)?.displayName ?? a.tool, first_seen: a.first_seen });
      } catch { artifacts.delete(path); }
    }
    persistArtifacts();
    return out.sort((a, b) => b.mtime - a.mtime);
  }

  let skippedOutsideSession = 0;
  // 作品ルート単位で 2 秒のデバウンス。パッケージ(.logicx)は保存 1 回で内部の複数ファイルが変わるので、
  // ルートにまとめて 1 回のスナップショットにする
  function onWorkEvent(adapter, root) {
    if (!sessionActive) {
      skippedOutsideSession += 1;
      return;
    }
    const st = files.get(root) ?? {};
    clearTimeout(st.timer);
    st.retries = 0;
    st.timer = setTimeout(() => snapshot(adapter, root), 2000);
    files.set(root, st);
  }

  // セッション検知シグナルは platform.js(OS別アダプタ)から
  let sessionActive = false;
  let sessionTool = null; // 現在のセッションで前面だった対象ツールのアダプタ id
  let nextAnchorAt = 0;
  let timerId = null;
  const watchers = [];
  let pendingEndAt = null;   // 猶予の期限。null = 猶予中でない
  let lastActiveWall = null; // 最後に「対象アプリが前面かつ入力あり」だった時刻

  // 猶予分は制作時間に数えない。last_active_wall を積んでおき、summary 側がそちらを終端に使う
  // (時間を盛らないこと自体が製品原則5)。
  const endSession = (reason, extra = {}) => {
    sessionActive = false;
    pendingEndAt = null;
    const lastActive = lastActiveWall;
    withChain(() => appendEvent('core.session_end', { last_active_wall: lastActive, grace_ms: SESSION_END_GRACE, ...extra }));
    log(`── session_end (${reason})`);
    return anchorNow('session_end');
  };

  const tick = () => {
    const front = PLATFORM.frontmostApp();
    const idle = PLATFORM.idleSeconds();
    const frontAdapter = matchApp(ADAPTERS, front); // どの対象ツールが前面か(該当なしは null)
    const active = frontAdapter != null && idle != null && idle < IDLE_THRESHOLD;
    const now = Date.now();
    if (active) {
      lastActiveWall = new Date(now).toISOString();
      if (pendingEndAt != null) {
        pendingEndAt = null; // 猶予内に戻ってきた → セッションは割らない
        log('── session resumed (猶予内の離席)');
      }
      if (!sessionActive) {
        sessionActive = true;
        sessionTool = frontAdapter.id;
        sessionNo += 1;
        withChain(() => appendEvent('core.session_start', { session_id: 's' + String(sessionNo).padStart(2, '0'), tool: frontAdapter.id }));
        log(`── session_start s${sessionNo} (${front})`);
        anchorNow('session_start');
        nextAnchorAt = now + ANCHOR_INTERVAL;
      } else {
        withChain(() => appendEvent('sim.activity', { input_count: idle < 30 ? 1 : 0 }));
        activityTicks += 1;
        if (now >= nextAnchorAt) {
          anchorNow('interval');
          nextAnchorAt = now + ANCHOR_INTERVAL;
        }
      }
    } else if (sessionActive) {
      if (pendingEndAt == null) pendingEndAt = now + SESSION_END_GRACE;
      else if (now >= pendingEndAt) endSession(`front=${front}`);
    }
  };

  // 監視の張り直し。存在しない/重複したルートは飛ばし、実際に監視できたルートを返す。
  // パスはローカルの設定であってチェーンには載せない(チェーン側にはハッシュしか積まない)。
  let activeRoots = [];
  function applyRoots(roots) {
    for (const w of watchers.splice(0)) { try { w.close(); } catch { /* 既に閉じている */ } }
    const seen = new Set();
    const watchedRoots = [];
    for (const root of roots) {
      const key = root.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (!existsSync(root)) continue;
      try {
        watchers.push(watch(root, { recursive: true }, (ev, fname) => {
          if (!fname) return;
          const full = join(root, fname);
          const m = matchWork(ADAPTERS, full);
          if (m) onWorkEvent(m.adapter, m.root);
          else onArtifactEvent(full);
        }));
        watchedRoots.push(root);
      } catch { /* 監視できないルートはスキップ */ }
    }
    activeRoots = watchedRoots;
    return watchedRoots;
  }

  // 記録するフォルダを本人が変えたとき(desktop-poc のオンボーディング / トレイ)。再起動なしで反映する。
  function setRoots(roots) {
    ROOTS = [...roots];
    const watched = applyRoots(ROOTS);
    for (const r of watched) log(`  watch: ${r}`);
    log(`roots changed: ${watched.length}/${ROOTS.length} 監視中`);
    return watched;
  }

  // 前回の実行がセッション中に終わっていた(クラッシュ・強制終了・電源断)なら、そのセッションを閉じる。
  // 終端は最後に記録された活動の時刻。落ちていた間は作業時間に数えない(製品原則5)。
  function recoverOpenSession() {
    const evs = chain.events;
    let lastStart = -1;
    for (let i = evs.length - 1; i >= 0; i--) {
      if (evs[i].type === 'core.session_end') return false;
      if (evs[i].type === 'core.session_start') { lastStart = i; break; }
    }
    if (lastStart < 0) return false;
    let lastActive = evs[lastStart].ts_wall;
    for (let i = evs.length - 1; i > lastStart; i--) {
      if (evs[i].type === 'sim.activity' || evs[i].type === 'core.snapshot') { lastActive = evs[i].ts_wall; break; }
    }
    appendEvent('core.session_end', { last_active_wall: lastActive, grace_ms: SESSION_END_GRACE, recovered: true });
    log(`── session_end (recovered: 前回はセッション中に終了。終端=${lastActive})`);
    return true;
  }

  async function start() {
    const health = await fetch(SERVER + '/health').then((r) => r.json()).catch(() => null);
    if (!health?.ok) throw new Error(`アンカーサーバーに接続できない: ${SERVER}`);
    await post('/keys', { key_id: keys.keyId, public_key_der_hex: keys.publicDerHex }).catch(() => {});
    log(`key: ${keys.keyId} → ${SERVER}`);

    // 実際に監視できたパスを必ず出す。「recording…」と出ているのに保存先を1つも見ていない、
    // という無言の失敗(OneDrive リダイレクト時に発生)を目視で潰せるようにする。
    const watchedRoots = applyRoots(ROOTS);
    const watched = watchedRoots.length;
    for (const r of watchedRoots) log(`  watch: ${r}`);
    if (watched === 0) log('⚠ 監視できるフォルダが1つもありません(保存しても記録されません)');

    if (isResume) {
      // 再開: work_start は積まない。回復 session_end → core.restart → アンカーで再開点をサーバー時刻に固定する
      const last = chain.events[chain.events.length - 1];
      const gapMs = last ? Date.now() - Date.parse(last.ts_wall) : null;
      log(`↻ 記録を再開: work ${workId} (${chain.events.length} イベント${droppedTail ? '、壊れた末尾行を1件切り捨て' : ''})`);
      await withChain(() => {
        const recovered = recoverOpenSession();
        appendEvent('core.restart', {
          reason: recovered ? 'crash_recovery' : 'app_start',
          prev_seq: last?.seq ?? 0,
          ...(Number.isFinite(gapMs) ? { gap_wall_ms: gapMs } : {}),
        });
      });
      await anchorNow('restart');
    } else {
      withChain(() => appendEvent('core.work_start', {
        work_id: workId, tool: meta.tool ?? null, tools_enabled: ADAPTERS.map((a) => a.id), tool_version: meta.tool_version ?? null,
        plugin_version: options.pluginVersion ?? '0.0.3-poc', key_id: keys.keyId, schema_v: 1,
      }));
      await anchorNow('work_start');
    }
    log(`recording… tools=${ADAPTERS.map((a) => a.id).join(',')} roots=${watched} anchor=${ANCHOR_INTERVAL / 1000}s間隔`);
    timerId = setInterval(tick, INTERVAL);
    tick();
    return { watchedRoots: watched, resumed: isResume };
  }

  // 公開候補一覧(公開ダイアログのファイル選択UI用)。更新日時の新しい順。
  function listCandidates() {
    return [...candidates.entries()]
      .map(([path, c]) => ({
        path, name: basename(path).replace(/^\d{14}/, ''), sha256: c.sha, bytes: c.bytes, mtime: c.mtime, snapshots: c.snapshots,
        tool: c.tool, toolName: adapterById(ADAPTERS, c.tool)?.displayName ?? c.tool,
      }))
      .sort((a, b) => b.mtime - a.mtime);
  }

  // 発行(publish): その時点までの記録から証明書を作る。記録は止めない(l2_lifecycle_v01 §3.2)。
  // セッション中なら一度閉じる(発行という実際の出来事で区切る)。次の tick が自然に新しいセッションを開く。
  // chosenPath: 公開時にユーザーが選んだ作品ファイル(未指定なら最後のユーザーファイル)
  let publishing = false;
  async function publish({ publish = true, disclosure = 2, chosenPath = null, artifactPath = null } = {}) {
    if (publishing) return null;
    publishing = true;
    try {
      log(publish ? 'publish…' : 'export…');
      // 発行直前に最新のログイン状態を反映する。アプリ起動後にログインした場合、
      // createRecorder 時点の meta.handle は古い(匿名)ため、ここで貼り直す。
      const nowSession = options.session ?? loadSession();
      meta.handle = nowSession?.handle ? '@' + nowSession.handle : '(匿名)';
      // 作品ファイルを1件も捕捉していないなら、チェーンに何も積まずに戻る。
      // ここでゼロハッシュの core.export を積むと、verify.js が「全ての export」を見るため
      // 以後この作品から出す証明書が永久に FAIL になる(記録は永続化されて作り直せない)。
      // 「中身の無い証明が PASS になる」経路は、export を積まないことで同じように塞がれる。
      if (candidates.size === 0) {
        log('⚠ 作品を1件も捕捉していないので発行できません(記録するフォルダの外に保存された可能性があります)');
        if (skippedOutsideSession > 0) log(`  (セッション外の作品ファイル変更を ${skippedOutsideSession} 件無視しました)`);
        log('  記録は続いています。対象ツールで保存してから、あらためて発行してください');
        return { ok: false, noUserFile: true, result: null, summary: null, cardPath: null, published: null, outDir: null, chosen: null };
      }
      // ここから先は候補が1件以上あることが保証される
      const chosen = chosenPath && candidates.has(chosenPath) ? chosenPath : (lastFile ?? [...candidates.keys()][0]);
      const chosenCand = candidates.get(chosen);
      const chosenAdapter = adapterById(ADAPTERS, chosenCand.tool) ?? ADAPTERS[0];
      const chosenSha = chosenCand.sha;
      // 完成時のタイムラプス規模。ベースラインとの比が「観測開始前の過程の割合」になり、
      // 年輪カードの芯(未観測領域)のスケールに使われる(summary の coverage.baseline_share)。
      // 再読みせず最終スナップショット時に同じ buf から取った値を使う(sha・bytes と整合するペア)。
      const chosenFrames = candidates.get(chosen).frames ?? null;
      // 書き出し音源の紐付け(任意): 音源そのものは送らず、ハッシュ・サイズ・形式・ファイル名だけを export に載せる
      let artifact = null;
      if (artifactPath) {
        try {
          const abuf = readFileSync(artifactPath);
          artifact = { sha256: createHash('sha256').update(abuf).digest('hex'), bytes: abuf.length, format: (artifactPath.split('.').pop() ?? '').toLowerCase(), name: basename(artifactPath) };
          log(`♪ 書き出し音源を紐付け: ${artifact.name} ${abuf.length.toLocaleString()}B`);
        } catch (e) {
          log(`⚠ 書き出し音源を読めないので紐付けません: ${e.message}`);
        }
      }
      if (sessionActive) await endSession('publish');
      await withChain(() => {
        appendEvent('core.export', {
          sha256: chosenSha, format: chosenAdapter.exportFormat, bytes: chosenCand.bytes, tool: chosenAdapter.id,
          ...(chosenFrames != null ? { timelapse_frame_count: chosenFrames } : {}),
          ...(artifact ? { artifact } : {}),
        });
        meta.title = basename(chosen).replace(/^\d{14}/, '');
        meta.tool = chosenAdapter.id;
        meta.tool_version = (chosenAdapter.toolVersion && chosenAdapter.toolVersion()) ?? meta.tool_version ?? null;
      });
      await anchorNow('export');

      // 発行時点のイベント列を固定する(発行処理中に tick が積み増しても、送るのはこの時点まで)
      const events = chain.events.slice();
      const outRel = 'published/' + new Date().toISOString().replace(/[:.]/g, '-');
      const outDir = join(workDir, outRel);
      mkdirSync(outDir, { recursive: true });

      const { public_key_der_hex: serverPub } = await (await fetch(SERVER + '/pubkey')).json();
      const ackIds = new Set(events.filter((e) => e.type === 'core.anchor_ack').map((e) => e.payload.anchor_id));
      const anchors = (await (await fetch(SERVER + `/anchors?key_id=${encodeURIComponent(keys.keyId)}`)).json()).anchors
        .filter((a) => ackIds.has(a.anchor_id));
      writeFileSync(join(outDir, 'anchors.json'), JSON.stringify(anchors, null, 2));

      const result = verifyWork(meta, events, anchors, {
        verifyReceipt: (p) => verifyHex(serverPub, `${p.anchor_id}|${p.chain_head}|${p.received_at}`, p.server_sig),
      });
      log(formatReport('record-work', result));

      const summary = deriveSummary(meta, events);
      writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
      writeFileSync(join(outDir, 'card.svg'), renderCard(meta, summary));

      let published = null;
      if (publish && result.ok) {
        // 完成サムネイル用に、選んだ作品の完成プレビューを抽出して同送(任意)
        const canvasPreviewB64 = chosen && chosenAdapter.preview ? chosenAdapter.preview(chosen) : null;
        const resp = await post('/publish', {
          meta: { work_id: meta.work_id, title: meta.title, tier: meta.tier, handle: meta.handle, key_id: meta.key_id, tool: meta.tool },
          events,
          disclosure_level: disclosure,
          canvas_preview_b64: canvasPreviewB64 ?? undefined,
        });
        writeFileSync(join(outDir, 'certificate.json'), JSON.stringify(resp.certificate, null, 2));
        published = resp;
        // 発行は記録の終わりではないので status は変えない。発行の事実は履歴として積む
        // (status を 'published' にすると findResumableWork から外れ、次回起動が別の作品を始めてしまう)。
        meta.publications.push({ at: new Date().toISOString(), url: resp.url, dir: outRel });
        log(`📜 証明書発行: ${resp.url}${resp.has_thumb ? ' (サムネイル付き)' : ''}`);
      }
      saveMeta();
      return { ok: result.ok, result, summary, cardPath: join(outDir, 'card.svg'), published, outDir, noUserFile: false, chosen };
    } finally {
      publishing = false;
    }
  }

  // 停止: 記録を止めてプロセスを終われる状態にする(記録は保持)。セッション中なら閉じてアンカーするが、
  // オフラインでも終了をブロックしない(タイムアウト後は次回起動の restart アンカーが穴を塞ぐ)。
  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(timerId);
    // 監視ハンドルも閉じる。開いたままだとイベントループが空にならず、プロセスが終われない
    for (const w of watchers.splice(0)) { try { w.close(); } catch { /* 既に閉じている */ } }
    if (sessionActive) {
      const done = endSession('stop');
      await Promise.race([done, new Promise((r) => setTimeout(r, STOP_ANCHOR_TIMEOUT_MS))]);
    }
    log('stopped(記録は保持)');
  }

  // 後方互換: 旧 API(発行して止める)。CLI(record.js)が使う。
  async function finalize(opts = {}) {
    const r = await publish({ publish: false, ...opts });
    await stop();
    return r;
  }

  const status = () => ({
    sessionActive, sessionNo, anchorCount, snapshotCount, candidateCount: candidates.size,
    lastFile: lastFile ? basename(lastFile) : null, server: SERVER, keyId: keys.keyId,
    clockSkewMs, skippedOutsideSession, watchedRoots: ROOTS, activeRoots,
    tools: ADAPTERS.map((a) => a.id), sessionTool,
    workId, workDir, worksDir: WORKS, resumed: isResume, eventCount: chain.events.length,
    // 発行への導線(desktop-poc/nudges.mjs)用
    activeApproxMs: activityTicks * INTERVAL, publicationCount: meta.publications.length, snapshotsSincePublish: snapshotsSinceExport(),
  });

  return { start, publish, stop, finalize, status, listCandidates, listArtifacts, setRoots };
}

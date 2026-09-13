// 共有認証モジュール — CLI(account.js)と Electronアプリ(main.js)が同じロジックを使う。
// メールマジックリンク認証 → session.json 保存 → ハンドル設定 → 鍵のアカウント紐付け。
// fetch は Node/Electronメインプロセスで実行する(CORSの影響を受けない)。
import { signHex } from './keys.js';
import { loadOrCreateIdentity, loadSession, saveSession, clearSession } from './identity.js';

const DEFAULT_SERVER = 'https://nenrinapp.com';

function serverOf(explicit) {
  return explicit ?? loadSession()?.server ?? DEFAULT_SERVER;
}

async function call(server, path, body, sessionId) {
  const res = await fetch(server + path, {
    method: body ? 'POST' : 'GET',
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(sessionId ? { authorization: 'Bearer ' + sessionId } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `${path} → ${res.status}`);
  return json;
}

// 確認コードを送る。開発モード(RESEND未設定)ではトークンが直接返る(dev_magic_token)
export async function requestCode(email, server) {
  const s = serverOf(server);
  return call(s, '/auth/request', { email });
}

// コードを検証してログイン。session.json に保存し、必要なら鍵をアカウントに紐付ける
export async function verifyCode(token, server) {
  const s = serverOf(server);
  const v = await call(s, '/auth/verify', { token });
  saveSession({ server: s, ...v });
  // ログインできたら手元の鍵をアカウントに紐付ける(以後の発行が認証済み名義になる)
  await bindKey(s).catch(() => {});
  return loadSession();
}

// ハンドル(ペンネーム)の設定・変更
export async function setHandle(handle, server) {
  const session = loadSession();
  if (!session) throw new Error('先にログインしてください');
  const s = serverOf(server);
  const r = await call(s, '/account/handle', { handle }, session.session_id);
  saveSession({ ...session, handle: r.handle });
  return r.handle;
}

// 手元の鍵(identity.pem)をログイン中のアカウントに紐付ける。所有証明の署名つき。
export async function bindKey(server) {
  const session = loadSession();
  if (!session) throw new Error('先にログインしてください');
  const s = serverOf(server);
  const id = loadOrCreateIdentity();
  await call(s, '/keys', { key_id: id.keyId, public_key_der_hex: id.publicDerHex }).catch(() => {});
  const proof = signHex(id.privateKey, `nenrin-bind:${session.account_id}:${id.keyId}`);
  return call(s, '/account/keys', { key_id: id.keyId, proof_sig: proof }, session.session_id);
}

// 現在のログイン状態(null = 未ログイン)
export function currentSession() {
  return loadSession();
}

export function logout() {
  clearSession();
}

// ローカル身元(鍵)の永続化 — 「鍵=身元」の継続性(trust_model §4)。
// ~/.nenrin-poc/identity.pem に保存し、record.js / account.js が共用する。
import { generateKeyPairSync, createPrivateKey, createPublicKey, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// NENRIN_HOME は検証用(本番のデータに触れずに別ディレクトリで動かす)。通常は未設定
export const STATE_DIR = process.env.NENRIN_HOME ?? join(process.env.HOME ?? process.env.USERPROFILE, '.nenrin-poc');
export const SESSION_FILE = join(STATE_DIR, 'session.json');

export function loadOrCreateIdentity() {
  mkdirSync(STATE_DIR, { recursive: true });
  const pemPath = join(STATE_DIR, 'identity.pem');
  let privateKey;
  if (existsSync(pemPath)) {
    privateKey = createPrivateKey(readFileSync(pemPath));
  } else {
    privateKey = generateKeyPairSync('ed25519').privateKey;
    writeFileSync(pemPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  }
  const der = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  return {
    privateKey,
    publicDerHex: der.toString('hex'),
    keyId: 'k:' + createHash('sha256').update(der).digest('hex').slice(0, 16),
  };
}

export function loadSession() {
  return existsSync(SESSION_FILE) ? JSON.parse(readFileSync(SESSION_FILE, 'utf8')) : null;
}

export function saveSession(s) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(SESSION_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
}

// ログアウト: セッションを消す(鍵 identity.pem は身元なので残す)
export function clearSession() {
  rmSync(SESSION_FILE, { force: true });
}

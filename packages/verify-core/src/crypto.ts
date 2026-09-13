// 暗号ユーティリティ — node:crypto に統一(nodejs_compat)。
// Workers(nodejs_compat)と素のNodeの両方で動く = Fly.io移行ヘッジを保つ。
import { createHash, createPublicKey, createPrivateKey, sign as cryptoSign, verify as cryptoVerify, randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';

const toHex = (u8: Uint8Array): string => { let s = ''; for (const b of u8) s += b.toString(16).padStart(2, '0'); return s; };

export const sha256hex = (data: string): string => 'sha256:' + createHash('sha256').update(data).digest('hex');
export const sha256bytes = (data: Uint8Array): string => 'sha256:' + createHash('sha256').update(data).digest('hex');

export function edVerify(pubDerHex: string, data: string, sigHex: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(pubDerHex, 'hex'), format: 'der', type: 'spki' });
    return cryptoVerify(null, Buffer.from(data, 'utf8'), key, Buffer.from(sigHex, 'hex'));
  } catch {
    return false;
  }
}

export function edSignWithPkcs8B64(pkcs8b64: string, data: string): string {
  const key = createPrivateKey({ key: Buffer.from(pkcs8b64, 'base64'), format: 'der', type: 'pkcs8' });
  return toHex(cryptoSign(null, Buffer.from(data, 'utf8'), key));
}

export const randomId = (bytes = 5): string => toHex(randomBytes(bytes));

// 簡易JCS(キーソート・空白なし)。record_schema_v01 §3 と同一規則(loop-poc/canonical.js のTS移植)
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const obj = value as Record<string, unknown>;
  return '{' + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
}

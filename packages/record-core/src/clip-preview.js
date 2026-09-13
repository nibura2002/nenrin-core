// .clip から CanvasPreview(完成画像PNG)を取り出す。node:sqlite を使う(クライアント側専用)。
// サーバーへは base64 で送り、サーバーが縮小+透かしする(サーバー側の thumbnail 処理)。
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';

// node:sqlite は環境によっては解決できない(--experimental-sqlite 未指定、Electron 同梱 Node の
// バージョン差など)。トップレベル import だとモジュール読み込み時点で落ち、記録エンジンごと
// 起動しなくなる。プレビュー抽出は任意機能なので、実際に使う時点で遅延解決して失敗は null に倒す。
const require = createRequire(import.meta.url);

export function extractCanvasPreviewB64(clipPath) {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const buf = readFileSync(clipPath);
    let pos = 24;
    let sqli = null;
    while (pos + 16 <= buf.length) {
      const name = buf.toString('latin1', pos, pos + 8);
      if (!name.startsWith('CHNK')) break;
      const size = Number(buf.readBigUInt64BE(pos + 8));
      if (name === 'CHNKSQLi') sqli = { d: pos + 16, s: size };
      if (name === 'CHNKFoot') break;
      pos += 16 + size;
    }
    if (!sqli) return null;
    // 一時ファイル無しでメモリ上のSQLiteを開けないため、tmpに書き出す
    const tmp = clipPath + '.preview.sqlite';
    writeFileSync(tmp, buf.subarray(sqli.d, sqli.d + sqli.s));
    const db = new DatabaseSync(tmp, { readOnly: true });
    const row = db.prepare('SELECT ImageData FROM CanvasPreview LIMIT 1').get();
    db.close();
    unlinkSync(tmp);
    if (!row?.ImageData) return null;
    return Buffer.from(row.ImageData).toString('base64');
  } catch {
    return null;
  }
}

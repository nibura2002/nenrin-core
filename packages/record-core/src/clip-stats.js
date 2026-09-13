// .clip の軽量統計(タイムラプス規模)を取り出す。node:sqlite を使う(クライアント側専用)。
// カバレッジモデル(docs/architecture/coverage_model_v01.md)のベースライン用: 初回観測時点で
// どれだけの過程(タイムラプス)が既に存在したかを事実として記録する。
// 抽出は任意機能なので、失敗は null に倒して記録エンジンを止めない(clip-preview.js と同じ方針)。
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// TimeLapseRecord.EncoderSequence = タイムラプスのフレーム連番(extract-timelapse.js のリバース結果)。
// 全blobをzlib展開せずに取れる最も安いフレーム数の指標。タイムラプスOFFのファイルは null。
// 引数は読み取り済みの Buffer。呼び出し側が sha256 と同じ読み取りを渡すことで、
// 「ハッシュ X の状態にフレーム N が存在した」という証拠ペアの整合を保証する。
export function extractClipStats(clipBuf) {
  // 一時ファイルは OS の tmpdir に置く(作品フォルダに置くとクラウド同期を汚し、
  // 例外時に残留する)。保存途中の壊れた .clip でも必ず片付くよう finally で消す。
  let tmp = null;
  try {
    const { DatabaseSync } = require('node:sqlite');
    let pos = 24;
    let sqli = null;
    while (pos + 16 <= clipBuf.length) {
      const name = clipBuf.toString('latin1', pos, pos + 8);
      if (!name.startsWith('CHNK')) break;
      const size = Number(clipBuf.readBigUInt64BE(pos + 8));
      if (name === 'CHNKSQLi') sqli = { d: pos + 16, s: size };
      if (name === 'CHNKFoot') break;
      pos += 16 + size;
    }
    if (!sqli) return null;
    // 一時ファイル無しでメモリ上のSQLiteを開けないため、tmpに書き出す
    tmp = join(tmpdir(), `nenrin-clip-stats-${randomUUID()}.sqlite`);
    writeFileSync(tmp, clipBuf.subarray(sqli.d, sqli.d + sqli.s));
    let db = null;
    try {
      db = new DatabaseSync(tmp, { readOnly: true });
      let row = null;
      try {
        row = db.prepare('SELECT EncoderSequence FROM TimeLapseRecord LIMIT 1').get();
      } catch {
        /* TimeLapseRecord テーブルなし = タイムラプスOFF */
      }
      return { timelapse_frame_count: row?.EncoderSequence != null ? Number(row.EncoderSequence) : null };
    } finally {
      try { db?.close(); } catch { /* close失敗でもunlinkは試す */ }
    }
  } catch {
    return null;
  } finally {
    if (tmp) {
      try { unlinkSync(tmp); } catch { /* 消せない一時ファイルはOSのtmp掃除に任せる */ }
    }
  }
}

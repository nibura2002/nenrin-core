// CLIP STUDIO PAINT アダプタ(.clip)。制作ツールごとの差はここに閉じ込める(daw_adapter_v01 §3)。
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import { extractClipStats } from '../clip-stats.js';
import { extractCanvasPreviewB64 } from '../clip-preview.js';

export const adapter = {
  id: 'clip-studio-paint',
  displayName: 'CLIP STUDIO PAINT',
  appNames: ['CLIP STUDIO PAINT'],
  exportFormat: 'clip',
  // OS 既定の書類・デスクトップ(mac は CELSYS も)で足りるので、追加の既定ルートは無い
  defaultRoots: () => [],
  // 作品ファイル 1 個 = 作品ルート
  matchPath: (path) => (/\.clip$/i.test(path) ? path : null),
  // 公開候補: ユーザーが「作品」と認識する保存済みファイルのみ。
  // CSP の内部/バックアップ(復元用の一時ファイル・CELSYS バックアップ)は除外する。
  isUserWork: (path) => {
    // 区切り文字を正規化してから判定する(mac: ~/Library/CELSYS, Windows: <Documents>\CELSYS)
    if (/\/CELSYS\//i.test(path.replace(/\\/g, '/'))) return false; // 自動バックアップ
    if (/^[0-9a-f]{2}[0-9a-f]{6}[0-9a-f-]{20,}\.clip$/i.test(basename(path))) return false; // 内部復元ファイル(ハッシュ状の名前)
    return true;
  },
  // 証拠ペアの整合: フレーム数は sha256 と同じ読み取り(buf)から取る。別読みにすると
  // 保存進行中の内容変化で「ハッシュXの状態にNフレーム存在した」が崩れる。
  hashWork: (path) => {
    const buf = readFileSync(path);
    const sha256 = createHash('sha256').update(buf).digest('hex');
    const frames = extractClipStats(buf)?.timelapse_frame_count ?? null;
    return { sha256, bytes: buf.length, frames, stats: frames != null ? { timelapse_frames: frames } : {} };
  },
  artifactExtensions: [], // イラストの書き出し(PNG 等)の紐付けは未対応(音楽で先に検証する: daw_adapter_v01 §1)
  preview: (path) => extractCanvasPreviewB64(path),
  toolVersion: () => null, // CSP のアプリ版は取っていない(record_schema §5: Tier B)
};

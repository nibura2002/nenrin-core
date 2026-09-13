// Logic Pro アダプタ(.logicx パッケージ)。設計は docs/architecture/daw_adapter_v01.md §4。
//
// パッケージ(ディレクトリ)の中で「保存」を表すのは Alternatives/<n>/ProjectData の変更。
// Undo Data.nosync/ と DisplayState.plist は保存と無関係に変わるので保存検知から外す。
// 未保存の新規プロジェクトは Alternatives/4294967295 だけを持つので、作品として扱わない。
// ハッシュの対象は ProjectData・MetaData.plist・Resources/ProjectInformation.plist(相対パス順に
// 「相対パス + NUL + 内容」を連結して sha256)。Media/ の音声は巨大なので対象外(件数は D2 の統計で)。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appVersion, userHome } from '../platform.js';
import { parsePlistXml } from '../plist-xml.js';

const PKG_RE = /^(.*?\.logicx)(?:[\\/]|$)/i;
const SAVE_FILE_RE = /(?:^|[\\/])(ProjectData|MetaData\.plist|ProjectInformation\.plist)$/;
const UNSAVED_ALT = '4294967295';
const APP_PATH = '/Applications/Logic Pro.app';

// バイナリ plist → JS 値。mac の plutil に stdin で渡す(Logic は mac 専用なので他 OS では null)
function readPlist(buf) {
  try {
    const xml = buf.subarray(0, 5).toString() === '<?xml' ? buf.toString('utf8')
      : execFileSync('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', '-'], { input: buf, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    return parsePlistXml(xml);
  } catch {
    return null;
  }
}
const count = (v) => (Array.isArray(v) ? v.length : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// フォルダ配下のファイル数と総バイト数(名前は返さない)
function inventory(dir) {
  if (!existsSync(dir)) return { files: 0, bytes: 0 };
  let files = 0, bytes = 0;
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); const st = statSync(p); if (st.isDirectory()) walk(p); else { files += 1; bytes += st.size; } } };
  try { walk(dir); } catch { /* 読めない分は数えない */ }
  return { files, bytes };
}

// 統計(件数と数値だけ。ファイル名・音源名・プラグイン名は含めない): daw_adapter_v01 §4
function statsFrom(root, buffers) {
  const meta = buffers.meta ? readPlist(buffers.meta) : null;
  const info = buffers.info ? readPlist(buffers.info) : null;
  const out = { alternatives: savedAlternatives(root).length };
  if (meta && typeof meta === 'object') {
    Object.assign(out, {
      tracks: num(meta.NumberOfTracks),
      bpm: num(meta.BeatsPerMinute),
      sample_rate: num(meta.SampleRate),
      key: typeof meta.SongKey === 'string' ? meta.SongKey : null,
      key_mode: typeof meta.SongGenderKey === 'string' ? meta.SongGenderKey : null,
      time_signature: num(meta.SongSignatureNumerator) != null && num(meta.SongSignatureDenominator) != null ? `${meta.SongSignatureNumerator}/${meta.SongSignatureDenominator}` : null,
      audio_files: count(meta.AudioFiles),
      unused_audio_files: count(meta.UnusedAudioFiles),
      sampler_instruments: count(meta.SamplerInstrumentsFiles),
      impulse_responses: count(meta.ImpulsResponsesFiles),
    });
  }
  if (info && typeof info === 'object' && typeof info.LastSavedFrom === 'string') out.last_saved_from = info.LastSavedFrom;
  // Logic が保存ごとに残す版(C 層の証拠)
  let backups = 0, lastBackup = 0;
  for (const alt of savedAlternatives(root)) {
    const dir = join(root, 'Alternatives', alt, 'Project File Backups');
    if (!existsSync(dir)) continue;
    for (const n of readdirSync(dir)) { try { const st = statSync(join(dir, n)); if (st.isFile()) { backups += 1; lastBackup = Math.max(lastBackup, st.mtimeMs); } } catch { /* skip */ } }
  }
  out.backups = backups;
  out.last_backup_at = lastBackup ? new Date(lastBackup).toISOString() : null;
  const audio = inventory(join(root, 'Media', 'Audio Files'));
  const samples = inventory(join(root, 'Media', 'Samples'));
  out.media_audio_files = audio.files; out.media_audio_bytes = audio.bytes;
  out.media_samples = samples.files; out.media_samples_bytes = samples.bytes;
  for (const k of Object.keys(out)) if (out[k] === null) delete out[k];
  return out;
}

function savedAlternatives(root) {
  const dir = join(root, 'Alternatives');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((d) => d !== UNSAVED_ALT && /^\d+$/.test(d) && existsSync(join(dir, d, 'ProjectData')))
    .sort();
}

export const adapter = {
  id: 'logic-pro',
  displayName: 'Logic Pro',
  appNames: ['Logic Pro'],
  exportFormat: 'logicx-project',
  // Logic が入っているときだけ ~/Music/Logic を既定候補に並べる(本人が追加・除外できる: l2_lifecycle S7)
  defaultRoots: () => (existsSync(APP_PATH) ? [join(userHome(), 'Music', 'Logic')] : []),
  // 変更されたパスがパッケージ内の「保存を表すファイル」なら、パッケージのルートを返す
  matchPath: (path) => {
    const m = path.match(PKG_RE);
    if (!m) return null;
    const root = m[1];
    const rel = path.slice(root.length).replace(/^[\\/]/, '');
    if (rel === '') return root; // パッケージ自体の作成・改名
    return SAVE_FILE_RE.test(rel) ? root : null;
  },
  isUserWork: (root) => savedAlternatives(root).length > 0,
  hashWork: (root) => {
    const files = [];
    for (const alt of savedAlternatives(root)) {
      for (const name of ['ProjectData', 'MetaData.plist']) {
        const p = join(root, 'Alternatives', alt, name);
        if (existsSync(p)) files.push([`Alternatives/${alt}/${name}`, p]);
      }
    }
    const info = join(root, 'Resources', 'ProjectInformation.plist');
    if (existsSync(info)) files.push(['Resources/ProjectInformation.plist', info]);
    if (!files.some(([rel]) => rel.endsWith('ProjectData'))) return null; // 未保存
    files.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const hash = createHash('sha256');
    let bytes = 0;
    const buffers = {};
    for (const [rel, abs] of files) {
      const buf = readFileSync(abs);
      hash.update(rel).update('\0').update(buf);
      bytes += buf.length;
      // 統計はハッシュと同じ読み取り(buf)から取る(証拠ペアの整合)。複数の代替があれば最初の代替の MetaData
      if (rel.endsWith('MetaData.plist') && !buffers.meta) buffers.meta = buf;
      if (rel.endsWith('ProjectInformation.plist')) buffers.info = buf;
    }
    return { sha256: hash.digest('hex'), bytes, frames: null, stats: statsFrom(root, buffers) };
  },
  preview: () => null,
  // 書き出し(バウンス)した音源の候補にする拡張子。セッション中に記録するフォルダ内へ新しくできたものを候補にする
  artifactExtensions: ['wav', 'aif', 'aiff', 'mp3', 'm4a', 'caf', 'flac'],
  toolVersion: () => appVersion(APP_PATH),
  // 保存検知はディレクトリ mtime に頼らない(fs.watch はパッケージ内部の変更を個別に返す)
  isPackage: (root) => { try { return statSync(root).isDirectory(); } catch { return false; } },
};

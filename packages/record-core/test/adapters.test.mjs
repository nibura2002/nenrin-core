// 実行: npm test(packages/record-core で)
// 制作ツールのアダプタ(adapters/)の単体テスト。パッケージ形式(Logic の .logicx)の保存検知とハッシュの決定性。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADAPTERS, matchApp, matchWork, adapterById } from '../src/adapters/index.js';
import { adapter as logic } from '../src/adapters/logic.js';
import { adapter as csp } from '../src/adapters/csp.js';
import { parsePlistXml } from '../src/plist-xml.js';

const mkLogic = (root, { alt = '000', projectData = 'PD-v1', display = 'ui', media = true } = {}) => {
  mkdirSync(join(root, 'Alternatives', alt), { recursive: true });
  writeFileSync(join(root, 'Alternatives', alt, 'ProjectData'), projectData);
  writeFileSync(join(root, 'Alternatives', alt, 'MetaData.plist'), 'meta');
  writeFileSync(join(root, 'Alternatives', alt, 'DisplayState.plist'), display);
  mkdirSync(join(root, 'Resources'), { recursive: true });
  writeFileSync(join(root, 'Resources', 'ProjectInformation.plist'), 'info');
  if (media) { mkdirSync(join(root, 'Media', 'Audio Files'), { recursive: true }); writeFileSync(join(root, 'Media', 'Audio Files', 'take1.wav'), 'x'.repeat(1000)); }
};

test('登録簿: 前面アプリ名からアダプタを引く(空白・大小無視の部分一致)', () => {
  assert.equal(matchApp(ADAPTERS, 'Logic Pro')?.id, 'logic-pro');
  assert.equal(matchApp(ADAPTERS, 'CLIP STUDIO PAINT')?.id, 'clip-studio-paint');
  assert.equal(matchApp(ADAPTERS, 'CLIPStudioPaint')?.id, 'clip-studio-paint');
  assert.equal(matchApp(ADAPTERS, 'Finder'), null);
  assert.equal(matchApp(ADAPTERS, null), null);
  assert.equal(adapterById(ADAPTERS, 'logic-pro')?.displayName, 'Logic Pro');
});

test('CSP: .clip が作品ルート、CELSYS と内部復元ファイルは公開候補にしない', () => {
  assert.equal(csp.matchPath('/u/Documents/a.clip'), '/u/Documents/a.clip');
  assert.equal(csp.matchPath('/u/Documents/a.psd'), null);
  assert.equal(csp.isUserWork('/u/Documents/a.clip'), true);
  assert.equal(csp.isUserWork('/u/Library/CELSYS/x/a.clip'), false);
  assert.equal(csp.isUserWork('/u/Documents/ab12345678-9abc-def0-1234-567890abcdef.clip'), false);
});

test('Logic: パッケージ内の保存を表すファイルだけがパッケージのルートに写像される', () => {
  const root = '/u/Music/Logic/Song.logicx';
  assert.equal(logic.matchPath(root), root);
  assert.equal(logic.matchPath(`${root}/Alternatives/000/ProjectData`), root);
  assert.equal(logic.matchPath(`${root}/Alternatives/000/MetaData.plist`), root);
  assert.equal(logic.matchPath(`${root}/Resources/ProjectInformation.plist`), root);
  assert.equal(logic.matchPath(`${root}/Alternatives/000/DisplayState.plist`), null, 'UI 状態は保存ではない');
  assert.equal(logic.matchPath(`${root}/Alternatives/000/Undo Data.nosync/0001`), null, 'アンドゥは保存ではない');
  assert.equal(logic.matchPath(`${root}/Media/Audio Files/take1.wav`), null, 'メディアの追加は保存ではない');
  assert.equal(logic.matchPath('/u/Music/other.wav'), null);
  assert.equal(matchWork(ADAPTERS, `${root}/Alternatives/000/ProjectData`)?.adapter.id, 'logic-pro');
});

test('Logic: ハッシュは ProjectData / MetaData / ProjectInformation から決定的に作られ、UI 状態とメディアは影響しない', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'nenrin-logic-'));
  try {
    const a = join(tmp, 'A.logicx'); mkLogic(a);
    const b = join(tmp, 'B.logicx'); mkLogic(b, { display: 'different-ui', media: false });
    const ha = logic.hashWork(a); const hb = logic.hashWork(b);
    assert.equal(ha.sha256, hb.sha256, 'DisplayState とメディアの差はハッシュに影響しない');
    assert.equal(ha.bytes, 'PD-v1'.length + 'meta'.length + 'info'.length);
    assert.equal(logic.isUserWork(a), true);
    writeFileSync(join(a, 'Alternatives', '000', 'ProjectData'), 'PD-v2');
    assert.notEqual(logic.hashWork(a).sha256, ha.sha256, '本体の変更でハッシュが変わる');
    // 代替(Alternative)が増えると対象に加わる
    mkdirSync(join(a, 'Alternatives', '001'), { recursive: true });
    writeFileSync(join(a, 'Alternatives', '001', 'ProjectData'), 'PD-alt');
    assert.equal(logic.hashWork(a).stats.alternatives, 2);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('Logic: 未保存の新規プロジェクト(Alternatives/4294967295 のみ)は作品として扱わない', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'nenrin-logic-'));
  try {
    const u = join(tmp, 'Untitled.logicx');
    mkdirSync(join(u, 'Alternatives', '4294967295', 'Undo Data.nosync'), { recursive: true });
    writeFileSync(join(u, 'Alternatives', '4294967295', 'ProjectData'), 'unsaved');
    assert.equal(logic.isUserWork(u), false);
    assert.equal(logic.hashWork(u), null);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

const META_XML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>AudioFiles</key><array><string>a.wav</string><string>b&amp;c.wav</string></array>
  <key>UnusedAudioFiles</key><array/>
  <key>SamplerInstrumentsFiles</key><array><string>Piano.exs</string></array>
  <key>ImpulsResponsesFiles</key><array><string>x.SDIR</string><string>y.SDIR</string><string>z.SDIR</string></array>
  <key>BeatsPerMinute</key><integer>127</integer>
  <key>NumberOfTracks</key><integer>24</integer>
  <key>SampleRate</key><integer>44100</integer>
  <key>SongKey</key><string>C</string><key>SongGenderKey</key><string>major</string>
  <key>SongSignatureNumerator</key><integer>4</integer><key>SongSignatureDenominator</key><integer>4</integer>
  <key>HasARAPlugins</key><false/>
</dict></plist>`;

test('plist-xml: dict / array / integer / string / エンティティ / 空配列', () => {
  const v = parsePlistXml(META_XML);
  assert.equal(v.NumberOfTracks, 24);
  assert.deepEqual(v.AudioFiles, ['a.wav', 'b&c.wav']);
  assert.deepEqual(v.UnusedAudioFiles, []);
  assert.equal(v.SongKey, 'C');
  assert.equal(v.HasARAPlugins, false);
});

test('Logic: 統計は件数と数値だけで、ファイル名を含まない', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'nenrin-logic-'));
  try {
    const a = join(tmp, 'A.logicx'); mkLogic(a);
    writeFileSync(join(a, 'Alternatives', '000', 'MetaData.plist'), META_XML);
    writeFileSync(join(a, 'Resources', 'ProjectInformation.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>LastSavedFrom</key><string>Logic Pro 11.2</string></dict></plist>`);
    mkdirSync(join(a, 'Alternatives', '000', 'Project File Backups'), { recursive: true });
    writeFileSync(join(a, 'Alternatives', '000', 'Project File Backups', 'A [2026-09-08 120000].logicx'), 'bk');
    const { stats } = logic.hashWork(a);
    assert.equal(stats.tracks, 24);
    assert.equal(stats.bpm, 127);
    assert.equal(stats.audio_files, 2);
    assert.equal(stats.unused_audio_files, 0);
    assert.equal(stats.impulse_responses, 3);
    assert.equal(stats.time_signature, '4/4');
    assert.equal(stats.backups, 1);
    assert.equal(stats.media_audio_files, 1);
    assert.equal(stats.last_saved_from, 'Logic Pro 11.2');
    assert.ok(!JSON.stringify(stats).includes('a.wav') && !JSON.stringify(stats).includes('Piano'), '名前は含めない');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

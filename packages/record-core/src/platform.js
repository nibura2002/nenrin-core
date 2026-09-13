// プラットフォーム・アダプタ: OS依存のセッション検知シグナルを吸収する。
//   frontmostApp() → 前面アプリの名前(string|null)
//   idleSeconds()  → 最終入力からの経過秒(number|null)
//   userFolders()  → 監視候補のユーザーフォルダ(string[])
// macOS: lsappinfo / ioreg(権限不要)。Windows: PowerShell + user32.dll(追加ライブラリ不要)。
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const HOME = process.env.HOME ?? process.env.USERPROFILE;

// ── macOS
function macFrontmost() {
  try {
    const list = execFileSync('lsappinfo', ['list'], { encoding: 'utf8' });
    return list.match(/"([^"]+)" ASN:[^:]+:\s*\(in front\)/)?.[1] ?? null;
  } catch {
    return null;
  }
}
function macIdle() {
  try {
    const out = execFileSync('ioreg', ['-c', 'IOHIDSystem'], { encoding: 'utf8' });
    const ns = out.match(/"HIDIdleTime"\s*=\s*(\d+)/)?.[1];
    return ns ? Number(ns) / 1e9 : null;
  } catch {
    return null;
  }
}

// ── Windows
// PowerShellで user32.dll を呼ぶ。前面ウィンドウのプロセス名と最終入力からの経過msを1回でまとめて取得。
// 出力形式: "<プロセス名>|<idleMs>"
const PS_SCRIPT = `
$ErrorActionPreference='SilentlyContinue'
Add-Type @'
using System;using System.Runtime.InteropServices;
public class N {
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
 [StructLayout(LayoutKind.Sequential)] public struct LII { public uint cbSize; public uint dwTime; }
 [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LII pl);
 [DllImport("kernel32.dll")] public static extern uint GetTickCount();
}
'@
$h=[N]::GetForegroundWindow();$p=0;[void][N]::GetWindowThreadProcessId($h,[ref]$p)
$name=(Get-Process -Id $p).ProcessName
$l=New-Object N+LII;$l.cbSize=[System.Runtime.InteropServices.Marshal]::SizeOf($l)
[void][N]::GetLastInputInfo([ref]$l)
$idle=[N]::GetTickCount()-$l.dwTime
Write-Output ("{0}|{1}" -f $name,$idle)
`;
let winCache = { name: null, idle: null, at: 0 };
function winPoll() {
  // PowerShell起動は重いので、両値を1回のプロセスで取得し短時間キャッシュ
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', PS_SCRIPT], { encoding: 'utf8', timeout: 4000 });
    const [name, idleMs] = out.trim().split('|');
    winCache = { name: name || null, idle: idleMs ? Number(idleMs) / 1000 : null, at: Date.now() };
  } catch {
    winCache = { name: null, idle: null, at: Date.now() };
  }
  return winCache;
}
// Windowsのプロセス名は拡張子なし(例: "CLIPStudioPaint")。照合しやすいよう素の名前を返す
function winFrontmost() { return winPoll().name; }
function winIdle() { return winCache.at && Date.now() - winCache.at < 500 ? winCache.idle : winPoll().idle; }

// ── ユーザーフォルダ解決
// Windows は OneDrive の「既知フォルダー移動」でドキュメント/デスクトップが %USERPROFILE% 配下から
// 外れる(実測: C:\Users\<user>\OneDrive\Documents)。パスを自前で組み立てると実際の保存先を
// 丸ごと取りこぼすため、OS に解決させる。日本語フォルダ名(デスクトップ)があるので出力は UTF-8 に固定。
const FOLDER_PS = [
  '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
  "[Environment]::GetFolderPath('MyDocuments')",
  "[Environment]::GetFolderPath('Desktop')",
].join('; ');

function winUserFolders() {
  const legacy = [join(HOME, 'Documents'), join(HOME, 'Desktop')];
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', FOLDER_PS], {
      encoding: 'utf8',
      timeout: 8000,
    });
    const resolved = out.trim().split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    // リダイレクト先とレガシーパスの両方を候補にする(旧ファイルが %USERPROFILE% 側に残る環境がある)
    return [...resolved, ...legacy];
  } catch {
    return legacy;
  }
}

// macOS は Library/CELSYS(CSPの自動バックアップ)も過程の証拠として見る。
const macUserFolders = () => [join(HOME, 'Documents'), join(HOME, 'Desktop'), join(HOME, 'Library/CELSYS')];

const isWin = process.platform === 'win32';
export const frontmostApp = isWin ? winFrontmost : macFrontmost;
export const idleSeconds = isWin ? winIdle : macIdle;
export const userFolders = isWin ? winUserFolders : macUserFolders;
export const platformName = process.platform;
export const userHome = () => HOME;

// mac: アプリ本体の Info.plist からバージョンを取る(アダプタの toolVersion 用)。Windows は未対応(null)
function macAppVersion(appPath) {
  try {
    return execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print CFBundleShortVersionString', join(appPath, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}
export const appVersion = isWin ? () => null : macAppVersion;

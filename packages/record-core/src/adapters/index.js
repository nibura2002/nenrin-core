// 制作ツールのアダプタ登録簿(daw_adapter_v01 §3)。エンジンはこの登録簿だけを見る。
// 新しいツールはここに足す。各アダプタは { id, displayName, appNames, exportFormat, defaultRoots, matchPath,
// isUserWork, hashWork, preview, toolVersion } を実装する。
import { adapter as csp } from './csp.js';
import { adapter as logic } from './logic.js';

export const ADAPTERS = [csp, logic];

export const adapterById = (adapters, id) => adapters.find((a) => a.id === id) ?? null;

// 前面アプリ名との照合(空白・大小無視の部分一致。Windows のプロセス名は "CLIPStudioPaint" のように空白なし)
const norm = (s) => s.replace(/\s+/g, '').toLowerCase();
export function matchApp(adapters, front) {
  if (!front) return null;
  const f = norm(front);
  return adapters.find((a) => a.appNames.some((n) => f.includes(norm(n)))) ?? null;
}

// 変更されたパスから { adapter, root } を引く。どのアダプタにも該当しなければ null
export function matchWork(adapters, path) {
  for (const a of adapters) {
    const root = a.matchPath(path);
    if (root) return { adapter: a, root };
  }
  return null;
}

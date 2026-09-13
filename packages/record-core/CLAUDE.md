# CLAUDE.md — packages/record-core(記録コア。OSS 公開部分)

ルートの製品原則(/CLAUDE.md)が常に優先。ここは技術スタック固有のルール。

## スタック

- Node.js 22+ / ESM / 依存なし(node 組み込みのみ)。TypeScript にはしない(配布アプリに asar なしでそのまま入るので「読める」ことを優先)
- OS 差分は `src/platform.js` に閉じ込める(前面アプリ・アイドル秒・ユーザーフォルダ)

## 制作ツールの追加

ツールごとの差は `src/adapters/<tool>.js` に閉じ込め、`src/adapters/index.js` の登録簿に足す(設計: `docs/architecture/daw_adapter_v01.md` §3)。エンジン(`engine.js`)にツール名や拡張子を書かない。アダプタは前面アプリ名・作品ルートの写像・公開候補の判定・ハッシュ・統計・プレビュー・ツール版を持つ。追加したら `test/adapters.test.mjs` に写像とハッシュの決定性、`test/<tool>.test.mjs` にエンジン単位の通し(保存 → 発行)を足す。

## 公開前提の規律(ルート CLAUDE.md「リポジトリ戦略」)

1. **このパッケージからリポジトリ内の非公開部分(apps/・prototypes/・docs/business-design)を import しない**。`node tools/check-oss-deps.mjs` で検査する
2. 秘密情報・ビジネス情報・個人情報をコード・コメント・テストデータに書かない(公開対象のツリーはそのまま公開リポジトリに写される)
3. ネットワークに出す変更は必ず `NETWORK.md` を同じ PR で更新する(`fetch(` と 1 対 1)
4. 記録する内容を増やす変更は `README.md` の「何を記録するか」を更新し、製品原則 2(ローカルファースト)に反しないことを PR で説明する

## 配布アプリとの関係

- `prototypes/desktop-poc/engine/` はこのパッケージからの機械的なコピー(`tools/sync-engine.mjs`)。**直接編集しない**。変更後は desktop-poc で `npm run sync-engine` → `MANIFEST.json` も更新される
- `MANIFEST.json` の `record_core_commit` は、このパッケージを最後に変えたモノレポ側のコミット。公開リポジトリ(nibura2002/nenrin-core)への同期はスナップショット方式(`tools/sync-public-core.sh`、同期 1 回 = 1 コミット、本文にモノレポのコミット ID)で、公開側でこの ID を直接は引けない(2026-09-10 の判断: 配布物との突き合わせは案内しない)

## テスト

```sh
npm test                    # node --test 'test/**/*.test.mjs'
node --check src/engine.js
```

テストは外部に接続しない(アンカーサーバーは `test/` 内のモック)。ライフサイクル(再開・回復)は `test/lifecycle.test.mjs`、チェーンの読み戻しは `test/chain.test.mjs`。

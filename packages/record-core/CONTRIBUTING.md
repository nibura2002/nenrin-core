# コントリビュート / Contributing

## 正はモノレポ側にあります

このリポジトリ(nenrin-core)は、NENRIN のプライベートなモノレポから `packages/record-core` を切り出して公開しているものです。

- 変更の取り込みは **モノレポ → このリポジトリ** の一方向です(同期 1 回につき 1 コミット。本文にモノレポ側のコミット ID を記載)
- Pull Request はこのリポジトリで受け付けます。マージ相当の判断をしたうえで、モノレポ側に手で取り込み、次の同期でここに反映されます。そのため、この画面上では PR が「マージ」ではなく「取り込み済み」として閉じられることがあります
- 配布アプリに乗るのは、モノレポ側でリリースしたときです

## 変更するときの約束(製品原則)

1. **証明の誠実さ**: 証明できるのは「対象ツール上で制作の過程があった」ことだけです。「AI を使っていない」と断定する文言・スキーマ・UI は入れません
2. **ローカルファースト**: 本人が明示的に発行の操作をするまで、記録データは外部に送りません。送信先と内容を増減するときは必ず `NETWORK.md` を更新してください
3. **比較しない実績設計**: 作業時間の長さを実績として強調する表示や、ランキング・スコアは作りません
4. 記録スキーマは年輪カードの描画を前提にしています(セッション区切り・イベント分類・時間分布が取れること)

## 開発

```sh
npm test            # node --test 'test/**/*.test.mjs'
node --check src/engine.js
```

テストは外部サービスに接続しません(アンカーサーバーはテスト内のモックです)。

## 言語

README は英語(`README.md`)と日本語(`README.ja.md`)を別ファイルで置き、先頭のリンクで行き来します。片方だけを変更せず、両方を同じ変更で更新してください。判断に迷う場合は日本語を正とします。コードの識別子とコメントは英語・日本語が混在しています(段階的に英語へ寄せます)。

---

The source of truth is a private monorepo; changes flow one way (monorepo → this repo). PRs are welcome here and will be ported by hand. Please keep the product principles above: certify only that a creative process took place (never "no AI was used"), send nothing before the user explicitly publishes (update `NETWORK.md` when endpoints change), and do not turn recorded time into rankings or scores.

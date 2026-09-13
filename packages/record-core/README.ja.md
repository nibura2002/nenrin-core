[English](./README.md) | **日本語**

# @nenrin/record-core

制作ツール上の作業過程を端末内でハッシュチェーンとして記録し、外部アンカーによって事後の改変を検知できるようにするライブラリです。[NENRIN](https://nenrinapp.com) の記録コアとして使われています。JavaScript(ESM)で、依存パッケージはありません(Node.js の組み込みモジュールのみ)。

NENRIN が証明するのは「対象ツール上で制作の過程があったこと」であり、「AI を一切使っていない」といった断定はしません。このライブラリのスキーマもその範囲に留まります。

## 仕組み

1. 約 5 秒ごとに前面アプリと入力の有無を観測し、対象ツールが前面にあり入力が続いている区間を**セッション**として区切ります(前面から外れた直後の短い離脱は猶予として吸収します)
2. 監視フォルダ内で作品ファイルが保存されると、その sha256・サイズと、ツール固有の統計(件数と数値のみ)を**スナップショット**として記録します
3. 各イベントは直前のイベントのハッシュを含めて `events.jsonl` に追記されます(`chain.js`)
4. 約 60 秒ごととセッションの境界で、チェーン先頭のハッシュに本人の Ed25519 署名を付けてアンカーサーバーへ送り、受領時刻とサーバー署名をチェーンに追記します
5. 発行時に、イベント列を検証し、作業の要約(`WorkSummary`)を導出して送信します

## モジュール

| モジュール | 内容 |
|---|---|
| `engine.js` | 記録エンジン。`createRecorder()` |
| `chain.js` | イベントのハッシュ連鎖(`ChainWriter`、`eventHash`、`parseEventLog`) |
| `canonical.js` | ハッシュ対象の正規化 JSON(キー順を固定) |
| `keys.js` / `identity.js` | Ed25519 鍵の生成・署名・検証と、鍵とセッションの永続化 |
| `verify.js` | チェーンとアンカーの検証(`verifyWork`、`formatReport`) |
| `summary.js` | イベント列から `WorkSummary`(セッション、実作業時間、保存回数など)を導出 |
| `card.js` | `WorkSummary` から年輪カード(SVG)を描画 |
| `adapters/` | 制作ツール別アダプタと登録簿 |
| `platform.js` | OS 依存の観測(前面アプリ、アイドル秒、ユーザーフォルダ)。macOS / Windows |
| `auth.js` | サーバーへのログイン(任意) |
| `mockAnchor.js` | テスト用のアンカーサーバー |
| `dev/simulator.js`, `dev/tamper.js` | 記録の合成と改ざんの再現(検証が検知することの確認用) |

## 対応ツール

| アダプタ id | ツール | 作品の単位 | ハッシュと統計 |
|---|---|---|---|
| `clip-studio-paint` | CLIP STUDIO PAINT | `.clip` ファイル | ファイル全体の sha256。タイムラプスのフレーム数 |
| `logic-pro` | Logic Pro | `.logicx` パッケージ | `Alternatives/*/ProjectData`、`MetaData.plist`、`Resources/ProjectInformation.plist` を相対パス順に連結して sha256。音声(`Media/`)、UI 状態、アンドゥ履歴は対象外。統計はトラック数・テンポ・サンプルレート・キー・拍子・音声ファイル数・バックアップ数・メディアの件数と総量・最後に保存したアプリ(ファイル名・音源名・プラグイン名は含めない)。書き出した音源(wav/aif/mp3/m4a/caf/flac)を発行時に任意で紐付け可能 |

## 記録するイベント

イベントは作品ごとに `<worksDir>/<work_id>/events.jsonl` へ追記されます。

| イベント | 内容 |
|---|---|
| `core.work_start` / `core.restart` | 記録の開始・再開(work_id、ツール、鍵 ID) |
| `core.session_start` / `core.session_end` | 対象ツールが前面で入力がある区間の始まりと終わり |
| `sim.activity` | 約 5 秒ごとの入力の有無(内容は含まない) |
| `core.snapshot` | 作品ファイルの保存(sha256、サイズ、ツール、`tool_stats`) |
| `core.checkpoint` / `core.anchor_ack` | チェーン先頭への本人署名と、アンカーサーバーの受領署名 |
| `core.export` | 証明書の発行(作品ファイルのハッシュ。任意で書き出し音源の sha256・サイズ・形式・ファイル名) |

記録しないもの: ファイルの内容、キー入力の内容、ポインタの座標、画面やウィンドウの内容。観測しているのは「前面のアプリが対象か」「入力が続いているか」「監視フォルダ内の作品ファイルが保存されたか」の三点です。

## 通信

記録中に外へ出るのはチェーン先頭のハッシュとその署名だけです。記録本体は、本人が発行の操作をしたときにのみ送信されます。テレメトリはありません。エンドポイントと送信内容の全一覧は [NETWORK.md](./NETWORK.md) にあり、コード中の `fetch(` と 1 対 1 で対応しています。

## 使い方

### 記録

```js
import { createRecorder } from '@nenrin/record-core';

const rec = createRecorder({
  server: 'https://nenrinapp.com',   // アンカーサーバー
  worksDir: '/path/to/works',        // 記録の保存先
  roots: ['/path/to/watch'],         // 監視フォルダ
});
await rec.start();                   // 観測と記録を開始
const result = await rec.publish();  // 検証して発行。記録は続く
await rec.stop();                    // 停止。次回 start() で再開
```

| オプション | 既定 | 内容 |
|---|---|---|
| `server` | `https://nenrinapp.com` | アンカーと発行の送信先 |
| `worksDir` | `out/works` | 記録の保存先 |
| `roots` | OS のユーザーフォルダ | 作品ファイルを監視するフォルダ |
| `adapters` | 登録簿の全アダプタ | 使用するアダプタの配列 |
| `intervalSec` | 5 | 観測の間隔 |
| `idleThresholdSec` | 120 | この秒数入力がなければ非アクティブ |
| `anchorIntervalSec` | 60 | アンカーの間隔 |
| `sessionEndGraceSec` | 45 | 前面から外れてからセッションを閉じるまでの猶予 |
| `platform` | `platform.js` | `frontmostApp` / `idleSeconds` の差し替え(テスト用) |
| `onLog` | `console.log` | ログ出力先 |

### 検証

```js
import { verifyWork, formatReport } from '@nenrin/record-core';

// meta: { public_key_der_hex, ... }、events: チェーン、serverRecords: サーバーが持つ受領記録
const r = verifyWork(meta, events, serverRecords, {
  verifyReceipt: (rec) => /* サーバー署名の検証 */ true,
});
console.log(r.ok, r.internal_ok, r.external_ok, r.errors);
console.log(formatReport('work', r));
```

内部整合性(`internal_ok`)は構造・ハッシュ・本人署名で、ローカルだけで再計算できます。外部突合(`external_ok`)は受領記録との一致とサーバー署名で、事後改変の検知はこちらが担います。`verifyReceipt` を省略するとテスト用の `mockAnchor.js` の検証が使われます。

### 低レベル API

```js
import { ChainWriter, parseEventLog, eventHash, GENESIS, canonical, deriveSummary, renderCard } from '@nenrin/record-core';

const chain = new ChainWriter({ events: parseEventLog(text), onAppend: (e) => append(e) });
const summary = deriveSummary(meta, chain.events);   // WorkSummary
const svg = renderCard(meta, summary);               // 年輪カード
```

個別モジュールは `@nenrin/record-core/chain` のようにサブパスでも読み込めます(`package.json` の `exports`)。

## アダプタの追加

ツールごとの差は `src/adapters/<tool>.js` に閉じ込め、`src/adapters/index.js` の登録簿に追加します。アダプタは次のフィールドを持ちます。

| フィールド | 内容 |
|---|---|
| `id`, `displayName` | 識別子と表示名 |
| `appNames` | 前面アプリ名との照合に使う名前 |
| `exportFormat` | `core.export` に記録する形式名 |
| `defaultRoots()` | OS のユーザーフォルダに加えて監視する既定フォルダ |
| `matchPath(path)` | 変更されたパスから作品ルートを返す |
| `isUserWork(path)` | 発行候補にしてよい作品か(自動バックアップ等を除外) |
| `hashWork(path)` | `{ sha256, bytes, stats }` を返す |
| `artifactExtensions` | 発行時に紐付けられる書き出しファイルの拡張子 |
| `preview(path)` | 発行時のプレビュー画像(base64 PNG)、なければ `null` |
| `toolVersion()` | ツールの版、取れなければ `null` |

追加したら `test/adapters.test.mjs` に照合とハッシュの決定性、`test/<tool>.test.mjs` に保存から発行までの通しを加えてください。

## 開発

```sh
npm test                    # node --test 'test/**/*.test.mjs'
node --check src/engine.js
```

テストは外部に接続しません(アンカーサーバーは `mockAnchor.js`)。`dev/tamper.js` は、過去のイベントを書き換える・チェーン全体を再計算して署名し直す、の二通りの改ざんを再現し、後者が外部突合でのみ検知されることを確かめるためのものです。

## 動作環境

- Node.js 22 以上
- macOS / Windows(前面アプリとアイドル秒の取得を `platform.js` が OS ごとに実装。追加のネイティブ依存はありません)

## ステータス

初期段階です。記録スキーマと API は安定しておらず、予告なく互換性のない変更が入ることがあります。

## ライセンス・商標

Apache License 2.0([LICENSE](./LICENSE))。「NENRIN」の名称と年輪のロゴは商標であり、ライセンスの対象外です([TRADEMARK.md](./TRADEMARK.md))。脆弱性の報告は [SECURITY.md](./SECURITY.md)、変更の取り込み方は [CONTRIBUTING.md](./CONTRIBUTING.md) を参照してください。

# 何を送るか / What this code sends

このパッケージがネットワークに出す通信の全一覧です。コード中の `fetch(` と 1 対 1 で対応させています。
**エンドポイントや送る内容を増減する変更は、必ずこのファイルも更新してください。**

既定の送信先は `https://nenrinapp.com`(`createRecorder({ server })` で差し替え可。テストはモックサーバーに向けます)。

## 記録中(本人の操作なしに自動で行うもの)

| いつ | 経路 | 送るもの | 送らないもの |
|---|---|---|---|
| 起動時 | `GET /health` | なし | — |
| 起動時 | `POST /keys` | `key_id`(公開鍵のハッシュ)、`public_key_der_hex`(公開鍵) | 秘密鍵 |
| 記録の区切り(起動・セッション開始/終了・約 60 秒ごと) | `POST /anchors` | `key_id`、`seq`(通し番号)、`chain_head`(その時点のチェーン先頭のハッシュ)、`client_sig`(その署名) | 作品ファイル・ファイル名・パス・イベントの中身・入力内容 |

アンカーは「この時点までの記録がこのハッシュだった」という控えをサーバーに預けるもので、サーバーは受領時刻と自分の署名を返します(`core.anchor_ack` としてローカルのチェーンに追記)。**ハッシュからは記録の内容を復元できません。**

## 本人が「証明書を発行」を操作したときだけ

| 経路 | 送るもの | 送らないもの |
|---|---|---|
| `GET /pubkey` | なし(サーバーの公開鍵を取得して受領署名を検証) | — |
| `GET /anchors?key_id=…` | `key_id` | — |
| `POST /publish` | チェーンのイベント列(操作の種類・時刻・ハッシュ。`sim.activity` は入力の**有無**のみ。`core.snapshot.tool_stats` は件数と数値だけの統計)、`WorkSummary`(セッションと時間の要約)、作品ファイルの sha256・サイズ、`meta`(work_id・タイトル=ファイル名・ツールのアダプタ id・ペンネーム・key_id)、選んだ作品の完成プレビュー PNG(base64。サーバー側で長辺 400px に縮小し透かしを入れて保存)、任意で紐付けた書き出し音源の sha256・サイズ・形式・ファイル名 | 作品ファイル本体・書き出した音源本体・タイムラプスのコマ・キー入力やペンの座標・ファイルのパス・音声ファイル名・プラグイン名 |

`POST /publish` の後、サーバーは検証結果と検証ページの URL を返します。生の記録はサーバーで検証後に破棄され、要約・ハッシュ・透かし入りサムネイルだけが残ります(サーバー側の仕様)。

## ログイン(任意。`auth.js`)

| 経路 | 送るもの |
|---|---|
| `POST /auth/request` | メールアドレス(確認コードの送付先) |
| `POST /auth/verify` | 確認コード |
| `POST /account/handle` | ペンネーム |
| `POST /keys` / `POST /account/keys` | 公開鍵と、その鍵を持っていることの署名 |

ログインしなくても記録と発行はできます(証明書は「匿名(未認証)」名義)。

## 送らないことの約束

- 記録データ(イベント列)は、本人が「発行」の操作をするまで端末の外に出ません(アンカーはハッシュのみ)
- テレメトリ・クラッシュレポートの類は送りません
- 記録データを AI の学習に使いません(サービス側の恒久的なコミットメント)

---

Every network call made by this package is listed above and maps 1:1 to `fetch(` in the code. While recording, only the **hash** of the chain head is anchored (~every 60 s, plus at session boundaries); no file names, paths or event contents leave the machine. Only when the user explicitly publishes does the client send the event chain, the work summary, the file hash and a base64 canvas preview. No telemetry. Recorded data is never used for AI training.

[English](./README.md) | **日本語**

# @nenrin/verify-core

提出されたイベントチェーンとアンカーの受領記録を検証し、検証ページに表示する `WorkSummary` を導出する、サーバー側の検証ロジックです。[NENRIN](https://nenrinapp.com) の発行 API で使われています。TypeScript で、`node:crypto` のみに依存するため Node.js と Cloudflare Workers(`nodejs_compat`)の両方で動きます。

## モジュール

| モジュール | 内容 |
|---|---|
| `src/verify.ts` | `verifySubmittedChain()`。チェーンの連続性(各イベントが直前のハッシュを含む)、本人署名、アンカー受領記録との一致、サーバー署名、時計のずれを検証 |
| `src/summary.ts` | `deriveSummary()`。イベント列から作業セッション、実作業時間、保存回数などを決定論的に導出 |
| `src/crypto.ts` | 正規化 JSON(`canonical`)、SHA-256、Ed25519 の署名と検証 |

## 使い方

```ts
import { verifySubmittedChain, type ChainEvent, type AnchorRecord } from '@nenrin/verify-core/verify';
import { deriveSummary } from '@nenrin/verify-core/summary';

// events: 提出されたチェーン
// clientPubDerHex: 本人の公開鍵(DER, hex)
// anchorsById: サーバーが保持する受領記録(anchor_id をキーにした Map)
// serverPubDerHex: サーバーの公開鍵
// expectedKeyId: 提出者の鍵 ID
const result = verifySubmittedChain(events, clientPubDerHex, anchorsById, serverPubDerHex, expectedKeyId);
// result: { ok, internal_ok, external_ok, errors, stats, anchors_used }

if (result.ok) {
  const summary = deriveSummary({ work_id, title, tier }, events);
}
```

`internal_ok` は構造・ハッシュ・本人署名(ローカルで再計算できる整合性)、`external_ok` は受領記録との一致とサーバー署名(事後改変の検知)を表します。`errors` は種類別(`structure`、`hashes`、`checkpoints`、`ack_vs_chain`、`ack_vs_server`、`server_sig`、`export`、`clock`)の配列です。

## record-core との関係

`record-core` の `verify.js` / `summary.js` / `canonical.js`(JavaScript)と同じ規則の TypeScript 実装です。一点だけ意図的に異なり、鍵が複数の作品にまたがって使われることを前提に、「サーバーの全受領記録がチェーンに現れること」は要求せず、チェーン内の受領記録がサーバー側記録の正当な部分集合であることを検証します。

二重実装のため、どちらかを変更するときは必ず両方を変更し、同じ入力で同じ結果になることを確認してください(同一性テストは準備中です)。

## 証明の範囲

検証が保証するのは、提出された記録が途中で差し替えられておらず、アンカーの受領記録と整合していることです。NENRIN はこれをもって「対象ツール上で制作の過程があったこと」を証明し、「AI を使っていない」ことは主張しません。

## ステータス

初期段階です。API は安定しておらず、予告なく変わることがあります。

## ライセンス

Apache License 2.0([LICENSE](./LICENSE))。商標、脆弱性の報告、変更の取り込み方は `record-core` の [TRADEMARK.md](../record-core/TRADEMARK.md)、[SECURITY.md](../record-core/SECURITY.md)、[CONTRIBUTING.md](../record-core/CONTRIBUTING.md) と共通です。


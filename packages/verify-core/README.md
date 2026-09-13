**English** | [日本語](./README.ja.md)

# @nenrin/verify-core

Server-side verification logic: validates a submitted event chain against anchor receipts and derives the `WorkSummary` shown on verification pages. It is used by the publishing API of [NENRIN](https://nenrinapp.com). Written in TypeScript and dependent only on `node:crypto`, so it runs on both Node.js and Cloudflare Workers (`nodejs_compat`).

## Modules

| Module | Description |
|---|---|
| `src/verify.ts` | `verifySubmittedChain()`: chain continuity (each event embeds the previous hash), the author's signatures, agreement with anchor receipts, server signatures, clock skew |
| `src/summary.ts` | `deriveSummary()`: deterministically derives sessions, active time, save count and more from the event log |
| `src/crypto.ts` | Canonical JSON (`canonical`), SHA-256, Ed25519 signing and verification |

## Usage

```ts
import { verifySubmittedChain, type ChainEvent, type AnchorRecord } from '@nenrin/verify-core/verify';
import { deriveSummary } from '@nenrin/verify-core/summary';

// events: the submitted chain
// clientPubDerHex: the author's public key (DER, hex)
// anchorsById: receipts held by the server, keyed by anchor_id
// serverPubDerHex: the server's public key
// expectedKeyId: the submitter's key id
const result = verifySubmittedChain(events, clientPubDerHex, anchorsById, serverPubDerHex, expectedKeyId);
// result: { ok, internal_ok, external_ok, errors, stats, anchors_used }

if (result.ok) {
  const summary = deriveSummary({ work_id, title, tier }, events);
}
```

`internal_ok` reflects structure, hashes and the author's signatures (consistency that can be recomputed offline); `external_ok` reflects agreement with receipts and server signatures (detection of after-the-fact alteration). `errors` groups messages by kind (`structure`, `hashes`, `checkpoints`, `ack_vs_chain`, `ack_vs_server`, `server_sig`, `export`, `clock`).

## Relationship to record-core

This is a TypeScript implementation of the same rules as `verify.js` / `summary.js` / `canonical.js` in `record-core`. It differs in one deliberate respect: because a key may be used across several works, it does not require every receipt held by the server to appear in the chain, and instead verifies that the receipts in the chain are a valid subset of the server's records.

As the logic is implemented twice, change both together and confirm they produce identical results for the same input (an equivalence test is in preparation).

## What is certified

Verification guarantees that the submitted record has not been altered and is consistent with the anchor receipts. On that basis NENRIN certifies that a creative process took place in the target tool; it does not claim that no AI was used.

## Status

Early stage. The API is not yet stable and may change without notice.

## License

Apache License 2.0 ([LICENSE](./LICENSE)). Trademarks, vulnerability reporting and contribution policy are shared with `record-core`: [TRADEMARK.md](../record-core/TRADEMARK.md), [SECURITY.md](../record-core/SECURITY.md), [CONTRIBUTING.md](../record-core/CONTRIBUTING.md).

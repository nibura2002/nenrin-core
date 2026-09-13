**English** | [日本語](./README.ja.md)

# nenrin-core

The recording core and verification logic of NENRIN.

[NENRIN](https://nenrinapp.com) records the creative process inside production tools and certifies, as a third party, that a work was produced through that process. This repository publishes the core of the service under the Apache License 2.0: **recording** (hash-chaining the process and anchoring it externally) and **verification**. NENRIN's desktop app and server are built on this technology.

## Packages

| Package | Description |
|---|---|
| [`packages/record-core`](./packages/record-core) | Recording engine, hash chain, keys, verification, summary, tree-ring card rendering, per-tool adapters and OS adapters. JavaScript (ESM), no dependencies |
| [`packages/verify-core`](./packages/verify-core) | Server-side verification: validates a submitted chain against anchor receipts and derives the `WorkSummary`. TypeScript |

## Design overview

- **Local first**: records stay on the machine. While recording, only the hash of the chain head and its signature leave the device; the record itself is sent only when the user explicitly publishes. Every network call is listed in [NETWORK.md](./packages/record-core/NETWORK.md)
- **Hash chain**: every event embeds the hash of the previous one, so replacing an event breaks every hash after it and is caught by verification
- **External anchoring**: the chain head is periodically deposited with a server, which returns a timestamped receipt signature. Even the key holder cannot rebuild the chain afterwards without contradicting the receipts held by the server
- **Two-tier verification**: internal consistency (structure, hashes, the author's signatures; recomputable offline) is reported separately from external cross-checking (agreement with anchor receipts and server signatures)
- **Adapters**: tool-specific behaviour (app names, what counts as a work file, how to hash it, statistics) lives in adapters; the engine itself is tool-agnostic

## What is certified

NENRIN certifies that a creative process took place in the target tool. It does not assert that "no AI was used" or that "a human created this". That scope is kept consistent across schemas, verification results and user-facing text, and nothing in this repository claims more. Recorded data never leaves the device until the user publishes, and is never used for AI training.

## Intended uses

- Write an adapter for another production tool and record its process
- Run the recorder against your own anchor server (`createRecorder({ server })`)
- Embed verification of submitted records in your own service (`verify-core`)
- Read the record format and verification steps to see what NENRIN's certification rests on

## Getting started

Requires Node.js 22 or later. The packages are not published to the npm registry; clone the repository and reference them as local dependencies.

```sh
git clone https://github.com/nibura2002/nenrin-core.git
cd nenrin-core/packages/record-core
npm test                                          # no network access
npm install ../nenrin-core/packages/record-core   # from another project
```

See each package's README for usage.

## Specifications

Public versions of the record schema, the trust model (what is and is not guaranteed) and the coverage model are in preparation. Until then, refer to the `record-core` README, `NETWORK.md` and the comments in the code.

## Maintenance

Development happens in NENRIN's private monorepo; the published paths are synchronised here one way, one commit per sync, each referencing the monorepo commit it was taken from. Pull requests are accepted in this repository, ported into the monorepo, and appear here with the next sync. See [CONTRIBUTING.md](./packages/record-core/CONTRIBUTING.md).

## Status

Early stage. The record schema and the API are not yet stable; breaking changes may land without notice.

## License, trademarks, security

- [Apache License 2.0](./LICENSE)
- The NENRIN name and the tree-ring logo are trademarks and are not covered by the license: [TRADEMARK.md](./packages/record-core/TRADEMARK.md)
- Reporting vulnerabilities: [SECURITY.md](./packages/record-core/SECURITY.md)

**English** | [日本語](./README.ja.md)

# @nenrin/record-core

A library that records the creative process in production tools as a hash chain on the local machine, and anchors it externally so that later alteration can be detected. It is the recording core of [NENRIN](https://nenrinapp.com). Written in JavaScript (ESM) with no dependencies beyond Node.js built-ins.

NENRIN certifies that a creative process took place in the target tool; it does not assert that "no AI was used". The schema of this library stays within that scope.

## How it works

1. Every ~5 seconds the frontmost app and the presence of input are sampled; a span in which the target tool is frontmost with ongoing input is a **session** (brief switches away are absorbed by a grace period)
2. When a work file is saved under a watched folder, its sha256, size and tool-specific statistics (counts and numbers only) are recorded as a **snapshot**
3. Each event embeds the hash of the previous one and is appended to `events.jsonl` (`chain.js`)
4. Every ~60 seconds and at session boundaries, the chain head is signed with the author's Ed25519 key and sent to an anchor server; the receipt (timestamp and server signature) is appended to the chain
5. On publishing, the event log is verified, a `WorkSummary` is derived, and both are submitted

## Modules

| Module | Description |
|---|---|
| `engine.js` | Recording engine, `createRecorder()` |
| `chain.js` | Hash chaining of events (`ChainWriter`, `eventHash`, `parseEventLog`) |
| `canonical.js` | Canonical JSON for hashing (fixed key order) |
| `keys.js` / `identity.js` | Ed25519 key generation, signing, verification; persistence of keys and login session |
| `verify.js` | Verification of chain and anchors (`verifyWork`, `formatReport`) |
| `summary.js` | Derives the `WorkSummary` (sessions, active time, saves, …) from the event log |
| `card.js` | Renders the tree-ring card (SVG) from a `WorkSummary` |
| `adapters/` | Per-tool adapters and the registry |
| `platform.js` | OS-specific observation (frontmost app, idle seconds, user folders). macOS / Windows |
| `auth.js` | Optional login against the server |
| `mockAnchor.js` | In-process anchor server for tests |
| `dev/simulator.js`, `dev/tamper.js` | Synthetic records and tampering scenarios, for exercising verification |

## Supported tools

| Adapter id | Tool | Unit of work | Hashing and statistics |
|---|---|---|---|
| `clip-studio-paint` | CLIP STUDIO PAINT | `.clip` file | sha256 of the whole file; timelapse frame count |
| `logic-pro` | Logic Pro | `.logicx` package | sha256 over `Alternatives/*/ProjectData`, `MetaData.plist` and `Resources/ProjectInformation.plist` concatenated in path order; audio (`Media/`), UI state and undo history are excluded. Statistics: track count, tempo, sample rate, key, time signature, audio file count, backup count, media count and total size, last-saving app (no file, instrument or plug-in names). A bounced file (wav/aif/mp3/m4a/caf/flac) can optionally be attached on publishing |

## Recorded events

Events are appended per work to `<worksDir>/<work_id>/events.jsonl`.

| Event | Description |
|---|---|
| `core.work_start` / `core.restart` | Start or resume of recording (work_id, tool, key id) |
| `core.session_start` / `core.session_end` | Start and end of a span in which the target tool is frontmost with input |
| `sim.activity` | Presence of input every ~5 s (never its content) |
| `core.snapshot` | A save of the work file (sha256, size, tool, `tool_stats`) |
| `core.checkpoint` / `core.anchor_ack` | The author's signature over the chain head, and the anchor server's receipt |
| `core.export` | Issuance of a certificate (hash of the work file; optionally sha256, size, format and file name of a bounced file) |

Not recorded: file contents, keystrokes, pointer coordinates, screen or window contents. Only three signals are observed: whether the frontmost app is a target tool, whether input is ongoing, and whether a work file under a watched folder was saved.

## Network

While recording, only the chain-head hash and its signature leave the machine. The record itself is sent only when the user publishes. There is no telemetry. [NETWORK.md](./NETWORK.md) lists every endpoint and payload, one entry per `fetch(` in the code.

## Usage

### Recording

```js
import { createRecorder } from '@nenrin/record-core';

const rec = createRecorder({
  server: 'https://nenrinapp.com',   // anchor server
  worksDir: '/path/to/works',        // where records are stored
  roots: ['/path/to/watch'],         // watched folders
});
await rec.start();                   // start observing and recording
const result = await rec.publish();  // verify and publish; recording continues
await rec.stop();                    // stop; the next start() resumes
```

| Option | Default | Description |
|---|---|---|
| `server` | `https://nenrinapp.com` | where anchors and publications are sent |
| `worksDir` | `out/works` | storage directory for records |
| `roots` | OS user folders | folders watched for work files |
| `adapters` | all registered adapters | adapters to use |
| `intervalSec` | 5 | sampling interval |
| `idleThresholdSec` | 120 | seconds without input before considered idle |
| `anchorIntervalSec` | 60 | anchoring interval |
| `sessionEndGraceSec` | 45 | grace before a session closes after losing focus |
| `platform` | `platform.js` | override `frontmostApp` / `idleSeconds` (for tests) |
| `onLog` | `console.log` | log sink |

### Verification

```js
import { verifyWork, formatReport } from '@nenrin/record-core';

// meta: { public_key_der_hex, ... }, events: the chain, serverRecords: receipts held by the server
const r = verifyWork(meta, events, serverRecords, {
  verifyReceipt: (rec) => /* verify the server signature */ true,
});
console.log(r.ok, r.internal_ok, r.external_ok, r.errors);
console.log(formatReport('work', r));
```

`internal_ok` covers structure, hashes and the author's signatures and can be recomputed offline. `external_ok` covers agreement with anchor receipts and the server signatures; this is what detects after-the-fact alteration. If `verifyReceipt` is omitted, the test verifier from `mockAnchor.js` is used.

### Lower-level API

```js
import { ChainWriter, parseEventLog, eventHash, GENESIS, canonical, deriveSummary, renderCard } from '@nenrin/record-core';

const chain = new ChainWriter({ events: parseEventLog(text), onAppend: (e) => append(e) });
const summary = deriveSummary(meta, chain.events);   // WorkSummary
const svg = renderCard(meta, summary);               // tree-ring card
```

Individual modules are also importable by subpath, e.g. `@nenrin/record-core/chain` (see `exports` in `package.json`).

## Adding a tool adapter

Tool-specific behaviour goes in `src/adapters/<tool>.js`, registered in `src/adapters/index.js`. An adapter has the following fields:

| Field | Description |
|---|---|
| `id`, `displayName` | identifier and display name |
| `appNames` | names matched against the frontmost app |
| `exportFormat` | format name recorded in `core.export` |
| `defaultRoots()` | extra default folders to watch |
| `matchPath(path)` | map a changed path to the work root |
| `isUserWork(path)` | whether the path is a user work (excludes auto-backups etc.) |
| `hashWork(path)` | returns `{ sha256, bytes, stats }` |
| `artifactExtensions` | extensions of exported files that can be attached |
| `preview(path)` | preview image for publishing (base64 PNG) or `null` |
| `toolVersion()` | tool version or `null` |

When adding one, cover matching and hash determinism in `test/adapters.test.mjs` and a save-to-publish run in `test/<tool>.test.mjs`.

## Development

```sh
npm test                    # node --test 'test/**/*.test.mjs'
node --check src/engine.js
```

Tests make no network calls (the anchor server is `mockAnchor.js`). `dev/tamper.js` reproduces two tampering scenarios, editing a past event and rebuilding the whole chain with fresh signatures, to show that the latter is caught only by external cross-checking.

## Requirements

- Node.js 22 or later
- macOS / Windows (`platform.js` implements frontmost-app and idle detection per OS without native dependencies)

## Status

Early stage. The record schema and the API are not yet stable; breaking changes may land without notice.

## License and trademarks

Apache License 2.0 ([LICENSE](./LICENSE)). The NENRIN name and the tree-ring logo are trademarks and are not covered by the license ([TRADEMARK.md](./TRADEMARK.md)). See [SECURITY.md](./SECURITY.md) for reporting vulnerabilities and [CONTRIBUTING.md](./CONTRIBUTING.md) for how changes are accepted.

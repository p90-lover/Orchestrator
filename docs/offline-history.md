# Offline finished-history archive

This offline tool imports explicitly supplied JSON exports into a separate `offline-history.sqlite` archive. It never opens AO storage, creates executable coordinator sessions, starts a provider, or changes the app's production engine. Run it outside Electron main.

## Format

An export uses `format: "orchestrator-finished-history"`, `schemaVersion: 1`, a stable `exportId`, a `conversations` array and a `blobs` array. A conversation contains `id`, `workspaceId`, `engine` (`legacy-ao` or `orchestrator-native`), `name`, terminal `state` (`completed`, `failed`, `cancelled`) and ordered `events`. Each event has a stable `id`, strictly increasing nonnegative `sequence`, `type`, opaque JSON `data` and optional `blobIds`. Tool outcomes and approval reasons are retained inside event data. A blob has `id`, `mediaType`, canonical `dataBase64` and SHA-256 `sha256` of its bytes.

All top-level record fields are validated; unsupported fields are rejected rather than discarded. Nested event data is preserved. The complete export is validated before archive creation. Unknown schema versions and active conversations fail closed. Export identity plus canonical-content digest makes repeated imports idempotent; changed content or conversation identity overlap is an error.

Explicit limits: 16 MiB per export, 500 conversations, 10,000 total events, 2,000 events per conversation, 64 KiB event data, 1,000 blobs, 1 MiB per blob and 8 MiB total blob bytes. The archive has a 256 MiB page budget; exceeding a limit fails without truncation or automatic eviction. This is a bounded offline archive, not a production retention-policy implementation.

## Offline AO snapshot captures

`import-ao` accepts a separate capture envelope, not a stock export produced by the running application. Its `format` is `ao-conversation-pages`, `schemaVersion` is `1`, and `sourceCommit` must match the pinned AO snapshot wire revision in `src/ao-history-export.cjs`. Supply a stable `exportId`, `trimLargeFields: false`, `blobs: []` (if none), and `conversations: [{ workspaceId, pages }]`. An operator-supplied capture contains the unwrapped AO snapshot response for each page as `{ beforeSequence, snapshot }`, newest first. `beforeSequence` is `null` for the first page and equals the preceding snapshot's `oldestSequence` thereafter. Each blob is a normal archive blob plus its opaque AO `uri`; the importer checks bytes and never fetches a URI.

This first converter supports stopped, unbranched finished chats with complete pages. It retains the original conversation, session, turn and timeline IDs, content, order and approval detail. The archive puts the source snapshot metadata in a separate sequence-0 event and keeps the original AO sequences for actual events. Missing, trimmed, changed, active, branched or discontinuous captures are rejected before archive creation. Page-local turn inventories are merged; repeated turn identities must retain the same metadata. The importer has no network or database discovery. Source files must be explicitly supplied, unlinked regular JSON files.

## Capture from an isolated AO source

Run `node scripts/capture-ao-history.cjs <http://127.0.0.1:port> <source-commit> <session-id> <workspace-id> <export-id> <new-absolute-json-file>` only against an already authorized, isolated AO instance using the pinned revision. Supply its credential through `AO_CAPTURE_TOKEN` in the process environment, not a command-line argument. The source revision and Coding Tools workspace mapping are operator-supplied, not discovered by the tool. The destination's existing parent folder must be private and on the chosen project/data drive.

The command requests only the selected session's read-only snapshot pages, refuses redirects and does not start an AO process. It publishes no partial capture, writes no diagnostic files and prints only a verification receipt. This capture path supports finished text-only chats; AO's snapshot API describes user attachments without supplying their bytes, so the command refuses such histories. For a capture with attachments, supply the separately exported and hash-verified blobs to `import-ao` instead. Neither command is a reason to query or copy the live database.

## CLI

Requires Node 22.13+ with built-in SQLite. Every data path must be explicitly absolute. The export input must be a regular `.json` file; database paths are refused before reading.

```sh
node scripts/import-history.cjs import --data-root /absolute/archive --export /absolute/finished.json
node scripts/import-history.cjs import-ao --data-root /absolute/archive --export /absolute/ao-capture.json
node scripts/import-history.cjs read --data-root /absolute/archive --export-id export-1 --limit 50
node scripts/import-history.cjs read --data-root /absolute/archive --export-id export-1 --conversation-id chat-1 --after -1 --limit 50
node scripts/import-history.cjs rollback --data-root /absolute/archive --export-id export-1
node scripts/import-history.cjs export --data-root /absolute/archive --export-id export-1 --include-inactive true
```

Commands emit JSON to stdout and bounded error metadata to stderr, never diagnostic files. Export intentionally emits the retained history: keep that output private. Windows absolute drive paths work too.

Rollback marks one import inactive atomically. It does not delete history or blobs, downgrade schemas, reactivate a chat, or replay inference. Default reads hide inactive imports. Explicit export with `--include-inactive true` can recover their contents. Reimporting the identical export explicitly reactivates it without duplicating rows.

## Verified scope

`node --test --test-isolation=none --test-concurrency=1 tests/migration.test.cjs`: eight cases pass on Node 26.12.1. Covers IDs/order, tool outcomes, approval rationale, blob bytes, paging, idempotency, inactive rollback/reactivation, identity conflicts, invalid/active/oversized inputs, injected mid-transaction failure, newer-schema refusal without file changes, tamper detection and CLI argument routing.

The regression suite evaluates the CLI entry point in-process. A separate shell smoke also ran the actual CLI commands for import, paged read, rollback, retained export and identical reactivation. Native-prefixed conversation IDs, legacy IDs, event order and approval rationale survived the round trip. Both checks used synthetic exports; neither opened an AO database. `tests/ao-history-export.test.cjs` additionally covers the pinned AO-format converter, including cursor continuity and rollback. The capture, import and rollback chain is exercised by `tests/ao-snapshot-capture.test.cjs` via a local test peer with the pinned page shapes. None of these receipts come from a user's live session. An operator-supplied real export, branched/long-history migration, host archive display and packaged rollback remain required before AO removal.

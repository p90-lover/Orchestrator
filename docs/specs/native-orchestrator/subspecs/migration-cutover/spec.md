# Migration and AO removal

## 范围

Offline migration and verified engine cutover.

## 需求回链

FR-8 and FR-9. Explicit offline history import, engine affinity, reversible cutover and removal of the AO build/runtime dependency after demonstrated parity.

## Acceptance (EARS)

1. WHEN an offline export is imported THEN conversation IDs, ordering, tool outcomes and approval audit records SHALL be preserved and checked before activation.
2. WHEN import fails THEN original data SHALL remain untouched and the partial native import SHALL not be activated.
3. WHEN the engine is promoted THEN all scenarios in docs/compatibility.md SHALL have passing executable evidence, including installer and rollback checks.
4. WHEN those gates fail or remain unknown THEN AO SHALL remain available for existing sessions and the app SHALL not claim removal.
5. WHEN AO removal ships THEN the app package SHALL contain no AO daemon, renderer, build step or live storage dependency.
6. WHEN importing an operator-supplied capture of finished legacy AO snapshot pages THEN the importer SHALL validate the pinned wire format and complete cursor chain before writing, preserve original IDs, event ordering and payloads, and reject changed, running, truncated, branched or missing-blob captures rather than pretending they migrated.
7. WHEN the operator identifies an already authorized isolated AO endpoint and one finished session THEN the capture command SHALL use only bounded read-only snapshot requests to the specified loopback address, preserve the original snapshot pages, and create a new export only after validation. It SHALL NOT discover or start a daemon, read a database directly, follow a redirect, or overwrite an existing file.

## Offline archive contract

The first importer is an offline CLI, never called on Electron main. It consumes an explicitly supplied absolute `.json` export path, not an AO database or automatic discovery path. Export format `orchestrator-finished-history`, schemaVersion 1, carries an exportId and finished conversations. Each conversation retains its id, workspaceId, engine (`legacy-ao` or `orchestrator-native`), name, terminal state, and ordered events with stable id, strictly increasing sequence, type and JSON data. Optional blob records contain hash-verified base64 bytes; event data and unknown nested fields are preserved, never interpreted as executable instructions.

Imported history lives in a separate `offline-history.sqlite` archive under an explicit absolute data root. It never adds dispatchable sessions/turns to the coordinator database. An import is atomic and idempotent by exportId plus canonical-content digest. Existing conversation/event identities cannot be overwritten by another import. Validation, conflicts, unknown schema and storage failures must leave prior archive data and the source export unchanged. Size/count limits reject the whole input explicitly rather than truncate or evict it.

Rollback is a transactional visibility change for one import receipt, not deletion or a schema downgrade: mark the import inactive, retain its audit/content/blob rows, and exclude it from default history reads. Re-import of the identical export can explicitly reactivate it without inference or duplicated rows. Bounded conversation/event pages and round-trip export allow verification of ordering, tool outcomes, approval rationale and blob bytes. Future host history integration and a real supplied AO-export fixture are separate parity gates; a synthetic archive round trip does not certify them.

## 不做项

No live database access, active-turn import, forced restart, implicit activation of native sessions, deletion of original/history records, or AO dependency removal before parity.

## 涉及文件

Files: scripts/import-history.cjs, tests/migration/, Coding Tools build/package/host integration. Never read the live AO database during development. No blind full-database copy or forced app restart.

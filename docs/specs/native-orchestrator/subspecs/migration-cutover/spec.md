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

## 不做项

No live database access or forced restart.

## 涉及文件

Files: scripts/import-history.cjs, tests/migration/, Coding Tools build/package/host integration. Never read the live AO database during development. No blind full-database copy or forced app restart.

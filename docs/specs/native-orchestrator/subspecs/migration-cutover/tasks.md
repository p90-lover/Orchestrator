# Cutover tasks

- [ ] 1.1 Implement offline migration, rollback verification and final removal of AO dependencies.
  - 证据块: docs/design.md:66-80; docs/compatibility.md all required scenarios; Coding Tools build-agent-orchestrator.cjs provenance and assets.
  - Files: src/offline-history.cjs, scripts/import-history.cjs, tests/migration.test.cjs, host/build/package files.
  - Isolated archive slice: explicit finished-history JSON contract, complete validation, atomic idempotent import, stable IDs/order/tool and approval data, verified blobs, bounded reads, reversible import visibility and lossless round-trip export. No coordinator activation or AO database access. Actual AO export adaptation, host history display and package rollback remain separate unfinished gates.
  - Verified CLI slice: synthetic legacy/native exports round-trip through separate import, paged read, rollback, export and reactivation processes. A user-supplied capture from an actual AO instance and packaged rollback are not covered.
  - Support explicit offline captures of AO's pinned finished chat snapshot format. No HTTP collection or database access in the importer. Verify complete cursor paging, tool/approval metadata, blob integrity, fail-closed source validation and rollback with fixtures derived from the pinned wire schema.
  - Capture one finished text-only conversation from an explicitly named, already authorized isolated AO endpoint using the pinned read-only paged snapshot API. Reject redirects, unknown source revisions, changing or incomplete captures and missing attachment data before writing a new private file. No daemon discovery, launch, database access, installed settings change or existing file overwrite.
  - Requirements: FR-8, FR-9.
  - Acceptance: import/export fixture parity, authorized canary/live checks, installer and rollback verification, no remaining AO dependency in packaged native path.

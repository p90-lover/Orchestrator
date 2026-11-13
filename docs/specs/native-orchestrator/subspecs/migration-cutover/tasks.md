# Cutover tasks

- [ ] 1.1 Implement offline migration, rollback verification and final removal of AO dependencies.
  - 证据块: docs/design.md:66-80; docs/compatibility.md all required scenarios; Coding Tools build-agent-orchestrator.cjs provenance and assets.
  - Files: scripts/import-history.cjs, tests/migration/, host/build/package files.
  - Requirements: FR-8, FR-9.
  - Acceptance: import/export fixture parity, authorized canary/live checks, installer and rollback verification, no remaining AO dependency in packaged native path.

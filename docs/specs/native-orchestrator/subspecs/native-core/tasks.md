# Native core tasks

- [ ] 1.1 Implement durable native storage and coordinator with explicit recovery, bounded queue and deduplicated client IDs.
  - 证据块: src/orchestrator-handler.cjs:5-16 defines the current boundary; docs/design.md:44-64 defines state and recovery constraints.
  - Files: src/native-store-worker.cjs, src/native-store.cjs, src/native-engine.cjs, tests/native-engine.test.cjs.
  - Requirements: FR-1, FR-2, FR-3.
  - Acceptance: executable synthetic-driver tests cover duplicate/conflicting IDs, ordered queue, cancellation, restart unknown state, failed writes and bounded event pages.

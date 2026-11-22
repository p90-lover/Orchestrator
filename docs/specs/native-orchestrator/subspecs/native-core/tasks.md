# Native core tasks

- [ ] 1.1 Implement durable native storage and coordinator with explicit recovery, bounded queue and deduplicated client IDs.
  - 证据块: src/orchestrator-handler.cjs:5-16 defines the current boundary; docs/design.md:44-64 defines state and recovery constraints.
  - Files: src/native-store-worker.cjs, src/native-store.cjs, src/native-engine.cjs, tests/native-engine.test.cjs.
  - Requirements: FR-1, FR-2, FR-3.
  - Acceptance: executable synthetic-driver tests cover duplicate/conflicting IDs, ordered queue, cancellation, restart unknown state, failed writes and bounded event pages. If the driver cannot confirm cancellation during coordinator shutdown, preserve the active turn as unknown and retain its queued successor on reopen. Do not treat a local abort as proof of a remote stop. In Coding Tools, pass the saved native turn ID to interruption, share in-flight stops only for that turn, and require its exact cancellation or terminal receipt. Missing ownership, a different current turn, or an unconfirmed stop must not shut down the session.
  - Fill a disposable native SQLite store to its page budget, verify the existing input receipt is still readable and duplicate acceptance is stable, and verify a refused input never reaches its driver. Page through large multibyte stream events within a byte budget and verify complete ordered reconstruction without truncation. Checkpoint latency and the WAL under a pinned reader require separate load evidence.

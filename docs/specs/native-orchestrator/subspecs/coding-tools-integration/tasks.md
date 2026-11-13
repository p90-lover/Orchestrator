# Integration tasks

- [ ] 1.1 Implement the native host adapter and an opt-in test plugin, then verify actual Coding Tools flows.
  - 证据块: src/orchestrator-handler.cjs:5-16; app-handler/host.cjs registered-module boundary; desktop-electron/electron/chat-mcp-servers.cjs supported extension mechanism.
  - Files: src/compatibility-plugin.cjs, scripts/, app adapter and tests.
  - Requirements: FR-6, FR-7.
  - Acceptance: synthetic scenarios and actual UI checks with no production-engine replacement until parity gates pass.

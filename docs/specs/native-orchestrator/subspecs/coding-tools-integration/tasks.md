# Integration tasks

- [ ] 1.1 Implement the native host adapter and an opt-in test plugin, then verify actual Coding Tools flows.
  - 证据块: src/orchestrator-handler.cjs:5-16; app-handler/host.cjs registered-module boundary; desktop-electron/electron/chat-mcp-servers.cjs supported extension mechanism.
  - Files: src/compatibility-plugin.cjs, src/native-runtime-adapter.cjs, src/engine-router.cjs, src/native-store-worker.cjs, src/native-engine.cjs, scripts/, app adapter and tests/native-runtime-adapter.test.cjs/tests/engine-router.test.cjs.
  - First isolated adapter slice: persist non-secret session settings; native-prefixed identities; bounded observation/history; truthful unsupported-method errors; read-only recovery; per-session engine routing with no fallback. This establishes an executable bridge, not live parity.
  - Product workflow probe: `node scripts/check-native-coding-tools.cjs <trusted-app-checkout>` uses the actual Coding Tools runtime factory and its trusted `composeRuntime` callback, plus real `advance`/`observe`, handler routing, native SQLite and the Codex driver with an in-process protocol peer. Checks the host reservation identity, one launch under exact-ID retry, same-session follow-up, scoped approval denial, explicit unsupported steering and history after reopen; legacy never starts. No live provider or installed host activation.
  - Verify the supported HTTP MCP path using the host's real isolated configuration store and official MCP SDK client; verify localhost binding, token/Origin enforcement, bounded requests and readiness reporting. Keep the stdio path unchanged. An isolated Codex app-server discovered the HTTP plugin with no inference. This is separate from native-engine turn verification.
  - Requirements: FR-6, FR-7.
  - Acceptance: synthetic scenarios and actual UI checks with no production-engine replacement until parity gates pass.

# Version 0.1.0 verification

Verified locally on Windows on 2026-11-13:

- `node --test --test-isolation=none tests/handler.test.cjs`: **9 passed**, no failures or skips.
- `node scripts/check-coding-tools.cjs <checkout>` against Coding Tools `adad0a6baf1cb936787c9bb32467382f36550007` plus the handler integration: **passed**, all 9 runtime and 27 harness methods present, stopped snapshot unchanged, no engine started.
- In the Coding Tools integration checkout, `node --test --test-isolation=none desktop-electron/tests/orchestrator-handler.test.cjs desktop-electron/tests/agent-orchestrator-lifecycle.test.cjs desktop-electron/tests/backend-bundle.test.cjs desktop-electron/tests/main-sync-calls.test.cjs`: **66 passed**, no failures or skips, about 108 seconds.

The initial isolated test-worker attempt failed with `spawn EPERM` before tests ran. The same suite passed in-process without changing sandbox permissions. Graph commands that spawn git require the normal shell on this machine; index and registry storage remain on the project drive.

These results validate the handler and legacy adapter integration, not an independent native engine. No paid model calls, live chat mutations, database migration, app installation or app restart were performed. The full app release suite and installer checks belong to the coordinated Coding Tools release owner; they are not claimed here.

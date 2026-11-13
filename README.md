# Orchestrator

An independently versioned orchestration handler and compatibility contract for Coding Tools.

**Status: experimental native prototype, not a compatible AO replacement.** Version 0.2.0-alpha.1 adds an independent session/turn/event core, a read-only Codex protocol prototype and an isolated compatibility-test MCP plugin. The version-1 handler still wraps the existing AO adapter. Production chat cutover and removal of AO are **not implemented**. See [the plugin guide](docs/native-plugin.md), [the design](docs/design.md) and [cutover requirements](docs/compatibility.md).

## Why a separate project?

Coding Tools needs session-scoped tools, provider routing, permission decisions, durable turns and Windows recovery. Its pinned AO fork implements several of these inside daemon code rather than through a public extension mechanism. Replacing that daemon with stock AO behind a proxy would lose behavior. Renaming or copying the fork would not solve the maintenance problem either.

Orchestrator separates the app-facing contract from engine implementation. The initial engine remains the current AO adapter, so existing conversations, permission checks and recovery behavior stay where they are. A native engine can later implement the same contract without requiring every app caller to change.

## Use

```js
const { createOrchestratorHandler } = require('./src/orchestrator-handler.cjs');
const handler = createOrchestratorHandler({ runtime: existingAoAdapter });
const sessionId = await handler.harness.spawn(launchOptions);
```

The runtime must implement all 9 runtime methods and all 27 harness methods. Construction checks method availability before invoking anything. Forwarding preserves argument objects, receivers, exact return values, promises, synchronous errors and subscription cancellation functions. A handler is bound to one runtime; it never retries, replays, changes approval decisions or silently switches engines.

`inspectRuntime()` reports **shape compatibility only**. A compatible shape is not behavioral certification. See the explicit release gates before using a different engine.

## Verify

Node 22.13 or newer, no package install or network needed for the native runtime and unit tests:

```sh
node --test --test-isolation=none tests/*.test.cjs
node scripts/check-coding-tools.cjs /absolute/path/to/coding-tools-mcp
```

For the isolated host registration and stdio round-trip check, use the existing MCP SDK in a trusted Coding Tools checkout with its runtime-web dependencies installed:

```sh
node scripts/check-plugin-coding-tools.cjs /absolute/path/to/coding-tools-mcp
```

In a sandbox that prohibits spawning the Node test worker:

```sh
node --test --test-isolation=none tests/handler.test.cjs
```

The source-checkout check instantiates the real Coding Tools adapter without starting AO, creating sessions or accessing its live database. It compares every exposed method and the stopped snapshot. It intentionally reports native-engine behavioral parity as `not_certified`.

## Scope and ownership

- This repository owns the handler contract, conformance tests, native-engine prototype and migration design.
- Coding Tools owns UI, task/team policy, approvals, provider-account selection and tool grants.
- The legacy AO adapter still owns daemon-specific transport, host recovery and its database until those responsibilities have verified replacements.
- No telemetry, disk logging, background polling, provider SDK, dynamic plugin loading or runtime network dependency is added by this handler.
- No AO source is copied into this repository. If an implementation later reuses AO source, its Apache-2.0 license and notices must be retained.
- The package is private/unlicensed pending an explicit licensing decision; it is not published to npm.

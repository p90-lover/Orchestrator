# Coding Tools compatibility gates

## What version 0.1.0 verifies

The handler is a pass-through boundary around the existing runtime, not a replacement runtime. Its unit tests enumerate every method, preserve opaque arguments and receivers, return the original promise/value/error, keep `watch` synchronous, reject missing methods/version mismatches, and perform no retries. The source-checkout probe instantiates the actual adapter without starting AO, then compares both method inventories and the stopped snapshot.

These checks establish **handler forwarding and interface compatibility**. They do not establish full compatibility of a new engine. `inspectRuntime().shapeCompatible` deliberately says nothing stronger.

## Native-engine cutover matrix

Every row is required before a replacement engine becomes the default. Version 0.2.0-alpha.1 has isolated prototype coverage for acceptance, deduplication, turn cancellation, event paging and conservative restart recovery, plus a read-only Codex protocol adapter. The isolated host workflow probe also verifies Codex steering with exact native and provider turn identities, bounded schema-3 receipts and no replay after an uncertain acknowledgement. That probe uses fixture inference; interactive approvals and real provider turns are not covered. The separate embedded Pi experiment ran the installed Pi SDK through the real host factory and workflow with an isolated loopback fixture, using in-memory settings, sessions and credentials and no tool discovery. Only the native engine's product SQLite files were written in the probe. It proves a subprocess-free, log-free text transport for that configuration, not real model behavior, interactive approvals or native product parity. **No row below is certified for production cutover.** The [MCP plugin check](native-plugin.md) verifies a tool integration, not replacement of the host's chat runtime. Legacy AO remains the production path.

| Area | Required evidence |
| --- | --- |
| Launch | All supported harnesses; model, effort, context window, plain prompt, async and warm startup; invalid options fail before side effects. |
| Provider routing | CPA/native routes, account isolation, missing and rotated credentials, no silent personal-sign-in fallback. |
| Tools | Session-bound MCP leases, HTTP/SSE/stdio servers, resume renewal, per-workspace file boundary, terminal/preview/computer opt-ins. |
| Approvals | Every supported permission mode; approve, deny with rationale, delayed/out-of-page approvals, stale request rejection, reviewer timeout. |
| Turns | Send, steer, queued follow-up, idempotency, ambiguous response, interrupt, stop, resume, no duplicate inference. |
| History | Existing IDs, ordered messages/tool calls/results, reasoning and compaction boundaries, bounded pagination, image/blob handling. |
| Events | Reconnect, replay cursor expiry, event loss/duplication, disconnect mid-frame, bounded buffers and correct idle notification. |
| Recovery | App/daemon/host crashes, Windows PID reuse, unknown turn state, absent host records, no unsafe queue redelivery. |
| Workspaces | Folder/shared/worktree modes, correct root, dependency links, owned process tree, cleanup that does not delete shared data. |
| Product behavior | Single chats, teams, subagents, goals, schedules, wakeups, terminal agents, context/usage reporting. |
| Security | Loopback exposure, authorization, untrusted terminal links, no credential persistence, sandbox mode fidelity. |
| Performance | Cold start, streaming, large history, many concurrent sessions, slow disk, bounded writer holds and maintenance. |
| Packaging | Exact source provenance, daemon/runtime assets, backend closure, upgrade and rollback with existing sessions. |

## Version-1 methods

The authoritative required lists are `RUNTIME_METHODS` and `HARNESS_METHODS` in `src/orchestrator-handler.cjs`. The real-checkout probe verifies the required inventory and reports known optional methods. Handler 0.1.1 adds optional `busyChatSessions` for the host's autonomous-turn discovery. Engines that have it keep the original receiver and result; older engines can omit it. An additional upstream method requires a deliberate contract decision and conformance coverage in both repositories.

Version 1 retains the legacy method signatures and opaque operation payloads. It is not yet a serialized wire schema. Any native implementation must freeze fixtures for arguments, return shapes, terminal states and error codes before claiming semantic parity. Never infer compatibility solely from an object having function properties.

## Embedded Pi canary

`node scripts/check-native-pi.cjs <absolute Coding Tools checkout> <absolute installed Pi SDK package directory>` reuses a trusted installed `@earendil-works/pi-coding-agent` 1.5.0 and its nested `pi-ai` dependency. It does not install a package or run a harness subprocess. The test passes only a synthetic credential to its own IPv4 loopback model-protocol fixture. The SDK uses the approved model, no discovered tools, and no automatic retry, catalog refresh, cache warming or compaction. The driver allows one matching provider request in each turn and requires an authoritative completed text response. Tests inspect the task-local tree after both chat turns to verify there are no harness files, then remove it. A real provider, tool grants, approval, steering, restart reattachment and packaging need separate verification. This is not registered in installed Coding Tools.

## Reproducibility

Record the exact Coding Tools commit, AO gitlink, handler commit and test commands for each compatibility run. Do not include live user prompts, credentials, account identifiers, local machine paths or copied database contents in public fixtures. Use synthetic sessions and mock protocol peers until explicit live verification is requested and authorized.

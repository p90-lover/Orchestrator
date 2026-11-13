# Handler-first Orchestrator design

Date: 2026-11-13. Status: accepted migration direction; isolated native core/protocol prototype implemented in 0.2.0-alpha.1. Product integration, full driver parity and cutover remain incomplete. The boundaries and final-engine rules below remain the target design, not a claim that every capability exists.

## Decision

Use one explicit handler boundary with engine-specific drivers. Keep the current AO implementation as the legacy engine during migration. Develop a separate native engine only behind the same app-facing contract and a behavioral compatibility gate. Do not switch the app to stock AO or relabel the fork as a rewrite.

## Verified baseline

Initial inspection used Coding Tools `0d05727f0eb21935f40e6025a5cca4c0114a62c9`, AO `99d1ab0ec64c8327a0770a525d7f1700876ed307`, and the build's declared upstream base `4c7dbf0ff4d1aacc30567229dd65003a8e7e1c3b`. A no-renames diff reports 303 changed files, 26,447 inserted and 10,856 deleted lines. These are source-delta counts, not a measurement that every line is a Coding Tools requirement.

The integration baseline was refreshed to Coding Tools `adad0a6baf1cb936787c9bb32467382f36550007`, which pins AO `37e2e6263f4761b717f073241aae5d5b7c10f822`. The full legacy adapter's surface was inventoried by instantiation: 9 runtime methods and 27 harness methods. The initial fork assessment is scoped to the stated upstream base; it is not a claim that all future upstream releases lack these capabilities.

Evidence paths in Coding Tools:

- `desktop-electron/electron/agent-orchestrator-upstream.cjs`: app/daemon adapter, lifecycle, timeline projection and harness surface.
- `desktop-electron/electron/agent-orchestrator-workflow.cjs`: tasks, teams, provider routing, grants, queues and goals.
- `desktop-electron/electron/ao-session-events.cjs`: server-sent event consumption and renderer notifications.
- `desktop-electron/scripts/build-agent-orchestrator.cjs`: fork and upstream provenance, local-only daemon and renderer packaging.
- `module/agent-orchestrator/backend/internal/httpd/controllers/dto.go`: fork-specific session options and approval rationale.
- `module/agent-orchestrator/backend/internal/storage/sqlite/store/wal_checkpoint.go` and `maintenance.go`: internal storage fixes that a reverse proxy cannot supply.
- `docs/fixes/ao-stability-plan-2026-11-11.md`: measured writer stalls and lifecycle failure history; individual items can have advanced since that document.

## Why not stock AO plus a proxy?

The compared base does not expose the same per-session `gateway`, `mcpServers`, `plainPrompt`, asynchronous provisioning and context-window behavior used by Coding Tools. Provider credentials and tool leases must be injected into the correct child process, not merely added to an HTTP body the daemon ignores. Approval denial rationale must reach the harness. Windows child ownership and SQLite write contention are internal concerns. A proxy may normalize responses or throttle reads, but cannot repair those internals.

Some extensions could be proposed upstream. Until actually available and behaviorally tested, they are not a compatible engine. Stock AO remains a possible future driver, not a current default.

## Responsibility boundaries

1. **Coding Tools host:** visible UI, tasks, teams, goals, schedules, provider-account selection, per-chat authorization, tool grants, workspace policy, packaging and upgrade consent.
2. **Orchestrator handler:** stable app-facing operations and normalized events. One bound engine per handler; no implicit fallback, mutation retries or approval escalation. Current implementation is the transparent version-1 boundary.
3. **Engine driver:** translate handler operations to an engine's protocol. Legacy AO uses its existing adapter. Future native drivers use documented harness protocols rather than patching harness source.
4. **Native coordinator (future):** durable command acceptance, session/turn state, event journal, scheduling and recovery. It must not duplicate task/team product policy.
5. **Process supervisor (future):** owned process handles, isolated child environment, session-scoped tool credentials, bounded stop and recovery. It must not infer ownership from a reused PID.
6. **Event/storage layer (future):** bounded projections and maintenance. Exactly one authority for each session/turn; never let both AO and the new engine write the same live store.

The legacy runtime surface includes `show`, `hide`, `call` and `aoShimFolder` because existing consumers require them. These are compatibility obligations, not a claim of a clean final domain API. A later contract version should split display integration and tool-runtime discovery only with a host migration. Do not silently drop these methods in version 1.

## Native engine rules

### Commands and state

Persist acceptance and a client request ID before acknowledging a mutating command. De-duplicate within the owning session. Track session, turn, harness connection and command identities separately. After transport loss, inspect accepted state; never resubmit an ambiguous spawn/send to another engine.

Session lifecycle: created, provisioning, ready, working, waiting for input/approval, stopping, stopped, failed. Turns keep their own queued/running/terminal state; a session being alive is not proof that its turn is progressing. All state changes carry monotonic event sequence numbers. Unknown state stays unknown rather than being projected as completion.

### Events and storage

Persist durable boundaries before publishing; batch stream deltas and keep bounded projections for UI reads. Replay from an event cursor and take a fresh snapshot when the cursor has expired. Bound in-memory queues and apply backpressure. Do not scan a whole conversation to answer a recent-tail request. Pending approvals must remain discoverable outside recent-page limits.

Foreground command writes take priority over bounded retention, checkpointing and usage maintenance. Measure writer wait/hold time and stalled projections in memory. A new event journal is not by itself a performance fix; retain stress fixtures and measure on slow storage.

### Permissions and providers

Keep grants bound to workspace, session, request and selected policy. Unsupported modes fail before launch. Do not emulate approval by treating a missing capability as allow. Reviewer rationale is data sent to the requesting harness, not an instruction to a separate privileged process. Temporary credentials stay in memory and the intended child environment, never in generic event payloads or logs.

Provider-account selection stays in Coding Tools. Drivers receive a scoped resolved connection and must not fall back to the agent's unrelated personal sign-in if that connection is missing. Refreshing a key must not replay an in-flight turn.

### Process recovery

Use owned process handles and a launch-instance identifier. Stop/interrupt are distinct from permanently destroying a session. An app restart may reconnect to a live host only when identity and protocol capability match. A failed reconnect preserves history and reports uncertainty; no silent model restart or duplicate queue drain.

## Migration and rollback

1. Land this contract and transparent legacy handler. No schema migration, daemon pin change, new poll or restart.
2. Freeze launch/read/control/event fixtures and add executable cross-engine scenario tests. Split the legacy adapter's policy and protocol incrementally, without deleting working behavior.
3. Implement native process drivers, coordinator and event store in this repository. Do not copy the monolithic AO fork under a new name.
4. Run isolated side-by-side tests on synthetic data. Shadow read-only projections only; never shadow mutating requests to both engines.
5. Canary new sessions only with explicit engine affinity and a rollback to the legacy engine for *new* sessions. Existing AO sessions continue using AO.
6. Import finished history only after a read-only exporter and fixture-tested importer preserve IDs, order, tool results and approval audit records. Never open the user's live AO database for development or share its writer.
7. Remove the fork only after all required engine scenarios, live harness checks, installer verification and rollback rehearsal pass. Retain historical attribution for reused source.

Rolling back the version-1 boundary is a source revert with no data action. Future native rollback requires that every persisted session records its engine/version; do not let an older engine consume a newer schema. Keep the old reader available until native history can be exported safely.

## Risks and unresolved work

The boundary has high app-startup impact. Backend bundle closure must include the vendored module. Method-shape checks do not prove semantic compatibility. Version 0.2.0-alpha.1 adds only an isolated native storage/coordinator and read-only Codex protocol prototype. Storage migration, production driver capability negotiation and a live host-chat parity run remain absent. The current AO fork remains required for production chats. Those are explicit completion gates, not features implemented by the design document.

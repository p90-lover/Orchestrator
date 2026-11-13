# Native Orchestrator design

## 概述

This design covers FR-1, FR-2, FR-3, FR-4, FR-5, FR-6, FR-7, FR-8 and FR-9.

## 技术方案

Coding Tools host -> versioned handler -> native coordinator -> explicit driver adapter. A separate storage worker owns a SQLite database in the explicitly configured native data directory. Existing AO storage is never opened. The pure contract remains usable for the transition but does not implement the engine.

## Data model

Sessions contain stable ID, workspace ID, harness ID, state and created/updated timestamps. Turns contain session ID, local turn ID, client request ID, request content hash, state, answer and error. Event rows use a global increasing sequence, session/turn identity and bounded JSON payload. Requests with the same client ID and different content fail. Schema version is checked before any migration/write.

## Lifecycle

A command is accepted in a transaction, then dispatched once. One active turn per session. Queue capacity is checked atomically. A worker emits persisted text/events and terminal state. On restart, outstanding turns become `unknown` and block that session's queue; recovery reports them without sending more input. Explicit cancellation clears that barrier. This trades automatic continuation for no duplicate external side effects until harness-specific reattachment can prove safety.

## Storage boundary

Use Node built-in SQLite inside a worker, not Electron main. Small bounded transactions, parameterized SQL, bounded pages and text limits. A worker crash rejects pending requests. Closing waits for outstanding writes and forbids new ones. Diagnostic output is not written to disk. Lock the native data directory to prevent two coordinators dispatching the same accepted turn.

## Drivers and permissions

Driver configuration is trusted host code, never a command string supplied by a chat tool. Drivers expose a capabilities declaration, open/run/interrupt/close methods and normalized events. Unsupported settings fail before dispatch. Tool approval decisions are tied to session/turn/request; no missing capability defaults to allow. Credentials are supplied through host-owned ephemeral resolvers, not persisted launch payloads.

## 文件结构

- src/native-store-worker.cjs, src/native-store.cjs: durable storage and worker RPC.
- src/native-engine.cjs: admission, dispatch, observation and explicit recovery.
- src/drivers/: harness-specific protocol adapters and deterministic test peers.
- src/compatibility-plugin.cjs: opt-in local test interface.
- tests/native-*.test.cjs: storage, race, restart and contract coverage.

## Transition and rollback

Native IDs and data root remain separate from AO. Production engine selection stays unchanged during initial development. Only synthetic/new opt-in sessions use the native engine. Preserve old conversations and sessions under their owning engine. An eventual AO removal requires offline import, installer compatibility and a rollback rehearsal; none is inferred from mock tests.

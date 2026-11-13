# Native compatibility plugin

Status: **experimental prototype**, not a replacement for Coding Tools' chat engine. No AO code is imported by the native engine or plugin. Existing production chats still need AO.

## Implemented

- Worker-owned SQLite sessions, turns and ordered events with one coordinator per data directory.
- Durable acceptance, bounded queues and per-session deduplication of client message IDs.
- Serialized execution and turn-scoped cancellation. Recovery preserves unknown outcomes rather than replaying inference.
- Direct Codex app-server protocol prototype: read-only sandbox, scoped thread/turn events, fail-closed approval requests, no reconnect after uncertain delivery.
- A local stdio MCP server with `orchestrator_status` and `orchestrator_self_test`.

The self-test uses a deterministic fixture driver, not an AI model. It executes a synthetic turn, submits the same command twice, checks completion events, closes storage, reopens it and verifies the answer and replay cursor survive without repeating execution. It removes its isolated test data afterward.

## Load into Coding Tools

Requires Node **22.13 or newer** with `node:sqlite`. No npm install is required to run the server.

In **Plugins > MCPs**, add a STDIO server:

- Name: `orchestrator-compat`
- Command: the absolute path of the Node executable, not the Electron executable.
- Argument 1: the absolute path of `scripts/mcp-plugin.cjs` in this checkout/extracted release.
- Argument 2: an absolute scratch directory on the project/app data drive, outside the installed app.
- Enabled: on.

Use the app's save action; do not overwrite its private MCP settings file. The app keeps that list in memory, so editing the file alone does not load a plugin into the running app. There are at most seven user-server slots beside Coding Tools' own server. A saved server beyond that limit is not evidence it reached a chat.

New or explicitly resumed sessions receive the configured server. Do not restart or resume an active chat merely to inject test tools. In an isolated test chat, call `orchestrator_status`, then `orchestrator_self_test`. The result must retain `productionReady: false` even when every self-test check passes.

## Reproducible isolated host test

With an existing trusted Coding Tools source checkout and its runtime-web dependencies installed:

```sh
node scripts/check-plugin-coding-tools.cjs /absolute/path/to/coding-tools-mcp
```

This uses the actual host's `createChatMcpServers` to save, reload and inject an entry into a synthetic session configuration. The official MCP client from that checkout then starts the real plugin process, initializes it, lists its tools and calls both tools. All settings and data are in a fresh task-owned directory, removed after closing the process. It does not change installed settings, open the live AO database or make a provider call.

This verifies the host registration/configuration contract and MCP transport. **It is not a live installed-chat test.** The result names that distinction explicitly.

## What still blocks removing AO

MCP servers add tools; they do not replace the app's runtime/harness object. This prototype does not implement the 36-operation Coding Tools runtime contract. Full harness parity, provider and tool-lease integration, interactive approvals, input questions, steering, compaction, history import, engine affinity, process reattachment and packaging/cutover remain incomplete. Read [compatibility.md](compatibility.md) before any engine switch.

Unsupported functionality must remain unavailable. Do not report a synthetic self-test as a successful live model conversation, and never silently fall back to AO while claiming native execution.

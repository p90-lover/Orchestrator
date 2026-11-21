# Crash-safe input tasks

- [ ] 1.1 Implement worker-owned revisioned input store and attachment snapshots with durable receipts.
  - Requirements: FR-10.
  - 证据块: Coding Tools desktop-electron/electron/durable-state.cjs:33 catches primary-write errors; chatQueueCall returns before persistence; chat-drafts.cjs:64 keeps path-backed attachments and evicts old drafts.
  - Files: chat-input-store.cjs, chat-input-worker.cjs, chat-attachment-store.cjs and focused tests.
  - Tests: commit/reopen, stale revisions, failing writes, oversize rejection, no eviction, attachment bytes after source deletion, duplicate/conflicting IDs, idempotent import.
- [ ] 1.2 Wire draft/send/queue/steer revisions and receipts through host and UI.
  - 证据块: Coding Tools desktop-electron/electron/agent-orchestrator-workflow.cjs:8176 uses message text for queue reconciliation; AgentOrchestratorSurface.tsx:2005 wires draft persistence without a committed revision receipt.
  - Requirements: FR-10.
  - Files: workflow, handler, main, backend bundle, AgentOrchestratorChat.tsx, AgentOrchestratorSurface.tsx, ao-chat.ts, Rust chat_input API and data model.
  - Tests: clear only submitted revision, continuous typing maximum wait, queue durability, transport-loss receipt reconciliation, visible Preview recovery interaction. For native steering include loss after the engine has committed, host journal restart, wrong or absent receipt, and zero additional provider dispatches while recovering.

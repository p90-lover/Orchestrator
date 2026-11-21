# Crash-safe chat input

## 范围

FR-10. Coding Tools owns user input independently of AO/native execution. A worker-owned SQLite store holds revisioned drafts, immutable submitted input IDs/digests, attachment references and delivery receipts. Attachment blobs are app-owned, committed before references. No implicit system temp or diagnostic file logging.

## 需求回链

Own FR-10: durable draft revisions, attachment ownership, submitted-input receipts, migration and recovery UI. Host-owned and independent of the selected execution engine.

## Acceptance (EARS)

1. WHEN a draft is acknowledged as saved THEN its exact revision SHALL have committed successfully; write failures SHALL reach the UI.
2. WHEN Send, Queue or Steer is accepted THEN the full input SHALL commit before clearing that revision or dispatch; newer typing SHALL remain.
3. WHEN a window submits an outdated revision THEN it SHALL not overwrite newer content; a recovery conflict SHALL preserve the attempted content.
4. WHEN an attachment is accepted THEN its bytes SHALL be preserved in app-owned storage before a durable reference is returned.
5. WHEN limits or disk errors occur THEN the system SHALL reject visibly without silent truncation or eviction of pending content.
6. WHEN a duplicate input ID has the same payload THEN acceptance SHALL return the same receipt; changed content SHALL fail with a conflict.
7. WHEN an uncertain dispatch is recovered THEN it SHALL remain delivery-unknown unless an exact receiver receipt proves its outcome; text matching SHALL NOT authorize replay.
8. WHEN draft/queue JSON is imported THEN import SHALL be transactional and idempotent and original files SHALL remain untouched during migration.
9. WHEN typing continues THEN writes SHALL be coalesced for 250 ms with a 500 ms maximum wait, and the UI SHALL distinguish saving, saved and not saved.
10. WHEN a draft is restored THEN it SHALL not be automatically sent to a model.
11. WHEN Coding Tools dispatches a saved native steer THEN it SHALL durably bind the chosen workspace, task, run, native session and turn to the saved input before sending guidance. WHEN the host loses the reply THEN receipt recovery SHALL use a read-only lookup of that binding, even after restart or a change of active turn; only a matching accepted native receipt may settle the input.

## 涉及文件

Coding Tools: desktop-electron/electron/chat-input-store.cjs, chat-input-worker.cjs, chat-attachment-store.cjs, chat-drafts.cjs, chat-queue.cjs, chat-attachments.cjs, agent-orchestrator-workflow.cjs, main.cjs, backend-bundle.cjs; app-handler/agent-orchestrator/handler.cjs; desktop-electron/src/features/AgentOrchestratorChat.tsx, AgentOrchestratorSurface.tsx, ao-chat.ts; src-tauri/src/integrations/chat_input.rs and host API/data model wiring.

## 不做项

No live AO DB, settings-file bypass, unsolicited installation/restart, silent engine switch, new hosted service or promise of physical-drive-failure immunity.

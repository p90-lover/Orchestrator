# Native core

## 范围

Native durable state only.

## 需求回链

Own FR-1, FR-2, FR-3: durable sessions, bounded serialized turns, command deduplication, event pages and crash-safe uncertainty. Files: src/native-store-worker.cjs, src/native-store.cjs, src/native-engine.cjs, tests/native-engine.test.cjs.

## Acceptance (EARS)

1. WHEN a new turn is acknowledged THEN the system SHALL have durably stored its session, client ID, content digest and queued state.
2. WHEN the same client ID and content are submitted again THEN the system SHALL return the same turn without a second dispatch; different content SHALL fail.
3. WHEN a session has active work THEN subsequent turns SHALL queue in order within a configured capacity.
4. WHEN the coordinator restarts THEN it SHALL preserve never-claimed turns as queued, mark previously running turns unknown, and refuse dispatch past an unknown turn; explicit recovery MAY schedule the safe session queue only when the caller identifies a queued turn and no unknown turn blocks it. A terminal-turn lookup or a recovery query without an exact turn identity SHALL remain read-only. Historical unknown turns SHALL NOT be reinterpreted as safe to resend.
8. WHEN streaming text is received THEN it SHALL be committed in bounded batches within 100 ms or 16 KiB and flushed before terminal state; write failure SHALL propagate without a success acknowledgement.
5. WHEN a client reads events THEN it SHALL receive an ordered page bounded by count and encoded payload bytes, with a cursor after the last returned row. A later page SHALL return the deferred events intact.
6. WHEN native SQLite cannot extend its database within the page budget, or an actual storage write fails, THEN command acceptance SHALL fail visibly without evicting prior events or receipts, and no driver shall be invoked for that command. Exact receipt reads and duplicate retries SHALL not require additional database pages.
7. WHEN the data directory is already owned THEN a second engine SHALL refuse to start.

## 涉及文件

src/native-store-worker.cjs, src/native-store.cjs, src/native-engine.cjs and tests/native-engine.test.cjs.

## 不做项

No AO imports or DB reads. No paid model, installer change or implicit temp root. Database work runs in a worker. Only command/event state is persisted; no diagnostic log files or secrets.

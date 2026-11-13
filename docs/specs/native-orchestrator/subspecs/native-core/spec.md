# Native core

## 范围

Native durable state only.

## 需求回链

Own FR-1, FR-2, FR-3: durable sessions, bounded serialized turns, command deduplication, event pages and crash-safe uncertainty. Files: src/native-store-worker.cjs, src/native-store.cjs, src/native-engine.cjs, tests/native-engine.test.cjs.

## Acceptance (EARS)

1. WHEN a new turn is acknowledged THEN the system SHALL have durably stored its session, client ID, content digest and queued state.
2. WHEN the same client ID and content are submitted again THEN the system SHALL return the same turn without a second dispatch; different content SHALL fail.
3. WHEN a session has active work THEN subsequent turns SHALL queue in order within a configured capacity.
4. WHEN the coordinator restarts with nonterminal turns THEN it SHALL mark them unknown and block automatic dispatch until explicit cancellation/recovery.
5. WHEN a client reads events THEN it SHALL receive a bounded ordered page and continuation cursor without loading all history.
6. WHEN storage fails THEN command acceptance SHALL fail and no driver shall be invoked for that command.
7. WHEN the data directory is already owned THEN a second engine SHALL refuse to start.

## 涉及文件

src/native-store-worker.cjs, src/native-store.cjs, src/native-engine.cjs and tests/native-engine.test.cjs.

## 不做项

No AO imports or DB reads. No paid model, installer change or implicit temp root. Database work runs in a worker. Only command/event state is persisted; no diagnostic log files or secrets.

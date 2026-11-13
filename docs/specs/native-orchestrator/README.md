# Native Orchestrator

## 原则

Replace AO with an independent Coding Tools-first engine, not a renamed fork. Preserve existing user data until tested migration and rollback exist. Passing a shape check is not engine certification.

## 子规格索引

| ID | Requirements | Dependencies |
| --- | --- | --- |
| native-core | FR-1, FR-2, FR-3 | None |
| harness-drivers | FR-4, FR-5 | native-core |
| coding-tools-integration | FR-6, FR-7 | native-core, harness-drivers |
| migration-cutover | FR-8, FR-9 | coding-tools-integration |

## 依赖关系

The dependency graph is recorded in spec-manifest.json. Native storage precedes drivers; verified integration precedes migration.

## 里程碑

1. Native durable sessions/turns/events and explicit recovery.
2. Harness adapters and scoped permissions/tools.
3. Coding Tools integration and opt-in test plugin.
4. Migration, live parity, packaging and AO removal. Full completion requires FR-9.

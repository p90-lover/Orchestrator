# Native Orchestrator task index

## 交付物清单

Native storage/coordinator, direct drivers, host contract/test plugin, migration and AO removal. Child tasks are authoritative.

## 任务列表

Deliver native-core/1.1, harness-drivers/1.1, coding-tools-integration/1.1, migration-cutover/1.1 in dependency order. Full replacement remains incomplete until the final task passes.

## 需求覆盖矩阵

| FR | Child task | Status |
| --- | --- | --- |
| FR-1 | native-core/1.1 | Pending |
| FR-2 | native-core/1.1 | Pending |
| FR-3 | native-core/1.1 | Pending |
| FR-4 | harness-drivers/1.1 | Pending |
| FR-5 | harness-drivers/1.1 | Pending |
| FR-6 | coding-tools-integration/1.1 | Pending |
| FR-7 | coding-tools-integration/1.1 | Pending |
| FR-8 | migration-cutover/1.1 | Pending |
| FR-9 | migration-cutover/1.1 | Pending |

## 文件变更清单

src/native-store-worker.cjs, src/native-store.cjs, src/native-engine.cjs, src/drivers/, src/compatibility-plugin.cjs, scripts/, tests/native-*.test.cjs and later Coding Tools integration/build files. No installed-app patching or live AO database changes.

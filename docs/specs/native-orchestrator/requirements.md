# Native Orchestrator requirements

## 功能概述

Independent local execution engine; Coding Tools remains the authority for product UI, teams, grants and provider-account selection. No live AO database writes, silent migration, permission escalation or unsupported capability emulation. No new hosted model service is required.

## 需求列表

| ID | Requirement | Owner |
| --- | --- | --- |
| FR-1 | Persist sessions and independently identified turns before acknowledging acceptance. | native-core |
| FR-2 | Deduplicate client command IDs, serialize work per session, and bound in-flight resources. | native-core |
| FR-3 | Provide sequenced events and bounded history; after a crash preserve uncertainty and never replay accepted work automatically. | native-core |
| FR-4 | Run approved harness adapters directly, without AO; advertise and enforce capabilities. | harness-drivers |
| FR-5 | Preserve scoped tools, provider connection, approval reasons, input questions, cancellation and process ownership. | harness-drivers |
| FR-6 | Support Coding Tools' runtime/harness behavior with explicit engine affinity. | coding-tools-integration |
| FR-7 | Expose an opt-in local test plugin through a supported extension path, isolated from production chats. | coding-tools-integration |
| FR-8 | Import history from a supplied offline export with stable identity, audit trail and reversible migration. | migration-cutover |
| FR-9 | Remove AO dependencies only after all parity, migration, security and package gates pass. | migration-cutover |

## 非功能需求

Storage is on an explicitly chosen application/project drive, never implicitly the system temp folder. Persistent state is product data, not diagnostic logging. No telemetry or file logs. Database work runs outside Electron main. Use bounded transactions and queries. Unsupported schema versions fail before writes. Recovery distinguishes queued, running and unknown outcomes. Tests must use isolated synthetic data and no paid model calls.

## 依赖关系

Subspec dependencies are recorded in spec-manifest.json.

## Acceptance

Each child specification defines executable EARS cases. The existing compatibility matrix in docs/compatibility.md remains required for cutover. Native core success alone is insufficient.

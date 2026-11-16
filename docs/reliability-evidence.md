# Reliability evidence register

Status: implementation in progress. This register describes observed incidents and prevention requirements, not a certification of the native engine. Diagnostic output remains bounded in memory. Do not publish private prompts, account identifiers, credentials, machine paths or database contents.

## Provenance and working baseline

- Coding Tools baseline: `eee717079d029093c5c5c446767b7d3a09e5a3ca`, published `v0.8.119`. Draft persistence PR [1300](https://github.com/p90-lover/coding-tools-mcp/pull/1300), head `238439c55d522e108749b17509f8ac8ed30b05bd`, is an ancestor. Required PR checks were successful; publication/source ancestry was independently checked. Those checks do not certify the stronger durable-input contract.
- Handler PR [1290](https://github.com/p90-lover/coding-tools-mcp/pull/1290) merged as `3d33ec2652fba2f0ba11597e6977a478a3c90d33` and shipped in `v0.8.117`. Boundary compatibility is not native execution compatibility.
- Native baseline: `43895f5e0a9ae263bffe51ee4b34abdf82c62af2`, `v0.2.0-alpha.1`. Runtime implementation `ff34808`, portable runner `e79827f`. Existing 27-test and isolated host-MCP receipts are in [release notes](releases/v0.2.0-alpha.1.md). Further runtime edits invalidate affected receipts.
- Reused task branches: Coding Tools `refactor/orchestrator-handler`; Orchestrator `work/handler-contract`. Task-local folders in the Coding Tools workspace are `aiTemp/orchestrator-handler/app` and `aiTemp/orchestrator-handler/Orchestrator`; the private handoff is the parent `CHECKPOINT.md`. No new checkout or production data copy is needed.
- Historical AO fork lives at Coding Tools `module/agent-orchestrator`, declared in `.gitmodules`. Do not infer that a branch or folder caused a runtime bug merely because it contains a candidate fix.

## Evidence classification

`observed` means a recorded measurement or source behavior; `hypothesis` is not a proven cause. Historical fix status belongs to the stated observation date unless a current PR/release receipt is listed. Test names below are required regression cases; they remain **planned** until an actual command/revision/result is recorded in the compatibility matrix.

| ID | Observed failure and provenance | Prevention rule | Required regression |
| --- | --- | --- | --- |
| writer-starvation | 2026-11-11: `ao.writer_held` reported 163–309 s and 8–14 waiting writes during `PruneChangeLogToMaxRows`. Source: Coding Tools `docs/fixes/ao-writer-yield-and-start-route-2026-11-11.md`, commit `ca8ff2cbe`; AO #28, `30f30365d`. The document records post-fix holds of 3–15 s, not zero contention. | Bounded maintenance batches must yield to foreground commands; measure wait/hold separately. No unbounded transaction around retention. | `maintenance_yields_to_foreground_acceptance` |
| startup-restart-loop | 2026-11-11 stability record: live startup killed at 90/180/360 s, five starts over 28 minutes. Commit `0dbbb82e7`; Coding Tools #1212. | Readiness phases and liveness/progress are distinct. No automatic kill merely for a slow startup; bounded exponential restart backoff. | `progressing_startup_is_not_restarted` |
| startup-checkpoint | Stability record reports a 483 MB WAL and first startup write taking minutes. Proposed AO #29 moves checkpoint work out of the foreground writer. | Disable foreground auto-checkpointing; schedule bounded passive checkpoints off the startup path; expose storage readiness honestly. | `oversized_wal_does_not_block_listener_start` |
| main-thread-io | 2026-11-11: main stall about 47 s in synchronous proxy-settings read, with 34 IPC timeout errors. Same measured-fix document and `ca8ff2cbe`. | Reuse asynchronously refreshed host configuration; never put filesystem flush/large parse on Electron main. | `chat_acceptance_does_not_block_main_loop` |
| projection-detach | Stability record item 7: three store errors 20 ms apart can detach a live chat after one long busy timeout. Proposed AO #30. | Separate transient projection/storage failure from agent death, apply bounded backoff/backpressure and report degraded state. | `busy_storage_does_not_claim_agent_exit` |
| unbounded-history-work | Stability record items 16–17 and 26: transcript import/backfill and repeated large conversation reads compete for the writer/disk. These entries are design obligations, not a fresh live measurement in this task. | Indexed, conversation-scoped cursor queries; bounded replay batches; retained watermarks; parse off main. | `history_replay_is_bounded_and_partitioned` |
| input-ack-before-write | Baseline host `durable-state.cjs` catches primary-write failures and `saved()` does not reject them; `chatQueueCall` returns before durable persistence. Draft PR1300 retains paths for files and evicts old drafts above its limit. Confirmed by source inspection, not a new destructive crash experiment. | Commit full input before acknowledging or clearing; preserve blobs; expose errors; no silent eviction/truncation; revision-specific receipts. | `input_ack_requires_committed_revision`; `attachment_survives_source_removal` |
| uncertain-delivery | Host queue restart reconciliation compares message text. Native baseline marks both queued and running work unknown and commits each text delta separately. Confirmed by source inspection. | Stable input/command IDs and digests; distinguish never-dispatched queue from uncertain dispatch; batch text; do not replay uncertain inference. | `queued_restart_preserves_safe_work`; `lost_reply_reuses_exact_receipt`; `terminal_waits_for_text_commit` |

## Unproven proposals must not become requirements by accident

Coding Tools `docs/fixes/ao-stability-plan-2026-11-11.md` commit `8381ac730` explicitly dropped two proposals: an expired recovery-context explanation whose regression also passed on main, and increasing persistent-host handshake timeouts without a measured late hello. Keep both as hypotheses, not confirmed root causes. Native process identity still requires a launch-instance identity and process creation time/owned handle; a bare PID is insufficient regardless of those hypotheses.

Coding Tools [PR1214](https://github.com/p90-lover/coding-tools-mcp/pull/1214), branch `fix/ao-start-wait-live`, head `ee01d6075a5481f6f9ae572066c87b21eda9cf9f`, was independently checked **OPEN** during this continuation. Do not describe every historical stability proposal as merged or released.

## Compatibility and evidence limits

- The companion MCP plugin uses a deterministic fixture, not a real model. Its success cannot certify native chat routing.
- The previous supported computer-control path excluded the host app's own window. No installed-chat registration receipt exists. Do not replace that missing gate with private API/settings edits.
- No live `ao.db` was read or copied. Historical raw diagnostic output is not available in this register and must not be fabricated.
- Current native graph has callback/value-reference lower-bound limitations. Host scoped index misses workflow/draft/queue symbols. An empty graph result is not permission to change a shared contract without confirming references.
- Source fixes, published releases and verified installed behavior are separate statuses. Each new receipt must name exact source, command, result and environment assumptions.

## Acceptance

[compatibility-matrix.json](compatibility-matrix.json) is the completion checklist. All required areas need actual passing evidence, including live chat, migration, rollback and packaging. A single repaired incident, a handler shape check or a source prerelease cannot mark the replacement complete.

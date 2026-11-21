# Driver tasks

- [ ] 1.1 Implement and verify direct harness adapters with capability negotiation, cancellation, approvals and process ownership.
  - 证据块: docs/design.md:56-64; Coding Tools agent-orchestrator-upstream.cjs launch and approval contracts.
  - Files: src/drivers/, tests/drivers/.
  - Native steering slice: worker-owned bounded receipts, exact native and provider turn identity, and explicit unsupported/unknown outcomes. Verify successful and lost acknowledgements, stale input rejection, no resend after restart, and no text-based deduplication of durable inputs.
  - Requirements: FR-4, FR-5.
  - Acceptance: deterministic protocol peers and then authorized live checks for each supported harness; missing capability fails closed.

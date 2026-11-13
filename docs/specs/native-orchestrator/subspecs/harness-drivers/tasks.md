# Driver tasks

- [ ] 1.1 Implement and verify direct harness adapters with capability negotiation, cancellation, approvals and process ownership.
  - 证据块: docs/design.md:56-64; Coding Tools agent-orchestrator-upstream.cjs launch and approval contracts.
  - Files: src/drivers/, tests/drivers/.
  - Requirements: FR-4, FR-5.
  - Acceptance: deterministic protocol peers and then authorized live checks for each supported harness; missing capability fails closed.

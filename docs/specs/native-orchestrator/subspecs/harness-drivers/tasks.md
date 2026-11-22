# Driver tasks

- [ ] 1.1 Implement and verify direct harness adapters with capability negotiation, cancellation, approvals and process ownership.
  - 证据块: docs/design.md:56-64; Coding Tools agent-orchestrator-upstream.cjs launch and approval contracts.
  - Files: src/drivers/, tests/drivers/.
  - Native steering slice: worker-owned bounded receipts, exact native and provider turn identity, and explicit unsupported/unknown outcomes. Verify successful and lost acknowledgements, stale input rejection, no resend after restart, and no text-based deduplication of durable inputs.
  - Codex stop verification: `turn/interrupt` must target the active provider thread and turn. Only its matching `interrupted` terminal event confirms the stop; a bare RPC acknowledgement, a different turn's event, or closing the transport does not. A naturally completed turn remains completed. After an unconfirmed disconnect, retain the queued successor without starting it.
  - Embedded Pi slice: explicit trusted SDK/model, in-memory settings/resources/session, no discovered tools or extensions, no automatic retry/cache warming. Check actual installed SDK over isolated loopback model protocol with an explicit truth label for fixture output.
  - Verify the existing Coding Tools approval action through a single inert Pi fixture tool, with manual confirmation, no built-in tools, exact turn ownership and fail-closed expiry. Do not enable it for production chats.
  - Requirements: FR-4, FR-5.
  - Acceptance: deterministic protocol peers and then authorized live checks for each supported harness; missing capability fails closed.

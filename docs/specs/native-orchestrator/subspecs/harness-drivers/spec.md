# Harness drivers

## 范围

Direct driver adapters only.

## 需求回链

FR-4 and FR-5. Direct documented harness protocols, explicit capabilities, scoped tools and provider settings, owned processes. Files: src/drivers/, tests/drivers/. Depends on native-core.

## Acceptance (EARS)

1. WHEN a harness is opened THEN the adapter SHALL use an explicit absolute executable, argv array and scoped environment, not shell interpolation.
2. WHEN a requested capability is unsupported THEN launch SHALL fail before external work.
3. WHEN a tool approval arrives THEN its decision SHALL be scoped to session, turn and request, including denial rationale.
4. WHEN a process exits or loses its protocol stream THEN active work SHALL settle as failed/unknown, not completed or silently retried.
5. WHEN a session is stopped THEN only its owned child process tree SHALL be terminated.
6. WHEN a supported driver steers a running native turn THEN it SHALL use the exact session, active provider turn and stable input identity, without starting a follow-up turn. An idempotent duplicate returns a known receipt without contacting the driver; a lost or mismatched acknowledgement SHALL remain unknown and SHALL NOT be retried or converted into a follow-up automatically.

## 涉及文件

src/drivers/ and tests/drivers/.

## 不做项

No model account selection, hosted-agent orchestration, global credentials, AO import or implicit authorization. Protocol fixture coverage is not a live harness certification.

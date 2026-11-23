# Coding Tools integration

## 范围

Native engine integration and opt-in tests.

## 需求回链

FR-6 and FR-7. Preserve the app contract without preserving unrelated AO product UI. Native engine selected explicitly for new test sessions only. Test plugin uses supported Plugins > MCPs; the App plugins list is not an arbitrary JavaScript loader.

## Acceptance (EARS)

1. WHEN the native engine is selected THEN the existing chat, team and subagent paths SHALL receive contract-compatible observations and errors.
2. WHEN compatibility is incomplete THEN the host SHALL keep the current production engine and report missing features honestly.
3. WHEN the user enables the test plugin THEN it SHALL use isolated synthetic data and never mutate production chats or claim live parity from shape checks.
4. WHEN an existing session is resumed THEN its recorded engine affinity SHALL be preserved.
5. WHEN a native experimental session is created THEN the host adapter SHALL validate its capability tuple and canonical workspace before persisting or launching, and SHALL return an explicitly native session identity.
6. WHEN the host calls recovery to inspect an existing turn THEN the adapter SHALL perform read-only observation and SHALL NOT drain a queued turn or start inference.
7. WHEN unsupported approval, steering, compaction, terminal, provider or tool settings are requested THEN the experimental adapter SHALL fail explicitly before external execution, not silently downgrade settings.
8. WHEN native and legacy runtimes are registered together THEN commands targeting an existing session SHALL route only to its persisted engine; an unknown engine or missing native provider SHALL fail without legacy fallback.
9. WHEN the operator selects HTTP for the compatibility plugin THEN the test transport SHALL listen only on the exact IPv4 loopback authority, require an explicit bearer token, reject browser origins and unauthorized requests, and run only the existing isolated fixture tools. It SHALL NOT replace or restart the installed engine.
10. WHEN a native follow-up is sent to an existing session THEN the host SHALL commit the workspace/run/card/reservation/session binding first. After host restart, an exact engine receipt may attach that reserved card and persist its turn ID; missing or mismatched receipts SHALL keep it reserved without dispatch. A subsequent result from a different turn SHALL NOT settle that card.
11. WHEN the first native launch reply or its host submission is lost THEN only a read-only lookup by the saved workspace, harness and launch reservation SHALL attach the exact first turn. Missing or mismatched receipts SHALL keep the card reserved. The lookup SHALL NOT start either engine, send a prompt, inspect the latest turn, or fall back to AO.
12. WHEN a user selects Runtime > Chats THEN the app SHALL open a separate text-chat surface using the host-owned `runtime.chats` route and native Orchestrator, not the AO Chat module. The current Chat, AO state and legacy session affinity SHALL remain unchanged.
13. WHEN the approved isolated development binding is absent or unsupported THEN Chats SHALL identify itself as unavailable and SHALL NOT fall back to AO or another model. The renderer SHALL NOT supply provider credentials, endpoint URLs, engine paths, workspace paths or permission modes. Production activation and packaging are separate gates.
14. WHEN a text input is sent THEN Chats SHALL retain the editor text until the native transaction commits and SHALL recover a lost receipt by its original stable input ID only. Transcript reads SHALL be bounded, scoped to the bound workspace and native session, and SHALL NOT dispatch, schedule persisted work, or inspect AO. While text-only, Chats SHALL NOT offer unsupported tools, steering, or Team controls.

## 不做项

No installed-resource patching or permission bypass.

## 涉及文件

Files: src/compatibility-plugin.cjs, scripts/, Coding Tools host adapter and relevant tests. No direct modifications to installed app resources or permission-policy bypass. Live UI checks require the connected visible Preview or app tools.

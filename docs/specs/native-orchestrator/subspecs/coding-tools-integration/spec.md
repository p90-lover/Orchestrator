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

## 不做项

No installed-resource patching or permission bypass.

## 涉及文件

Files: src/compatibility-plugin.cjs, scripts/, Coding Tools host adapter and relevant tests. No direct modifications to installed app resources or permission-policy bypass. Live UI checks require the connected visible Preview or app tools.

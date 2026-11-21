# Native Orchestrator cutover and rollback

**Hold.** Source integration and fixture recovery can continue in the existing draft branches. Do not promote the draft, merge, publish, remove AO, or install/restart a running app from this plan. The missing release inputs are an approved no-cost, log-compatible model endpoint and exact model ID, and an authorized finished AO export or isolated capture. Do not take those from the running app or ask for keys in chat.

## Release sequence

1. Pin the exact host and engine candidate trees. Finish the [compatibility matrix](docs/compatibility-matrix.json) and [release gates](docs/gates/GATES.md) on the integrated candidate. Include an actual native chat, verification of existing session affinity, and isolated package upgrade/rollback before approving AO removal. Get the release schedule and production cutover approved separately.
2. Use one independent Orchestrator batch PR against `main`. Merge only after its required Windows/Linux CI and security checks. Package the approved source, record the exact merge SHA in the provenance manifest, verify payload hashes from the draft release, and publish the verified tag. No export, runtime profile, logs, credentials, or test attachments belong in the package.
3. Pin that release in the existing Coding Tools integration and coordinate one app release PR, version bump and notes with its owner. Rerun invalidated compatibility and required CI/package checks on the final AO-free tree. Verify the merged source, signed assets where applicable and actual downloaded file hashes. Do not start a competing package dispatch or substitute a local installer build. A green draft PR, fixture run, or downloaded package is not a verified installed update.

## Offline archive rollback rehearsal

Use the exact candidate's standalone CLI and only an **operator-approved, finished export**. In a private local shell from the candidate root, pass an absolute `AO_REHEARSAL_EXPORT` pointing to the supplied JSON and an absolute `AO_REHEARSAL_ARCHIVE` pointing to a new, dedicated directory on the chosen test drive. They must not point at live storage. The following PowerShell procedure keeps archive contents and paths out of receipts; it does not touch any existing app, run inference or copy `ao.db`.

```powershell
$source = $env:AO_REHEARSAL_EXPORT
$archive = $env:AO_REHEARSAL_ARCHIVE
if (-not $source -or -not $archive -or $source -notmatch '^\w:[\\/]' -or $archive -notmatch '^\w:[\\/]' -or
    [IO.Path]::GetExtension($source) -ne '.json' -or -not (Test-Path -LiteralPath $source -PathType Leaf) -or
    (Test-Path -LiteralPath $archive)) { throw 'Choose an approved absolute JSON export and an unused absolute archive directory.' }
$before = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
$added = node scripts/import-history.cjs import-ao --data-root "$archive" --export "$source" | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $added.state -ne 'active' -or $added.duplicate) { throw 'Fresh isolated history import did not complete.' }
$visible = node scripts/import-history.cjs read --data-root "$archive" --export-id $added.exportId --limit 1 | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $visible.items.Count) { throw 'The imported history is not visible.' }
$reversed = node scripts/import-history.cjs rollback --data-root "$archive" --export-id $added.exportId | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $reversed.state -ne 'inactive' -or -not $reversed.retained -or $reversed.digest -ne $added.digest) {
  throw 'Archive visibility reversal was not confirmed.'
}
$hidden = node scripts/import-history.cjs read --data-root "$archive" --export-id $added.exportId --limit 1 2>&1
if ($LASTEXITCODE -eq 0 -or ($hidden -join "`n") -notmatch 'HISTORY_NOT_FOUND') { throw 'Default reads did not hide the inactive archive.' }
$retained = node scripts/import-history.cjs read --data-root "$archive" --export-id $added.exportId --include-inactive true --limit 1 | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $retained.items.Count) { throw 'The inactive data was not retained.' }
if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ne $before) { throw 'The supplied export changed.' }
[pscustomobject]@{ ArchiveDigest = $reversed.digest; State = $reversed.state; SourceUnchanged = $true }
```

This is a visibility rollback, not a packaged downgrade. Also compare real source IDs, ordered events, tool/approval records and hash-verified attachments privately; reject unsupported or incomplete history. Existing synthetic CLI evidence does not certify an operator export.

## Packaged rollback rehearsal and removals

- Verify both previous AO-capable and candidate package provenance. Use a **separate isolated profile** with approved copied rehearsal data, not the live application. Freeze any writes during the exercise. Retain the operator export and both immutable package references. Verify the new runtime can read the intended history and keeps unknown delivery from running again.
- Exercise the supported package reinstall/rollback back to the verified AO-capable baseline, with native routing disabled in that isolated profile. Confirm the loaded version/runtime, original AO-owned histories and attachments, accounts/settings retained, no duplicated turns and native-only state retained safely or refused by a compatible schema check. Do not overwrite a newer schema with an old runtime. If reversal fails, keep both source data and archives; do not release or remove AO.
- After both parity and rollback pass, remove AO daemon/renderer dependencies and bundled artifacts, build inputs/job steps and old storage initialization from the candidate. Update runtime/module manifests, tests, docs and version pin. Confirm it neither requires nor silently starts AO while preserving supported archive access. Re-run the release gates on that exact AO-free candidate before updating any user installation.

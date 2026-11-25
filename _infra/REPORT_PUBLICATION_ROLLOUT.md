# Publication V2: rollout and recovery

This implements the S3-only [design](REPORT_PUBLICATION_DESIGN.md). It is opt-in;
repository tests do not establish that the running service is configured or
deployed. No database is required.

## Components

- `lambda-token-admin/publication.js`: conditional lifecycle changes, seven-day
  retention, revision selection, owner dashboard, and cleanup decisions.
- `publication-s3.js`: S3 ETag compare-and-swap writes, version-pinned copies,
  streaming SHA-256 source/destination verification, and version-aware cleanup.
- `reconcile.js`: scheduled cleanup with a persistent, replayable scan checkpoint.
- `lambda-auth/index.js`: viewer-request gate before cache lookup and all public
  or authenticated bypasses; direct control/physical keys are denied.
- `publication-stack.json`: private versioned staging, lifecycle backstop,
  additive API/edge IAM policies, scheduled worker, logs, and cleanup alarms.
- Hub **Incomplete uploads**: owner-only listing, pagination, on-demand file
  observations, deadlines, failure details, and refresh.

Manifests and pinned/verified file evidence are initially inline in the per-report
control document. This is simpler for the existing 100-file API limit than adding
a second manifest store. The manifest is immutable through the API; only
descriptive metadata can be edited. Monitor control-document growth/read latency.
Extracting immutable manifests or adding a database remains a future optimization,
not a second source of lifecycle authority.

## Configuration and client behavior

The API retains existing behavior when `REPORT_STAGING_BUCKET` is absent. Once
configured, V2 reads, mutations, dashboard, and completion are active. Set
`REPORT_UPLOAD_MODE=paused` to stop new plans, or `v2` to enable staging plans.
With staging configured, unset/other modes fail closed rather than issuing old
direct-to-final plans. The deployment script refuses to silently remove lifecycle
configuration.

On code redeploys, omitting `REPORT_UPLOAD_MODE` preserves the deployed value;
new functions or configurations with no prior value default to `paused`. An
explicit value overrides that default. Mode lookup failures stop deployment.

CLI/MCP request and success formats remain compatible. PUT URLs last up to 15 minutes;
new submissions have a six-hour edit/completion deadline and seven-day retention.
Completion can succeed after PUT authorization expires if every file already exists.
Missing or mismatched files fail publication but can be repaired within six hours.
An authenticated owner can POST a validated submission with `resumeId` to `/reports`
to update its details and file manifest and obtain fresh links for the same ID.
Recovery rejects active publication, committed reports, stale replacements, and
expired deadlines. Pre-feature uploads retain their original completion deadline.
Deploy the API before the updated hub and CLI. SHA-256 verifies the
pinned source against its destination, not a client's original local bytes when
no client checksum was supplied. Nested paths remain intact.

Duplicate active completion returns a retryable conflict; committed completion
returns the same result. Failed uploads remain private until the seven-day
retention deadline. Successful publication allows prompt staging cleanup.
Selected finalized report copies have **no automatic expiry**.

Dashboard GETs remain read-only and never preview staging. **Edit and continue**
opens the existing upload form for single HTML files; bundle recovery uses CLI
`--resume`. Both require all files to be reselected and re-uploaded, and neither
extends the original six-hour deadline.
Summary pages avoid HEAD requests for every file. **Inspect file progress** checks
one upload; failed S3 observations display Unknown. Empty pages may still have a
continuation cursor. Cursors are signed and bound to the GitHub owner.

The API role can list only staging's `uploads/*` namespace. A missing staging
object may still return 403 to HEAD under prefix-scoped permissions. In that
case the adapter lists the exact key prefix and reports missing only after a
successful, complete listing proves the exact key absent. Prefix-sharing siblings
do not count as the requested file. A listed but unreadable object, failed
listing, or incomplete pagination remains a storage error/Unknown observation;
arbitrary permission denials are never interpreted as missing files. Deploy the
updated scoped IAM policy before deploying this adapter.

## Deployment sequence — separate authorization required

For routine releases, use the [full-stack workflow](FULL_STACK_DEPLOYMENT.md)
after its one-time OIDC permissions and Secrets Manager setup. The sequence below
also describes the ordering required for an authorized manual rollout.

1. Inventory actual report-bucket policies, versioning, Object Lock, replication,
   origins/cache behaviors, quotas, and API/edge roles. Staging must be in the
   report bucket's region and must not be an origin. Resolve retention settings
   that prevent timely cleanup before enabling issuance.
2. Package all `lambda-token-admin/*.js` and production dependencies in the Lambda
   ZIP, not just `index.js`. The updated deployment script does this. The worker
   uses that artifact with handler `reconcile.handler`. Supply its artifact
   bucket/key explicitly; no credentials belong in the artifact.
3. Deploy the stack with existing report bucket/role names. It adds scoped
   policies rather than replacing existing ones. The schedule and alarm actions
   start disabled (`CleanupEnabled=false`, `CleanupNotificationsEnabled=false`).
   Supply `AlarmTopicArn` for the team's notification channel. The template owns
   that destination; leaving the parameter empty configures no notification delivery.
4. Deploy the new authorizer to **every** relevant cache behavior and wait for
   distribution deployment. Its role needs the control-read policy. Verify raw
   and encoded control/physical paths are denied even for signed-in owners;
   verify V2 public/private cache hits and misses and alternate hostnames. This
   must precede any V2 plan.
5. Pause old issuance, wait out old presigned URLs, and review outstanding legacy
   plans separately. Deploy the API with staging configured and mode `paused`.
   Old completion IDs without V2 locators now return a retired-plan error; do not
   silently convert incomplete legacy uploads. Existing committed reports remain
   readable.
6. Enable `CleanupEnabled=true` while keeping `CleanupNotificationsEnabled=false`.
   Confirm the worker heartbeat/full scan and healthy alarm states, then set
   `CleanupNotificationsEnabled=true`. After this and any later alarm configuration
   update, verify the destination on every cleanup alarm before relying on alerts.
   Updating an alarm can clear a destination attached outside the template; recover
   by setting `AlarmTopicArn` rather than relying on an out-of-band attachment.
   Deploy the generated hub. Validate in isolated AWS resources with explicit
   approval for test uploads and deletions.
7. Set API mode `v2` only after validation passes. Never enable issuance without
   both the gate and working cleanup.

The API Lambda uses 512 MiB / a 120-second timeout when V2 is configured. API
Gateway/CloudFront can time out sooner; this does not cancel Lambda execution.
Retry completion to discover an existing commit rather than immediately creating
another upload. Measure representative bundles in isolated AWS resources: if
the synchronous path cannot fit the user-visible request budget, pause issuance
and implement a separately reviewed asynchronous contract. Do not silently lower
size limits to make it fit; size-policy work is #20.

## Legacy migration and deletion

Legacy reports are adopted on their first mutation/replacement: establish control
state and a locator before issuing V2 URLs. All API writers must use the new
version during transition. Retain old metadata as migration evidence but suppress
its listing once the revision is registered. Control state then owns edits,
archive, revision selection, and deletion. Do not run old writers against adopted
reports.

Legacy paths retain existing access behavior. V2 deletion closes the gate,
retains owner-visible retry evidence, and verifies files are gone before marking
deletion complete. Historical legacy objects are removed only by an authorized
owner deletion, not the scheduled worker; worker IAM cannot delete legacy
public/private prefixes.

## Cleanup and observability

Every five minutes the worker scans up to 20 pages of 10 report documents, stopping
between pages when runtime is low. It persists the next page only after processing
the current one; crashes replay safely. Reserved concurrency is one, with additional
conditional per-report leases. Full passes revisit tombstones to catch late PUTs
and stale-worker copies without client cleanup or an operator.

The worker initializes its checkpoint with a create-only conditional write before
reading it, preserving an existing checkpoint on conflict. This avoids relying on
missing-object GETs returning 404 under scoped listing permissions. Other errors,
including permission denials, remain failures.

Scans avoid control writes when no abort or cleanup is due and skip adopted
legacy revisions with no managed upload data. Managed tombstones remain eligible
for periodic sweeps: URL expiry plus an application lease is not proof that all
in-flight storage writes have finished. Report listing reads at most ten control
documents concurrently per page; it still scans the full collection.

Cleanup deletes all versions/delete markers in exact managed prefixes, checks
per-key errors, and verifies emptiness. Failures retain evidence and retry with
jittered backoff capped at approximately 15 minutes. Control documents/locators
have no lifecycle expiry. Never discard them to clear a backlog.

Target: verify due cleanup within 30 minutes of the seven-day deadline with healthy
AWS dependencies and sufficient scan capacity. Late writes create new work; full
scans must complete within a day. These are targets to validate, not unconditional
deadlines. Seven-day staging lifecycle is an asynchronous backstop and has separate
current/noncurrent-version clocks.

Logs include publication failures, pending counts/age, cleanup backlog/oldest due
age, safe cleanup failures, and scan heartbeats. Alarms cover cleanup errors,
missing heartbeats, full scans older than a day, and cleanup over 30 minutes
overdue. Logs omit tokens, signed URLs, raw storage errors, and staged contents.
Monitor gate latency/fail-closed responses with Lambda@Edge and CloudFront metrics
during isolated validation and rollout.

All cleanup alarm actions require both `CleanupEnabled=true` and
`CleanupNotificationsEnabled=true`. Alarms still evaluate while actions are
disabled: an ALARM state before first metrics is expected and does not send a
notification. Heartbeat/scan-age alarms continue to treat missing data as
breaching once enabled, so a failed worker is not silently ignored. Before an
intentional cleanup shutdown, reset notification readiness to false; after a
restart, verify fresh heartbeat/full-scan evidence before re-enabling it. Pausing
upload issuance alone does not stop cleanup or its notifications.

## Recovery and rollback

- Pause issuance; keep staging configuration, gate, V2 reads, and worker active.
  Never revert to an authorizer that permits direct V2 storage keys.
- Resolve lost completion responses by reading/retrying the stable upload result;
  inspect the dashboard before creating a duplicate upload after a timeout.
- Repair underlying cleanup permissions/service failures and allow automatic
  retries. Do not manually set COMMITTED or empty flags.
- Control-read failures fail closed. Backup restoration requires reviewed
  reconciliation of generations, committed references, and object versions.
- Historical orphan cleanup requires a separate read-only inventory, correlation
  against metadata/manifests/revisions, owner review, an exact candidate list,
  recovery plan, and explicit approval. Missing listings alone are insufficient.

## Verification boundary

Run `node --test tests/*.test.js`, `cfn-lint _infra/publication-stack.json`,
`bash -n _infra/deploy-token-admin.sh`, and Python syntax checks for the generator.
Mocked tests cover races, partial uploads/copies, lost responses, late writes,
version cleanup, per-key errors, retries, gate access, dashboard authorization,
and existing browser/CLI behavior.

Real IAM isolation, S3 conditional/version semantics, edge caching/propagation,
cleanup throughput, and completion/gate latency still require separately approved
tests in isolated AWS resources. Local success does not claim a production rollout.

## Production status — 2026-11-23

Publication V2 was deployed and enabled from merged main `3b337b9` (PR #25)
after isolated AWS validation and explicit production authorization. The API runs
with `REPORT_UPLOAD_MODE=v2`; edge version 16 gates all three viewer-request
behaviors. The cleanup schedule is enabled, and all four production alarms were
healthy with notification actions and the confirmed SNS destination verified.
The rendered deployment template includes `AlarmActions` so readiness updates
preserve that destination. Full-stack deployment automation remains tracked in #24.

Production smoke checks passed public/private publication, missing-file inspection,
cached-response access control, deletion gate closure, and physical synthetic-data
cleanup. CloudFront returned `RefreshHit` for `no-cache` revalidation; these were
not unqualified cache-hit observations. All synthetic report objects were removed.
The 29 existing metadata records and eight legacy pending records were unchanged.
Seven-day elapsed lifecycle behavior and sustained-load/scan-capacity limits remain
outside the bounded tests. SNS configuration and subscription were verified, not
independent receipt of an alert email. Use the recovery procedure above if issuance
must be paused; retain the V2 gate, reads, and cleanup.

# Full-stack releases

The `Deploy PSAP Reports Full Stack` workflow releases merged `main` through the
existing `github-pages` GitHub environment and AWS OIDC role. No report content
or authentication package is published as a GitHub artifact. Deployment targets
are explicit, non-secret identifiers in `deployment-targets.json`.

## One-time setup — separate AWS authorization

The production V2 rollout is already complete. This automation updates existing
APIs, distributions, roles, and publication stacks; it does not create a new hub.
Before merging/enabling the workflow, an administrator must provision the two
deployment secrets and attach reviewed backend permissions to the OIDC role.
At implementation time the role had frontend-only permissions and these secrets
did not exist. A successful local test is not proof that setup is complete.

### Authentication secrets

Create these Secrets Manager JSON secrets in `us-east-1`:

- `psap-reports/deployment-auth`: the currently deployed production values.
- `psap-reports/validation-auth`: the isolated environment's own values, never
  production credentials. Its GitHub client ID/secret are the existing inert
  `isolated-validation-no-oauth` strings; Google values are empty strings.

Each JSON object contains `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`,
`COOKIE_SECRET`, `GOOGLE_CLIENT_ID`, and `GOOGLE_CLIENT_SECRET`. Preserve all five
values from the corresponding deployed edge configuration. The cookie secret
must also match that environment's API. Use Secrets Manager's default encryption
key; a customer-managed KMS key requires separately reviewed `kms:Decrypt` access.

An authorized administrator should transfer the values directly into Secrets
Manager using an owner-only temporary JSON file, never terminal output, command
line values, GitHub variables, or a repository file. For example, with a securely
prepared file (replace the local path and select the appropriate secret name):

```bash
aws secretsmanager create-secret --region us-east-1 \
  --name psap-reports/deployment-auth \
  --secret-string file:///secure/local/production-auth.json \
  --query ARN --output text
```

Remove that temporary credential file after provisioning. Do not copy a whole
rollout workspace: it also contains secret-bearing packages and rollback files.
The release preflight compares secret values with the deployed edge and API and
refuses accidental rotation. Changing OAuth credentials or the cookie secret is
a separate operation, not part of a routine release.

### Backend permissions

With read-only access to the existing stacks, generate proposed policies:

```bash
python3 _infra/release-policy.py --output-dir /secure/local/release-policies
```

This inventories the production and isolated stacks and **does not apply IAM
changes**. Review each generated document, create customer-managed policies from
them, and attach those policies to `github-actions-psap-reports-deploy`. Keep its
existing frontend policies. Documents are split below the managed-policy size
limit; do not combine them into an oversized inline policy.

Permissions target existing API/edge/worker functions, stack resources, API IDs,
distributions, artifact prefixes, and the two named secrets. The runner can update
inline policies only on the existing API/edge/worker roles; it cannot create IAM
users, credentials, arbitrary roles, or delete production reports. Synthetic
control-record writes and version listings are restricted to the isolated bucket.
Stack resource replacement may require a new inventory and separately reviewed
permissions. The existing Lambda@Edge service-linked roles must already exist.

CloudFormation also needs `iam:ListRoleTags`, `iam:TagRole`, and `iam:UntagRole`
on its worker role. The generator scopes these actions to that role, not the
externally managed API/edge roles. Releases explicitly preserve current stack
tags: omitting `--tags` from `aws cloudformation deploy` can request their removal.
Installations bootstrapped from PR #27 need this worker-tagging permission addition
reviewed and applied before retrying. If an earlier attempt reached
`UPDATE_ROLLBACK_FAILED`, an authorized operator must finish rollback first;
do not skip resources just to bypass a missing permission.

Preserve the role's repository/environment-specific OIDC trust. Protect the
`github-pages` environment and `main` so unreviewed branches cannot use these
permissions. Dispatches from other branches are blocked in the workflow.

## Release sequence

1. Run JavaScript/Python regression tests and CloudFormation lint.
2. Deploy the same commit to the isolated validation environment. Retrieve its
   own secret, install locked Node 22 dependencies, and upload the versioned,
   non-secret API/worker ZIP to the private artifact bucket.
3. Update infrastructure/IAM and publish a new edge version. Associate every
   existing viewer-request behavior, preserving body inclusion and origin
   settings. Wait for CloudFront propagation before deploying the API.
4. Update API code/configuration and routes, including `/uploads`. Check the
   worker invocation, recent full-scan checkpoint, API readiness, and physical-path
   gate. Enable scheduling, verify healthy alarms/destinations, and explicitly
   enable V2 for isolated tests. Validation alarm actions stay disabled.
5. Test missing-file isolation, real S3 versions and conditional replacement,
   SHA-256 evidence, reused/late PUTs, public/private cache misses and cached
   responses, deletion gate closure, and cleanup. Measure 1/10/99 MiB completion
   against a 28-second request budget and viewer requests against five seconds.
   `RefreshHit` is accepted as a revalidated cached response for `no-cache` reports.
   These samples are not sustained-throughput or seven-day elapsed-retention proof.
6. Delete only this run's synthetic IDs and verify their prefixes have no object
   versions/delete markers. Retain control records for late-write reconciliation.
   Pause isolated issuance even after test failure. Allow in-flight completions
   up to three minutes to settle; reread their state and delete any committed
   synthetic revision. Reconciliation can advance over multiple invocations
   (at most 20 attempts within a 30-minute invocation-start budget). Each worker
   call has a 960-second socket/process timeout, exceeding its 900-second runtime;
   no new invocation starts without that much budget remaining. Verify terminal
   revision states and empty prefixes before disabling the isolated schedule.
   If settling, cleanup, or pausing fails, retain fixture IDs and keep scheduled
   reconciliation enabled with notification readiness off. The release still fails;
   a late committed synthetic report requires owner deletion on recovery.
7. Only after isolated success, deploy production backend in the same order.
   Normal pushes preserve the deployed upload mode. Readiness failure blocks
   frontend deployment and explicit V2 enablement.
8. Generate/upload the frontend, wait for its CloudFront invalidation, and perform
   read-only production site/session/upload-inspection smoke checks. No production
   test uploads or deletes are made by this workflow. Publish the legacy Pages
   redirect and retain sanitized per-stage release evidence.

All releases share a concurrency group with cancellation disabled. Do not run
the old shell deployment scripts concurrently or use them for routine V2 releases.
The controller never prints raw AWS errors or secret values. Rendered edge ZIPs
and environment files exist only in the private temporary release directory and
are removed on normal process exit; they are never retained as workflow artifacts.

## Upload-mode controls and initial enablement

Manual dispatch accepts `upload_mode=preserve` (default), `paused`, or `v2`.
Automatic pushes always use `preserve`. A routine redeploy of `v2` stays `v2`,
and a paused installation stays paused. Unknown deployed mode values stop release.

For an installation whose publication stack is provisioned but whose API still
uses legacy issuance, the first backend deployment configures `paused` and waits
17 minutes for the old 15-minute URL lifetime plus an in-flight allowance. V2
requires the explicit dispatch input and successful gate, worker, and alarm checks.
Periodic late-write cleanup is retained; that wait is not proof that all old
requests finished. Historical content is never automatically swept.

Production alarms use `AlarmTopicArn` from target configuration. The destination
is now managed in the source template, so readiness updates retain it. The
confirmed subscription must be maintained by the operator; an OK alarm and a
configured destination do not independently prove email receipt.

## Evidence and recovery

The `release-<commit>` workflow artifact contains only the allowlisted
`validation-release.json`, `backend-release.json`, and `frontend-release.json`.
Together with the Actions job result, these identify the source commit, API
artifact SHA/key, edge version, completed stages, measured isolated latencies,
and fixture IDs. Known sanitized validation/cleanup failure reasons are retained;
unexpected exceptions and raw service responses remain redacted. A failed stage
does not produce a successful full-stack release.

On failure, downstream steps stop. Existing production mode is preserved; the
workflow does not silently pause a live installation or revert its edge version.
Inspect the failed stage and AWS service state, fix the cause, and rerun the
workflow for reviewed `main`. A rerun packages the same source and creates another
immutable edge version. Concurrent operator API-environment changes are detected
rather than overwritten.

`UPDATE_ROLLBACK_COMPLETE` is accepted for a retry after a successful CloudFormation
update rollback. In-progress operations, failed rollbacks, and failed initial
creation remain blocked for operator recovery.

If issuance must be paused urgently, use the authorized operator procedure in
[the rollout guide](REPORT_PUBLICATION_ROLLOUT.md#recovery-and-rollback); a workflow
dispatch is not an emergency pause path because it first validates the release.
Retain staging configuration, V2 reads, edge gate, control records, and cleanup.
Never roll back to an edge authorizer that permits physical V2 storage paths.
Do not discard control records to clear a failed cleanup or restore legacy upload
issuance after V2 data exists.

Local checks:

```bash
python3 -m unittest discover -s tests -p 'test_*.py'
node --test tests/*.test.js
cfn-lint _infra/publication-stack.json
python3 -m py_compile _infra/release.py _infra/validate-release.py _infra/release-policy.py
```

The live validation script mutates only the designated isolated resources, but
running it still requires authorization and the provisioned secret/permissions.
Do not treat local mock tests as a successful live release.

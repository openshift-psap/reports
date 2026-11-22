# Atomic report publication and abandoned-upload cleanup

**Status: proposed design for [#15](https://github.com/openshift-psap/reports/issues/15), not implemented or deployed.**
Reviewed against `main` at `8f81356` (2026-11-22). Implementation and AWS rollout
require separate approval. This document does not authorize deletion of existing
objects or change upload size limits (#20).

## Selected approach

Use a private, versioned staging bucket, immutable server-created bundle copies,
and a viewer-request publication gate backed by **one S3 control document per
logical report**. Publish by a conditional replacement of that document, not by
moving S3 objects. No database is required in this version.
A scheduled reconciler cleans abandoned uploads independently of clients.
Provide an owner-scoped **Incomplete uploads** dashboard and retain incomplete
upload data for seven days before automatic cleanup. Finalized report copies
have no automatic expiry.

This introduces a staging bucket, private control objects, a scheduled worker, and edge
read permissions. These are material infrastructure changes, justified below;
they are proposals rather than provisioned resources.

**Accepted tradeoff:** use S3 listing/document reads despite their inefficiency;
a database can be introduced later. Keep report IDs, viewer URLs, and API
responses independent of the storage implementation.

**Remaining approval questions:** agree on the cleanup service-level objective described below;
approve the isolated AWS validation before enabling production uploads.
Do not treat this design as proof that #15's acceptance criteria already pass.

## Evidence and existing seams

- `_infra/lambda-token-admin/index.js`, `POST /reports`: signs PUTs directly to
  final `public/` or `private/` keys and stores a pending S3 JSON document.
- The completion handler checks only the entry object, updates the old revision
  before writing new metadata, then removes the pending record. It lacks an
  explicit pending-owner comparison at completion; the new path must enforce it.
- `_infra/lambda-auth/index.js`: `/public/*` bypasses authentication and there
  is no publication check. GitHub/token viewers can otherwise reach arbitrary
  origin paths after authentication. A private-looking prefix alone is insufficient.
- `_infra/deploy-auth-lambda.sh` attaches the authorizer at **viewer-request**,
  the existing place to gate both cache hits and misses.
- `_infra/setup-s3-cloudfront.sh` grants the distribution OAC reads across the
  report bucket. Staging must not inherit that permission.
- #16 added `deleteReportObjects()` error checks and empty-prefix verification.
  Reuse its failure policy; versioned staging requires version-aware deletion,
  not merely calling that helper on a versioned prefix.

These are repository observations. Deployed IAM, bucket versioning, lifecycle,
Object Lock, replication, CloudFront behavior coverage, and quotas are unverified.

## Guarantees and explicit boundaries

1. No report viewer, including an authenticated uploader, can read staged bytes
   or uncommitted copies through report URLs or direct S3 access.
2. A revision becomes readable only after every expected file has been copied
   and validated. One durable commit record is the external publication boundary.
3. Presigned URLs write only staging. They cannot overwrite committed objects.
4. Completion retries return the same committed revision. Replacement commits
   atomically select the new head; the old revision remains readable throughout.
5. Cleanup never deletes a committed attempt. Failed cleanup retains durable
   evidence and retries; an empty observation is not a promise that late PUTs
   can never appear.
6. Listing discovery may lag; it must never expose uncommitted metadata or
   temporarily remove the old head during replacement.

This is application publication atomicity, not a multi-object S3 transaction,
global instantaneous cache invalidation, or a guarantee against AWS outages.

## Storage and read boundary

### Staging

- Dedicated bucket with Block Public Access, no website endpoint, no CloudFront
  origin/OAC grant, and versioning enabled before issuing any URL.
- Keys: `uploads/<upload-id>/<validated-relative-path>`. Only the upload signer
  may issue scoped PUTs. Clients receive no GET, LIST, DELETE, or tagging grants.
- Preserve the intended manifest, author, visibility, entry path, and deadlines
  before returning any signed URL. Scope browser CORS to existing hub origins.
- Separate `uploadUrlsExpireAt` (existing short-lived PUT authorization) from
  `retainUntil` (creation plus seven days) and the completion deadline (also
  creation plus seven days). Do not extend bearer URL validity to a week.
- Versioning lets completion pin exact source versions even when the same PUT
  URL is reused. Retain checksum/size evidence for those versions.

### Immutable copies and viewer URLs

- Copy only manifest objects to the existing report bucket under
  `report-objects-v2/<revision-id>/<attempt-id>/<relative-path>`.
- Attempt IDs are unique and durably registered **before any copy**. A restarted
  worker with a new lease writes a new attempt, never an older attempt's prefix.
- Clients never receive write URLs for this namespace. Only the publisher can
  write it; cleanup roles may delete eligible attempts, not modify their bytes.
- Viewer URLs use `/public/v2/<report-id>/<revision-id>/<relative-path>` or
  `/private/v2/<report-id>/<revision-id>/<relative-path>`. The logical report ID
  locates the authoritative control document without an index lookup.
  Handle these routes before the
  existing broad `/public/` allow rule and legacy manifest exceptions.
- At every viewer request, GET the authoritative report control object directly
  from S3, not through a CDN or replica. Require its revision entry to be
  `COMMITTED`, with matching visibility,
  and existing viewer eligibility for private reports. Google stays view-only.
- Rewrite an allowed request to the committed physical attempt prefix. Preserve
  directory-relative paths. Allow only GET/HEAD; reject ambiguous encoding,
  traversal, and malformed revision/path components.
- Deny direct viewer requests for `report-objects-v2/`, lifecycle/control data,
  and staging-like namespaces **before** all authenticated/public bypasses.
  Do not redirect viewers to physical keys or issue presigned GET URLs.
- Unknown/uncommitted revisions return a non-cacheable not-found response;
  control-store failures fail closed with a non-cacheable service error.
  No positive gate cache in the first implementation.

The existing S3 origin must handle the rewritten paths. CloudFront URI rewriting
does not change the selected cache behavior or origin [2]. Tests must cover all
behaviors, encoded paths, alternate distribution hostnames, cached content, and
origin access. A gate only at origin-request is insufficient: cache hits bypass it.

## Durable state and commit

Store `report-control-v2/<report-id>.json` in private control storage. Keep it
outside every staging lifecycle rule and deny viewer access. Its three sections
are updated together as one S3 object:

| Section | Required evidence |
| --- | --- |
| Upload/revision | owner, report ID, visibility, immutable manifest reference/digest, entry path, state, created/updated times, upload URL expiry, seven-day retention/completion deadline, safe failure stage/code, expected parent/head generation, current lease generation, committed attempt and result |
| Attempt | upload ID, unique prefix, pinned source version manifest, lease generation, validation evidence, cleanup state, retry time/count, last successful empty verification |
| Report head | report ID, current revision, generation, latest listing metadata, visibility and owner |

Keep file manifests and validation evidence as immutable private control objects,
referenced by digest, so the mutable report document holds compact coordination
state. Public API responses exclude control prefixes, source versions, and signed
URLs except upload plans. Never expire the only cleanup record.

Create a control document using `PutObject` with `If-None-Match: *`. Read it with
its ETag; replace it with `PutObject` using `If-Match: <etag>` [3]. Include a
monotonically increasing document generation in every replacement. Treat ETags
as opaque concurrency tokens, not content integrity hashes. There are no
unconditional writes to control documents and no delete/recreate reset.

On 409/412 conflicts, reread and reevaluate owner, state, lease, expected head,
and deadline before constructing a new update. Back off with jitter; return a
retryable conflict if the request's bounded retry budget is exhausted. Never
blindly replay stale state. On an ambiguous write timeout, read the document
and identify the durable operation/result before deciding whether to retry.

All publication and cleanup-eligibility decisions for a report live in this
single document. Immutable manifests and optional discovery hints are not
commit records. To preserve the existing completion endpoint keyed by upload ID,
create an immutable private upload-to-report locator before returning a plan;
then authorize completion against the report document, not the locator. A crash
before locator creation leaves discoverable control state but no issued URLs.

```text
OPEN -> PREPARING -> COMMITTED
  |         |
  +---------+----> ABORTED

attempt: REGISTERED -> VERIFIED -> SELECTED (committed)
             |           |
             +-----------+----> CLEANUP_PENDING -> EMPTY_OBSERVED
```

`EMPTY_OBSERVED` remains eligible for rechecking; it is not permission to forget
the attempt. Committed uploads also retain a staging-cleanup obligation.

### Completion

1. Require the original GitHub owner and existing uploader eligibility, including
   on retries. Read the durable result first: already committed returns the same
   report; aborted/expired returns an actionable terminal response.
   Expired PUT URLs alone do not prevent completion of an already fully uploaded
   bundle within the seven-day completion deadline.
2. Conditionally claim `OPEN -> PREPARING` with a lease generation. Duplicate
   completion while work is active returns a retryable conflict, not a new plan.
3. Resolve and record a version for **every** manifest object; check actual sizes,
   expected paths, and content types. Validate supplied checksums where present.
   Establish a server-verified digest for each pinned object and compare the
   copied destination. Never equate multipart ETag with a content hash.
   Missing or invalid files cannot commit; return corrective errors and abort
   that attempt, with a new upload required after terminal validation failure.
4. Copy pinned versions to the registered unique attempt prefix. Check each copy
   result and verify all destination objects before marking the attempt VERIFIED.
   No viewer can read partial copies. Recovery can resume a live attempt only
   while it still holds its lease; a new lease uses a fresh attempt prefix.
5. Read the current control document and check lease, state, completion deadline,
   owner, validation evidence, and expected parent/head generation. Build one
   replacement document transitioning the upload to COMMITTED, marking its
   verified attempt SELECTED, and updating the current report head. Write it
   with `If-Match` against the ETag just read. Any competing change makes that
   write fail; reread and recheck rather than overwriting the competing change.
6. Persist the stable result in that same conditional write. On a timeout, read
   state before retrying. Idempotency relies on the stored upload ID/result, not
   an SDK retry window. Two replacements of the same head cannot both win.
7. Schedule staging and losing-attempt cleanup. Failure here cannot unpublish
   the committed report: the periodic reconciler discovers the durable obligation.

The successful conditional control-object write is the commit point. No old `isLatest` S3 metadata write may
precede it. Existing revision URLs remain readable after successful replacement.
Client disconnect does not cancel a committed operation.

Initially use the existing synchronous completion interface, bounded by measured
API/Lambda runtime. A deadline failure leaves PREPARING state for automatic
recovery/abort. If representative bundles cannot finish within that budget, an
asynchronous status/polling contract is a separate required design revision,
not an implicit change to existing CLI/MCP success handling.

## Listings, edits, deletion, and legacy compatibility

- V2 listings paginate S3 control keys, read each document, and return only
  committed metadata permitted for the caller. Accept the scan/read overhead
  for now. A replacement updates the same document, so its old head is never
  removed before its new head appears. A listing across multiple documents is
  not a global snapshot; do not promise otherwise.
- History reads committed revisions and the head from the same control-document
  response. Derive `isLatest` from that head, not separately written revision flags.
- Keep the existing report JSON response shape and `pathMode=preserve`. CLI/MCP
  continue sending metadata, PUTing planned files, and calling completion.
  Checksums that require additional client headers must be negotiated and tested;
  old clients must not silently upload outside the V2 flow.
- Metadata edits and archive/delete operations must dispatch by lifecycle
  version. V2 edits condition on record generation; do not keep a second
  authoritative S3 metadata copy. Preserve existing authorization.
- V2 owner deletion closes the gate with a durable deletion state, retains owner
  listing/retry evidence, and deletes only its committed attempt with #16's
  verified files-first policy. Coordinate head changes with replacement commits
   through the same conditional control-document update. Preserve revision isolation.
- Existing reports retain old paths and S3 metadata. Do not reinterpret old
  paths as V2 or delete anything merely because it lacks a V2 record.
- A legacy report must be explicitly registered with a V2 head/generation before
  accepting its first V2 replacement. Route subsequent mutations through that
  head and deduplicate its legacy listing entry. This is a migration prerequisite,
  not a bulk content move. External-link replacement must use the same atomic
  head update, without inventing staging files for external links.

## Cleanup, races, and late writes

A scheduled worker runs every five minutes, paginates the managed control prefix,
reads documents to find due work, and rechecks state before taking ownership by
conditional write. Persist scan progress and bound each invocation; overlapping
workers are safe only because cleanup ownership is conditional. Discovery hints,
if introduced later, never authorize deletion and do not replace periodic scans.

- On the seven-day completion deadline, conditionally transition OPEN to ABORTED.
  A failed or abandoned PREPARING attempt may be aborted earlier, but its private
  data stays available for diagnosis until the upload's `retainUntil` deadline.
  Expired upload URLs alone do not make retained incomplete data cleanup-eligible.
  This competes with the commit write on the same control object: exactly one
  wins from a given state. After claiming ABORTED/cleanup eligibility, the attempt
  must never transition back to publishable. A committed
  attempt is never eligible for abandonment cleanup.
- Expired workers cannot commit with an old lease generation. Their unique
  prefixes remain registered cleanup targets; a stale copy cannot modify a
  committed attempt belonging to another worker.
- For versioned staging, list and delete **all versions and delete markers** with
  pagination, inspect per-key errors, then verify with ListObjectVersions. A
  simple DeleteObjects by key only creates markers and is not sufficient.
- For nonselected copied attempts, use #16's verified deletion policy. If the
  report bucket is versioned, use version-aware cleanup there too. Confirm its
  actual configuration before implementation/rollout.
- For incomplete uploads, cleanup eligibility is the seven-day `retainUntil`
  deadline, not an earlier validation error, worker lease timeout, or client
  disconnect. Successful publication allows prompt cleanup of its staging and
  unselected copies; the selected finalized report has no automatic expiry.
- Back off transient failures with jitter, capped at fifteen minutes between
  attempts. Keep retry state and continue after the alert threshold; a dead-letter
  queue or alert must not become a terminal cleanup state.
- Retain compact tombstones and attempt registrations without an automatic TTL
  initially. A daily paginated reconciliation of **only new managed namespaces**
  catches late-created objects and missed discovery events. An S3 event can speed
  discovery but is not the only recovery mechanism.
- A late PUT produces another private staging version, never published content.
  Repeated reconciliation deletes it even if an earlier pass observed emptiness.
  Do not infer quiescence merely from URL expiry: expiry is checked when requests
  start [1]; do not assume it terminates an in-flight transfer.
- Add staging-only lifecycle rules for current versions, noncurrent versions,
  delete markers, and incomplete multipart uploads as a backstop. Proposed
  eligibility: **seven days**, applied only to staging. Current-object and
  noncurrent-version age are separate lifecycle clocks; day-based rules round
  to a UTC day boundary and removal is asynchronous, so this backstop can run
  later than the worker's seven-day upload deadline. Apply no blanket expiry
  to committed report storage.

### Cleanup target, not an unconditional wall-clock promise

Propose cleanup verification within **30 minutes of eligibility**, assuming
healthy AWS dependencies, sufficient worker capacity, and no later write.
Eligibility is the seven-day retention deadline for incomplete uploads, even if
they failed earlier; staging cleanup after commit
still continues through URL expiry and late arrivals. A late object starts a new
cleanup obligation, detected by events or, at worst, the daily managed-prefix
reconciliation. Alert if the 30-minute due-work target or daily scan deadline is
missed. Capacity tests must demonstrate full scan completion at expected scale.

S3 lifecycle deletion is asynchronous [4]. Neither it nor a scheduler provides
a hard deadline through service outages or arbitrarily late in-flight writes.
**Review blocker:** agree whether #15's "bounded period" means this conditional
operational SLO. If it means an unconditional deadline from initial expiry,
this proposal does not satisfy it. A controlled upload gateway with enforced
transfer deadlines would require a different design, and still cannot guarantee
physical deletion during an S3 outage. Do not document the proposed SLO as deployed.

## Observability and recovery

### Incomplete uploads dashboard

Add an **Incomplete uploads** view to the hub for signed-in GitHub uploaders.
Back it with a paginated `GET /uploads` endpoint scoped server-side to the
authenticated GitHub owner. A public intended visibility does not make pending
metadata public. Anonymous, Google view-only, and access-token viewers cannot
list uploads. The first version shows each owner's uploads; a cross-owner admin
view needs a separately approved administrative authorization policy.

Implement discovery by paginating control keys and reading documents, filtering
by the authenticated owner **before** returning any fields. Bound work per API
request and return an opaque continuation cursor even if a scanned page yields
no matching rows. Bind cursors to the caller/filter; never expose raw control
keys or other owners' metadata. No separate authoritative dashboard index.

Show:

- Report title, upload ID, intended visibility, category, entry path, and whether
  it is a new report or a proposed replacement revision.
- Creation/update times, seven-day retention deadline, time remaining, and the
  separate upload URL expiry. Clearly label expired upload authorization rather
  than implying that seven-day retention extends the PUT URLs.
- Lifecycle status: awaiting files, preparing, failed/aborted but retained,
  expired/cleanup pending, or cleanup retrying. Do not label failed validation
  as successful publication.
- Expected versus observed file count and bytes, observation timestamp, and
  missing/mismatched relative filenames in an owner-only detail view. Use bounded
  manifest-based S3 metadata checks; unavailable observations display **Unknown**,
  not zero. Do not fetch or render staged HTML or asset contents.
- Safe failure stage/code, next cleanup retry, and last verification time. Retain
  cleanup-failure rows after seven days until cleanup is actually verified.

Offer refresh, status filters, and a link to the prior committed revision for
replacement uploads. Display instructions to start a fresh upload when the PUT
URLs have expired or the attempt is terminal. Do not add automatic resubmission,
URL renewal, preview access, or resumable upload semantics as part of this view.
The seven-day retention is a diagnostic window, not a promise of resumability.

Successful commits leave the incomplete list. Fully cleaned terminal uploads
leave its active view; compact server-side tombstones remain for late-write
reconciliation. Reappearing objects restore cleanup-pending visibility. Persist
state server-side so closing the browser or losing client credentials does not
hide abandoned work. Never expose signed URLs, credentials, internal S3 keys,
raw storage errors, or another owner's upload data in dashboard responses.

### Metrics and recovery

Emit upload/revision/attempt IDs, lifecycle transition, failure stage, safe error
code, attempt count, and next retry time. Never log OAuth credentials, signed
URLs, raw SDK request objects, or request bodies containing private metadata.

Metrics: OPEN/PREPARING counts and oldest age; publication failures; lease
conflicts; cleanup backlog/oldest due age; per-key deletion failures; staging
versions/bytes; unselected-attempt bytes; last full scan completion; gate latency
and fail-closed errors. Alert on overdue cleanup, stalled scans, and persistent
gate failures. An absent metric/worker heartbeat is also a failure.

Recovery reads authoritative state first. Resume/abort expired attempts using
conditional state changes; never manually toggle COMMITTED to fix copy failures.
Restore control-state backups only with a reviewed reconciliation of referenced
objects and gate state. Ordinary cleanup must recover without operator action.

## Verification required before implementation is accepted

| Fault/scenario | Required observation |
| --- | --- |
| Interrupt after each client PUT | Neither visibility mode serves any partial bundle; expiry triggers cleanup |
| Missing asset, wrong size/digest, bad entry | No commit, even when entry HTML exists |
| Failure after any copy or state write | Old head remains; unselected attempts eventually empty |
| Commit succeeds but response is lost | Retry returns original result, never a new revision |
| Duplicate/concurrent completions and replacements | One valid head transition; losers cannot publish |
| Cleanup races completion or worker lease expiry | Only one transition wins; selected attempt survives |
| Late PUT before/after cleanup, including new versions | Stays private; rediscovered and deleted; committed digest unchanged |
| Stale worker resumes after lease loss | Writes only its unselected registered prefix; cannot commit |
| Partial S3 batch errors, failed listings, crash after delete | Evidence retained; retries inspect all versions/pages |
| Client disappears or credentials expire | Scheduled work continues without client participation |
| Incomplete upload at day 1/day 6/day 7 | Retained before the seven-day deadline; cleanup becomes eligible at the deadline |
| PUT URLs expire while data is retained | Dashboard distinguishes URL expiry from retention; no implicit URL renewal |
| Dashboard pagination, refresh, failed metadata checks | Correct owner-only state; unavailable counts show Unknown |
| Other owner, anonymous, Google, token dashboard request | No pending-upload metadata or filenames disclosed |
| Cleanup fails after seven days | Row and recovery evidence remain; retries continue |
| Finalized report older than seven days | Remains readable; staging lifecycle cannot delete the committed copy |
| Gate lookup fails; cache already warm | Fail closed, including anonymous and all private viewer identities |
| Direct physical keys, staging S3 URLs, encoding variants | No viewer bypass, including authenticated owners |
| Nested assets and legacy replacement | Paths work; old revision remains; listing has one current head |
| Owner deletion races replacement | Generation conditions preserve the surviving revision |

Build deterministic mocked state-machine and fault-injection tests first.
Then, with separate authorization, use isolated buckets/distribution to
test real IAM denial, edge/cache behavior, version pinning, checksums, timeouts,
late writes, and reconciliation. Measure gate latency and completion duration.
Mocks alone cannot establish those AWS guarantees.

## Rollout and rollback

1. Approve design/SLO and infrastructure plan. Inventory actual policies,
   versioning, replication/retention settings, regions, and deployment behavior.
2. Provision isolated staging/control/reconciliation infrastructure. Verify its
   health and cleanup backstop before permitting uploads.
3. Deploy the V2 read gate and direct-key denials first; wait for complete edge
   propagation. New prefixes must be denied everywhere before any V2 copy exists.
4. Deploy metadata/lifecycle-aware API operations, the owner-scoped incomplete
   upload dashboard, and client compatibility tests.
   Pause old-plan issuance; let existing plans expire and reconcile them under a
   separately approved legacy plan. Do not assert V2 guarantees for old plans.
5. Enable V2 upload issuance only after isolated validation and explicit rollout
   approval. Keep cleanup active throughout. Publish accurate user documentation
   for the enabled version and measured cleanup window.
6. Roll back by disabling new V2 upload issuance while preserving the gate,
   lifecycle reads, and cleanup. Never restore a blanket allow rule for V2 paths
   or silently fall back to direct-to-final uploads. Existing committed V2 reports
   must remain served by the gate-capable version.

Historical orphan work is separate: create a read-only inventory, correlate
metadata, pending plans, legacy manifests and revision references, obtain owner
review, produce an exact candidate list and retention/recovery plan, then request
approval for cleanup. Missing listing entries alone never authorize deletion.

## Alternatives and remaining decisions

- **Just copy staging to public:** rejected; partial copies are readable before
  metadata is written, and crash recovery still lacks a reliable commit point.
- **Only lifecycle expiry:** rejected; it neither gates publication nor supplies
  prompt, observable, verified cleanup or deletes all version history by default.
- **DynamoDB:** deferred by user choice. It could improve querying and coordination
  as usage grows, but is not a dependency of the first implementation.
- **Independent S3 head/revision/cleanup writes:** rejected; conditional writes
  on separate objects do not create a cross-object transaction. Keep governing
  state in one report document.
- **Origin-request gate only:** rejected for the stated guarantee because cached
  requests can bypass it. A later cache optimization needs a separate proof.

Highest-risk assumptions remain real edge latency/fail-closed routing, the
completion runtime budget, and cleanup timeliness under late writes. Revisit
the design if isolated tests fail any of these; do not compensate with undocumented
limits or weaken the visibility guarantee. Keep #20's size policy separate.

### Future database path

Use small storage functions for reading a report, conditionally updating it, and
paginating discovery; implement only S3 now, not a configurable multi-backend
framework. Keep schema versions, stable report/upload/revision IDs, and opaque
API cursors. Measure scan duration/read counts, control-document growth,
conditional-write conflicts, and gate latency. Reconsider a database when these
costs or latency interfere with agreed service objectives.

A future migration must choose one authoritative writer at a time, reconcile
all committed references and cleanup obligations, and move the gate and workers
together. Do not introduce unsafe dual writes or split commit/cleanup authority
between S3 and a database. Existing report URLs and dashboard response fields
should remain unchanged. No database provisioning or migration is included now.

## AWS references checked during design

1. [Presigned URL behavior and expiration](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html).
2. [Lambda@Edge event structure and URI rewriting](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/lambda-event-structure.html).
3. [S3 conditional writes and conflict handling](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html).
4. [S3 lifecycle expiration and versioning considerations](https://docs.aws.amazon.com/AmazonS3/latest/userguide/lifecycle-expire-general-considerations.html).

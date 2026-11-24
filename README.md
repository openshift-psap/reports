# PSAP Report Hub

Report hub and report bundles are served from private S3 through CloudFront. Git contains the application and infrastructure code, never report content.

See [Using the PSAP Report Hub](USING_THE_REPORT_HUB.md) for browsing, sign-in, token management, and report publishing instructions. For command-line uploads, including authentication, limits, and automation constraints, see the [CLI guide](CLI.md).

Publication V2 is **enabled in production as of 2026-11-23**: atomic bundle
publication, seven-day incomplete-upload retention with automatic cleanup, and
an owner-only dashboard. See the
[rollout and recovery guide](_infra/REPORT_PUBLICATION_ROLLOUT.md) for deployment
status and recovery procedures.

Agent clients can optionally use the [local stdio MCP uploader](MCP.md), which shares the CLI's upload and authentication implementation.

Maintainers: the [full-stack deployment guide](_infra/FULL_STACK_DEPLOYMENT.md)
covers the required OIDC/Secrets Manager setup, isolated validation, automatic
backend/frontend releases, upload-mode preservation, and recovery.

## How it works

1. **Report bundles live only in S3** — submitters upload an HTML bundle with a designated entry page through the protected hub or CLI.
2. **The repository deploys the hub shell** — GitHub Actions uses OIDC to publish the application UI and infrastructure-controlled artifacts.
3. **Metadata is per-report** — conditional S3 control documents under `report-control-v2/` own V2 publication and lifecycle state. Legacy `report-meta/public/` and `report-meta/authenticated/` entries remain readable; there is no shared mutable manifest or database.
4. **Auth via CloudFront** — `private/` reports are gated by GitHub OAuth, verified `redhat.com` Google sign-in (view only), or an access token; `public/` reports are deliberately anonymous.

## Adding a report

Sign in at the CloudFront hub and use **Submit a report** to upload one self-contained HTML file; any HTML filename is accepted. For a report with relative assets or multiple files, use the [CLI uploader](CLI.md), which preserves directory-relative paths, including a nested entry page. The browser or CLI receives short-lived, prefix-scoped S3 upload URLs. Files go to private staging and every file is verified before atomic publication.

Do not commit report HTML, assets, or private report metadata to this repository.

## Access levels

| `access` value | Behavior |
|----------------|----------|
| `"authenticated"` | GitHub OAuth required (default); verified `redhat.com` Google sign-in can view but not publish |
| `"public"` | Served without auth via CloudFront |

## Categories

- `benchmarks/` — performance benchmarks, load tests
- `investigations/` — debugging reports, root cause analyses
- `ci/` — CI/CD test results, Allure suites
- `presentations/` — presentation decks and visual explainers

## Configuration

- `_generator/s3_config.json` — S3 bucket, region, CloudFront domain
- `_infra/deploy-auth-lambda.sh` — reads `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and `COOKIE_SECRET`; optional `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` enable verified `redhat.com` view-only sign-in. `CANONICAL_DOMAIN` defaults to `cloudfront_domain`.
- AWS access is provided by the restricted `github-actions-psap-reports-deploy` OIDC role; no repository AWS secrets are required.

## Local checks

Run `node --test tests/*.test.js` for API and form behavior tests (no AWS access or installed dependencies required), and `python3 _generator/generate_index.py` to generate the hub shell locally. The form tests use a lightweight DOM stub; they do not replace a live browser smoke test.

The **Report Hub Tests** workflow runs the regression suite on pull requests to `main`. The deployment workflow reuses the same checks on pushes to `main` and manual deployments; deployment cannot start unless the tests pass. Test jobs have read-only repository access and need no AWS credentials or secrets.

For the metadata-edit feature, deploy the updated token-admin Lambda **before** publishing the updated hub shell. The previous Lambda interprets all report PATCH requests as archive requests; the new Lambda distinguishes metadata edits from archiving. The site workflow deploys only the shell, not the Lambda.

## Architecture decisions

### Client-side index (no pagination)

The full report index is baked into `index.html` as a JSON array. All filtering, searching, and sorting happens client-side in vanilla JS. At the projected scale of 500-1000 reports, the index JSON is ~150-300 KB (30-60 KB gzipped) — well within acceptable page load size. Client-side operations on 1000 entries are instantaneous.

**When to reconsider:** If the report count exceeds ~10,000, the index JSON enters MB range and initial render may slow. At that point, evaluate moving to a server-side API (API Gateway + Lambda querying DynamoDB or S3 Select) with paginated responses. This is a different architecture — don't prematurely optimize.

### Upload model: authenticated direct-to-S3

Legacy submissions use unique `public/<category>/...` or `private/<category>/...` object prefixes. V2 uses private staging and gated `/public/v2/...` or `/private/v2/...` viewer paths backed by a conditional S3 control document. Upload URLs are valid for 15 minutes; the existing API allows at most 100 files and 100 MiB total and requires a designated HTML entry file among them. The browser accepts one HTML file; the CLI preserves nested entry and asset paths. V2 incomplete uploads are retained for seven days and then cleaned up automatically; finalized reports have no automatic expiry. Owners can delete their reports in the hub; see [Delete a report](USING_THE_REPORT_HUB.md#delete-a-report). Archiving keeps the files.

### Report format: HTML only

The generator is format-agnostic — it indexes `meta.json` and links to whatever HTML is on S3. Whether that HTML comes from raw authoring, quarto render, MDX compilation, or Allure output doesn't matter to the indexing layer. A discussion about supporting quarto/MDX as a build step is deferred — see Slack thread from 2026-08-19 (michey's 3-topic decomposition).

### Visibility model: separate S3 prefixes

Public metadata is read anonymously from `report-meta/public/` through the reports API. Private metadata is read only after authentication from `report-meta/authenticated/`. The edge authorizer permits the hub shell, `/public/`, and the public listing endpoint only; private paths and private titles never reach anonymous clients.

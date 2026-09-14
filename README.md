# PSAP Report Hub

Report hub and report bundles are served from private S3 through CloudFront. Git contains the application and infrastructure code, never report content.

See [Using the PSAP Report Hub](USING_THE_REPORT_HUB.md) for browsing, sign-in, token management, and report publishing instructions.

## How it works

1. **Report bundles live only in S3** — submitters upload an `index.html` bundle through the protected hub.
2. **The repository deploys the hub shell** — GitHub Actions uses OIDC to publish the application UI and infrastructure-controlled artifacts.
3. **Metadata is per-report** — S3 objects under `report-meta/public/` and `report-meta/private/` power the dynamic index without a shared mutable manifest.
4. **Auth via CloudFront** — `private/` reports are gated by GitHub OAuth or an access token; `public/` reports are deliberately anonymous.

## Adding a report

Sign in at the CloudFront hub and use **Submit a report**. Select the entire report folder, which must contain a top-level `index.html` plus any relative assets. The browser receives short-lived, prefix-scoped S3 upload URLs; it uploads the files directly to S3 and publishes the metadata only after `index.html` is present.

Do not commit report HTML, assets, or private report metadata to this repository.

## Access levels

| `access` value | Behavior |
|----------------|----------|
| `"authenticated"` | GitHub OAuth required (default) |
| `"public"` | Served without auth via CloudFront |

## Categories

- `benchmarks/` — performance benchmarks, load tests
- `investigations/` — debugging reports, root cause analyses
- `ci/` — CI/CD test results, Allure suites
- `presentations/` — presentation decks and visual explainers

## Configuration

- `_generator/s3_config.json` — S3 bucket, region, CloudFront domain
- AWS access is provided by the restricted `github-actions-psap-reports-deploy` OIDC role; no repository AWS secrets are required.

## Architecture decisions

### Client-side index (no pagination)

The full report index is baked into `index.html` as a JSON array. All filtering, searching, and sorting happens client-side in vanilla JS. At the projected scale of 500-1000 reports, the index JSON is ~150-300 KB (30-60 KB gzipped) — well within acceptable page load size. Client-side operations on 1000 entries are instantaneous.

**When to reconsider:** If the report count exceeds ~10,000, the index JSON enters MB range and initial render may slow. At that point, evaluate moving to a server-side API (API Gateway + Lambda querying DynamoDB or S3 Select) with paginated responses. This is a different architecture — don't prematurely optimize.

### Upload model: authenticated direct-to-S3

Every submission uses a unique object prefix: `public/<category>/...` or `private/<category>/...`. The upload plan is valid for 15 minutes, allows at most 100 files and 100 MB total, and requires a top-level `index.html`. A separate metadata object is written only after the report is complete. The current UI intentionally has no deletion function; removal is an explicit administrative S3 operation.

### Report format: HTML only

The generator is format-agnostic — it indexes `meta.json` and links to whatever HTML is on S3. Whether that HTML comes from raw authoring, quarto render, MDX compilation, or Allure output doesn't matter to the indexing layer. A discussion about supporting quarto/MDX as a build step is deferred — see Slack thread from 2026-08-19 (michey's 3-topic decomposition).

### Visibility model: separate S3 prefixes

Public metadata is read anonymously from `report-meta/public/` through the reports API. Private metadata is read only after authentication from `report-meta/private/`. The edge authorizer permits the hub shell, `/public/`, and the public listing endpoint only; private paths and private titles never reach anonymous clients.

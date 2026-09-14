# PSAP Report Hub

Report index served via GitHub Pages. All reports stored on S3, accessed via CloudFront with GitHub OAuth authentication.

See [Using the PSAP Report Hub](USING_THE_REPORT_HUB.md) for browsing, sign-in, token management, and report publishing instructions.

## How it works

1. **Report source lives in git** — each report has a self-contained `reports/<category>/<date>_<slug>/` directory
2. **Reports deploy to S3** — GitHub Actions validates and publishes report HTML/assets using GitHub OIDC
3. **Index auto-generated** — GitHub Actions runs `_generator/generate_index.py` on push, deploys to GitHub Pages
4. **Auth via CloudFront** — authenticated reports gated by GitHub OAuth; public reports served without auth

## Adding a report

1. Create folder: `reports/<category>/<YYYY-MM-DD>_<slug>/`
2. Add `index.html` and any relative assets to that folder.
3. Add `meta.json`:
   ```json
   {
     "title": "Report Title",
     "description": "Brief description",
     "tags": ["tag1", "tag2"],
     "date": "2026-08-19",
     "author": "your-name",
     "status": "final",
     "s3_key": "<category>/<YYYY-MM-DD>_<slug>/index.html",
     "access": "authenticated",
     "size": "2.4 MB"
   }
   ```
4. Validate locally (optional):
   ```bash
   python3 _generator/validate_reports.py
   ```
5. Open a PR. On merge to `main`, GitHub Actions publishes the report, manifests, and index.

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

### Upload model: validated CI publish

The merge-to-`main` workflow validates every report, publishes its non-metadata files to the S3 prefix declared by `s3_key`, updates the index/manifests, and invalidates the affected CloudFront paths. It never deletes report artifacts automatically; archival or removal must be an explicit operation.

### Report format: HTML only

The generator is format-agnostic — it indexes `meta.json` and links to whatever HTML is on S3. Whether that HTML comes from raw authoring, quarto render, MDX compilation, or Allure output doesn't matter to the indexing layer. A discussion about supporting quarto/MDX as a build step is deferred — see Slack thread from 2026-08-19 (michey's 3-topic decomposition).

### Visibility model: two-manifest split

Public report metadata is baked into `index.html`. Private (authenticated) report metadata is written to `private-entries.json`, uploaded to S3, and served behind CloudFront auth. Client JS fetches private entries on load — if authenticated, entries merge into the UI; if not, only public reports are visible. Internal report titles and descriptions are never exposed to unauthenticated users.

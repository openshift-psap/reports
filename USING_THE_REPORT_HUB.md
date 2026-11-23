# Using the PSAP Report Hub

The PSAP Report Hub has a public index and a secure report delivery site:

- **Browse reports:** <https://reports.psap.aws.rhperfscale.org/>
- **Sign in, submit reports, and manage access tokens:** <https://reports.psap.aws.rhperfscale.org/admin/index.html>

## Browse reports

Use the public index to search by title, tag, category, or submitter. Report cards link to the report hosted through CloudFront.

- Reports marked **public** open directly.
- Reports marked **SSO** require GitHub organization membership, an allowlisted GitHub account, or an access token.

## Sign in to private reports

Open a private report, or select **Sign in / Manage reports** from the index header. The sign-in page offers three methods:

1. **GitHub sign-in** — use this if you are an `openshift-psap` organization member or your GitHub username is allowlisted. GitHub sign-in is required to submit reports.
2. **Google sign-in (view only)** — Red Hat employees with a verified `redhat.com` Google Workspace account can browse private reports but cannot submit reports or manage access tokens.
3. **Access token** — paste a token beginning with `psap_rht_` that was shared with you through an approved private channel.

GitHub and Google sign-in create a secure browser session valid for one day; a token sign-in session is valid for seven days.

If you need access, contact **#forum-psap** on Slack.

## Create and revoke access tokens

PSAP members signed in with GitHub or an access token can use the protected admin page to manage tokens. Google view-only sessions cannot manage tokens.

1. Open <https://reports.psap.aws.rhperfscale.org/admin/index.html> and sign in.
2. Enter a **Group** (for example, `engineering`) and a descriptive **Note**.
3. Choose a token lifetime: **7 days** (default), 30 days, 90 days, one year, or **Long-lived**.
4. Select **Generate Token**.
5. Copy the full token immediately and share it only through an approved private channel. The full value is shown once; the service stores only a SHA-256 digest.
6. To revoke a token, select **Revoke** next to its displayed prefix.

An expired or revoked token prevents future sign-ins with it. Browser sessions created before expiry or revocation remain valid until their seven-day expiry.

## Submit a report

1. Open <https://reports.psap.aws.rhperfscale.org/admin/index.html> and sign in with GitHub. Uploading requires a GitHub identity so the submitter can be recorded.
2. Under **Submit a report**, enter the title, category, optional tags/description, and visibility (**Red Hat Internal** or **Public**). Select matching **Workstream** buttons (`rhoai`, `llm-d`, `rhaii`, or `rhaiis`) when applicable; multiple selections are allowed. These add ordinary tags. The tag picker suggests other tags already used in the hub; choose several, or type a new tag and press Enter. The submitter is automatically recorded as your verified GitHub handle, and the service records the UTC submission time.
3. Use the file picker to select one self-contained HTML report; its filename does not matter. For a report with relative assets or multiple files, use the CLI uploader and designate its HTML entry file.
4. Select **Upload report** and leave the page open until it says **Published**.

The browser uploads directly to S3 using URLs that expire after 15 minutes. Report content and private report metadata are never committed to this public GitHub repository.

Choose **External HTTPS link** instead of Upload HTML to index a report hosted elsewhere. An entry is either one external HTTPS URL or uploaded report content—never both.

### Incomplete uploads (publication V2)

Publication V2 is enabled in production as of **2026-11-23**. Uploaded files stay in private staging
until every file has been verified and the report is published atomically. A
replacement leaves the previous committed revision available until publication.

In the GitHub-signed-in admin page, open **Incomplete uploads** and select
**Refresh uploads**. Only your uploads appear. Use **Load next page** to continue
the scan and **Inspect file progress** to check missing or mismatched files;
Unknown means progress has not been checked or could not be read.

Incomplete uploads are retained for seven days from creation, then automatically
cleaned up, targeting verified cleanup within 30 minutes after the deadline with
healthy dependencies and sufficient scan capacity. Upload URLs expire after 15 minutes; retention does not renew them or
make uploads resumable. Failed validation or expired URLs require a fresh upload.
After a completion timeout, refresh the hub before uploading again: publication
may have succeeded. Finalized reports have no automatic expiry.

Completion can still succeed after PUT URL expiry if every file already arrived
and the seven-day completion deadline has not passed. See the
[rollout and recovery guide](_infra/REPORT_PUBLICATION_ROLLOUT.md).

### CLI upload for multi-file reports and local automation

Use the repository's CLI uploader for a report directory with relative assets or for scripted publishing from your machine. The script must remain in an intact checkout, but it may be invoked from any directory; cloning, `--help`, login, options, limits, and troubleshooting are documented in the [CLI guide](CLI.md). Local agents must obtain explicit user approval for each upload, whether internal/private or public, including the exact bundle, entry page, metadata, and visibility; see the [agent upload guidance](CLI.md#local-coding-agents).

```bash
./bin/psap-report --login
./bin/psap-report ./rendered-report \
  --entry-file index.html \
  --title "Inference benchmark" \
  --category benchmarks \
  --tags "llm-d,gpu" \
  --description "Automated benchmark report"
```

The CLI creates new reports only; use the browser controls in this guide to edit metadata, replace content, archive, or delete. CLI uploads require an `openshift-psap` GitHub account authenticated through Device Flow. Google view-only and `psap_rht_` token sessions cannot upload. Authentication is cached at `~/.config/psap-report/github-oauth.json` with owner-only permissions; re-run `--login` to switch accounts. No AWS credentials are required. Unattended CI login is not yet supported; see the CLI guide.

## Sign out

Select **Sign out** in the hub header to end the browser session immediately. This clears the Report Hub session only; it does not sign you out of GitHub itself.

## Workstreams and curated tags

The hub groups reports into **RHOAI**, **llm-d / RHAII**, and **RHAIIS** when they carry the matching tags. These are ordinary optional tags, not a separate required field. Reports without one of those tags stay in an **Unassigned** section.

Workstream owners curate the optional prominent tag shortcuts in [`_generator/workstreams.json`](./_generator/workstreams.json). Add approved tags to a workstream's `top_tags` list and merge the change; the next site deployment publishes them.

## Delete a report

1. Sign in with GitHub as the account that submitted the report. CLI/MCP login
   does not sign you in to the browser.
2. Find the intended report/revision. **Delete** appears only on reports attributed
   to your verified GitHub handle.
3. Select **Delete** and confirm. This cannot be undone through the hub.

The production V2 service closes a V2 revision's viewer path before deleting its
published bundle, including nested assets and object versions. It verifies that
the managed prefix is empty before marking the revision deleted and removing it
from the listing. Control records remain for recovery and reconciliation; deletion
does not erase all lifecycle evidence. Other retained revisions are not deleted.

A partial deletion, storage error, or failed verification returns an error and
retains the owner listing so you can refresh and retry **Delete**. The V2 viewer
path is already closed, and some files may already be gone. Retry after a network
error too: a lost response does not establish whether deletion completed. If
failures persist, contact the administrator with the report ID and error.

Legacy reports are adopted into lifecycle tracking when changed or deleted. Their
deletion scope uses the recorded bundle `baseKey`, or, for older reports without
one, the directory containing the entry page; files outside that directory may
remain. Legacy URLs do not gain the V2 viewer gate. External-link deletion removes
the hub entry, not content on the external host.

Scheduled cleanup removes abandoned V2 uploads after their seven-day retention
period and revisits managed prefixes for late writes. It does not automatically
delete historical content or revoke old PUT URLs. The CLI and MCP currently upload
new reports only; neither provides a delete command/tool.

Use **Archive** instead to retire an old or deprecated report without deleting its files. Archived reports remain available through their links and can be found with the status filter, but are clearly marked as archived.

## Update a report

Owners can select **Update** on a current report. The form is pre-filled and the **Update report** radio buttons default to **Edit info only — keep existing report**. Change the title, description, category, or tags (including the visible **Workstream** choices), then select **Save report info**. No file selection or upload is needed: the existing files or external link, report URL, author, submission date, and content revision number remain unchanged. Info edits update the current revision's metadata in place, not historical revisions.

Choose **Replace report / change link** to publish new content instead. Uploading the replacement bundle creates a new immutable content revision. The updated revision becomes the card shown in the hub; the prior files and metadata are retained for audit and version history. Visibility cannot be changed while updating a report. Select **Cancel update**, beside the save/publish button, to return to a fresh submission.

When a report has more than one revision, its card shows **Versions**. The dialog lists every retained revision and provides a direct link to each one. Authenticated users also see the stable report ID on cards; use it when referring to a report in automation or support requests.

### Non-HTML reports

Every submission needs an HTML entry page. Its name does not need to be `index.html`—select the file in the browser, or pass its directory-relative path with `--entry-file` to the CLI. The CLI accepts a nested entry such as `site/report.html` and keeps the bundle paths unchanged.

- **Quarto, Jupyter, Allure, and slide decks:** render or export them to static HTML and upload the resulting folder.
- **PDFs:** include a small `index.html` landing page that describes the report and embeds or links to `report.pdf`.
- **Office documents:** convert to PDF and include an HTML landing page.
- **Large data or downloadable artifacts:** upload them as relative files alongside an HTML summary with download links.

Do not add server-side document converters or executable report generators to the submission service. Static HTML bundles are safer, portable, and work with the existing CloudFront authorization model.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| A public report shows the sign-in page | Wait a minute for the deployment/invalidation, then confirm it was submitted with **Public** visibility. |
| A private report denies GitHub sign-in | Confirm you are in `openshift-psap` or request allowlist access through **#forum-psap**. |
| Google sign-in fails | Use a verified `redhat.com` Google Workspace account. Google access is view only; use GitHub to upload or manage tokens. |
| A token is rejected | Check that it was copied in full and has not been revoked. Request a new token through **#forum-psap**. |
| Upload fails before completion | Check the selected entry HTML file is included in the bundle, keep it under 100 MB / 100 files, and retry to obtain fresh upload URLs. |

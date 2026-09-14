# Using the PSAP Report Hub

The PSAP Report Hub has a public index and a secure report delivery site:

- **Browse reports:** <https://d3a5l0t7t5dflc.cloudfront.net/>
- **Sign in, submit reports, and manage access tokens:** <https://d3a5l0t7t5dflc.cloudfront.net/admin/index.html>

## Browse reports

Use the public index to search by title, tag, category, or submitter. Report cards link to the report hosted through CloudFront.

- Reports marked **public** open directly.
- Reports marked **SSO** require GitHub organization membership, an allowlisted GitHub account, or an access token.

## Sign in to private reports

Open a private report, or select **Sign in / Manage reports** from the index header. The sign-in page offers two methods:

1. **GitHub sign-in** — use this if you are an `openshift-psap` organization member or your GitHub username is allowlisted.
2. **Access token** — paste a token beginning with `psap_rht_` that was shared with you through an approved private channel.

GitHub sign-in creates a secure browser session valid for one day; a token sign-in session is valid for seven days.

If you need access, contact **#forum-psap** on Slack.

## Create and revoke access tokens

All authenticated PSAP members can use the protected admin page to manage tokens.

1. Open <https://d3a5l0t7t5dflc.cloudfront.net/admin/index.html> and sign in.
2. Enter a **Group** (for example, `engineering`) and a descriptive **Note**.
3. Choose a token lifetime: **7 days** (default), 30 days, 90 days, one year, or **Long-lived**.
4. Select **Generate Token**.
5. Copy the full token immediately and share it only through an approved private channel. The full value is shown once; the service stores only a SHA-256 digest.
6. To revoke a token, select **Revoke** next to its displayed prefix.

An expired or revoked token prevents future sign-ins with it. Browser sessions created before expiry or revocation remain valid until their seven-day expiry.

## Submit a report

1. Open <https://d3a5l0t7t5dflc.cloudfront.net/admin/index.html> and sign in.
2. Under **Submit a report**, enter the title, category, optional tags/description, and visibility (**Red Hat Internal** or **Public**). The submitter is automatically recorded as your verified GitHub handle, and the service records the UTC submission time.
3. Use the file picker to select the complete report folder. It must include `index.html` at its top level; relative assets and subfolders are supported.
4. Select **Upload report** and leave the page open until it says **Published**.

The browser uploads directly to S3 using URLs that expire after 15 minutes. Report content and private report metadata are never committed to this public GitHub repository. A bundle is limited to 100 files and 100 MB.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| A public report shows the sign-in page | Wait a minute for the deployment/invalidation, then confirm its `meta.json` has `"access": "public"`. |
| A private report denies GitHub sign-in | Confirm you are in `openshift-psap` or request allowlist access through **#forum-psap**. |
| A token is rejected | Check that it was copied in full and has not been revoked. Request a new token through **#forum-psap**. |
| Upload fails before completion | Check the bundle contains a top-level `index.html`, is under 100 MB / 100 files, and retry to obtain fresh upload URLs. |

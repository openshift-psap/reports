# Using the PSAP Report Hub

The PSAP Report Hub has a public index and a secure report delivery site:

- **Browse reports:** <https://openshift-psap.github.io/reports/>
- **Sign in and manage access tokens:** <https://d3a5l0t7t5dflc.cloudfront.net/admin/index.html>

## Browse reports

Use the public index to search by title, tag, category, or submitter. Report cards link to the report hosted through CloudFront.

- Reports marked **public** open directly.
- Reports marked **SSO** require GitHub organization membership, an allowlisted GitHub account, or an access token.

## Sign in to private reports

Open a private report, or select **Sign in / Manage reports** from the index header. The sign-in page offers two methods:

1. **GitHub sign-in** — use this if you are an `openshift-psap` organization member or your GitHub username is allowlisted.
2. **Access token** — paste a token beginning with `psap_rht_` that was shared with you through an approved private channel.

Successful sign-in creates a secure browser session valid for seven days.

If you need access, contact **#forum-psap** on Slack.

## Create and revoke access tokens

All authenticated PSAP members can use the protected admin page to manage tokens.

1. Open <https://d3a5l0t7t5dflc.cloudfront.net/admin/index.html> and sign in.
2. Enter a **Group** (for example, `engineering`) and a descriptive **Note**.
3. Select **Generate Token**.
4. Copy the full token immediately and share it only through an approved private channel. The full value is shown once; the service stores only a SHA-256 digest.
5. To revoke a token, select **Revoke** next to its displayed prefix.

Revoking a token prevents future sign-ins with it. Browser sessions created before revocation remain valid until their seven-day expiry.

## Publish a report

Report source is version-controlled in this repository. A report directory must contain `index.html`, `meta.json`, and any relative assets:

```text
reports/<category>/<YYYY-MM-DD>_<slug>/
├── index.html
├── meta.json
└── assets/              # optional
```

Use this metadata shape:

```json
{
  "title": "Report title",
  "description": "Short summary",
  "tags": ["benchmark", "gpu"],
  "date": "2026-09-14",
  "author": "github-username",
  "status": "final",
  "s3_key": "<category>/<YYYY-MM-DD>_<slug>/index.html",
  "access": "authenticated",
  "size": "1.2 MB"
}
```

`s3_key` must exactly match the report directory relative to `reports/`, followed by `/index.html`. Set `access` to either `public` or `authenticated`.

Before opening a pull request, run:

```bash
python3 _generator/validate_reports.py
```

After merge to `main`, GitHub Actions validates all report directories, publishes report files to S3 through OIDC, regenerates the index and manifests, and invalidates the affected CloudFront paths. It does not automatically delete removed report files from S3.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| A public report shows the sign-in page | Wait a minute for the deployment/invalidation, then confirm its `meta.json` has `"access": "public"`. |
| A private report denies GitHub sign-in | Confirm you are in `openshift-psap` or request allowlist access through **#forum-psap**. |
| A token is rejected | Check that it was copied in full and has not been revoked. Request a new token through **#forum-psap**. |
| The publish workflow fails validation | Read the validation output; every `meta.json` must be valid and every report must contain `index.html`. |

# PSAP Report CLI

`bin/psap-report` uploads a static HTML report to the PSAP Report Hub. It is the
supported uploader for report folders with relative assets and for use by local
coding agents. It is not installed as a system command and it does not use AWS
credentials.

The CLI uploads **new reports only**. Listing, metadata edits, content
replacement, archiving, deletion, external-link submissions, and access-token
management remain browser features in the hub. An optional [local MCP wrapper](MCP.md)
exposes the same uploader to agent clients over stdio.

## Agent upload approval

**If you are acting as an agent, obtain explicit user approval before every
upload, whether internal/private or public.** Show the intended bundle and entry
page, the title and other metadata, and the visibility before asking for
approval. An explicit request that authorizes those specifics is enough; do not
require a separate confirmation ritual. Do not upload until the user approves. A
generated report, a valid cached login, or the default internal visibility does
not imply permission to publish. Ask again if the bundle, metadata, or
visibility changes.

This is an agent workflow guardrail, not technical enforcement or a security
guarantee. Responsibility for the report's content, metadata, audience, and
decision to publish remains with the user.

## Before you start

- A GitHub account that is a member of the `openshift-psap` organization. The
  upload API verifies organization membership with the GitHub token created by
  the CLI. The hub's separate username allowlist applies to browser sign-in, not
  to CLI uploads.
- Python 3.10 or newer on Linux or macOS, with its standard library. Safe file
  opening requires POSIX `dir_fd` and `O_NOFOLLOW` support. No packages, virtual
  environment, or AWS CLI are required.
- Network access to GitHub and the report API.
- A report entry page in HTML (`.html` or `.htm`) and any relative assets beside
  it.

You do **not** need AWS credentials, an S3 bucket name, a CloudFront key, a
`psap_rht_` access token, or a Google account. The CLI never accepts those as
upload credentials.

## Get the CLI

The script reads configuration from the repository at
`_generator/s3_config.json`. Configuration is resolved relative to the script's
checkout, not the current working directory, so keep the repository layout
intact.

```bash
git clone https://github.com/openshift-psap/reports.git
cd reports
python3 --version
./bin/psap-report --help
```

Nested entry paths require the current CLI and upload service from `main`. In an
existing checkout, update to the current `main` before uploading:

```bash
git switch main
git pull --ff-only
```

If the checkout cannot fast-forward, or if it predates nested path support, make
a fresh clone with the commands above instead of uploading from the old
checkout. The CLI stops before uploading if the service does not confirm path
preservation.

The checkout already marks `bin/psap-report` executable. If needed, run it as
`python3 bin/psap-report` instead. You can invoke it by path from another
directory as long as the checkout is intact.

Do not copy `bin/psap-report` by itself to another location. The script loads
`bin/psap_report.py` and `_generator/s3_config.json` when it starts, so a standalone
copy fails even for `--help`. There are no environment overrides for
the API URL or GitHub client ID.

## Options

```text
usage: psap-report [-h] [--entry-file ENTRY_FILE] [--title TITLE]
                   [--category {benchmarks,ci,investigations,presentations}]
                   [--access {public,internal}] [--tags TAGS]
                   [--description DESCRIPTION] [--login]
                   [source]

positional arguments:
  source                HTML file or report directory

options:
  -h, --help            show this help message and exit
  --entry-file ENTRY_FILE
                        HTML entry path relative to directory
  --title TITLE
  --category {benchmarks,ci,investigations,presentations}
  --access {public,internal}
  --tags TAGS
  --description DESCRIPTION
  --login               Authenticate with GitHub Device Flow
```

| Option | Required | Meaning |
| --- | --- | --- |
| `source` | yes, except with `--login` alone | One HTML file, or a directory containing the report |
| `--entry-file` | required for a directory | HTML entry page path relative to the directory, such as `index.html` or `site/report.html` |
| `--title` | yes | Report title; also used to generate the URL slug |
| `--category` | yes | Exactly one of `benchmarks`, `ci`, `investigations`, `presentations` |
| `--access` | no | `internal` (default) or `public` |
| `--tags` | no | Comma-separated tags, for example `"rhoai,gpu"` |
| `--description` | no | Short description |
| `--login` | no | Run GitHub Device Flow; with no `source`, only authenticate and exit |

## Sign in with GitHub Device Flow

Run the login step once on the machine that will upload:

```bash
./bin/psap-report --login
```

The CLI prints a GitHub verification URL and a short code. Open the URL in a
browser, enter the code, and authorize the request. GitHub returns a user token
with the `read:org` scope. The upload service uses that token to identify you
and verify `openshift-psap` membership. Login alone uploads nothing.

Use the verification URL printed by the command rather than a URL from an old
session. The short code is only for this login attempt; do not post it or the
resulting credential in chat, tickets, or repository files.

### Where the credential is stored

The GitHub OAuth response is saved to:

```text
~/.config/psap-report/github-oauth.json
```

The file is written with owner-only (`0600`) permissions and contains a GitHub
OAuth access token. The CLI does not print the token, does not use a refresh
token, and does not track an expiry time. Treat the file as a personal
credential:

- Do not print, paste, commit, attach, or share its contents.
- Do not copy it to CI secrets, shared runners, other users, or other machines.
- Do not assume it is interchangeable with a hub browser session.

The hub's GitHub browser cookie, the `psap_rht_` access-token sign-in, and
Google view-only sign-in are separate mechanisms. The CLI does not read browser
cookies, does not accept `psap_rht_` tokens, and does not offer Google sign-in.
Conversely, logging in with the CLI does not sign you in to the hub in a
browser.

### Account switching, expiry, and rejected credentials

The CLI reuses the cached token whenever `--login` is not supplied. To switch
GitHub accounts, run `--login` again and authorize the other account; the cache
is overwritten. To remove the local credential entirely, delete the file:

```bash
rm ~/.config/psap-report/github-oauth.json
```

There is no CLI logout command. Removing the cache does not revoke the token on
GitHub; revoke it under GitHub **Settings → Applications → Authorized OAuth
Apps** if it may have been exposed.

If the token is expired, revoked, or belongs to an account that is not an
`openshift-psap` member, the upload API returns:

```text
API error (401): Not authenticated
```

The CLI does not delete the stale cache automatically. Run `--login` again (or
remove the cache and log in) before retrying. If you are only on the browser
allowlist, you can sign in to the hub and may upload through the browser, but
the CLI does not accept the allowlist for uploads; request `openshift-psap`
organization membership through **#forum-psap** for CLI use.

## Upload a standalone HTML report

A single-file upload must be `.html` or `.htm`. Its filename becomes the entry
page. Do not pass `--entry-file` unless it exactly matches that filename.

An explicitly selected single-file symlink is allowed: its final resolved target
is the selected file, and that target's filename and HTML extension are used.
There is no selected directory boundary in this mode. Dangling links and loops
are rejected. To enforce a report-directory boundary, select the directory
instead and specify its entry page.

```bash
./bin/psap-report ./standalone-report.html \
  --title "Standalone investigation" \
  --category investigations \
  --tags "rhoai,gpu" \
  --description "Summary of the local reproduction"
```

By default the report is **internal**; `--access internal` states that default
explicitly. Add `--access public` only to publish anonymously:

```bash
./bin/psap-report ./standalone-report.html \
  --title "Public benchmark summary" \
  --category benchmarks \
  --access public
```

Public visibility exposes the bundle to anonymous readers. Confirm the bundle
contains no internal data before using `--access public`. The hub does not
provide a visibility toggle for an existing report; choose the audience before
uploading.

## Upload a directory with assets

A directory upload requires `--entry-file`. Stage the intended report files in
a dedicated directory before uploading. The CLI includes every regular file
under that directory recursively, including dotfiles and unrelated notes; there
is no ignore file or include filter. Do not run it against a working directory
that contains files you do not intend to publish.

```bash
./bin/psap-report ./rendered-report \
  --entry-file index.html \
  --title "Inference benchmark" \
  --category benchmarks \
  --tags "llm-d,gpu" \
  --description "Rendered benchmark report with relative assets"
```

Rules for `--entry-file`:

- Use a path relative to the directory, with forward slashes.
- Do not use a leading `./` or an absolute path.
- The file must exist inside the directory.
- Nested entries such as `site/report.html` are allowed.
- For a single-file upload, `--entry-file` must match the HTML filename exactly.

The selected directory is the upload root. Its own name is not part of any
uploaded or entry path. The CLI preserves every path relative to that root,
including a nested entry. For example, if `./rendered-report/` contains
`site/report.html` and `site/assets/style.css`, use
`--entry-file site/report.html`. The files are uploaded as exactly
`site/report.html` and
`site/assets/style.css`, so relative links such as `assets/style.css` continue
to resolve. Do not flatten `site/` into the upload root and do not prefix the
entry with `rendered-report/`.

The CLI verifies that the service confirmed path preservation before uploading
anything; if confirmation is missing, it stops instead of publishing rewritten
paths (see Troubleshooting).

All uploads default to internal visibility. Add `--access public` only for a
report intended for anonymous readers.

The CLI sends the file list first, then uploads each file to a short-lived S3
URL, and finally asks the service to publish the report. The service checks
that the entry HTML exists before publishing metadata.

### Symlink boundary and filesystem changes

For a directory upload, the canonical (fully resolved) selected directory is the
upload root. Selecting a directory through a symlink selects that canonical
directory. Both internal and public uploads enforce the same boundary:

- File symlinks and chains are allowed only when their final target is inside
  the upload root. They retain the link's directory-relative upload name.
- An out-of-root target rejects the entire bundle before any upload-plan or PUT
  request. The error names the offending relative path without showing target
  contents. Sibling directories such as `report-private` are outside `report`.
- Dangling links and symlink loops reject the entire bundle. Repair or remove
  the named link before retrying; links are never silently omitted.
- Directory symlinks are rejected, including in-root ones. Replace them with
  real directories containing the intended assets.

After validation, the uploader opens each resolved path component without
following symlinks and snapshots the file bytes in memory before requesting a
plan. A file or parent replaced with a symlink before opening causes rejection;
changes after snapshotting cannot change the uploaded bytes. Snapshot memory is
bounded by the existing 100 MiB bundle limit (plus a one-byte overflow check).

This is not an atomic snapshot of the filesystem. Concurrent edits to an opened
regular file can produce inconsistent contents; concurrent additions may be
missed, and renaming real directories or changing mount points during traversal
is not fully prevented. Hard links are treated as regular files, not evidence
of content provenance. Stage a stable bundle and do not modify it during upload.
The boundary check complements explicit upload approval; users remain
responsible for the selected content and audience.

## Categories, tags, and workstreams

Categories are fixed:

| `--category` | Use for |
| --- | --- |
| `benchmarks` | Performance benchmarks and load tests |
| `ci` | CI/CD results and Allure suites |
| `investigations` | Debugging reports and root cause analyses |
| `presentations` | Presentation decks and visual explainers |

Tags are optional, comma-separated, and trimmed. The service keeps at most 20
tags and truncates long tags. Workstream grouping uses ordinary tags:
`rhoai`, `llm-d`, `rhaii`, and `rhaiis`. A report without one of those tags
appears under **Unassigned** in the hub, which is valid.

The service truncates a title longer than 180 characters, a tag longer than 40
characters, and a description longer than 1000 characters. A title must contain
at least one ASCII letter or number because the service derives the report URL
slug from it.

## What the command returns

Each uploaded file produces a progress line, and the final line is the report
URL:

```text
Uploaded site/index.html
Uploaded site/assets/style.css
Uploaded site/assets/chart.png
https://reports.psap.aws.rhperfscale.org/private/benchmarks/2026-11-19_inference-benchmark-1a2b3c4d/site/index.html
```

The final line is the entry page URL, not an administrative page and not a
report ID. Internal reports use a `private/` path; public reports use `public/`.
The authenticated GitHub handle is recorded as the submitter.

The CLI does not print the report ID, list reports, or update an existing
report. A successful upload creates a new report entry. If you lose the URL,
find the report in the hub; authenticated users can see report IDs on cards.

## Limits

The service enforces these limits:

| Limit | Value |
| --- | --- |
| Files per report | 100 maximum, at least 1 |
| Total bundle size | 100 MB maximum |
| Individual file size | 100 MB maximum |
| Upload URL lifetime | 15 minutes from upload-plan creation |
| Entry page | One designated entry file, which must be one of the uploaded files and may be nested |
| Tags | 20 kept, 40 characters each |
| Title | 180 characters |
| Description | 1000 characters |

The CLI checks the 100 MiB total size limit while snapshotting files; the service
still validates file count and bundle limits. A large or slow upload can
outlive its upload URLs. An upload may then fail, or the completion request may
fail with an expired-plan error; in either case no report is published. Re-run
the command to obtain a fresh plan, but check the hub first if the previous run
may have completed.

File names must be unique relative paths without backslashes, leading slashes,
empty segments, `.` segments, or `..` segments. Hidden files are uploaded like
any other file.

## Troubleshooting

| Message or symptom | Cause and action |
| --- | --- |
| `API error (401): Not authenticated` | Token is invalid, expired, revoked, or not an `openshift-psap` member. Re-run `--login`; confirm organization membership. The allowlist does not grant CLI uploads. |
| `API error (400): Choose a supported category` | Use one of the four category values exactly. |
| `API error (400): A report title is required` | Pass a non-empty `--title`. |
| `API error (400): A URL slug or title containing letters/numbers is required` | Add at least one ASCII letter or number to the title. |
| `API error (400): Choose 1–100 files` | The bundle has no files or more than 100. |
| `API error (400): The report bundle exceeds the 100 MB limit` | Reduce the bundle below 100 MB. |
| `API error (400): Invalid, duplicate, or oversized file name` | Rename duplicate or invalid paths, and keep each file at or below 100 MB. |
| `API error (400): entryFile must be one of the uploaded files` | Correct `--entry-file` to an uploaded relative path. |
| `API error (400): entryFile must be a valid relative file path` | Remove a leading `/` or `./`, backslashes, and any `.` or `..` path segments from `--entry-file`. |
| `API error (400): pathMode must be strip or preserve` | The service rejected the path-preservation option. Treat this as a client/service version mismatch and do not retry the same upload. |
| `The report API did not confirm pathMode=preserve; update the report service before uploading` | The service endpoint does not support path preservation. The CLI stopped before uploading any files. Use the current CLI and service from `main`, and report a version mismatch if this persists. |
| `Upload plan does not match the source files` | The service returned upload targets that do not match the staged bundle. No files were uploaded; report the mismatch rather than retrying blindly. |
| `API error (400): The selected HTML entry file has not been uploaded yet` | An upload did not land or used a different name. Retry with a fresh plan. |
| `API error (410): Upload plan expired; start again` | The 15-minute window closed. Re-run the command. |
| `API error (404): Upload plan not found or already completed` | The plan was already completed or expired. Check the hub before re-uploading. |
| `Source not found: <path>` | Check the HTML file or directory path. |
| `--entry-file is required when uploading a directory` | Pass the HTML entry path relative to the directory. |
| `Entry file not found: <path>` | Use an exact relative path without a leading `./`. |
| `Single-file uploads must be HTML files` | A single-file upload must end in `.html` or `.htm`; put other assets in a directory bundle. |
| `--entry-file must match the supplied HTML filename` | For a single file, omit `--entry-file` unless it exactly matches the filename. |
| `source, --title, and --category are required for upload` | Supply all three for an upload. `--login` alone is the exception. |
| `FileNotFoundError` for `_generator/s3_config.json` | The script was copied out of its checkout. Run `bin/psap-report` from an intact clone. |
| GitHub device-flow error or timeout | Retry `--login`; use the newly printed verification URL and code. |
| `File upload failed` | A direct S3 upload failed. Check file readability and network access, then retry with a fresh upload plan. |

The CLI does not retry failed requests automatically. Re-running an upload
creates a new report rather than resuming the old one.

## Humans, local agents, and CI

### People

Use the CLI when the browser form cannot represent the bundle: directories with
relative assets, generated HTML, or a report prepared elsewhere. For a single
self-contained HTML file, either the CLI or the browser form works.

### Local coding agents

An agent can clone the repository, check `--help`, prepare the report directory,
and run the upload only after the user approves that upload, whether
internal/private or public. Before asking for approval, present:

- the exact file or staged directory and its entry page;
- the title, category, tags, and description;
- the intended visibility: internal/private or public.

An explicit user request authorizing those specifics counts as approval; do not
demand a redundant confirmation step. Do not treat a generated report, a valid
cached login, or the default internal visibility as permission. If the bundle,
entry page, metadata, or visibility changes, seek approval again.

This is the workflow guardrail described at the top of this guide. The CLI does
not enforce it, and it is not a security guarantee; the user is responsible for
the report's content, metadata, audience, and decision to publish.

The device-flow step needs a human with a browser. An agent may start
`--login` and show the printed verification URL and code, then wait for the
human to authorize. The agent must not read, print, copy, or commit
`~/.config/psap-report/github-oauth.json`, and must not ask the user to paste a
token into the conversation. After login, the upload command reads the cache
itself; no token needs to be passed on the command line.

### CI and unattended automation

**Unattended CI authentication is not currently supported.** The only login
path is interactive GitHub Device Flow, which requires a person to open a
browser and approve a code. The resulting token is a personal GitHub OAuth
credential cached at a fixed home-directory path; it has no refresh flow and is
not a service-account credential.

The CLI has no environment-variable or flag for supplying a token. In
particular, it does not read `GITHUB_TOKEN`, and AWS credentials do not help.
An ephemeral CI runner will not have the cache, so it will stop at the
interactive login prompt. Copying a developer's cache into CI secrets would
share that person's credential and is not supported.

Until a dedicated unattended mechanism exists, publish from a machine where a
human has completed `--login`, or use the hub's browser form. Do not design a CI
job that assumes a pre-authenticated cache or a bot token.

## Related documentation

- [Using the PSAP Report Hub](USING_THE_REPORT_HUB.md) — browsing, sign-in,
  access tokens, metadata updates, replacement, archive, and delete.
- [README](README.md) — repository architecture, access model, and local
  checks.
- Report issues and documentation corrections at
  <https://github.com/openshift-psap/reports/issues>.

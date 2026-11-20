# Local MCP report uploader

The optional `upload_report` tool publishes a new HTML report through the same
uploader and GitHub authentication cache as [the CLI](CLI.md). It runs locally
over stdio; there is no hosted MCP endpoint or shared service identity.

## Install and authenticate

Use Python 3.10 or newer and an intact repository checkout:

```bash
git clone https://github.com/openshift-psap/reports.git
cd reports
python3 -m venv .venv-mcp
.venv-mcp/bin/python -m pip install -r requirements-mcp.txt
python3 bin/psap-report --login
```

Complete GitHub Device Flow in a terminal on the host that will run the MCP
process, as the same operating-system user. The API checks that individual's
`openshift-psap` organization membership. The MCP tool reads the existing
`~/.config/psap-report/github-oauth.json` cache; it never prompts for login or
accepts tokens as tool arguments. Missing, unreadable, or malformed credentials
return login instructions. Rejected credentials return instructions to log in
again and confirm organization membership. Do not share or paste the cache.

The MCP dependency is optional. The CLI still requires only Python's standard
library. Keep `bin/` and `_generator/s3_config.json` in their checkout layout.

## Configure a local client

The server uses standard MCP stdio and supports both Claude Code and OpenCode,
but their configuration formats differ. Replace the absolute paths below with
your checkout location. Both clients require CLI login on the host running the
MCP process, as described above.

### Claude Code

Add this to `.mcp.json` in your project root (merge with existing servers):

```json
{
  "mcpServers": {
    "psap-reports": {
      "command": "/absolute/path/reports/.venv-mcp/bin/python",
      "args": ["/absolute/path/reports/bin/psap-report-mcp"]
    }
  }
}
```

Approve the project server when Claude Code prompts, then check its connection
with `/mcp` or `claude mcp get psap-reports`.

### OpenCode V2

Add this to `opencode.json` in your project root (merge with existing settings):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "psap-reports": {
        "type": "local",
        "command": [
          "/absolute/path/reports/.venv-mcp/bin/python",
          "/absolute/path/reports/bin/psap-report-mcp"
        ]
      }
    }
  }
}
```

OpenCode reloads configuration automatically. Check the connection with `/mcps`
or `opencode mcp list`. Unlike Claude Code, OpenCode V2 uses `mcp.servers` and
places the executable and arguments together in the `command` array.

For either client, confirm `upload_report` appears after connecting.
Stdout is reserved for MCP messages; upload progress is not printed.
The integration tests exercise a standard MCP stdio client, not either
application directly.

Configuration references: [Claude Code MCP](https://code.claude.com/docs/en/mcp)
and [OpenCode V2 MCP](https://opencode.ai/v2/docs/mcp-servers).

## Files and arguments

Files must already exist on the **MCP process's host**, accessible to its OS
user. This tool does not transfer files from a laptop to a remote agent host.
Prefer absolute source paths; relative paths resolve against the MCP process's
working directory, which the client chooses. `~` and environment-variable
expressions in arguments are not expanded.

| Argument | Meaning |
| --- | --- |
| `source` | Required HTML file or directory path |
| `title` | Required report title |
| `category` | Required: `benchmarks`, `ci`, `investigations`, or `presentations` |
| `entry_file` | Required for directories: exact relative entry path, e.g. `site/index.html`; omit for a standalone file |
| `access` | `internal` (default) or `public` |
| `tags` | Comma-separated string, default empty |
| `description` | String, default empty |

Directory uploads include every regular file recursively, including dotfiles
and file symlink targets, just as the CLI does. Stage only the intended bundle.
Paths and relative asset references are preserved. Entry paths must match an
included file; do not prefix them with `/`, `./`, or the source directory name.
The existing API enforces metadata and bundle limits described in [CLI.md](CLI.md).
Internal visibility maps to the API's `authenticated` access; Google sign-in,
browser tokens, and AWS credentials do not grant upload eligibility here.

## Complete agent example

1. Stage `/home/me/rendered-report/site/index.html` and its relative assets,
   such as `/home/me/rendered-report/site/assets/style.css`.
2. Present the bundle, entry page, metadata, and visibility to the user and obtain
   explicit upload approval, following the [agent upload policy](CLI.md#agent-upload-approval).
   A request already authorizing these specifics is sufficient.
3. Call `upload_report` with:

   ```json
   {
     "source": "/home/me/rendered-report",
     "entry_file": "site/index.html",
     "title": "Inference benchmark",
     "category": "benchmarks",
     "access": "internal",
     "tags": "llm-d,gpu",
     "description": "Rendered benchmark report with relative assets"
   }
   ```

4. On success, share the `path` from the structured result:

   ```json
   {
     "id": "example-report-id",
     "path": "https://reports.psap.aws.rhperfscale.org/private/benchmarks/example/site/index.html"
   }
   ```

For a standalone HTML report, use the same metadata with
`"source": "/home/me/standalone.html"` and omit `entry_file`.

The tool requests the existing scoped upload plan, PUTs files directly to S3,
and completes publication through the API. It returns only the report ID and
path, never credentials or signed upload URLs. Errors are MCP tool results with
`isError: true`: authentication guidance, entry-path corrections, API status
and metadata/limit guidance, or upload/completion recovery instructions. Raw
remote error bodies are intentionally omitted because they can contain secrets.

There are no automatic retries. If completion or connectivity fails, check the
hub before retrying: a lost response may follow a successful publication, and
a new call creates a new report. Approval is an agent workflow rule, not a
technical enforcement mechanism. Unattended CI authentication and report
lifecycle operations are not supported.

## Tests

```bash
.venv-mcp/bin/python -m unittest discover -s tests -p 'test_*.py'
node --test tests/*.test.js
```

MCP tests launch a real stdio client/server with a temporary credential cache
and local mock API/S3 endpoints. Live uploads require explicit user authorization.

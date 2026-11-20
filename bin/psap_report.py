#!/usr/bin/env python3
"""Upload PSAP report bundles using GitHub OAuth Device Flow."""
import argparse, json, mimetypes, time
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.parse import urlencode
from urllib.error import HTTPError

ROOT = Path(__file__).resolve().parents[1]
CONFIG = json.loads((ROOT / "_generator" / "s3_config.json").read_text())
API = CONFIG["cli_report_api_url"]
CLIENT_ID = CONFIG["github_client_id"]
TOKEN_FILE = Path.home() / ".config" / "psap-report" / "github-oauth.json"

def device_login():
    body = urlencode({"client_id": CLIENT_ID, "scope": "read:org"}).encode()
    response = urlopen(Request("https://github.com/login/device/code", data=body, headers={"Accept": "application/json"}), timeout=30)
    device = json.loads(response.read())
    print(f"Open {device['verification_uri']} and enter code: {device['user_code']}")
    while True:
        time.sleep(device.get("interval", 5))
        poll = urlencode({"client_id": CLIENT_ID, "device_code": device["device_code"], "grant_type": "urn:ietf:params:oauth:grant-type:device_code"}).encode()
        result = json.loads(urlopen(Request("https://github.com/login/oauth/access_token", data=poll, headers={"Accept": "application/json"}), timeout=30).read())
        if result.get("access_token"):
            TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True); TOKEN_FILE.write_text(json.dumps(result)); TOKEN_FILE.chmod(0o600)
            print("GitHub authentication saved."); return result["access_token"]
        if result.get("error") not in ("authorization_pending", "slow_down"): raise SystemExit(result.get("error_description", result.get("error")))

LOGIN_HELP = "Run bin/psap-report --login in a terminal on this host, then retry; confirm openshift-psap organization membership."

class ReportError(Exception):
    """Separate CLI detail from credential-safe MCP diagnostics."""
    def __init__(self, message, safe_message=None):
        super().__init__(message)
        self.safe_message = safe_message or message

def get_token(login=False, *, interactive=True):
    if login or not TOKEN_FILE.exists():
        if not interactive: raise ReportError(LOGIN_HELP)
        return device_login()
    try:
        token = json.loads(TOKEN_FILE.read_text())["access_token"]
        if not isinstance(token, str) or not token: raise ValueError("Empty credential")
        return token
    except (OSError, ValueError, KeyError, TypeError):
        raise ReportError(LOGIN_HELP) from None

def request(url, method="GET", data=None, token=None):
    headers = {"Content-Type": "application/json"} if data is not None else {}
    if token: headers["Authorization"] = f"Bearer {token}"
    body = json.dumps(data).encode() if data is not None else None
    try:
        with urlopen(Request(url, data=body, method=method, headers=headers), timeout=60) as response:
            return json.loads(response.read())
    except HTTPError as error:
        detail = error.read().decode(errors="replace")
        try: detail = json.loads(detail).get("error", detail)
        except (ValueError, AttributeError): pass
        safe = LOGIN_HELP if error.code in (401, 403) else "Check metadata, entry path, bundle limits, and service availability."
        raise ReportError(f"API error ({error.code}): {detail}", f"API error ({error.code}). {safe}") from None

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path, nargs="?", help="HTML file or report directory")
    parser.add_argument("--entry-file", help="HTML entry path relative to directory")
    parser.add_argument("--title"); parser.add_argument("--category", choices=["benchmarks", "ci", "investigations", "presentations"])
    parser.add_argument("--access", choices=["public", "internal"], default="internal")
    parser.add_argument("--tags", default=""); parser.add_argument("--description", default="")
    parser.add_argument("--login", action="store_true", help="Authenticate with GitHub Device Flow")
    args = parser.parse_args()
    try:
        cli_upload(args)
    except ReportError as error:
        raise SystemExit(str(error)) from None

def cli_upload(args):
    token = get_token(args.login)
    if args.login and not args.source: return
    if not args.source or not args.title or not args.category: raise SystemExit("source, --title, and --category are required for upload")
    result = upload(args.source, title=args.title, category=args.category, entry_file=args.entry_file, access=args.access, tags=args.tags, description=args.description, token=token, progress=print)
    print(result["path"])

def upload(source, *, title, category, entry_file=None, access="internal", tags="", description="", token, progress=None):
    if not title or category not in ("benchmarks", "ci", "investigations", "presentations"):
        raise ReportError("A title and supported category are required for upload")
    if access not in ("internal", "public"):
        raise ReportError("Access must be internal or public")
    source = Path(source).resolve()
    if source.is_file():
        if source.suffix.lower() not in (".html", ".htm"): raise ReportError("Single-file uploads must be HTML files")
        entry = source.name
        if entry_file and entry_file.replace("\\", "/") != entry: raise ReportError("--entry-file must match the supplied HTML filename")
        relative = {entry: source}
    elif source.is_dir():
        if not entry_file: raise ReportError("--entry-file is required when uploading a directory")
        root = source; entry = entry_file.replace("\\", "/")
        files = [path for path in root.rglob("*") if path.is_file()]
        relative = {path.relative_to(root).as_posix(): path for path in files}
    else: raise ReportError(f"Source not found: {source}", "Source not found; supply a file or directory on the MCP server host.")
    if entry not in relative: raise ReportError(f"Entry file not found: {entry}", "Entry file not found; use an exact directory-relative path without ./ or ../.")
    payload = {"title": title, "category": category, "access": "authenticated" if access == "internal" else "public", "tags": [tag.strip() for tag in tags.split(",") if tag.strip()], "description": description, "entryFile": entry, "pathMode": "preserve", "files": [{"name": name, "size": path.stat().st_size, "contentType": mimetypes.guess_type(name)[0] or "application/octet-stream"} for name, path in relative.items()]}
    plan = request(f"{API}/reports", "POST", payload, token)
    if plan.get("pathMode") != "preserve": raise ReportError("The report API did not confirm pathMode=preserve; update the report service before uploading")
    planned = [target["name"] for target in plan["uploads"]]
    if len(planned) != len(relative) or set(planned) != set(relative): raise ReportError("Upload plan does not match the source files")
    for target in plan["uploads"]:
        path = relative[target["name"]]
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        try:
            with path.open("rb") as handle:
                urlopen(Request(target["url"], data=handle.read(), method="PUT", headers={"Content-Type": content_type, "Cache-Control": "no-cache"}), timeout=300).read()
        except Exception:
            raise ReportError("File upload failed. Check local file readability and network access; retry with a fresh upload plan.") from None
        if progress: progress(f"Uploaded {target['name']}")
    try:
        result = request(f"{API}/reports/{plan['id']}/complete", "POST", {}, token)
        return {"id": plan["id"], "path": result["report"]["path"]}
    except ReportError as error:
        raise ReportError(str(error), "Completion failed. " + error.safe_message + " Check the hub before retrying to avoid duplicates.") from None
    except Exception:
        raise ReportError("Completion failed. Check service connectivity and the hub before retrying to avoid duplicates.") from None

if __name__ == "__main__": main()

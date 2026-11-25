#!/usr/bin/env python3
"""Upload PSAP report bundles using GitHub OAuth Device Flow."""
import argparse, json, mimetypes, os, shutil, stat, tempfile, time
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
    parser.add_argument("--resume", help="Incomplete upload ID to edit and retry within six hours of creation")
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
    result = upload(args.source, title=args.title, category=args.category, entry_file=args.entry_file, access=args.access, tags=args.tags, description=args.description, token=token, progress=print, resume_id=args.resume)
    print(result["path"])

def resolve_upload_path(path, name):
    try:
        return path.resolve(strict=True)
    except (OSError, RuntimeError):
        raise ReportError(f"Cannot resolve {name!r}: dangling link, symlink loop, or inaccessible path. Remove the link or repair its target before uploading.") from None

def directory_files(root):
    """Validate every link, including links is_file() would silently omit."""
    relative = {}
    def walk_error(error):
        raise ReportError("Cannot enumerate the report directory. Check permissions and keep the staged bundle unchanged.") from None
    for parent, directories, files in os.walk(root, followlinks=False, onerror=walk_error):
        for filename in directories + files:
            path = Path(parent) / filename
            name = path.relative_to(root).as_posix()
            target = resolve_upload_path(path, name)
            if not target.is_relative_to(root):
                raise ReportError(f"Upload path {name!r} resolves outside the upload root. Remove the link or copy the intended file into the report directory.")
            if path.is_symlink() and target.is_dir():
                raise ReportError(f"Directory symlink {name!r} is not supported. Replace it with a real directory containing the intended report files.")
            if target.is_file():
                relative[name] = target
    return relative

def snapshot_files(root, relative, directory):
    """Pin each path component with openat/O_NOFOLLOW, then retain its bytes.

    Resolved paths alone are not safe to reopen: a file or parent directory can
    become a symlink between validation and open. Start at / and open every
    directory component without following links, including the root's ancestors.
    """
    if os.open not in os.supports_dir_fd or not hasattr(os, "O_NOFOLLOW"):
        raise ReportError("Safe uploads require POSIX dir_fd and O_NOFOLLOW support. Run the uploader on Linux or macOS.")
    directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    fd = os.open(root.anchor, directory_flags)
    snapshots = {}
    name = "upload root"
    try:
        for part in root.parts[1:]:
            next_fd = os.open(part, directory_flags, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        for name, target in relative.items():
            parts = target.relative_to(root).parts
            parent_fd = os.dup(fd)
            try:
                for part in parts[:-1]:
                    next_fd = os.open(part, directory_flags, dir_fd=parent_fd)
                    os.close(parent_fd)
                    parent_fd = next_fd
                file_fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent_fd)
                with os.fdopen(file_fd, "rb") as handle:
                    if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
                        raise ReportError(f"Upload path {name!r} is no longer a regular file. Restage the bundle and retry.")
                    snapshot = Path(directory) / str(len(snapshots))
                    with snapshot.open("wb") as output:
                        shutil.copyfileobj(handle, output)
                snapshots[name] = snapshot
            finally:
                os.close(parent_fd)
    except OSError:
        raise ReportError(f"Cannot safely open or snapshot {name!r}: a path changed, is inaccessible, or temporary storage is unavailable. Restage the bundle without changing it during upload, check permissions and temporary disk space, and retry.") from None
    finally:
        os.close(fd)
    return snapshots

def upload(source, *, title, category, entry_file=None, access="internal", tags="", description="", token, progress=None, resume_id=None):
    if not title or category not in ("benchmarks", "ci", "investigations", "presentations"):
        raise ReportError("A title and supported category are required for upload")
    if access not in ("internal", "public"):
        raise ReportError("Access must be internal or public")
    source = resolve_upload_path(Path(source), "source")
    if source.is_file():
        if source.suffix.lower() not in (".html", ".htm"): raise ReportError("Single-file uploads must be HTML files")
        entry = source.name
        if entry_file and entry_file.replace("\\", "/") != entry: raise ReportError("--entry-file must match the supplied HTML filename")
        relative = {entry: source}
        root = source.parent
    elif source.is_dir():
        if not entry_file: raise ReportError("--entry-file is required when uploading a directory")
        root = source; entry = entry_file.replace("\\", "/")
        relative = directory_files(root)
    else: raise ReportError(f"Source not found: {source}", "Source not found; supply a file or directory on the MCP server host.")
    if entry not in relative: raise ReportError(f"Entry file not found: {entry}", "Entry file not found; use an exact directory-relative path without ./ or ../.")
    with tempfile.TemporaryDirectory(prefix="psap-report-") as directory:
        snapshots = snapshot_files(root, relative, directory)
        payload = {"title": title, "category": category, "access": "authenticated" if access == "internal" else "public", "tags": [tag.strip() for tag in tags.split(",") if tag.strip()], "description": description, "entryFile": entry, "pathMode": "preserve", "files": [{"name": name, "size": path.stat().st_size, "contentType": mimetypes.guess_type(name)[0] or "application/octet-stream"} for name, path in snapshots.items()]}
        if resume_id:
            payload["resumeId"] = resume_id
        return publish_snapshot(snapshots, payload, token, progress)

def publish_snapshot(snapshots, payload, token, progress):
    plan = request(f"{API}/reports", "POST", payload, token)
    if progress and plan.get("resumeUntil"):
        progress(f"Submission {plan['id']}: edit and retry with --resume {plan['id']} until {plan['resumeUntil']}")
    if plan.get("pathMode") != "preserve": raise ReportError("The report API did not confirm pathMode=preserve; update the report service before uploading")
    planned = [target["name"] for target in plan["uploads"]]
    if len(planned) != len(snapshots) or set(planned) != set(snapshots): raise ReportError("Upload plan does not match the source files")
    for target in plan["uploads"]:
        content_type = mimetypes.guess_type(target["name"])[0] or "application/octet-stream"
        try:
            urlopen(Request(target["url"], data=snapshots[target["name"]].read_bytes(), method="PUT", headers={"Content-Type": content_type, "Cache-Control": "no-cache"}), timeout=300).read()
        except Exception:
            raise ReportError(f"File upload failed. Check local files and connectivity, then retry with --resume {plan['id']} within the original six-hour window.") from None
        if progress: progress(f"Uploaded {target['name']}")
    try:
        result = request(f"{API}/reports/{plan['id']}/complete", "POST", {}, token)
        return {"id": plan["id"], "path": result["report"]["path"]}
    except ReportError as error:
        raise ReportError(str(error), "Completion failed. " + error.safe_message + " Check the hub before retrying to avoid duplicates.") from None
    except Exception:
        raise ReportError("Completion failed. Check service connectivity and the hub before retrying to avoid duplicates.") from None

if __name__ == "__main__": main()

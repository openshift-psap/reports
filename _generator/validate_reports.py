#!/usr/bin/env python3
"""Validate report source directories before publishing them."""

import json
import re
import sys
from pathlib import Path

REPORTS_DIR = Path("reports")
REQUIRED_FIELDS = {"title", "date", "s3_key", "access"}
VALID_ACCESS = {"public", "authenticated"}
VALID_STATUS = {"final", "draft", "archived"}
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def report_dirs():
    if not REPORTS_DIR.exists():
        return []
    return sorted(path.parent for path in REPORTS_DIR.glob("*/*/meta.json"))


def validate_report(report_dir):
    errors = []
    meta_path = report_dir / "meta.json"
    try:
        meta = json.loads(meta_path.read_text())
    except json.JSONDecodeError as error:
        return None, [f"{meta_path}: invalid JSON ({error.msg})"]

    missing = REQUIRED_FIELDS - meta.keys()
    if missing:
        errors.append(f"{meta_path}: missing {', '.join(sorted(missing))}")

    access = meta.get("access")
    if access not in VALID_ACCESS:
        errors.append(f"{meta_path}: access must be one of {', '.join(sorted(VALID_ACCESS))}")
    if not DATE_RE.match(meta.get("date", "")):
        errors.append(f"{meta_path}: date must use YYYY-MM-DD")
    if "status" in meta and meta["status"] not in VALID_STATUS:
        errors.append(f"{meta_path}: invalid status '{meta['status']}'")

    relative_dir = report_dir.relative_to(REPORTS_DIR)
    expected_key = f"{relative_dir.as_posix()}/index.html"
    if meta.get("s3_key") != expected_key:
        errors.append(f"{meta_path}: s3_key must be '{expected_key}'")
    if not (report_dir / "index.html").is_file():
        errors.append(f"{report_dir}: missing index.html")

    files = [path for path in report_dir.rglob("*") if path.is_file() and path.name != "meta.json"]
    if not files:
        errors.append(f"{report_dir}: contains no publishable files")
    if errors:
        return None, errors
    return meta, []


def validate_all():
    valid = []
    errors = []
    for directory in report_dirs():
        meta, report_errors = validate_report(directory)
        errors.extend(report_errors)
        if meta:
            valid.append((directory, meta))
    return valid, errors


def main():
    reports, errors = validate_all()
    if errors:
        print("Report validation failed:")
        for error in errors:
            print(f"  - {error}")
        return 1
    print(f"Validated {len(reports)} report(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Upload a report folder to S3 for the hybrid report hub."""

import json
import mimetypes
import subprocess
import sys
from pathlib import Path

S3_CONFIG_PATH = Path(__file__).parent / "s3_config.json"

REQUIRED_META_FIELDS = {"title", "storage", "s3_key"}


def load_s3_config():
    if not S3_CONFIG_PATH.exists():
        print(f"Error: {S3_CONFIG_PATH} not found")
        sys.exit(1)
    with open(S3_CONFIG_PATH) as f:
        return json.load(f)


def validate_meta(meta, report_dir):
    missing = REQUIRED_META_FIELDS - set(meta.keys())
    if missing:
        print(f"Error: meta.json in {report_dir} missing fields: {', '.join(sorted(missing))}")
        sys.exit(1)
    if meta.get("storage") != "s3":
        print(f"Error: meta.json storage is '{meta.get('storage')}', expected 's3'")
        sys.exit(1)


def upload_report(report_dir, s3_config):
    report_dir = Path(report_dir)
    meta_path = report_dir / "meta.json"

    if not meta_path.exists():
        print(f"Error: no meta.json in {report_dir}")
        sys.exit(1)

    with open(meta_path) as f:
        meta = json.load(f)

    validate_meta(meta, report_dir)

    bucket = s3_config["bucket"]
    region = s3_config["region"]
    s3_key = meta["s3_key"]
    s3_prefix = str(Path(s3_key).parent) if "/" in s3_key else ""

    files_to_upload = [
        f for f in report_dir.rglob("*")
        if f.is_file() and f.name != "meta.json"
    ]

    if not files_to_upload:
        print(f"Error: no files to upload in {report_dir} (only meta.json found)")
        sys.exit(1)

    print(f"Uploading {len(files_to_upload)} file(s) to s3://{bucket}/{s3_prefix}/")

    for file_path in files_to_upload:
        relative = file_path.relative_to(report_dir)
        if s3_prefix:
            dest_key = f"{s3_prefix}/{relative}"
        else:
            dest_key = str(relative)

        content_type, _ = mimetypes.guess_type(str(file_path))
        if content_type is None:
            content_type = "application/octet-stream"

        cmd = [
            "aws", "s3", "cp", str(file_path),
            f"s3://{bucket}/{dest_key}",
            "--region", region,
            "--content-type", content_type,
        ]

        print(f"  {relative} -> s3://{bucket}/{dest_key} ({content_type})")
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            print(f"  Error: {result.stderr.strip()}")
            sys.exit(1)

    cf_domain = s3_config["cloudfront_domain"]
    print(f"\nUploaded. Report will be available at: https://{cf_domain}/{s3_key}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(f"Usage: {sys.argv[0]} <report-directory>")
        print(f"Example: {sys.argv[0]} reports/benchmarks/2026-08-05_internal-bench/")
        sys.exit(1)

    s3_config = load_s3_config()
    upload_report(sys.argv[1], s3_config)

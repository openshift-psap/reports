#!/usr/bin/env python3
"""Publish validated report source directories to their declared S3 locations."""

import argparse
import json
import mimetypes
import subprocess
import sys
from pathlib import Path

from validate_reports import validate_all

S3_CONFIG_PATH = Path(__file__).parent / "s3_config.json"


def load_config():
    return json.loads(S3_CONFIG_PATH.read_text())


def upload(file_path, destination, region, dry_run):
    content_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
    command = [
        "aws", "s3", "cp", str(file_path), destination,
        "--region", region,
        "--content-type", content_type,
        "--cache-control", "no-cache",
    ]
    print(f"  {file_path} -> {destination}")
    if not dry_run:
        subprocess.run(command, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--paths-file", type=Path, help="Write changed CloudFront paths here")
    args = parser.parse_args()

    reports, errors = validate_all()
    if errors:
        for error in errors:
            print(f"Error: {error}", file=sys.stderr)
        return 1

    config = load_config()
    published_paths = []
    for directory, meta in reports:
        prefix = Path(meta["s3_key"]).parent.as_posix()
        print(f"Publishing {directory} to s3://{config['bucket']}/{prefix}/")
        for file_path in sorted(directory.rglob("*")):
            if not file_path.is_file() or file_path.name == "meta.json":
                continue
            relative = file_path.relative_to(directory).as_posix()
            upload(file_path, f"s3://{config['bucket']}/{prefix}/{relative}", config["region"], args.dry_run)
            published_paths.append(f"/{prefix}/{relative}")

    if args.paths_file:
        args.paths_file.write_text("\n".join(published_paths) + ("\n" if published_paths else ""))
    print(f"Published {len(published_paths)} file(s) from {len(reports)} report(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main())

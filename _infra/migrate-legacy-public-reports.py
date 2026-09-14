#!/usr/bin/env python3
"""One-time migration of legacy Git-published *public* reports into /public/.

The report files are copied S3-to-S3, so this does not download their content.
Metadata is read from the current Git HEAD, allowing the script to run after
the working tree has removed reports/ but before this migration commit is made.
"""

import hashlib
import json
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CONFIG = json.loads((ROOT / "_generator" / "s3_config.json").read_text())


def run(*command):
    print(" ".join(command))
    subprocess.run(command, check=True)


def git_file(path):
    result = subprocess.run(
        ["git", "show", f"HEAD:{path}"], cwd=ROOT, capture_output=True, text=True
    )
    if result.returncode:
        raise RuntimeError(f"Could not read {path} from HEAD: {result.stderr.strip()}")
    return result.stdout


def main():
    folders = subprocess.run(
        ["git", "ls-tree", "-r", "--name-only", "HEAD", "reports"],
        cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout.splitlines()
    meta_files = [item for item in folders if item.endswith("/meta.json")]
    if not meta_files:
        print("No legacy report metadata found in HEAD.")
        return

    migrated_paths = []
    for meta_file in meta_files:
        meta = json.loads(git_file(meta_file))
        if meta.get("access") != "public":
            print(f"Skipping non-public legacy report {meta_file}")
            continue
        report_dir = meta_file.rsplit("/", 1)[0]
        relative = report_dir.removeprefix("reports/")
        category, folder = relative.split("/", 1)
        old_prefix = meta["s3_key"].rsplit("/", 1)[0]
        new_prefix = f"public/{category}/{folder}"
        run("aws", "s3", "cp", f"s3://{CONFIG['bucket']}/{old_prefix}/", f"s3://{CONFIG['bucket']}/{new_prefix}/", "--recursive", "--region", CONFIG["region"])

        identifier = hashlib.sha256(relative.encode()).hexdigest()[:24]
        entry = {
            "id": f"legacy-{identifier}",
            "title": meta.get("title", folder),
            "description": meta.get("description", ""),
            "tags": meta.get("tags", []),
            "date": meta.get("date", ""),
            "author": meta.get("author", ""),
            "status": meta.get("status", "final"),
            "category": category,
            "path": f"https://{CONFIG['cloudfront_domain']}/{new_prefix}/index.html",
            "size": meta.get("size", "—"),
            "authenticated": False,
        }
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as output:
            json.dump(entry, output, indent=2)
            output.write("\n")
            output_path = output.name
        try:
            run("aws", "s3", "cp", output_path, f"s3://{CONFIG['bucket']}/report-meta/public/{entry['id']}.json", "--content-type", "application/json", "--cache-control", "no-store", "--region", CONFIG["region"])
        finally:
            Path(output_path).unlink(missing_ok=True)
        migrated_paths.extend([f"/{new_prefix}/*", f"/report-meta/public/{entry['id']}.json"])

    if migrated_paths:
        run("aws", "cloudfront", "create-invalidation", "--distribution-id", "E3URYTY8ICV8ON", "--paths", *migrated_paths)
    print(f"Migrated {len(migrated_paths) // 2} public legacy report(s).")


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as error:
        sys.exit(error.returncode)

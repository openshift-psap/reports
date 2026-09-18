#!/usr/bin/env python3
"""Rebuild PSAP Report Hub S3 indexes from authoritative report metadata."""

import argparse
import json
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

import boto3


CONFIG = json.loads((Path(__file__).parents[1] / "_generator" / "s3_config.json").read_text())
BUCKET = CONFIG["bucket"]
REGION = CONFIG["region"]
SCHEMA_VERSION = 1


def sort_key(entry):
    return entry.get("submittedAt") or entry.get("date") or ""


def normalized(entries):
    counts = Counter(entry.get("reportId") or entry["id"] for entry in entries)
    reports = []
    for entry in entries:
        report = dict(entry)
        report["reportId"] = report.get("reportId") or report["id"]
        report["version"] = report.get("version") or 1
        report["versionCount"] = counts[report["reportId"]]
        reports.append(report)
    reports.sort(key=sort_key, reverse=True)
    return reports


def load_entries(s3, access):
    paginator = s3.get_paginator("list_objects_v2")
    entries = []
    for page in paginator.paginate(Bucket=BUCKET, Prefix=f"report-meta/{access}/"):
        for item in page.get("Contents", []):
            if not item["Key"].endswith(".json"):
                continue
            try:
                entries.append(json.loads(s3.get_object(Bucket=BUCKET, Key=item["Key"])["Body"].read()))
            except Exception as error:
                print(f"Skipping unreadable metadata {item['Key']}: {error}")
    return entries


def put_json(s3, key, value, dry_run):
    if dry_run:
        print(f"Would write s3://{BUCKET}/{key}")
        return
    s3.put_object(Bucket=BUCKET, Key=key, Body=json.dumps(value, indent=2), ContentType="application/json", CacheControl="no-store")


def rebuild_access(s3, access, dry_run):
    reports = normalized(load_entries(s3, access))
    generated_at = datetime.now(timezone.utc).isoformat()
    current = [report for report in reports if report.get("isLatest") is not False]
    put_json(s3, f"report-index/{access}-current.json", {"schemaVersion": SCHEMA_VERSION, "generatedAt": generated_at, "reports": current}, dry_run)

    histories = defaultdict(list)
    for report in reports:
        histories[report["reportId"]].append(report)
    for report_id, history in histories.items():
        put_json(s3, f"report-index/history/{access}/{report_id}.json", {"schemaVersion": SCHEMA_VERSION, "generatedAt": generated_at, "reportId": report_id, "reports": history}, dry_run)

    prefix = f"report-index/history/{access}/"
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=BUCKET, Prefix=prefix):
        for item in page.get("Contents", []):
            report_id = item["Key"][len(prefix):].removesuffix(".json")
            if report_id not in histories:
                if dry_run:
                    print(f"Would delete stale s3://{BUCKET}/{item['Key']}")
                else:
                    s3.delete_object(Bucket=BUCKET, Key=item["Key"])

    print(f"{access}: indexed {len(current)} current reports and {len(histories)} histories")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--access", choices=["public", "authenticated", "all"], default="all")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    s3 = boto3.client("s3", region_name=REGION)
    for access in (["public", "authenticated"] if args.access == "all" else [args.access]):
        rebuild_access(s3, access, args.dry_run)


if __name__ == "__main__":
    main()

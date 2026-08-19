#!/usr/bin/env python3
"""Manage the GitHub username allowlist for the PSAP report hub."""

import json
import subprocess
import sys
from pathlib import Path

S3_CONFIG_PATH = Path(__file__).parent / "s3_config.json"


def load_s3_config():
    with open(S3_CONFIG_PATH) as f:
        return json.load(f)


def s3_path(config):
    return f"s3://{config['bucket']}/allowlist.json"


def download_allowlist(config):
    result = subprocess.run(
        ["aws", "s3", "cp", s3_path(config), "-", "--region", config["region"]],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        return {"users": []}
    return json.loads(result.stdout)


def upload_allowlist(config, data):
    proc = subprocess.run(
        ["aws", "s3", "cp", "-", s3_path(config),
         "--region", config["region"], "--content-type", "application/json"],
        input=json.dumps(data, indent=2),
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        print(f"Error uploading: {proc.stderr.strip()}")
        sys.exit(1)


def cmd_add(args):
    if not args:
        print("Usage: allowlist.py add <github-username> [username2 ...]")
        sys.exit(1)
    config = load_s3_config()
    data = download_allowlist(config)
    added = []
    for username in args:
        if username not in data["users"]:
            data["users"].append(username)
            added.append(username)
    data["users"].sort()
    upload_allowlist(config, data)
    if added:
        print(f"Added: {', '.join(added)}")
    else:
        print("All usernames already in allowlist.")


def cmd_remove(args):
    if not args:
        print("Usage: allowlist.py remove <github-username> [username2 ...]")
        sys.exit(1)
    config = load_s3_config()
    data = download_allowlist(config)
    removed = []
    for username in args:
        if username in data["users"]:
            data["users"].remove(username)
            removed.append(username)
    upload_allowlist(config, data)
    if removed:
        print(f"Removed: {', '.join(removed)}")
    else:
        print("None of those usernames were in the allowlist.")


def cmd_list(_args):
    config = load_s3_config()
    data = download_allowlist(config)
    if not data["users"]:
        print("Allowlist is empty.")
        return
    print(f"{len(data['users'])} user(s):")
    for u in data["users"]:
        print(f"  {u}")


COMMANDS = {"add": cmd_add, "remove": cmd_remove, "list": cmd_list}

if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        print(f"Usage: {sys.argv[0]} <{' | '.join(COMMANDS.keys())}> [args...]")
        print(f"\nExamples:")
        print(f"  {sys.argv[0]} add some-github-user")
        print(f"  {sys.argv[0]} remove some-github-user")
        print(f"  {sys.argv[0]} list")
        sys.exit(1)
    COMMANDS[sys.argv[1]](sys.argv[2:])

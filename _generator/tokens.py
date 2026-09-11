#!/usr/bin/env python3
"""Manage access tokens for the PSAP report hub."""

import json
import hashlib
import secrets
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

S3_CONFIG_PATH = Path(__file__).parent / "s3_config.json"
TOKEN_PREFIX = "psap_rht_"
TOKEN_LENGTH = 40


def token_digest(token):
    return f"sha256:{hashlib.sha256(token.encode()).hexdigest()}"


def token_prefix(token, info):
    return info.get("prefix", token[:20])


def add_token(data, token, group, note):
    data["tokens"][token_digest(token)] = {
        "prefix": token[:20],
        "created": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "group": group,
        "note": note,
        "active": True,
    }


def load_s3_config():
    with open(S3_CONFIG_PATH) as f:
        return json.load(f)


def s3_path(config):
    return f"s3://{config['bucket']}/tokens.json"


def download_tokens(config):
    result = subprocess.run(
        ["aws", "s3", "cp", s3_path(config), "-", "--region", config["region"]],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        return {"tokens": {}}
    return json.loads(result.stdout)


def upload_tokens(config, data):
    proc = subprocess.run(
        ["aws", "s3", "cp", "-", s3_path(config),
         "--region", config["region"], "--content-type", "application/json"],
        input=json.dumps(data, indent=2),
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        print(f"Error uploading: {proc.stderr.strip()}")
        sys.exit(1)


def parse_generate_args(args):
    group = "everyone"
    note_parts = []
    i = 0
    while i < len(args):
        if args[i] == "--group" and i + 1 < len(args):
            group = args[i + 1]
            i += 2
        else:
            note_parts.append(args[i])
            i += 1
    note = " ".join(note_parts) if note_parts else f"{group} access"
    return group, note


def cmd_generate(args):
    group, note = parse_generate_args(args)
    config = load_s3_config()
    data = download_tokens(config)

    token = TOKEN_PREFIX + secrets.token_urlsafe(TOKEN_LENGTH)
    add_token(data, token, group, note)

    upload_tokens(config, data)
    cf = config["cloudfront_domain"]
    print(f"Token generated (group: {group}):\n  {token}\n")
    print(f"Share with {group} users.")
    print(f"They enter it at: https://{cf}/")


def cmd_list(_args):
    config = load_s3_config()
    data = download_tokens(config)

    if not data["tokens"]:
        print("No tokens configured.")
        return

    for token, info in data["tokens"].items():
        status = "ACTIVE" if info.get("active", True) else "REVOKED"
        group = info.get("group", "everyone")
        short = token_prefix(token, info) + "..."
        print(f"  [{status}] {short}  group={group}  created={info.get('created','')}  note={info.get('note','')}")


def cmd_revoke(args):
    if not args:
        print("Usage: tokens.py revoke <token-or-prefix>")
        sys.exit(1)
    prefix = args[0]
    config = load_s3_config()
    data = download_tokens(config)

    matched = [t for t, info in data["tokens"].items()
               if token_prefix(t, info).startswith(prefix)]
    if not matched:
        print(f"No token matching '{prefix}'")
        sys.exit(1)
    for t in matched:
        data["tokens"][t]["active"] = False
        print(f"  Revoked: {token_prefix(t, data['tokens'][t])}...")

    upload_tokens(config, data)
    print("Done.")


def cmd_rotate(args):
    group, note = parse_generate_args(args)
    config = load_s3_config()
    data = download_tokens(config)

    for t in data["tokens"]:
        info = data["tokens"][t]
        if info.get("active", True) and info.get("group", "everyone") == group:
            info["active"] = False
            print(f"  Revoked old ({group}): {token_prefix(t, info)}...")

    token = TOKEN_PREFIX + secrets.token_urlsafe(TOKEN_LENGTH)
    add_token(data, token, group, note)
    upload_tokens(config, data)
    cf = config["cloudfront_domain"]
    print(f"\nNew token (group: {group}):\n  {token}\n")
    print(f"Distribute to {group} users. Old {group} tokens revoked.")


def cmd_migrate_hashes(args):
    """Replace legacy raw-token keys with irreversible SHA-256 digests."""
    dry_run = "--dry-run" in args
    config = load_s3_config()
    data = download_tokens(config)
    migrated = 0
    hashed = {}

    for token, info in data["tokens"].items():
        if token.startswith("sha256:"):
            hashed[token] = info
            continue
        entry = dict(info)
        entry.setdefault("prefix", token[:20])
        hashed[token_digest(token)] = entry
        migrated += 1

    if migrated == 0:
        print("All token records are already hashed.")
        return
    if dry_run:
        print(f"Would replace {migrated} raw token record(s) with SHA-256 digests.")
        return

    data["tokens"] = hashed
    upload_tokens(config, data)
    print(f"Replaced {migrated} raw token record(s) with SHA-256 digests.")


COMMANDS = {
    "generate": cmd_generate,
    "list": cmd_list,
    "revoke": cmd_revoke,
    "rotate": cmd_rotate,
    "migrate-hashes": cmd_migrate_hashes,
}

if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        print(f"Usage: {sys.argv[0]} <{' | '.join(COMMANDS.keys())}> [args...]")
        print(f"\nExamples:")
        print(f"  {sys.argv[0]} generate --group engineering Internal engineering access")
        print(f"  {sys.argv[0]} generate --group sales Sales team access")
        print(f"  {sys.argv[0]} generate --group everyone Red Hat wide access")
        print(f"  {sys.argv[0]} list")
        print(f"  {sys.argv[0]} revoke psap_rht_abc...")
        print(f"  {sys.argv[0]} rotate --group sales New sales token")
        print(f"  {sys.argv[0]} migrate-hashes --dry-run")
        sys.exit(1)
    COMMANDS[sys.argv[1]](sys.argv[2:])

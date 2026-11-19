#!/usr/bin/env python3
"""Render auth Lambda config placeholders as JSON-encoded JavaScript strings.

The deployment script passes configuration through the environment. Values are
embedded with json.dumps, so quotes, backslashes, ampersands, pipes, newlines,
and other special characters cannot corrupt the JavaScript source or shell
substitution. Placeholders are replaced in a single pass over the original
source, so a value that looks like a placeholder is never substituted again.
Values are never printed.
"""

import json
import os
import re
import sys

# Placeholder in _infra/lambda-auth/index.js -> environment variable.
PLACEHOLDERS = {
    "__GITHUB_CLIENT_ID__": "GITHUB_CLIENT_ID",
    "__GITHUB_CLIENT_SECRET__": "GITHUB_CLIENT_SECRET",
    "__COOKIE_SECRET__": "COOKIE_SECRET",
    "__S3_BUCKET__": "S3_BUCKET",
    "__S3_REGION__": "S3_REGION",
    "__CANONICAL_DOMAIN__": "CANONICAL_DOMAIN",
    "__GOOGLE_CLIENT_ID__": "GOOGLE_CLIENT_ID",
    "__GOOGLE_CLIENT_SECRET__": "GOOGLE_CLIENT_SECRET",
}
REQUIRED = {
    "GITHUB_CLIENT_ID",
    "GITHUB_CLIENT_SECRET",
    "COOKIE_SECRET",
    "S3_BUCKET",
    "S3_REGION",
    "CANONICAL_DOMAIN",
}


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: render-auth-config.py <lambda-index.js>")

    path = sys.argv[1]
    with open(path, encoding="utf-8") as handle:
        source = handle.read()

    for variable in REQUIRED:
        if not os.environ.get(variable):
            raise SystemExit(f"{variable} is required")

    tokens = {f"'{placeholder}'": variable for placeholder, variable in PLACEHOLDERS.items()}
    for token in tokens:
        if token not in source:
            raise SystemExit(f"missing placeholder {token[1:-1]}")

    values = {variable: os.environ.get(variable, "") for variable in PLACEHOLDERS.values()}
    pattern = re.compile("|".join(re.escape(token) for token in sorted(tokens, key=len, reverse=True)))
    source = pattern.sub(lambda match: json.dumps(values[tokens[match.group(0)]]), source)

    with open(path, "w", encoding="utf-8") as handle:
        handle.write(source)

    print(f"Rendered {len(PLACEHOLDERS)} auth configuration placeholders.")


if __name__ == "__main__":
    main()

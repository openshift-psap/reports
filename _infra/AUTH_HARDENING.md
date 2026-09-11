# Auth hardening deployment order

The auth Lambda reads `tokens.json` and `allowlist.json` from the private S3
bucket using its Lambda IAM role. It does not make anonymous S3 HTTP requests.

Token records use SHA-256 digest keys. Raw access tokens are returned only when
created and are not stored in S3.

Before deploying the auth Lambda version that requires hashed token keys, run:

```bash
python3 _generator/tokens.py migrate-hashes --dry-run
python3 _generator/tokens.py migrate-hashes
```

The migration preserves every issued token: users continue entering the same
value, while S3 retains only its digest and a short display prefix. Run it with
AWS credentials that can read and write `s3://psap-reports/tokens.json`.

Then deploy the auth Lambda. Its deployment script installs its pinned S3 SDK
dependency and attaches a role policy limited to these private objects:

- `s3://psap-reports/tokens.json`
- `s3://psap-reports/allowlist.json`

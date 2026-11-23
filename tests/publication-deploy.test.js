'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('deployment preserves existing upload mode and fails closed on lookup errors', () => {
  const source = fs.readFileSync('_infra/deploy-token-admin.sh', 'utf8');
  const block = source.slice(source.indexOf('if [[ -n "${REPORT_STAGING_BUCKET:-}" ]]'), source.indexOf('if aws lambda get-function --'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-mode-'));
  try {
    for (const [remote, supplied, expected] of [['v2', null, 'v2'], ['paused', null, 'paused'], ['None', null, 'paused'],
      ['missing', null, 'paused'], ['denied', null, null], ['v2', 'paused', 'paused'], ['paused', 'v2', 'v2'], ['v2', '', null]]) {
      const script = `set -eu\n${supplied === null ? 'unset REPORT_UPLOAD_MODE' : `REPORT_UPLOAD_MODE='${supplied}'`}\n` +
        `aws() { case "$REMOTE" in missing) echo ResourceNotFoundException >&2; return 1;; denied) echo AccessDenied >&2; return 1;; *) echo "$REMOTE";; esac; }\n` +
        block + '\nprintf "%s" "$REPORT_UPLOAD_MODE"';
      const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, WORK_DIR: dir,
        REMOTE: remote, REPORT_STAGING_BUCKET: 'staging', FUNCTION_NAME: 'test', REGION: 'test', S3_BUCKET: 'test', S3_REGION: 'test', COOKIE_SECRET: 'test', CF_DOMAIN: 'test' } });
      if (expected === null) assert.notEqual(result.status, 0);
      else { assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, expected); }
    }
  } finally { fs.rmSync(dir, { recursive: true }); }
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const ENV_TO_CONFIG = {
  GITHUB_CLIENT_ID: 'clientId',
  GITHUB_CLIENT_SECRET: 'clientSecret',
  COOKIE_SECRET: 'cookieSecret',
  S3_BUCKET: 's3Bucket',
  S3_REGION: 's3Region',
  CANONICAL_DOMAIN: 'canonicalDomain',
  GOOGLE_CLIENT_ID: 'googleClientId',
  GOOGLE_CLIENT_SECRET: 'googleClientSecret',
};

function renderWith(values) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'psap-auth-config-'));
  const rendered = path.join(directory, 'index.js');
  fs.copyFileSync('_infra/lambda-auth/index.js', rendered);
  const stdout = execFileSync('python3', ['_infra/render-auth-config.py', rendered], {
    env: { ...process.env, ...values },
    stdio: 'pipe',
  }).toString();
  return { rendered, source: fs.readFileSync(rendered, 'utf8'), stdout };
}

test('auth package rendering uses JSON-safe JavaScript literals for every config value', () => {
  const values = {
    GITHUB_CLIENT_ID: 'github-id-"quote\'&|$',
    GITHUB_CLIENT_SECRET: 'github-secret-\\backslash-"quote\'&|$`tick\nnewline\ttab',
    COOKIE_SECRET: 'cookie-secret-\\path\\"quote\'&|$',
    S3_BUCKET: 'bucket-&|"quoted"',
    S3_REGION: 'us-east-1',
    CANONICAL_DOMAIN: 'reports.example',
    GOOGLE_CLIENT_ID: 'google-id-<>&|"\'',
    GOOGLE_CLIENT_SECRET: 'google-secret-\\"\'&|$`\nline',
  };
  const { rendered, source, stdout } = renderWith(values);

  assert.equal(stdout, 'Rendered 8 auth configuration placeholders.\n');
  assert.doesNotMatch(source, /__[A-Z_]+__/, 'no template placeholder may remain');
  execFileSync(process.execPath, ['--check', rendered], { stdio: 'pipe' });

  const context = {
    exports: {},
    Buffer,
    URL,
    console: { log() {} },
    require(name) {
      if (name === 'google-auth-library') return { OAuth2Client: class {} };
      if (name === '@aws-sdk/client-s3') {
        return {
          S3Client: class { async send() { return {}; } },
          GetObjectCommand: class {},
        };
      }
      return require(name);
    },
  };
  vm.runInNewContext(`${source}\nglobalThis.__RENDERED_CONFIG = CONFIG;`, context);
  for (const [variable, configKey] of Object.entries(ENV_TO_CONFIG)) {
    assert.equal(context.__RENDERED_CONFIG[configKey], values[variable], configKey);
  }
});

test('auth package rendering rejects missing required values without printing supplied secrets', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'psap-auth-config-'));
  const rendered = path.join(directory, 'index.js');
  fs.copyFileSync('_infra/lambda-auth/index.js', rendered);
  const values = {
    GITHUB_CLIENT_ID: 'github-id',
    GITHUB_CLIENT_SECRET: 'do-not-print-this-secret',
    COOKIE_SECRET: 'cookie-secret',
    S3_BUCKET: 'bucket',
    S3_REGION: 'us-east-1',
    CANONICAL_DOMAIN: '',
    GOOGLE_CLIENT_ID: '',
    GOOGLE_CLIENT_SECRET: '',
  };
  assert.throws(
    () => execFileSync('python3', ['_infra/render-auth-config.py', rendered], {
      env: { ...process.env, ...values },
      stdio: 'pipe',
    }),
    error => {
      const output = `${error.stdout || ''}${error.stderr || ''}`;
      assert.match(output, /CANONICAL_DOMAIN is required/);
      assert.doesNotMatch(output, /do-not-print-this-secret/);
      return true;
    },
  );
});

function evaluateConfig(source) {
  const context = {
    exports: {},
    Buffer,
    URL,
    console: { log() {} },
    require(name) {
      if (name === 'google-auth-library') return { OAuth2Client: class {} };
      if (name === '@aws-sdk/client-s3') {
        return {
          S3Client: class { async send() { return {}; } },
          GetObjectCommand: class {},
        };
      }
      return require(name);
    },
  };
  vm.runInNewContext(`${source}\nglobalThis.__RENDERED_CONFIG = CONFIG;`, context);
  return context.__RENDERED_CONFIG;
}

test('rendered values that resemble placeholders are substituted exactly once', () => {
  const values = {
    GITHUB_CLIENT_ID: "github-id-'__GITHUB_CLIENT_SECRET__'",
    GITHUB_CLIENT_SECRET: 'plain-secret',
    COOKIE_SECRET: '__S3_BUCKET__',
    S3_BUCKET: 'bucket-name',
    S3_REGION: 'us-east-1',
    CANONICAL_DOMAIN: 'reports.example',
    GOOGLE_CLIENT_ID: 'google-id',
    GOOGLE_CLIENT_SECRET: 'google-secret',
  };
  const { rendered, source, stdout } = renderWith(values);

  assert.equal(stdout, 'Rendered 8 auth configuration placeholders.\n');
  execFileSync(process.execPath, ['--check', rendered], { stdio: 'pipe' });

  const config = evaluateConfig(source);
  for (const [variable, configKey] of Object.entries(ENV_TO_CONFIG)) {
    assert.equal(config[configKey], values[variable], configKey);
  }
});

test('a missing placeholder is reported without modifying the source', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'psap-auth-config-'));
  const rendered = path.join(directory, 'index.js');
  const original = fs.readFileSync('_infra/lambda-auth/index.js', 'utf8').replace("'__S3_REGION__'", '"us-east-1"');
  fs.writeFileSync(rendered, original);
  const values = {
    GITHUB_CLIENT_ID: 'github-id',
    GITHUB_CLIENT_SECRET: 'github-secret',
    COOKIE_SECRET: 'cookie-secret',
    S3_BUCKET: 'bucket',
    S3_REGION: 'us-east-1',
    CANONICAL_DOMAIN: 'reports.example',
    GOOGLE_CLIENT_ID: 'google-id',
    GOOGLE_CLIENT_SECRET: 'google-secret',
  };

  assert.throws(
    () => execFileSync('python3', ['_infra/render-auth-config.py', rendered], {
      env: { ...process.env, ...values },
      stdio: 'pipe',
    }),
    error => {
      const output = `${error.stdout || ''}${error.stderr || ''}`;
      assert.match(output, /missing placeholder __S3_REGION__/);
      return true;
    },
  );
  assert.equal(fs.readFileSync(rendered, 'utf8'), original);
});

'use strict';

// Run with node --test tests/*.test.js; no AWS credentials or packages needed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const source = fs.readFileSync('_infra/lambda-token-admin/index.js', 'utf8');
const id = '12345678-1234-1234-1234-123456789abc';

function setup(overrides = {}) {
  const original = {
    id, reportId: id, title: 'Old title', description: 'Old description', category: 'ci',
    tags: ['gpu'], author: 'Owner', version: 2, isLatest: true, status: 'final',
    date: '2026-10-01', submittedAt: '2026-10-01T12:00:00Z',
    path: 'https://reports.example/private/ci/original/report.html', authenticated: true,
    ...overrides,
  };
  const calls = [];
  const objects = new Map([[`report-meta/authenticated/${id}.json`, original]]);
  const commands = {};
  for (const name of ['GetObjectCommand', 'PutObjectCommand', 'DeleteObjectCommand', 'HeadObjectCommand', 'ListObjectsV2Command', 'DeleteObjectsCommand']) {
    commands[name] = class { constructor(input) { this.name = name; this.input = input; } };
  }
  commands.S3Client = class {
    async send(command) {
      calls.push(command);
      const { Key, Body } = command.input;
      if (command.name === 'GetObjectCommand') {
        if (!objects.has(Key)) throw new Error('NoSuchKey');
        return { Body: { transformToString: async () => JSON.stringify(objects.get(Key)) } };
      }
      if (command.name === 'PutObjectCommand') objects.set(Key, JSON.parse(Body));
      return {};
    }
  };
  const context = {
    exports: {}, process: { env: { COOKIE_SECRET: 'test-secret', CLOUDFRONT_DOMAIN: 'reports.example' } }, console,
    require(name) {
      if (name === '@aws-sdk/client-s3') return commands;
      if (name === '@aws-sdk/s3-request-presigner') return { getSignedUrl: async () => 'https://upload.example/' };
      return require(name);
    },
  };
  vm.runInNewContext(source, context);
  async function request(body, { handle = 'owner', method = 'PATCH', access = 'authenticated', reportId = id } = {}) {
    const value = `authenticated:github:${Date.now()}:${handle}`;
    const signature = crypto.createHmac('sha256', 'test-secret').update(value).digest('base64url');
    const result = await context.exports.handler({
      httpMethod: method, path: '/reports', headers: { cookie: `psap_auth=${value}.${signature}` },
      queryStringParameters: { access, id: reportId }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { ...result, data: result.body ? JSON.parse(result.body) : null };
  }
  return { request, original, calls, objects };
}

const metadata = { action: 'metadata', title: 'New title', category: 'benchmarks', description: 'Updated', tags: ['rhoai', 'gpu'] };

test('metadata edits change only info; no file operations or new revision', async () => {
  const { request, original, calls } = setup();
  const result = await request(metadata);
  assert.equal(result.statusCode, 200);
  const { action, ...info } = metadata;
  const expected = { ...original, ...info, updatedAt: result.data.report.updatedAt };
  assert.deepEqual(result.data.report, expected);
  assert.ok(Date.parse(result.data.report.updatedAt));
  assert.deepEqual(calls.map(call => call.name), ['GetObjectCommand', 'PutObjectCommand']);
  assert.equal(calls[1].input.Key, `report-meta/authenticated/${id}.json`);
});

test('external report info edits preserve the original link', async () => {
  const { request } = setup({ externalUrl: 'https://external.example/report', path: 'https://external.example/report' });
  const result = await request(metadata);
  assert.equal(result.statusCode, 200);
  assert.equal(result.data.report.externalUrl, 'https://external.example/report');
  assert.equal(result.data.report.path, 'https://external.example/report');
});

test('public metadata uses the public metadata key', async () => {
  const { request, objects, original, calls } = setup({ authenticated: false });
  objects.set(`report-meta/public/${id}.json`, original);
  assert.equal((await request(metadata, { access: 'public' })).statusCode, 200);
  assert.equal(calls[1].input.Key, `report-meta/public/${id}.json`);
});

test('ownership, identity, current revision, and missing-report checks', async () => {
  assert.equal((await setup().request(metadata, { handle: 'someone-else' })).statusCode, 403);
  assert.equal((await setup().request(metadata, { handle: '' })).statusCode, 403);
  assert.equal((await setup({ isLatest: false }).request(metadata)).statusCode, 409);
  assert.equal((await setup().request(metadata, { reportId: 'aaaaaaaa' })).statusCode, 404);
});

test('invalid and protected fields cannot be written', async () => {
  for (const invalid of [
    { title: ' ' }, { category: 'unknown' }, { tags: 'rhoai' }, { tags: [123] },
    { tags: Array(21).fill('tag') }, { access: 'public' }, { path: 'https://evil.example' },
    { author: 'other' }, { version: 99 }, { files: [] }, { externalUrl: 'https://other.example' },
    { action: 'unknown' },
  ]) {
    const { request, calls } = setup();
    assert.equal((await request({ ...metadata, ...invalid })).statusCode, 400);
    assert.equal(calls.filter(call => call.name === 'PutObjectCommand').length, 0);
  }
});

test('existing archive requests remain compatible and preserve files', async () => {
  const { request, calls } = setup();
  const result = await request();
  assert.equal(result.statusCode, 200);
  assert.equal(result.data.report.status, 'archived');
  assert.ok(result.data.report.archivedAt);
  assert.deepEqual(calls.map(call => call.name), ['GetObjectCommand', 'PutObjectCommand']);
});

test('replacement upload still creates a new pending content revision', async () => {
  const { request, objects } = setup();
  const result = await request({ ...metadata, access: 'authenticated', parentId: id, files: [{ name: 'new.html', size: 12 }] }, { method: 'POST' });
  assert.equal(result.statusCode, 201);
  assert.equal(result.data.uploads.length, 1);
  const pending = objects.get(`report-submissions/${result.data.id}.json`);
  assert.equal(pending.version, 3);
  assert.equal(pending.parentId, id);
  assert.equal(pending.reportId, id);
});

test('CORS preflight permits metadata PATCH', async () => {
  const result = await setup().request(undefined, { method: 'OPTIONS' });
  assert.equal(result.statusCode, 204);
  assert.match(result.headers['Access-Control-Allow-Methods'], /PATCH/);
});

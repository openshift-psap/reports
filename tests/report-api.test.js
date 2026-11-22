'use strict';

// Run with node --test tests/*.test.js; no AWS credentials or packages needed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const source = fs.readFileSync('_infra/lambda-token-admin/index.js', 'utf8');
const id = '12345678-1234-1234-1234-123456789abc';

function setup(overrides = {}, { reportId = id, listings = {}, onSend = () => undefined } = {}) {
  const original = {
    id: reportId, reportId, title: 'Old title', description: 'Old description', category: 'ci',
    tags: ['gpu'], author: 'Owner', version: 2, isLatest: true, status: 'final',
    date: '2026-10-01', submittedAt: '2026-10-01T12:00:00Z',
    path: 'https://reports.example/private/ci/original/report.html', authenticated: true,
    ...overrides,
  };
  const calls = [];
  const objects = new Map([[`report-meta/authenticated/${reportId}.json`, original]]);
  for (const keys of Object.values(listings)) for (const key of keys) objects.set(key, 'file');
  const commands = {};
  for (const name of ['GetObjectCommand', 'PutObjectCommand', 'DeleteObjectCommand', 'HeadObjectCommand', 'ListObjectsV2Command', 'DeleteObjectsCommand']) {
    commands[name] = class { constructor(input) { this.name = name; this.input = input; } };
  }
  commands.S3Client = class {
    async send(command) {
      calls.push(command);
      const injected = await onSend(command, objects);
      if (injected !== undefined) return injected;
      const { Key, Body } = command.input;
      if (command.name === 'GetObjectCommand') {
        if (!objects.has(Key)) throw new Error('NoSuchKey');
        return { Body: { transformToString: async () => JSON.stringify(objects.get(Key)) } };
      }
      if (command.name === 'PutObjectCommand') objects.set(Key, JSON.parse(Body));
      if (command.name === 'DeleteObjectCommand') objects.delete(Key);
      if (command.name === 'DeleteObjectsCommand') (command.input.Delete.Objects || []).forEach(item => objects.delete(item.Key));
      if (command.name === 'ListObjectsV2Command') {
        const { Prefix, ContinuationToken, MaxKeys = 1000 } = command.input;
        const keys = [...objects.keys()].filter(key => key.startsWith(Prefix) && (!ContinuationToken || key > ContinuationToken)).sort();
        const page = keys.slice(0, MaxKeys);
        return { Contents: page.map(Key => ({ Key })), IsTruncated: keys.length > MaxKeys,
          ...(keys.length > MaxKeys ? { NextContinuationToken: page[page.length - 1] } : {}) };
      }
      return {};
    }
  };
  const context = {
    exports: {}, process: { env: { COOKIE_SECRET: 'test-secret', CLOUDFRONT_DOMAIN: 'reports.example' } }, console, URL,
    require(name) {
      if (name === '@aws-sdk/client-s3') return commands;
      if (name === '@aws-sdk/s3-request-presigner') return { getSignedUrl: async () => 'https://upload.example/' };
      return require(name);
    },
  };
  vm.runInNewContext(source, context);
  async function request(body, { handle = 'owner', method = 'PATCH', access = 'authenticated', reportId: requestedId = reportId } = {}) {
    const value = `authenticated:github:${Date.now()}:${handle}`;
    const signature = crypto.createHmac('sha256', 'test-secret').update(value).digest('base64url');
    const result = await context.exports.handler({
      httpMethod: method, path: '/reports', headers: { cookie: `psap_auth=${value}.${signature}` },
      queryStringParameters: { access, id: requestedId }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { ...result, data: result.body ? JSON.parse(result.body) : null };
  }
  async function upload(body, { handle = 'owner' } = {}) {
    const value = `authenticated:github:${Date.now()}:${handle}`;
    const signature = crypto.createHmac('sha256', 'test-secret').update(value).digest('base64url');
    const result = await context.exports.handler({
      httpMethod: 'POST', path: '/reports', headers: { cookie: `psap_auth=${value}.${signature}` },
      body: JSON.stringify(body),
    });
    const pendingCall = calls.filter(call => call.name === 'PutObjectCommand' && call.input.Key.startsWith('report-submissions/')).pop();
    return { ...result, data: result.body ? JSON.parse(result.body) : null, pending: pendingCall ? JSON.parse(pendingCall.input.Body) : null };
  }
  async function complete(uploadId, { handle = 'owner' } = {}) {
    const value = `authenticated:github:${Date.now()}:${handle}`;
    const signature = crypto.createHmac('sha256', 'test-secret').update(value).digest('base64url');
    const result = await context.exports.handler({
      httpMethod: 'POST', path: `/reports/${uploadId}/complete`, headers: { cookie: `psap_auth=${value}.${signature}` },
      body: '{}',
    });
    return { ...result, data: result.body ? JSON.parse(result.body) : null };
  }
  return { request, upload, complete, original, calls, objects };
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

const bundle = { title: 'Nested report', category: 'ci', access: 'authenticated' };

function fileList(...names) {
  return names.map((name, index) => ({ name, size: 10 + index, contentType: 'application/octet-stream' }));
}

test('preserve mode keeps a nested entry file and its assets under the source root', async () => {
  const { upload } = setup();
  const result = await upload({
    ...bundle, pathMode: 'preserve', entryFile: 'site/index.html',
    files: fileList('site/index.html', 'site/assets/app.js', 'site/assets/app.css'),
  });
  assert.equal(result.statusCode, 201);
  assert.equal(result.data.pathMode, 'preserve');
  assert.deepEqual(result.data.uploads.map(item => item.name), ['site/index.html', 'site/assets/app.js', 'site/assets/app.css']);
  assert.deepEqual(result.pending.files.map(item => item.name), ['site/index.html', 'site/assets/app.js', 'site/assets/app.css']);
  assert.equal(result.pending.entryFile, 'site/index.html');
  assert.equal(result.pending.pathMode, 'preserve');
});

test('completion checks and links the preserved nested entry path', async () => {
  const { upload, complete, calls } = setup();
  const plan = await upload({
    ...bundle, pathMode: 'preserve', entryFile: 'site/index.html',
    files: fileList('site/index.html', 'site/assets/app.js'),
  });
  assert.equal(plan.statusCode, 201);
  const result = await complete(plan.data.id);
  assert.equal(result.statusCode, 201);
  assert.equal(result.data.report.path, `https://reports.example/${plan.pending.baseKey}/site/index.html`);
  const head = calls.find(call => call.name === 'HeadObjectCommand');
  assert.equal(head.input.Key, `${plan.pending.baseKey}/site/index.html`);
});

test('preserve mode accepts a root entry file with nested assets', async () => {
  const { upload } = setup();
  const result = await upload({
    ...bundle, pathMode: 'preserve', entryFile: 'index.html',
    files: fileList('index.html', 'assets/app.js'),
  });
  assert.equal(result.statusCode, 201);
  assert.equal(result.pending.entryFile, 'index.html');
  assert.deepEqual(result.pending.files.map(item => item.name), ['index.html', 'assets/app.js']);
});

test('preserve mode honors an explicit entry when a bundle has multiple HTML files', async () => {
  const { upload } = setup();
  const result = await upload({
    ...bundle, pathMode: 'preserve', entryFile: 'report/deck/report.html',
    files: fileList('report/index.html', 'report/deck/report.html', 'report/assets/chart.png'),
  });
  assert.equal(result.statusCode, 201);
  assert.equal(result.pending.entryFile, 'report/deck/report.html');
  assert.deepEqual(result.data.uploads.map(item => item.name), ['report/index.html', 'report/deck/report.html', 'report/assets/chart.png']);
});

test('preserve mode infers the single nested HTML entry when entryFile is omitted', async () => {
  const { upload } = setup();
  const result = await upload({
    ...bundle, pathMode: 'preserve', files: fileList('site/index.html', 'site/assets/app.js'),
  });
  assert.equal(result.statusCode, 201);
  assert.equal(result.pending.entryFile, 'site/index.html');
});

test('legacy requests keep folder stripping and normalize an explicit entry consistently', async () => {
  const { upload } = setup();
  const result = await upload({
    ...bundle, entryFile: 'report/index.html',
    files: fileList('report/index.html', 'report/assets/app.css'),
  });
  assert.equal(result.statusCode, 201);
  assert.equal(result.data.pathMode, 'strip');
  assert.deepEqual(result.pending.files.map(item => item.name), ['index.html', 'assets/app.css']);
  assert.equal(result.pending.entryFile, 'index.html');
  assert.deepEqual(result.data.uploads.map(item => item.name), ['index.html', 'assets/app.css']);
});

test('legacy inferred entries are not stripped a second time', async () => {
  const { upload } = setup();
  const result = await upload({
    ...bundle, files: fileList('root/root/report.html', 'root/root/assets/app.css'),
  });
  assert.equal(result.statusCode, 201);
  assert.deepEqual(result.pending.files.map(item => item.name), ['root/report.html', 'root/assets/app.css']);
  assert.equal(result.pending.entryFile, 'root/report.html');
});

test('legacy explicit original and already-normalized double-root entries map deterministically', async () => {
  for (const entryFile of ['root/root/report.html', 'root/report.html']) {
    const { upload } = setup();
    const result = await upload({
      ...bundle, entryFile, files: fileList('root/root/report.html', 'root/root/assets/app.css'),
    });
    assert.equal(result.statusCode, 201, entryFile);
    assert.equal(result.pending.entryFile, 'root/report.html', entryFile);
  }
});

test('legacy ambiguity resolves from the original-name mapping deterministically', async () => {
  const files = fileList('root/report.html', 'root/root/report.html');
  const original = await setup().upload({ ...bundle, entryFile: 'root/report.html', files });
  assert.equal(original.statusCode, 201);
  assert.equal(original.pending.entryFile, 'report.html');
  const nested = await setup().upload({ ...bundle, entryFile: 'root/root/report.html', files });
  assert.equal(nested.statusCode, 201);
  assert.equal(nested.pending.entryFile, 'root/report.html');
});

test('legacy requests retain the already-stripped explicit entry form', async () => {
  const { upload } = setup();
  const result = await upload({
    ...bundle, entryFile: 'assets/report.html',
    files: fileList('report/assets/report.html', 'report/styles/app.css'),
  });
  assert.equal(result.statusCode, 201);
  assert.deepEqual(result.pending.files.map(item => item.name), ['assets/report.html', 'styles/app.css']);
  assert.equal(result.pending.entryFile, 'assets/report.html');
});

test('an unsupported path mode is rejected instead of silently changing behavior', async () => {
  const { upload } = setup();
  const result = await upload({
    ...bundle, pathMode: 'absolute', entryFile: 'index.html', files: fileList('index.html'),
  });
  assert.equal(result.statusCode, 400);
  assert.match(result.data.error, /pathMode/);
});

test('invalid explicit entry and traversal paths are rejected', async () => {
  const { upload } = setup();
  for (const entryFile of ['../index.html', 'site/../index.html', '/index.html', 'site\\index.html']) {
    const result = await upload({
      ...bundle, pathMode: 'preserve', entryFile, files: fileList('index.html'),
    });
    assert.equal(result.statusCode, 400, entryFile);
    assert.equal(result.pending, null);
  }
  const traversalFile = await upload({
    ...bundle, pathMode: 'preserve', entryFile: 'index.html', files: fileList('../index.html'),
  });
  assert.equal(traversalFile.statusCode, 400);
  assert.equal(traversalFile.pending, null);
});

const bundleKey = 'private/ci/2026-10-01_old-title-12345678';

test('completion records the bundle base key for lifecycle deletion', async () => {
  const { upload, complete } = setup();
  const plan = await upload({
    ...bundle, pathMode: 'preserve', entryFile: 'pages/report.html',
    files: fileList('pages/report.html', 'assets/app.js'),
  });
  const result = await complete(plan.data.id);
  assert.equal(result.statusCode, 201);
  assert.equal(result.data.report.baseKey, plan.pending.baseKey);
});

test('legacy root-entry delete keeps its established full-prefix behavior', async () => {
  const { request, calls } = setup({
    path: `https://reports.example/${bundleKey}/report.html`,
  }, { listings: { [`${bundleKey}/`]: [`${bundleKey}/report.html`, `${bundleKey}/assets/app.js`] } });
  const result = await request(undefined, { method: 'DELETE' });
  assert.equal(result.statusCode, 200);
  const list = calls.find(call => call.name === 'ListObjectsV2Command');
  assert.equal(list.input.Prefix, `${bundleKey}/`);
  const deleted = calls.find(call => call.name === 'DeleteObjectsCommand').input.Delete.Objects.map(item => item.Key).sort();
  assert.deepEqual(deleted, [`${bundleKey}/assets/app.js`, `${bundleKey}/report.html`]);
});

test('nested new bundle delete removes sibling assets from the recorded prefix', async () => {
  const { request, calls, objects } = setup({
    baseKey: bundleKey, path: `https://reports.example/${bundleKey}/pages/report.html`,
  }, { listings: { [`${bundleKey}/`]: [`${bundleKey}/pages/report.html`, `${bundleKey}/assets/app.js`, `${bundleKey}/assets/style.css`] } });
  const result = await request(undefined, { method: 'DELETE' });
  assert.equal(result.statusCode, 200);
  assert.equal(calls.find(call => call.name === 'ListObjectsV2Command').input.Prefix, `${bundleKey}/`);
  assert.deepEqual(calls.find(call => call.name === 'DeleteObjectsCommand').input.Delete.Objects.map(item => item.Key).sort(), [
    `${bundleKey}/assets/app.js`, `${bundleKey}/assets/style.css`, `${bundleKey}/pages/report.html`,
  ]);
  assert.equal(objects.has(`report-meta/authenticated/${id}.json`), false);
});

test('editing metadata category does not invalidate the recorded bundle prefix', async () => {
  const { request, calls } = setup({
    baseKey: bundleKey, category: 'benchmarks', path: `https://reports.example/${bundleKey}/pages/report.html`,
  }, { listings: { [`${bundleKey}/`]: [`${bundleKey}/pages/report.html`] } });
  const result = await request(undefined, { method: 'DELETE' });
  assert.equal(result.statusCode, 200);
  assert.equal(calls.find(call => call.name === 'ListObjectsV2Command').input.Prefix, `${bundleKey}/`);
});

test('delete still requires ownership before prefix handling', async () => {
  const { request, calls, objects } = setup({ baseKey: bundleKey });
  const result = await request(undefined, { method: 'DELETE', handle: 'someone-else' });
  assert.equal(result.statusCode, 403);
  assert.equal(calls.some(call => ['ListObjectsV2Command', 'DeleteObjectsCommand', 'DeleteObjectCommand'].includes(call.name)), false);
  assert.equal(objects.has(`report-meta/authenticated/${id}.json`), true);
});

test('deleting one revision cannot remove another revision bundle', async () => {
  const firstId = '11111111-1111-1111-1111-111111111111';
  const secondId = '22222222-2222-2222-2222-222222222222';
  const firstKey = 'private/ci/2026-10-01_old-title-11111111';
  const secondKey = 'private/ci/2026-10-01_old-title-22222222';
  const { request, calls, objects } = setup({ baseKey: firstKey }, {
    reportId: firstId,
    listings: {
      [`${firstKey}/`]: [`${firstKey}/index.html`, `${firstKey}/assets/app.js`],
      [`${secondKey}/`]: [`${secondKey}/index.html`],
    },
  });
  objects.set(`report-meta/authenticated/${secondId}.json`, {
    id: secondId, reportId: firstId, title: 'Old title', category: 'ci', author: 'Owner',
    date: '2026-10-01', baseKey: secondKey, path: `https://reports.example/${secondKey}/index.html`,
  });
  const result = await request(undefined, { method: 'DELETE', reportId: firstId });
  assert.equal(result.statusCode, 200);
  const prefixes = calls.filter(call => call.name === 'ListObjectsV2Command').map(call => call.input.Prefix);
  assert.deepEqual(prefixes, [`${firstKey}/`, `${firstKey}/`]);
  assert.equal(calls.some(call => call.name === 'DeleteObjectCommand' && call.input.Key.includes(secondId)), false);
  assert.equal(objects.has(`report-meta/authenticated/${firstId}.json`), false);
  assert.equal(objects.has(`report-meta/authenticated/${secondId}.json`), true);
});

test('malformed recorded bundle prefixes are rejected without listing or deleting objects', async () => {
  for (const malformed of [
    'private', 'private/ci', 'private/ci/../other', 'private//ci/2026-10-01_old-title-12345678',
    'public/ci/2026-10-01_old-title-12345678', 'private/unknown/2026-10-01_old-title-12345678',
    'private/ci/2026-10-02_old-title-12345678', 'private/ci/2026-10-01_old-title-99999999',
    ` ${bundleKey}`, `${bundleKey}/extra`,
  ]) {
    const { request, calls, objects } = setup({ baseKey: malformed });
    const result = await request(undefined, { method: 'DELETE' });
    assert.equal(result.statusCode, 400, malformed);
    assert.match(result.data.error, /Invalid report storage path/);
    assert.equal(calls.some(call => ['ListObjectsV2Command', 'DeleteObjectsCommand'].includes(call.name)), false);
    assert.equal(objects.has(`report-meta/authenticated/${id}.json`), true);
  }
});

test('partial S3 errors retain metadata, expose only scoped details, and allow retry', async () => {
  for (const access of ['authenticated', 'public']) {
    const key = bundleKey.replace(/^private/, access === 'public' ? 'public' : 'private');
    const meta = `report-meta/${access}/${id}.json`;
    const files = [`${key}/pages/report.html`, `${key}/assets/style.css`];
    let fail = true;
    const state = setup({ baseKey: key }, { listings: { [`${key}/`]: files }, onSend(command, objects) {
      if (command.name === 'DeleteObjectsCommand' && fail) {
        objects.delete(files[0]);
        return { Errors: [{ Key: files[1], Code: 'AccessDenied', Message: 'sensitive storage details' }] };
      }
    } });
    state.objects.set(meta, state.original);
    const result = await state.request(undefined, { method: 'DELETE', access });
    assert.equal(result.statusCode, 502);
    assert.equal(result.data.stage, 'files');
    assert.equal(result.data.failedCount, 1);
    assert.match(result.data.error, /Retry Delete/);
    assert.doesNotMatch(result.body, /sensitive storage|assets\/style/);
    assert.equal(state.objects.has(meta), true);
    assert.equal(state.objects.has(files[1]), true);
    assert.equal(state.calls.some(call => call.name === 'DeleteObjectCommand'), false);
    fail = false;
    assert.equal((await state.request(undefined, { method: 'DELETE', access })).statusCode, 200);
    assert.equal(state.objects.has(meta), false);
    assert.equal(state.objects.has(files[1]), false);
    assert.equal(state.calls.at(-1).input.Key, meta);
    assert.equal(state.calls.at(-2).input.MaxKeys, 1);
  }
});

test('thrown S3 listing, batch deletion, and verification errors retain metadata', async () => {
  for (const stage of ['list', 'delete', 'verify']) {
    const { request, objects, calls } = setup({ baseKey: bundleKey }, {
      listings: { [`${bundleKey}/`]: [`${bundleKey}/index.html`] },
      onSend(command) {
        if ((stage === 'list' && command.name === 'ListObjectsV2Command' && !command.input.MaxKeys) ||
            (stage === 'delete' && command.name === 'DeleteObjectsCommand') ||
            (stage === 'verify' && command.input.MaxKeys === 1)) throw new Error('private backend error');
      },
    });
    const result = await request(undefined, { method: 'DELETE' });
    assert.equal(result.statusCode, 502, stage);
    assert.doesNotMatch(result.body, /private backend error/);
    assert.equal(objects.has(`report-meta/authenticated/${id}.json`), true);
    assert.equal(calls.some(call => call.name === 'DeleteObjectCommand'), false);
  }
});

test('remaining objects and incomplete listings prevent metadata deletion', async () => {
  for (const mode of ['remaining', 'truncated']) {
    const { request, objects, calls } = setup({ baseKey: bundleKey }, {
      onSend(command) {
        if (command.name !== 'ListObjectsV2Command') return;
        if (mode === 'truncated') return { Contents: [], IsTruncated: true };
        if (command.input.MaxKeys === 1) return { Contents: [{ Key: `${bundleKey}/late.html` }] };
      },
    });
    assert.equal((await request(undefined, { method: 'DELETE' })).statusCode, 502);
    assert.equal(objects.has(`report-meta/authenticated/${id}.json`), true);
    assert.equal(calls.some(call => call.name === 'DeleteObjectCommand'), false);
  }
});

test('multi-page deletion verifies empty prefix before deleting metadata', async () => {
  const files = Array.from({ length: 2005 }, (_, index) => `${bundleKey}/assets/${String(index).padStart(4, '0')}.txt`);
  const { request, calls, objects } = setup({ baseKey: bundleKey }, { listings: { [`${bundleKey}/`]: files } });
  const result = await request(undefined, { method: 'DELETE' });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.data, { deleted: id });
  assert.deepEqual(calls.filter(call => call.name === 'DeleteObjectsCommand').map(call => call.input.Delete.Objects.length), [1000, 1000, 5]);
  assert.equal(files.some(key => objects.has(key)), false);
  assert.equal(calls.at(-2).input.MaxKeys, 1);
  assert.equal(calls.at(-1).name, 'DeleteObjectCommand');
});

test('errors on a later deletion page retain metadata and remaining files for retry', async () => {
  const files = Array.from({ length: 1001 }, (_, index) => `${bundleKey}/${String(index).padStart(4, '0')}.txt`);
  let batches = 0;
  const state = setup({ baseKey: bundleKey }, { listings: { [`${bundleKey}/`]: files }, onSend(command) {
    if (command.name === 'DeleteObjectsCommand' && ++batches === 2) return { Errors: [{ Code: 'InternalError' }] };
  } });
  assert.equal((await state.request(undefined, { method: 'DELETE' })).statusCode, 502);
  assert.equal(state.objects.has(`report-meta/authenticated/${id}.json`), true);
  assert.equal(files.filter(key => state.objects.has(key)).length, 1);
  assert.equal((await state.request(undefined, { method: 'DELETE' })).statusCode, 200);
});

test('metadata deletion failure after file cleanup remains retryable', async () => {
  let fail = true;
  const state = setup({ baseKey: bundleKey }, { listings: { [`${bundleKey}/`]: [`${bundleKey}/index.html`] }, onSend(command) {
    if (command.name === 'DeleteObjectCommand' && fail) throw new Error('metadata unavailable');
  } });
  const result = await state.request(undefined, { method: 'DELETE' });
  assert.equal(result.statusCode, 502);
  assert.equal(result.data.stage, 'metadata');
  assert.equal(state.objects.has(`report-meta/authenticated/${id}.json`), true);
  assert.equal(state.objects.has(`${bundleKey}/index.html`), false);
  fail = false;
  assert.equal((await state.request(undefined, { method: 'DELETE' })).statusCode, 200);
});

test('already-empty bundles are verified and external entries only delete metadata', async () => {
  const empty = setup({ baseKey: bundleKey });
  assert.equal((await empty.request(undefined, { method: 'DELETE' })).statusCode, 200);
  assert.deepEqual(empty.calls.map(call => call.name), ['GetObjectCommand', 'ListObjectsV2Command', 'ListObjectsV2Command', 'DeleteObjectCommand']);
  for (const fail of [false, true]) {
    const external = setup({ externalUrl: 'https://example.org/report' }, { onSend(command) {
      if (fail && command.name === 'DeleteObjectCommand') throw new Error('unavailable');
    } });
    assert.equal((await external.request(undefined, { method: 'DELETE' })).statusCode, fail ? 502 : 200);
    assert.deepEqual(external.calls.map(call => call.name), ['GetObjectCommand', 'DeleteObjectCommand']);
    assert.equal(external.objects.has(`report-meta/authenticated/${id}.json`), fail);
  }
});

'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { Readable } = require('node:stream');

function load(send) {
  const names = ['GetObject', 'PutObject', 'ListObjectsV2', 'ListObjectVersions', 'DeleteObjects', 'HeadObject', 'CopyObject', 'GetBucketVersioning'];
  const sdk = Object.fromEntries(names.map(name => [`${name}Command`, class { constructor(input) { this.name = name; this.input = input; } }]));
  const context = { module: { exports: {} }, process: { env: {} }, require(name) {
    if (name === '@aws-sdk/client-s3') return sdk;
    if (name === '@aws-sdk/s3-request-presigner') return { getSignedUrl: async () => 'signed' };
    if (name === './publication') return require('../_infra/lambda-token-admin/publication');
    return require(name);
  } };
  vm.runInNewContext(fs.readFileSync('_infra/lambda-token-admin/publication-s3.js', 'utf8'), context);
  return context.module.exports.createStore({ s3: { send }, bucket: 'reports', stagingBucket: 'staging' });
}

test('control writes enforce create/update preconditions and do not swallow read failures', async () => {
  const calls = [], store = load(async command => { calls.push(command); if (command.name === 'GetObject') throw new Error('denied'); return {}; });
  await store.put('control', { generation: 1 });
  await store.put('control', { generation: 2 }, 'opaque-etag');
  assert.equal(calls[0].input.IfNoneMatch, '*');
  assert.equal(calls[1].input.IfMatch, 'opaque-etag');
  await assert.rejects(store.get('control'), /denied/);
});

test('version cleanup includes delete markers, pages, partial errors and final verification', async () => {
  for (const failure of [null, 'partial', 'remaining', 'throw']) {
    const calls = []; let lists = 0;
    const store = load(async command => {
      calls.push(command);
      if (command.name === 'ListObjectVersions') {
        lists++;
        if (command.input.MaxKeys === 1) return failure === 'remaining' ? { Versions: [{ Key: 'uploads/00000000-0000-0000-0000-000000000001/file', VersionId: 'late' }] } : {};
        if (lists === 1) return { Versions: [{ Key: 'uploads/00000000-0000-0000-0000-000000000001/file', VersionId: 'v1' }], IsTruncated: true, NextKeyMarker: 'next', NextVersionIdMarker: 'v1' };
        return { DeleteMarkers: [{ Key: 'uploads/00000000-0000-0000-0000-000000000001/file', VersionId: 'marker' }] };
      }
      if (failure === 'throw') throw new Error('unavailable');
      return failure === 'partial' ? { Errors: [{ Code: 'AccessDenied' }] } : {};
    });
    const operation = store.deleteStaging('00000000-0000-0000-0000-000000000001');
    if (failure) await assert.rejects(operation);
    else {
      await operation;
      assert.deepEqual(calls.filter(call => call.name === 'DeleteObjects').map(call => call.input.Delete.Objects[0].VersionId), ['v1', 'marker']);
      assert.equal(calls.at(-1).input.MaxKeys, 1);
    }
  }
});

test('copies pin source version and reject destination corruption', async () => {
  for (const corrupt of [false, true]) {
    const calls = [];
    const store = load(async command => {
      calls.push(command);
      if (command.name === 'GetObject') return { Body: Readable.from([command.input.Bucket === 'reports' && corrupt ? 'wrong' : 'bytes']) };
      if (command.name === 'CopyObject') return { CopyObjectResult: { ETag: 'copied' }, VersionId: 'dest-version' };
      if (command.name === 'HeadObject') return { ContentLength: 5, ContentType: 'text/html' };
    });
    const operation = store.copyVerified('upload-id', { name: 'site/index.html', version: 'source-version', size: 5, contentType: 'text/html' }, 'report-objects-v2/revision/attempt/');
    if (corrupt) await assert.rejects(operation, /verification/); else await operation;
    assert.match(calls.find(call => call.name === 'CopyObject').input.CopySource, /versionId=source-version$/);
    assert.equal(calls.filter(call => call.name === 'GetObject').at(-1).input.VersionId, 'dest-version');
  }
});

test('staging without versioning is refused before signed URL issuance', async () => {
  await assert.rejects(load(async () => ({ Status: 'Suspended' })).checkStaging(), /versioned staging/);
});

test('destructive prefix guard rejects broad and malformed prefixes before S3 access', async () => {
  const calls = [], store = load(async command => { calls.push(command); return {}; });
  for (const prefix of ['', 'public/', 'public/ci/', 'report-objects-v2/x/', 'public/ci/../private/x/', 'public/ci/old']) {
    assert.throws(() => store.deletePublished(prefix), /Invalid bundle prefix/);
  }
  assert.equal(calls.length, 0);
  for (const prefix of ['report-objects-v2/00000000-0000-0000-0000-000000000001/00000000-0000-0000-0000-000000000002/', 'public/ci/old/']) {
    await store.deletePublished(prefix);
    assert.equal(calls.at(-1).input.Prefix, prefix);
  }
});

test('storage rejects malformed document roots while retaining valid ETags', async () => {
  for (const value of [null, [], 'text', 42, true, { cursor: null }]) {
    const store = load(async () => ({ ETag: 'etag', Body: { transformToString: async () => JSON.stringify(value) } }));
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      assert.equal((await store.get('checkpoint')).etag, 'etag');
    } else await assert.rejects(store.get('checkpoint'), /Invalid stored document root/);
  }
});

test('storage propagates conditional conflicts and rejects truncated lists without cursors', async () => {
  const error = Object.assign(new Error('conflict'), { name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } });
  await assert.rejects(load(async () => { throw error; }).put('control', {}, 'etag'), actual => actual === error);
  await assert.rejects(load(async () => ({ IsTruncated: true })).list(), /Incomplete control listing/);
});

test('a forbidden staging HEAD is missing only after successful exact-key absence verification', async () => {
  const denied = Object.assign(new Error('denied'), { $metadata: { httpStatusCode: 403 } });
  const calls = [];
  const store = load(async command => {
    calls.push(command);
    if (command.name === 'HeadObject') throw denied;
    assert.equal(command.name, 'ListObjectsV2');
    assert.equal(command.input.Bucket, 'staging');
    assert.equal(command.input.Prefix, 'uploads/id/site/app.js');
    // A sibling whose name starts with the requested key is not that object.
    return { Contents: [{ Key: 'uploads/id/site/app.js.map' }] };
  });
  assert.equal(await store.inspect('id', 'site/app.js'), null);
  assert.equal(calls.length, 2);
});

test('staging lookup never converts denied existing objects or failed listings to missing', async () => {
  const denied = Object.assign(new Error('denied'), { $metadata: { httpStatusCode: 403 } });
  for (const mode of ['exists', 'list-denied', 'list-unavailable', 'truncated', 'outside-prefix']) {
    const store = load(async command => {
      if (command.name === 'HeadObject') throw denied;
      if (mode === 'list-denied') throw denied;
      if (mode === 'list-unavailable') throw new Error('storage unavailable');
      if (mode === 'truncated') return { IsTruncated: true };
      return { Contents: [{ Key: mode === 'exists' ? 'uploads/id/file' : 'uploads/other/file' }] };
    });
    await assert.rejects(store.inspect('id', 'file'));
  }
});

test('staging absence requires every listing page and rejects repeated cursors', async () => {
  const denied = Object.assign(new Error('denied'), { $metadata: { httpStatusCode: 403 } });
  for (const mode of ['absent', 'exists-later', 'repeated-cursor']) {
    let pages = 0;
    const store = load(async command => {
      if (command.name === 'HeadObject') throw denied;
      pages++;
      if (pages === 1 || mode === 'repeated-cursor') return { Contents: [{ Key: 'uploads/id/file.backup' }], IsTruncated: true, NextContinuationToken: 'next' };
      assert.equal(command.input.ContinuationToken, 'next');
      return mode === 'exists-later' ? { Contents: [{ Key: 'uploads/id/file' }] } : {};
    });
    if (mode === 'absent') assert.equal(await store.inspect('id', 'file'), null);
    else await assert.rejects(store.inspect('id', 'file'));
    assert.equal(pages, 2);
  }
});

test('successful HEAD, explicit not-found, and non-permission failures need no listing', async () => {
  for (const status of [200,404,500]) {
    let calls = 0;
    const store = load(async command => {
      calls++;
      assert.equal(command.name, 'HeadObject');
      if (status !== 200) throw Object.assign(new Error('HEAD failed'), { $metadata: { httpStatusCode: status } });
      return { VersionId: 'pinned', ContentLength: 5, ContentType: 'text/html' };
    });
    if (status === 500) await assert.rejects(store.inspect('id', 'file'));
    else if (status === 404) assert.equal(await store.inspect('id', 'file'), null);
    else assert.equal((await store.inspect('id', 'file')).version, 'pinned');
    assert.equal(calls, 1);
  }
});

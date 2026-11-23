'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { fixture } = require('./helpers/publication-fixture');
const { controlKey } = require('../_infra/lambda-token-admin/publication');

function gate(f) {
  const context = { exports: {}, URL, Buffer, console: { log() {} }, require(name) {
    if (name === 'google-auth-library') return { OAuth2Client: class {} };
    if (name === '@aws-sdk/client-s3') return {
      GetObjectCommand: class { constructor(input) { this.input = input; } },
      S3Client: class { async send(command) {
        const object = await f.store.get(command.input.Key);
        if (!object) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
        return { Body: { transformToString: async () => JSON.stringify(object.value) } };
      } },
    };
    return require(name);
  } };
  vm.runInNewContext(fs.readFileSync('_infra/lambda-auth/index.js', 'utf8').replaceAll('__COOKIE_SECRET__', 'test-secret'), context);
  return (uri, method = 'GET', identity, querystring = '') => {
    const value = `authenticated:${identity}:${Date.now()}:owner`;
    const cookie = `${value}.${crypto.createHmac('sha256', 'test-secret').update(value).digest('base64url')}`;
    return context.exports.handler({ Records: [{ cf: { request: { uri, method, querystring, headers: identity ? { cookie: [{ value: `psap_auth=${cookie}` }] } : {} } } }] });
  };
}

test('private V2 sign-in preserves query parameters and bare paths', async () => {
  const f = fixture(), plan = await f.plan({ access: 'authenticated' });
  const path = `/private/v2/${plan.id}/${plan.id}/site/index.html`;
  for (const query of ['', 'view=latency&run=2']) {
    const result = await gate(f)(path, 'GET', undefined, query);
    assert.ok(result.body.includes('/_auth/github?state=' + encodeURIComponent(path + (query ? '?' + query : ''))));
  }
});

test('viewer gate denies every partial-copy state and serves only committed manifest files', async () => {
  for (const access of ['public', 'authenticated']) {
    const f = fixture(), plan = await f.plan({ access }); f.fill(plan.id);
    const call = gate(f), route = `/${access === 'public' ? 'public' : 'private'}/v2/${plan.id}/${plan.id}/site/index.html`;
    assert.equal((await call(route, 'GET', 'github')).status, '404');
    f.hooks.afterCopy = async () => assert.equal((await call(route, 'GET', 'github')).status, '404');
    await f.service.complete(plan.id, 'owner');
    for (const identity of ['github', 'google', 'token']) {
      assert.match((await call(route, 'GET', identity)).uri, /^\/report-objects-v2\//);
      assert.match((await call(route, 'HEAD', identity)).uri, /^\/report-objects-v2\//);
    }
    if (access === 'public') assert.match((await call(route)).uri, /^\/report-objects-v2\//);
    else assert.equal((await call(route)).status, '200', 'unauthenticated viewer receives login page');
    assert.equal((await call(route.replace('index.html', 'not-in-manifest.html'), 'GET', 'github')).status, '404');
    assert.equal((await call(route, 'PUT', 'github')).status, '400');
    // Simulate a warm cache: each invocation must still consult current state.
    f.hooks.get = key => { if (key === controlKey(plan.id)) throw new Error('store unavailable'); };
    assert.equal((await call(route, 'GET', 'github')).status, '503');
  }
});

test('physical, control, staging and encoded bypasses are denied to all identities', async () => {
  const f = fixture(), call = gate(f);
  for (const path of ['/report-objects-v2/anything', '/report-control-v2/id.json', '/report-locators-v2/id.json', '/uploads/id/file',
    '/report-submissions/id.json', '/public/../report-objects-v2/anything', '/%72eport-control-v2/id.json', '/%2572eport-control-v2/id.json']) {
    for (const identity of [undefined, 'github', 'google', 'token']) assert.ok(['400', '403'].includes((await call(path, 'GET', identity)).status), path);
  }
});

test('gate closes on owner deletion even after a report has been served', async () => {
  const f = fixture(), plan = await f.plan(); f.fill(plan.id);
  const report = await f.service.complete(plan.id, 'owner'), call = gate(f), path = new URL(report.path).pathname;
  assert.match((await call(path)).uri, /^\/report-objects-v2\//);
  f.hooks.deletePublished = () => { throw new Error('partial'); };
  await assert.rejects(f.service.remove(plan.id, 'owner', 'public'));
  assert.equal((await call(path)).status, '404');
});

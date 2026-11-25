'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/publication-fixture');
const { controlKey, RETENTION } = require('../_infra/lambda-token-admin/publication');
const WINDOW = 6 * 60 * 60 * 1000;

test('owner repairs failed validation and report details after URL expiry using the same submission', async () => {
  const f = fixture(), original = await f.plan();
  await assert.rejects(f.service.complete(original.id, 'owner'), { status: 400 });
  f.advance(3600000);
  await assert.rejects(f.service.resume(original.id, f.submission, 'other'), { status: 403 });
  const signed = [];
  f.store.sign = async (id, file, ttl) => { signed.push(ttl); return 'https://staging.example/upload'; };
  const updated = { ...f.submission, title: 'Corrected', category: 'benchmarks', description: 'Fixed', tags: ['gpu'],
    access: 'authenticated', entryFile: 'fixed.html', files: [{ name: 'fixed.html', size: 7, contentType: 'text/html' }] };
  const resumed = await f.service.resume(original.id, updated, 'owner');
  assert.equal(resumed.id, original.id);
  assert.equal(resumed.resumeUntil, original.resumeUntil);
  assert.equal(resumed.retainUntil, original.retainUntil);
  assert.deepEqual(signed, [900]);
  f.put(original.id, updated.files[0], 'newbody');
  const report = await f.service.complete(original.id, 'owner');
  assert.equal(report.title, 'Corrected');
  assert.equal(report.description, 'Fixed');
  assert.equal(report.category, 'benchmarks');
  assert.deepEqual(report.tags, ['gpu']);
  assert.equal(report.authenticated, true);
  assert.match(report.path, /\/private\/v2\/.*\/fixed.html$/);
  await assert.rejects(f.service.resume(original.id, updated, 'owner'), { status: 409 });
  assert.deepEqual(await f.service.complete(original.id, 'owner'), report);
});

test('renewal and completion cannot extend the six-hour window; retention remains seven days', async () => {
  const f = fixture(), plan = await f.plan();
  f.advance(WINDOW - 10000);
  const signed = [];
  f.store.sign = async (id, file, ttl) => { signed.push(ttl); return 'https://staging.example/upload'; };
  const resumed = await f.service.resume(plan.id, f.submission, 'owner');
  assert.deepEqual(signed, [10, 10]);
  assert.equal(resumed.expiresAt, plan.resumeUntil);
  f.fill(plan.id); f.advance(10000);
  await assert.rejects(f.service.resume(plan.id, f.submission, 'owner'), { status: 410 });
  await assert.rejects(f.service.complete(plan.id, 'owner'), { status: 410 });
  assert.equal((await f.service.dashboard('owner')).uploads[0].canResume, false);
  await f.service.reconcile();
  assert.equal(f.staging.size, 2);
  f.advance(RETENTION - WINDOW);
  await f.service.reconcile();
  assert.equal(f.staging.size, 0);
});

test('recovery cannot race active completion or change visibility of a replacement', async () => {
  const f = fixture(), first = await f.plan(); f.fill(first.id);
  f.hooks.copy = async () => {
    await assert.rejects(f.service.resume(first.id, f.submission, 'owner'), { status: 409 });
  };
  await f.service.complete(first.id, 'owner'); f.hooks.copy = null;
  const replacement = await f.service.plan(f.submission, 'owner', first.id);
  await assert.rejects(f.service.resume(replacement.id, { ...f.submission, access: 'authenticated' }, 'owner'), { status: 400 });
  const doc = f.documents.get(controlKey(first.id)).value;
  assert.equal(doc.head, first.id);
  assert.equal(doc.revisions[replacement.id].state, 'OPEN');
});

test('recovering a storage failure keeps old copies private and cleans only unselected attempts', async () => {
  const f = fixture(), plan = await f.plan(); f.fill(plan.id);
  f.hooks.afterCopy = () => { throw new Error('copy interrupted'); };
  await assert.rejects(f.service.complete(plan.id, 'owner'), { status: 502 });
  assert.equal(f.published.size, 1);
  assert.equal((await f.service.listReports('public')).reports.length, 0);
  f.hooks.afterCopy = null;
  await f.service.resume(plan.id, f.submission, 'owner');
  f.fill(plan.id);
  await f.service.complete(plan.id, 'owner');
  await f.service.reconcile();
  assert.equal(f.published.size, 2);
  assert.equal(f.staging.size, 0);
  assert.equal((await f.service.listReports('public')).reports.length, 1);
});

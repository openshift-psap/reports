'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/publication-fixture');
const { controlKey, RETENTION, LEASE } = require('../_infra/lambda-token-admin/publication');

test('both visibilities publish only after every nested asset is copied; completion is idempotent', async () => {
  for (const access of ['public', 'authenticated']) {
    const f = fixture(), plan = await f.plan({ access });
    f.fill(plan.id);
    f.hooks.afterCopy = async () => {
      assert.equal((await f.service.listReports(access)).reports.length, 0);
      assert.equal(f.documents.get(controlKey(plan.id)).value.revisions[plan.id].state, 'PREPARING');
    };
    const result = await f.service.complete(plan.id, 'owner');
    assert.match(result.path, /\/v2\/.*\/site\/index.html$/);
    assert.equal(result.authenticated, access === 'authenticated');
    assert.equal(f.published.size, 2);
    assert.deepEqual(await f.service.complete(plan.id, 'owner'), result);
    assert.equal((await f.service.listReports(access)).reports.length, 1);
    f.advance(RETENTION * 2);
    await f.service.reconcile();
    assert.equal(f.staging.size, 0);
    assert.equal(f.published.size, 2, 'committed objects never expire');
  }
});

test('interruption after every PUT stays unpublished and retains partial data for a week', async () => {
  for (let count = 0; count <= 2; count++) {
    const f = fixture(), plan = await f.plan();
    f.submission.files.slice(0, count).forEach(file => f.put(plan.id, file));
    f.advance(RETENTION - 1);
    await f.service.reconcile();
    assert.equal(f.staging.size, count);
    assert.equal((await f.service.listReports('public')).reports.length, 0);
    f.advance(1);
    await f.service.reconcile();
    assert.equal(f.staging.size, 0);
    assert.equal(f.documents.get(controlKey(plan.id)).value.revisions[plan.id].state, 'ABORTED');
  }
});

test('missing asset, wrong size, and unversioned objects cannot commit', async () => {
  for (const mode of ['missing', 'size', 'unversioned']) {
    const f = fixture(), plan = await f.plan(); f.fill(plan.id);
    if (mode === 'missing') f.staging.delete(`${plan.id}/site/assets/app.js`);
    if (mode === 'size') f.put(plan.id, f.submission.files[1], 'wrong-size');
    if (mode === 'unversioned') f.staging.get(`${plan.id}/site/assets/app.js`)[0].version = 'null';
    await assert.rejects(f.service.complete(plan.id, 'owner'), { status: 400 });
    assert.equal((await f.service.listReports('public')).reports.length, 0);
    assert.equal(f.published.size, 0);
    const dashboard = await f.service.dashboard('owner', null, plan.id);
    assert.equal(dashboard.uploads[0].state, 'ABORTED');
  }
});

test('failure after each copy retains cleanup evidence and never publishes', async () => {
  for (let failAt = 1; failAt <= 2; failAt++) {
    const f = fixture(), plan = await f.plan(); f.fill(plan.id); let copies = 0;
    f.hooks.afterCopy = () => { if (++copies === failAt) throw new Error('private SDK details'); };
    await assert.rejects(f.service.complete(plan.id, 'owner'), { status: 502 });
    assert.equal((await f.service.listReports('public')).reports.length, 0);
    assert.equal(f.published.size, failAt);
    await f.service.reconcile(); assert.equal(f.published.size, failAt);
    f.advance(RETENTION);
    await f.service.reconcile(); assert.equal(f.published.size, 0);
    assert.ok(f.documents.has(controlKey(plan.id)));
    assert.doesNotMatch(JSON.stringify(f.logs), /secret=|private SDK/);
  }
});

test('lost commit response resolves to the same committed result', async () => {
  const f = fixture(), plan = await f.plan(); f.fill(plan.id);
  let once = true;
  f.hooks.afterPut = (key, value) => {
    if (once && key === controlKey(plan.id) && value.revisions[plan.id].state === 'COMMITTED') { once = false; throw new Error('response lost'); }
  };
  const result = await f.service.complete(plan.id, 'owner');
  assert.deepEqual(await f.service.complete(plan.id, 'owner'), result);
});

test('replacement preserves old revision and only one concurrent replacement can win', async () => {
  const f = fixture(), original = await f.plan(); f.fill(original.id);
  await f.service.complete(original.id, 'owner');
  const a = await f.service.plan(f.submission, 'owner', original.id);
  const b = await f.service.plan(f.submission, 'owner', original.id);
  f.fill(a.id); f.fill(b.id);
  const results = await Promise.allSettled([f.service.complete(a.id, 'owner'), f.service.complete(b.id, 'owner')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const listing = await f.service.listReports('public', true);
  assert.equal(listing.reports.length, 2);
  assert.equal(listing.reports.filter(report => report.isLatest).length, 1);
  assert.equal(f.documents.get(controlKey(original.id)).value.revisions[original.id].state, 'COMMITTED');
});

test('cleanup wins a lease race and stale copier cannot commit or affect other revisions', async () => {
  const f = fixture(), plan = await f.plan(); f.fill(plan.id);
  let once = true;
  f.hooks.copy = async () => {
    if (!once) return; once = false;
    f.advance(LEASE + 1); await f.service.reconcile();
  };
  await assert.rejects(f.service.complete(plan.id, 'owner'), { status: 409 });
  assert.equal((await f.service.listReports('public')).reports.length, 0);
  f.advance(RETENTION); await f.service.reconcile();
  assert.equal(f.published.size, 0);
});

test('late PUT after commit and after cleanup cannot modify published bytes', async () => {
  const f = fixture(), plan = await f.plan(); f.fill(plan.id);
  await f.service.complete(plan.id, 'owner');
  const before = [...f.published.entries()];
  await f.service.reconcile();
  f.put(plan.id, f.submission.files[0], 'late-secret');
  f.advance(300001); await f.service.reconcile();
  assert.equal(f.staging.size, 0);
  assert.deepEqual([...f.published.entries()], before);
});

test('pinning versions prevents PUT replacement during completion from changing copied data', async () => {
  const f = fixture(), plan = await f.plan(); f.fill(plan.id);
  f.hooks.copy = (id, file) => f.put(id, file, 'later');
  await f.service.complete(plan.id, 'owner');
  assert.deepEqual([...f.published.values()], ['bytes', 'bytes']);
});

test('partial cleanup failure remains visible, backs off, and automatically retries', async () => {
  const f = fixture(), plan = await f.plan(); f.fill(plan.id); f.advance(RETENTION);
  f.hooks.deleteStaging = () => { f.staging.delete(`${plan.id}/site/index.html`); throw new Error('denied'); };
  await f.service.reconcile();
  const row = (await f.service.dashboard('owner')).uploads[0];
  assert.equal(row.cleanup.failures, 1);
  assert.equal(f.staging.size, 1);
  f.hooks.deleteStaging = null; f.advance(900001); await f.service.reconcile();
  assert.equal(f.staging.size, 0);
  assert.equal((await f.service.dashboard('owner')).uploads.length, 0);
});

test('dashboard is owner-only, counts unknown on failure, and separates authorization expiry', async () => {
  const f = fixture(), plan = await f.plan();
  assert.equal((await f.service.dashboard('other')).uploads.length, 0);
  await assert.rejects(f.service.dashboard(''), { status: 403 });
  await assert.rejects(f.service.complete(plan.id, 'other'), { status: 403 });
  assert.equal((await f.service.dashboard('owner')).uploads[0].observedFiles, null);
  const detail = (await f.service.dashboard('owner', null, plan.id)).uploads[0];
  assert.equal(detail.observedFiles, 0);
  assert.equal(detail.missing.length, 2);
  assert.equal(detail.retainUntil - detail.createdAt, RETENTION);
  assert.equal(detail.uploadUrlsExpireAt - detail.createdAt, 15 * 60 * 1000);
  assert.equal(Date.parse(plan.expiresAt), detail.uploadUrlsExpireAt);
  f.hooks.inspect = () => { throw new Error('unavailable'); };
  assert.equal((await f.service.dashboard('owner', null, plan.id)).uploads[0].observedFiles, null);
  f.hooks.inspect = null; f.fill(plan.id); f.advance(15 * 60 * 1000 + 1);
  await f.service.complete(plan.id, 'owner'); // completed bytes outlive URL authorization
});

test('deletion closes gate but preserves retry metadata; other revisions survive', async () => {
  const f = fixture(), a = await f.plan(); f.fill(a.id); await f.service.complete(a.id, 'owner');
  const b = await f.service.plan(f.submission, 'owner', a.id); f.fill(b.id); await f.service.complete(b.id, 'owner');
  f.hooks.deletePublished = () => { throw new Error('partial'); };
  await assert.rejects(f.service.remove(a.id, 'owner', 'public'), { status: 502 });
  assert.equal((await f.service.listReports('public', true)).reports.length, 2);
  f.hooks.deletePublished = null;
  await f.service.remove(a.id, 'owner', 'public');
  assert.equal((await f.service.listReports('public')).reports[0].id, b.id);
  assert.equal(f.published.size, 2);
});

test('external links and legacy adoption preserve their existing content paths', async () => {
  const f = fixture();
  const legacyId = f.uuid();
  const old = { id: legacyId, reportId: legacyId, author: 'owner', authenticated: false, isLatest: true, version: 1, path: 'https://reports.example/public/ci/old/index.html' };
  await f.service.adopt(old, 'owner', 'public/ci/old/');
  const result = await f.service.plan({ ...f.submission, files: [], externalUrl: 'https://example.org/new' }, 'owner', legacyId);
  assert.equal(result.report.path, 'https://example.org/new');
  assert.equal((await f.service.listReports('public', true)).reports.length, 2);
  await f.service.edit(result.report.id, 'owner', 'public', { title: 'Changed' });
  assert.equal((await f.service.listReports('public')).reports[0].title, 'Changed');
});

test('legacy external links never generate staging cleanup work', async () => {
  const f = fixture();
  await f.service.adopt({ id: 'legacy-abcdef', author: 'owner', authenticated: false,
    externalUrl: 'https://example.org/report', path: 'https://example.org/report' }, 'owner', null);
  f.hooks.deleteStaging = () => { assert.fail('adopted reports have no staging upload'); };
  await f.service.reconcile();
  assert.equal(f.logs.some(log => log.event === 'upload_cleanup_failed'), false);
});

test('adoption and lookup accept safe route IDs and reject unsafe IDs', async () => {
  const f = fixture();
  for (const id of ['abcdef', 'legacy-abcdef']) {
    const reportId = await f.service.adopt({ id, author: 'owner', authenticated: false, externalUrl: 'https://example.org' }, 'owner', null);
    assert.equal(await f.service.locate(id), reportId);
    assert.equal((await f.service.edit(id, 'owner', 'public', { title: 'Edited' })).title, 'Edited');
  }
  for (const id of ['../abcdef', 'a/b', 'a'.repeat(65)]) {
    await assert.rejects(f.service.adopt({ id }, 'owner', null), { status: 400 });
    assert.equal(await f.service.locate(id), null);
  }
});

test('idle scans avoid control writes but late bytes still get swept after URL expiry', async () => {
  const f = fixture(), plan = await f.plan();
  const before = structuredClone(f.documents.get(controlKey(plan.id)));
  await f.service.reconcile();
  assert.deepEqual(f.documents.get(controlKey(plan.id)), before);
  f.fill(plan.id); await f.service.complete(plan.id, 'owner');
  await f.service.reconcile();
  const cleaned = structuredClone(f.documents.get(controlKey(plan.id)));
  await f.service.reconcile();
  assert.deepEqual(f.documents.get(controlKey(plan.id)), cleaned);
  f.advance(RETENTION);
  f.put(plan.id, f.submission.files[0], 'late');
  await f.service.reconcile();
  assert.equal(f.staging.size, 0);
  assert.equal(f.published.size, 2);
});

test('listing starts all control reads in a page concurrently', async () => {
  const f = fixture(); await f.plan(); await f.plan();
  let started = 0, release;
  const barrier = new Promise(resolve => { release = resolve; });
  f.hooks.get = async key => {
    if (!key.startsWith('report-control-v2/')) return;
    if (++started === 2) release();
    await barrier;
  };
  await f.service.listReports('public');
  assert.equal(started, 2);
});

test('verified cleanup still revisits unselected attempts for late copier writes', async () => {
  const f = fixture(), plan = await f.plan(); f.fill(plan.id);
  f.hooks.afterCopy = () => { throw new Error('interrupted copier'); };
  await assert.rejects(f.service.complete(plan.id, 'owner'), { status: 502 });
  const attempt = Object.values(f.documents.get(controlKey(plan.id)).value.revisions[plan.id].attempts)[0];
  f.advance(RETENTION); await f.service.reconcile();
  assert.equal(f.published.size, 0);
  f.published.set(attempt.prefix + 'site/index.html', 'late copy');
  f.advance(300001); await f.service.reconcile();
  assert.equal(f.published.size, 0);
});

test('conditional-write exhaustion leaves upload unpublished and duplicate active completion conflicts', async () => {
  const f = fixture(), plan = await f.plan(); f.fill(plan.id);
  let checked = false;
  f.hooks.copy = async () => {
    if (checked) return;
    checked = true;
    await assert.rejects(f.service.complete(plan.id, 'owner'), { status: 409 });
  };
  f.hooks.beforePut = (key, value) => {
    if (key === controlKey(plan.id) && value.revisions[plan.id].state === 'COMMITTED') {
      throw Object.assign(new Error('conflict'), { name: 'PreconditionFailed' });
    }
  };
  await assert.rejects(f.service.complete(plan.id, 'owner'), { status: 409 });
  assert.equal(checked, true);
  assert.equal((await f.service.listReports('public')).reports.length, 0);
  assert.equal(f.documents.get(controlKey(plan.id)).value.revisions[plan.id].state, 'ABORTED');
});

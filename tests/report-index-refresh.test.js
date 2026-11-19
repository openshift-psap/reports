'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const template = fs.readFileSync('_generator/generate_index.py', 'utf8');
const source = template.slice(
  template.indexOf('function reportsApiUrl('),
  template.indexOf('function makePill('),
);

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function entry(id, authenticated, submittedAt) {
  return { id, title: id, category: 'ci', tags: [], date: submittedAt, submittedAt, authenticated };
}

function setup() {
  const calls = [];
  const context = {
    REPORTS: [],
    window: { location: { origin: 'https://reports.example' } },
    fetch(url, options = {}) {
      const completion = deferred();
      calls.push({ url, options, completion });
      return completion.promise;
    },
    rebuildFilters() {},
    render() {},
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  const respond = (call, reports) => call.completion.resolve({ ok: true, json: async () => ({ reports }) });
  const ids = () => Array.from(context.REPORTS, report => report.id);
  return { context, calls, respond, ids };
}

test('a late public response keeps private entries that completed first', async () => {
  const { context, calls, respond, ids } = setup();
  const privateLoad = context.loadPrivateEntries();
  const publicLoad = context.loadPublicEntries();
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /access=authenticated/);
  assert.equal(calls[0].options.credentials, 'include');
  assert.match(calls[1].url, /access=public/);

  respond(calls[0], [entry('private-1', true, '2026-03-02')]);
  await privateLoad;
  respond(calls[1], [entry('public-1', false, '2026-03-01')]);
  await publicLoad;

  assert.deepEqual(ids(), ['private-1', 'public-1']);
  assert.equal(context.REPORTS.find(report => report.id === 'private-1').authenticated, true);
  assert.equal(context.REPORTS.find(report => report.id === 'public-1').authenticated, false);
});

test('a late private response merges with public entries that completed first', async () => {
  const { context, calls, respond, ids } = setup();
  const publicLoad = context.loadPublicEntries();
  const privateLoad = context.loadPrivateEntries();
  respond(calls[0], [entry('public-1', false, '2026-03-01')]);
  await publicLoad;
  respond(calls[1], [entry('private-1', true, '2026-03-02')]);
  await privateLoad;

  assert.deepEqual(ids(), ['private-1', 'public-1']);
  assert.equal(context.REPORTS.length, 2);
});

test('repeated private refreshes replace the private set without duplicates', async () => {
  const { context, calls, respond, ids } = setup();
  const publicLoad = context.loadPublicEntries();
  respond(calls[0], [entry('public-1', false, '2026-03-01')]);
  await publicLoad;

  const firstPrivate = context.loadPrivateEntries();
  respond(calls[1], [entry('private-1', true, '2026-03-03'), entry('private-2', true, '2026-03-02')]);
  await firstPrivate;
  assert.deepEqual(ids(), ['private-1', 'private-2', 'public-1']);

  const secondPrivate = context.loadPrivateEntries();
  respond(calls[2], [entry('private-1', true, '2026-03-03')]);
  await secondPrivate;
  assert.deepEqual(ids(), ['private-1', 'public-1'], 'a removed private entry must disappear');

  const repeatedPrivate = context.loadPrivateEntries();
  respond(calls[3], [entry('private-1', true, '2026-03-03')]);
  await repeatedPrivate;
  assert.deepEqual(ids(), ['private-1', 'public-1'], 'refreshing the same private entry must not duplicate it');
});

test('a public refresh removes stale public entries but keeps private entries', async () => {
  const { context, calls, respond, ids } = setup();
  const privateLoad = context.loadPrivateEntries();
  respond(calls[0], [entry('private-1', true, '2026-03-02')]);
  await privateLoad;

  const firstPublic = context.loadPublicEntries();
  respond(calls[1], [entry('public-1', false, '2026-03-04'), entry('public-2', false, '2026-03-01')]);
  await firstPublic;
  assert.deepEqual(ids(), ['public-1', 'private-1', 'public-2']);

  const secondPublic = context.loadPublicEntries();
  respond(calls[2], [entry('public-2', false, '2026-03-01')]);
  await secondPublic;
  assert.deepEqual(ids(), ['private-1', 'public-2'], 'only the public set may be replaced by a public refresh');
});

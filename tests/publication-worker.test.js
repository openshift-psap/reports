'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { fixture } = require('./helpers/publication-fixture');

function worker(service) {
  const logs = [];
  const context = { exports: {}, console: { log: value => logs.push(JSON.parse(value)) },
    require: () => ({ publication: () => service }) };
  vm.runInNewContext(fs.readFileSync('_infra/lambda-token-admin/reconcile.js', 'utf8'), context);
  return { run: context.exports.handler, logs };
}
const key = 'report-reconciliation-v2/checkpoint.json';

test('worker resumes checkpoint after runtime boundary and records a completed scan', async () => {
  const f = fixture(), cursors = [];
  const w = worker({ store: f.store, reconcile: async cursor => {
    cursors.push(cursor); return { cursor: cursor ? null : 'page-two' };
  } });
  await w.run({}, { getRemainingTimeInMillis: () => 10000 });
  assert.equal(f.documents.get(key).value.cursor, 'page-two');
  assert.equal(f.documents.get(key).value.lastFullScan, null);
  await w.run({}, { getRemainingTimeInMillis: () => 900000 });
  assert.deepEqual(cursors, [null, 'page-two']);
  assert.equal(f.documents.get(key).value.cursor, null);
  assert.ok(w.logs.at(-1).lastFullScan);
});

test('worker replays page after failure before checkpoint and resumes after a lost write response', async () => {
  for (const lostResponse of [false, true]) {
    const f = fixture(), cursors = [];
    await f.store.put(key, { cursor: null, lastFullScan: null });
    const w = worker({ store: f.store, reconcile: async cursor => {
      cursors.push(cursor); return { cursor: cursor ? null : 'next' };
    } });
    const hook = lostResponse ? 'afterPut' : 'beforePut';
    f.hooks[hook] = (written, value) => { if (written === key && value.cursor === 'next') throw new Error('interrupted'); };
    await assert.rejects(w.run({}, { getRemainingTimeInMillis: () => 10000 }), /interrupted/);
    assert.equal(w.logs.length, 0);
    delete f.hooks[hook];
    await w.run({}, { getRemainingTimeInMillis: () => 10000 });
    assert.deepEqual(cursors, [null, lostResponse ? 'next' : null]);
  }
});

test('worker bootstraps before missing-key reads and never swallows denied writes', async () => {
  const f = fixture();
  f.hooks.get = requested => {
    if (requested === key && !f.documents.has(key)) throw Object.assign(new Error('denied'), { $metadata: { httpStatusCode: 403 } });
  };
  const w = worker({ store: f.store, reconcile: async () => ({ cursor: null }) });
  await w.run({});
  const before = structuredClone(f.documents.get(key));
  f.hooks.beforePut = () => { throw Object.assign(new Error('denied'), { $metadata: { httpStatusCode: 403 } }); };
  await assert.rejects(w.run({}), /denied/);
  assert.deepEqual(f.documents.get(key), before);
});

test('worker bounds scans to twenty pages and does not advance on listing failure', async () => {
  const f = fixture(); let pages = 0;
  const w = worker({ store: f.store, reconcile: async () => ({ cursor: String(++pages) }) });
  await w.run({}, { getRemainingTimeInMillis: () => 900000 });
  assert.equal(pages, 20);
  const before = structuredClone(f.documents.get(key));
  const failing = worker({ store: f.store, reconcile: async () => { throw new Error('list unavailable'); } });
  await assert.rejects(failing.run({}), /list unavailable/);
  assert.deepEqual(f.documents.get(key), before);
});

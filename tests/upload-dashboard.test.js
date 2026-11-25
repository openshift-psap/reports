'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const template = fs.readFileSync('_generator/generate_index.py', 'utf8');

class Element {
  constructor() { this.children = []; this.value = ''; this.style = {}; this.listeners = {}; }
  set textContent(value) { this.text = value; this.children = []; }
  get textContent() { return this.text; }
  appendChild(child) { this.children.push(child); }
  addEventListener(event, fn) { this.listeners[event] = fn; }
}
function setup() {
  const elements = new Map(), calls = [];
  const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const row = { id: 'upload', title: '<script>unsafe</script>', access: 'internal', category: 'ci', state: 'OPEN', entryFile: 'site/index.html',
    createdAt: Date.now(), retainUntil: Date.now() + 604800000, uploadUrlsExpireAt: Date.now() + 900000,
    resumeUntil: Date.now() + 6 * 60 * 60 * 1000, canResume: true,
    expectedFiles: 2, expectedBytes: 10, observedFiles: null, observedBytes: null, missing: null, mismatched: null, cleanup: null };
  let response = { uploads: [row], cursor: 'next-page', enabled: true }, failure = false;
  const context = { currentGithubHandle: 'owner', TOKEN_API: 'https://api.example',
    document: { getElementById: get, createElement: () => new Element() },
    fetch: async url => { calls.push(url); if (failure) throw new Error('network unavailable'); return { ok: true, json: async () => response }; },
  };
  vm.createContext(context);
  vm.runInContext(template.slice(template.indexOf('let incompleteUploads ='), template.indexOf('async function initAdmin(')), context);
  return { context, get, row, calls, respond: data => { response = data; }, fail: () => { failure = true; } };
}

test('dashboard renders text safely, exposes pagination, and retains rows after network errors', async () => {
  const f = setup(); await f.context.loadIncompleteUploads();
  const card = f.get('upload-list').children[0];
  assert.equal(card.children[0].textContent, '<script>unsafe</script>');
  assert.match(card.children[2].textContent, /Unknown/);
  assert.equal(f.get('upload-list-more').hidden, false);
  f.respond({ uploads: [], cursor: 'another-page', enabled: true });
  await f.context.loadIncompleteUploads(true);
  assert.match(f.calls.at(-1), /cursor=next-page/);
  assert.equal(f.get('upload-list').children.length, 1);
  assert.equal(f.get('upload-list-more').hidden, false, 'empty page is not end of scan');
  f.fail(); await f.context.loadIncompleteUploads();
  assert.equal(f.get('upload-list').children.length, 1);
  assert.match(f.get('upload-list-status').textContent, /retained/);
});

test('inspection refreshes missing files and explains bounded CLI recovery without a staged preview', async () => {
  const f = setup(); await f.context.loadIncompleteUploads();
  f.respond({ uploads: [{ ...f.row, observedFiles: 1, observedBytes: 5, missing: ['site/assets/app.js'], mismatched: [] }] });
  await f.get('upload-list').children[0].children[4].listeners.click();
  assert.match(f.calls.at(-1), /uploads\?id=upload/);
  const card = f.get('upload-list').children[0];
  assert.match(card.children[2].textContent, /1 files \/ 5 bytes/);
  assert.match(card.children[3].textContent, /site\/assets\/app.js/);
  assert.match(card.children.at(-1).textContent, /--resume upload/);
  assert.match(card.children.at(-1).textContent, /does not extend the six-hour deadline/);
});

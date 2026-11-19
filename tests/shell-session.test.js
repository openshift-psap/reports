'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');

const template = fs.readFileSync('_generator/generate_index.py', 'utf8');
const start = template.indexOf('async function initAdmin(');
const end = template.indexOf('\nfunction initReportTagPicker(', start);
const initAdminSource = template.slice(start, end);

class Element {
  constructor() {
    this.value = '';
    this.textContent = '';
    this.innerHTML = '';
    this.hidden = false;
    this.style = {};
    this.dataset = {};
    this.placeholder = '';
    this.href = '';
    this.disabled = false;
    this.listeners = {};
  }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  scrollIntoView() {}
}

function setup(responses) {
  assert.ok(start > -1 && end > start, 'initAdmin must stay extractable for the session regression test');
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  get('admin-panel').hidden = true;
  const calls = [];
  const context = {
    document: { getElementById: get },
    window: { location: { search: '' } },
    TOKEN_API: 'https://api.example',
    URLSearchParams,
    requestAnimationFrame: fn => fn(),
    fetch: async url => {
      calls.push({ url });
      const next = responses.shift();
      if (!next) throw new Error(`unexpected fetch: ${url}`);
      return next;
    },
    render: () => calls.push({ url: 'render' }),
    loadPrivateEntries: async () => calls.push({ url: 'loadPrivateEntries' }),
    renderTokenTable: tokens => calls.push({ url: 'renderTokenTable', tokens }),
    initReportTagPicker: () => calls.push({ url: 'initReportTagPicker' }),
    initReportUpload: () => calls.push({ url: 'initReportUpload' }),
  };
  vm.createContext(context);
  vm.runInContext('let currentGithubHandle = ""; let isAuthenticated = false;', context);
  vm.runInContext(initAdminSource, context);
  return { context, get, calls };
}

test('view-only Google sessions hide submission UI and never fetch token administration', async () => {
  const { context, get, calls } = setup([
    { ok: true, json: async () => ({ method: 'google', email: 'viewer@redhat.com', githubHandle: null, viewOnly: true }) },
  ]);

  await context.initAdmin();

  assert.deepEqual(calls.map(call => call.url), ['https://api.example/session', 'render', 'loadPrivateEntries']);
  assert.equal(vm.runInContext('isAuthenticated', context), true);
  assert.equal(vm.runInContext('currentGithubHandle', context), '');
  assert.equal(get('auth-status').textContent, 'Signed in as viewer@redhat.com (view only)');
  assert.equal(get('signin-link').hidden, true);
  assert.equal(get('signout-link').hidden, false);
  assert.equal(get('submit-link').hidden, true);
  assert.equal(get('submit-signin').hidden, true);
  assert.equal(get('admin-panel').hidden, true, 'view-only sessions must not open the admin panel');
  assert.equal(get('token-generate-btn').listeners.click, undefined, 'token controls must not be bound for view-only sessions');
});

test('GitHub sessions keep token administration after the session check', async () => {
  const { context, get, calls } = setup([
    { ok: true, json: async () => ({ method: 'github', email: null, githubHandle: 'owner', viewOnly: false }) },
    { ok: true, json: async () => ({ tokens: [{ id: 'psap_rht_abc...', group: 'everyone' }] }) },
  ]);

  await context.initAdmin();

  assert.deepEqual(calls.map(call => call.url), [
    'https://api.example/session',
    'https://api.example/tokens',
    'renderTokenTable',
    'render',
    'loadPrivateEntries',
    'initReportTagPicker',
    'initReportUpload',
  ]);
  assert.equal(get('admin-panel').hidden, false);
  assert.equal(get('auth-status').textContent, 'Signed in as owner');
  assert.equal(get('submit-link').hidden, false);
  assert.equal(get('submit-link').href, '#admin-panel');
  assert.equal(get('report-author').value, 'owner');
  assert.equal(get('report-upload-form').hidden, false);
  assert.deepEqual(calls.find(call => call.url === 'renderTokenTable').tokens, [
    { id: 'psap_rht_abc...', group: 'everyone' },
  ]);
});

test('access-token sessions retain their existing limited shell behavior', async () => {
  const { context, get, calls } = setup([
    { ok: true, json: async () => ({ method: 'token', email: null, githubHandle: null, viewOnly: false }) },
    { ok: true, json: async () => ({ tokens: [] }) },
  ]);

  await context.initAdmin();

  assert.equal(get('auth-status').textContent, 'Signed in with access token');
  assert.equal(get('report-upload-form').hidden, true);
  assert.equal(get('report-oauth-required').hidden, false);
  assert.equal(get('report-author').placeholder, 'GitHub sign-in required to submit');
  assert.equal(calls.filter(call => call.url.endsWith('/tokens')).length, 1);
});

test('a failed session check still leaves the shell unauthenticated', async () => {
  const { context, get, calls } = setup([{ ok: false, json: async () => ({ error: 'Not authenticated' }) }]);

  await context.initAdmin();

  assert.deepEqual(calls, [{ url: 'https://api.example/session' }]);
  assert.equal(vm.runInContext('isAuthenticated', context), false);
  assert.equal(get('admin-panel').hidden, true);
  assert.equal(get('signin-link').hidden, false);
});

test('the shell links the recovered interim privacy page without changing its wording', () => {
  assert.match(template, /<footer>Generated __GENERATED_AT__ &middot; __REPORT_COUNT__ reports indexed &middot; <a href="\/privacy.html">Privacy Policy<\/a><\/footer>/);
  const privacy = fs.readFileSync('privacy.html', 'utf8');
  assert.match(privacy, /<h1>Privacy and Use Policy<\/h1>/);
  assert.match(privacy, /Interim policy · Updated October 20, 2026/);
  assert.match(privacy, /https:\/\/github\.com\/openshift-psap\/reports\/issues\/7/);
  // Exact deployed interim page: issue #7 owns any future wording change.
  assert.equal(crypto.createHash('sha256').update(privacy).digest('hex'), '4e371b5bdd33b410f9ee8a0f40036bd3018c1851f3ecba532f086518e440aaa3');
});

test('the existing deploy workflow uploads and invalidates the privacy page without adding new infrastructure automation', () => {
  const workflow = fs.readFileSync('.github/workflows/deploy.yml', 'utf8');
  assert.match(workflow, /aws s3 cp privacy\.html "s3:\/\/\$\{BUCKET\}\/privacy\.html" --content-type text\/html --cache-control no-store/);
  assert.match(workflow, /--paths \/ \/index\.html \/admin\/index\.html \/public-reports\.json \/privacy\.html/);
  // Scope stays on the existing shell upload; no new Lambda/CI job is introduced.
  assert.doesNotMatch(workflow, /lambda/i);
});

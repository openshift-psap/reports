'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const template = fs.readFileSync('_generator/generate_index.py', 'utf8');
const workstreams = JSON.parse(fs.readFileSync('_generator/workstreams.json')).workstreams;

test('save and cancel share a compact action row and base button styling', () => {
  const actions = template.match(/<div class="report-form-actions">([\s\S]*?)<\/div>/);
  assert.ok(actions, 'Form actions must stay together rather than fill separate grid columns');
  assert.match(actions[1], /id="report-upload-btn"[^>]*class="report-form-button"/);
  assert.match(actions[1], /id="report-cancel-update"[^>]*class="report-form-button report-form-button-secondary"[^>]*hidden/);
  assert.ok(actions[1].indexOf('report-upload-btn') < actions[1].indexOf('report-cancel-update'));
  assert.match(template, /\.report-form-actions\{[^}]*display:flex;[^}]*gap:/);
});

test('update mode exposes two labelled native radio choices, defaulting to info only', () => {
  const modes = template.match(/<fieldset id="report-update-mode-label"[\s\S]*?<\/fieldset>/);
  assert.ok(modes);
  assert.equal((modes[0].match(/type="radio" name="report-update-mode"/g) || []).length, 2);
  assert.match(modes[0], /id="report-update-metadata"[^>]*checked/);
  assert.match(modes[0], /id="report-update-replacement"/);
  assert.doesNotMatch(modes[0], /<select/);
});

class Element {
  constructor() {
    this.value = ''; this.dataset = {}; this.style = {}; this.children = [];
    this.listeners = {}; this.attributes = {}; this.files = []; this.hidden = false;
    this.classList = { toggle() {} };
  }
  set innerHTML(value) { this.children = []; }
  appendChild(child) { this.children.push(child); }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  setAttribute(name, value) { this.attributes[name] = value; }
  querySelectorAll() { return this.children.flatMap(child => child.children); }
  scrollIntoView() {}
}

function setup(report = {}) {
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const calls = [];
  const context = {
    document: { getElementById: get, createElement: () => new Element(), addEventListener() {} },
    window: { location: { origin: 'https://reports.example' } },
    WORKSTREAMS: workstreams, getAllTags: () => ['rhoai', 'gpu'],
    loadPublicEntries: async () => {}, loadPrivateEntries: async () => {},
    fetch: async (url, options) => {
      calls.push({ url, ...options });
      return { ok: true, json: async () => ({ external: true }) };
    },
  };
  vm.createContext(context);
  vm.runInContext('let updatingReport = null; const selectedReportTags = new Set(); const TOKEN_API = "https://api.example"; const CF_DOMAIN = "reports.example";', context);
  context.REPORTS = [{ id: 'abc123', title: 'Original', category: 'ci', tags: ['RHOAI', 'gpu'], authenticated: true, version: 2, ...report }];
  vm.runInContext(template.slice(template.indexOf('function updateReport('), template.indexOf('async function deleteReport(')), context);
  vm.runInContext(template.slice(template.indexOf('function initReportTagPicker('), template.indexOf('function renderTokenTable(')), context);
  get('report-author').value = 'owner';
  get('report-update-metadata').checked = true;
  get('report-update-replacement').checked = false;
  get('report-upload-form').reset = () => {
    for (const element of elements.values()) element.value = '';
    get('report-source').value = 'upload';
    get('report-access').value = 'authenticated';
    get('report-update-metadata').checked = true;
    get('report-update-replacement').checked = false;
  };
  context.initReportTagPicker();
  context.initReportUpload();
  const buttons = () => get('report-workstreams').querySelectorAll().filter(child => child.dataset.workstreamTag);
  const tags = () => JSON.parse(vm.runInContext('JSON.stringify([...selectedReportTags])', context));
  const submit = () => get('report-upload-form').listeners.submit({ preventDefault() {} });
  return { context, get, calls, buttons, tags, submit };
}

test('visible workstream choices use configured matching tags and toggle ordinary tags', () => {
  const { buttons, tags, get } = setup();
  assert.deepEqual(buttons().map(button => button.textContent), workstreams.flatMap(item => item.match_tags));
  const button = buttons()[0];
  button.listeners.click();
  assert.deepEqual(tags(), ['rhoai']);
  assert.equal(button.attributes['aria-pressed'], 'true');
  assert.equal(get('report-workstream-reminder').hidden, true);
  button.listeners.click();
  assert.deepEqual(tags(), []);
  assert.equal(get('report-workstream-reminder').hidden, false);
});

test('edit preselects case-insensitive workstreams and tag removal synchronizes chips', () => {
  const { context, get, buttons, tags } = setup();
  context.updateReport('abc123');
  assert.equal(buttons()[0].attributes['aria-pressed'], 'true');
  get('report-selected-tags').children[0].listeners.click();
  assert.deepEqual(tags(), ['gpu']);
  assert.equal(buttons()[0].attributes['aria-pressed'], 'false');
});

test('metadata edit defaults to retaining files and PATCHes only editable fields', async () => {
  const { context, get, calls, submit, tags } = setup();
  context.updateReport('abc123');
  assert.equal(get('report-update-metadata').checked, true);
  assert.equal(get('report-update-replacement').checked, false);
  assert.equal(get('report-file-label').hidden, true);
  assert.equal(get('report-source').disabled, true);
  assert.equal(get('report-access').disabled, true);
  assert.equal(get('report-upload-btn').textContent, 'Save report info');
  get('report-title').value = 'Edited';
  await submit();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'PATCH');
  assert.match(calls[0].url, /access=authenticated&id=abc123/);
  assert.deepEqual(JSON.parse(calls[0].body), { action: 'metadata', title: 'Edited', category: 'ci', tags: ['RHOAI', 'gpu'], description: '' });
  assert.equal(get('report-author').value, 'owner');
  assert.equal(get('report-source').disabled, false);
  assert.equal(get('report-access').disabled, false);
  assert.equal(get('report-update-mode-label').hidden, true);
  assert.deepEqual(tags(), []);
});

test('switching to replacement retains upload revision behavior', async () => {
  const { context, get, calls, submit } = setup();
  context.fetch = async (url, options) => {
    calls.push({ url, ...options });
    return { ok: true, json: async () => options.method === 'POST' && url.endsWith('/reports') ? { id: 'revision-id', uploads: [{ name: 'new.html', url: 'https://upload.example/new' }] } : {} };
  };
  context.updateReport('abc123');
  get('report-update-metadata').checked = false;
  get('report-update-replacement').checked = true;
  get('report-update-replacement').listeners.change();
  assert.equal(get('report-file-label').hidden, false);
  assert.equal(get('report-source').disabled, false);
  assert.equal(get('report-upload-btn').textContent, 'Publish revision 3');
  get('report-files').files = [{ name: 'new.html', size: 12, type: 'text/html' }];
  await submit();
  assert.equal(calls[0].method, 'POST');
  const payload = JSON.parse(calls[0].body);
  assert.equal(payload.parentId, 'abc123');
  assert.equal(payload.entryFile, 'new.html');
  assert.equal(calls[1].method, 'PUT');
  assert.equal(calls[1].url, 'https://upload.example/new');
  assert.equal(calls[2].method, 'POST');
  assert.match(calls[2].url, /revision-id\/complete$/);
  assert.equal(get('report-upload-btn').textContent, 'Upload report');
});

test('external report edits retain the link and cancel resets the form', () => {
  const { context, get, tags } = setup({ externalUrl: 'https://external.example/report' });
  context.updateReport('abc123');
  assert.equal(get('report-external-url').hidden, true);
  assert.equal(get('report-external-url').disabled, true);
  assert.equal(get('report-external-url').value, 'https://external.example/report');
  get('report-update-metadata').checked = false;
  get('report-update-replacement').checked = true;
  get('report-update-replacement').listeners.change();
  assert.equal(get('report-external-url').hidden, false);
  assert.equal(get('report-external-url').disabled, false);
  get('report-cancel-update').listeners.click();
  assert.equal(get('report-file-label').hidden, false);
  assert.equal(get('report-external-url').hidden, true);
  assert.equal(get('report-upload-btn').textContent, 'Upload report');
  assert.deepEqual(tags(), []);
});

test('failed metadata save retains form and allows retry', async () => {
  const { context, get, submit } = setup();
  context.updateReport('abc123');
  context.fetch = async () => ({ ok: false, json: async () => ({ error: 'This is no longer the current revision' }) });
  await submit();
  assert.equal(get('report-upload-status').textContent, 'This is no longer the current revision');
  assert.equal(get('report-title').value, 'Original');
  assert.equal(get('report-upload-btn').disabled, false);
  assert.equal(get('report-update-mode-label').hidden, false);
});

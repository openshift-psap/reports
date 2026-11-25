'use strict';

// Runs bin/psap-report against a local mock API. No GitHub login, cloud
// credentials, S3 access, or real uploads are involved.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const repo = path.resolve(__dirname, '..');
const python = process.env.PYTHON || 'python3';
const hasPython = spawnSync(python, ['--version'], { stdio: 'ignore' }).status === 0;

function writeFile(root, relative, content) {
  const target = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function makeBundle(apiUrl) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'psap-cli-'));
  fs.mkdirSync(path.join(root, 'bin'));
  fs.copyFileSync(path.join(repo, 'bin', 'psap-report'), path.join(root, 'bin', 'psap-report'));
  fs.copyFileSync(path.join(repo, 'bin', 'psap_report.py'), path.join(root, 'bin', 'psap_report.py'));
  fs.chmodSync(path.join(root, 'bin', 'psap-report'), 0o755);
  fs.mkdirSync(path.join(root, '_generator'));
  fs.writeFileSync(path.join(root, '_generator', 's3_config.json'), JSON.stringify({
    cli_report_api_url: apiUrl, github_client_id: 'mock-client',
  }));
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.config', 'psap-report'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'psap-report', 'github-oauth.json'), JSON.stringify({ access_token: 'mock-token' }));
  fs.chmodSync(path.join(home, '.config', 'psap-report', 'github-oauth.json'), 0o600);
  return { root, home, cli: path.join(root, 'bin', 'psap-report') };
}

function normalizeForLegacy(files) {
  const names = files.map(file => file.name);
  const roots = names.map(name => name.split('/')[0]);
  if (roots.length && roots.every(root => root === roots[0]) && names.every(name => name.includes('/'))) {
    return names.map(name => name.slice(name.indexOf('/') + 1));
  }
  return names;
}

function startMock({ echoPathMode = true } = {}) {
  const state = { plan: null, uploads: [], completes: 0, errors: [] };
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks);
      const send = (status, payload) => {
        const encoded = JSON.stringify(payload);
        response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded) });
        response.end(encoded);
      };
      if (request.method === 'POST' && request.url.endsWith('/reports')) {
        const plan = JSON.parse(body.toString() || '{}');
        state.plan = plan;
        const files = Array.isArray(plan.files) ? plan.files : [];
        const pathMode = plan.pathMode === 'preserve' ? 'preserve' : 'strip';
        const names = pathMode === 'preserve' ? files.map(file => file.name) : normalizeForLegacy(files);
        if (!plan.entryFile || !names.includes(plan.entryFile)) {
          state.errors.push('entryFile must be one of the uploaded files');
          send(400, { error: 'entryFile must be one of the uploaded files' });
          return;
        }
        const uploads = names.map(name => ({
          name,
          url: `http://127.0.0.1:${server.address().port}/upload/${encodeURIComponent(name)}`,
        }));
        send(201, echoPathMode ? { id: 'mock-id', pathMode, uploads } : { id: 'mock-id', uploads });
        return;
      }
      if (request.method === 'POST' && request.url.endsWith('/reports/mock-id/complete')) {
        state.completes += 1;
        send(201, { report: { path: 'https://reports.example/private/ci/2026-11-20_nested-mock-id/report/deck/report.html' } });
        return;
      }
      if (request.method === 'PUT' && request.url.startsWith('/upload/')) {
        const name = decodeURIComponent(request.url.slice('/upload/'.length));
        state.uploads.push({ name, content: body.toString() });
        response.writeHead(200);
        response.end();
        return;
      }
      send(404, { error: 'unexpected mock request' });
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, state, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

function runCli(cli, home, args) {
  return new Promise(resolve => {
    const child = spawn(python, [cli, ...args], { env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
}

async function withMock(options, fn) {
  const mock = await startMock(options);
  try { return await fn(mock); } finally { await new Promise(resolve => mock.server.close(resolve)); }
}

const skip = hasPython ? false : 'python3 is required for CLI integration tests';

test('CLI rejects an escaping symlink before any plan or upload', { skip }, async () => {
  await withMock({}, async ({ url, state }) => {
    const bundle = makeBundle(url);
    const source = path.join(bundle.root, 'source');
    writeFile(source, 'site/index.html', 'entry');
    writeFile(bundle.root, 'source-private/secret.html', 'do-not-publish');
    fs.symlinkSync('../../source-private/secret.html', path.join(source, 'site/leak.html'));
    const result = await runCli(bundle.cli, bundle.home, [
      source, '--entry-file', 'site/index.html', '--title', 'Report', '--category', 'ci',
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /site\/leak.html.*outside the upload root/);
    assert.doesNotMatch(result.stderr, /do-not-publish/);
    assert.equal(state.plan, null);
    assert.deepEqual(state.uploads, []);
    assert.equal(state.completes, 0);
  });
});

test('CLI preserves a nested source entry and uploads each original file to its signed target', { skip }, async () => {
  await withMock({}, async ({ url, state }) => {
    const bundle = makeBundle(url);
    const source = path.join(bundle.root, 'source');
    writeFile(source, 'site/index.html', 'nested-index');
    writeFile(source, 'site/assets/app.js', 'asset-js');
    writeFile(source, 'site/assets/style.css', 'asset-css');
    const result = await runCli(bundle.cli, bundle.home, [
      source, '--entry-file', 'site/index.html', '--title', 'Nested report', '--category', 'ci',
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(state.plan.pathMode, 'preserve');
    assert.equal(state.plan.entryFile, 'site/index.html');
    assert.deepEqual(state.plan.files.map(file => file.name).sort(), ['site/assets/app.js', 'site/assets/style.css', 'site/index.html']);
    assert.deepEqual(Object.fromEntries(state.uploads.map(upload => [upload.name, upload.content])), {
      'site/index.html': 'nested-index',
      'site/assets/app.js': 'asset-js',
      'site/assets/style.css': 'asset-css',
    });
    assert.equal(state.completes, 1);
    assert.match(result.stdout, /report\/deck\/report\.html/);
  });
});

test('CLI keeps a root entry and nested assets at their source paths', { skip }, async () => {
  await withMock({}, async ({ url, state }) => {
    const bundle = makeBundle(url);
    const source = path.join(bundle.root, 'source');
    writeFile(source, 'index.html', 'root-index');
    writeFile(source, 'assets/app.js', 'root-asset');
    const result = await runCli(bundle.cli, bundle.home, [
      source, '--entry-file', 'index.html', '--title', 'Root report', '--category', 'ci',
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(state.plan.pathMode, 'preserve');
    assert.equal(state.plan.entryFile, 'index.html');
    assert.deepEqual(state.uploads, [
      { name: 'index.html', content: 'root-index' },
      { name: 'assets/app.js', content: 'root-asset' },
    ]);
  });
});

test('CLI recovery sends the existing upload ID with corrected details and the full bundle', { skip }, async () => {
  await withMock({}, async ({ url, state }) => {
    const bundle = makeBundle(url);
    const source = path.join(bundle.root, 'source');
    writeFile(source, 'fixed.html', 'corrected');
    const result = await runCli(bundle.cli, bundle.home, [
      source, '--entry-file', 'fixed.html', '--title', 'Corrected', '--category', 'ci', '--resume', 'pending-id',
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(state.plan.resumeId, 'pending-id');
    assert.equal(state.plan.title, 'Corrected');
    assert.equal(state.uploads[0].content, 'corrected');
    assert.equal(state.completes, 1);
  });
});

test('CLI honors an explicit nested HTML entry when the bundle has several HTML files', { skip }, async () => {
  await withMock({}, async ({ url, state }) => {
    const bundle = makeBundle(url);
    const source = path.join(bundle.root, 'source');
    writeFile(source, 'report/index.html', 'other-index');
    writeFile(source, 'report/deck/report.html', 'chosen-entry');
    writeFile(source, 'report/assets/chart.png', 'png-bytes');
    const result = await runCli(bundle.cli, bundle.home, [
      source, '--entry-file', 'report/deck/report.html', '--title', 'Deck report', '--category', 'ci',
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(state.plan.entryFile, 'report/deck/report.html');
    assert.deepEqual(Object.fromEntries(state.uploads.map(upload => [upload.name, upload.content])), {
      'report/index.html': 'other-index',
      'report/deck/report.html': 'chosen-entry',
      'report/assets/chart.png': 'png-bytes',
    });
  });
});

test('CLI refuses a plan that does not confirm preserved paths before uploading', { skip }, async () => {
  await withMock({ echoPathMode: false }, async ({ url, state }) => {
    const bundle = makeBundle(url);
    const source = path.join(bundle.root, 'source');
    writeFile(source, 'site/index.html', 'nested-index');
    writeFile(source, 'site/assets/app.js', 'asset-js');
    const result = await runCli(bundle.cli, bundle.home, [
      source, '--entry-file', 'site/index.html', '--title', 'Nested report', '--category', 'ci',
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /pathMode/);
    assert.deepEqual(state.uploads, []);
    assert.equal(state.completes, 0);
  });
});

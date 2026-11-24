'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const template = fs.readFileSync('_generator/generate_index.py', 'utf8');
const source = template.slice(template.indexOf('function renderTokenTable('), template.indexOf('\ninit();', template.indexOf('function renderTokenTable(')));

function setup(responses) {
  const calls = [], alerts = [], tbody = {};
  const context = { TOKEN_API: '/api', document: { getElementById: () => tbody }, escHtml: s => s,
    confirm: () => true, alert: message => alerts.push(message),
    fetch: async (url, options) => {
      calls.push({ url, options });
      const response = responses.shift();
      if (response instanceof Error) throw response;
      assert.ok(response, 'unexpected fetch');
      return response;
    } };
  vm.runInNewContext(source, context);
  return { context, calls, alerts, tbody };
}

test('UI uses actionable prefix and refreshes the revoked token after successful DELETE', async () => {
  const token = { id: 'synthetic...', revokePrefix: 'synthetic', active: true, expires: '2099-01-01', group: '', note: '', created: '' };
  const f = setup([{ ok: true }, { ok: true, json: async () => ({ tokens: [{ ...token, active: false }] }) }]);
  f.context.renderTokenTable([token]);
  assert.match(f.tbody.innerHTML, /revokeToken\('synthetic'\)/);
  await f.context.revokeToken(token.revokePrefix);
  assert.equal(JSON.parse(f.calls[0].options.body).prefix, 'synthetic');
  assert.equal(f.calls[0].options.method, 'DELETE');
  assert.match(f.tbody.innerHTML, /Revoked/);
  assert.doesNotMatch(f.tbody.innerHTML, /revokeToken\(/);
  assert.deepEqual(f.alerts, []);
});

test('UI shows DELETE failures without silently refreshing the list', async () => {
  for (const response of [
    { ok: false, status: 404, json: async () => ({ error: 'No matching active tokens' }) },
    { ok: false, status: 502, json: async () => { throw new Error('not JSON'); } },
    new Error('Network failed'),
  ]) {
    const f = setup([response]);
    await f.context.revokeToken('synthetic');
    assert.equal(f.calls.length, 1);
    assert.equal(f.alerts.length, 1);
    assert.match(f.alerts[0], /No matching active tokens|502|Network failed/);
  }
});

test('UI distinguishes successful revocation from a failed list refresh', async () => {
  for (const response of [
    { ok: false },
    new Error('Network failed'),
    { ok: true, json: async () => { throw new Error('Invalid JSON'); } },
    { ok: true, json: async () => ({ tokens: null }) },
  ]) {
    const f = setup([{ ok: true }, response]);
    f.tbody.innerHTML = '<button>Revoke</button>';
    await f.context.revokeToken('synthetic');
    assert.match(f.alerts[0], /Token revoked, but the list could not be refreshed/);
    assert.doesNotMatch(f.tbody.innerHTML, /<button/);
    assert.equal(f.calls.length, 2, 'never retry the successful DELETE');
  }
});

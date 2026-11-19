'use strict';

// Run with node --test tests/*.test.js; no AWS credentials or installed
// packages are needed. Google's OAuth client and S3 are stubbed in-memory.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const querystring = require('node:querystring');

const AUTH_SOURCE = fs.readFileSync('_infra/lambda-auth/index.js', 'utf8');
const TOKEN_ADMIN_SOURCE = fs.readFileSync('_infra/lambda-token-admin/index.js', 'utf8');
const GOOGLE_CLIENT_ID = 'test-google-client';
const GOOGLE_CLIENT_SECRET = 'test-google-secret';
const CANONICAL_DOMAIN = 'reports.example';
const COOKIE_SECRET = 'test-secret';

function sign(value, secret = COOKIE_SECRET) {
  return `${value}.${crypto.createHmac('sha256', secret).update(value).digest('base64url')}`;
}

function authCookie(method, subject, issuedAt = Date.now()) {
  const value = `authenticated:${method}:${issuedAt}${subject ? `:${subject}` : ''}`;
  return `psap_auth=${sign(value)}`;
}

function event(uri, { method = 'GET', query = '', headers = {} } = {}) {
  const cfHeaders = {};
  for (const [key, value] of Object.entries(headers)) cfHeaders[key] = [{ key, value }];
  return { Records: [{ cf: { request: { uri, method, querystring: query, headers: cfHeaders } } }] };
}

function loadAuth({ enableGoogle = true } = {}) {
  const instances = [];
  let claims = {};
  let tokenFailure = false;
  const logs = [];

  class FakeOAuth2Client {
    constructor(clientId, clientSecret, redirectUri) {
      this.clientId = clientId;
      this.clientSecret = clientSecret;
      this.redirectUri = redirectUri;
      this.tokenOptions = null;
      this.verifyOptions = null;
      instances.push(this);
    }
    generateAuthUrl(options) {
      this.authUrlOptions = options;
      return `https://accounts.google.com/o/oauth2/v2/auth?${querystring.stringify({
        client_id: this.clientId,
        redirect_uri: this.redirectUri,
        response_type: 'code',
        scope: options.scope.join(' '),
        state: options.state,
        nonce: options.nonce,
        hd: options.hd,
        prompt: options.prompt,
        code_challenge: options.code_challenge,
        code_challenge_method: options.code_challenge_method,
      })}`;
    }
    async getToken(options) {
      this.tokenOptions = options;
      if (tokenFailure) throw new Error('token exchange failed');
      return { tokens: { id_token: 'fake-id-token' } };
    }
    async verifyIdToken(options) {
      this.verifyOptions = options;
      return { getPayload: () => claims };
    }
  }

  let source = AUTH_SOURCE
    .replace(/__GITHUB_CLIENT_ID__/g, 'test-github-client')
    .replace(/__GITHUB_CLIENT_SECRET__/g, 'test-github-secret')
    .replace(/__COOKIE_SECRET__/g, COOKIE_SECRET)
    .replace(/__S3_BUCKET__/g, 'test-bucket')
    .replace(/__S3_REGION__/g, 'us-east-1')
    .replace(/__CANONICAL_DOMAIN__/g, CANONICAL_DOMAIN);
  if (enableGoogle) {
    source = source
      .replace(/__GOOGLE_CLIENT_ID__/g, GOOGLE_CLIENT_ID)
      .replace(/__GOOGLE_CLIENT_SECRET__/g, GOOGLE_CLIENT_SECRET);
  }

  const context = {
    exports: {},
    Buffer,
    URL,
    console: { log: entry => logs.push(entry) },
    require(name) {
      if (name === 'google-auth-library') return { OAuth2Client: FakeOAuth2Client };
      if (name === '@aws-sdk/client-s3') {
        return {
          S3Client: class { async send() { return { Body: { transformToString: async () => '{}' } }; } },
          GetObjectCommand: class {},
        };
      }
      return require(name);
    },
  };
  vm.runInNewContext(source, context);
  return {
    handler: context.exports.handler,
    instances,
    logs,
    setClaims: value => { claims = value; },
    setTokenFailure: value => { tokenFailure = value; },
  };
}

async function startGoogle(handler, returnPath = '/private/ci/report.html') {
  const response = await handler(event('/_auth/google', {
    query: `state=${encodeURIComponent(returnPath)}`,
    headers: { host: CANONICAL_DOMAIN },
  }));
  const location = response.headers.location[0].value;
  const query = querystring.parse(location.split('?')[1]);
  const setCookie = response.headers['set-cookie'][0].value;
  const cookie = setCookie.split(';')[0];
  const signedFlow = cookie.substring(cookie.indexOf('=') + 1);
  const encodedFlow = signedFlow.substring(0, signedFlow.lastIndexOf('.'));
  const flow = JSON.parse(Buffer.from(encodedFlow, 'base64url').toString('utf8'));
  return { response, location, query, setCookie, cookie, flow };
}

async function callback(handler, flowCookie, state, extraQuery = '') {
  return handler(event('/_auth/google/callback', {
    query: `state=${encodeURIComponent(state)}&code=auth-code${extraQuery}`,
    headers: { host: CANONICAL_DOMAIN, cookie: flowCookie },
  }));
}

function validClaims(flow) {
  return {
    nonce: flow.nonce,
    email: 'viewer@redhat.com',
    email_verified: true,
    hd: 'redhat.com',
  };
}

function assertRejectedAuth(response, logs) {
  assert.equal(response.status, '200');
  assert.match(response.body, /Google sign-in failed/);
  const cookies = response.headers['set-cookie'] || [];
  assert.ok(cookies.every(cookie => !cookie.value.startsWith('psap_auth=')), 'failed sign-in must not set a session');
  assert.ok(cookies.some(cookie => cookie.value.startsWith('psap_google_flow=;')), 'failed sign-in must clear the flow cookie');
  assert.equal(logs.length, 0, 'provider errors, codes, tokens, and claims must not be logged');
}

test('Google start creates a signed S256 PKCE transaction with state and nonce', async () => {
  const { handler, instances } = loadAuth();
  const { response, query, setCookie, flow } = await startGoogle(handler);

  assert.equal(response.status, '302');
  assert.equal(query.client_id, GOOGLE_CLIENT_ID);
  assert.equal(query.redirect_uri, `https://${CANONICAL_DOMAIN}/_auth/google/callback`);
  assert.equal(query.response_type, 'code');
  assert.equal(query.scope, 'openid email');
  assert.equal(query.hd, 'redhat.com');
  assert.equal(query.prompt, 'select_account');
  assert.equal(query.code_challenge_method, 'S256');
  assert.equal(query.state, flow.state);
  assert.equal(query.nonce, flow.nonce);
  assert.equal(flow.returnPath, '/private/ci/report.html');
  assert.ok(flow.expires > Date.now());
  assert.equal(query.code_challenge, crypto.createHash('sha256').update(flow.verifier).digest('base64url'));
  assert.equal(instances[0].clientSecret, GOOGLE_CLIENT_SECRET);
  assert.match(setCookie, /Path=\/_auth\/google\/callback/);
  assert.match(setCookie, /Max-Age=600/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
});

test('Google callback verifies the transaction and issues a view-only session', async () => {
  const { handler, instances, setClaims } = loadAuth();
  const started = await startGoogle(handler);
  setClaims(validClaims(started.flow));

  const response = await callback(handler, started.cookie, started.flow.state);
  assert.equal(response.status, '302');
  assert.equal(response.headers.location[0].value, '/private/ci/report.html');
  assert.equal(response.headers['cache-control'][0].value, 'no-store');

  const cookies = response.headers['set-cookie'];
  const session = cookies.find(cookie => cookie.value.startsWith('psap_auth='));
  assert.ok(session);
  const signedValue = session.value.split(';')[0].substring('psap_auth='.length);
  const value = signedValue.substring(0, signedValue.lastIndexOf('.'));
  assert.equal(signedValue, sign(value));
  assert.match(value, /^authenticated:google:\d+:viewer@redhat\.com$/);
  assert.ok(cookies.some(cookie => cookie.value.startsWith('psap_google_flow=;')));

  assert.equal(instances[1].tokenOptions.code, 'auth-code');
  assert.equal(instances[1].tokenOptions.codeVerifier, started.flow.verifier);
  assert.equal(instances[1].verifyOptions.idToken, 'fake-id-token');
  assert.equal(instances[1].verifyOptions.audience, GOOGLE_CLIENT_ID);
});

test('Google callback rejects mismatched, expired, tampered, and ineligible transactions', async () => {
  {
    const { handler, setClaims, logs } = loadAuth();
    const started = await startGoogle(handler);
    setClaims(validClaims(started.flow));
    assertRejectedAuth(await callback(handler, started.cookie, 'different-state'), logs);
  }
  {
    const { handler, setClaims, logs } = loadAuth();
    const started = await startGoogle(handler);
    setClaims(validClaims(started.flow));
    assertRejectedAuth(await callback(handler, started.cookie, started.flow.state, '&error=access_denied'), logs);
  }
  {
    const { handler, setClaims, logs } = loadAuth();
    const started = await startGoogle(handler);
    setClaims(validClaims(started.flow));
    const response = await handler(event('/_auth/google/callback', {
      query: `state=${encodeURIComponent(started.flow.state)}`,
      headers: { host: CANONICAL_DOMAIN, cookie: started.cookie },
    }));
    assertRejectedAuth(response, logs);
  }
  {
    const { handler, setClaims, logs } = loadAuth();
    const started = await startGoogle(handler);
    setClaims(validClaims(started.flow));
    assertRejectedAuth(await callback(handler, 'psap_google_flow=tampered.0000', started.flow.state), logs);
  }
  {
    const { handler, setClaims, logs } = loadAuth();
    const started = await startGoogle(handler);
    const expired = { ...started.flow, expires: Date.now() - 1 };
    const encoded = Buffer.from(JSON.stringify(expired)).toString('base64url');
    setClaims(validClaims(expired));
    assertRejectedAuth(await callback(handler, `psap_google_flow=${sign(encoded)}`, expired.state), logs);
  }
  for (const claims of [
    { nonce: 'wrong-nonce', email: 'viewer@redhat.com', email_verified: true, hd: 'redhat.com' },
    { nonce: 'FLOW', email: 'viewer@redhat.com', email_verified: false, hd: 'redhat.com' },
    { nonce: 'FLOW', email: 'viewer@redhat.com', email_verified: true, hd: 'example.com' },
    { nonce: 'FLOW', email: 'viewer@example.com', email_verified: true, hd: 'redhat.com' },
    { nonce: 'FLOW', email: 'viewer@redhat.com', email_verified: true },
  ]) {
    const { handler, setClaims, logs } = loadAuth();
    const started = await startGoogle(handler);
    setClaims({ ...claims, nonce: claims.nonce === 'FLOW' ? started.flow.nonce : claims.nonce });
    assertRejectedAuth(await callback(handler, started.cookie, started.flow.state), logs);
  }
  {
    const { handler, setClaims, setTokenFailure, logs } = loadAuth();
    const started = await startGoogle(handler);
    setClaims(validClaims(started.flow));
    setTokenFailure(true);
    assertRejectedAuth(await callback(handler, started.cookie, started.flow.state), logs);
  }
});

test('Google readers are limited to view-only GETs and never reach token admin', async () => {
  const { handler } = loadAuth();
  const cookie = authCookie('google', 'viewer@redhat.com');

  for (const [method, uri] of [
    ['GET', '/private/ci/report.html'],
    ['HEAD', '/private/ci/report.html'],
    ['GET', '/admin/index.html'],
    ['GET', '/_admin-api/session'],
    ['GET', '/_admin-api/reports'],
  ]) {
    const request = await handler(event(uri, { method, query: 'access=authenticated', headers: { cookie } }));
    assert.equal(request.status, undefined, `${method} ${uri} should pass through`);
    assert.equal(request.uri, uri);
  }

  for (const [method, uri] of [
    ['GET', '/_admin-api/tokens'],
    ['POST', '/_admin-api/reports'],
    ['DELETE', '/_admin-api/reports'],
    ['PUT', '/private/ci/report.html'],
  ]) {
    const response = await handler(event(uri, { method, headers: { cookie } }));
    assert.equal(response.status, '403');
    assert.equal(response.body, 'Google sign-in provides view-only report access.');
    assert.equal(response.headers['cache-control'][0].value, 'no-store');
  }

  const github = await handler(event('/_admin-api/tokens', {
    method: 'POST',
    headers: { cookie: authCookie('github', 'owner') },
  }));
  assert.equal(github.status, undefined, 'GitHub sessions keep existing write access');
});

test('Google, GitHub, token, expired, and forged cookies keep their existing semantics', async () => {
  const { handler } = loadAuth();
  for (const uri of ['/', '/index.html', '/privacy.html', '/public/ci/report.html']) {
    const request = await handler(event(uri));
    assert.equal(request.status, undefined, `${uri} must remain public`);
  }

  const expired = Date.now() - 2 * 86400 * 1000;
  for (const cookie of [
    authCookie('google', 'viewer@redhat.com', expired),
    authCookie('github', 'owner', expired),
    'psap_auth=authenticated:github:123:owner.forged',
  ]) {
    const response = await handler(event('/private/ci/report.html', { headers: { cookie } }));
    assert.equal(response.status, '200');
    assert.match(response.body, /Sign in to PSAP Report Hub/);
    assert.match(response.body, /To upload reports/);
    assert.match(response.body, /openshift-psap/);
    assert.match(response.body, /href="\/privacy.html"/);
  }
});

test('raw CloudFront hosts redirect to the canonical domain', async () => {
  const { handler } = loadAuth();
  const response = await handler(event('/private/ci/report.html', {
    query: 'a=1',
    headers: { host: 'd111111abcdef8.cloudfront.net' },
  }));
  assert.equal(response.status, '301');
  assert.equal(response.headers.location[0].value, `https://${CANONICAL_DOMAIN}/private/ci/report.html?a=1`);
  assert.equal(response.headers['cache-control'][0].value, 'max-age=86400');

  const canonical = await handler(event('/private/ci/report.html', { headers: { host: CANONICAL_DOMAIN } }));
  assert.equal(canonical.status, '200', 'canonical host falls through to sign-in, not a redirect');
});

test('Google sign-in is disabled cleanly while placeholders remain', async () => {
  const { handler } = loadAuth({ enableGoogle: false });
  const page = await handler(event('/admin/index.html', { headers: { host: CANONICAL_DOMAIN } }));
  assert.equal(page.status, '200');
  assert.doesNotMatch(page.body, /Sign in with Google/);
  const google = await handler(event('/_auth/google', {
    query: 'state=%2F',
    headers: { host: CANONICAL_DOMAIN },
  }));
  assert.equal(google.status, '200');
  assert.doesNotMatch(google.body, /accounts\.google\.com/);
});

function loadTokenAdmin() {
  const commands = {};
  for (const name of ['GetObjectCommand', 'PutObjectCommand', 'DeleteObjectCommand', 'HeadObjectCommand', 'ListObjectsV2Command', 'DeleteObjectsCommand']) {
    commands[name] = class { constructor(input) { this.name = name; this.input = input; } };
  }
  commands.S3Client = class {
    async send(command) {
      if (command.name === 'ListObjectsV2Command') return { Contents: [] };
      if (command.name === 'GetObjectCommand') return { Body: { transformToString: async () => '{"tokens":{}}' } };
      return {};
    }
  };
  const context = {
    exports: {},
    process: { env: { COOKIE_SECRET, CLOUDFRONT_DOMAIN: CANONICAL_DOMAIN } },
    console,
    require(name) {
      if (name === '@aws-sdk/client-s3') return commands;
      if (name === '@aws-sdk/s3-request-presigner') return { getSignedUrl: async () => 'https://upload.example/' };
      return require(name);
    },
  };
  vm.runInNewContext(TOKEN_ADMIN_SOURCE, context);
  return context.exports.handler;
}

async function tokenAdminRequest(handler, { method = 'GET', path = '/session', cookie, query = {}, body } = {}) {
  const response = await handler({
    httpMethod: method,
    path,
    headers: cookie ? { cookie } : {},
    queryStringParameters: query,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { ...response, data: response.body ? JSON.parse(response.body) : null };
}

test('token admin session separates view-only identity from token administration', async () => {
  const handler = loadTokenAdmin();

  const googleSession = await tokenAdminRequest(handler, { cookie: authCookie('google', 'viewer@redhat.com') });
  assert.equal(googleSession.statusCode, 200);
  assert.deepEqual(googleSession.data, {
    method: 'google', githubHandle: null, email: 'viewer@redhat.com', viewOnly: true,
  });
  assert.equal(googleSession.headers['Cache-Control'], 'no-store');

  const githubSession = await tokenAdminRequest(handler, { cookie: authCookie('github', 'owner') });
  assert.deepEqual(githubSession.data, {
    method: 'github', githubHandle: 'owner', email: null, viewOnly: false,
  });

  const tokenSession = await tokenAdminRequest(handler, { cookie: authCookie('token') });
  assert.deepEqual(tokenSession.data, {
    method: 'token', githubHandle: null, email: null, viewOnly: false,
  });

  const reports = await tokenAdminRequest(handler, {
    path: '/reports', cookie: authCookie('google', 'viewer@redhat.com'), query: { access: 'authenticated' },
  });
  assert.equal(reports.statusCode, 200);
  assert.deepEqual(reports.data.reports, []);

  for (const [method, path] of [
    ['GET', '/tokens'],
    ['POST', '/tokens'],
    ['DELETE', '/tokens'],
    ['POST', '/reports'],
    ['PATCH', '/reports'],
    ['DELETE', '/reports'],
  ]) {
    const response = await tokenAdminRequest(handler, {
      method, path, cookie: authCookie('google', 'viewer@redhat.com'),
      query: { access: 'authenticated', id: '12345678-1234-1234-1234-123456789abc' },
    });
    assert.equal(response.statusCode, 403, `${method} ${path} must be denied for view-only readers`);
    assert.equal(response.data.error, 'Google sign-in provides view-only report access');
  }

  const githubTokens = await tokenAdminRequest(handler, { path: '/tokens', cookie: authCookie('github', 'owner') });
  assert.equal(githubTokens.statusCode, 200);
  assert.deepEqual(githubTokens.data.tokens, []);
  assert.equal(githubTokens.data.githubHandle, 'owner');
});

test('token admin rejects unauthenticated session requests', async () => {
  const handler = loadTokenAdmin();
  const response = await tokenAdminRequest(handler);
  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.data, { error: 'Not authenticated' });
});

test('deployment sources route and parameterize the recovered Google/session features', () => {
  const tokenDeploy = fs.readFileSync('_infra/deploy-token-admin.sh', 'utf8');
  assert.match(tokenDeploy, /\$ROUTE_PREFIX\/session/);
  assert.match(tokenDeploy, /resource-id "\$SESSION_ID" --http-method GET/);
  assert.match(tokenDeploy, /--uri "\$INTEGRATION_URI"/);

  const authDeploy = fs.readFileSync('_infra/deploy-auth-lambda.sh', 'utf8');
  assert.match(authDeploy, /python3 "\$SCRIPT_DIR\/render-auth-config\.py" "\$WORK_DIR\/index\.js"/);
  assert.doesNotMatch(authDeploy, /\bsed -i\b/, 'config values must not be interpolated through sed');

  const renderer = fs.readFileSync('_infra/render-auth-config.py', 'utf8');
  for (const placeholder of [
    '__GITHUB_CLIENT_ID__',
    '__GITHUB_CLIENT_SECRET__',
    '__COOKIE_SECRET__',
    '__S3_BUCKET__',
    '__S3_REGION__',
    '__CANONICAL_DOMAIN__',
    '__GOOGLE_CLIENT_ID__',
    '__GOOGLE_CLIENT_SECRET__',
  ]) {
    assert.match(renderer, new RegExp(`"${placeholder}":`));
  }
  assert.match(renderer, /json\.dumps\(os\.environ\.get\(variable, ""\)\)/);
  assert.match(fs.readFileSync('_infra/lambda-auth/package.json', 'utf8'), /"google-auth-library": "\^10\.9\.1"/);
  assert.match(fs.readFileSync('_infra/lambda-auth/package-lock.json', 'utf8'), /"node_modules\/google-auth-library"/);
});

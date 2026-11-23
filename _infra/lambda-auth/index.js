'use strict';

const crypto = require('crypto');
const https = require('https');
const querystring = require('querystring');
const { OAuth2Client } = require('google-auth-library');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');

const CONFIG = {
  clientId: '__GITHUB_CLIENT_ID__',
  clientSecret: '__GITHUB_CLIENT_SECRET__',
  requiredOrg: 'openshift-psap',
  cookieName: 'psap_auth',
  cookieSecret: '__COOKIE_SECRET__',
  githubCookieMaxAge: 86400,
  tokenCookieMaxAge: 86400 * 7,
  s3Bucket: '__S3_BUCKET__',
  s3Region: '__S3_REGION__',
  callbackPath: '/_auth/callback',
  githubPath: '/_auth/github',
  tokenPath: '/_auth/token',
  logoutPath: '/_auth/logout',
  publicManifestPath: '/public-reports.json',
  canonicalDomain: '__CANONICAL_DOMAIN__',
  googleClientId: '__GOOGLE_CLIENT_ID__',
  googleClientSecret: '__GOOGLE_CLIENT_SECRET__',
};

const GOOGLE_PATH = '/_auth/google';
const GOOGLE_CALLBACK = '/_auth/google/callback';
const GOOGLE_FLOW_COOKIE = 'psap_google_flow';
const configured = value => value && !value.startsWith('__');
const googleEnabled = () => configured(CONFIG.googleClientId) && configured(CONFIG.googleClientSecret) &&
  configured(CONFIG.canonicalDomain);

const CACHE = { tokens: null, tokensAt: 0, allowlist: null, allowlistAt: 0, publicPaths: null, publicPathsAt: 0 };
const CACHE_TTL = 60000;
const s3 = new S3Client({ region: CONFIG.s3Region });

function httpRequest(options, postData) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve({ statusCode: res.statusCode, body: JSON.parse(body) }); }
        catch (e) { resolve({ statusCode: res.statusCode, body }); }
      });
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

async function fetchS3Json(key) {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: CONFIG.s3Bucket, Key: key }));
    return JSON.parse(await res.Body.transformToString());
  } catch (error) {
    console.log(JSON.stringify({ event: 'auth_data_read_failed', key, error: error.name }));
    return null;
  }
}

function tokenDigest(token) {
  return `sha256:${crypto.createHash('sha256').update(token).digest('hex')}`;
}

function tokenIsActive(entry) {
  if (!entry || entry.active === false || !entry.expires) return entry && entry.active !== false;
  const expiresAt = entry.expires.includes('T') ? entry.expires : `${entry.expires}T23:59:59.999Z`;
  return Date.now() <= Date.parse(expiresAt);
}

async function getTokens() {
  if (CACHE.tokens && Date.now() - CACHE.tokensAt < CACHE_TTL) return CACHE.tokens;
  const data = await fetchS3Json('tokens.json');
  if (data) { CACHE.tokens = data; CACHE.tokensAt = Date.now(); }
  return data || { tokens: {} };
}

async function getAllowlist() {
  if (CACHE.allowlist && Date.now() - CACHE.allowlistAt < CACHE_TTL) return CACHE.allowlist;
  const data = await fetchS3Json('allowlist.json');
  if (data) { CACHE.allowlist = data; CACHE.allowlistAt = Date.now(); }
  return data || { users: [] };
}

async function getPublicPaths() {
  if (CACHE.publicPaths && Date.now() - CACHE.publicPathsAt < CACHE_TTL) return CACHE.publicPaths;
  const data = await fetchS3Json(CONFIG.publicManifestPath.substring(1));
  if (!data || !Array.isArray(data.paths)) return new Set();
  const paths = new Set(data.paths.map(path => {
    try { return new URL(path).pathname; }
    catch (e) { return path; }
  }));
  CACHE.publicPaths = paths;
  CACHE.publicPathsAt = Date.now();
  return paths;
}

function signCookie(value) {
  const hmac = crypto.createHmac('sha256', CONFIG.cookieSecret);
  hmac.update(value);
  return value + '.' + hmac.digest('base64url');
}

function verifyCookie(signed) {
  const lastDot = signed.lastIndexOf('.');
  if (lastDot < 0) return null;
  const value = signed.substring(0, lastDot);
  if (signCookie(value) !== signed) return null;

  const [authenticated, method, issuedAt, githubHandle] = value.split(':');
  const maxAge = method === 'github' || method === 'google' ? CONFIG.githubCookieMaxAge :
    method === 'token' ? CONFIG.tokenCookieMaxAge : 0;
  if (authenticated !== 'authenticated' || !maxAge || !/^\d+$/.test(issuedAt || '')) return null;
  if (Date.now() > Number(issuedAt) + maxAge * 1000) return null;
  return { method, githubHandle: method === 'github' ? githubHandle || null : null };
}

function parseCookies(headers) {
  const cookies = {};
  if (headers.cookie) {
    headers.cookie[0].value.split(';').forEach(pair => {
      const [k, ...v] = pair.trim().split('=');
      cookies[k] = v.join('=');
    });
  }
  return cookies;
}

function setAuthCookie(redirectTo, method, githubHandle) {
  const maxAge = method === 'github' || method === 'google' ? CONFIG.githubCookieMaxAge : CONFIG.tokenCookieMaxAge;
  const expires = new Date(Date.now() + maxAge * 1000).toUTCString();
  const subject = ['github', 'google'].includes(method) && githubHandle ? `:${githubHandle.toLowerCase()}` : '';
  const cookieValue = signCookie(`authenticated:${method}:${Date.now()}${subject}`);
  return {
    status: '302',
    statusDescription: 'Found',
    headers: {
      location: [{ key: 'Location', value: redirectTo || '/' }],
      'cache-control': [{ key: 'Cache-Control', value: 'no-store' }],
      'set-cookie': [{
        key: 'Set-Cookie',
        value: `${CONFIG.cookieName}=${cookieValue}; Path=/; Expires=${expires}; Secure; HttpOnly; SameSite=Lax`,
      }],
    },
  };
}

function clearAuthCookie(redirectTo) {
  return {
    status: '302',
    statusDescription: 'Found',
    headers: {
      location: [{ key: 'Location', value: redirectTo || '/' }],
      'set-cookie': [{
        key: 'Set-Cookie',
        value: `${CONFIG.cookieName}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly; SameSite=Lax`,
      }],
    },
  };
}

function loginPage(returnPath, error) {
  const errorHtml = error ? `<div style="color:#c00;background:#fde8e8;padding:0.5rem 1rem;border-radius:6px;margin-bottom:1rem;font-size:0.85rem">${error}</div>` : '';
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign In — PSAP Report Hub</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:"Red Hat Text","Helvetica Neue",Arial,sans-serif;background:#fff;color:#151515;display:flex;flex-direction:column;min-height:100vh}
.site-header{background:#151515;border-bottom:3px solid #EE0000;padding:0.75rem 0}
.site-header .c{max-width:960px;margin:0 auto;padding:0 1rem}
.brand{color:#fff;font-size:1.3rem;font-weight:700;text-decoration:none;letter-spacing:-0.01em}
.brand span{color:#a0a0a0;font-size:0.8rem;font-weight:400;margin-left:0.75rem}
.main{flex:1;display:flex;align-items:center;justify-content:center;padding:2rem 1rem}
.card{background:#fff;border:1px solid #d2d2d2;border-radius:12px;padding:2.5rem;max-width:400px;width:100%;box-shadow:0 2px 8px rgba(0,0,0,0.08)}
.card h2{font-size:1.2rem;font-weight:600;margin-bottom:0.25rem}
.card p{font-size:0.85rem;color:#6a6e73;margin-bottom:1.5rem}
.divider{display:flex;align-items:center;gap:0.75rem;margin:1.25rem 0;color:#6a6e73;font-size:0.75rem}
.divider::before,.divider::after{content:"";flex:1;border-top:1px solid #d2d2d2}
.gh-btn{display:flex;align-items:center;justify-content:center;gap:0.5rem;width:100%;padding:0.65rem;background:#24292f;color:#fff;border:none;border-radius:6px;font-size:0.9rem;font-weight:600;cursor:pointer;text-decoration:none}
.gh-btn:hover{background:#1b1f23}
.gh-btn svg{width:1.1rem;height:1.1rem;fill:#fff}
.token-form{display:flex;gap:0.5rem}
.token-input{flex:1;padding:0.55rem 0.75rem;border:1px solid #d2d2d2;border-radius:6px;font-size:0.85rem;font-family:inherit}
.token-input:focus{outline:none;border-color:#EE0000;box-shadow:0 0 0 3px rgba(238,0,0,0.12)}
.token-btn{padding:0.55rem 1rem;background:#EE0000;color:#fff;border:none;border-radius:6px;font-size:0.85rem;font-weight:600;cursor:pointer}
.token-btn:hover{background:#cc0000}
.requirement{background:#f5f5f5;border-left:3px solid #EE0000;border-radius:4px;padding:0.65rem 0.85rem;margin-bottom:1.25rem;font-size:0.82rem;color:#3c3f42;line-height:1.45}
footer{text-align:center;padding:1rem;font-size:0.7rem;color:#888;border-top:1px solid #d2d2d2}
</style></head><body>
<div class="site-header"><div class="c"><a class="brand" href="/">PSAP<span>Report Hub</span></a></div></div>
<div class="main"><div class="card">
<h2>Sign in to PSAP Report Hub</h2>
<p>PSAP team members can sign in with GitHub. ${googleEnabled() ? 'Red Hat employees can sign in with Google for view-only access, or use an access token.' : 'Red Hat employees can use an access token.'}</p>
<div class="requirement"><strong>To upload reports</strong>, sign in with GitHub as an <strong>openshift-psap</strong> organization member (allowlisted GitHub accounts are also permitted). Access tokens and other sign-in methods cannot upload reports.</div>
<p style="font-size:0.8rem;color:#6a6e73;margin-top:-0.5rem">Don't have a token? Reach out to <strong>#forum-psap</strong> on Slack to request access.</p>
${errorHtml}
${googleEnabled() ? `<a class="gh-btn" style="margin-bottom:1rem" href="${GOOGLE_PATH}?state=${encodeURIComponent(safeReturnPath(returnPath))}">Sign in with Google (view only)</a>` : ''}
<a class="gh-btn" href="/_auth/github?state=${encodeURIComponent(returnPath || '/')}">
<svg viewBox="0 0 16 16"><path fill-rule="evenodd" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
Sign in with GitHub</a>
<div class="divider">or</div>
<form class="token-form" method="POST" action="/_auth/token">
<input type="hidden" name="state" value="${returnPath || '/'}">
<input class="token-input" type="password" name="token" placeholder="Access token" required>
<button class="token-btn" type="submit">Enter</button>
</form>
</div></div>
<footer>Performance &amp; Scale for AI Platforms · <a href="/privacy.html">Privacy Policy</a></footer>
</body></html>`;
  return {
    status: '200',
    statusDescription: 'OK',
    headers: { 'content-type': [{ key: 'Content-Type', value: 'text/html; charset=utf-8' }] },
    body: html,
  };
}

function parseFormBody(body) {
  return body ? querystring.parse(body) : {};
}

function requestBody(request) {
  const body = request.body;
  if (!body || !body.data) return '';
  return body.encoding === 'base64' ? Buffer.from(body.data, 'base64').toString('utf8') : body.data;
}

function safeReturnPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\x00-\x20]/.test(value) || value.startsWith('/_auth/')) return '/';
  return value;
}

async function googleLogin(request) {
  const params = querystring.parse(request.querystring || '');
  const redirectUri = `https://${CONFIG.canonicalDomain}${GOOGLE_CALLBACK}`;
  const client = new OAuth2Client(CONFIG.googleClientId, CONFIG.googleClientSecret, redirectUri);
  const cookie = (value, age) => ({ key: 'Set-Cookie', value: `${GOOGLE_FLOW_COOKIE}=${value}; Path=${GOOGLE_CALLBACK}; Max-Age=${age}; Secure; HttpOnly; SameSite=Lax` });
  if (request.uri === GOOGLE_PATH) {
    const flow = {
      state: crypto.randomBytes(32).toString('base64url'),
      nonce: crypto.randomBytes(32).toString('base64url'),
      verifier: crypto.randomBytes(32).toString('base64url'),
      returnPath: safeReturnPath(params.state), expires: Date.now() + 600000,
    };
    const url = client.generateAuthUrl({
      scope: ['openid', 'email'], state: flow.state, nonce: flow.nonce,
      hd: 'redhat.com', prompt: 'select_account',
      code_challenge: crypto.createHash('sha256').update(flow.verifier).digest('base64url'),
      code_challenge_method: 'S256',
    });
    return { status: '302', headers: {
      location: [{ key: 'Location', value: url }],
      'cache-control': [{ key: 'Cache-Control', value: 'no-store' }],
      'set-cookie': [cookie(signCookie(Buffer.from(JSON.stringify(flow)).toString('base64url')), 600)],
    } };
  }
  let result;
  try {
    const signed = parseCookies(request.headers)[GOOGLE_FLOW_COOKIE] || '';
    const value = signed.substring(0, signed.lastIndexOf('.'));
    if (!signed || signCookie(value) !== signed) throw new Error('Invalid transaction');
    const flow = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (flow.expires < Date.now() || !params.state || params.state !== flow.state || typeof params.code !== 'string' || params.error) throw new Error('Invalid callback');
    const { tokens } = await client.getToken({ code: params.code, codeVerifier: flow.verifier });
    const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: CONFIG.googleClientId });
    const claims = ticket.getPayload();
    if (claims.nonce !== flow.nonce || claims.email_verified !== true || claims.hd !== 'redhat.com' ||
        typeof claims.email !== 'string' || !/^[^@:\s]+@redhat\.com$/i.test(claims.email)) throw new Error('Account not permitted');
    result = setAuthCookie(safeReturnPath(flow.returnPath), 'google', claims.email);
  } catch (_) {
    // Never log authorization codes, tokens, claims, or provider error details.
    result = loginPage('/', 'Google sign-in failed. Use your verified redhat.com Google Workspace account and try again.');
  }
  result.headers['cache-control'] = [{ key: 'Cache-Control', value: 'no-store' }];
  (result.headers['set-cookie'] ||= []).push(cookie('', 0));
  return result;
}

exports.handler = async (event) => {
  const request = event.Records[0].cf.request;
  const headers = request.headers;
  const uri = request.uri;

  // Publication checks run at viewer-request, before cache lookup and before
  // every public/authenticated bypass. Never serve control or physical keys.
  let decoded;
  try { decoded = decodeURIComponent(uri); }
  catch (_) { return { status: '400', body: 'Invalid path' }; }
  if (/%[0-9a-f]{2}/i.test(decoded)) return { status: '400', body: 'Ambiguous path encoding' };
  const forbidden = /^\/(report-objects-v2|report-control-v2|report-locators-v2|report-reconciliation-v2|report-submissions|uploads)(\/|$)/;
  const normalized = require('path').posix.normalize(decoded.replace(/\\/g, '/'));
  if (forbidden.test(decoded) || forbidden.test(normalized)) return { status: '403', headers: {
    'cache-control': [{ key: 'Cache-Control', value: 'no-store' }],
  }, body: 'Not a report path.' };
  if (/^\/(public|private)\/v2(?:\/|$)/.test(decoded) || /^\/(public|private)\/v2(?:\/|$)/.test(normalized)) {
    const deny = (status, body) => ({ status, headers: { 'cache-control': [{ key: 'Cache-Control', value: 'no-store' }] }, body });
    if (decoded !== normalized || decoded.includes('%') || decoded.includes('\\') || /%2f|%5c/i.test(uri) || !['GET', 'HEAD'].includes(request.method)) return deny('400', 'Invalid report path');
    const match = decoded.match(/^\/(public|private)\/v2\/([a-f0-9-]{36})\/([a-f0-9-]{36})\/(.+)$/);
    if (!match) return deny('404', 'Report not found');
    const [, access, reportId, revisionId, relative] = match;
    if (relative.split('/').some(part => !part || part === '.' || part === '..')) return deny('400', 'Invalid report path');
    if (access === 'private') {
      const cookie = parseCookies(headers)[CONFIG.cookieName];
      if (!cookie || !verifyCookie(cookie)) return loginPage(uri);
    }
    try {
      const result = await s3.send(new GetObjectCommand({ Bucket: CONFIG.s3Bucket, Key: `report-control-v2/${reportId}.json` }));
      const doc = JSON.parse(await result.Body.transformToString());
      const revision = doc.revisions?.[revisionId];
      if (doc.id !== reportId || revision?.state !== 'COMMITTED' || revision.metadata.authenticated !== (access === 'private') || !revision.files?.some(file => file.name === relative)) return deny('404', 'Report not found');
      const prefix = revision.attempts?.[revision.selectedAttempt]?.prefix;
      if (prefix !== `report-objects-v2/${revisionId}/${revision.selectedAttempt}/` || !/^[a-f0-9-]{36}$/.test(revision.selectedAttempt)) return deny('503', 'Publication state unavailable');
      request.uri = '/' + (prefix + relative).split('/').map(encodeURIComponent).join('/');
      return request;
    } catch (error) {
      return deny(error.$metadata?.httpStatusCode === 404 || error.name === 'NoSuchKey' ? '404' : '503', 'Report unavailable');
    }
  }

  // Redirect raw CloudFront domain to the canonical custom domain so that
  // OAuth callbacks, API endpoints, and uploads work correctly.
  const host = headers.host && headers.host[0] && headers.host[0].value;
  const canonicalDomainConfigured = configured(CONFIG.canonicalDomain);
  if (host && host.endsWith('.cloudfront.net') && canonicalDomainConfigured) {
    const qs = request.querystring ? `?${request.querystring}` : '';
    return {
      status: '301',
      statusDescription: 'Moved Permanently',
      headers: {
        location: [{ key: 'Location', value: `https://${CONFIG.canonicalDomain}${uri}${qs}` }],
        'cache-control': [{ key: 'Cache-Control', value: 'max-age=86400' }],
      },
    };
  }

  // The hub shell, public reports, and the unauthenticated public-report index
  // endpoint are deliberately public. Private reports live exclusively below
  // /private/ and are never included here.
  if (uri === '/' || uri === '/index.html' || uri === '/privacy.html' || uri.startsWith('/public/')) return request;
  if (uri === '/_admin-api/reports' && request.method === 'GET' &&
      /(^|&)access=public(&|$)/.test(request.querystring || '')) return request;
  if (uri === CONFIG.publicManifestPath) return request;
  if ((await getPublicPaths()).has(uri)) return request;

  // End the browser session without affecting the underlying GitHub OAuth grant.
  if (uri === CONFIG.logoutPath) return clearAuthCookie('/');

  if (googleEnabled() && (uri === GOOGLE_PATH || uri === GOOGLE_CALLBACK)) return googleLogin(request);

  // This endpoint exists only as the target of the token form POST. Serving a
  // login page for a direct GET prevents an authenticated browser from being
  // forwarded to the S3 origin, where no such object exists.
  if (uri === CONFIG.tokenPath && request.method === 'GET') return loginPage('/');

  // GitHub OAuth redirect
  if (uri === CONFIG.githubPath) {
    const params = querystring.parse(request.querystring);
    const host = headers.host[0].value;
    const redirectUri = `https://${host}${CONFIG.callbackPath}`;
    const state = params.state || '/';
    const authUrl = `https://github.com/login/oauth/authorize?client_id=${CONFIG.clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=read:org&state=${encodeURIComponent(state)}`;
    return { status: '302', statusDescription: 'Found', headers: { location: [{ key: 'Location', value: authUrl }] } };
  }

  // GitHub OAuth callback
  if (uri === CONFIG.callbackPath) {
    const params = querystring.parse(request.querystring);
    if (!params.code) return loginPage(params.state, 'GitHub authentication failed.');

    const tokenData = querystring.stringify({
      client_id: CONFIG.clientId,
      client_secret: CONFIG.clientSecret,
      code: params.code,
    });
    const tokenRes = await httpRequest({
      hostname: 'github.com',
      path: '/login/oauth/access_token',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json', 'Content-Length': Buffer.byteLength(tokenData) },
    }, tokenData);

    if (tokenRes.statusCode !== 200 || !tokenRes.body.access_token) {
      return loginPage(params.state, 'GitHub token exchange failed.');
    }

    const accessToken = tokenRes.body.access_token;
    const username = await getUsername(accessToken);

    // Check org membership
    const orgRes = await httpRequest({
      hostname: 'api.github.com',
      path: `/orgs/${CONFIG.requiredOrg}/members/${username}`,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'User-Agent': 'psap-reports-auth', 'Accept': 'application/json' },
    });

    if (orgRes.statusCode === 204) {
      console.log(JSON.stringify({ event: 'github_auth', method: 'org', user: username }));
      return setAuthCookie(params.state, 'github', username);
    }

    // Check allowlist
    const allowlist = await getAllowlist();
    if (allowlist.users && allowlist.users.includes(username)) {
      console.log(JSON.stringify({ event: 'github_auth', method: 'allowlist', user: username }));
      return setAuthCookie(params.state, 'github', username);
    }

    return loginPage(params.state, `Access denied: ${username} is not an <strong>openshift-psap</strong> organization member or an allowlisted account. Reach out to <strong>#forum-psap</strong> on Slack to request access.`);
  }

  // Token validation (POST)
  if (uri === CONFIG.tokenPath && request.method === 'POST') {
    const form = parseFormBody(requestBody(request));
    const submittedToken = form.token || '';
    const returnPath = safeReturnPath(form.state);

    const tokensData = await getTokens();
    const entry = tokensData.tokens && tokensData.tokens[tokenDigest(submittedToken)];

    if (tokenIsActive(entry)) {
      console.log(JSON.stringify({ event: 'token_auth', group: entry.group || 'everyone', path: returnPath }));
      return setAuthCookie(returnPath, 'token');
    }
    return loginPage(returnPath, 'Invalid or revoked access token. Reach out to <strong>#forum-psap</strong> on Slack for a valid token.');
  }

  // Check existing auth cookie
  const cookies = parseCookies(headers);
  const authCookie = cookies[CONFIG.cookieName];
  const principal = authCookie && verifyCookie(authCookie);
  if (principal) {
    if (principal.method === 'google') {
      // Do not expose origin auth data or submission objects to Google readers.
      const readable = ['GET', 'HEAD'].includes(request.method) &&
        (uri.startsWith('/private/') || uri === '/admin/index.html' ||
          uri === '/_admin-api/session' || uri === '/_admin-api/reports');
      if (!readable) return { status: '403', headers: {
        'cache-control': [{ key: 'Cache-Control', value: 'no-store' }],
      }, body: 'Google sign-in provides view-only report access.' };
    }
    return request;
  }

  // Not authenticated — show login page
  const returnPath = uri + (request.querystring ? '?' + request.querystring : '');
  return loginPage(returnPath);
};

async function getUsername(accessToken) {
  const res = await httpRequest({
    hostname: 'api.github.com',
    path: '/user',
    method: 'GET',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'User-Agent': 'psap-reports-auth', 'Accept': 'application/json' },
  });
  return res.body.login;
}

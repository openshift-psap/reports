'use strict';

const crypto = require('crypto');
const https = require('https');
const querystring = require('querystring');

const CONFIG = {
  clientId: '__GITHUB_CLIENT_ID__',
  clientSecret: '__GITHUB_CLIENT_SECRET__',
  requiredOrg: 'openshift-psap',
  cookieName: 'psap_auth',
  cookieSecret: '__COOKIE_SECRET__',
  cookieMaxAge: 86400 * 7,
  s3Bucket: '__S3_BUCKET__',
  s3Region: '__S3_REGION__',
  callbackPath: '/_auth/callback',
  githubPath: '/_auth/github',
  tokenPath: '/_auth/token',
  publicManifestPath: '/public-reports.json',
};

const CACHE = { tokens: null, tokensAt: 0, allowlist: null, allowlistAt: 0 };
const CACHE_TTL = 60000;

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
  const res = await httpRequest({
    hostname: `${CONFIG.s3Bucket}.s3.${CONFIG.s3Region}.amazonaws.com`,
    path: `/${key}`,
    method: 'GET',
    headers: { 'Accept': 'application/json' },
  });
  if (res.statusCode === 200 && typeof res.body === 'object') return res.body;
  return null;
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

function signCookie(value) {
  const hmac = crypto.createHmac('sha256', CONFIG.cookieSecret);
  hmac.update(value);
  return value + '.' + hmac.digest('base64url');
}

function verifyCookie(signed) {
  const lastDot = signed.lastIndexOf('.');
  if (lastDot < 0) return null;
  const value = signed.substring(0, lastDot);
  if (signCookie(value) === signed) return value;
  return null;
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

function setAuthCookie(redirectTo) {
  const expires = new Date(Date.now() + CONFIG.cookieMaxAge * 1000).toUTCString();
  const cookieValue = signCookie(`authenticated:${Date.now()}`);
  return {
    status: '302',
    statusDescription: 'Found',
    headers: {
      location: [{ key: 'Location', value: redirectTo || '/' }],
      'set-cookie': [{
        key: 'Set-Cookie',
        value: `${CONFIG.cookieName}=${cookieValue}; Path=/; Expires=${expires}; Secure; HttpOnly; SameSite=Lax`,
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
footer{text-align:center;padding:1rem;font-size:0.7rem;color:#888;border-top:1px solid #d2d2d2}
</style></head><body>
<div class="site-header"><div class="c"><a class="brand" href="/">PSAP<span>Report Hub</span></a></div></div>
<div class="main"><div class="card">
<h2>Sign in to view reports</h2>
<p>PSAP team members can sign in with GitHub. Red Hat employees can use an access token.</p>
${errorHtml}
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
<footer>Performance &amp; Scale for AI Platforms</footer>
</body></html>`;
  return {
    status: '200',
    statusDescription: 'OK',
    headers: { 'content-type': [{ key: 'Content-Type', value: 'text/html; charset=utf-8' }] },
    body: html,
  };
}

function parseFormBody(body) {
  const params = {};
  if (!body) return params;
  body.split('&').forEach(pair => {
    const [k, ...v] = pair.split('=');
    params[decodeURIComponent(k)] = decodeURIComponent(v.join('='));
  });
  return params;
}

exports.handler = async (event) => {
  const request = event.Records[0].cf.request;
  const headers = request.headers;
  const uri = request.uri;

  if (uri === CONFIG.publicManifestPath) return request;

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
      return setAuthCookie(params.state);
    }

    // Check allowlist
    const allowlist = await getAllowlist();
    if (allowlist.users && allowlist.users.includes(username)) {
      console.log(JSON.stringify({ event: 'github_auth', method: 'allowlist', user: username }));
      return setAuthCookie(params.state);
    }

    return loginPage(params.state, `Access denied: ${username} is not a member of ${CONFIG.requiredOrg} and not in the allowlist.`);
  }

  // Token validation (POST)
  if (uri === CONFIG.tokenPath && request.method === 'POST') {
    const form = parseFormBody(request.body && request.body.data);
    const submittedToken = form.token || '';
    const returnPath = form.state || '/';

    const tokensData = await getTokens();
    const entry = tokensData.tokens && tokensData.tokens[submittedToken];

    if (entry && entry.active !== false) {
      console.log(JSON.stringify({ event: 'token_auth', group: entry.group || 'everyone', path: returnPath }));
      return setAuthCookie(returnPath);
    }
    return loginPage(returnPath, 'Invalid or revoked access token.');
  }

  // Check existing auth cookie
  const cookies = parseCookies(headers);
  const authCookie = cookies[CONFIG.cookieName];
  if (authCookie && verifyCookie(authCookie)) return request;

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

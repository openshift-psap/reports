'use strict';

const crypto = require('crypto');
const https = require('https');
const querystring = require('querystring');

// These get replaced by the deploy script before zipping
const CONFIG = {
  clientId: '__GITHUB_CLIENT_ID__',
  clientSecret: '__GITHUB_CLIENT_SECRET__',
  requiredOrg: 'openshift-psap',
  cookieName: 'psap_auth',
  cookieSecret: '__COOKIE_SECRET__',
  cookieMaxAge: 86400 * 7, // 7 days
  callbackPath: '/_auth/callback',
  publicManifestPath: '/public-reports.json',
};

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

function redirectResponse(location) {
  return {
    status: '302',
    statusDescription: 'Found',
    headers: { location: [{ key: 'Location', value: location }] },
  };
}

exports.handler = async (event) => {
  const request = event.Records[0].cf.request;
  const headers = request.headers;
  const uri = request.uri;

  // Always allow public-reports.json without auth
  if (uri === CONFIG.publicManifestPath) return request;

  // Handle OAuth callback
  if (uri === CONFIG.callbackPath) {
    const params = querystring.parse(request.querystring);
    if (!params.code) {
      return { status: '400', statusDescription: 'Bad Request', body: 'Missing code parameter' };
    }

    // Exchange code for access token
    const tokenData = querystring.stringify({
      client_id: CONFIG.clientId,
      client_secret: CONFIG.clientSecret,
      code: params.code,
    });
    const tokenRes = await httpRequest({
      hostname: 'github.com',
      path: '/login/oauth/access_token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(tokenData),
      },
    }, tokenData);

    if (tokenRes.statusCode !== 200 || !tokenRes.body.access_token) {
      return { status: '403', statusDescription: 'Forbidden', body: 'OAuth token exchange failed' };
    }

    const accessToken = tokenRes.body.access_token;

    // Check org membership
    const orgRes = await httpRequest({
      hostname: 'api.github.com',
      path: `/orgs/${CONFIG.requiredOrg}/members/${await getUsername(accessToken)}`,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'User-Agent': 'psap-reports-auth',
        'Accept': 'application/json',
      },
    });

    if (orgRes.statusCode !== 204) {
      return { status: '403', statusDescription: 'Forbidden', body: `Access denied: not a member of ${CONFIG.requiredOrg}` };
    }

    // Set signed cookie and redirect to originally requested path
    const redirectTo = params.state || '/';
    const expires = new Date(Date.now() + CONFIG.cookieMaxAge * 1000).toUTCString();
    const cookieValue = signCookie(`authenticated:${Date.now()}`);

    return {
      status: '302',
      statusDescription: 'Found',
      headers: {
        location: [{ key: 'Location', value: redirectTo }],
        'set-cookie': [{
          key: 'Set-Cookie',
          value: `${CONFIG.cookieName}=${cookieValue}; Path=/; Expires=${expires}; Secure; HttpOnly; SameSite=Lax`,
        }],
      },
    };
  }

  // Check for valid auth cookie
  const cookies = parseCookies(headers);
  const authCookie = cookies[CONFIG.cookieName];

  if (authCookie && verifyCookie(authCookie)) {
    return request;
  }

  // Not authenticated — redirect to GitHub OAuth
  const host = headers.host[0].value;
  const redirectUri = `https://${host}${CONFIG.callbackPath}`;
  const state = uri + (request.querystring ? '?' + request.querystring : '');
  const authUrl = `https://github.com/login/oauth/authorize?client_id=${CONFIG.clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=read:org&state=${encodeURIComponent(state)}`;

  return redirectResponse(authUrl);
};

async function getUsername(accessToken) {
  const res = await httpRequest({
    hostname: 'api.github.com',
    path: '/user',
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'User-Agent': 'psap-reports-auth',
      'Accept': 'application/json',
    },
  });
  return res.body.login;
}

'use strict';

const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const crypto = require('crypto');

const BUCKET = process.env.S3_BUCKET || 'psap-reports';
const REGION = process.env.S3_REGION || 'us-east-1';
const COOKIE_SECRET = process.env.COOKIE_SECRET;
const COOKIE_NAME = 'psap_auth';
const TOKEN_PREFIX = 'psap_rht_';
const TOKEN_LENGTH = 54;

const s3 = new S3Client({ region: REGION });

function tokenDigest(token) {
  return `sha256:${crypto.createHash('sha256').update(token).digest('hex')}`;
}

function tokenPrefix(token, info) {
  return info.prefix || token.substring(0, 20);
}

function verifyCookie(signed) {
  if (!signed || !COOKIE_SECRET) return false;
  const lastDot = signed.lastIndexOf('.');
  if (lastDot < 0) return false;
  const value = signed.substring(0, lastDot);
  const hmac = crypto.createHmac('sha256', COOKIE_SECRET);
  hmac.update(value);
  const expected = value + '.' + hmac.digest('base64url');
  return expected === signed;
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach(pair => {
    const [k, ...v] = pair.trim().split('=');
    cookies[k] = v.join('=');
  });
  return cookies;
}

async function getTokens() {
  try {
    const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'tokens.json' }));
    const body = await resp.Body.transformToString();
    return JSON.parse(body);
  } catch (e) {
    return { tokens: {} };
  }
}

async function putTokens(data) {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: 'tokens.json',
    Body: JSON.stringify(data, null, 2),
    ContentType: 'application/json',
  }));
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function response(statusCode, body, origin) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  const origin = event.headers && event.headers.origin;

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(origin), body: '' };
  }

  const cookies = parseCookies(event.headers && event.headers.cookie);
  if (!verifyCookie(cookies[COOKIE_NAME])) {
    return response(401, { error: 'Not authenticated' }, origin);
  }

  const method = event.httpMethod;
  const path = event.path || event.resource;

  // GET /tokens — list tokens (redacted)
  if (method === 'GET' && path === '/tokens') {
    const data = await getTokens();
    const redacted = Object.entries(data.tokens).map(([token, info]) => ({
      id: tokenPrefix(token, info) + '...',
      group: info.group || 'everyone',
      note: info.note || '',
      created: info.created || '',
      active: info.active !== false,
    }));
    return response(200, { tokens: redacted }, origin);
  }

  // POST /tokens — create token
  if (method === 'POST' && path === '/tokens') {
    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch (e) {}
    const group = body.group || 'everyone';
    const note = body.note || `${group} access`;

    const token = TOKEN_PREFIX + crypto.randomBytes(TOKEN_LENGTH).toString('base64url').substring(0, TOKEN_LENGTH);
    const data = await getTokens();
    data.tokens[tokenDigest(token)] = {
      prefix: token.substring(0, 20),
      created: new Date().toISOString().split('T')[0],
      group,
      note,
      active: true,
    };
    await putTokens(data);

    return response(201, { token, group, note }, origin);
  }

  // DELETE /tokens — revoke token by prefix
  if (method === 'DELETE' && path === '/tokens') {
    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch (e) {}
    const prefix = body.prefix || '';
    if (!prefix) return response(400, { error: 'Missing prefix' }, origin);

    const data = await getTokens();
    let revoked = 0;
    for (const [token, info] of Object.entries(data.tokens)) {
      if (tokenPrefix(token, info).startsWith(prefix) && info.active !== false) {
        info.active = false;
        revoked++;
      }
    }
    if (revoked === 0) return response(404, { error: 'No matching active tokens' }, origin);
    await putTokens(data);
    return response(200, { revoked }, origin);
  }

  return response(404, { error: 'Not found' }, origin);
};

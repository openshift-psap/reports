'use strict';

const {
  S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand,
  HeadObjectCommand, ListObjectsV2Command, DeleteObjectsCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const crypto = require('crypto');
const https = require('https');

const BUCKET = process.env.S3_BUCKET || 'psap-reports';
const REGION = process.env.S3_REGION || 'us-east-1';
const COOKIE_SECRET = process.env.COOKIE_SECRET;
const COOKIE_NAME = 'psap_auth';
const GITHUB_COOKIE_MAX_AGE = 86400;
const TOKEN_COOKIE_MAX_AGE = 86400 * 7;
const TOKEN_PREFIX = 'psap_rht_';
const TOKEN_LENGTH = 54;
const REPORT_CATEGORIES = new Set(['benchmarks', 'ci', 'investigations', 'presentations']);
const REPORT_ACCESS = new Set(['public', 'authenticated']);
const MAX_UPLOAD_FILES = 100;
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const UPLOAD_URL_TTL = 15 * 60;

const s3 = new S3Client({ region: REGION });

function tokenDigest(token) {
  return `sha256:${crypto.createHash('sha256').update(token).digest('hex')}`;
}

function tokenPrefix(token, info) {
  return info.prefix || token.substring(0, 20);
}

function tokenIsActive(info) {
  if (!info || info.active === false) return false;
  if (!info.expires) return true;
  const expiresAt = info.expires.includes('T') ? info.expires : `${info.expires}T23:59:59.999Z`;
  return Date.now() <= Date.parse(expiresAt);
}

function expirationTimestamp(lifetimeDays) {
  if (lifetimeDays === 0) return null;
  return new Date(Date.now() + lifetimeDays * 86400 * 1000).toISOString();
}

function verifyCookie(signed) {
  if (!signed || !COOKIE_SECRET) return false;
  const lastDot = signed.lastIndexOf('.');
  if (lastDot < 0) return false;
  const value = signed.substring(0, lastDot);
  const hmac = crypto.createHmac('sha256', COOKIE_SECRET);
  hmac.update(value);
  const expected = value + '.' + hmac.digest('base64url');
  if (expected !== signed) return false;
  const [authenticated, method, issuedAt, githubHandle] = value.split(':');
  const maxAge = method === 'github' ? GITHUB_COOKIE_MAX_AGE :
    method === 'token' ? TOKEN_COOKIE_MAX_AGE : 0;
  if (!(authenticated === 'authenticated' && maxAge > 0 && /^\d+$/.test(issuedAt || '') &&
    Date.now() <= Number(issuedAt) + maxAge * 1000)) return null;
  return { method, githubHandle: method === 'github' ? githubHandle || null : null };
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

function safeString(value, maxLength = 500) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function safeSlug(value) {
  return safeString(value, 100).toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

function safeFileName(value) {
  const name = safeString(value, 300);
  if (!name || name.startsWith('/') || name.includes('\\') || name.split('/').some(part => !part || part === '.' || part === '..')) return null;
  return name;
}

function parseBody(raw) {
  try { return JSON.parse(raw || '{}'); } catch (e) { return {}; }
}

function githubRequest(path, token) {
  return new Promise((resolve, reject) => {
    const request = https.request({ hostname: 'api.github.com', path, method: 'GET', headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'psap-reports-cli', Accept: 'application/json' } }, response => {
      let body = ''; response.on('data', chunk => body += chunk);
      response.on('end', () => { try { resolve({ status: response.statusCode, body: JSON.parse(body) }); } catch (e) { resolve({ status: response.statusCode, body: {} }); } });
    });
    request.on('error', reject); request.end();
  });
}

async function cliPrincipal(headers) {
  const authorization = headers.authorization || headers.Authorization || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const token = match[1];
  const user = await githubRequest('/user', token);
  if (user.status !== 200 || !user.body.login) return null;
  const member = await githubRequest(`/orgs/openshift-psap/members/${encodeURIComponent(user.body.login)}`, token);
  return member.status === 204 ? { method: 'github-cli', githubHandle: user.body.login.toLowerCase() } : null;
}

async function getJson(key) {
  const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return JSON.parse(await resp.Body.transformToString());
}

async function putJson(key, value) {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET, Key: key, Body: JSON.stringify(value, null, 2),
    ContentType: 'application/json', CacheControl: 'no-store',
  }));
}

async function listReports(access, includeSuperseded = false) {
  const prefix = `report-meta/${access}/`;
  let continuationToken;
  const entries = [];
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: continuationToken }));
    for (const item of page.Contents || []) {
      if (!item.Key.endsWith('.json')) continue;
      try { entries.push(await getJson(item.Key)); } catch (error) { console.log(JSON.stringify({ event: 'report_metadata_read_failed', key: item.Key, error: error.name })); }
    }
    continuationToken = page.NextContinuationToken;
  } while (continuationToken);
  return entries.filter(entry => includeSuperseded || entry.isLatest !== false)
    .sort((a, b) => String(b.submittedAt || b.date).localeCompare(String(a.submittedAt || a.date)));
}

async function deleteReportObjects(prefix) {
  let token;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token }));
    const objects = (page.Contents || []).map(item => ({ Key: item.Key }));
    if (objects.length) await s3.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: objects, Quiet: true } }));
    token = page.NextContinuationToken;
  } while (token);
}

function reportEntry(submission) {
  return {
    id: submission.id,
    reportId: submission.reportId,
    version: submission.version,
    isLatest: true,
    title: submission.title,
    description: submission.description,
    tags: submission.tags,
    date: submission.date,
    submittedAt: submission.createdAt,
    author: submission.author,
    status: submission.status,
    category: submission.category,
    path: `https://${submission.cloudfrontDomain}/${submission.baseKey}/${submission.entryFile}`,
    size: submission.size || '—',
    authenticated: submission.access === 'authenticated',
  };
}

function validateSubmission(body) {
  const access = body.access === 'authenticated' ? 'authenticated' : body.access;
  const category = safeString(body.category, 40);
  const title = safeString(body.title, 180);
  const slug = safeSlug(body.slug || title);
  const files = Array.isArray(body.files) ? body.files : [];
  if (!REPORT_ACCESS.has(access)) return { error: 'access must be public or authenticated' };
  if (!REPORT_CATEGORIES.has(category)) return { error: 'Choose a supported category' };
  if (!title) return { error: 'A report title is required' };
  if (!slug) return { error: 'A URL slug or title containing letters/numbers is required' };
  if (!files.length || files.length > MAX_UPLOAD_FILES) return { error: `Choose 1–${MAX_UPLOAD_FILES} files, including index.html` };
  const normalizedFiles = [];
  let totalBytes = 0;
  const names = new Set();
  for (const file of files) {
    const name = safeFileName(file && file.name);
    const size = Number(file && file.size);
    if (!name || !Number.isFinite(size) || size < 0 || size > MAX_UPLOAD_BYTES || names.has(name)) return { error: 'Invalid, duplicate, or oversized file name' };
    names.add(name); totalBytes += size;
    normalizedFiles.push({ name, size, contentType: safeString(file.contentType, 120) || 'application/octet-stream' });
  }
  // Browser directory inputs commonly include the selected folder itself in
  // every relative path (for example, report/index.html). Strip that one
  // wrapper while retaining any real nested asset directories.
  const roots = normalizedFiles.map(file => file.name.split('/')[0]);
  if (roots.length && roots.every(root => root === roots[0]) && normalizedFiles.every(file => file.name.includes('/'))) {
    normalizedFiles.forEach(file => { file.name = file.name.substring(file.name.indexOf('/') + 1); });
  }
  const outputNames = new Set(normalizedFiles.map(file => file.name));
  if (outputNames.size !== normalizedFiles.length) return { error: 'Duplicate file names after folder normalization' };
  let entryFile = safeFileName(body.entryFile);
  if (!entryFile) {
    const htmlFiles = normalizedFiles.filter(file => /\.html?$/i.test(file.name));
    if (htmlFiles.length !== 1) return { error: 'Specify entryFile when the bundle has zero or multiple HTML files' };
    entryFile = htmlFiles[0].name;
  }
  if (!outputNames.has(entryFile)) return { error: 'entryFile must be one of the uploaded files' };
  if (totalBytes > MAX_UPLOAD_BYTES) return { error: 'The report bundle exceeds the 100 MB limit' };
  const tags = Array.isArray(body.tags) ? body.tags.map(tag => safeString(tag, 40)).filter(Boolean).slice(0, 20) : [];
  return {
    access, category, title, slug, files: normalizedFiles, entryFile, tags,
    description: safeString(body.description, 1000),
    status: ['draft', 'final', 'archived'].includes(body.status) ? body.status : 'final',
    size: safeString(body.size, 40),
  };
}

exports.handler = async (event) => {
  const origin = event.headers && event.headers.origin;

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(origin), body: '' };
  }

  const method = event.httpMethod;
  const path = event.path || event.resource || '';
  const isReportsPath = path.endsWith('/reports');
  const reportMatch = path.match(/\/reports\/([a-f0-9-]+)\/complete$/);
  const requestHeaders = event.headers || {};
  const cookies = parseCookies(requestHeaders.cookie || requestHeaders.Cookie);
  let authenticated = verifyCookie(cookies[COOKIE_NAME]);

  // The public index is intentionally readable without a browser session.
  // Private metadata is never returned through this branch.
  if (method === 'GET' && isReportsPath && (event.queryStringParameters || {}).access === 'public') {
    return response(200, { reports: await listReports('public') }, origin);
  }

  if (!authenticated && (isReportsPath || reportMatch)) authenticated = await cliPrincipal(requestHeaders);
  if (!authenticated) {
    return response(401, { error: 'Not authenticated' }, origin);
  }

  const isTokensPath = path.endsWith('/tokens');

  // GET /reports?access=authenticated — list private report metadata.
  if (method === 'GET' && isReportsPath) {
    const access = (event.queryStringParameters || {}).access;
    if (access !== 'authenticated') return response(400, { error: 'access must be authenticated' }, origin);
    return response(200, { reports: await listReports(access) }, origin);
  }

  // POST /reports — create a short-lived, direct-to-S3 upload plan.
  if (method === 'POST' && isReportsPath) {
    if (!authenticated.githubHandle) {
      return response(403, { error: 'Report submission requires a fresh GitHub sign-in so the submitter can be recorded' }, origin);
    }
    const submission = validateSubmission(parseBody(event.body));
    if (submission.error) return response(400, { error: submission.error }, origin);
    const parentId = safeString(parseBody(event.body).parentId, 64);
    let parent;
    if (parentId) {
      try { parent = await getJson(`report-meta/${submission.access}/${parentId}.json`); } catch (e) { return response(404, { error: 'Current report not found' }, origin); }
      if (String(parent.author).toLowerCase() !== authenticated.githubHandle.toLowerCase()) return response(403, { error: 'You may update only your own reports' }, origin);
      if (parent.isLatest === false) return response(409, { error: 'This is no longer the current revision' }, origin);
    }
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    submission.date = createdAt.slice(0, 10);
    const suffix = id.split('-')[0];
    const baseKey = `${submission.access === 'public' ? 'public' : 'private'}/${submission.category}/${submission.date}_${submission.slug}-${suffix}`;
    const pending = {
      ...submission, id, baseKey, cloudfrontDomain: process.env.CLOUDFRONT_DOMAIN,
      author: authenticated.githubHandle,
      parentId: parentId || null,
      parentAccess: parent ? submission.access : null,
      reportId: parent ? (parent.reportId || parent.id) : id,
      version: parent ? (Number(parent.version) || 1) + 1 : 1,
      createdAt, expiresAt: new Date(Date.now() + UPLOAD_URL_TTL * 1000).toISOString(),
    };
    await putJson(`report-submissions/${id}.json`, pending);
    const uploads = await Promise.all(pending.files.map(async file => ({
      name: file.name,
      url: await getSignedUrl(s3, new PutObjectCommand({
        Bucket: BUCKET, Key: `${baseKey}/${file.name}`, ContentType: file.contentType,
        CacheControl: 'no-cache',
      }), { expiresIn: UPLOAD_URL_TTL }),
    })));
    return response(201, { id, uploads, expiresAt: pending.expiresAt }, origin);
  }

  // POST /reports/<id>/complete — only publish metadata after index.html exists.
  if (method === 'POST' && reportMatch) {
    const id = reportMatch[1];
    let pending;
    try { pending = await getJson(`report-submissions/${id}.json`); }
    catch (error) { return response(404, { error: 'Upload plan not found or already completed' }, origin); }
    if (Date.now() > Date.parse(pending.expiresAt)) {
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: `report-submissions/${id}.json` }));
      return response(410, { error: 'Upload plan expired; start again' }, origin);
    }
    try { await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: `${pending.baseKey}/${pending.entryFile}` })); }
    catch (error) { return response(400, { error: 'The selected HTML entry file has not been uploaded yet' }, origin); }
    const entry = reportEntry(pending);
    if (pending.parentId) {
      const parent = await getJson(`report-meta/${pending.parentAccess}/${pending.parentId}.json`);
      parent.isLatest = false;
      parent.reportId = parent.reportId || parent.id;
      parent.version = parent.version || 1;
      parent.supersededBy = entry.id;
      await putJson(`report-meta/${pending.parentAccess}/${pending.parentId}.json`, parent);
    }
    await putJson(`report-meta/${pending.access}/${id}.json`, entry);
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: `report-submissions/${id}.json` }));
    return response(201, { report: entry }, origin);
  }

  if (method === 'DELETE' && isReportsPath) {
    const query = event.queryStringParameters || {};
    const access = query.access;
    const id = safeString(query.id, 64);
    if (!REPORT_ACCESS.has(access) || !/^(legacy-)?[a-f0-9-]+$/.test(id)) return response(400, { error: 'Invalid report identifier' }, origin);
    if (!authenticated.githubHandle) return response(403, { error: 'GitHub sign-in required' }, origin);
    let entry;
    try { entry = await getJson(`report-meta/${access}/${id}.json`); } catch (e) { return response(404, { error: 'Report not found' }, origin); }
    if (String(entry.author).toLowerCase() !== authenticated.githubHandle.toLowerCase()) return response(403, { error: 'You may delete only your own reports' }, origin);
    const prefix = new URL(entry.path).pathname.replace(/^\//, '').replace(/\/[^/]+$/, '/');
    if (!prefix.startsWith(access === 'public' ? 'public/' : 'private/')) return response(400, { error: 'Invalid report storage path' }, origin);
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: `report-meta/${access}/${id}.json` }));
    await deleteReportObjects(prefix);
    return response(200, { deleted: id }, origin);
  }

  // PATCH /reports?access=public&id=... — retain files, mark an owned report archived.
  if (method === 'PATCH' && isReportsPath) {
    const query = event.queryStringParameters || {};
    const access = query.access;
    const id = safeString(query.id, 64);
    if (!REPORT_ACCESS.has(access) || !/^(legacy-)?[a-f0-9-]+$/.test(id)) return response(400, { error: 'Invalid report identifier' }, origin);
    if (!authenticated.githubHandle) return response(403, { error: 'GitHub sign-in required' }, origin);
    let entry;
    try { entry = await getJson(`report-meta/${access}/${id}.json`); } catch (e) { return response(404, { error: 'Report not found' }, origin); }
    if (String(entry.author).toLowerCase() !== authenticated.githubHandle.toLowerCase()) return response(403, { error: 'You may archive only your own reports' }, origin);
    entry.status = 'archived';
    entry.archivedAt = new Date().toISOString();
    await putJson(`report-meta/${access}/${id}.json`, entry);
    return response(200, { report: entry }, origin);
  }

  // GET /tokens — list tokens (redacted)
  if (method === 'GET' && isTokensPath) {
    const data = await getTokens();
    const redacted = Object.entries(data.tokens).map(([token, info]) => ({
      id: tokenPrefix(token, info) + '...',
      group: info.group || 'everyone',
      note: info.note || '',
      created: info.created || '',
      expires: info.expires || null,
      active: tokenIsActive(info),
    }));
    return response(200, { tokens: redacted, githubHandle: authenticated.githubHandle }, origin);
  }

  // POST /tokens — create token
  if (method === 'POST' && isTokensPath) {
    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch (e) {}
    const group = body.group || 'everyone';
    const note = body.note || `${group} access`;
    const lifetimeDays = body.lifetimeDays === undefined ? 7 : Number(body.lifetimeDays);
    if (!Number.isInteger(lifetimeDays) || lifetimeDays < 0 || lifetimeDays > 3650) {
      return response(400, { error: 'lifetimeDays must be an integer from 0 (long-lived) to 3650' }, origin);
    }

    const token = TOKEN_PREFIX + crypto.randomBytes(TOKEN_LENGTH).toString('base64url').substring(0, TOKEN_LENGTH);
    const data = await getTokens();
    data.tokens[tokenDigest(token)] = {
      prefix: token.substring(0, 20),
      created: new Date().toISOString().split('T')[0],
      group,
      note,
      expires: expirationTimestamp(lifetimeDays),
      active: true,
    };
    await putTokens(data);

    return response(201, { token, group, note, expires: expirationTimestamp(lifetimeDays) }, origin);
  }

  // DELETE /tokens — revoke token by prefix
  if (method === 'DELETE' && isTokensPath) {
    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch (e) {}
    const prefix = body.prefix || '';
    if (!prefix) return response(400, { error: 'Missing prefix' }, origin);

    const data = await getTokens();
    let revoked = 0;
    for (const [token, info] of Object.entries(data.tokens)) {
      if (tokenPrefix(token, info).startsWith(prefix) && tokenIsActive(info)) {
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

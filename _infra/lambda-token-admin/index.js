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
const BASE_KEY_PATTERN = /^(public|private)\/(benchmarks|ci|investigations|presentations)\/(\d{4}-\d{2}-\d{2})_([a-z0-9-]+)-([a-f0-9]+)$/;

const s3 = new S3Client({ region: REGION });
const lifecycle = () => process.env.REPORT_STAGING_BUCKET ? require('./publication-s3').publication() : null;

async function managedEntry(id, access) {
  const service = lifecycle();
  if (!service) return null;
  const reportId = await service.locate(id);
  if (!reportId) return null;
  const doc = (await service.read(reportId))?.value;
  const revision = doc?.revisions[id];
  if (!revision || !['COMMITTED', 'DELETING'].includes(revision.state) || revision.metadata.authenticated !== (access === 'authenticated')) {
    const error = new Error('Report not found'); error.status = 404; throw error;
  }
  return { ...revision.metadata, isLatest: doc.head === id };
}

async function adoptEntry(entry, access, owner) {
  if (!lifecycle() || await lifecycle().locate(entry.id)) return;
  let prefix = null;
  if (!entry.externalUrl) {
    prefix = entry.baseKey ? reportBundlePrefix(entry, access, entry.id) : new URL(entry.path).pathname.replace(/^\//, '').replace(/\/[^/]+$/, '/');
    if (!prefix || !prefix.startsWith(access === 'public' ? 'public/' : 'private/') || prefix.split('/').filter(Boolean).length < 3) {
      const error = new Error('Invalid report storage path'); error.status = 400; throw error;
    }
  }
  await lifecycle().adopt(entry, owner, prefix);
}

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
  const maxAge = method === 'github' || method === 'google' ? GITHUB_COOKIE_MAX_AGE :
    method === 'token' ? TOKEN_COOKIE_MAX_AGE : 0;
  if (!(authenticated === 'authenticated' && maxAge > 0 && /^\d+$/.test(issuedAt || '') &&
    Date.now() <= Number(issuedAt) + maxAge * 1000)) return null;
  return { method, githubHandle: method === 'github' ? githubHandle || null : null,
    email: method === 'google' ? githubHandle || null : null };
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
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function response(statusCode, body, origin) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders(origin) },
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

async function listLegacyReports(access, includeSuperseded = false) {
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
  const counts = new Map();
  entries.forEach(entry => { const id = entry.reportId || entry.id; counts.set(id, (counts.get(id) || 0) + 1); });
  return entries.filter(entry => includeSuperseded || entry.isLatest !== false)
    .map(entry => ({ ...entry, reportId: entry.reportId || entry.id, version: entry.version || 1, versionCount: counts.get(entry.reportId || entry.id) || 1 }))
    .sort((a, b) => String(b.submittedAt || b.date).localeCompare(String(a.submittedAt || a.date)));
}

async function listReports(access, includeSuperseded = false) {
  if (!lifecycle()) return listLegacyReports(access, includeSuperseded);
  const legacy = await listLegacyReports(access, true);
  const current = await lifecycle().listReports(access, includeSuperseded);
  const remaining = legacy.filter(entry => !current.migrated.has(entry.id));
  const counts = new Map();
  for (const entry of [...remaining, ...current.allReports]) {
    const id = entry.reportId || entry.id;
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  return [...remaining.filter(entry => includeSuperseded || entry.isLatest !== false), ...current.reports]
    .map(entry => ({ ...entry, versionCount: counts.get(entry.reportId || entry.id) || 1 }))
    .sort((a, b) => String(b.submittedAt || b.date).localeCompare(String(a.submittedAt || a.date)));
}

async function deleteReportObjects(prefix) {
  let token;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token }));
    const objects = (page.Contents || []).map(item => ({ Key: item.Key }));
    for (let offset = 0; offset < objects.length; offset += 1000) {
      const result = await s3.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: objects.slice(offset, offset + 1000), Quiet: true } }));
      if (result.Errors && result.Errors.length) {
        const error = new Error('Some report files could not be deleted');
        error.failedCount = result.Errors.length;
        throw error;
      }
    }
    if (page.IsTruncated && !page.NextContinuationToken) throw new Error('Incomplete report file listing');
    token = page.NextContinuationToken;
  } while (token);
  const remaining = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, MaxKeys: 1 }));
  if ((remaining.Contents || []).length || remaining.IsTruncated || remaining.NextContinuationToken) {
    throw new Error('Report files remain after deletion');
  }
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
    path: submission.externalUrl || `https://${submission.cloudfrontDomain}/${submission.baseKey}/${submission.entryFile}`,
    externalUrl: submission.externalUrl || null,
    ...(submission.baseKey && !submission.externalUrl ? { baseKey: submission.baseKey } : {}),
    size: submission.size || '—',
    authenticated: submission.access === 'authenticated',
  };
}

function reportBundlePrefix(entry, access, id) {
  if (typeof entry.baseKey !== 'string' || entry.baseKey !== entry.baseKey.trim()) return null;
  const match = entry.baseKey.match(BASE_KEY_PATTERN);
  if (!match) return null;
  if (match[1] !== (access === 'public' ? 'public' : 'private')) return null;
  // Category is editable metadata, while baseKey keeps the creation category.
  // Validate the supported storage format instead of the current category.
  if (match[3] !== entry.date) return null;
  if (match[5] !== id.split('-')[0]) return null;
  return `${entry.baseKey}/`;
}

function validateSubmission(body) {
  const access = body.access === 'authenticated' ? 'authenticated' : body.access;
  const category = safeString(body.category, 40);
  const title = safeString(body.title, 180);
  const slug = safeSlug(body.slug || title);
  const files = Array.isArray(body.files) ? body.files : [];
  const externalUrl = safeString(body.externalUrl, 2000);
  const pathMode = body.pathMode === undefined || body.pathMode === null || body.pathMode === '' ? 'strip' : body.pathMode;
  if (!['strip', 'preserve'].includes(pathMode)) return { error: 'pathMode must be strip or preserve' };
  if (!REPORT_ACCESS.has(access)) return { error: 'access must be public or authenticated' };
  if (!REPORT_CATEGORIES.has(category)) return { error: 'Choose a supported category' };
  if (!title) return { error: 'A report title is required' };
  if (!slug) return { error: 'A URL slug or title containing letters/numbers is required' };
  if (externalUrl) {
    try { if (new URL(externalUrl).protocol !== 'https:') throw new Error(); } catch (e) { return { error: 'External URL must be a valid HTTPS URL' }; }
    if (files.length) return { error: 'An external-link report cannot include uploaded files' };
    return { access, category, title, slug, files: [], entryFile: null, externalUrl, tags: Array.isArray(body.tags) ? body.tags.map(tag => safeString(tag, 40)).filter(Boolean).slice(0, 20) : [], description: safeString(body.description, 1000), status: 'final', size: '—' };
  }
  if (!files.length || files.length > MAX_UPLOAD_FILES) return { error: `Choose 1–${MAX_UPLOAD_FILES} files` };
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
  // every relative path (for example, report/index.html). Legacy callers strip
  // that one wrapper while retaining any real nested asset directories. Callers
  // that already send paths relative to their source root opt into preserve.
  const originalNames = normalizedFiles.map(file => file.name);
  const roots = originalNames.map(name => name.split('/')[0]);
  const stripRoot = pathMode === 'strip' && roots.length &&
    roots.every(root => root === roots[0]) && originalNames.every(name => name.includes('/'))
    ? roots[0] : null;
  if (stripRoot) {
    normalizedFiles.forEach(file => { file.name = file.name.substring(file.name.indexOf('/') + 1); });
  }
  const normalizedByOriginal = stripRoot
    ? new Map(originalNames.map((name, index) => [name, normalizedFiles[index].name]))
    : null;
  const outputNames = new Set(normalizedFiles.map(file => file.name));
  if (outputNames.size !== normalizedFiles.length) return { error: 'Duplicate file names after folder normalization' };
  let entryFile = safeFileName(body.entryFile);
  const entryProvided = body.entryFile !== undefined && body.entryFile !== null &&
    !(typeof body.entryFile === 'string' && body.entryFile.trim() === '');
  if (entryProvided && !entryFile) return { error: 'entryFile must be a valid relative file path' };
  if (!entryFile) {
    const htmlFiles = normalizedFiles.filter(file => /\.html?$/i.test(file.name));
    if (htmlFiles.length !== 1) return { error: 'Specify entryFile when the bundle has zero or multiple HTML files' };
    entryFile = htmlFiles[0].name;
  } else if (normalizedByOriginal && normalizedByOriginal.has(entryFile)) {
    // Legacy folder-selection payloads use the original wrapper-prefixed path.
    // Map it through the same one-time normalization as the files. An explicit
    // path that is not an original name is treated as already normalized, and
    // inferred entries are always taken from the normalized names above. If a
    // path is both an original and a normalized name, the original-name
    // interpretation wins deterministically.
    entryFile = normalizedByOriginal.get(entryFile);
  }
  if (!outputNames.has(entryFile)) return { error: 'entryFile must be one of the uploaded files' };
  if (totalBytes > MAX_UPLOAD_BYTES) return { error: 'The report bundle exceeds the 100 MB limit' };
  const tags = Array.isArray(body.tags) ? body.tags.map(tag => safeString(tag, 40)).filter(Boolean).slice(0, 20) : [];
  return {
    access, category, title, slug, files: normalizedFiles, entryFile, pathMode, tags,
    description: safeString(body.description, 1000),
    status: ['draft', 'final', 'archived'].includes(body.status) ? body.status : 'final',
    size: safeString(body.size, 40),
  };
}

async function handle(event) {
  const origin = event.headers && event.headers.origin;

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(origin), body: '' };
  }

  const method = event.httpMethod;
  const path = event.path || event.resource || '';
  const isReportsPath = path.endsWith('/reports');
  const isUploadsPath = path.endsWith('/uploads');
  const reportMatch = path.match(/\/reports\/([a-f0-9-]+)\/complete$/);
  const requestHeaders = event.headers || {};
  const cookies = parseCookies(requestHeaders.cookie || requestHeaders.Cookie);
  let authenticated = verifyCookie(cookies[COOKIE_NAME]);

  // The public index is intentionally readable without a browser session.
  // Private metadata is never returned through this branch.
  if (method === 'GET' && isReportsPath && (event.queryStringParameters || {}).access === 'public') {
    const query = event.queryStringParameters || {};
    let reports = await listReports('public', query.history === '1');
    if (query.reportId) reports = reports.filter(entry => entry.reportId === query.reportId);
    return response(200, { reports }, origin);
  }

  if (!authenticated && (isReportsPath || reportMatch || isUploadsPath)) authenticated = await cliPrincipal(requestHeaders);
  if (!authenticated) {
    return response(401, { error: 'Not authenticated' }, origin);
  }

  const isTokensPath = path.endsWith('/tokens');

  if (method === 'GET' && isUploadsPath) {
    if (!authenticated.githubHandle) return response(403, { error: 'GitHub uploader sign-in required' }, origin);
    if (!lifecycle()) return response(200, { uploads: [], cursor: null, enabled: false }, origin);
    const query = event.queryStringParameters || {};
    let cursor;
    if (query.cursor) {
      try {
        const [payload, signature] = query.cursor.split('.');
        const expected = crypto.createHmac('sha256', COOKIE_SECRET).update(payload).digest('base64url');
        if (signature !== expected) throw new Error();
        const value = JSON.parse(Buffer.from(payload, 'base64url').toString());
        if (value.owner !== authenticated.githubHandle.toLowerCase() || Date.now() > value.expires) throw new Error();
        cursor = value.cursor;
      } catch (_) { return response(400, { error: 'Invalid or expired page cursor; refresh the upload list' }, origin); }
    }
    const result = await lifecycle().dashboard(authenticated.githubHandle, cursor, query.id);
    if (result.cursor) {
      const payload = Buffer.from(JSON.stringify({ owner: authenticated.githubHandle.toLowerCase(), cursor: result.cursor, expires: Date.now() + 3600000 })).toString('base64url');
      result.cursor = `${payload}.${crypto.createHmac('sha256', COOKIE_SECRET).update(payload).digest('base64url')}`;
    }
    return response(200, { ...result, enabled: true }, origin);
  }

  // Session identity is separate from token administration for read-only users.
  if (method === 'GET' && path.endsWith('/session')) {
    return response(200, { method: authenticated.method, githubHandle: authenticated.githubHandle,
      email: authenticated.email || null, viewOnly: authenticated.method === 'google' }, origin);
  }
  if (authenticated.method === 'google' && !(method === 'GET' && isReportsPath)) {
    return response(403, { error: 'Google sign-in provides view-only report access' }, origin);
  }

  // GET /reports?access=authenticated — list private report metadata.
  if (method === 'GET' && isReportsPath) {
    const query = event.queryStringParameters || {};
    const access = query.access;
    if (access !== 'authenticated') return response(400, { error: 'access must be authenticated' }, origin);
    let reports = await listReports(access, query.history === '1');
    if (query.reportId) reports = reports.filter(entry => entry.reportId === query.reportId);
    return response(200, { reports }, origin);
  }

  // POST /reports — create a short-lived, direct-to-S3 upload plan.
  if (method === 'POST' && isReportsPath) {
    if (!authenticated.githubHandle) {
      return response(403, { error: 'Report submission requires a fresh GitHub sign-in so the submitter can be recorded' }, origin);
    }
    const submission = validateSubmission(parseBody(event.body));
    if (submission.error) return response(400, { error: submission.error }, origin);
    if (lifecycle() && process.env.REPORT_UPLOAD_MODE !== 'v2') return response(503, { error: 'New uploads are paused for publication rollout' }, origin);
    const parentId = safeString(parseBody(event.body).parentId, 64);
    let parent;
    if (parentId) {
      parent = await managedEntry(parentId, submission.access);
      if (!parent) try { parent = await getJson(`report-meta/${submission.access}/${parentId}.json`); } catch (e) { return response(404, { error: 'Current report not found' }, origin); }
      if (String(parent.author).toLowerCase() !== authenticated.githubHandle.toLowerCase()) return response(403, { error: 'You may update only your own reports' }, origin);
      if (parent.isLatest === false) return response(409, { error: 'This is no longer the current revision' }, origin);
      await adoptEntry(parent, submission.access, authenticated.githubHandle);
    }
    if (lifecycle()) return response(201, await lifecycle().plan(submission, authenticated.githubHandle, parentId), origin);
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
    if (submission.externalUrl) {
      const entry = reportEntry(pending);
      if (parent) { parent.isLatest = false; parent.reportId = parent.reportId || parent.id; parent.version = parent.version || 1; parent.supersededBy = entry.id; await putJson(`report-meta/${submission.access}/${parentId}.json`, parent); }
      await putJson(`report-meta/${submission.access}/${id}.json`, entry);
      return response(201, { report: entry, external: true }, origin);
    }
    await putJson(`report-submissions/${id}.json`, pending);
    const uploads = await Promise.all(pending.files.map(async file => ({
      name: file.name,
      url: await getSignedUrl(s3, new PutObjectCommand({
        Bucket: BUCKET, Key: `${baseKey}/${file.name}`, ContentType: file.contentType,
        CacheControl: 'no-cache',
      }), { expiresIn: UPLOAD_URL_TTL }),
    })));
    return response(201, { id, uploads, expiresAt: pending.expiresAt, pathMode: submission.pathMode }, origin);
  }

  // POST /reports/<id>/complete — only publish metadata after index.html exists.
  if (method === 'POST' && reportMatch) {
    const id = reportMatch[1];
    if (lifecycle() && await lifecycle().locate(id)) return response(201, { report: await lifecycle().complete(id, authenticated.githubHandle) }, origin);
    if (lifecycle()) return response(410, { error: 'Legacy upload plan retired; start a new upload' }, origin);
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
    entry = await managedEntry(id, access);
    if (!entry) try { entry = await getJson(`report-meta/${access}/${id}.json`); } catch (e) { return response(404, { error: 'Report not found' }, origin); }
    if (String(entry.author).toLowerCase() !== authenticated.githubHandle.toLowerCase()) return response(403, { error: 'You may delete only your own reports' }, origin);
    if (lifecycle()) {
      await adoptEntry(entry, access, authenticated.githubHandle);
      await lifecycle().remove(id, authenticated.githubHandle, access);
      return response(200, { deleted: id }, origin);
    }
    let prefix;
    if (entry.externalUrl) {
      prefix = null;
    } else if (entry.baseKey !== undefined && entry.baseKey !== null) {
      prefix = reportBundlePrefix(entry, access, id);
      if (!prefix) return response(400, { error: 'Invalid report storage path' }, origin);
    } else {
      // Older metadata has no recorded bundle key. Keep the prior root-entry
      // fallback, which deletes the directory containing the entry page.
      prefix = new URL(entry.path).pathname.replace(/^\//, '').replace(/\/[^/]+$/, '/');
      if (!prefix.startsWith(access === 'public' ? 'public/' : 'private/')) return response(400, { error: 'Invalid report storage path' }, origin);
    }
    let stage = 'files';
    try {
      if (prefix) await deleteReportObjects(prefix);
      stage = 'metadata';
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: `report-meta/${access}/${id}.json` }));
    } catch (error) {
      const failedCount = Number.isInteger(error.failedCount) ? error.failedCount : undefined;
      console.log(JSON.stringify({ event: 'report_deletion_failed', id, access, stage, failedCount }));
      return response(502, {
        error: stage === 'files'
          ? 'Report file deletion could not be verified. The report listing was retained for retry; some files may already be deleted. Retry Delete. If this persists, contact the report hub administrator.'
          : 'Report metadata deletion could not be confirmed. Bundle deletion completed (or this is an external link). Refresh the listing and retry Delete if the report remains.',
        stage, ...(failedCount !== undefined ? { failedCount } : {}),
      }, origin);
    }
    return response(200, { deleted: id }, origin);
  }

  // PATCH /reports?access=public&id=... — edit info or archive an owned report.
  if (method === 'PATCH' && isReportsPath) {
    const query = event.queryStringParameters || {};
    const access = query.access;
    const id = safeString(query.id, 64);
    if (!REPORT_ACCESS.has(access) || !/^(legacy-)?[a-f0-9-]+$/.test(id)) return response(400, { error: 'Invalid report identifier' }, origin);
    if (!authenticated.githubHandle) return response(403, { error: 'GitHub sign-in required' }, origin);
    let entry;
    entry = await managedEntry(id, access);
    if (!entry) try { entry = await getJson(`report-meta/${access}/${id}.json`); } catch (e) { return response(404, { error: 'Report not found' }, origin); }
    if (String(entry.author).toLowerCase() !== authenticated.githubHandle.toLowerCase()) return response(403, { error: 'You may update only your own reports' }, origin);
    const body = parseBody(event.body);
    if (lifecycle()) await adoptEntry(entry, access, authenticated.githubHandle);
    if (body.action === 'metadata') {
      if (entry.isLatest === false) return response(409, { error: 'This is no longer the current revision' }, origin);
      const allowed = new Set(['action', 'title', 'description', 'category', 'tags']);
      if (Object.keys(body).some(key => !allowed.has(key))) return response(400, { error: 'Only title, description, category, and tags may be edited' }, origin);
      const title = safeString(body.title, 180);
      const category = safeString(body.category, 40);
      if (!title) return response(400, { error: 'A report title is required' }, origin);
      if (!REPORT_CATEGORIES.has(category)) return response(400, { error: 'Choose a supported category' }, origin);
      if (!Array.isArray(body.tags) || body.tags.length > 20 || body.tags.some(tag => typeof tag !== 'string')) return response(400, { error: 'Choose at most 20 tags' }, origin);
      entry.title = title;
      entry.category = category;
      entry.description = safeString(body.description, 1000);
      entry.tags = [...new Set(body.tags.map(tag => safeString(tag, 40)).filter(Boolean))];
      entry.updatedAt = new Date().toISOString();
    } else if (!body.action || body.action === 'archive') {
      entry.status = 'archived';
      entry.archivedAt = new Date().toISOString();
    } else {
      return response(400, { error: 'Unsupported report update action' }, origin);
    }
    if (lifecycle()) {
      const changes = body.action === 'metadata' ? { title: entry.title, category: entry.category, description: entry.description, tags: entry.tags, updatedAt: entry.updatedAt }
        : { status: entry.status, archivedAt: entry.archivedAt };
      return response(200, { report: await lifecycle().edit(id, authenticated.githubHandle, access, changes) }, origin);
    }
    await putJson(`report-meta/${access}/${id}.json`, entry);
    return response(200, { report: entry }, origin);
  }

  // GET /tokens — list tokens (redacted)
  if (method === 'GET' && isTokensPath) {
    const data = await getTokens();
    const redacted = Object.entries(data.tokens).map(([token, info]) => ({
      id: tokenPrefix(token, info) + '...',
      revokePrefix: tokenPrefix(token, info),
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
    // Accept the old UI's display suffix during rolling frontend updates.
    const prefix = typeof body.prefix === 'string' ? body.prefix.replace(/\.\.\.$/, '') : '';
    if (!prefix) return response(400, { error: 'Missing prefix' }, origin);

    const data = await getTokens();
    const matches = Object.entries(data.tokens).filter(([token, info]) => tokenPrefix(token, info) === prefix && tokenIsActive(info));
    if (matches.length === 0) return response(404, { error: 'No matching active tokens' }, origin);
    if (matches.length > 1) return response(409, { error: 'Token prefix is ambiguous; contact the report hub administrator' }, origin);
    matches[0][1].active = false;
    await putTokens(data);
    return response(200, { revoked: 1 }, origin);
  }

  return response(404, { error: 'Not found' }, origin);
};

exports.handler = async event => {
  try { return await handle(event); }
  catch (error) {
    console.log(JSON.stringify({ event: 'report_api_failed', status: error.status || 502 }));
    return response(error.status || 502, { error: error.status ? error.message : 'Storage operation could not be confirmed. Refresh the hub and retry; incomplete uploads remain private.' }, event.headers?.origin);
  }
};

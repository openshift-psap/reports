'use strict';

// One compare-and-swap document owns head, revision, attempt and cleanup state.
// Storage is injected so races and ambiguous writes can be tested without AWS.
const crypto = require('crypto');
const DAY = 86400000;
const RETENTION = 7 * DAY;
const UPLOAD_URL_TTL = 15 * 60;
const RECOVERY_WINDOW = 6 * 60 * 60 * 1000;
const LEASE = 120000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const REPORT_ID = /^(legacy-)?[a-f0-9-]+$/;
const validReportId = id => typeof id === 'string' && id.length <= 64 && REPORT_ID.test(id);
const controlKey = id => `report-control-v2/${id}.json`;
const locatorKey = id => `report-locators-v2/${id}.json`;
const conflict = error => [409, 412].includes(error.$metadata?.httpStatusCode) || ['PreconditionFailed', 'ConditionalRequestConflict'].includes(error.name);
class PublicationError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new PublicationError(status, message); };
const owned = (doc, owner) => { if (!owner || doc.owner !== owner.toLowerCase()) fail(403, 'You may manage only your own uploads'); };

function createPublication({ store, domain, now = Date.now, uuid = crypto.randomUUID, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), log = entry => console.log(JSON.stringify(entry)) }) {
  async function read(id) {
    if (!UUID.test(id)) fail(400, 'Invalid report identifier');
    return store.get(controlKey(id));
  }
  async function change(id, update) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const current = await read(id);
      const doc = current ? structuredClone(current.value) : { schema: 2, id, generation: 0, head: null, revisions: {} };
      const result = update(doc);
      if (result?.unchanged) return { doc, result: result.value };
      doc.generation++;
      doc.updatedAt = now();
      try {
        await store.put(controlKey(id), doc, current?.etag);
        return { doc, result };
      } catch (error) {
        if (!conflict(error)) throw error; // ambiguous writes are resolved by operation ID on the next request
        await sleep(Math.floor(Math.random() * Math.min(250, 10 * 2 ** attempt)));
      }
    }
    fail(409, 'Report changed concurrently; retry the operation');
  }
  async function locate(id) {
    if (!validReportId(id)) return null;
    return (await store.get(locatorKey(id)))?.value.reportId || null;
  }
  async function locator(id, reportId) {
    try { await store.put(locatorKey(id), { reportId }); }
    catch (error) {
      if (!conflict(error) || await locate(id) !== reportId) throw error;
    }
  }
  function entry(doc, revision) {
    return { ...revision.metadata, reportId: doc.id, isLatest: doc.head === revision.id,
      versionCount: Object.values(doc.revisions).filter(item => ['COMMITTED', 'DELETING'].includes(item.state)).length,
      publicationVersion: 2 };
  }

  // Called for legacy mutations during rollout as well as legacy replacements.
  // All writers must use this API version before v2 issuance is enabled.
  async function adopt(legacy, owner, prefix) {
    if (!validReportId(legacy.id)) fail(400, 'Invalid report identifier');
    const hash = crypto.createHash('sha256').update(`legacy:${legacy.id}`).digest('hex');
    const legacyId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
    const reportId = UUID.test(legacy.reportId) ? legacy.reportId : UUID.test(legacy.id) ? legacy.id : legacyId;
    const existing = await locate(legacy.id);
    if (existing) return existing;
    const { doc } = await change(reportId, doc => {
      if (doc.owner) owned(doc, owner);
      else doc.owner = owner.toLowerCase();
      if (doc.revisions[legacy.id]) return { unchanged: true };
      doc.revisions[legacy.id] = { id: legacy.id, state: 'COMMITTED', metadata: legacy,
        adopted: true, legacyPrefix: prefix, attempts: {}, createdAt: now(), retainUntil: now() };
      if (!doc.head && legacy.isLatest !== false) doc.head = legacy.id;
    });
    owned(doc, owner);
    await locator(legacy.id, reportId);
    return reportId;
  }

  async function plan(submission, owner, parentId) {
    const id = uuid();
    const reportId = parentId ? await locate(parentId) : id;
    if (!reportId) fail(409, 'Register the current report revision before replacing it');
    const createdAt = now();
    const { doc } = await change(reportId, doc => {
      if (doc.owner) owned(doc, owner);
      else doc.owner = owner.toLowerCase();
      if (parentId && doc.head !== parentId) fail(409, 'This is no longer the current revision');
      const parent = parentId && doc.revisions[parentId];
      if (parent && (parent.state !== 'COMMITTED' || parent.metadata.authenticated !== (submission.access === 'authenticated'))) fail(409, 'The current revision or visibility changed');
      const version = parent ? (Number(parent.metadata.version) || 1) + 1 : 1;
      doc.revisions[id] = { id, state: 'OPEN', parentId: parentId || null, createdAt, retainUntil: createdAt + RETENTION,
        resumeUntil: createdAt + RECOVERY_WINDOW,
        uploadUrlsExpireAt: createdAt + UPLOAD_URL_TTL * 1000, files: submission.files || [], entryFile: submission.entryFile,
        attempts: {}, metadata: { id, reportId, version, title: submission.title, description: submission.description,
          category: submission.category, tags: submission.tags, status: submission.status, author: doc.owner,
          date: new Date(createdAt).toISOString().slice(0, 10), submittedAt: new Date(createdAt).toISOString(),
          authenticated: submission.access === 'authenticated', externalUrl: submission.externalUrl || null,
          path: submission.externalUrl || `https://${domain}/${submission.access === 'public' ? 'public' : 'private'}/v2/${reportId}/${id}/${submission.entryFile}` } };
    });
    await locator(id, reportId); // no URL leaves the process before both durable records exist
    if (submission.externalUrl) return { report: await complete(id, owner), external: true };
    await store.checkStaging();
    const uploads = [];
    for (const file of submission.files) uploads.push({ name: file.name, url: await store.sign(id, file, UPLOAD_URL_TTL) });
    return { id, uploads, expiresAt: new Date(doc.revisions[id].uploadUrlsExpireAt).toISOString(),
      retainUntil: new Date(doc.revisions[id].retainUntil).toISOString(),
      resumeUntil: new Date(doc.revisions[id].resumeUntil).toISOString(), pathMode: submission.pathMode };
  }

  async function resume(id, submission, owner) {
    const reportId = await locate(id);
    if (!reportId) fail(404, 'Upload plan not found');
    const { doc } = await change(reportId, doc => {
      owned(doc, owner);
      const r = doc.revisions[id];
      if (!r) fail(404, 'Upload plan not found');
      const deadline = r.resumeUntil || r.createdAt + RECOVERY_WINDOW;
      const ttl = Math.min(UPLOAD_URL_TTL, Math.floor((deadline - now()) / 1000));
      if (ttl <= 0) fail(410, 'The six-hour recovery window has ended; start a new upload');
      if (doc.cleanupLease?.until > now() || (r.state === 'PREPARING' && now() < r.leaseUntil)) fail(409, 'Publication is busy; refresh and retry shortly');
      if (!['OPEN', 'ABORTED', 'PREPARING'].includes(r.state) || r.cleanup?.empty) fail(409, 'Upload is no longer editable; refresh the report list');
      if (doc.head !== r.parentId) fail(409, 'Another revision is now current');
      if (submission.externalUrl || r.metadata.externalUrl) fail(400, 'Recovery requires uploaded files');
      if (r.parentId && r.metadata.authenticated !== (submission.access === 'authenticated')) fail(400, 'A replacement must keep the current report visibility');
      r.state = 'OPEN'; r.failure = null; r.activeAttempt = null; r.leaseUntil = null;
      r.resumeUntil = deadline;
      r.uploadUrlsExpireAt = now() + ttl * 1000;
      r.files = submission.files; r.entryFile = submission.entryFile;
      Object.assign(r.metadata, { title: submission.title, description: submission.description,
        category: submission.category, tags: submission.tags, status: submission.status,
        authenticated: submission.access === 'authenticated',
        path: `https://${domain}/${submission.access === 'public' ? 'public' : 'private'}/v2/${reportId}/${id}/${submission.entryFile}` });
    });
    await store.checkStaging();
    const r = doc.revisions[id], uploads = [];
    for (const file of r.files) {
      const ttl = Math.min(UPLOAD_URL_TTL, Math.floor((r.uploadUrlsExpireAt - now()) / 1000));
      if (ttl <= 0) fail(410, 'Upload links expired while preparing; retry recovery');
      uploads.push({ name: file.name, url: await store.sign(id, file, ttl) });
    }
    return { id, uploads, expiresAt: new Date(r.uploadUrlsExpireAt).toISOString(),
      resumeUntil: new Date(r.resumeUntil).toISOString(), retainUntil: new Date(r.retainUntil).toISOString(), pathMode: submission.pathMode };
  }

  async function complete(id, owner) {
    const reportId = await locate(id);
    if (!reportId) fail(404, 'Upload plan not found');
    const attemptId = uuid();
    const { doc } = await change(reportId, doc => {
      owned(doc, owner);
      const r = doc.revisions[id];
      if (!r) fail(404, 'Upload plan not found');
      if (r.state === 'COMMITTED') return { unchanged: true };
      if (r.resumeUntil && now() >= r.resumeUntil) fail(410, 'The six-hour submission window has ended; start a new upload');
      if (now() >= r.retainUntil) fail(410, 'Upload retention deadline passed; start a new upload');
      if (r.state === 'PREPARING' && now() < r.leaseUntil) fail(409, 'Completion is in progress; retry shortly');
      if (!['OPEN', 'PREPARING'].includes(r.state)) fail(409, 'Upload is no longer publishable; start a new upload');
      if (doc.head !== r.parentId) fail(409, 'Another revision is now current');
      r.state = 'PREPARING'; r.leaseUntil = now() + LEASE; r.activeAttempt = attemptId;
      r.attempts[attemptId] = { prefix: `report-objects-v2/${id}/${attemptId}/`, createdAt: now(), state: 'REGISTERED' };
    });
    const r = doc.revisions[id];
    if (r.state === 'COMMITTED') return entry(doc, r);
    try {
      const pinned = [];
      for (const file of r.files) {
        const actual = await store.inspect(id, file.name);
        if (!actual || !actual.version || actual.version === 'null' || actual.size !== file.size || actual.contentType !== file.contentType) {
          fail(400, `Missing or mismatched upload file: ${file.name}. Use Edit and continue within the six-hour recovery window.`);
        }
        pinned.push({ ...file, ...actual });
      }
      await change(reportId, doc => {
        const current = doc.revisions[id];
        if (current.state !== 'PREPARING' || current.activeAttempt !== attemptId || now() >= current.leaseUntil) fail(409, 'Completion lease expired');
        current.attempts[attemptId].pinned = pinned;
      });
      const verified = [];
      for (const file of pinned) verified.push({ name: file.name, ...await store.copyVerified(id, file, r.attempts[attemptId].prefix) });
      const committed = await change(reportId, doc => {
        const current = doc.revisions[id];
        if (current.state === 'COMMITTED' && current.selectedAttempt === attemptId) return { unchanged: true };
        if (current.state !== 'PREPARING' || current.activeAttempt !== attemptId || now() >= current.leaseUntil || now() >= Math.min(current.retainUntil, current.resumeUntil || current.retainUntil)) fail(409, 'Completion lease or submission deadline expired');
        if (doc.head !== current.parentId) fail(409, 'Another revision is now current');
        current.attempts[attemptId].state = 'SELECTED';
        current.attempts[attemptId].verified = verified;
        current.selectedAttempt = attemptId; current.state = 'COMMITTED'; current.committedAt = now();
        doc.head = id;
      });
      return entry(committed.doc, committed.doc.revisions[id]);
    } catch (error) {
      // A successful CAS can lose its response. Read before aborting anything.
      const latest = await read(reportId);
      if (latest?.value.revisions[id]?.state === 'COMMITTED') return entry(latest.value, latest.value.revisions[id]);
      await change(reportId, doc => {
        const current = doc.revisions[id];
        if (current.state !== 'PREPARING' || current.activeAttempt !== attemptId) return { unchanged: true };
        current.state = 'ABORTED'; current.failure = error instanceof PublicationError ? 'validation_or_conflict' : 'publication_storage_failure';
      });
      log({ event: 'publication_failed', reportId, uploadId: id, stage: 'prepare_or_commit' });
      if (error instanceof PublicationError) throw error;
      fail(502, 'Publication failed; files remain private. Check Incomplete uploads and use Edit and continue within six hours.');
    }
  }

  async function listReports(access, history) {
    const reports = [], allReports = [], migrated = new Set();
    let cursor;
    do {
      const page = await store.list(cursor);
      const documents = await Promise.all(page.ids.map(id => read(id)));
      for (const current of documents) {
        if (!current) continue;
        const doc = current.value;
        for (const r of Object.values(doc.revisions)) {
          migrated.add(r.id);
          if (['COMMITTED', 'DELETING'].includes(r.state) && r.metadata.authenticated === (access === 'authenticated')) {
            const report = entry(doc, r);
            allReports.push(report);
            if (history || doc.head === r.id || r.state === 'DELETING') reports.push(report);
          }
        }
      }
      cursor = page.cursor;
    } while (cursor);
    return { reports, allReports, migrated };
  }

  async function dashboard(owner, cursor, detailId) {
    if (!owner) fail(403, 'GitHub uploader sign-in required');
    const reportId = detailId && await locate(detailId);
    const page = detailId ? { ids: reportId ? [reportId] : [] } : await store.list(cursor), uploads = [];
    for (const id of page.ids) {
      const current = await read(id);
      if (!current || current.value.owner !== owner.toLowerCase()) continue;
      for (const r of Object.values(current.value.revisions)) {
        if (detailId && r.id !== detailId) continue;
        if (['COMMITTED', 'DELETING', 'DELETED'].includes(r.state) || r.cleanup?.empty) continue;
        // Counts are observations, never publication authorization. No staged GETs.
        let observedFiles = 0, observedBytes = 0, missing = [], mismatched = [], unknown = !detailId;
        for (const file of detailId ? r.files : []) {
          try {
            const object = await store.inspect(r.id, file.name);
            if (!object) missing.push(file.name);
            else { observedFiles++; observedBytes += object.size; if (object.size !== file.size || object.contentType !== file.contentType) mismatched.push(file.name); }
          } catch (_) { unknown = true; break; }
        }
        uploads.push({ id: r.id, title: r.metadata.title, category: r.metadata.category, access: r.metadata.authenticated ? 'internal' : 'public',
          entryFile: r.entryFile, state: r.state, createdAt: r.createdAt, updatedAt: current.value.updatedAt,
          retainUntil: r.retainUntil, resumeUntil: r.resumeUntil || r.createdAt + RECOVERY_WINDOW,
          canResume: now() < (r.resumeUntil || r.createdAt + RECOVERY_WINDOW) && ['OPEN', 'ABORTED', 'PREPARING'].includes(r.state) && !(r.state === 'PREPARING' && now() < r.leaseUntil) && current.value.head === r.parentId,
          submission: { title: r.metadata.title, description: r.metadata.description, tags: r.metadata.tags,
            category: r.metadata.category, access: r.metadata.authenticated ? 'authenticated' : 'public' },
          uploadUrlsExpireAt: r.uploadUrlsExpireAt, failure: r.failure || null,
          cleanup: r.cleanup ? { failures: r.cleanup.failures, nextRetryAt: r.cleanup.nextRetryAt, verifiedAt: r.cleanup.verifiedAt } : null,
          previousPath: current.value.revisions[r.parentId]?.metadata.path || null,
          expectedFiles: r.files.length, expectedBytes: r.files.reduce((sum, file) => sum + file.size, 0),
          observedAt: now(), observedFiles: unknown ? null : observedFiles, observedBytes: unknown ? null : observedBytes,
          missing: unknown ? null : missing, mismatched: unknown ? null : mismatched });
      }
    }
    return { uploads, cursor: page.cursor || null };
  }

  async function edit(id, owner, access, changes) {
    const reportId = await locate(id);
    if (!reportId) return null;
    const result = await change(reportId, doc => {
      owned(doc, owner);
      const r = doc.revisions[id];
      if (!r || r.metadata.authenticated !== (access === 'authenticated')) fail(404, 'Report not found');
      if (r.state !== 'COMMITTED' || doc.head !== id) fail(409, 'This is no longer the current revision');
      Object.assign(r.metadata, changes);
    });
    return entry(result.doc, result.doc.revisions[id]);
  }

  async function remove(id, owner, access) {
    const reportId = await locate(id);
    if (!reportId) return false;
    const { doc } = await change(reportId, doc => {
      owned(doc, owner);
      const r = doc.revisions[id];
      if (!r || r.metadata.authenticated !== (access === 'authenticated')) fail(404, 'Report not found');
      if (r.state === 'DELETED') return { unchanged: true };
      if (!['COMMITTED', 'DELETING'].includes(r.state)) fail(409, 'Report is not committed');
      r.state = 'DELETING'; // gate closes, owner listing stays until files are verified absent
    });
    const r = doc.revisions[id];
    if (r.state === 'DELETED') return true;
    try {
      if (r.legacyPrefix) await store.deletePublished(r.legacyPrefix);
      else if (r.selectedAttempt && !r.metadata.externalUrl) await store.deletePublished(r.attempts[r.selectedAttempt].prefix);
      await change(reportId, doc => {
        const current = doc.revisions[id];
        if (current.state === 'DELETED') return { unchanged: true };
        if (current.state !== 'DELETING') fail(409, 'Deletion state changed');
        current.state = 'DELETED'; if (doc.head === id) doc.head = null;
      });
      return true;
    } catch (_) { fail(502, 'Deletion could not be verified. Some files may already be deleted. Refresh and retry Delete.'); }
  }

  async function reconcileReport(reportId) {
    const lease = uuid();
    const needsAbort = r => (r.state === 'OPEN' && now() >= r.retainUntil) ||
      (r.state === 'PREPARING' && now() >= Math.min(r.leaseUntil, r.retainUntil));
    const cleanupDue = r => !r.adopted && !['OPEN', 'PREPARING', 'DELETING'].includes(r.state) &&
      (r.state !== 'ABORTED' || now() >= r.retainUntil) && !(r.cleanup?.nextRetryAt > now());
    const claimed = await change(reportId, doc => {
      if (!doc.owner) return { unchanged: true, value: false };
      if (doc.cleanupLease && doc.cleanupLease.until > now()) return { unchanged: true, value: false };
      if (!Object.values(doc.revisions).some(r => needsAbort(r) || cleanupDue(r))) return { unchanged: true, value: false };
      doc.cleanupLease = { id: lease, until: now() + LEASE };
      for (const r of Object.values(doc.revisions)) {
        if (needsAbort(r)) {
          r.state = 'ABORTED'; r.failure ||= 'expired_or_interrupted';
        }
      }
      return true;
    });
    const revisions = Object.values(claimed.doc.revisions);
    const pending = revisions.filter(r => ['OPEN', 'PREPARING'].includes(r.state));
    const due = revisions.filter(r => r.state === 'ABORTED' && now() >= r.retainUntil && !r.cleanup?.empty);
    log({ event: 'upload_lifecycle_observed', reportId, pending: pending.length, cleanupBacklog: due.length,
      oldestPendingSeconds: pending.length ? Math.floor((now() - Math.min(...pending.map(r => r.createdAt))) / 1000) : 0,
      oldestCleanupDueSeconds: due.length ? Math.floor((now() - Math.min(...due.map(r => r.retainUntil))) / 1000) : 0 });
    if (!claimed.result) return;
    for (const r of Object.values(claimed.doc.revisions)) {
      if (!cleanupDue(r)) continue;
      let success = false;
      try {
        // The state above is terminal: no attempt in this set can later commit.
        // The selected attempt is excluded even if a stale reconciler continues.
        if (!r.adopted && !r.legacyPrefix) await store.deleteStaging(r.id);
        for (const [attemptId, attempt] of Object.entries(r.attempts)) {
          if (attemptId !== r.selectedAttempt) await store.deletePublished(attempt.prefix);
        }
        success = true;
      } catch (_) { log({ event: 'upload_cleanup_failed', reportId, uploadId: r.id }); }
      await change(reportId, doc => {
        if (doc.cleanupLease?.id !== lease) return { unchanged: true };
        const current = doc.revisions[r.id];
        const failures = success ? 0 : (current.cleanup?.failures || 0) + 1;
        current.cleanup = { empty: success, failures, verifiedAt: success ? now() : current.cleanup?.verifiedAt || null,
          nextRetryAt: now() + (success ? 300000 : Math.min(900000, 30000 * 2 ** Math.min(failures, 5)) + Math.floor(Math.random() * 10000)) };
      });
    }
    await change(reportId, doc => {
      if (doc.cleanupLease?.id !== lease) return { unchanged: true };
      delete doc.cleanupLease;
    });
  }
  async function reconcile(cursor) {
    const page = await store.list(cursor);
    let failures = 0;
    for (const id of page.ids) {
      try { await reconcileReport(id); }
      catch (_) { failures++; log({ event: 'upload_reconciliation_failed', reportId: id }); }
    }
    log({ event: 'upload_reconciliation_page', checked: page.ids.length, failures, complete: !page.cursor });
    return { cursor: page.cursor || null, failures };
  }
  return { plan, resume, complete, locate, adopt, listReports, dashboard, edit, remove, reconcile, read };
}
module.exports = { createPublication, PublicationError, controlKey, locatorKey, RETENTION, LEASE };

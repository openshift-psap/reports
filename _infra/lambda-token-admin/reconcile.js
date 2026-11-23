'use strict';

// Dedicated scheduled Lambda, not an API action. Use reserved concurrency = 1.
// Checkpoint advances only after a page finishes; crashes safely replay a page.
const { publication } = require('./publication-s3');
exports.handler = async (_event, context) => {
  const service = publication();
  const key = 'report-reconciliation-v2/checkpoint.json';
  // Bootstrap before GET: without bucket-wide ListBucket, a missing key can
  // return 403. Never reinterpret AccessDenied as an absent checkpoint.
  try { await service.store.put(key, { cursor: null, lastFullScan: null }); }
  catch (error) {
    if (error.name !== 'PreconditionFailed' && error.$metadata?.httpStatusCode !== 412) throw error;
  }
  let checkpoint = await service.store.get(key);
  let pages = 0;
  do {
    const result = await service.reconcile(checkpoint?.value.cursor);
    const value = { cursor: result.cursor, updatedAt: Date.now(), lastFullScan: result.cursor ? checkpoint?.value.lastFullScan || null : Date.now() };
    await service.store.put(key, value, checkpoint?.etag);
    checkpoint = await service.store.get(key);
    pages++;
    if (!result.cursor) break;
  } while (pages < 20 && (!context || context.getRemainingTimeInMillis() > 30000));
  console.log(JSON.stringify({ event: 'reconciliation_heartbeat', pages, lastFullScan: checkpoint.value.lastFullScan,
    fullScanAgeSeconds: checkpoint.value.lastFullScan ? Math.floor((Date.now() - checkpoint.value.lastFullScan) / 1000) : 86401 }));
};

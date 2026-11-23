'use strict';

const crypto = require('crypto');
const sdk = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { createPublication } = require('./publication');
const missing = error => error.$metadata?.httpStatusCode === 404 || ['NoSuchKey', 'NotFound'].includes(error.name);

function createStore({ s3, bucket, stagingBucket }) {
  const send = (name, input) => s3.send(new sdk[`${name}Command`](input));
  async function digest(input) {
    const response = await send('GetObject', input);
    const hash = crypto.createHash('sha256');
    for await (const chunk of response.Body) hash.update(chunk);
    return hash.digest('hex');
  }
  async function deleteVersions(Bucket, Prefix) {
    // List/delete version IDs, not just keys. This also works for unversioned
    // buckets (the null version), and avoids hiding data behind delete markers.
    let KeyMarker, VersionIdMarker;
    do {
      const page = await send('ListObjectVersions', { Bucket, Prefix, KeyMarker, VersionIdMarker, MaxKeys: 1000 });
      const Objects = [...page.Versions || [], ...page.DeleteMarkers || []].map(({ Key, VersionId }) => ({ Key, VersionId }));
      if (Objects.some(object => !object.Key.startsWith(Prefix))) throw new Error('Out-of-prefix listing');
      for (let offset = 0; offset < Objects.length; offset += 1000) {
        const result = await send('DeleteObjects', { Bucket, Delete: { Objects: Objects.slice(offset, offset + 1000), Quiet: true } });
        if (result.Errors?.length) throw new Error('Partial object deletion');
      }
      if (page.IsTruncated && !page.NextKeyMarker) throw new Error('Incomplete version listing');
      KeyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
      VersionIdMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
    } while (KeyMarker);
    const remaining = await send('ListObjectVersions', { Bucket, Prefix, MaxKeys: 1 });
    if (remaining.Versions?.length || remaining.DeleteMarkers?.length || remaining.IsTruncated) throw new Error('Versions remain');
  }
  return {
    async get(Key) {
      try {
        const response = await send('GetObject', { Bucket: bucket, Key });
        if (!response.ETag) throw new Error('Missing concurrency token');
        const value = JSON.parse(await response.Body.transformToString());
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid stored document root');
        return { value, etag: response.ETag };
      } catch (error) { if (missing(error)) return null; throw error; }
    },
    async put(Key, value, etag) {
      await send('PutObject', { Bucket: bucket, Key, Body: JSON.stringify(value), ContentType: 'application/json', CacheControl: 'no-store',
        ...(etag ? { IfMatch: etag } : { IfNoneMatch: '*' }) });
    },
    async list(cursor) {
      const page = await send('ListObjectsV2', { Bucket: bucket, Prefix: 'report-control-v2/', MaxKeys: 10, ContinuationToken: cursor || undefined });
      if (page.IsTruncated && !page.NextContinuationToken) throw new Error('Incomplete control listing');
      return { ids: (page.Contents || []).map(item => item.Key.match(/^report-control-v2\/([a-f0-9-]+)\.json$/)?.[1]).filter(Boolean), cursor: page.NextContinuationToken };
    },
    async checkStaging() {
      // Refuse to issue plans if staging was provisioned without versioning.
      const versioning = await send('GetBucketVersioning', { Bucket: stagingBucket });
      if (versioning.Status !== 'Enabled' || stagingBucket === bucket) throw new Error('Private versioned staging bucket required');
    },
    async sign(id, file, ttl) {
      return getSignedUrl(s3, new sdk.PutObjectCommand({ Bucket: stagingBucket, Key: `uploads/${id}/${file.name}`, ContentType: file.contentType, CacheControl: 'no-cache' }), { expiresIn: ttl });
    },
    async inspect(id, name) {
      try {
        const result = await send('HeadObject', { Bucket: stagingBucket, Key: `uploads/${id}/${name}` });
        return { version: result.VersionId, size: result.ContentLength, contentType: result.ContentType };
      } catch (error) { if (missing(error)) return null; throw error; }
    },
    async copyVerified(id, file, prefix) {
      const source = { Bucket: stagingBucket, Key: `uploads/${id}/${file.name}`, VersionId: file.version };
      const expected = await digest(source);
      const result = await send('CopyObject', { Bucket: bucket, Key: prefix + file.name,
        CopySource: `${stagingBucket}/${source.Key.split('/').map(encodeURIComponent).join('/')}?versionId=${encodeURIComponent(file.version)}`,
        MetadataDirective: 'REPLACE', ContentType: file.contentType, CacheControl: 'no-cache' });
      if (!result.CopyObjectResult?.ETag) throw new Error('Unconfirmed object copy');
      const destination = { Bucket: bucket, Key: prefix + file.name, ...(result.VersionId ? { VersionId: result.VersionId } : {}) };
      const head = await send('HeadObject', destination);
      if (head.ContentLength !== file.size || head.ContentType !== file.contentType || await digest(destination) !== expected) throw new Error('Copied content failed verification');
      return { sha256: expected, size: file.size, destinationVersion: result.VersionId || null };
    },
    deleteStaging: id => {
      if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid upload ID');
      return deleteVersions(stagingBucket, `uploads/${id}/`);
    },
    deletePublished: prefix => {
      if (!/^(report-objects-v2\/[a-f0-9-]{36}\/[a-f0-9-]{36}|(?:public|private)\/[^/]+\/.+)\/$/.test(prefix) || prefix.split('/').some(part => part === '.' || part === '..')) throw new Error('Invalid bundle prefix');
      return deleteVersions(bucket, prefix);
    },
  };
}

let service;
function configured() { return Boolean(process.env.REPORT_STAGING_BUCKET); }
function publication() {
  if (!configured()) throw new Error('Publication is not configured');
  if (!service) {
    const s3 = new sdk.S3Client({ region: process.env.S3_REGION || 'us-east-1' });
    const store = createStore({ s3, bucket: process.env.S3_BUCKET || 'psap-reports', stagingBucket: process.env.REPORT_STAGING_BUCKET });
    service = { store, ...createPublication({ store, domain: process.env.CLOUDFRONT_DOMAIN }) };
  }
  return service;
}
module.exports = { createStore, publication, configured };

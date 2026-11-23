'use strict';
const { createPublication } = require('../../_infra/lambda-token-admin/publication');

function fixture() {
  let time = 1000000000000, sequence = 0;
  const documents = new Map(), staging = new Map(), published = new Map(), logs = [];
  const hooks = {};
  const uuid = () => `00000000-0000-0000-0000-${String(++sequence).padStart(12, '0')}`;
  const store = {
    async get(key) { await hooks.get?.(key); return documents.has(key) ? structuredClone(documents.get(key)) : null; },
    async put(key, value, etag) {
      await hooks.beforePut?.(key, value);
      if (documents.get(key)?.etag !== etag) throw Object.assign(new Error('conflict'), { name: 'PreconditionFailed' });
      documents.set(key, { value: structuredClone(value), etag: String(++sequence) });
      await hooks.afterPut?.(key, value);
    },
    async list() { return { ids: [...documents.keys()].filter(key => key.startsWith('report-control-v2/')).map(key => key.split('/')[1].replace('.json', '')) }; },
    async checkStaging() {},
    async sign(id, file) { return `https://private-staging.example/${id}/${file.name}?secret=do-not-log`; },
    async inspect(id, name) { await hooks.inspect?.(id, name); const versions = staging.get(`${id}/${name}`); return versions?.length ? { version: versions.at(-1).version, size: versions.at(-1).data.length, contentType: versions.at(-1).type } : null; },
    async copyVerified(id, file, prefix) {
      await hooks.copy?.(id, file, prefix);
      const version = staging.get(`${id}/${file.name}`).find(item => item.version === file.version);
      published.set(prefix + file.name, version.data);
      await hooks.afterCopy?.(id, file, prefix);
      return { sha256: 'verified-digest', size: file.size, destinationVersion: null };
    },
    async deleteStaging(id) { await hooks.deleteStaging?.(id); for (const key of staging.keys()) if (key.startsWith(id + '/')) staging.delete(key); },
    async deletePublished(prefix) { await hooks.deletePublished?.(prefix); for (const key of published.keys()) if (key.startsWith(prefix)) published.delete(key); },
  };
  const service = createPublication({ store, domain: 'reports.example', now: () => time, uuid, sleep: async () => {}, log: entry => logs.push(entry) });
  const submission = { title: 'Report', category: 'ci', access: 'public', status: 'final', description: '', tags: [], entryFile: 'site/index.html', pathMode: 'preserve',
    files: [{ name: 'site/index.html', size: 5, contentType: 'text/html' }, { name: 'site/assets/app.js', size: 5, contentType: 'text/javascript' }] };
  function put(id, file, data = 'bytes') {
    const key = `${id}/${file.name}`;
    const versions = staging.get(key) || [];
    versions.push({ version: uuid(), data, type: file.contentType }); staging.set(key, versions);
  }
  return { service, store, submission, documents, staging, published, hooks, logs, uuid, put,
    advance: ms => { time += ms; }, now: () => time,
    fill: id => submission.files.forEach(file => put(id, file)),
    plan: overrides => service.plan({ ...submission, ...overrides }, 'owner'),
  };
}
module.exports = { fixture };

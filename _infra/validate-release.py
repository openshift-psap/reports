#!/usr/bin/env python3
"""Destructive synthetic checks restricted to the designated isolated target."""
import argparse
import concurrent.futures
import hashlib
import json
import os
import re
from pathlib import Path
import tempfile
import time
import urllib.parse
import urllib.request

from release import Release, ReleaseError, WORKER_WAIT_SECONDS

CLEANUP_SECONDS = 1800
CLEANUP_ATTEMPTS = 20


def failure(r, stage, error):
    reason = str(error) if isinstance(error, ReleaseError) else 'Unexpected error; raw diagnostics redacted'
    r.evidence.setdefault('failures', []).append({'stage': stage, 'reason': reason})
    print(stage + ': ' + reason, flush=True)


class Validation:
    def __init__(self, release):
        self.r = release
        c = release.config
        if release.target != 'validation' or c['bucket'] != 'psap-reports-v2-validation-194365112018-us-east-1' or c['distribution'] != 'ENFXKXLUGP5HS':
            raise ReleaseError('Synthetic writes are allowed only in the isolated validation target')
        self.plans = []
        self.roots = set()

    def api(self, path, method='GET', body=None):
        status, raw, _ = self.r.request('/_admin-api' + path, method, body)
        return status, json.loads(raw)

    def plan(self, access='public', size=32, parent=None):
        body = {'title': 'Automated isolated release validation', 'category': 'ci', 'access': access,
                'status': 'final', 'pathMode': 'preserve', 'entryFile': 'site/index.html',
                'files': [{'name': 'site/index.html', 'size': 5, 'contentType': 'text/html'},
                          {'name': 'site/asset.js', 'size': size, 'contentType': 'text/javascript'}]}
        if parent:
            body['parentId'] = parent
        status, plan = self.api('/reports', 'POST', body)
        if status != 201:
            raise ReleaseError('Synthetic upload plan failed')
        plan.update(access=access, root=parent or plan['id'], size=size)
        self.plans.append(plan)
        self.roots.add(plan['root'])
        return plan

    def put(self, plan, name, content=None):
        url = next(f['url'] for f in plan['uploads'] if f['name'] == name)
        if content is None:
            content = b'bytes' if name.endswith('.html') else b'x' * plan['size']
        req = urllib.request.Request(url, data=content, method='PUT', headers={
            'Content-Type': 'text/html' if name.endswith('.html') else 'text/javascript', 'Cache-Control': 'no-cache'})
        with urllib.request.urlopen(req, timeout=120) as response:
            if response.status != 200:
                raise ReleaseError('Synthetic PUT failed')

    def complete(self, plan):
        start = time.monotonic()
        status, data = self.api('/reports/' + plan['id'] + '/complete', 'POST', {})
        seconds = time.monotonic() - start
        if seconds >= 28:
            raise ReleaseError('Completion exceeds API Gateway/CloudFront budget; review asynchronous publication')
        if status == 201:
            plan['path'] = urllib.parse.urlsplit(data['report']['path']).path
        return status, seconds

    def control(self, root):
        path = self.r.work / ('control-' + root + '.json')
        metadata = self.r.aws('s3api', 'get-object', '--bucket', self.r.config['bucket'],
                             '--key', 'report-control-v2/' + root + '.json', str(path))
        return json.loads(path.read_text()), metadata['ETag'], path

    def worker(self, deadline=None):
        if deadline is not None and deadline - time.monotonic() < WORKER_WAIT_SECONDS:
            raise ReleaseError('Cleanup time budget exhausted; reconciliation must remain enabled')
        result = self.r.aws('lambda', 'invoke', '--function-name', self.r.outputs['CleanupFunction'], str(self.r.work / 'validation-worker.json'))
        if result.get('FunctionError'):
            raise ReleaseError('Synthetic cleanup failed')

    def expire(self, root):
        doc, etag, path = self.control(root)
        if doc['owner'] != 'publication-release-verifier' or root not in self.roots:
            raise ReleaseError('Synthetic fixture ownership mismatch')
        for revision in doc['revisions'].values():
            if revision['metadata']['title'] != 'Automated isolated release validation':
                raise ReleaseError('Unexpected fixture metadata')
            if revision['state'] in ('OPEN', 'ABORTED'):
                revision['retainUntil'] = int(time.time()*1000) - 1
            if revision.get('cleanup'):
                revision['cleanup']['nextRetryAt'] = 0
        path.write_text(json.dumps(doc))
        self.r.aws('s3api', 'put-object', '--bucket', self.r.config['bucket'], '--key', 'report-control-v2/' + root + '.json',
                   '--body', str(path), '--if-match', etag, '--content-type', 'application/json')

    def is_empty(self, plan):
        for bucket, prefix in [(self.r.outputs['StagingBucket'], 'uploads/' + plan['id'] + '/'),
                               (self.r.config['bucket'], 'report-objects-v2/' + plan['id'] + '/')]:
            result = self.r.aws('s3api', 'list-object-versions', '--bucket', bucket, '--prefix', prefix)
            if result.get('Versions') or result.get('DeleteMarkers'):
                return False
        return True

    def reconcile_until_empty(self, plans):
        deadline = time.monotonic() + CLEANUP_SECONDS
        for _ in range(CLEANUP_ATTEMPTS):
            self.worker(deadline)
            if all(self.is_empty(plan) for plan in plans):
                return
            time.sleep(2)
        raise ReleaseError('Synthetic fixture versions remain after bounded reconciliation')

    def run(self):
        missing = self.plan()
        self.put(missing, 'site/index.html')
        status, detail = self.api('/uploads?id=' + missing['id'])
        if status != 200 or detail['uploads'][0]['missing'] != ['site/asset.js'] or self.complete(missing)[0] != 400:
            raise ReleaseError('Incomplete upload validation failed')
        if self.r.request('/public/v2/' + missing['id'] + '/' + missing['id'] + '/site/index.html')[0] != 404:
            raise ReleaseError('Incomplete upload became visible')
        self.expire(missing['root']); self.reconcile_until_empty([missing])
        self.put(missing, 'site/index.html')  # still-valid URL after prior verified cleanup
        self.expire(missing['root']); self.reconcile_until_empty([missing])
        self.r.record('isolated-late-write', incompleteDenied=True, expiredAndLateVersionsRemoved=True)

        for access in ('public', 'authenticated'):
            plan = self.plan(access)
            self.put(plan, 'site/index.html'); self.put(plan, 'site/asset.js')
            if self.complete(plan)[0] != 201:
                raise ReleaseError('Synthetic publication failed')
            doc, _, _ = self.control(plan['root'])
            revision = doc['revisions'][plan['id']]
            verified = revision['attempts'][revision['selectedAttempt']]['verified']
            if not any(f['sha256'] == hashlib.sha256(b'bytes').hexdigest() for f in verified):
                raise ReleaseError('Persisted SHA-256 evidence mismatch')
            # A reused staging URL must not modify the pinned published copy.
            self.put(plan, 'site/index.html', b'other')
            caches, gate_times = [], []
            for _ in range(5):
                start = time.monotonic()
                status, data, headers = self.r.request(plan['path'], authenticated=access == 'authenticated')
                seconds = time.monotonic() - start
                gate_times.append(round(seconds, 3))
                if status != 200 or data != b'bytes' or seconds >= 5:
                    raise ReleaseError('Viewer gate correctness/latency check failed')
                caches.append(headers.get('X-Cache', ''))
            if not any(c in ('Hit from cloudfront', 'RefreshHit from cloudfront') for c in caches):
                raise ReleaseError('No cached response observed')
            if 'Miss from cloudfront' not in caches:
                raise ReleaseError('No fresh cache miss observed')
            if access == 'authenticated':
                status, data, _ = self.r.request(plan['path'], authenticated=False)
                if status != 200 or b'/_auth/github?state=' not in data:
                    raise ReleaseError('Anonymous private gate failed')
            # Two replacement revisions race on the same conditional head.
            a, b = self.plan(access, parent=plan['id']), self.plan(access, parent=plan['id'])
            for replacement in (a, b):
                self.put(replacement, 'site/index.html'); self.put(replacement, 'site/asset.js')
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                statuses = [s for s, _ in pool.map(self.complete, (a, b))]
            if sorted(statuses) != [201, 409]:
                raise ReleaseError('Conditional replacement conflict check failed')
            status, _ = self.api('/reports?' + urllib.parse.urlencode({'id': plan['id'], 'access': access}), 'DELETE')
            if status != 200 or self.r.request(plan['path'])[0] != 404:
                raise ReleaseError('Deleted cached viewer path remained open')
            self.r.record('isolated-publication', access=access, cacheStates=sorted(set(caches)),
                          gateSeconds=gate_times, gateBudgetSeconds=5, replacementStatuses=statuses,
                          reusedPutCannotChangePublishedCopy=True)

        for size in (1024*1024, 10*1024*1024, 99*1024*1024):
            plan = self.plan(size=size)
            self.put(plan, 'site/index.html'); self.put(plan, 'site/asset.js')
            status, seconds = self.complete(plan)
            if status != 201:
                raise ReleaseError('Representative bundle completion failed')
            self.r.record('isolated-latency', bytes=size, completionSeconds=round(seconds, 3), budgetSeconds=28)

    def cleanup(self):
        # Only IDs recorded by this run are eligible; never scan/delete other reports.
        deadline = time.monotonic() + CLEANUP_SECONDS
        settle_deadline = min(deadline, time.monotonic() + 180)
        for _ in range(CLEANUP_ATTEMPTS):
            for root in self.roots:
                while True:
                    doc, _, _ = self.control(root)
                    if doc['owner'] != 'publication-release-verifier':
                        raise ReleaseError('Fixture ownership changed')
                    preparing = [v for v in doc['revisions'].values() if v['state'] == 'PREPARING']
                    if not any(v['leaseUntil'] > time.time()*1000 for v in preparing):
                        break
                    if time.monotonic() >= settle_deadline:
                        raise ReleaseError('In-flight completion did not settle; reconciliation must remain enabled')
                    time.sleep(5)
                for revision in doc['revisions'].values():
                    if revision['state'] in ('COMMITTED', 'DELETING'):
                        access = 'authenticated' if revision['metadata']['authenticated'] else 'public'
                        status, _ = self.api('/reports?' + urllib.parse.urlencode({'id': revision['id'], 'access': access}), 'DELETE')
                        if status != 200:
                            raise ReleaseError('Fixture deletion failed; retain IDs for recovery')
                self.expire(root)
            self.worker(deadline)
            # Empty prefixes alone do not prove an in-flight publication has stopped.
            terminal = True
            for root in self.roots:
                doc, _, _ = self.control(root)
                if doc['owner'] != 'publication-release-verifier':
                    raise ReleaseError('Fixture ownership changed')
                terminal = terminal and all(v['state'] in ('ABORTED', 'DELETED') for v in doc['revisions'].values())
            if terminal and all(self.is_empty(plan) for plan in self.plans):
                self.r.record('isolated-cleanup', reports=len(self.plans), remainingVersions=0)
                return
            time.sleep(2)
        raise ReleaseError('Synthetic cleanup did not finish within reconciliation bound')


def finalize(r, tests):
    failed = False
    try:
        r.set_mode('paused')
    except Exception as error:
        failed = True
        failure(r, 'isolated-pause', error)
    cleaned = False
    try:
        tests.cleanup()
        cleaned = True
    except Exception as error:
        failed = True
        failure(r, 'isolated-cleanup', error)
    try:
        # Leave retries running when a completion or physical deletion is unresolved.
        r.infrastructure(schedule=not cleaned or failed, notifications=False)
    except Exception as error:
        failed = True
        failure(r, 'isolated-schedule', error)
    return failed


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--commit', required=True)
    parser.add_argument('--evidence', type=Path, required=True)
    args = parser.parse_args()
    if not re.fullmatch('[a-f0-9]{40}', args.commit):
        parser.error('commit must be a full Git SHA')
    os.umask(0o077)
    with tempfile.TemporaryDirectory(prefix='psap-validation-') as work:
        r = Release('validation', work, args.commit)
        tests = Validation(r)
        failed = False
        try:
            r.deploy('v2')
            tests.run()
        except Exception as error:
            failed = True
            failure(r, 'isolated-validation', error)
        finally:
            if hasattr(r, 'outputs'):
                failed = finalize(r, tests) or failed
            r.evidence.update(result='failed' if failed else 'passed', fixtureIds=[p['id'] for p in tests.plans])
            args.evidence.write_text(json.dumps(r.evidence, indent=2))
        if failed:
            raise SystemExit(1)


if __name__ == '__main__':
    main()

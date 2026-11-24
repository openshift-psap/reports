#!/usr/bin/env python3
"""Release existing Report Hub installations. AWS output is never logged raw."""
import argparse
import base64
import datetime
import hashlib
import hmac
import io
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]


class ReleaseError(Exception):
    pass


def upload_mode(current, requested):
    if requested not in ('preserve', 'paused', 'v2'):
        raise ReleaseError('Invalid requested upload mode')
    mode = current or 'paused'
    if mode not in ('paused', 'v2'):
        raise ReleaseError('Unknown deployed upload mode')
    return mode if requested == 'preserve' else requested


def associate_gate(config, arn):
    behaviors = [config['DefaultCacheBehavior'], *config.get('CacheBehaviors', {}).get('Items', [])]
    for behavior in behaviors:
        gates = [a for a in behavior.get('LambdaFunctionAssociations', {}).get('Items', [])
                 if a['EventType'] == 'viewer-request']
        if len(gates) != 1 or behavior.get('FunctionAssociations', {}).get('Quantity', 0):
            raise ReleaseError('Review missing or competing viewer-request associations')
        gates[0]['LambdaFunctionARN'] = arn
    return len(behaviors)


class Release:
    def __init__(self, target, work, commit):
        self.target = target
        self.config = json.loads((ROOT / '_infra/deployment-targets.json').read_text())[target]
        self.work = Path(work)
        self.commit = commit
        self.evidence = {'commit': commit, 'target': target, 'stages': []}
        self.secret = None

    def aws(self, *args):
        result = subprocess.run(['aws', *args, '--region', self.config['region'], '--output', 'json'],
                                capture_output=True, text=True)
        if result.returncode:
            # stderr may contain request parameters, including credentials.
            raise ReleaseError(f'AWS {args[0]} {args[1]} failed; inspect AWS service state')
        if args[:2] == ('cloudformation', 'deploy'):
            return {}
        return json.loads(result.stdout) if result.stdout.strip() else {}

    def file(self, name, value):
        path = self.work / name
        path.write_text(json.dumps(value))
        path.chmod(0o600)
        return 'file://' + str(path)

    def record(self, stage, **details):
        self.evidence['stages'].append({'stage': stage, **details})
        print(json.dumps({'stage': stage, **details}), flush=True)

    def preflight(self):
        c = self.config
        if self.aws('sts', 'get-caller-identity')['Account'] != c['account']:
            raise ReleaseError('Wrong AWS account')
        self.api = self.aws('lambda', 'get-function-configuration', '--function-name', c['api_function'])
        self.stack = self.aws('cloudformation', 'describe-stacks', '--stack-name', c['stack'])['Stacks'][0]
        if self.stack['StackStatus'] not in ('CREATE_COMPLETE', 'UPDATE_COMPLETE'):
            raise ReleaseError('Publication stack is not ready for a release')
        secret = self.aws('secretsmanager', 'get-secret-value', '--secret-id', c['secret_id'])
        self.secret = json.loads(secret['SecretString'])
        required = ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'COOKIE_SECRET']
        if not all(isinstance(self.secret.get(k), str) and self.secret[k] for k in required):
            raise ReleaseError('Deployment secret lacks required auth fields')
        if bool(self.secret.get('GOOGLE_CLIENT_ID')) != bool(self.secret.get('GOOGLE_CLIENT_SECRET')):
            raise ReleaseError('Incomplete Google authentication configuration')
        env = self.api.get('Environment', {}).get('Variables', {})
        if self.secret['COOKIE_SECRET'] != env.get('COOKIE_SECRET'):
            raise ReleaseError('Cookie secret differs from deployed API; rotation is a separate operation')
        distribution = self.aws('cloudfront', 'get-distribution-config', '--id', c['distribution'])['DistributionConfig']
        behaviors = [distribution['DefaultCacheBehavior'], *distribution.get('CacheBehaviors', {}).get('Items', [])]
        versions = {a['LambdaFunctionARN'] for b in behaviors for a in b.get('LambdaFunctionAssociations', {}).get('Items', []) if a['EventType'] == 'viewer-request'}
        if len(versions) != 1:
            raise ReleaseError('Mixed deployed auth versions require review')
        deployed = self.aws('lambda', 'get-function', '--function-name', versions.pop())
        with urllib.request.urlopen(deployed['Code']['Location'], timeout=30) as response:
            with zipfile.ZipFile(io.BytesIO(response.read())) as archive:
                source = archive.read('index.js').decode()
        for field, key in {'clientId': 'GITHUB_CLIENT_ID', 'clientSecret': 'GITHUB_CLIENT_SECRET',
                           'cookieSecret': 'COOKIE_SECRET', 'googleClientId': 'GOOGLE_CLIENT_ID',
                           'googleClientSecret': 'GOOGLE_CLIENT_SECRET'}.items():
            match = re.search(r'^\s*' + field + r':\s*("(?:[^"\\]|\\.)*"),?\s*$', source, re.MULTILINE)
            if not match or json.loads(match.group(1)) != self.secret.get(key, ''):
                raise ReleaseError('Secret differs from deployed edge authentication; review provisioning')
        if env.get('S3_BUCKET') != c['bucket']:
            raise ReleaseError('API bucket does not match release target')
        self.old_mode = env.get('REPORT_UPLOAD_MODE')
        self.parameters = {p['ParameterKey']: p['ParameterValue'] for p in self.stack['Parameters']}
        if self.parameters['ReportBucket'] != c['bucket']:
            raise ReleaseError('Stack bucket does not match release target')
        self.record('preflight', previousMode=self.old_mode or 'legacy')

    def package(self):
        artifacts = {}
        for name in ('lambda-token-admin', 'lambda-auth'):
            source = ROOT / '_infra' / name
            run = subprocess.run(['npm', 'ci', '--omit=dev', '--ignore-scripts'], cwd=source,
                                 capture_output=True, text=True)
            if run.returncode:
                raise ReleaseError('Locked Lambda dependency installation failed')
            path = self.work / (name + '.zip')
            with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as archive:
                for item in sorted(source.rglob('*')):
                    if not item.is_file() or not (item.suffix == '.js' and item.parent == source or 'node_modules' in item.parts):
                        continue
                    data = item.read_bytes()
                    if name == 'lambda-auth' and item.name == 'index.js' and item.parent == source:
                        spec = importlib.util.spec_from_file_location('renderer', ROOT / '_infra/render-auth-config.py')
                        renderer = importlib.util.module_from_spec(spec)
                        spec.loader.exec_module(renderer)
                        values = {**self.secret, 'S3_BUCKET': self.config['bucket'], 'S3_REGION': self.config['region'],
                                  'CANONICAL_DOMAIN': self.config['domain'] if self.target == 'production' else '__VALIDATION_NO_CUSTOM_ALIAS__'}
                        tokens = {"'" + token + "'": key for token, key in renderer.PLACEHOLDERS.items()}
                        text = data.decode()
                        if not all(token in text for token in tokens):
                            raise ReleaseError('Auth placeholders changed; review renderer')
                        data = re.sub('|'.join(map(re.escape, tokens)),
                                      lambda m: json.dumps(values.get(tokens[m.group()], '')), text).encode()
                    info = zipfile.ZipInfo(str(item.relative_to(source)))
                    info.compress_type = zipfile.ZIP_DEFLATED
                    archive.writestr(info, data)
            artifacts[name] = path
        self.api_zip = artifacts['lambda-token-admin']
        self.edge_zip = artifacts['lambda-auth']
        digest = hashlib.sha256(self.api_zip.read_bytes()).hexdigest()
        self.artifact_key = f'publication/{self.commit}/api-worker-{digest}.zip'
        self.aws('s3api', 'put-object', '--bucket', self.config['artifact_bucket'], '--key', self.artifact_key,
                 '--body', str(self.api_zip), '--server-side-encryption', 'AES256')
        # Only the non-secret API artifact is retained; rendered auth stays temporary.
        self.record('package', apiSha256=digest, apiArtifactKey=self.artifact_key)

    def infrastructure(self, *, schedule=None, notifications=None):
        c = self.config
        parameters = {**self.parameters, 'ArtifactBucket': c['artifact_bucket'], 'ArtifactKey': self.artifact_key,
                      'AlarmTopicArn': c['alarm_topic']}
        if schedule is not None:
            parameters['CleanupEnabled'] = str(schedule).lower()
        if notifications is not None:
            parameters['CleanupNotificationsEnabled'] = str(notifications).lower()
        template = json.loads((ROOT / '_infra/publication-stack.json').read_text())
        for resource in template['Resources'].values():
            props = resource.get('Properties', {})
            if resource['Type'] == 'AWS::CloudWatch::Alarm':
                props['Namespace'] = c['metric_namespace']
            if resource['Type'] == 'AWS::Logs::MetricFilter':
                for metric in props['MetricTransformations']:
                    metric['MetricNamespace'] = c['metric_namespace']
        self.file('publication.json', template)
        parameters = {k: v for k, v in parameters.items() if k in template['Parameters']}
        # deploy handles an empty change set, unlike update-stack.
        self.aws('cloudformation', 'deploy', '--stack-name', c['stack'], '--template-file', str(self.work / 'publication.json'),
                 '--parameter-overrides', *[f'{k}={v}' for k, v in parameters.items()],
                 '--capabilities', 'CAPABILITY_IAM', '--no-fail-on-empty-changeset')
        self.parameters = parameters
        stack = self.aws('cloudformation', 'describe-stacks', '--stack-name', c['stack'])['Stacks'][0]
        self.outputs = {o['OutputKey']: o['OutputValue'] for o in stack['Outputs']}
        self.record('infrastructure', schedule=parameters['CleanupEnabled'], notifications=parameters['CleanupNotificationsEnabled'])

    def gate(self):
        c = self.config
        current = self.aws('cloudfront', 'get-distribution-config', '--id', c['distribution'])
        config = current['DistributionConfig']
        # Check before changing the function, and preserve include-body and all origins.
        associate_gate(json.loads(json.dumps(config)), 'preflight')
        self.aws('lambda', 'update-function-configuration', '--function-name', c['edge_function'], '--runtime', 'nodejs22.x')
        self.aws('lambda', 'wait', 'function-updated-v2', '--function-name', c['edge_function'])
        result = self.aws('lambda', 'update-function-code', '--function-name', c['edge_function'], '--zip-file', 'fileb://' + str(self.edge_zip))
        self.aws('lambda', 'wait', 'function-updated-v2', '--function-name', c['edge_function'])
        version = self.aws('lambda', 'publish-version', '--function-name', c['edge_function'], '--code-sha256', result['CodeSha256'], '--description', 'Report Hub ' + self.commit)
        count = associate_gate(config, version['FunctionArn'])
        self.aws('cloudfront', 'update-distribution', '--id', c['distribution'], '--if-match', current['ETag'],
                 '--distribution-config', self.file('cloudfront.json', config))
        self.aws('cloudfront', 'wait', 'distribution-deployed', '--id', c['distribution'])
        self.record('gate', version=version['FunctionArn'], behaviors=count)

    def api_deploy(self):
        c = self.config
        current = self.aws('lambda', 'get-function-configuration', '--function-name', c['api_function'])
        if current['Environment']['Variables'] != self.api['Environment']['Variables']:
            raise ReleaseError('API environment changed during release; preserve concurrent operator changes')
        env = dict(self.api['Environment']['Variables'])
        # Preserve an existing mode throughout routine releases. First deployment
        # starts paused; an explicit override is applied only after readiness.
        env.update(REPORT_STAGING_BUCKET=self.outputs['StagingBucket'], REPORT_UPLOAD_MODE=upload_mode(self.old_mode, 'preserve'))
        self.aws('lambda', 'update-function-configuration', '--function-name', c['api_function'], '--runtime', 'nodejs22.x',
                 '--memory-size', '512', '--timeout', '120', '--revision-id', current['RevisionId'], '--environment', self.file('api-env.json', {'Variables': env}))
        self.aws('lambda', 'wait', 'function-updated-v2', '--function-name', c['api_function'])
        self.aws('lambda', 'update-function-code', '--function-name', c['api_function'], '--zip-file', 'fileb://' + str(self.api_zip))
        self.aws('lambda', 'wait', 'function-updated-v2', '--function-name', c['api_function'])
        actual = self.aws('lambda', 'get-function-configuration', '--function-name', c['api_function'])
        expected = base64.b64encode(hashlib.sha256(self.api_zip.read_bytes()).digest()).decode()
        if actual['CodeSha256'] != expected:
            raise ReleaseError('API artifact verification failed')
        resources = self.aws('apigateway', 'get-resources', '--rest-api-id', c['api_id'])['items']
        paths = {r['path']: r for r in resources}
        if '/_admin-api/uploads' not in paths:
            paths['/_admin-api/uploads'] = self.aws('apigateway', 'create-resource', '--rest-api-id', c['api_id'],
                '--parent-id', paths['/_admin-api']['id'], '--path-part', 'uploads')
        for path, methods in {'/_admin-api/session': ['GET'], '/_admin-api/uploads': ['GET'],
                              '/_admin-api/reports': ['GET', 'POST', 'PATCH', 'DELETE'],
                              '/_admin-api/reports/{id}/complete': ['POST']}.items():
            resource = paths[path]
            for method in methods:
                if method not in resource.get('resourceMethods', {}):
                    self.aws('apigateway', 'put-method', '--rest-api-id', c['api_id'], '--resource-id', resource['id'],
                             '--http-method', method, '--authorization-type', 'NONE', '--no-api-key-required')
                self.aws('apigateway', 'put-integration', '--rest-api-id', c['api_id'], '--resource-id', resource['id'],
                         '--http-method', method, '--type', 'AWS_PROXY', '--integration-http-method', 'POST',
                         '--uri', f"arn:aws:apigateway:{c['region']}:lambda:path/2015-03-31/functions/arn:aws:lambda:{c['region']}:{c['account']}:function:{c['api_function']}/invocations")
        deployed = self.aws('apigateway', 'create-deployment', '--rest-api-id', c['api_id'], '--stage-name', c['stage'], '--description', self.commit)
        if not self.old_mode:
            # Retire legacy URLs before first V2 enablement; retain late-write sweeps.
            time.sleep(17 * 60)
        self.record('api', deployment=deployed['id'], mode=env['REPORT_UPLOAD_MODE'])

    def cookie(self):
        value = f'authenticated:github:{int(time.time()*1000)}:publication-release-verifier'
        sig = base64.urlsafe_b64encode(hmac.new(self.secret['COOKIE_SECRET'].encode(), value.encode(), hashlib.sha256).digest()).decode().rstrip('=')
        return 'psap_auth=' + value + '.' + sig

    def request(self, path, method='GET', body=None, authenticated=True):
        headers = {'Cookie': self.cookie()} if authenticated else {}
        if body is not None:
            headers['Content-Type'] = 'application/json'
            body = json.dumps(body).encode()
        req = urllib.request.Request('https://' + self.config['domain'] + path, data=body, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=28) as response:
                return response.status, response.read(), dict(response.headers)
        except urllib.error.HTTPError as error:
            return error.code, error.read(), dict(error.headers)

    def readiness(self):
        c = self.config
        started = time.time()
        response = self.aws('lambda', 'invoke', '--function-name', self.outputs['CleanupFunction'], str(self.work / 'worker.json'))
        if response.get('FunctionError'):
            raise ReleaseError('Cleanup invocation failed')
        self.aws('s3api', 'get-object', '--bucket', c['bucket'], '--key', 'report-reconciliation-v2/checkpoint.json', str(self.work / 'checkpoint.json'))
        checkpoint = json.loads((self.work / 'checkpoint.json').read_text())
        if time.time()*1000 - checkpoint.get('lastFullScan', 0) > 10*60*1000:
            raise ReleaseError('No recent complete cleanup scan')
        for attempt in range(20):
            status, body, _ = self.request('/_admin-api/uploads')
            if status == 200 and isinstance(json.loads(body).get('uploads'), list):
                break
            if attempt == 19:
                raise ReleaseError('Uploads route readiness failed')
            time.sleep(15)
        for path in ('/report-control-v2/probe.json', '/report-objects-v2/probe/index.html', '/%72eport-control-v2/probe.json'):
            if self.request(path)[0] not in (403, 404):
                raise ReleaseError('Physical storage gate failed')
        since = datetime.datetime.fromtimestamp(int(started // 60) * 60, datetime.timezone.utc).isoformat()
        for attempt in range(20):
            fresh = True
            for metric, statistic in [('ReconciliationHeartbeat', 'Sum'), ('FullScanAgeSeconds', 'Maximum')]:
                points = self.aws('cloudwatch', 'get-metric-statistics', '--namespace', c['metric_namespace'],
                                  '--metric-name', metric, '--start-time', since,
                                  '--end-time', datetime.datetime.now(datetime.timezone.utc).isoformat(),
                                  '--period', '60', '--statistics', statistic)['Datapoints']
                fresh = fresh and bool(points)
            if fresh:
                break
            if attempt == 19:
                raise ReleaseError('Fresh worker heartbeat/scan metrics unavailable')
            time.sleep(15)
        self.record('readiness', fullScan=True, freshWorkerMetrics=True, api=True, physicalPathsDenied=True)

    def alarms(self):
        resources = self.aws('cloudformation', 'describe-stack-resources', '--stack-name', self.config['stack'])['StackResources']
        names = [r['PhysicalResourceId'] for r in resources if r['ResourceType'] == 'AWS::CloudWatch::Alarm']
        if len(names) != 4:
            raise ReleaseError('Expected four cleanup alarms')
        for attempt in range(30):
            alarms = self.aws('cloudwatch', 'describe-alarms', '--alarm-names', *names)['MetricAlarms']
            enabled = self.parameters.get('CleanupEnabled') == self.parameters.get('CleanupNotificationsEnabled') == 'true'
            if len(alarms) == 4 and all(a['StateValue'] == 'OK' and a.get('AlarmActions') == [self.config['alarm_topic']]
                                       and a['ActionsEnabled'] == enabled for a in alarms):
                self.record('alarms', healthy=True, destinationsVerified=True)
                return
            if attempt == 29:
                raise ReleaseError('Cleanup alarms did not become ready')
            time.sleep(20)

    def set_mode(self, mode):
        c = self.config
        current = self.aws('lambda', 'get-function-configuration', '--function-name', c['api_function'])
        env = current['Environment']['Variables']
        if env.get('REPORT_UPLOAD_MODE') != mode:
            env['REPORT_UPLOAD_MODE'] = mode
            self.aws('lambda', 'update-function-configuration', '--function-name', c['api_function'], '--revision-id', current['RevisionId'],
                     '--environment', self.file('mode.json', {'Variables': env}))
            self.aws('lambda', 'wait', 'function-updated-v2', '--function-name', c['api_function'])
        self.record('upload-mode', mode=mode)

    def smoke(self):
        for path in ('/', '/admin/index.html', '/privacy.html'):
            if self.request(path)[0] != 200:
                raise ReleaseError('Frontend readiness failed')
        status, body, _ = self.request('/_admin-api/session')
        if status != 200 or json.loads(body).get('githubHandle') != 'publication-release-verifier':
            raise ReleaseError('API session readiness failed')
        if self.request('/_admin-api/uploads')[0] != 200:
            raise ReleaseError('API upload inspection readiness failed')
        self.record('frontend-smoke', site=True, api=True, mutatingRequests=False)

    def deploy(self, requested):
        self.preflight()
        desired = upload_mode(self.old_mode, requested)
        self.package()
        self.infrastructure()
        self.gate()
        self.api_deploy()
        self.readiness()
        if desired == 'v2':
            self.infrastructure(schedule=True)
            self.alarms()
            self.infrastructure(notifications=self.target == 'production')
            self.alarms()
        if requested == 'preserve':
            # A concurrent operator pause after API deployment must not be undone.
            current = self.aws('lambda', 'get-function-configuration', '--function-name', self.config['api_function'])
            actual = upload_mode(current['Environment']['Variables'].get('REPORT_UPLOAD_MODE'), 'preserve')
            self.record('upload-mode', mode=actual, preserved=True)
        else:
            self.set_mode(desired)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--target', choices=['production', 'validation'], required=True)
    parser.add_argument('--commit', required=True)
    parser.add_argument('--upload-mode', choices=['preserve', 'paused', 'v2'], default='preserve')
    parser.add_argument('--evidence', type=Path, required=True)
    parser.add_argument('--phase', choices=['deploy', 'smoke'], default='deploy')
    args = parser.parse_args()
    if not re.fullmatch('[a-f0-9]{40}', args.commit):
        parser.error('commit must be a full Git SHA')
    os.umask(0o077)
    with tempfile.TemporaryDirectory(prefix='psap-release-') as work:
        release = Release(args.target, work, args.commit)
        try:
            if args.phase == 'deploy':
                release.deploy(args.upload_mode)
            else:
                release.preflight()
                release.smoke()
            release.evidence['result'] = 'passed'
        except Exception as error:
            release.evidence['result'] = 'failed'
            reason = str(error) if isinstance(error, ReleaseError) else 'Unexpected release error; inspect completed stages and AWS service state'
            release.evidence['failure'] = reason
            # Never dump exception bodies, environment, auth source or AWS responses.
            print('Release failed; downstream deployment blocked. ' + reason, flush=True)
            raise SystemExit(1) from None
        finally:
            args.evidence.write_text(json.dumps(release.evidence, indent=2))


if __name__ == '__main__':
    main()

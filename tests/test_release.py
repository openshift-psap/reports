"""Safety boundaries for full-stack deployment; no AWS credentials or writes."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / '_infra'))
from release import Release, ReleaseError, associate_gate, upload_mode


class ReleaseTests(unittest.TestCase):
    def test_upload_mode_matrix_and_unknown_modes(self):
        for current in (None, 'paused', 'v2'):
            self.assertEqual(upload_mode(current, 'preserve'), current or 'paused')
            for explicit in ('paused', 'v2'):
                self.assertEqual(upload_mode(current, explicit), explicit)
        for current, requested in [('legacy', 'preserve'), ('v2', 'automatic')]:
            with self.assertRaises(ReleaseError):
                upload_mode(current, requested)

    def test_gate_updates_every_behavior_preserving_body_and_origins(self):
        behavior = {'TargetOriginId': 'original', 'LambdaFunctionAssociations': {'Quantity': 1, 'Items': [
            {'EventType': 'viewer-request', 'LambdaFunctionARN': 'old', 'IncludeBody': True}]}}
        config = {'DefaultCacheBehavior': copy.deepcopy(behavior),
                  'CacheBehaviors': {'Items': [copy.deepcopy(behavior), copy.deepcopy(behavior)]}}
        self.assertEqual(associate_gate(config, 'new'), 3)
        for b in [config['DefaultCacheBehavior'], *config['CacheBehaviors']['Items']]:
            self.assertEqual(b['TargetOriginId'], 'original')
            self.assertEqual(b['LambdaFunctionAssociations']['Items'][0],
                             {'EventType': 'viewer-request', 'LambdaFunctionARN': 'new', 'IncludeBody': True})

    def test_gate_refuses_missing_or_competing_associations(self):
        for b in ({}, {'FunctionAssociations': {'Quantity': 1}},
                  {'LambdaFunctionAssociations': {'Items': [{'EventType': 'viewer-request'}, {'EventType': 'viewer-request'}]}}):
            with self.assertRaises(ReleaseError):
                associate_gate({'DefaultCacheBehavior': b}, 'new')

    def test_aws_errors_do_not_expose_secret_bearing_stderr(self):
        r = Release('production', '/unused', 'a'*40)
        with patch('release.subprocess.run', return_value=subprocess.CompletedProcess([], 1, '', 'SECRET')):
            with self.assertRaises(ReleaseError) as error:
                r.aws('lambda', 'update-function-configuration', '--environment', 'SECRET')
        self.assertNotIn('SECRET', str(error.exception))

    def runner(self, fail=None, old_mode='v2'):
        r = Release('production', '/unused', 'a'*40)
        r.old_mode = old_mode
        r.aws = Mock(return_value={'Environment': {'Variables': {'REPORT_UPLOAD_MODE': old_mode or 'paused'}}})
        calls = []
        for name in ('preflight', 'package', 'infrastructure', 'gate', 'api_deploy', 'readiness', 'alarms', 'set_mode'):
            def method(*args, _name=name, **kwargs):
                calls.append((_name, args, kwargs))
                if _name == fail:
                    raise ReleaseError('injected failure')
            setattr(r, name, method)
        return r, calls

    def test_failed_gate_or_readiness_never_enables_issuance(self):
        for failed in ('gate', 'readiness', 'alarms'):
            r, calls = self.runner(failed, old_mode='paused')
            with self.assertRaises(ReleaseError):
                r.deploy('v2')
            names = [c[0] for c in calls]
            self.assertNotIn('set_mode', names)
            if failed == 'gate':
                self.assertNotIn('api_deploy', names)

    def test_initial_enablement_and_routine_preservation(self):
        for current, requested, expected in [(None, 'preserve', 'paused'), ('paused', 'preserve', 'paused'),
                                             ('v2', 'preserve', 'v2'), ('paused', 'v2', 'v2')]:
            r, calls = self.runner(old_mode=current)
            r.deploy(requested)
            if requested == 'preserve':
                self.assertNotIn('set_mode', [c[0] for c in calls])
                self.assertEqual(r.evidence['stages'][-1]['mode'], expected)
            else:
                self.assertEqual(calls[-1], ('set_mode', (expected,), {}))
            names = [c[0] for c in calls]
            self.assertLess(names.index('gate'), names.index('api_deploy'))
            if requested != 'preserve':
                self.assertLess(names.index('readiness'), names.index('set_mode'))
            if expected == 'v2':
                self.assertIn(('infrastructure', (), {'notifications': True}), calls)

    def test_routine_release_does_not_undo_a_concurrent_operator_pause(self):
        r, calls = self.runner(old_mode='v2')
        r.aws.return_value = {'Environment': {'Variables': {'REPORT_UPLOAD_MODE': 'paused'}}}
        r.deploy('preserve')
        self.assertNotIn('set_mode', [c[0] for c in calls])
        self.assertEqual(r.evidence['stages'][-1]['mode'], 'paused')

    def test_validation_writes_reject_production_target(self):
        spec = importlib.util.spec_from_file_location('validation', ROOT / '_infra/validate-release.py')
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        with self.assertRaises(ReleaseError):
            module.Validation(Release('production', '/unused', 'a'*40))

    def test_infrastructure_preserves_mode_flags_and_isolates_metrics(self):
        with tempfile.TemporaryDirectory() as work:
            r = Release('validation', work, 'a'*40)
            r.artifact_key = 'publication/test.zip'
            r.parameters = {'CleanupEnabled': 'false', 'CleanupNotificationsEnabled': 'false', 'ReportBucket': r.config['bucket']}
            r.aws = Mock(side_effect=[{}, {'Stacks': [{'Outputs': [{'OutputKey': 'StagingBucket', 'OutputValue': 'isolated'}]}]}])
            r.infrastructure()
            template = json.loads((Path(work) / 'publication.json').read_text())
            for resource in template['Resources'].values():
                if resource['Type'] == 'AWS::CloudWatch::Alarm':
                    self.assertEqual(resource['Properties']['Namespace'], 'PSAP/PublicationValidation')
                    self.assertIn('AlarmActions', resource['Properties'])
            command = r.aws.call_args_list[0].args
            self.assertIn('CleanupEnabled=false', command)
            self.assertIn('CleanupNotificationsEnabled=false', command)

    def test_rendered_auth_is_not_the_retained_s3_artifact(self):
        with tempfile.TemporaryDirectory() as checkout, tempfile.TemporaryDirectory() as work:
            root = Path(checkout)
            auth = root / '_infra/lambda-auth'; auth.mkdir(parents=True)
            api = root / '_infra/lambda-token-admin'; api.mkdir()
            (api / 'index.js').write_text('exports.handler = async () => {};')
            (api / 'reconcile.js').write_text('exports.handler = async () => {};')
            (auth / 'index.js').write_bytes((ROOT / '_infra/lambda-auth/index.js').read_bytes())
            (root / '_infra/render-auth-config.py').write_bytes((ROOT / '_infra/render-auth-config.py').read_bytes())
            r = Release('production', work, 'a'*40)
            r.secret = {'GITHUB_CLIENT_ID': 'client', 'GITHUB_CLIENT_SECRET': 'secret-marker',
                        'COOKIE_SECRET': 'cookie-marker', 'GOOGLE_CLIENT_ID': '', 'GOOGLE_CLIENT_SECRET': ''}
            r.aws = Mock(return_value={})
            with patch('release.ROOT', root), patch('release.subprocess.run', return_value=subprocess.CompletedProcess([], 0, '', '')):
                r.package()
            with zipfile.ZipFile(r.edge_zip) as z:
                self.assertIn(b'secret-marker', z.read('index.js'))
            with zipfile.ZipFile(r.api_zip) as z:
                self.assertNotIn(b'secret-marker', b''.join(z.read(name) for name in z.namelist()))
                self.assertIn('reconcile.js', z.namelist())
            self.assertEqual(r.aws.call_count, 1)
            self.assertIn(str(r.api_zip), r.aws.call_args.args)
            self.assertNotIn(str(r.edge_zip), r.aws.call_args.args)
            self.assertNotIn('secret-marker', json.dumps(r.evidence))

    def test_production_smoke_is_read_only(self):
        r = Release('production', '/unused', 'a'*40)
        r.request = Mock(side_effect=[(200, b'', {})] * 3 + [
            (200, b'{"githubHandle":"publication-release-verifier"}', {}), (200, b'', {})])
        r.smoke()
        for call in r.request.call_args_list:
            self.assertEqual(len(call.args), 1)
            self.assertFalse(call.kwargs)

    def test_generated_policies_fit_managed_policy_limits_without_dropping_permissions(self):
        spec = importlib.util.spec_from_file_location('policy', ROOT / '_infra/release-policy.py')
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        statements = [{'Effect': 'Allow', 'Action': ['s3:GetObject'], 'Resource': ['arn:aws:s3:::bucket/' + str(i) + 'x'*800]} for i in range(20)]
        docs = module.split_policy({'Version': '2012-10-17', 'Statement': statements})
        self.assertEqual([s for doc in docs for s in doc['Statement']], statements)
        self.assertTrue(all(len(json.dumps(doc, separators=(',', ':'))) <= 5800 for doc in docs))


if __name__ == '__main__':
    unittest.main()

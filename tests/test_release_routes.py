"""Deploy API routes against both production and minimal validation inventories."""
import base64
import hashlib
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / '_infra'))
from release import Release


class ReleaseRouteTests(unittest.TestCase):
    def test_missing_session_and_uploads_are_created_and_existing_routes_reused(self):
        for present in (set(), {'uploads'}, {'session'}, {'session', 'uploads'}):
            with self.subTest(present=present), tempfile.TemporaryDirectory() as work:
                r = Release('validation', work, 'a'*40)
                r.old_mode = 'paused'
                r.api = {'Environment': {'Variables': {'REPORT_UPLOAD_MODE': 'paused'}}}
                r.outputs = {'StagingBucket': 'staging'}
                r.api_zip = Path(work) / 'api.zip'; r.api_zip.write_bytes(b'package')
                resources = [
                    {'id': 'prefix', 'path': '/_admin-api'},
                    {'id': 'reports', 'path': '/_admin-api/reports', 'resourceMethods': {m: {} for m in ('GET', 'POST', 'PATCH', 'DELETE')}},
                    {'id': 'complete', 'path': '/_admin-api/reports/{id}/complete', 'resourceMethods': {'POST': {}}},
                    *[{'id': name, 'path': '/_admin-api/' + name, 'resourceMethods': {'GET': {}}} for name in sorted(present)],
                ]

                def aws(*args):
                    if args[:2] == ('lambda', 'get-function-configuration'):
                        return {**r.api, 'RevisionId': 'revision', 'CodeSha256': base64.b64encode(hashlib.sha256(b'package').digest()).decode()}
                    if args[:2] == ('apigateway', 'get-resources'):
                        return {'items': resources}
                    if args[:2] == ('apigateway', 'create-resource'):
                        self.assertEqual(args[args.index('--parent-id') + 1], 'prefix')
                        name = args[args.index('--path-part') + 1]
                        return {'id': name, 'path': '/_admin-api/' + name}
                    if args[:2] == ('apigateway', 'create-deployment'):
                        return {'id': 'deployment'}
                    return {}

                r.aws = Mock(side_effect=aws)
                r.api_deploy()
                commands = [call.args for call in r.aws.call_args_list]
                created = {args[args.index('--path-part') + 1] for args in commands if args[:2] == ('apigateway', 'create-resource')}
                self.assertEqual(created, {'session', 'uploads'} - present)
                for name in ('session', 'uploads'):
                    integrations = [args for args in commands if args[:2] == ('apigateway', 'put-integration') and args[args.index('--resource-id') + 1] == name]
                    self.assertEqual(len(integrations), 1)
                    self.assertEqual(integrations[0][integrations[0].index('--http-method') + 1], 'GET')
                    methods = [args for args in commands if args[:2] == ('apigateway', 'put-method') and args[args.index('--resource-id') + 1] == name]
                    self.assertEqual(len(methods), 0 if name in present else 1)
                self.assertEqual(commands[-1][:2], ('apigateway', 'create-deployment'))


if __name__ == '__main__':
    unittest.main()

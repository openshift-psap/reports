"""Regression proof for release recovery, long scans and late completions."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import time
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / '_infra'))
from release import Release, ReleaseError


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / '_infra' / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


validation = load('validation_review', 'validate-release.py')
policy = load('policy_review', 'release-policy.py')


class ReleaseReviewTests(unittest.TestCase):
    def fixture(self):
        r = Release('validation', '/unused', 'a'*40)
        r.outputs = {'CleanupFunction': 'worker', 'StagingBucket': 'staging'}
        r.aws = Mock()
        test = validation.Validation(r)
        test.roots = {'root'}
        test.plans = [{'id': 'root'}]
        return r, test

    def document(self, state):
        return ({'owner': 'publication-release-verifier', 'revisions': {'root': {
            'id': 'root', 'state': state, 'leaseUntil': time.time()*1000 + 120000,
            'metadata': {'authenticated': False}}}}, 'etag', Path('/unused'))

    def test_completed_rollback_can_retry_but_unsafe_states_cannot(self):
        for state in ('CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE',
                      'UPDATE_IN_PROGRESS', 'UPDATE_ROLLBACK_FAILED', 'ROLLBACK_COMPLETE'):
            r = Release('production', '/unused', 'a'*40)
            r.aws = Mock(side_effect=[{'Account': r.config['account']}, {}, {'Stacks': [{'StackStatus': state}]},
                                     RuntimeError('reached secret lookup')])
            if state in ('CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE'):
                with self.assertRaisesRegex(RuntimeError, 'reached secret lookup'):
                    r.preflight()
                self.assertEqual(r.aws.call_count, 4)
            else:
                with self.assertRaisesRegex(ReleaseError, 'stack is not ready'):
                    r.preflight()
                self.assertEqual(r.aws.call_count, 3)

    def test_shared_invocation_wait_exceeds_worker_timeout_and_is_bounded(self):
        r = Release('validation', '/unused', 'a'*40)
        with patch('release.subprocess.run', return_value=subprocess.CompletedProcess([], 0, '{}', '')) as run:
            r.aws('lambda', 'invoke', '--function-name', 'worker', '/unused/result.json')
        args = run.call_args.args[0]
        self.assertEqual(args[args.index('--cli-read-timeout') + 1], '960')
        self.assertEqual(run.call_args.kwargs['timeout'], 960)
        _, test = self.fixture()
        test.r.aws.return_value = {'FunctionError': 'Unhandled'}
        with self.assertRaisesRegex(ReleaseError, 'Synthetic cleanup failed'):
            test.worker()

    def test_no_invocation_starts_without_enough_remaining_time(self):
        r, test = self.fixture()
        with self.assertRaisesRegex(ReleaseError, 'time budget exhausted'):
            test.worker(time.monotonic() + 100)
        r.aws.assert_not_called()

    def test_paginated_cleanup_retries_until_tracked_prefixes_empty(self):
        _, test = self.fixture()
        test.worker = Mock()
        test.is_empty = Mock(side_effect=[False, False, True])
        with patch.object(validation.time, 'sleep'):
            test.reconcile_until_empty(test.plans)
        self.assertEqual(test.worker.call_count, 3)

    def test_nonempty_bound_and_storage_errors_are_not_hidden(self):
        _, test = self.fixture()
        test.worker = Mock()
        test.is_empty = Mock(return_value=False)
        with patch.object(validation.time, 'sleep'), self.assertRaisesRegex(ReleaseError, 'bounded reconciliation'):
            test.reconcile_until_empty(test.plans)
        self.assertEqual(test.worker.call_count, validation.CLEANUP_ATTEMPTS)
        test.worker.reset_mock()
        test.is_empty.side_effect = ReleaseError('listing denied')
        with self.assertRaisesRegex(ReleaseError, 'listing denied'):
            test.reconcile_until_empty(test.plans)
        self.assertEqual(test.worker.call_count, 1)

    def test_preparing_then_committed_is_deleted_before_success(self):
        _, test = self.fixture()
        test.control = Mock(side_effect=[self.document('PREPARING'), self.document('COMMITTED'), self.document('DELETED')])
        test.api = Mock(return_value=(200, {}))
        test.expire = Mock()
        test.worker = Mock()
        test.is_empty = Mock(return_value=True)
        with patch.object(validation.time, 'sleep') as sleep:
            test.cleanup()
        sleep.assert_called_once_with(5)
        self.assertEqual(test.api.call_args.args[1], 'DELETE')
        self.assertEqual(test.worker.call_count, 1)

    def test_expired_preparing_is_reconciled_then_aborted_retention_is_aged(self):
        _, test = self.fixture()
        expired = self.document('PREPARING')
        expired[0]['revisions']['root']['leaseUntil'] = 0
        test.control = Mock(side_effect=[expired, self.document('ABORTED'), self.document('ABORTED'), self.document('ABORTED')])
        test.api = Mock()
        test.expire = Mock()
        test.worker = Mock()
        test.is_empty = Mock(side_effect=[False, True])
        with patch.object(validation.time, 'sleep'):
            test.cleanup()
        self.assertEqual(test.expire.call_count, 2)
        self.assertEqual(test.worker.call_count, 2)
        test.api.assert_not_called()

    def test_active_completion_settling_is_bounded(self):
        _, test = self.fixture()
        test.control = Mock(return_value=self.document('PREPARING'))
        test.worker = Mock()
        with patch.object(validation.time, 'monotonic', side_effect=[0, 0, 181]), self.assertRaisesRegex(ReleaseError, 'did not settle'):
            test.cleanup()
        test.worker.assert_not_called()

    def test_finalizer_keeps_schedule_on_for_unresolved_cleanup(self):
        for cleanup_error in (None, ReleaseError('completion unresolved')):
            r, test = self.fixture()
            r.set_mode = Mock(); r.infrastructure = Mock()
            test.cleanup = Mock(side_effect=cleanup_error)
            failed = validation.finalize(r, test)
            self.assertEqual(failed, cleanup_error is not None)
            r.set_mode.assert_called_once_with('paused')
            r.infrastructure.assert_called_once_with(schedule=cleanup_error is not None, notifications=False)

    def test_diagnostics_retain_known_reasons_and_redact_unexpected_errors(self):
        r, _ = self.fixture()
        validation.failure(r, 'cleanup', ReleaseError('fixture versions remain'))
        validation.failure(r, 'http', RuntimeError('SECRET signed URL'))
        encoded = json.dumps(r.evidence)
        self.assertIn('fixture versions remain', encoded)
        self.assertNotIn('SECRET', encoded)

    def test_pause_failure_also_retains_reconciliation(self):
        r, test = self.fixture()
        r.set_mode = Mock(side_effect=ReleaseError('pause failed'))
        r.infrastructure = Mock()
        test.cleanup = Mock()
        self.assertTrue(validation.finalize(r, test))
        r.infrastructure.assert_called_once_with(schedule=True, notifications=False)

    def test_template_summary_grant_remains_stack_scoped(self):
        def release(target, work, commit):
            r = Release(target, work, commit)
            ids = {'Worker': 'worker', 'WorkerRole': 'worker-role', 'Staging': 'staging', 'Schedule': 'schedule'}
            resources = [{'LogicalResourceId': k, 'PhysicalResourceId': v, 'ResourceType': 'unused'} for k, v in ids.items()]
            r.aws = Mock(side_effect=[{'Account': r.config['account']}, {'Stacks': [{'StackId': 'arn:aws:cloudformation:us-east-1:194365112018:stack/' + target + '/id'}]}, {'StackResources': resources}])
            return r
        with patch.object(policy, 'Release', side_effect=release):
            document = policy.policy()
        grants = [s for s in document['Statement'] if 'cloudformation:GetTemplateSummary' in s['Action']]
        self.assertEqual(len(grants), 2)
        self.assertTrue(all('*' not in s['Resource'] and any(':stack/' in arn for arn in s['Resource']) for s in grants))


if __name__ == '__main__':
    unittest.main()

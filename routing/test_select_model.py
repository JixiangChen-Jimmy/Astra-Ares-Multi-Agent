"""Focused contract tests for the task-start routing advice."""

import importlib.util
import json
import math
from pathlib import Path
import subprocess
import tempfile
import unittest


SOURCE = Path(__file__).with_name('select_model.py')
SPEC = importlib.util.spec_from_file_location('select_model', SOURCE)
router = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(router)


def task(kind='simple_code'):
    return {
        'kind': kind,
        'description': 'Change one local utility with a known acceptance check.',
        'data_class': 'synthetic', 'failure_count': 0, 'uncertainty': 'low',
        'scope': 'local', 'effects_known': True,
    }


def response(choice='sol_adaptive', confidence=0.95, **extra):
    return {'status': 'ok', 'mode': 'mock', 'answers': {
        'model_choice': {'value': choice, 'confidence': confidence}},
        'usage': {'input_tokens': 24, 'output_tokens': 5},
        'cost': None, 'cost_source': 'unknown', 'request_attempts': 0,
        'live_attempted': False, **extra}


class RouterTests(unittest.TestCase):
    def run_with(self, item, service_response):
        seen = {}

        def runner(command, **kwargs):
            seen['command'] = command
            seen['request'] = json.loads(kwargs['input'])
            return subprocess.CompletedProcess(command, 0, json.dumps(service_response), '')

        return router.select(item, runner=runner), seen

    def test_core_is_fixed_high_without_jev(self):
        result = router.select(task('core_implementation'), runner=lambda *_args, **_kwargs: self.fail('called Jev'))
        self.assertEqual((result['model'], result['effort'], result['mode']),
                         ('gpt-6.1-sol', 'high', 'deterministic'))
        self.assertEqual(result['reason'], 'core_fixed_high')

    def test_missing_metadata_and_failure_fall_back(self):
        invalid = task()
        del invalid['description']
        self.assertEqual(router.select(invalid)['reason'], 'task_fields')
        failed = task()
        failed['failure_count'] = 1
        failed_result = router.select(failed)
        self.assertEqual(failed_result['reason'], 'prior_failure_requires_root')
        self.assertEqual((failed_result['role'], failed_result['ares_model_alias']),
                         ('simple_worker_adaptive', 'Sol-6.1-Jev'))
        unclear = task()
        unclear['scope'] = 'cross_module'
        self.assertEqual(router.select(unclear)['effort'], 'high')
        self.assertEqual(router.select(task(), offline=True)['mode'], 'offline')

    def test_sol_choice_and_full_pricing_reach_typesafe(self):
        result, seen = self.run_with(task(), response('sol_adaptive'))
        self.assertEqual((result['model'], result['effort'], result['role']),
                         ('gpt-6.1-sol', 'medium', 'simple_worker_adaptive'))
        self.assertEqual(result['ares_model_alias'], 'Sol-6.1-Jev')
        self.assertEqual(Path(seen['command'][1]), router.TRIAGE)
        state = seen['request']['state']
        self.assertEqual(state['task'], task())
        self.assertEqual(seen['request']['data_class'], 'synthetic')
        pricing = state['pricing']
        self.assertEqual(pricing['verified_date'], '2026-10-07')
        self.assertEqual(pricing['standard_at_or_below_272k_context']['gpt-6-luna']['cache_write'], 0.125)
        self.assertEqual(pricing['standard_at_or_below_272k_context']['gpt-6.1-sol']['cached_input'], 0.1)
        self.assertEqual(pricing['above_272k_context']['output_multiplier'], 1.5)
        self.assertEqual(pricing['service_tier_multipliers']['batch'], 0.5)
        self.assertEqual(set(seen['request']['questions']['model_choice']['criteria']), set(router.CHOICES))

    def test_luna_choice_uses_kind_specific_role(self):
        result, _ = self.run_with(task('execution'), response('luna_max'))
        self.assertEqual((result['model'], result['effort'], result['role']),
                         ('gpt-6-luna', 'max', 'luna_executor'))
        self.assertIsNone(result['ares_model_alias'])

    def test_invalid_choice_confidence_and_shape_fall_back(self):
        for service_response in (
                response('unknown'), response(confidence=0.79), response(confidence=math.nan),
                response(answers=[]), response(answers={'model_choice': []})):
            with self.subTest(service_response=service_response):
                result, _ = self.run_with(task(), service_response)
                self.assertEqual((result['status'], result['model'], result['effort']),
                         ('fallback', 'gpt-6.1-sol', 'high'))

    def test_service_failure_keeps_reported_usage(self):
        failed = {'status': 'fallback', 'reason': 'low_confidence', 'mode': 'mock',
                  'usage': {'input_tokens': 100}, 'cost': 0.003, 'cost_source': 'mock'}
        result, _ = self.run_with(task(), failed)
        self.assertEqual(result['reason'], 'low_confidence')
        self.assertEqual(result['usage'], {'input_tokens': 100})
        self.assertEqual(result['cost_source'], 'mock')

    def test_timeout_falls_back(self):
        def timed_out(*_args, **_kwargs):
            raise subprocess.TimeoutExpired('typesafe', 45)
        result = router.select(task(), runner=timed_out)
        self.assertEqual((result['reason'], result['effort']), ('triage_unavailable', 'high'))
        self.assertIsNone(result['live_attempted'])
        self.assertIsNone(result['request_attempts'])

    def test_public_class_preserved_and_project_label_rejected(self):
        public = task()
        public['data_class'] = 'public'
        _, seen = self.run_with(public, response())
        self.assertEqual(seen['request']['data_class'], 'public')
        invalid = task()
        invalid['data_class'] = 'project_authorized'
        self.assertEqual(router.select(invalid)['reason'], 'data_class')

    def test_real_adapter_mock_contract(self):
        options = {'sol_adaptive': 0.05, 'luna_max': 0.95}
        mocked = {'answers': {'model_choice': {
            'type': 'choice', 'choice': 'luna_max', 'confidence': 0.95,
            'probabilities': options}}, 'usage': {'input_tokens': 10, 'output_tokens': 2}}
        with tempfile.TemporaryDirectory() as directory:
            fixture = Path(directory) / 'response.json'
            fixture.write_text(json.dumps(mocked), encoding='utf-8')
            result = router.select(task(), mock_response=fixture)
        self.assertEqual((result['status'], result['model'], result['mode']),
                         ('ok', 'gpt-6-luna', 'mock'))
        self.assertEqual(result['usage'], {'input_tokens': 10, 'output_tokens': 2})
        self.assertIsNone(result['cost'])


if __name__ == '__main__':
    unittest.main()

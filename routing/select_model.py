#!/usr/bin/env python3
"""Advisory task-start model choice; never starts an agent or command."""

import argparse
import json
import math
import os
from pathlib import Path
import subprocess
import sys


HERE = Path(__file__).resolve().parent
TRIAGE = HERE / 'typesafe_triage.py'
KINDS = {'core_implementation', 'simple_code', 'execution'}
CHOICES = {'sol_adaptive': ('gpt-6.1-sol', 'medium'), 'luna_max': ('gpt-6-luna', 'max')}
THRESHOLD = 0.8


def fallback(reason, *, kind=None, mode='deterministic', telemetry=None):
    telemetry = telemetry or {}
    role = ('simple_worker_adaptive' if kind == 'simple_code' else
            'executor_adaptive' if kind == 'execution' else 'worker')
    return {
        'status': 'fallback', 'reason': reason, 'model': 'gpt-6.1-sol',
        'effort': 'high', 'ares_model_alias': 'Sol-6.1-Jev' if kind in {'simple_code', 'execution'} else None,
        'role': role,
        'confidence': None, 'mode': mode,
        'usage': telemetry.get('usage'), 'cost': telemetry.get('cost'),
        'cost_source': telemetry.get('cost_source') or 'unknown',
        'request_attempts': telemetry.get('request_attempts', 0),
        'live_attempted': telemetry.get('live_attempted', False),
        'advisory_only': True,
    }


def validate_task(task):
    required = {'kind', 'description', 'data_class', 'failure_count',
                'uncertainty', 'scope', 'effects_known'}
    if not isinstance(task, dict) or set(task) != required:
        raise ValueError('task_fields')
    if task['kind'] not in KINDS:
        raise ValueError('task_scope')
    description = task['description']
    if (not isinstance(description, str) or not 1 <= len(description.strip()) <= 400
            or '\n' in description or '\r' in description or '```' in description):
        raise ValueError('description_contract')
    if task['data_class'] not in {'public', 'synthetic'}:
        raise ValueError('data_class')
    if type(task['failure_count']) is not int or not 0 <= task['failure_count'] <= 100:
        raise ValueError('failure_count')
    if task['uncertainty'] not in {'low', 'moderate', 'high'}:
        raise ValueError('uncertainty')
    if task['scope'] not in {'local', 'cross_module', 'core'}:
        raise ValueError('scope')
    if type(task['effects_known']) is not bool:
        raise ValueError('effects_known')
    return task


def triage_request(task, pricing):
    criteria = {
        'sol_adaptive': 'Use Sol with native adaptive reasoning effort when the task needs its stronger understanding or execution ability to finish reliably.',
        'luna_max': 'Use Luna max when the bounded task is clear enough for Luna to finish correctly and its lower price is likely to reduce total cost.'
    }
    return {
        'purpose': 'triage',
        'data_class': task['data_class'],
        'state': {'task': task, 'pricing': pricing},
        'questions': {'model_choice': {
            'type': 'choice',
            'instructions': (
                'For this task at its start, choose the model most likely '
                'to complete correctly at the lowest total cost, including failures, rework, '
                'verification, and coordination. Sol uses its separate native adaptive effort '
                'selector; this question does not choose Sol effort. Compare both models using '
                'the complete `pricing` snapshot; rates per token do not predict token counts or equal quality. '
                'The choice is advisory and does not grant permission to execute. '
                'Do not assume Luna is suitable merely because its token price is lower.'),
            'criteria': criteria,
        }},
    }


def select(task, *, offline=False, mock_response=None, runner=subprocess.run):
    try:
        task = validate_task(task)
    except (ValueError, TypeError) as error:
        return fallback(str(error))
    if task['kind'] == 'core_implementation' or task['scope'] == 'core':
        result = fallback('core_fixed_high')
        result['status'] = 'ok'
        return result
    if task['failure_count'] > 0:
        return fallback('prior_failure_requires_root', kind=task['kind'])
    if task['uncertainty'] == 'high' or task['scope'] == 'cross_module' or not task['effects_known']:
        return fallback('uncertain_scope_requires_root', kind=task['kind'])
    if offline:
        return fallback('offline_selected', kind=task['kind'], mode='offline')
    try:
        pricing = json.loads((HERE / 'pricing.json').read_text(encoding='utf-8'))
        request = triage_request(task, pricing)
        provider = os.environ.get('ARES_ROUTE_PROVIDER', 'typesafe')
        if provider not in {'typesafe', 'zen'}:
            return fallback('invalid_route_provider', kind=task['kind'])
        adapter = TRIAGE if provider == 'typesafe' else HERE / 'jev_triage.py'
        command = [sys.executable, str(adapter)]
        if mock_response:
            command.extend(['--mock-response', str(mock_response)])
        completed = runner(command, input=json.dumps(request, ensure_ascii=False), text=True,
                           capture_output=True, timeout=45, check=False)
        response = json.loads(completed.stdout)
        if not isinstance(response, dict):
            raise ValueError('triage_response')
        mode = response.get('mode', 'unknown')
        telemetry = {key: response.get(key) for key in
                     ('usage', 'cost', 'cost_source', 'request_attempts', 'live_attempted')}
        if completed.returncode != 0 or response.get('status') != 'ok':
            reason = response.get('reason', 'triage_failure')
            return fallback(reason if isinstance(reason, str) else 'triage_failure', kind=task['kind'],
                            mode=mode, telemetry=telemetry)
        answers = response.get('answers')
        if not isinstance(answers, dict):
            return fallback('invalid_or_low_confidence_choice', kind=task['kind'], mode=mode, telemetry=telemetry)
        answer = answers.get('model_choice')
        if not isinstance(answer, dict):
            return fallback('invalid_or_low_confidence_choice', kind=task['kind'], mode=mode, telemetry=telemetry)
        choice, confidence = answer.get('value'), answer.get('confidence')
        if (choice not in CHOICES or type(confidence) not in (int, float)
                or not math.isfinite(confidence) or not THRESHOLD <= confidence <= 1):
            return fallback('invalid_or_low_confidence_choice', kind=task['kind'], mode=mode, telemetry=telemetry)
        model, effort = CHOICES[choice]
        role = ('simple_worker_adaptive' if task['kind'] == 'simple_code' else 'executor_adaptive')
        if model == 'gpt-6-luna':
            role = 'luna_worker' if task['kind'] == 'simple_code' else 'luna_executor'
        return {
            'status': 'ok', 'reason': 'jev_choice', 'model': model, 'effort': effort,
            'ares_model_alias': 'Sol-6.1-Jev' if model == 'gpt-6.1-sol' else None,
            'role': role, 'confidence': confidence, 'mode': mode,
            'usage': telemetry['usage'], 'cost': telemetry['cost'],
            'cost_source': telemetry['cost_source'] or 'unknown',
            'request_attempts': telemetry['request_attempts'] or 0,
            'live_attempted': telemetry['live_attempted'] or False, 'advisory_only': True,
        }
    except (OSError, ValueError, TypeError, subprocess.TimeoutExpired, KeyError):
        # The subprocess may have sent a request before it failed to return telemetry.
        unknown_attempt = {} if mock_response else {'request_attempts': None, 'live_attempted': None}
        return fallback('triage_unavailable', kind=task['kind'], mode='mock' if mock_response else 'live',
                        telemetry=unknown_attempt)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('request', nargs='?', help='task JSON file, default stdin')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--offline', action='store_true')
    mode.add_argument('--mock-response', help='TypeSafe response JSON file')
    args = parser.parse_args(argv)
    try:
        raw = Path(args.request).read_bytes() if args.request else sys.stdin.buffer.read(4097)
        if len(raw) > 4096:
            raise ValueError('task_too_large')
        task = json.loads(raw.decode('utf-8'))
    except (OSError, UnicodeError, ValueError):
        print(json.dumps(fallback('invalid_task_json')))
        return 2
    result = select(task, offline=args.offline, mock_response=args.mock_response)
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result['status'] == 'ok' or result['reason'] not in {
        'task_fields', 'task_scope', 'description_contract', 'data_class', 'failure_count',
        'uncertainty', 'scope', 'effects_known'} else 2


if __name__ == '__main__':
    sys.exit(main())

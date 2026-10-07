#!/usr/bin/env python3
"""Official TypeSafe entry for public/synthetic project triage; no Zen key fallback."""
import importlib.util
import os
from pathlib import Path
import sys

KEY_FILE = Path.home() / '.config/typesafe/api.key'


def key_present():
    if 'TYPESAFE_API_KEY' in os.environ:
        return True
    try:
        return KEY_FILE.is_file()
    except OSError:
        return False


def load_key():
    key = os.environ.get('TYPESAFE_API_KEY', '').strip()
    if key:
        return key
    try:
        return KEY_FILE.read_text(encoding='utf-8').strip() or None
    except OSError:
        return None


def main(argv=None):
    source = Path(__file__).with_name('jev_triage.py')
    spec = importlib.util.spec_from_file_location('_typesafe_jev_triage', source)
    if spec is None or spec.loader is None:
        raise ImportError(f'cannot load triage adapter: {source}')
    triage = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(triage)
    triage.ENDPOINT = 'https://api.typesafe.ai/v1/systemone'
    triage.MODEL = 'jev-latest'
    triage.key_present = key_present
    triage.load_key = load_key
    return triage.main(argv)


if __name__ == '__main__':
    sys.exit(main())

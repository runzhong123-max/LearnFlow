#!/usr/bin/env python3
"""Fetch a pinned public corpus outside the offline evaluation process."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import urllib.request

COMMIT = '3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376'
BLOB = 'd95b872480b413d935821fdc3c84f8a8f5f29e73'
SHA256 = '79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4'
API_PATH = f'repos/snap-research/locomo/git/blobs/{BLOB}'


def fetch():
    if shutil.which('gh'):
        raw = subprocess.check_output(['gh', 'api', API_PATH], timeout=120)
    else:
        request = urllib.request.Request('https://api.github.com/' + API_PATH,
                                         headers={'User-Agent': 'LearnFlow-offline-eval-data-fetch'})
        with urllib.request.urlopen(request, timeout=60) as response:
            raw = response.read()
    payload = json.loads(raw)
    if payload['sha'] != BLOB or payload['encoding'] != 'base64':
        raise ValueError('unexpected GitHub blob identity')
    data = base64.b64decode(payload['content'])
    if hashlib.sha256(data).hexdigest() != SHA256:
        raise ValueError('corpus hash mismatch')
    rows = json.loads(data)
    if len(rows) != 10 or sum(len(r['qa']) for r in rows) != 1986:
        raise ValueError('unexpected corpus counts')
    return data


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        if hashlib.sha256(args.output.read_bytes()).hexdigest() != SHA256:
            raise ValueError('existing file differs; choose a new output path')
    else:
        data = fetch()
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open('xb') as stream:
            stream.write(data)
    print(json.dumps({'file': str(args.output.resolve()), 'sha256': SHA256, 'upstream_commit': COMMIT}))


if __name__ == '__main__':
    main()

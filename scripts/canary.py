#!/usr/bin/env python3
"""Exercise a private candidate backend. Restart only the explicitly named candidate unit."""
import argparse
import hashlib
import json
import pathlib
import subprocess
import sys
import time
import uuid
sys.dont_write_bytecode = True
from recovery import backend_probe, rpc, error_status


def validate(settings, candidate_unit=None):
    endpoint = settings['backendUrl'].rstrip('/') + '/mcp'
    config = json.loads(pathlib.Path(settings['configPath']).read_text())
    token = config.get('http', {}).get('token')
    def call(name, args):
        result = rpc(endpoint, 'tools/call', {'name': name, 'arguments': args}, token)
        failure = error_status(result)
        if failure:
            raise RuntimeError(f'{name} failed: {failure}')
        return result.get('structuredContent', {})
    def wait_backend():
        deadline = time.monotonic() + 40
        while time.monotonic() < deadline:
            try:
                status, evidence = backend_probe(settings)
                if status == 'HEALTHY':
                    return evidence
            except Exception:
                pass
            time.sleep(0.5)
        raise RuntimeError('candidate backend did not pass its capability probe')
    evidence = wait_backend()
    names = {t['name'] for t in rpc(endpoint, 'tools/list', token=token)['tools']}
    results = {'backend': 'passed', 'catalogCount': len(names), 'runtime': evidence.get('runtime', {})}
    directory = pathlib.Path(settings['canaryDirectory'])
    if 'fs.write' in names and 'fs.read' in names and 'fs.delete' in names:
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        target = str(directory / ('file-' + uuid.uuid4().hex))
        original = 'mcp canary original\n'
        try:
            call('fs.write', {'path': target, 'content': original, 'mode': 'create'})
            if call('fs.read', {'path': target}).get('content') != original:
                raise RuntimeError('canary content mismatch')
            results['filesystem'] = 'passed'
            if 'fs.replace' in names:
                digest = hashlib.sha256(original.encode()).hexdigest()
                call('fs.replace', {'path': target, 'content': 'replacement\n', 'expectedSha256': digest})
                conflict = rpc(endpoint, 'tools/call', {'name': 'fs.replace', 'arguments': {'path': target, 'content': 'must not overwrite', 'expectedSha256': digest}}, token)
                if not conflict.get('isError') or call('fs.read', {'path': target}).get('content') != 'replacement\n':
                    raise RuntimeError('conditional replacement did not reject an old hash')
                results['atomicConflict'] = 'passed'
        finally:
            if pathlib.Path(target).exists():
                call('fs.delete', {'path': target})
    if 'exec.start' in names:
        allowed = config.get('shell', {}).get('allowedCommands', [])
        if '*' not in allowed and 'node' not in allowed:
            results['durableJobs'] = 'not exercised: node is not granted'
        else:
            directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            operation = 'release-canary-' + uuid.uuid4().hex
            request = {'operationId': operation, 'command': 'node', 'args': ['-e', 'setTimeout(()=>process.stdout.write("durable-canary-result"),5000)'], 'cwd': str(directory), 'timeoutMs': 15000}
            first = call('exec.start', request)
            duplicate = call('exec.start', request)
            if first['jobId'] != duplicate['jobId']:
                raise RuntimeError('duplicate operation received a different job')
            if candidate_unit:
                subprocess.run(['systemctl', '--user', 'restart', candidate_unit], check=True, timeout=15)
                wait_backend()
            deadline = time.monotonic() + 25
            while time.monotonic() < deadline:
                state = call('exec.status', {'jobId': first['jobId']})
                if state['state'] == 'succeeded':
                    break
                if state['state'] in ['failed', 'cancelled', 'unknown']:
                    raise RuntimeError('canary job state: ' + state['state'])
                time.sleep(0.25)
            else:
                raise RuntimeError('canary job did not complete')
            output = call('exec.output', {'jobId': first['jobId']})
            if output.get('text') != 'durable-canary-result':
                raise RuntimeError('durable result was not preserved')
            if call('exec.start', request)['jobId'] != first['jobId']:
                raise RuntimeError('completed operation was replayed')
            results['durableJobs'] = 'passed'
            results['backendRestartPreservesJob'] = 'passed' if candidate_unit else 'not requested'
            cancel_request = {**request, 'operationId': 'cancel-canary-' + uuid.uuid4().hex, 'args': ['-e', 'setTimeout(()=>{},30000)'], 'timeoutMs': 40000}
            cancel = call('exec.start', cancel_request)
            call('exec.cancel', {'jobId': cancel['jobId']})
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                state = call('exec.status', {'jobId': cancel['jobId']})
                if state['state'] == 'cancelled':
                    break
                time.sleep(0.25)
            else:
                raise RuntimeError('cancellation was not confirmed')
            results['cancellation'] = 'passed'
    results['finalBackend'] = wait_backend()
    return results


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--settings', required=True, type=pathlib.Path)
    parser.add_argument('--restart-candidate', help='Only use a private candidate unit that has no user traffic')
    args = parser.parse_args()
    print(json.dumps(validate(json.loads(args.settings.read_text()), args.restart_candidate), indent=2))

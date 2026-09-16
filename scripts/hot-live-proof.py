#!/usr/bin/env python3
"""Installed owner-flow proof: real MCP calls throughout Overdeck sync and rollback.

Uses the enrolled policy unchanged. Never launches desktop applications when the
owner disabled them, never repeats a failed mutation, and cleans only its own
uniquely named commands. Run observe on the guest before sync on the host.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import fcntl
import json
import os
from pathlib import Path
import subprocess
import re
import sys
import threading
import time
import urllib.request
import uuid

sys.dont_write_bytecode = True
from hot_control import atomic_json, control, load_state, read_json, select, state_path, process_identity


def desktop_observation(before, after, exercised):
    keys = ['application', 'browser', 'hostDisplayAccess', 'screenCapture', 'screenRecording', 'input']
    original = {key: bool(before.get(key, False)) for key in keys}
    current = {key: bool(after.get(key, False)) for key in keys}
    if original != current:
        raise RuntimeError('desktop capabilities changed during the upgrade')
    return {'granted': current, 'policyUnchanged': True,
            'proof': 'passed' if exercised else 'not exercised; actual grants are reported separately'}


def prove(home, expected, mode, report, desktop_display=None):
    active = read_json(home / '.config/chatgpt-mcp/active.json')
    target = read_json(home / '.config/overdeck/mcp-target.json')
    config = read_json(active['configPath'])
    endpoint = active['backendUrl'] + '/mcp'
    token = config.get('http', {}).get('token')
    runtime_ms = min(config.get('shell', {}).get('maxRuntimeMs', 30000), 600000)
    if runtime_ms < 60000:
        raise RuntimeError('installed proof needs a permitted one-minute command lifetime')
    operation = uuid.uuid4().hex
    root = Path(target['canaryDirectory']) / ('hotswap-' + operation)
    stop = threading.Event()
    markers = set()
    faults = []
    jobs = []
    observations = {}
    desktop_resources = []
    desktop_results = []
    phase = 'preparing'

    def call(name, arguments):
        request = urllib.request.Request(endpoint, data=json.dumps({'jsonrpc': '2.0', 'id': uuid.uuid4().hex,
            'method': 'tools/call', 'params': {'name': name, 'arguments': arguments}}).encode(),
            headers={'Accept': 'application/json, text/event-stream', 'Content-Type': 'application/json',
                     **({'Authorization': 'Bearer ' + token} if token else {})})
        with urllib.request.urlopen(request, timeout=runtime_ms / 1000 + 10) as response:
            raw = response.read(8 * 1024 * 1024 + 1)
        if len(raw) > 8 * 1024 * 1024:
            raise RuntimeError('proof response limit exceeded')
        text = raw.decode()
        if text.startswith(('event:', 'data:', ':')):
            messages = [json.loads(line[5:].strip()) for line in text.splitlines() if line.startswith('data:')]
            value = next(item for item in messages if 'result' in item or 'error' in item)
        else:
            value = json.loads(text)
        result = value.get('result', {})
        if value.get('error') or result.get('isError'):
            # Report only the operation name, never arbitrary tool output.
            raise RuntimeError('installed proof operation failed: ' + name)
        return result.get('structuredContent', {})

    def identity():
        return call('system.info', {})['runtime']

    def pids():
        units = [profile['unit'] for profile in active['profiles']]
        return {unit: subprocess.check_output(['systemctl', '--user', 'show', unit, '-p', 'MainPID', '--value'], text=True).strip() for unit in units}

    def hold(name):
        code = "const f=require('node:fs');const p=" + json.dumps(str(root)) + ";"
        code += "f.writeFileSync(p+'/' + " + json.dumps(name + '.started') + ",String(process.pid));"
        code += "const finish=()=>{if(f.existsSync(p+'/' + " + json.dumps(name + '.release') + ")){w.close();process.stdout.write(" + json.dumps(name) + ");}};const w=f.watch(p,finish);finish();"
        return {'command': 'node', 'args': ['-e', code], 'cwd': str(root), 'timeoutMs': runtime_ms}

    def wait_started(name):
        deadline = time.monotonic() + 15
        while not (root / (name + '.started')).exists():
            if time.monotonic() >= deadline:
                raise RuntimeError('proof command did not reach its barrier')
            time.sleep(.05)

    def cancel_job(job):
        call('exec.cancel', {'jobId': job['jobId']})
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            current = call('exec.status', {'jobId': job['jobId']})
            if current['state'] == 'cancelled':
                return current
            if current['state'] in ['failed', 'unknown', 'succeeded']:
                raise RuntimeError('proof cancellation did not reach its worker')
            time.sleep(.1)
        raise RuntimeError('proof cancellation not confirmed')

    def traffic(lane):
        try:
            for counter in range(5000):
                if stop.is_set():
                    return
                marker = f'{lane}:{counter}'
                call('fs.write', {'path': str(root / 'writes'), 'content': marker + '\n', 'mode': 'append'})
                body = call('fs.read', {'path': str(root / 'writes')})
                if marker + '\n' not in body['content']:
                    raise RuntimeError('proof write missing from subsequent read')
                command = call('shell.exec', {'command': 'node', 'cwd': str(root), 'timeoutMs': 10000,
                    'args': ['-e', "require('node:fs').appendFileSync(" + json.dumps(str(root / 'commands')) + ',' + json.dumps(marker + '\n') + ')']})
                if command['exitCode'] != 0 or command['timedOut']:
                    raise RuntimeError('proof command did not complete')
                markers.add(marker)
        except BaseException as error:
            faults.append(type(error).__name__ + ': ' + str(error)[:180])
            stop.set()

    def desktop_start(label):
        if desktop_display is None:
            return None
        profile = root / ('firefox-profile-' + label)
        call('fs.mkdir', {'path': str(profile), 'recursive': False})
        browser = call('app.launch', {'name': 'firefox', 'display': desktop_display,
            'args': ['about:blank', '--no-remote', '--profile', str(profile)]})
        owned = {'label': label, 'browser': browser, 'browserIdentity': process_identity(browser['pid']),
                 'browserCloseAttempted': False, 'recordingStopAttempted': False}
        desktop_resources.append(owned)
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            window = call('shell.exec', {'command': 'xdotool', 'args': ['search', '--onlyvisible', '--pid', str(browser['pid'])],
                          'env': {'DISPLAY': desktop_display}, 'timeoutMs': 3000})
            if window['exitCode'] == 0 and window['stdout'].strip():
                owned['windowIds'] = window['stdout'].split()
                break
            if process_identity(browser['pid']) != owned['browserIdentity']:
                raise RuntimeError('isolated browser exited before its window became visible')
            time.sleep(.1)
        else:
            raise RuntimeError('isolated browser did not expose a visible window')
        capture = call('screen.capture', {'display': desktop_display})
        if capture.get('mimeType') != 'image/png' or capture.get('bytes', 0) <= 100:
            raise RuntimeError('real desktop capture did not produce a PNG')
        recording = call('screen.record.start', {'display': desktop_display, 'path': str(root / (label + '.mp4')), 'frameRate': 4})
        owned.update(recording=recording, recordingIdentity=process_identity(recording['pid']))
        if not owned['browserIdentity'] or not owned['recordingIdentity']:
            raise RuntimeError('desktop resource ownership was not observed')
        return owned

    def desktop_finish(owned):
        if owned is None:
            return
        browser, recording = owned['browser'], owned['recording']
        if process_identity(browser['pid']) != owned['browserIdentity'] or process_identity(recording['pid']) != owned['recordingIdentity']:
            raise RuntimeError('desktop resource did not retain its original process incarnation')
        visible = call('shell.exec', {'command': 'xdotool', 'args': ['search', '--onlyvisible', '--pid', str(browser['pid'])],
                       'env': {'DISPLAY': desktop_display}, 'timeoutMs': 3000})
        if visible['exitCode'] != 0 or not set(owned['windowIds']).intersection(visible['stdout'].split()):
            raise RuntimeError('browser window was lost across the version change')
        # Mark before dispatch: an uncertain acknowledgement never authorizes a
        # second stop/close submission from the cleanup path.
        owned['recordingStopAttempted'] = True
        finalized = call('screen.record.stop', {'handle': recording['handle']})
        video = call('shell.exec', {'command': 'ffprobe', 'args': ['-v', 'error', '-select_streams', 'v:0',
                     '-show_entries', 'stream=codec_name,width,height,nb_frames', '-of', 'json', finalized['path']], 'timeoutMs': 5000})
        if video['exitCode'] != 0:
            raise RuntimeError('real recording did not finalize into a decodable video')
        stream = json.loads(video['stdout'])['streams'][0]
        if stream.get('codec_name') != 'h264' or int(stream.get('nb_frames', 0)) <= 0 or finalized['bytes'] <= 0:
            raise RuntimeError('real recording contains no verified video frames')
        owned['browserCloseAttempted'] = True
        call('app.close', {'handle': browser['handle']})
        deadline = time.monotonic() + 10
        while process_identity(browser['pid']) == owned['browserIdentity'] and time.monotonic() < deadline:
            time.sleep(.05)
        if process_identity(browser['pid']) == owned['browserIdentity']:
            raise RuntimeError('owned browser did not close through its retained handle')
        desktop_results.append({'label': owned['label'], 'browserPid': browser['pid'], 'recordingPid': recording['pid'],
                                'windowPreserved': True, 'video': stream, 'bytes': finalized['bytes'], 'path': finalized['path']})

    def status(phase_name):
        atomic_json(report.with_suffix('.status.json'), {'phase': phase_name, 'mode': mode, 'expected': expected,
            'operation': operation, 'root': str(root), 'completedCycles': len(markers), 'faultCount': len(faults)})

    pool = ThreadPoolExecutor(max_workers=3)
    manager = None
    manager_log = None
    held = None
    pumps = []
    before_info = call('system.info', {})
    before = before_info['runtime']
    if desktop_display is not None:
        if not re.fullmatch(r':[0-9]+(?:\.[0-9]+)?', desktop_display):
            raise RuntimeError('desktop proof requires an explicitly selected local test display')
        if not all(before_info.get('capabilities', {}).get(key) for key in ['application', 'browser', 'hostDisplayAccess', 'screenCapture', 'screenRecording']):
            raise RuntimeError('the existing desktop grants do not permit the requested proof')
        firefox = config.get('application', {}).get('applications', {}).get('firefox', {})
        if not firefox.get('allowArguments'):
            raise RuntimeError('desktop proof requires the configured Firefox application with isolated-profile arguments')
    tunnel_before = pids()
    if before['release'] == expected:
        raise RuntimeError('proof requires a real version change, not an already-installed revision')
    try:
        call('fs.mkdir', {'path': str(root), 'recursive': False})
        for name in ['writes', 'commands']:
            call('fs.write', {'path': str(root / name), 'content': '', 'mode': 'create'})
        desktop_a = desktop_start('before-upgrade')
        held = pool.submit(call, 'shell.exec', hold('original-call'))
        wait_started('original-call')
        job_a = call('exec.start', {'operationId': 'hotswap-a-' + operation, **hold('job-a')})
        jobs.append(job_a); wait_started('job-a')
        job_a = call('exec.status', {'jobId': job_a['jobId']})
        pumps = [pool.submit(traffic, lane) for lane in range(2)]
        phase = 'traffic-ready'; status(phase)
        if mode == 'sync':
            manager_log = report.with_suffix('.sync.log').open('w')
            os.chmod(manager_log.name, 0o600)
            manager = subprocess.Popen([sys.executable, str(home / '.local/lib/overdeck-mcp-manager/current/manage.py'), 'sync'],
                                       stdout=manager_log, stderr=subprocess.STDOUT)
        deadline = time.monotonic() + min(850, runtime_ms / 1000 - 15)
        while time.monotonic() < deadline:
            if faults:
                raise RuntimeError('continuous traffic failed')
            try:
                deployment = load_state(home)
                route = control(deployment['router']['controlSocket'])
                observations.setdefault('routerPid', route['routerPid'])
            except (OSError, ValueError, RuntimeError):
                pass
            observed = read_json(home / '.local/state/overdeck/mcp/local.json')
            if observed.get('state') == 'converged' and observed.get('revision') == expected:
                if manager is None or manager.poll() is not None:
                    break
            if manager is not None and manager.poll() not in [None, 0]:
                raise RuntimeError('normal Overdeck sync failed')
            time.sleep(.1)
        else:
            raise RuntimeError('normal Overdeck upgrade did not converge before the held-command deadline')
        if manager is not None and manager.returncode != 0:
            raise RuntimeError('normal Overdeck sync did not complete successfully')
        after_info = call('system.info', {})
        after = after_info['runtime']
        desktop_observed = desktop_observation(before_info.get('capabilities', {}), after_info.get('capabilities', {}), desktop_display is not None)
        if after['release'] != expected or held.done():
            raise RuntimeError('replacement failed to answer while original call remained active')
        deployment = load_state(home)
        route = control(deployment['router']['controlSocket'])
        selected = route['active']
        phase = 'upgraded-with-original-call-active'; status(phase)
        assert tunnel_before == pids(), 'tunnel PID changed'
        assert route['routerPid'] == observations['routerPid'], 'router PID changed'
        observed_a = call('exec.status', {'jobId': job_a['jobId']})
        assert observed_a['workerPid'] == job_a['workerPid'] and observed_a['workerIdentity'] == job_a['workerIdentity']
        cancel_job(job_a)
        call('fs.write', {'path': str(root / 'original-call.release'), 'content': 'go', 'mode': 'create'})
        original = held.result(timeout=15)
        assert original['exitCode'] == 0 and original['stdout'] == 'original-call' and not original['timedOut']
        desktop_finish(desktop_a)
        desktop_b = desktop_start('after-upgrade')
        job_b = call('exec.start', {'operationId': 'hotswap-b-' + operation, **hold('job-b')})
        jobs.append(job_b); wait_started('job-b')
        job_b = call('exec.status', {'jobId': job_b['jobId']})
        lock_path = home / '.local/state/chatgpt-mcp/recovery/recovery.lock'
        with lock_path.open('a+') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            select(home, 'rollback')
            try:
                assert identity()['release'] == before['release'], 'immediate rollback did not select the original version'
                observed_b = call('exec.status', {'jobId': job_b['jobId']})
                assert observed_b['workerPid'] == job_b['workerPid'] and observed_b['workerIdentity'] == job_b['workerIdentity']
                cancel_job(job_b)
                desktop_finish(desktop_b)
            finally:
                select(home, 'activate', selected)
        assert identity()['release'] == expected
        phase = 'rollback-and-restoration-passed'; status(phase)
        current = control(deployment['router']['controlSocket'])
        assert current['routerPid'] == route['routerPid'] and tunnel_before == pids()
        noop = subprocess.run([sys.executable, str(home / '.local/lib/overdeck-mcp-manager/current/manage.py'), 'apply'],
                              capture_output=True, text=True, timeout=120)
        assert noop.returncode == 0 and json.loads(noop.stdout)['unchanged'] is True, 'second normal sync was not a verified no-op'
        stop.set()
        for pump in pumps:
            pump.result(timeout=20)
        if faults:
            raise RuntimeError('continuous traffic failed: ' + '; '.join(faults))
        for name in ['writes', 'commands']:
            rows = call('fs.read', {'path': str(root / name)})['content'].splitlines()
            assert len(rows) == len(markers) and set(rows) == markers, 'lost or duplicated ' + name
        assert len(markers) >= 4
        result = {'state': 'passed', 'oldRevision': before['release'], 'revision': expected, 'operation': operation,
                  'writes': len(markers), 'commands': len(markers), 'duplicateCommands': 0, 'interruptedCalls': 0,
                  'originalCallFinished': True, 'jobHandlesSurvivedUpgradeAndRollback': True, 'cancellationConfirmed': True,
                  'tunnelPidsUnchanged': tunnel_before, 'routerPidUnchanged': current['routerPid'],
                  'newBackendPid': after['pid'], 'oldBackendPid': before['pid'], 'secondApplyUnchanged': True,
                  'desktopPolicyUnchanged': desktop_observed['policyUnchanged'], 'desktopLiveProof': desktop_observed['proof'],
                  'desktopCapabilities': desktop_observed['granted'], 'desktopResults': desktop_results,
                  'auditDirectory': str(root)}
        atomic_json(report, result); status('passed')
        print(json.dumps(result), flush=True)
        return result
    except BaseException as error:
        atomic_json(report, {'state': 'failed', 'phase': phase, 'errorType': type(error).__name__,
                            'detail': str(error)[:300], 'completedCycles': len(markers), 'trafficErrors': faults,
                            'auditDirectory': str(root), 'expected': expected})
        raise
    finally:
        stop.set()
        # Only test-owned markers/jobs are released. Never terminate a backend,
        # router, tunnel, owner job, or an uncertain in-progress deployment.
        if held is not None and not held.done():
            (root / 'original-call.release').touch(exist_ok=True)
        for job in jobs:
            try:
                call('exec.cancel', {'jobId': job['jobId']})
            except Exception:
                pass
        for owned in desktop_resources:
            for kind, operation_name, attempted in [('recording', 'screen.record.stop', 'recordingStopAttempted'), ('browser', 'app.close', 'browserCloseAttempted')]:
                if kind not in owned or owned[attempted]:
                    continue
                owned[attempted] = True
                try:
                    call(operation_name, {'handle': owned[kind]['handle']})
                except Exception:
                    pass  # Retain the failed proof; never retry an uncertain operation.
        pool.shutdown(wait=True)
        if manager_log is not None:
            manager_log.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--expect', required=True)
    parser.add_argument('--mode', choices=['sync', 'observe'], required=True)
    parser.add_argument('--report', required=True, type=Path)
    parser.add_argument('--desktop-display', help='Optional dedicated test-owned local X11 display; never enables desktop grants')
    args = parser.parse_args()
    if len(args.expect) != 40 or any(c not in '0123456789abcdef' for c in args.expect):
        parser.error('expected revision must be a full commit ID')
    try:
        prove(Path.home(), args.expect, args.mode, args.report, args.desktop_display)
    except Exception as error:
        print(json.dumps({'state': 'proof-failed', 'errorType': type(error).__name__, 'report': str(args.report)}), file=sys.stderr)
        raise SystemExit(1)

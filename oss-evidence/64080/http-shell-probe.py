#!/usr/bin/env python3
"""Diagnostic for #64080 through the actual CLI server and HTTP shell API.
No model/provider call is made. HOME is preserved; XDG and the product's test-home
setting isolate application state. Helper start count is the assertion; elapsed
wall time is recorded only as a local observation.
"""
import base64
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time
import urllib.request
import urllib.error

def locked_rewrite(path, transform):
    # Each output directory belongs to one probe; replace its final JSON atomically.
    temporary = path.with_name(path.name + '.tmp.' + str(os.getpid()))
    temporary.write_text(transform(''))
    os.replace(temporary, path)

if len(sys.argv) != 4 or sys.argv[3] not in ('baseline', 'candidate'):
    raise SystemExit('usage: http-shell-probe.py WORKTREE OUTPUT_DIR baseline|candidate')
work = Path(sys.argv[1]).expanduser().resolve()
root = Path(sys.argv[2]).expanduser().resolve()
root.mkdir(parents=True, exist_ok=True)
label = sys.argv[3]
case = root / ('http-' + label)
case.mkdir(parents=True, exist_ok=True)
for name in ['project', 'home', 'data', 'cache', 'config', 'state', 'tmp']:
    (case / name).mkdir(exist_ok=True)
helper = Path(__file__).with_name('unreachable-pty.py')
assert helper.is_file()
launches = case / 'helper-starts.jsonl'
assert not launches.exists(), 'Use a new label; never overwrite earlier runs.'

env = dict(os.environ)
env.update({
    'OPENCODE_PTY_BIN': str(helper),
    'OPENCODE_HTTP_PROBE_STARTS': str(launches),
    'OPENCODE_PASSWORD': 'oss-fixture-only',
    'OPENCODE_TEST_HOME': str(case / 'home'),
    'OPENCODE_CONFIG_DIR': str(case / 'config'),
    'OPENCODE_CONFIG_CONTENT': '{}',
    'OPENCODE_DISABLE_PROJECT_CONFIG': 'true',
    'OPENCODE_DISABLE_CLAUDE_CODE': 'true',
    'OPENCODE_DISABLE_MODELS_FETCH': 'true',
    'OPENCODE_DISABLE_FILEWATCHER': 'true',
    'OPENCODE_DISABLE_FFF': 'true',
    'XDG_DATA_HOME': str(case / 'data'),
    'XDG_CACHE_HOME': str(case / 'cache'),
    'XDG_CONFIG_HOME': str(case / 'config'),
    'XDG_STATE_HOME': str(case / 'state'),
    'TMPDIR': str(case / 'tmp'),
    'BUN_RUNTIME_TRANSPILER_CACHE_PATH': str(root / 'transpiler-cache'),
})
# Prevent inherited test/service endpoints or provider config from changing this probe.
for key in ['OPENCODE_SERVER_PASSWORD', 'OPENCODE_CONFIG', 'OPENCODE_CLI_CONFIG_CONTENT',
            'OPENCODE_SERVER', 'OPENCODE_DB', 'OPENCODE_SIMULATE']:
    env.pop(key, None)
head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=work, text=True).strip()
command = ['bun', 'run', '--cwd', str(work / 'packages/cli'), 'src/index.ts',
           'serve', '--hostname', '127.0.0.1', '--port', '0']
result = {'label': label, 'head': head, 'command': command,
          'scope': 'macOS HTTP shell API; stand-in registration without a socket; no model/provider/nono',
          'requests': []}
server = None
cleanup = []

def starts():
    return [json.loads(line) for line in launches.read_text().splitlines()] if launches.exists() else []

def request(endpoint, payload=None):
    headers = {'Authorization': 'Basic ' + base64.b64encode(b'opencode:oss-fixture-only').decode(),
               'x-opencode-directory': str(case / 'project')}
    data = None
    if payload is not None:
        data = json.dumps(payload).encode()
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(url + endpoint, data=data, headers=headers)
    with urllib.request.urlopen(req, timeout=90) as response:
        return json.load(response)

def unwrap(value):
    return value.get('data', value) if isinstance(value, dict) else value

try:
    with (case / 'server.log').open('a') as logfile:
        server = subprocess.Popen(command, cwd=case / 'project', env=env,
                                  stdout=logfile, stderr=subprocess.STDOUT, start_new_session=True)
        locked_rewrite(case / 'server-process.json', lambda _: json.dumps({'pid': server.pid, 'head': head}) + '\n')
        deadline = time.monotonic() + 60
        url = None
        while time.monotonic() < deadline:
            log = (case / 'server.log').read_text(errors='replace')
            found = re.search(r'server listening on (http://127\.0\.0\.1:\d+)', log)
            if found:
                url = found.group(1)
                break
            if server.poll() is not None:
                raise RuntimeError('server exited before listening: ' + log[-4000:])
            time.sleep(0.05)
        if url is None:
            raise RuntimeError('server did not start: ' + (case / 'server.log').read_text(errors='replace')[-4000:])
        result['url'] = url
        print(json.dumps({'label': label, 'listening': url, 'pid': server.pid}), flush=True)
        for number in [1, 2]:
            before = len(starts())
            began = time.monotonic()
            raw = request('/api/shell', {'command': "printf 'oss-http-shell-ok\\n'"})
            info = unwrap(raw)
            elapsed = round((time.monotonic() - began) * 1000)
            if not isinstance(info, dict) or 'id' not in info:
                raise RuntimeError('unexpected shell.create: ' + json.dumps(raw))
            shell_id = info['id']
            deadline = time.monotonic() + 10
            while info.get('status') == 'running' and time.monotonic() < deadline:
                info = unwrap(request('/api/shell/' + shell_id))
                if info.get('status') == 'running':
                    time.sleep(0.02)
            output = unwrap(request('/api/shell/' + shell_id + '/output'))
            row = {'call': number, 'create_ms': elapsed, 'starts_before': before,
                   'starts_after': len(starts()), 'info': info, 'output': output}
            result['requests'].append(row)
            assert info['status'] == 'exited', row
            assert info.get('exit') == 0, row
            assert output['output'] == 'oss-http-shell-ok\n', row
            print(json.dumps({'label': label, 'call': number, 'ms': elapsed,
                              'helper_starts': row['starts_after'], 'output': output['output']}), flush=True)
        expected_starts = [4, 8] if label == 'baseline' else [2, 2]
        assert [row['starts_after'] for row in result['requests']] == expected_starts, result
        # Observe a bounded idle period without sending any API requests.
        result['idle_starts_before'] = len(starts())
        time.sleep(6)
        result['idle_starts_after'] = len(starts())
        result['idle_observation_seconds'] = 6
        result['passed'] = True
except BaseException as error:
    result['passed'] = False
    result['error'] = repr(error)
finally:
    if server is not None and server.poll() is None:
        os.killpg(server.pid, signal.SIGTERM)
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(server.pid, signal.SIGKILL)
            server.wait(timeout=5)
    for event in starts():
        pid = event['pid']
        try:
            # The unique absolute helper path and label bind cleanup to this fixture.
            current = subprocess.run(['ps', '-p', str(pid), '-o', 'command='], capture_output=True, text=True).stdout
            if str(helper) in current:
                os.kill(pid, signal.SIGTERM)
                cleanup.append({'pid': pid, 'action': 'terminated-own-fixture'})
        except ProcessLookupError:
            pass
    result['helper_starts'] = starts()
    result['cleanup'] = cleanup
    result['server_returncode'] = server.poll() if server is not None else None
    result['end_head'] = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=work, text=True).strip()
    locked_rewrite(case / 'result.json', lambda _: json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(result, ensure_ascii=False), flush=True)
if not result['passed']:
    sys.exit(1)

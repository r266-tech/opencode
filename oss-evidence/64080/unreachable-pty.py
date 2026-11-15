#!/usr/bin/env python3
import json
import os
from pathlib import Path
import signal
import sys
import time
args = sys.argv[1:]
runtime = Path(args[args.index('--runtime-dir') + 1])
name = args[args.index('--name') + 1]
folder = runtime / name
folder.mkdir(parents=True, exist_ok=True)
log = Path(os.environ['OPENCODE_HTTP_PROBE_STARTS'])
line = json.dumps({'pid': os.getpid(), 'runtime': str(folder), 'at_ns': time.monotonic_ns()}) + '\n'
fd = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
os.write(fd, line.encode())
os.close(fd)
# Short missing AF_UNIX pathname avoids macOS's socket-path length limit.
(folder / 'service.json').write_text(json.dumps({
    'instance_id': 'oss-http-fixture', 'pid': os.getpid(), 'protocol': 8,
    'socket': '/tmp/oss-http-missing-' + str(os.getpid()) + '.sock',
    'token': 'fixture-only', 'features': [],
}))
signal.pause()

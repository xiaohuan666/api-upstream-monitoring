"""Offline IPC adversary: never imports the production worker or accesses a network."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
from urllib.parse import parse_qs, urlsplit

payload = json.loads(sys.stdin.readline(65537))
query = parse_qs(urlsplit(payload['authUrl']).query)
mode = query.get('fixture', ['success'])[0]
result = {'type': 'result', 'code': 'offline-code', 'state': query['state'][0],
          'redirectUri': query['redirect_uri'][0]}


ack_file = Path(__file__).with_suffix('.acks')
effects_file = Path(__file__).with_suffix('.effects')
# Only non-secret IPC control frames and synthetic stage markers go to disk.
ack_file.write_text('')
effects_file.write_text('')


def emit(value):
    print(json.dumps(value), flush=True)


def gated_stage(stage):
    emit({'type': 'stage', 'stage': stage})
    raw = sys.stdin.readline(1025)
    assert raw.endswith('\n')
    assert json.loads(raw) == {'type': 'ack', 'stage': stage}
    with ack_file.open('a') as output:
        output.write(raw)
    # This marker stands for the HTTP submission that must never precede ACK.
    with effects_file.open('a') as output:
        output.write(stage + '\n')


if mode == 'success':
    for stage in ['warmup', 'csrf', 'authorizing', 'email', 'password', 'totp', 'consent']:
        gated_stage(stage)
    emit(result)
elif mode == 'split':
    result['code'] = 'offline-授权码'
    wire = (json.dumps(result, ensure_ascii=False) + '\n').encode()
    for byte in wire:
        os.write(1, bytes([byte]))
        time.sleep(0.001)
elif mode == 'duplicate':
    emit(result)
    time.sleep(0.03)
    emit(result)
elif mode == 'trailing-stage':
    emit(result)
    emit({'type': 'stage', 'stage': 'password'})
elif mode == 'exit-failure':
    emit(result)
    sys.exit(7)
elif mode == 'signal-exit':
    emit(result)
    os.kill(os.getpid(), signal.SIGTERM)
elif mode == 'missing':
    pass
elif mode == 'partial':
    sys.stdout.write(json.dumps(result))
elif mode == 'invalid-json':
    print('RAW-UPSTREAM-SECRET', flush=True)
elif mode == 'invalid-utf8':
    os.write(1, b'\xff\n')
elif mode == 'unknown-stage':
    emit({'type': 'stage', 'stage': payload['password']})
elif mode == 'extra-field':
    emit({**result, 'message': payload['password']})
elif mode == 'unknown-event':
    emit({'type': 'log', 'message': payload['password']})
elif mode == 'bad-envelope':
    print('[]', flush=True)
elif mode == 'empty-line':
    print('', flush=True)
elif mode == 'line-limit':
    print('x' * (16 * 1024 + 1), flush=True)
elif mode == 'unfinished-line-limit':
    os.write(1, b'x' * (16 * 1024 + 1))
    time.sleep(10)
elif mode == 'total-limit':
    # Valid stage events, individual lines and event count are all in bounds.
    for unused in range(10):
        print(json.dumps({'type': 'stage', 'stage': 'warmup'}) + ' ' * 8000, flush=True)
    emit(result)
elif mode == 'event-limit':
    for unused in range(129):
        emit({'type': 'stage', 'stage': 'warmup'})
    emit(result)
elif mode == 'stderr-limit':
    os.write(2, b'x' * (64 * 1024 + 1))
    time.sleep(10)
elif mode == 'stderr-secret':
    print(payload['email'], payload['password'], payload['totpSecret'], payload['proxy'], file=sys.stderr, flush=True)
    emit({'type': 'error', 'code': 'OAUTH_NETWORK_ERROR'})
elif mode == 'unknown-error':
    emit({'type': 'error', 'code': payload['password']})
elif mode == 'error-message':
    emit({'type': 'error', 'code': 'OAUTH_NETWORK_ERROR', 'message': payload['password']})
elif mode == 'known-error':
    emit({'type': 'error', 'code': query['error'][0]})
    sys.exit(1)
elif mode == 'error-hold':
    emit({'type': 'error', 'code': 'OAUTH_NETWORK_ERROR'})
    time.sleep(10)
elif mode == 'callback':
    result.update(json.loads(query['override'][0]))
    emit(result)
elif mode == 'gated-side-effect':
    gated_stage('password')
    emit(result)
elif mode == 'ack-pipe-closed':
    # Standard Python stream wrappers may retain fd 0; close the actual pipe.
    os.close(0)
    emit({'type': 'stage', 'stage': 'password'})
    time.sleep(10)
elif mode == 'hold':
    gated_stage('password')
    time.sleep(10)
elif mode == 'descendants':
    pid_file = str(Path(__file__).with_suffix('.pids'))
    child_source = '''import os, signal, subprocess, sys, time
signal.signal(signal.SIGTERM, signal.SIG_IGN)
grandchild = subprocess.Popen([sys.executable, '-c', 'import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(30)'], stdin=subprocess.DEVNULL)
with open(sys.argv[1], 'w') as output: output.write(str(os.getpid()) + ',' + str(grandchild.pid))
time.sleep(30)
'''
    subprocess.Popen([sys.executable, '-c', child_source, pid_file], stdin=subprocess.DEVNULL)
    while not Path(pid_file).exists():
        time.sleep(0.005)
    gated_stage('password')
    time.sleep(30)
else:
    raise AssertionError('Unknown offline fixture case')

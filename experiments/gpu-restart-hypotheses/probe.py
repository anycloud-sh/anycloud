"""The in-container GPU probe for this spike; see README.md.

`probe.py` prints one JSON record. `probe.py monitor` is the container's main
process: it initializes torch once, like a long-running Job, and every 15 s
appends a fresh probe plus that live process's `mem_get_info()` to
/spike/monitor-$SPIKE_LABEL.log.
"""

import ctypes
import json
import os
import subprocess
import sys
import time

TORCH = 'import torch; print(torch.cuda.device_count()); print(torch.cuda.mem_get_info())'


def nvml():
    try:
        lib = ctypes.CDLL('libnvidia-ml.so.1')
    except OSError as error:
        return f'load failed: {error}'
    lib.nvmlErrorString.restype = ctypes.c_char_p
    rc = lib.nvmlInit_v2()
    if rc:
        return f'{rc}: {lib.nvmlErrorString(rc).decode()}'
    count = ctypes.c_uint()
    lib.nvmlDeviceGetCount_v2(ctypes.byref(count))
    lib.nvmlShutdown()
    return f'ok count={count.value}'


def cuda():
    try:
        lib = ctypes.CDLL('libcuda.so.1')
    except OSError as error:
        return f'load failed: {error}'
    rc = lib.cuInit(0)
    if rc:
        text = ctypes.c_char_p()
        lib.cuGetErrorString(rc, ctypes.byref(text))
        return f'{rc}: {(text.value or b"?").decode()}'
    count = ctypes.c_int()
    lib.cuDeviceGetCount(ctypes.byref(count))
    return f'ok count={count.value}'


def run(command):
    try:
        done = subprocess.run(command, capture_output=True, text=True, timeout=120)
        return {'rc': done.returncode, 'out': (done.stdout + done.stderr)[-600:]}
    except Exception as error:  # noqa: BLE001 - the probe reports every failure
        return {'rc': None, 'out': repr(error)}


def probe():
    return {
        'at': time.time(),
        'dev': sorted(name for name in os.listdir('/dev') if name.startswith('nvidia')),
        'nvml': nvml(),
        'cuInit': cuda(),
        'torch': run([sys.executable, '-c', TORCH]),
        'smi': run(['nvidia-smi', '-L']),
    }


if sys.argv[1:] == ['monitor']:
    log = open(f"/spike/monitor-{os.environ['SPIKE_LABEL']}.log", 'a', buffering=1)
    try:
        import torch
    except Exception as error:  # noqa: BLE001
        torch = None
        log.write(json.dumps({'importTorch': repr(error)}) + '\n')
    while True:
        record = probe()
        try:
            record['torchLive'] = str(torch.cuda.mem_get_info())
        except Exception as error:  # noqa: BLE001
            record['torchLive'] = f'{type(error).__name__}: {error}'[:600]
        log.write(json.dumps(record) + '\n')
        time.sleep(15)
else:
    print(json.dumps(probe()))

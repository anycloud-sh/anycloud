"""Run the MACE cold-start workload shared by profiling and GPU E2E tests."""

import json
import math
import os
import time


started_at = time.perf_counter()
run_id = os.environ["AC_TIMING_RUN_ID"]
hold_seconds = float(os.environ["AC_TIMING_HOLD_SECONDS"])


def mark(name: str, **extra: object) -> None:
    payload = {
        "name": name,
        "runId": run_id,
        "elapsed_s": round(time.perf_counter() - started_at, 3),
        **extra,
    }
    print("AC_TIMING " + json.dumps(payload, sort_keys=True), flush=True)


mark("process_start")

import torch

mark(
    "torch_imported",
    cuda_available=bool(torch.cuda.is_available()),
    cuda_device_count=int(torch.cuda.device_count()),
)

from ase import build
from mace.calculators import mace_off

device = "cuda" if torch.cuda.is_available() else "cpu"
mark("mace_imported", device=device)

calculator = mace_off(model="medium", device=device)
mark("calculator_ready", device=device)

atoms = build.molecule("H2O")
atoms.calc = calculator
energy = float(atoms.get_potential_energy())
if device == "cuda":
    torch.cuda.synchronize()
if not math.isfinite(energy):
    raise RuntimeError("MACE returned a non-finite energy")

mark("first_inference_done", device=device, energy=energy)
time.sleep(hold_seconds)
mark("hold_complete", hold_seconds=hold_seconds)

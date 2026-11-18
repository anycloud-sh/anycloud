"""Fresh CUDA work checked against immutable CPU references for the GPU pool receiver."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import threading
import time
import uuid
from pathlib import Path
from typing import Any

MODEL_NAME = "MACE-OFF23_medium.model"
REFERENCE_PATH = Path("/app/mace-references.json")
TOLERANCE_EV = 1e-5
# A canary Job is checked against its reference plus this offset, so it must
# error with the energy it computed (hosted-stage.ts MACE_CANARY_OFFSET_EV).
CANARY_OFFSET_EV = 1.0
# Explicit coordinates make the numerical reference independent of ASE's molecule catalog.
GEOMETRIES = {
    "a": [[0.0, 0.0, 0.0], [0.0, 0.757, 0.586], [0.0, -0.757, 0.586]],
    "b": [[0.0, 0.0, 0.0], [0.0, 0.797, 0.626], [0.0, -0.757, 0.586]],
}


def timing(name: str) -> None:
    """deployment.py's AC_TIMING mark."""
    print("AC_TIMING " + json.dumps(
        {"name": name, "epochMs": time.time_ns() // 1_000_000}, sort_keys=True
    ) + "\n", end="", flush=True)


def model_path() -> Path:
    from mace.tools.utils import get_cache_dir

    path = Path(get_cache_dir()) / MODEL_NAME
    if not path.is_file():
        raise RuntimeError(f"pinned image omitted cached model {MODEL_NAME}")
    return path


def fingerprint(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def fresh_energy(calculator: Any, geometry: str) -> float:
    from ase import Atoms

    # ASE can retain results even across new identical Atoms objects. reset()
    # clears calculator results/atoms without unloading MACE's torch models.
    calculator.reset()
    atoms = Atoms("OH2", positions=GEOMETRIES[geometry])
    atoms.calc = calculator
    energy = float(atoms.get_potential_energy())
    if not math.isfinite(energy):
        raise RuntimeError("MACE returned a non-finite energy")
    return energy


def build_references() -> None:
    from mace.calculators import mace_off

    path = model_path()
    calculator = mace_off(model=str(path), device="cpu", default_dtype="float64")
    references = {key: fresh_energy(calculator, key) for key in GEOMETRIES}
    if abs(references["a"] - references["b"]) <= 10 * TOLERANCE_EV:
        raise RuntimeError("reference geometries did not produce distinct energies")
    REFERENCE_PATH.write_text(
        json.dumps(
            {
                "modelSha256": fingerprint(path),
                "geometries": GEOMETRIES,
                "energies": references,
            },
            sort_keys=True,
        )
        + "\n"
    )


class MaceInference:
    """One CUDA model load per process; every Job gets a fresh, checked energy."""

    def __init__(self) -> None:
        import torch

        timing("torch_imported")
        from mace.calculators import mace_off

        if not torch.cuda.is_available() or torch.cuda.device_count() < 1:
            raise RuntimeError("MACE Deployment requires a visible CUDA device")
        path = model_path()
        self._reference = json.loads(REFERENCE_PATH.read_text())
        if self._reference["modelSha256"] != fingerprint(path):
            raise RuntimeError("cached model does not match immutable CPU references")
        if self._reference["geometries"] != GEOMETRIES:
            raise RuntimeError("CPU reference geometries differ from the workload")
        self._calculator = mace_off(
            model=str(path), device="cuda", default_dtype="float64"
        )
        if any(
            parameter.device.type != "cuda"
            for model in self._calculator.models
            for parameter in model.parameters()
        ):
            raise RuntimeError("MACE model parameters were not loaded on CUDA")
        torch.cuda.synchronize()
        timing("calculator_ready")
        # One checked energy before the receiver asks for Jobs, as the voice
        # profile warms up: a Job's energy is then never the first on the card.
        # Geometry b, since the first Job computes a.
        warm = fresh_energy(self._calculator, "b")
        torch.cuda.synchronize()
        if not abs(warm - self._reference["energies"]["b"]) <= TOLERANCE_EV:
            raise RuntimeError(f"MACE warm-up energy {warm!r} eV differs from its reference")
        timing("warm_inference_done")
        self._lock = threading.Lock()
        self._load_id = str(uuid.uuid4())
        self._sequence = 0
        self._torch = torch
        self._device = torch.cuda.get_device_name(0)
        self._canaries = set(
            filter(None, os.environ.get("E2E_MACE_CANARY_JOB_IDS", "").split(","))
        )

    def run(self, job: Any) -> dict[str, Any]:
        # Reservation waits, cancellation and lifecycle HTTP calls stay outside
        # this lock; only the shared calculator and its CUDA work are serialized.
        with self._lock:
            self._sequence += 1
            # Alternate geometries so consecutive Jobs can't pass on a cached result.
            geometry = "a" if self._sequence % 2 else "b"
            energy = fresh_energy(self._calculator, geometry)
            self._torch.cuda.synchronize()
            reference = self._reference["energies"][geometry]
            compared = reference + (
                CANARY_OFFSET_EV if job.id in self._canaries else 0.0
            )
            # Written so a NaN energy fails too.
            if not abs(energy - compared) <= TOLERANCE_EV:
                raise RuntimeError(
                    f"MACE {geometry} energy {energy!r} eV on {self._device}"
                    f" differs from reference {compared!r} eV"
                )
            return {
                "jobId": job.id,
                "executionId": str(job.selected.execution_id),
                "modelLoadId": self._load_id,
                "sequence": self._sequence,
                "geometry": geometry,
                "deviceName": self._device,
                "energyEv": energy,
                "referenceEnergyEv": reference,
            }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--build-references", action="store_true", required=True)
    parser.parse_args()
    build_references()

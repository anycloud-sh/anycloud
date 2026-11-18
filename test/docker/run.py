import argparse
import json
import time
import os
from pathlib import Path

import torch
from ase import build
from mace.calculators import mace_off

MOLECULES = ["H2O", "CH4", "NH3", "CO2", "C2H6", "H2", "O2", "N2", "CH3OH", "C2H4"]


def load_results(path: str) -> dict:
    if Path(path).exists():
        with open(path) as f:
            data = json.load(f)
        if "molecules" in data:
            return data["molecules"]
        return data
    return {}


def save_results(path: str, results: dict, run_label: str | None):
    tmp = path + ".tmp"
    if run_label:
        data = {"run_label": run_label, "molecules": results}
    else:
        data = results
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, path)


def parse_args():
    parser = argparse.ArgumentParser(description="Compute MACE-OFF energies for small molecules")
    parser.add_argument(
        "--pause", type=float, default=5.0,
        help="Seconds to pause between molecules (default: 5)",
    )
    parser.add_argument(
        "--save-dir", default=".",
        help="Directory to save results in (default: current directory)",
    )
    parser.add_argument(
        "--input-file",
        help="JSON file with list of molecule names (default: use hardcoded list)",
    )
    parser.add_argument(
        "--output-dir",
        help="Directory to write output results (in addition to save-dir)",
    )
    return parser.parse_args()


def main():
    """Minimal example script that computes energies with MACE-OFF23,
    saves results to a JSON file.

    Robust to pre-emption. Includes a pause time which can be used to simulate running a slow job.
    """
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"Using device: {device}")

    args = parse_args()
    save_dir = Path(args.save_dir)
    save_dir.mkdir(parents=True, exist_ok=True)
    results_file = str(save_dir / "results.json")
    pause_seconds = args.pause
    run_label = os.environ.get("ANYCLOUD_TEST_ENV")

    if args.input_file:
        with open(args.input_file) as f:
            molecules = json.load(f)
        print(f"Loaded {len(molecules)} molecules from {args.input_file}")
    else:
        molecules = MOLECULES

    output_file = None
    if args.output_dir:
        output_dir = Path(args.output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)
        output_file = str(output_dir / "results.json")

    results = load_results(results_file)
    msg = f"Loaded {len(results)}/{len(molecules)} existing results from {results_file}"
    print("*" * len(msg))
    print(msg)
    print("*" * len(msg))

    # Observability for CI diagnosis: surface what env the container saw,
    # what checkpoint state it loaded, and what work remains. Catches env
    # delivery regressions and /mnt/checkpoint contamination in one log read.
    print(f"[anycloud-test] ANYCLOUD_TEST_ENV={run_label!r}", flush=True)
    print(
        f"[anycloud-test] Loaded {len(results)} molecules from checkpoint: {sorted(results.keys())}",
        flush=True,
    )
    print(
        f"[anycloud-test] Remaining to compute: {[m for m in molecules if m not in results]}",
        flush=True,
    )

    remaining = [m for m in molecules if m not in results]
    if not remaining:
        print("All molecules already computed.")
        print(json.dumps(results, indent=2))
        return

    calc = mace_off(model="medium", device=device)

    for mol_name in remaining:
        atoms = build.molecule(mol_name)
        atoms.calc = calc
        energy = atoms.get_potential_energy()
        results[mol_name] = energy
        save_results(results_file, results, run_label)
        if output_file:
            save_results(output_file, results, run_label)
        print(f"{mol_name}: {energy:.6f} eV  (saved)")
        time.sleep(pause_seconds)

    print(f"\nAll {len(molecules)} molecules computed.")
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()

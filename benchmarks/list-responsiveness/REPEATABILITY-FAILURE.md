# Fixture-validation study v1: invalid run

Decision: **no usable timing evidence; no promotion**.

The first measurement run
used harness `8b52b6fa0d3b4c1849f1d41521724849775ee16d` and the frozen
`list-fixture-preflight-v1` protocol. GitHub reported disk exhaustion while its
runner was writing its own worker log: `No space left on device`. The measurement
step ran from 06:27:15 to 06:40:26 UTC on September 17, 2026, before the worker
failed. Its final retention and upload steps never ran.

Only the separate verification artifact survived. It records **10,174 passing
tests across 421 files**, successful `yarn verify`, and the unchanged six-second
integration gate passing with 3,700 workloads. The measurement job's logs, setup
memory observations, fixture fingerprints and request traces are unavailable.
The number and outcomes of executed A/A or A/B trials are unknown. No timing or
correctness result from that job can be reconstructed or counted as evidence.
The independent report correctly failed because its required artifact was absent.

## Demonstrated defect and correction

The runner retained a private full database after every trial and had no disk
admission check. Its best-effort filesystem cloning did not bound storage on a
host without clone support. The older retained mixed fixture is 649,355,264 bytes;
28 full copies of that size would occupy about 17 GiB before dependencies and
reports. The failed VM's exact disk composition and last completed trial are
unavailable, but GitHub's disk-exhaustion annotation is retained.

Version 2 checks disk capacity before preparation and every trial. Every live
trial still receives an independent copy. After all checks and child exit, a
large mixed/user copy must match the seed's exact bytes; only then can its closed
path share the seed's storage. Small correctness copies stay private and are
archived individually because hosted authentication legitimately configures
access-policy rows. Every raw database path remains available until successful
upload. A failed or changed copy stays private and stops the run. Capacity
admission reserves space for failures and publication instead of relying on an
`always()` step after the worker has already exhausted its disk.

The correction has regression coverage for accumulating ordinary copies,
independent live writes, changed bytes, sidecars, hosted policy setup and the
disk-admission boundary. Real HTTP checks retained 299 matching functional
responses across the baseline, candidate, scopes and storage modes; these are
not timing evidence. Readback now retains its failure log even when download
fails. The [v2 protocol](REPEATABILITY.md) uses fresh preparation and a complete
new sample under the approved harness-defect recovery rule. It does not resume
v1, replace a trial, infer a missing result or change an acceptance threshold.

## Retained failure record

The ignored directory
`.context/list-repeatability-followup-20260917T054806Z/` contains GitHub's
measurement/report annotations and job metadata, the available workflow-log ZIP,
the verification artifact, a source archive of v1 and the explicit invalid-run
receipt `ci-35189048550.json`. The original aggregation archive and inventory
still match their recorded hashes. This storage failure changes none of the
earlier measured decisions and provides no evidence about the candidate's speed.

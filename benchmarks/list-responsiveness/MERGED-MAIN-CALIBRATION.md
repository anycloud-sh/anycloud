# Merged-main calibration: no promotion

**B remains unqualified.** Both selected A/A cases completed with valid evidence,
but 30 of 78 intervals did not fit their calibration bands. No A/B qualification
ran and no implementation PR was created. C remains rejected. The
[original spike](RESULTS.md), [provisional qualification](QUALIFICATION.md) and
[native diagnosis](NATIVE-DIAGNOSIS.md) retain their original evidence and attribution.

## Frozen study

Actions run 34901951049
completed successfully on September 14, 2026. CI success verifies correctness,
accounting and artifact integrity; its timing decision is informational.

- Application for both A/A labels: the merge at
  `62ed9a28c`.
- Frozen harness and protocol:
  `8b7f1cd190564460d0af80e194e71e1bfa2386db`. Both built applications and native
  SQLite bindings matched. Permanent measurement performs no SQL rewriting.
- Each case used a fresh Ubuntu 24.04 VM, Node 22.14.0, two vCPUs and about
  7.75 GiB usable RAM. The matrix VM reported AMD EPYC 7763; the load VM reported
  EPYC 9V74. Comparisons stay within each case. No exclusive physical host or
  cold OS-cache claim is made.
- Six alternating pairs per case: exactly 24 trials, without additional
  repetitions. The matrix retained ten warmups and fifty observations per
  endpoint; load retained the full 30/60/90-second schedule, 10 Hz health,
  one-second health and fifteen-second work deadlines, and a twenty-second drain.

The unchanged policy thresholds only the geometric mean of paired timing ratios
and mean paired rate differences. It enumerates all 46,656 joint complete-pair
bootstrap draws, with pointwise 95% nearest-rank intervals. A/A requires every
timing interval inside [0.95, 1.05] and every rate interval inside [-1, +1]
percentage points. This separately authorized study is not pooled with older runs.

## Results

| Case                 | Complete trials | Passing gates | Inconclusive gates |
| -------------------- | --------------: | ------------: | -----------------: |
| IP-heavy user matrix |              12 |         22/30 |               8/30 |
| Mixed user load      |              12 |         26/48 |              22/48 |

All **6,000 matrix observations** completed within deadline. Nine of ten SQL
means and nine of ten HTTP medians calibrated; four of ten HTTP p95 metrics did.
The terminal-status control failed all three timing gates. All twelve trials
had identical builds and 32 identical captured query plans.

| Selected A/A metric         | Paired ratio | 95% interval   |
| --------------------------- | -----------: | -------------- |
| Ordinary limit 200 HTTP p95 |        0.930 | [0.815, 1.016] |
| Terminal status SQL mean    |        1.626 | [1.227, 2.148] |
| Terminal status HTTP p50    |        1.357 | [1.098, 1.690] |
| Terminal status HTTP p95    |        2.755 | [1.699, 4.401] |

These are identical-build comparisons, not B regressions. For ordinary limit
200 HTTP p95, the descriptive ratio of arm medians was 0.999; the prescribed
paired estimator above still failed calibration.

The mixed fixture matched **18,664 deployments, 1,994,751 events and 285,564 VMs**.
Its **9,216 offered requests** produced 7,013 timely completions, 1,792 work
request timeouts and 411 transport failures. There were no late successes,
scheduling/admission skips, truncated responses or unfinished requests.
All 411 transport failures reported `UND_ERR_CONNECT_TIMEOUT` at the client's
ten-second connection timeout; none reached an observed HTTP handler. Five work
timeouts also lacked an application observation. All observed handlers drained.
Peak client concurrency ranged from 59 to 65, below the 128-request cap.

During scheduled load, **12,896 of 21,600 health probes** missed the one-second
deadline. Eleven timing and eleven rate intervals failed calibration. In the
recorded final recovery window, all 861 work offers and 3,600 health probes were
timely, but three endpoint tail intervals still failed calibration. Remaining
health misses do not independently reject B.

The frozen recovery calculation uses recorded floating-point phase offsets.
Three nominal boundary offers fell about 1.5e-11 milliseconds below the cutoff;
all three were timely and remain in total-work accounting. The reported window
membership was not adjusted after measurement. This boundary behavior and the
unexplained tail variability remain qualification limitations.

## Evidence and verification

The independent local report matches CI's JSON and Markdown byte for byte.
Both downloaded case inventories passed: **640 files, 81,842,071 bytes**, including
328 complete gzip responses and 84 request/server/health journals. All three
artifact archives match GitHub's published SHA-256 digests. The 148 complete
A/A correctness responses matched, and every measured successful response was
checked against its complete snapshot. Full intervals, accounting, resources,
source/runtime fingerprints and archive hashes are in the
[machine-readable record](merged-main-calibration-summary.json).

Raw downloads, archives, CI logs, fixture manifests, plans and failure records
remain in the fresh ignored directory
`.context/list-merged-main-calibration-20260914T210712Z/`. CI artifacts expire
September 21; the checked local copies are retained. The frozen experiment's
`run.ts --report --input DIR --output NEW_DIR` independently validates downloads.

Preparation passed:

- Main versus the separate B-only prototype
  `2af8cd689`:
  150 complete HTTP responses, including current `workerId`, Worker and Cluster cases.
- `yarn verify`: 9,511 tests across 390 files in the corrected harness; eight
  existing lint warnings, zero lint errors. The evidence branch passed 9,457 tests
  after merging main. Both passed the unchanged six-second long-history gate
  with 3,700 deployments.
- Automatic preset: sixteen trials, 680 measured offers and 64 seconds of load
  traffic completed in 193.020 seconds under its 240-second command budget.
  Billing compatibility passed all four smoke cases. These are local diagnostics.
- Formatting, independent artifact roundtrips and expected rejection of a
  missing request journal and corrupt gzip response.

The first local smoke run exhausted its four-minute budget while the full test
suite competed for CPU; its partial evidence is retained. The quiet run used
fresh output without code or budget changes. GitHub also rejected the initial
workflow dispatch before creating a run because runner context was at job scope.
That placement was corrected with regression coverage before any CI timing
trials; the failed dispatch is retained.

## Delivery boundary

Main was merged into the evidence branch and pushed. The shared-runner adaptation,
study workflow and two-line B prototype remain separately reviewable; no product
implementation was merged, released or deployed. The evidence PR that
reviewed this work records this outcome.

The fresh VMs did not establish calibration under the fixed rules. Investigating
the remaining variability and deterministic recovery boundaries precedes any
new qualification. B still needs every required profile/scope/lane to pass
A/A and A/B, followed by qualification of its actual proposed merge. A provisional
negative result creates no implementation PR; the draft-PR final-qualification
path was never entered. Review permanent CI policy before promotion: the issue's
current daily/manual-only wording differs from the earlier approved automatic
list-smoke plan. Preserve these frozen records when removing temporary study code.

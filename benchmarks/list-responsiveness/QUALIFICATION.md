# B qualification: no promotion

**Decision: no promotion.** Every completed A/A case was inconclusive under the
frozen acceptance policy. The provisional run then hit its child watchdog in
the hosted/API mixed matrix, leaving the full comparison incomplete. No A/B
qualification stage ran, and no implementation PR was created.

This follow-up preserves the [original spike results](RESULTS.md), whose
measurements remain attributed to `02b2d81d8`. The original A/B/C screen is
historical; this attempt uses the fixed six-pair policy described below. C
remains rejected.

## Revisions and method

- Baseline: pin `7c45ca7ce`.
- Candidate and shared harness: `e89add119`,
  on `depombo/list-b-qualification`. Its only product changes are the two outer
  list-join predicates. There are no index, migration, dependency or public type
  changes.
- Runtime: Node 22.14.0, Darwin arm64, Apple M4, ten logical CPUs, 24 GiB RAM.
- Run: 2026-09-12 21:14:33–23:31:00 UTC, in isolated checkouts inside this workspace.
- Business clock, fixture copies, warmup, instrumentation and shared runner were
  identical across arms. Both arms loaded their actual built applications.
  Permanent measurement performed no SQL rewriting.
- The baseline PR was still open at `a60d4e99a` when checked on 2026-09-13. The approved
  provisional baseline stayed pinned to `7c45ca7ce`.

The shared runner documentation
contains the runnable commands, bounded CI workloads and complete policy.
Timing gates use the geometric mean of paired ratios; rates use mean paired
percentage-point differences. All 46,656 complete-pair bootstrap draws are
enumerated jointly across metrics, with pointwise 95% nearest-rank intervals.
A/A requires every timing interval within [0.95, 1.05] and every rate interval
within [-1, +1] percentage points. No repetitions or thresholds were changed
after inspecting results.

## Provisional observations

There were 151 complete performance trials out of 168 planned A/A trials, plus
one interrupted trial. Twelve cases completed all six pairs; none calibrated.

| Profile / lane              | User scope                | Hosted/API scope                                       |
| --------------------------- | ------------------------- | ------------------------------------------------------ |
| Sparse matrix               | Inconclusive: 12/30 gates | Inconclusive: 5/30 gates                               |
| Retry-heavy matrix          | Inconclusive: 9/30        | Inconclusive: 5/30                                     |
| IP-bearing-heavy matrix     | Inconclusive: 10/30       | Inconclusive: 10/30                                    |
| Event-depth matrix          | Inconclusive: 9/30        | Inconclusive: 10/30                                    |
| Outside-page-history matrix | Inconclusive: 8/30        | Inconclusive: 9/30                                     |
| Mixed matrix                | Inconclusive: 13/30       | Incomplete: seven complete trials; trial eight stopped |
| Mixed load                  | Inconclusive: 31/48       | Not run                                                |

Counts show intervals that failed to fit wholly inside their A/A calibration
bands. Overall, 131 of the 378 evaluated calibration gates were inconclusive.
These are calibration outcomes, not estimates of B's performance benefit.

The mixed fixture matched **18,664 deployments, 1,994,751 events and 285,564
VMs**. All 69,500 observations in completed matrix trials finished successfully
within the work deadline.

The twelve completed user-scope load trials offered 9,216 work requests: 9,175
succeeded, 31 timed out, seven had transport failures and three were skipped for
scheduling delay. There were no admission skips or unfinished requests in those
completed trials. The retained health summary includes endpoint warmup and drainage: 1,123 of
21,725 probes missed the one-second deadline. The calibration gates use their
individual scheduled phases and final recovery window. Every completed trial had zero observed handlers after
drainage. Transport causes and client/server correlation remain in the raw
traces; the seven transport failures carried `ETIMEDOUT`.

Remaining health misses do not independently reject B. The fixed calibration
intervals and the incomplete full run prevent promotion here.

## Watchdog and retained evidence

The baseline arm of hosted/API mixed-matrix pair four exceeded the
600,000-millisecond child watchdog. Its trace retains 205 measured offers:
204 successful responses and one unfinished request. The cause of the stalled
trial was not established by the retained logs. The run exited 1 with
`status: failed` and `qualification: invalid-evidence`. Its pending pair and the
unstarted hosted/API load case were not replaced with additional trials.

Raw measurements remain in the ignored
`.context/list-qualification/provisional-20260912-1/` directory. Original spike
measurements were preserved. An upload-style copy at
`.context/list-qualification/download-provisional-1/` contains only the five
allowed extensions: JSON, JSONL, compressed JSON, Markdown and logs.

All **3,098 files (356,579,478 bytes)** passed independent size/hash checks after
copying, including decoding all 1,605 gzip responses. The audit rechecked 92,965
request records from complete trials, 57,919 complete health observations,
server journals, response hashes, raw metrics and the twelve completed A/A
decisions. Full-comparison validation correctly rejected the incomplete copy;
the interrupted trace remains visibly unfinished.

The [machine-readable decision record](qualification-summary.json) includes
source/build/runtime/harness fingerprints, acceptance and inventory hashes,
case counts and failure accounting. Detailed audit output is retained at
`.context/list-qualification/provisional-audit.json`. There is no claim of cold
OS caches, Linux CI performance or final proposed-merge qualification.

## Implementation and verification

The shared runner now supports the list scenario, independent HTTP workload
children, retained accounting, the fixed acceptance manifest and checked
artifacts. The workflow adds one automatic list-smoke job with eight load
trials and 64 seconds of scheduled traffic, bounded setup/measurement and
reserved upload time. Manual cases retain the full protocol and six-pair
A/A-before-A/B gating. Uploads include JSONL and compressed responses, and
cleanup requires a successful upload. Timing outcomes remain informational;
correctness, isolation, accounting, completeness and artifact failures block.

Validation of the frozen candidate/harness passed:

- 75 HTTP correctness cases across both builds: 150 complete responses,
  including current `workerId` coverage and retained Worker/Cluster cases.
- 460 focused tests across eleven files.
- `yarn verify`: 9,173 tests across 373 files; eight existing lint warnings,
  zero lint errors.
- `yarn test:long-history-responsiveness`: 3,700 deployments with the existing
  six-second gate unchanged.
- The automatic preset through its CI budget wrapper: 16 trials completed in
  111.772 seconds. This local smoke result is diagnostic.
- Billing compatibility smoke, plus successful artifact roundtrip and expected
  rejection of a missing request trace and a corrupt gzip response.

The full manual run failed as recorded above; the passing code checks do not
turn that run into qualification evidence.

## Delivery boundary

An evidence PR records this
no-promotion outcome. The frozen qualification branch is available for review.
**A provisional negative result creates no implementation PR.** The later path
of a draft failing final qualification and closing unmerged was never entered.
No merge, release or deployment was performed.

Any future promotion attempt needs the watchdog cause and calibration
variability addressed through a documented study, with fresh complete evidence
under frozen rules. A demonstrated harness correction requires regression
coverage and fresh calibration/comparison. After provisional success, that baseline PR
must merge before preparing a separate draft implementation PR; that PR's
actual proposed merge and verified base then require full qualification.
Changes to the build, harness, fixture or base invalidate that qualification.

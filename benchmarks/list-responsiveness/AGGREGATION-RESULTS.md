# List aggregation experiment results

September 16, 2026. **No promotion.** The structural regression passes red →
green → red and complete public results are unchanged. A/A timing calibration
is inconclusive, so the frozen protocol stopped before candidate timing or full
qualification. The experimental query correction is retained for review.

## Reproduced cause and candidate

The real list HTTP path carries wide workload/spec fields through SQLite's VM
grouping sorter. The selected page was already bounded. Selecting its IDs,
aggregating VM inputs, then attaching the public projection reduces the width of
the intermediate records. The candidate changes only the two query shapes in
`WorkloadStore.listWorkloads`, in an isolated built checkout. It preserves the
aggregate expressions, provider fallback, existence checks and public behavior.
There is no B predicate, dependency, index, migration, API or type change.

All twelve fixture/scope/list cases failed the frozen work budget on the original
build, passed with the candidate, and failed again after reversal. Each temporary
insertion site producing more than twice the query's output row count must
average at most 192 serialized bytes. The maximum amplified-record average per
endpoint was 290–305 bytes originally and 45–53 bytes with the candidate.
Counters cover sorting,
ephemeral indexes and ephemeral tables; merely moving wide intermediates would
not pass.

Total temporary-record bytes fell by **77–81%**, across both ownership scopes.
The following are individual measured requests in user scope. MB means 1,000,000
bytes; these are work counters, not performance qualification timings.

| Fixture               | List path, limit 1000 | Original temporary MB | Candidate temporary MB | Original SQLite writes MB | Candidate SQLite writes MB |
| --------------------- | --------------------- | --------------------: | ---------------------: | ------------------------: | -------------------------: |
| Mixed                 | Ordinary              |                 39.75 |                   8.71 |                     18.77 |                          0 |
| Mixed                 | Terminatable          |                 18.56 |                   4.09 |                     17.15 |                          0 |
| IP-heavy              | Ordinary              |                 65.12 |                  15.01 |                     53.82 |                          0 |
| IP-heavy              | Terminatable          |                 30.96 |                   7.23 |                     28.97 |                          0 |
| IP-heavy plus history | Ordinary              |                122.78 |                  23.16 |                    105.09 |                          0 |
| IP-heavy plus history | Terminatable          |                 58.36 |                  11.16 |                     56.56 |                          0 |

Reversal exactly reproduced the original temporary-record bytes and SQLite VFS
read/write requests in every case. The observed `SorterInsert` PCs map to the
grouping operators in each statement's captured bytecode. VFS counters describe
SQLite's requested bytes, not physical disk activity or fsync. Instrumented
latencies remain diagnostic and are excluded from the timing decision.

## Correctness and fixtures

All three stages passed the same 37 user-scope and 38 API-scope correctness cases:
225 complete HTTP results, including expected authorization errors. Their bodies,
status and recorded public headers match. Coverage retains costs and IP-null
semantics, provider/credential/resubmission checks, limits, filters, owner
resolution, ordering/ties, current Deployment-ID filtering, Cluster/Deployment
targets and the wrong-key no-decryption oracle. The large-fixture stages add 90
HTTP observations, including first requests and daily-cost/status controls.

The retained mixed fixture still contains 18,664 workloads, 285,564 VMs and
1,994,751 events. IP-heavy contains 2,400 workloads, 281,801 VMs and 9,600 events.
Its depth control adds 279,400 ended IP-null attempts, for 561,201 VMs, while
requiring identical complete HTTP results. Every original seed is preserved.
Copies use the actual current migrations; hashes compare every pre-existing
column through the Workload/Anycloud Deployment renames. Integrity and foreign-key
checks pass.

## Timing decision

All six alternating A/A pairs completed, with ten warmups and 50 observations
per endpoint/trial. Both labels ran the same stock baseline build and native
module. **None of the twelve timing intervals fit [0.95, 1.05].** The protocol
therefore stopped before any unprofiled A/B trial. No repetition was added.

These are geometric means of paired ratios with pointwise 95% intervals from
all 46,656 joint complete-pair bootstrap draws, using nearest-rank quantiles.
Ratios below one in this table describe variation between identical builds;
they are not candidate gains.

| Endpoint                 | SQL mean ratio [95% interval] | HTTP p50 ratio [95% interval] | HTTP p95 ratio [95% interval] |
| ------------------------ | ----------------------------- | ----------------------------- | ----------------------------- |
| Ordinary, limit 1000     | 0.886 [0.673, 1.126]          | 0.907 [0.705, 1.109]          | 0.837 [0.575, 1.212]          |
| Terminatable, limit 1000 | 1.018 [0.817, 1.252]          | 0.962 [0.795, 1.135]          | 1.090 [0.736, 1.607]          |
| Daily cost               | 0.837 [0.603, 1.209]          | 0.825 [0.607, 1.093]          | 0.911 [0.537, 1.727]          |
| Terminal status          | 0.606 [0.408, 0.881]          | 0.683 [0.500, 0.923]          | 0.398 [0.198, 0.742]          |

All 2,400 measured calibration requests completed within 15 seconds. Complete
response equality, request accounting and handler drainage passed. Including
first requests and warmup, 2,077 of 8,786 health offers missed their one-second
deadline; three were late successful responses and still counted as misses.
Health, first requests, event-loop delay, CPU and memory remain diagnostic for
this discovery matrix. No load, recovery or full-profile qualification was run.
The complete protocol and promotion conditions are in [AGGREGATION.md](AGGREGATION.md).

The previous status-only A/A audit found identical builds, fixtures, schedules,
responses and query plans, with the declared alternating order. Code inspection
found the arm label used only as metadata in the application child and the same
warmup, clock and lifecycle paths. This does not explain the saved timing
asymmetry. That previous study is neither repeated nor regraded.

## Attribution and retained evidence

Application source: `913f8e992adbefd8d236d59fcec89f99dd788503`, version 0.1.64.
Node 22.14.0, better-sqlite3 11.10.0, SQLite 3.49.2, macOS Darwin 25.5.0, Apple M4
arm64, 24 GiB RAM. Both source trees have normal `yarn build` output. Reversal
restores the original source and reuses its byte-identical verified build.

Output: `.context/list-aggregation-20260916T220526Z`. `evidence/` contains the frozen
protocol and acceptance manifest, build/native/harness/fixture hashes, actual
candidate patch, migration receipts, SQL/plans/bytecode, request/server/health and
native JSONL, complete responses and seed databases as gzip, previous A/A audit,
structural work-budget reports, timing trials and decision records. Preparation
failures and successful verification logs are retained separately from evidence
used for decisions. Experimental execution used **25.31 of 30 minutes**:
6.48 minutes for structural/correctness stages and 18.83 minutes for the previous
A/A audit and new calibration. Preparation and repository checks are separate.

The 165 MB `list-aggregation-evidence.tar.gz` archive is retained in that ignored
output directory. Its independent extraction passed the archived standalone
verifier: **747 files, 36 complete trials, 3,207 HTTP requests and 9,597 health
observations**. The audit recomputed paired intervals and work budgets, decoded
gzip responses and fixtures, verified hashes and trace counts, and checked
complete cross-build responses and frozen harness hashes. Archive and inventory
SHA-256 values are in the committed [receipt](aggregation-receipt.json).

This is a local synthetic study on a shared development machine. It makes no
claim about cold OS caches, a dedicated host, production traffic, load recovery
or the untested full qualification matrix. A structural reduction alone cannot
establish the user-visible latency or control bounds required for promotion.

## Verification and disposition

Focused harness checks pass: 12 tests. The native preparation CLI independently
passes its record-count, VFS-I/O, reset and stock-response self-check.

The isolated candidate passes 325 of 326 existing list/store/spec tests. The
remaining test rejects any query-plan line beginning with `SCAN d`; the new plan
uses that alias for the already-selected page inside `list_vm_totals`. Its active,
legacy and pending-cleanup discovery still uses the required indexes. The failure
is retained in `candidate-focused.log`; the frozen candidate and existing guard
were not changed to turn it green. A future promotion would need a precise guard
that distinguishes this bounded intermediate from a scan of workload history.

Repository boundaries, normal build, lint, type checks, dead-export checks and
whole-checkout formatting pass. Knip initially mistook the isolation test's
deliberately blocked command for a dependency; its exact sentinel is now excluded.
The measured harness is unchanged.

A completely passing `yarn verify` run was not obtained. The full suite had
10,163 passing tests and one failure in an unchanged 150 ms shutdown/telemetry
test. One retry with the same default four-worker settings again had 10,163
passes, this time failing an unchanged process-group cleanup test with
`kill EPERM`. Both affected suites pass in isolation on the untouched baseline
(6 and 19 tests). The failures and rerun logs are retained; no tests or deadlines
were relaxed. All twelve new harness tests pass in both full runs.

The unchanged six-second responsiveness integration gate passes on both builds
with 3,700 workloads. These checks do not replace the failed timing calibration.
Independent artifact verification passes. Product source in the working branch
is unchanged. The original B and C decisions remain unchanged.

The smallest possible product follow-up would be this selected-ID/VM-total/final
projection change in the two list queries, together with a precise bounded-scan
regression. It remains conditional on a separately justified measurement setup,
complete six-profile/both-scope qualification, load/recovery protection and an
actual proposed-merge qualification. This completed study permits no additional
candidate or timing repetitions. No implementation PR is opened.

# Bounded list aggregation experiment

Status: complete; structural red/green/reversal passes, timing is inconclusive,
and there is no promotion. See [the measured result](AGGREGATION-RESULTS.md).
This is a separate query-shape experiment approved
September 16, 2026; prior B, driver and allocation decisions remain unchanged.

Baseline: `913f8e992adbefd8d236d59fcec89f99dd788503`, Node 22.14.0,
better-sqlite3 11.10.0 / SQLite 3.49.2. Pin source, build, lockfile, migration,
fixture, runtime and harness hashes in each fresh ignored output directory.
Use the current Workload/Deployment record model. Preserve original retained
seed files; migrate copies with the actual application's migrations and compare
every pre-existing column through the documented renames.

## Hypothesis and scope

The current list query limits its selected page before VM aggregation. Its wide
workload and container-spec projection still enters the VM join and GROUP BY.
Earlier native stacks observed temporary-sort writes without identifying the
individual spilling operator. Identify that operator on this build before
preparing one candidate: aggregate only VM fields for selected workload IDs,
then attach the public workload/spec projection once per result. Preserve every
aggregate expression, fallback/existence check, owner branch and selection rule.
Do not add B's IP predicate, an index, migration, dependency change or public API
change. Candidate source exists only in an isolated experimental checkout.

## Frozen discovery protocol

The initial execution budget is 1,800 seconds, accumulated across all HTTP and
native experimental children, including startup, warmup, drainage and analysis.
Preparation, fixture migration, builds, counter-unit tests and repository
verification are separate. A watchdog invalidates partial evidence; no additional
candidate, repetitions, or replacement timing run follows an observed outcome.
One demonstrated harness defect requires a recorded correction and regression;
it cannot silently replace evidence or reset the budget.

Use retained full mixed and IP-heavy seeds, plus an IP-heavy depth control formed
by adding 127 ended, IP-null placeholder attempts per existing hot workload.
These rows use already-present credentials, zero cost and earlier timestamps.
Require identical complete public responses between original and depth-control
fixtures; VM/event rows outside the selected page remain represented in the seeds.

For each fixture, both user and hosted/API scopes run the two limit-1000 list
paths and the daily-cost/status controls: one separate first request, zero
warmups and one observation per endpoint. The sequence is baseline observation,
one candidate observation if red reproduces, and baseline reversal. All observed
trials use the same instrumented native build. A separate small correctness
fixture retains all existing assertions and current Deployment-ID filtering.

The work-budget regression is fixed before observing results: every temporary
record insertion site that inserts more than twice the query's returned row count
must average at most **192 serialized bytes per record**. Count sorter writes,
ephemeral index writes and ephemeral table writes, so moving wide intermediate
rows to another temporary structure does not evade the test. The threshold
allows the fixture's ID and numeric VM aggregate inputs while excluding its
full public projection. Require a baseline failure and a candidate pass for
every nonempty deep list query, with the failure returning on reversal. Require
at least a 50% reduction in total temporary-record bytes for each original
fixture/scope/list endpoint. A plan string alone cannot pass this regression.

SQLite counters are inserted into a separate copy of the exact pinned native
source at the three record-write opcodes and VFS read/write boundaries. They
observe the real HTTP request's actual query, not rewritten/replayed SQL.
Record operator PCs, row/byte counts, maximum width, VFS requested bytes, actual
SQL/parameters, EXPLAIN bytecode and query plans. VFS byte counts describe SQLite
I/O requests, not physical disk traffic or fsync. Observer overhead makes these
timings diagnostic. The stock native module remains untouched and is required
for unprofiled comparisons. Do not force index selection or temporary storage.

## Conditional timing comparison

After structural red/green/reversal and complete correctness equality, evaluate
one discovery case: full mixed/user matrix, ordinary and terminatable limit 1000,
daily cost and cleaned-terminal status. Six alternating A/A pairs precede six
conditional A/B pairs, ten warmups and 50 observations per endpoint/trial. A/A
failure stops before A/B. Read the previous A/A traces and implementation for
label/setup/clock differences before starting this calibration; retain the audit
even if no defect can be demonstrated.

Use the approved geometric mean of within-pair ratios, all 46,656 complete-pair
joint bootstrap draws and nearest-rank pointwise two-sided 95% bounds. A/A
intervals for SQL mean and HTTP p50/p95 must fit [0.95, 1.05]. Both list SQL
upper bounds must be <= 0.90; every SQL/HTTP control upper bound must be <= 1.05.
The matrix requires all requests complete within their deadlines and all observed
handlers drained. Report CPU, memory, event-loop delay, health rates and first
requests separately. No cold OS cache claim.

Independent health offers remain 10 Hz with a one-second deadline, work deadlines
15 seconds, client cap 128 and drain 20 seconds. Late success counts as a miss;
retain offered/admitted/completed/skipped/unfinished work and transport causes.
No lifecycle services, provider operations, outbound networking or subprocesses
are permitted in application/driver children. Caught violations remain fatal.

This discovery case cannot qualify the product. Only discovery success permits
the separate full six-profile, both-scope matrix and mixed-load qualification
with all previously approved tail, completion, recovery and control gates. Full
qualification is outside the initial 30-minute execution budget and retains its
manual per-case budgets. A proposed merge needs its own final qualification.

## Run and delivery

Use Node 22.14.0 and this experiment's recorded harness revision. The retained
fixture root must contain `007-seed-mixed` and `048-seed-ip-heavy`, each with its
original `api.db` and `result.json`. The previous A/A artifact must contain the
twelve `calibration-{1..6}-{baseline,candidate}` directories from run
`35151522417`. Missing prerequisites are errors; the runner does not substitute
new fixtures or repeat the prior study.

Prepare a fresh directory and the exact baseline. Install the pinned dependencies
with `yarn install --frozen-lockfile` before these commands if necessary:

```sh
export AGGREGATION_OUTPUT="$PWD/.context/list-aggregation-NEW"
mkdir "$AGGREGATION_OUTPUT"
git worktree add --detach "$AGGREGATION_OUTPUT/baseline" 913f8e992adbefd8d236d59fcec89f99dd788503
ln -s "$PWD/node_modules" "$AGGREGATION_OUTPUT/baseline/node_modules"
yarn --cwd "$AGGREGATION_OUTPUT/baseline" build
node experiments/list-responsiveness/prepare-aggregation-native.mjs --output "$AGGREGATION_OUTPUT/native-driver"
node experiments/list-responsiveness/aggregation.mjs prepare \
  --output "$AGGREGATION_OUTPUT" \
  --baseline "$AGGREGATION_OUTPUT/baseline" \
  --native-package "$AGGREGATION_OUTPUT/native-driver" \
  --retained-root .context/list-full-3 \
  --aa-evidence .context/list-zod-only-20260916T210213Z/retained-35151522417/api-responsiveness-list-zod-only
```

The native preparer requires a working C/C++ toolchain and Node headers. It uses
the `node-gyp` bundled with npm; pass `--node-gyp /absolute/path/to/node-gyp.js`
for another installation layout. It copies and instruments the pinned package,
checks record counts and temporary I/O against the stock driver, and preserves
the installed module. `--check-only` validates an already-built copy. Native
checks are preparation, never timing observations.

Run the following stages in order, proceeding only when each records its required
gate in `state.json`. On macOS, prefix measured stages with `caffeinate -is` to
prevent host sleep. Avoid other builds or tests during measurement.

```sh
node experiments/list-responsiveness/aggregation.mjs observe-baseline --output "$AGGREGATION_OUTPUT"
node experiments/list-responsiveness/aggregation.mjs prepare-candidate --output "$AGGREGATION_OUTPUT"
node experiments/list-responsiveness/aggregation.mjs observe-candidate --output "$AGGREGATION_OUTPUT"
node experiments/list-responsiveness/aggregation.mjs observe-reversal --output "$AGGREGATION_OUTPUT"
node experiments/list-responsiveness/aggregation.mjs compare --output "$AGGREGATION_OUTPUT"
node experiments/list-responsiveness/aggregation.mjs finalize --output "$AGGREGATION_OUTPUT"
node experiments/list-responsiveness/aggregation.mjs verify --output "$AGGREGATION_OUTPUT/evidence"
```

`prepare-candidate` creates, formats and builds the one isolated source candidate.
Reversal removes its complete patch and reuses the verified, byte-identical
baseline build. `compare` audits prior A/A data and runs the fixed six pairs;
it never starts A/B after unsuccessful calibration. A child has a three-minute
watchdog, capped by the remaining execution budget. Failed trials retain their
database and incremental traces. Do not rerun or overwrite a completed stage.
`finalize` removes only successful prepared database copies, retaining gzip seeds
and inventory; run it after all permitted measurements. Verify a separately
extracted artifact as well as the local directory before publishing a decision.

The retained archive includes the frozen runner and its helper sources. Its
inventory can be verified without an application build or installed packages:

```sh
node "$AGGREGATION_OUTPUT/retained/evidence/source/experiments/list-responsiveness/aggregation.mjs" verify \
  --output "$AGGREGATION_OUTPUT/retained/evidence"
```

Keep the archive and the external [receipt](aggregation-receipt.json) together.
The receipt records its SHA-256 and the independently verified trial/trace counts.

Commands and exact fingerprints are retained with the result. The native
preparation CLI was added after observation to expose the same preparation and
self-check procedure; it is outside the frozen measurement harness. Temporary
helpers adapt the shared child manager,
HTTP driver, accounting and estimator from `ccffaabe2f9d11681c94d4bb8b769692f00797cc`;
the original source workspace and billing defaults remain unchanged.

Retain request/server/health/native JSONL, compressed complete responses,
plans, manifests, source/runtime hashes, errors and an independently checked
artifact inventory. Add focused observer, preservation, accounting, estimator and
artifact regressions; run formatting, `yarn verify` and the unchanged six-second
long-history integration gate. Publish a concise result and red/green/reversal
receipt, including unresolved HTTP qualification. No production implementation,
merge, release or deployment follows an inconclusive result.

Promote only after complete current-source qualification. After review, remove
the temporary native hooks and unused candidate; preserve immutable decisions,
regressions that remain useful, and original raw evidence.

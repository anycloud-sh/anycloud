# Native replay diagnosis

The four planned diagnostic trials completed using the exact retained databases.
Native stacks identify SQLite temporary-sort writes, and load traces locate long
delays before connection acceptance and HTTP parsing while the listener queue
fills. **B remains unqualified.** This baseline-only, profiled study supplements
the [earlier diagnosis](DIAGNOSIS.md); it does not replace the original
[qualification decision](QUALIFICATION.md) or [spike measurements](RESULTS.md).

## Observed results

Both labels ran the unchanged application built from
`7c45ca7cec5c379defd2430d2bb28d92bc8430b0`. Each case used one sequential pair,
with ten matrix warmups and 50 observations per endpoint, or the original
30/60/90-second load schedule. All four trials retained the original deadlines,
independent 10 Hz health probes, bounded drainage and complete response checks.

| Case / trial        | Work offers | Successful bodies | Timeouts | Transport errors | Successful HTTP p95 | Health misses / offers |
| ------------------- | ----------: | ----------------: | -------: | ---------------: | ------------------: | ---------------------: |
| IP-heavy matrix / 1 |         500 |               500 |        0 |                0 |          363.770 ms |                4 / 700 |
| IP-heavy matrix / 2 |         500 |               500 |        0 |                0 |          359.234 ms |                0 / 702 |
| Mixed load / 1      |         768 |               711 |       25 |               32 |        2,036.169 ms |            602 / 1,820 |
| Mixed load / 2      |         768 |               746 |       13 |                9 |        1,245.928 ms |            442 / 1,814 |

All **2,536 offers** were admitted. There were no scheduling or admission skips,
unexpected HTTP errors, truncated bodies, late successes or unfinished work.
All 38 timed-out requests were eventually observed and finished by the application.
The 41 transport failures reported `connect ETIMEDOUT`; none reached an observed
application handler. The separate correctness checks compared 148 complete
responses successfully, and paired measurement responses were equal.

Matrix p95 combines the ten equally sampled endpoints; individual endpoint
metrics remain in the raw reports and machine-readable summary. Health totals
include warmup and drainage. All work failures came from offers
during overload. The final 30 seconds of each recovery phase completed 72/72
work requests and 300/300 health probes within their deadlines. All observed
handlers drained. Work failure rates over the complete load trials were 7.422%
and 2.865%; their all-offer, deadline-penalized p95 values were 15,000 ms and
1,958.980 ms. These descriptive values are separate from the successful-response
quantiles above and are not qualification estimators.

## SQL and connection delays

The main-thread stack in the second IP-heavy trial includes this path during
the scheduled ordinary-list capture:

```text
Statement::JS_all → sqlite3_step → sqlite3VdbeExec
  → vdbeSorterFlushPMA → vdbeSorterListToPMA → unixWrite → pwrite
```

Actual query plans retain `idx_vms_deployment_id` and temporary B-trees for
grouping and ordering. The stack establishes temporary-sort file I/O in the list
path, consistent with SQLite's documented use of temporary storage for
[sorting and grouping](https://www.sqlite.org/tempfiles.html#transient_indices).
It does not identify which individual grouping or ordering stage spilled.

In that trial, request 478's terminatable-list SQL took **465.708 ms**, with
203.317 ms of directly measured process CPU. The enclosing native observation
window was 519.018 ms, with 248.525 ms of CPU, 30,392,320 bytes read,
31,928,320 bytes written, and zero process page-ins. The wider window includes
nearby work; its counters are not exact per-query I/O attribution. Aggregate
stack captures also cannot establish the cause of every earlier SQL outlier,
including the previous study's 2,664-ms pause.

During load, the API listener's accept queue reached its recorded limit of
**128 connections**. It was full in 432/1,712 native snapshots in trial one and
261/1,695 in trial two. These are sampled counts, not continuous occupancy
durations. Peak client work in flight was only 37 and 24, below the 128-request
client cap; client admission limits did not bound the server's connection queue.

Two examples show where timed-out requests waited:

| Trial / request | Endpoint        | Client write → HTTP parse | Handler duration |
| --------------- | --------------- | ------------------------: | ---------------: |
| Load 1 / 153    | Daily cost      |             52,041.126 ms |       106.796 ms |
| Load 2 / 244    | Terminal status |             27,891.399 ms |         2.194 ms |

For request 153, runtime socket acceptance occurred about 51.805 seconds after
the client write. Approximately 49.206 seconds of synchronous SQL overlapped
the wait before its application callback. The enclosing 52.058-second native
window recorded 45.321 seconds of API process CPU. This locates a backlog while
the API services other synchronous work; the delay is not explained by that
request's own short handler.

Correlation uses unique request IDs and matching socket ports when available.
Node omitted the server's remote port for 28 timed-out peers; unique IDs still
matched their sole client writes to HTTP parsing. The analyzer now retains those
observations, rejects ambiguous or contradictory matches, and preserves missing
ports explicitly. Its preliminary analysis had omitted these 28 timings. That
analysis correction has regression coverage and uses the same four raw trials.

## Reproduction and evidence

The native replay entrypoint and instructions
are committed and pushed at `1ae3c152203cbc80ffc39a7898f57fa67544b927`, in the
separate diagnostic checkout. The retained-input manifest requires both arms'
source and build fingerprints to match the baseline. It hashes the closed seed
databases before and after execution, copies them before normal migration
preparation, and checks their logical contents. No original database is opened
for mutation. The mixed database retains 18,664 deployments, 1,994,751 events and
285,564 VMs; the IP-heavy database retains 2,400 deployments and 281,801 VMs.

Run the analyzer in this evidence checkout with:

```sh
node experiments/list-responsiveness/analyze-native.mjs \
  --input .context/list-native-diagnosis-2 \
  --output .context/NEW_NATIVE_ANALYSIS_DIRECTORY
```

Execution ran on **2026-09-14, 17:20:02–17:30:02 UTC**, on macOS 26.5, an Apple
M4 with ten logical CPUs and 24 GiB RAM, using Node 22.14.0. Each command ran
under `caffeinate -is` on AC power. No competing build or benchmark was started
by this study. Recorded power logs contain no sleep/wake events during execution;
parent and driver sampling had no gaps over two seconds during measured work.
The 30-second preflight's aggregate CPU idle median was 81.407%. This is neither
a dedicated-host guarantee nor evidence of cold OS caches.

Raw output remains in `.context/list-native-diagnosis-2/`, including the frozen
plan, exact input manifests, actual SQL/plans, request/server/health journals,
compressed bodies, native counters and stacks, capability failures, execution
state, analyses and verification logs. Original spike and qualification outputs
remain intact. The canonical native analysis is `analysis-3/analysis.json`;
earlier analysis attempts are retained separately.

An independent audit of an upload-style copy validated **386 inventoried files
(84,476,545 bytes)**, including 178 decoded compressed responses, 40 process
diagnostic journals, 12 native journals and six native stack captures. It
rechecked complete response pairs, accounting, lifecycle, hashes and required
captures. The copy remains under `download/`. Original database and baseline
build hashes still match. The [machine-readable summary](native-diagnosis-summary.json)
records plan, source, build, harness, analyzer, input and inventory fingerprints.

Native observers sampled at 100 ms; scheduled stack captures sampled at 20 ms
for up to 20 seconds. Profiling and synchronous journals affect timing. Kernel
scheduler tracing and packet capture were unavailable under this host's
permissions, and Instruments was not installed. The evidence therefore cannot
separate every kernel wait, scheduling delay or retransmission, or transfer
these profiled timings to production or unprofiled qualification.

## Verification and decision

The four GCP catalog test failures were corrected separately in
`47a69f155d14b5fe52314169aa4b3f01fa808fcf`. The tests now derive compatible zones
from the published catalog and check failover across every available zone. They
preserve the real catalog boundary; no catalog or production behavior changed.
All 66 focused catalog/optimizer tests passed.

The frozen native checkout passed `yarn verify` with **9,180 tests**, eight
existing lint warnings and zero lint errors. Its long-history integration check
passed with the six-second gate unchanged. Focused native/shared-runner checks
passed 47 tests, fixed-protocol checks passed 39, and the evidence analyzers
passed 11. Coverage includes retained-input identity, native counters and complete
captures, isolation/accounting failures, missing artifacts, Mach CPU units,
ambiguous request correlation, missing peer ports, late successes and skips.

The evidence checkout passed `yarn verify` with **9,177 tests in 375 files**,
eight existing lint warnings and zero lint errors. One earlier run encountered
`kill EPERM` during cleanup in an existing canary RPC test. Its 14-test file
passed in isolation, and the complete suite then passed without changing that
helper. Both logs remain available; the intermittent cleanup error's cause is
not established.

The evidence checkout's long-history check also passed for 3,700 deployments
with the six-second gate unchanged. Its final error-log scan initially skipped
because `rg` was unavailable. The scan now uses the same `grep -E` expression
as the shared runner; shell syntax and the complete integration check passed
after that portability correction. It does not change list qualification's
application, traffic, accounting or acceptance rules.

**Recommendation: retain no promotion.** The retained A/A qualification remains
inconclusive and incomplete. This study identifies real SQL and queueing costs,
but establishes no defect in the original qualification harness whose correction
would justify replacing that evidence. Catalog assertions and diagnostic
correlation do not change qualification's measured application or workload.
There is consequently no fresh qualification run or implementation PR from this
study. Health misses alone are not the rejection criterion.

A further product optimization of sorting, aggregation or event-loop ownership
would require a separately scoped experiment. B's two outer-join predicates
remain the smallest candidate within the approved B-only scope. Promotion still
requires the unchanged full six-pair A/A→A/B protocol, followed by actual
proposed-merge qualification after the identity PR merges. Its approved baseline
pin remains `7c45ca7cec5c379defd2430d2bb28d92bc8430b0`; the identity PR was still
open when checked on September 14. No production query, index, migration, API or type changed in this
diagnosis, and no implementation was merged, released or deployed.

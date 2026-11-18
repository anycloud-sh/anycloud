# List qualification blocker diagnosis

The interrupted watchdog trial is explained by macOS sleep. The earlier A/A
calibration failures and load timeouts are separate problems: they occurred
before the sleep. B remains unqualified under the unchanged acceptance rules.
This study preserves the [qualification decision](QUALIFICATION.md) and the
[original spike results](RESULTS.md).

## Watchdog: host suspension

The interrupted hosted/API mixed-matrix trial has a 913,464.825-millisecond gap
between independent health offers, from **2026-09-12 23:15:47.297 UTC** to
**23:31:00.762 UTC**. These wall times use the shared phase marker to align the
retained parent and driver clocks; they are not inferred from the report's
start time.

The retained `pmset -g log` output records clamshell sleep at 16:01:40 PDT,
a dark wake at 16:15:00, maintenance sleep at 16:15:45 for 915 seconds, and
another dark wake at 16:31:00. The long health gap aligns with that second
sleep interval. The benchmark's idle-sleep assertion was present; it did not
prevent lid-triggered or maintenance sleep.

The watchdog correctly invalidated the incomplete run. Its elapsed time is
not evidence of an API handler deadlock. The appropriate operational correction
is an awake measurement host that will remain available throughout the run.
Increasing the watchdog or accepting the interrupted trial would not repair
the evidence.

## Retained calibration evidence

Eleven complete matrix cases evaluated 330 timing gates. Of the 100 intervals
that did not fit the fixed A/A band, 71 were HTTP p95, 16 HTTP p50, and 13 SQL
mean. All four completed retry-heavy primary SQL gates calibrated. The mixed
user ordinary-list SQL gate did not calibrate; the corresponding terminatable
SQL gate did.

The failures therefore cannot be described as uniformly unstable SQL. Fast
control requests also varied: in the first two IP-heavy/user pairs, terminal
status p95 changed from 1.457 to 3.960 milliseconds and from 1.493 to 4.279
milliseconds in chronological order. Other cases favored the second process,
so alternating order did not reveal one consistent direction of drift.

With 50 observations, the specified nearest-rank p95 is the 48th ordered
value, or third largest. A few delayed observations can move it substantially.
This is a description of the retained sample, not a replacement estimator,
an adjusted threshold, or a reason to discard slow requests.

## Retained load evidence

All 31 work timeouts had zero received bytes and no response headers. Every
one was eventually observed and completed by the application. Aligning the
independent clocks with bounds from successful round trips places application
receipt after the client's 15-second deadline, approximately 15.47–19.64 seconds
after offer. The clock-offset bounds are about 2.04–2.19 milliseconds wide.

For example, trial 161's ordinary-list request 175 reached the application
16.225–16.228 seconds after offer and spent about 572 milliseconds in its
handler. Request 179, a terminal status, arrived 17.538–17.540 seconds after
offer and spent about 3 milliseconds in its handler. Short handler durations
do not establish that a response was available before the client timed out.

The seven `ETIMEDOUT` transport failures had no application observations.
Historical traces cannot distinguish client connection queuing, TCP behavior,
or server acceptance and parsing before the application callback. They contain
no GC observations; missing GC data is not evidence of zero GC activity.

## New diagnostic observations

All **20 planned trials** completed on 2026-09-13, 23:11:41–23:31:06 UTC.
All 10,536 measured work requests succeeded within their deadlines. The
separate correctness checks compared 298 complete responses successfully.

| Case                 | Trials | Measured work offers | Recorded health offers | Health misses |
| -------------------- | -----: | -------------------: | ---------------------: | ------------: |
| Sparse/user matrix   |      6 |                3,000 |                    379 |             0 |
| IP-heavy/user matrix |      6 |                3,000 |                  3,651 |            56 |
| Mixed/API matrix     |      6 |                3,000 |                  2,016 |             0 |
| Mixed/user load      |      2 |                1,536 |                  3,628 |             0 |

Health counts include each performance trial's warmup and drainage. All work
was admitted, with zero skips, timeouts, transport failures, late successes or
unfinished requests. Every trial drained its observed handlers. There were no
parent or driver heartbeat gaps exceeding two seconds. The mixed fixtures' 4–6.3-second
API heartbeat gaps occurred during preparation, before the first HTTP request.

Fast-control variation persisted. Across the six trials per matrix case,
terminal-status HTTP p95 ranged from **0.997–1.638 ms** for sparse,
**2.434–6.024 ms** for IP-heavy, and **2.645–3.957 ms** for mixed/API. These are
descriptive ranges, not qualification estimators. In the first sparse trial,
request 598 took 2.771 ms, including 1.312 ms overlapping API GC, while its
SQL took 0.331 ms. Other outliers had no overlapping GC. Removing GC-overlapping
requests would change the sample and is not an acceptable qualification fix.

One IP-heavy ordinary-list request had **2,664.451 ms of synchronous SQL**
within a 2,678.547-ms HTTP response, with only 2.111 ms overlapping API GC.
The enclosing 2,974.740-ms process-sample interval used **593.771 ms of CPU**.
Most of the elapsed interval was therefore waiting or descheduling, rather
than recorded process CPU work. The exact native/OS cause is unresolved.
This was `010-ip-heavy-user-matrix-comparison-2-candidate`, request 191;
despite its arm label, it ran the baseline application. All 56 health misses
occurred in that trial. Aggregate host CPU idle medians ranged from 73–86%
across trials; aggregate idle capacity does not establish that an individual
process was scheduled promptly or exclude memory/I/O waits.

The load pair completed 768/768 work requests each, with HTTP p95 of
**342.926 ms** and **208.888 ms**. Both recorded zero health misses. The original
15-second work timeouts and `ETIMEDOUT` failures did **not** reproduce. Shorter
delays before application receipt did: trial one's terminal-status request 84
took 709.665 ms; Undici reported writing the request after 0.786 ms, application
receipt occurred after 706.837 ms, and its handler took 2.519 ms. This locates
that observed wait after the client write and before the application callback;
it does not identify the narrower kernel/acceptance/scheduling cause or prove
the cause of the historical timeouts.

The application build hash matches the original baseline. These diagnostic
fixtures were freshly seeded with the unchanged generator; their counts,
business time and VM distribution match the retained fixtures. Fresh encrypted
fixture fields make their full logical hashes differ. Both arms used identical
copies within each case, and all five mixed-load complete-response hashes match
the original baseline's corresponding snapshots. This was not a replay of the
original database bytes or a controlled comparison against yesterday's timings.

## Diagnostic method and reproducibility

The separate diagnostic plan was frozen before measurement. Both arms use the
unchanged built baseline `7c45ca7cec5c379defd2430d2bb28d92bc8430b0`.
The shared runner's diagnostic extension and instructions
are committed at `ad084905dfaf9ef242d9252a096e81e92454bb5f`, above the frozen qualification
harness. It changes no production source or acceptance rule.

The plan schedules three alternating pairs each for sparse/user matrix,
IP-heavy/user matrix, and mixed/API matrix, followed by one mixed/user load
pair. Matrix trials retain ten warmups and 50 observations per endpoint. Load
trials retain the 30/60/90-second arrival schedule, independent 10 Hz health
probes, original deadlines, and bounded drain. A case failure stops the plan;
no retries or additional qualification repetitions are permitted.

The opt-in `--diagnostics` flag records API, HTTP driver, and parent process
identities and real clock origins, IPC milestones, GC events, CPU, memory,
event-loop samples, host CPU counters, and Undici connection/request milestones.
It rejects the six-pair qualification protocol before preparation. Probe I/O
and observers can affect timing, so these runs cannot qualify B. Temporal GC
overlap is correlation, not proof of causation.

From the diagnostic checkout, a case is runnable with:

```sh
caffeinate -i node benchmarks/api-responsiveness.mjs \
  --scenario list --diagnostics --profile sparse --scope user --lane matrix \
  --repetitions 3 --timeout-ms 600000 --run-timeout-ms 1200000 \
  --base-dir /absolute/path/to/frozen-baseline \
  --candidate-dir /absolute/path/to/frozen-baseline \
  --output /absolute/path/to/fresh-diagnostic-output
```

Analyze a retained list run from this evidence checkout with:

```sh
node experiments/list-responsiveness/analyze-diagnostics.mjs \
  --input .context/list-qualification/provisional-20260912-1 \
  --output .context/NEW_ANALYSIS_DIRECTORY
```

The analyzer records source/report hashes, preserves the original qualification
status, and validates network correlation against request order, paths, and
creation intervals when diagnostic events are available. It never reclassifies
the original gates or combines diagnostic trials with qualification trials.

Raw diagnostic output, the frozen plan, power logs, checks, and execution state
are retained separately in `.context/list-blocker-diagnosis-1/`. The plan's
SHA-256 is `52475732343e16d2ea7bf864e4835c73c7a0130c602af3c3302df22cadd1a1fd`.

An independent read of an upload-style copy validated all **988 inventoried
files (82,564,276 bytes)**, including 488 decoded compressed responses and 132
process journals. It rechecked hashes, request accounting, health/server
observations, response equality, lifecycle, metrics and all complete pairs.
The copy remains in `.context/list-blocker-diagnosis-1/download/`; originals
remain intact. The [machine-readable summary](diagnosis-summary.json) records
the source, build, harness, analyzer, plan and per-case inventory fingerprints.

## Verification and next action

The diagnostic runner passed 44 focused tests; the retained-evidence analyzer
passed six. Coverage includes real-clock preservation, process/watchdog
journals, the actual CLI, missing diagnostics, ambiguous network correlation,
late responses, and a timeout preceding application receipt. A diagnostic flag
wiring error was caught in the development pilot and covered by the real-CLI
regression before timing collection. It did not affect the original evidence.

`yarn test:long-history-responsiveness` passed with the existing six-second
gate unchanged. The diagnostic checkout's `yarn verify` passed build,
boundaries, types, lint and formatting, then reported four existing GCP catalog
test failures (9,169 tests passed). The same four failures reproduce on the
untouched pinned baseline: the cached published catalog includes zone
`us-central1-c`, while those assertions expect only `b` and `f`. Synthetic
measurement children use separate directories and seeded prices.

The evidence checkout's final `yarn verify` also passed build, boundaries,
types, lint and formatting, with **9,168 tests passing and the same four
catalog failures**. Both checkouts reported eight existing lint warnings and
zero lint errors. The cached catalog SHA-256 is
`aa05100a716789412b3aae04bb74019c74aee07fd1557bfb5c9c8e065673a0e0`.
The catalog assertions were left unchanged.

**Recommendation: retain no promotion.** The watchdog has an environmental
explanation. The calibration study identifies GC-related tails and an outlier
dominated by time off CPU, but does not establish a product or measurement
correctness defect that would justify a production fix. Historical transport
timeouts remain unlocalized beyond their pre-application delay.

The next bounded study should use an awake, otherwise quiet host and the
retained seed database, with native stack/scheduler and memory/I/O observations
around long SQL intervals and connection/acceptance tracing around delayed
requests. Freeze its workload and counts before execution. Use that evidence
to address a demonstrated cause; keep GC probes and profiling out of subsequent
qualification. Fresh qualification must still pass the unchanged full six-pair
A/A→A/B protocol. No extra repetitions, relaxed gates, implementation PR,
promotion, merge, release or deployment are part of this diagnosis.

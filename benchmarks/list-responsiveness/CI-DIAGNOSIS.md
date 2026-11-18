# Linux CI diagnosis: no promotion

**B remains unqualified.** Four profiled baseline trials located load delays at
the synchronous database work and listener backlog, but did not reproduce or
explain the terminal-status variation from the
[six-pair calibration](MERGED-MAIN-CALIBRATION.md). No new A/A calibration or A/B
qualification followed. The acceptance rules are unchanged; C remains rejected.

- Measured application: the identity PR's merge,
  `62ed9a28c`,
  for both labels, with identical builds and native SQLite bindings.
- Measured harness and frozen protocol:
  `f524cb0feee1ced32780cb0011a61a5533793de4`.
- Diagnostic run 34909892717:
  one fresh Ubuntu 24.04 GitHub-hosted VM, Node 22.14.0, two AMD EPYC 9V74 vCPUs,
  8,323,973,120 bytes of RAM. Measurement took **734.893 seconds**, within the
  approved thirty-minute cap.
- Scope: one IP-heavy user matrix pair, then one full mixed user load pair.
  Both baseline/candidate labels are A. These profiled observations are
  diagnostic, not qualification or a cross-machine timing baseline.

## Verification failure discovered after download

The diagnostic run's green job status was wrong. `yarn verify` ran out of Node
heap in ESLint and exited **134**, after boundaries and build passed. The shell
pipeline returned `tee`'s successful status, allowing measurement to proceed.
The independent report had the same failure-propagation weakness. Its validator
checked data integrity but did not require successful verification evidence.
The earlier progress claim that verification passed was incorrect.

Preserve the four trials as diagnostic evidence with a **failed verification
precondition**. The unchanged six-second long-history gate did pass, but it does
not replace full verification. It recorded sixteen one-second health misses
among thirty-two probes; none exceeded the existing six-second threshold.

The separate correction
selects Bash explicitly, so failures propagate through every diagnostic logging
pipeline. It records actual check exit statuses, source/run identities and log
hashes. Preflight, measurement and independent download validation require both
successful checks and their unchanged logs. A failed or cancelled first check
cannot authorize measurement. Executable regressions exercise failed checks,
failed artifact validation and missing, changed or mismatched receipts.

Only full verification receives a 4 GiB Node old-space limit.
The measurement and integration environments retain their original limits.
A separate verification-only dispatch on the normal repository CI backend
checks the corrected frozen source without collecting additional performance trials. Its outcome is recorded below; it
cannot retroactively satisfy the first run's before-measurement requirement.

## Diagnostic findings

Both matrix trials completed all **500 observations**, with ten warmups and
fifty observations for each of the eight list cases and two controls. All
1,000 measured responses matched their complete snapshots.

| Terminal-status control | First A | Second A |
| ----------------------- | ------: | -------: |
| Mean synchronous SQL ms |   2.611 |    2.618 |
| HTTP p50 ms             |   7.050 |    6.703 |
| HTTP p95 ms             |  14.890 |   13.971 |
| Requests overlapping GC |       0 |        0 |

These fifty-request summaries do not explain the previously observed
candidate-labelled p95 spikes. The SQL definitions and query plans remained
identical. No defensible change to the control or its warmup follows from this
single instrumented pair.

The mixed fixture retained **18,664 deployments, 1,994,751 events and 285,564 VMs**.
Each load trial offered 768 requests over the full 30/60/90-second schedule.

| Mixed user load                             | First A | Second A |
| ------------------------------------------- | ------: | -------: |
| Timely work completions                     |     624 |      619 |
| Work deadline timeouts                      |     125 |      124 |
| Connection timeouts                         |      19 |       25 |
| Scheduled health misses / 1,800             |     910 |      943 |
| Peak admitted client requests / cap 128     |      54 |       49 |
| Largest observed listener queue / cap 511   |     513 |      513 |
| Listener samples at or above capacity       |      25 |       27 |
| Final thirty seconds: timely work / offered |   72/72 |    72/72 |
| Final thirty seconds: health misses / 300   |   0/300 |    0/300 |

Every offered work request was admitted. There were no scheduling/admission
skips, late successes, HTTP status errors, truncated bodies or unfinished
requests. All observed handlers drained. Twelve extra health offers per trial
during the bounded drain were timely; the table uses the 1,800 scheduled probes.

All **249 work deadline timeouts** had written HTTP headers and eventually reached
an observed handler. The longest measured offer-to-handler waits were 55.317 and
55.554 seconds, long after the fifteen-second client deadline. The **44 connection
timeouts** reported `UND_ERR_CONNECT_TIMEOUT`; they wrote no HTTP headers and
had no application observation. They remain distinct from work deadline failures.

The listener's own port reached capacity during overload. Host TCP counters rose
by 2,027/2,128 listen overflows and 1,564/1,682 SYN retransmissions. Those host
counters are supporting evidence, not a per-request packet trace. Together with
the correlated request records, they locate a real backlog before HTTP handling;
the client's outstanding-request cap does not bound that backlog.

The API CPU profiles were dominated by synchronous database execution. For the
five-endpoint rotation, the observed mean SQL times imply **1.251/1.288 seconds
of synchronous SQL demand per second** at eight requests/sec. This descriptive
calculation includes the profiled cost and is not a production capacity estimate.
It supports overload as the explanation for accumulating work and connection
delays. The HTTP driver spent most profile samples idle. Increasing client
deadlines, listener capacity or changing health traffic would change the experiment
without fixing the calibration problem, so those settings remain unchanged.

Linux syscall snapshots returned `EPERM`; wait-channel and CPU samples remained
available. The evidence contains no full native SQLite stack, kernel scheduling
trace or packet capture. CPU profiles include setup/warmup and cannot establish
unprofiled timing improvements. No cold OS-cache or exclusive physical-host claim
is made.

## Recovery correction and evidence integrity

The driver now retains the nominal phase offset before adding the absolute clock
origin. At the previously failing origin, subtraction produced
`59999.999999999985` ms for a nominal `60000` ms arrival. Tests cover the actual
failed origin and three others, including admitted and skipped work, and verify
all seventy-two final-window offers. Restoring the old arithmetic makes the
regression fail. The previous published recovery counts are unchanged.

The original frozen validator passes data integrity locally: **380 inventoried
files, 431,452,855 bytes**, including 178 gzip responses, 57 JSONL journals and
fifteen CPU profiles. Twelve profiles belong to the four trials; three belong
to the short collector lifecycle check. The 148 complete user-scope correctness
responses matched, including current `workerId`, Worker/Cluster and secret
projection checks. Every successful measured response matched its full snapshot.

Both original ZIP archives match GitHub's published SHA-256 digests. All 383
files in the main archive match the extracted copies. Inventories omit their
own hashes; the archive supplies that outer integrity check. The corrected
verification validator rejects the original evidence's missing receipts as
expected. Data-integrity success does not erase the failed verification.

Raw downloads, archives, profiles, incremental request/server/health traces,
SQL/plans, fixture manifests, source/runtime fingerprints, analysis and failures
remain in `.context/list-ci-diagnosis-20260914T231312Z/`. Artifacts expire seven
days after upload; the checked local copies are retained. Exact values and
fingerprints are in [the machine-readable record](ci-diagnosis-summary.json).

## Checks and delivery

Verification-only run 34913186117
passed on the ordinary CI backend at frozen correction `72e5dc2b9`:

- `yarn verify`: **9,549 tests across 392 files**, all passing; 308.55 seconds
  for the complete command, including build, boundaries, lint and formatting.
- `yarn test:long-history-responsiveness`: passed for 3,700 deployments in
  32.77 seconds. Sixteen of thirty-three probes missed one second; none missed
  the unchanged six-second integration threshold.
- Both check receipts record exit zero and the expected source/run identity.
  Independent CI download validation and local log/hash validation passed.
  Both ZIP archives match GitHub's digests and all extracted files.

The unchanged typed-lint test passed on this backend. Its two-vCPU timeout
remains a limitation; no fixture or timeout was changed. These successful checks
qualify the corrected source for review, not the earlier performance data or B.

Focused checks on the correction passed **71 tests** across three files, plus
ESLint and formatting. The subsequent workflow-policy correction passed 52 tests
across two files, with lint and formatting. The first verification-only run,
34912062047,
correctly failed after 9,547 tests passed and two failed. One exposed my omission
of the new checks job from the workflow-policy test; that mapping is corrected.
The other was the unchanged typed-lint fixture exceeding thirty seconds on the
two-vCPU VM. Its assertions and deadline remain intact; separate verification
uses the ordinary CI backend. The failed receipt was independently downloaded
and correctly rejected, and integration was skipped. Earlier local failures remain recorded: a corrected
missing `ss` declaration, an unrelated process-cleanup `EPERM`, and an ESLint
fixture timeout on a loaded Mac. No test timeout, six-second integration gate,
acceptance threshold or sample size was relaxed.

The rounding and verification defects are corrected in separately reviewable
experimental code. They do not explain the remaining unprofiled control
variation. The approved stopping rule therefore retains the documented
no-promotion outcome, with no additional calibration repetitions and no B
implementation PR. Review the evidence PR.
Any future B proposal still needs fixed-policy A/A and A/B qualification for
every required case, followed by qualification of its actual proposed merge.

Preserve all original records when deleting the temporary diagnostic entrypoint,
manifest and CI jobs after review. Production implementation, merge, release and
deployment remain outside this work.

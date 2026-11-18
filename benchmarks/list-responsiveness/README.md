# List responsiveness spike

This investigation is retired after review in a merged PR.
The outcome is **complete, inconclusive; no production promotion**. Its tracking
issue is closed; the parent issue tracks the
remaining cleanup. The candidate commands and temporary manual CI scenarios have
been removed. Decision records and machine-readable receipts below remain intact.

The commands and run instructions below describe the archived experiment. Use
the reviewed source tree
and each study's exact recorded application, harness and dependency revisions to
reproduce historical evidence. The [closeout record](CLOSEOUT.md) describes the
archive, retained regression coverage and removal scope. Existing measurements
and qualification decisions have not been changed.

The [bounded status-control follow-up](STATUS-CONTROL-RESULTS.md) is complete with
no promotion. Four profiled trials located GC and request-dispatch delays but did
not demonstrate a correctable defect in the unprofiled harness. No new
qualification or implementation PR follows; prior measurements remain unchanged.

The completed [fixture-validation repeatability study](REPEATABILITY-RESULTS.md)
calibrated all twelve A/A gates on a fresh VM. The retained aggregation candidate
reduced list SQL time by 41–47% and HTTP p50 by 37–42% on the full mixed/user
fixture. Eleven of twelve comparison gates passed; terminal-status HTTP p95
remained inconclusive, so there is no promotion. Earlier decisions and archives
remain unchanged, including the [v1 disk-capacity failure](REPEATABILITY-FAILURE.md).
Its entrypoint is `node experiments/list-responsiveness/repeatability.mjs`; use
the documented `prepare`, `run`, `retain` and `verify` commands in the
[frozen protocol](REPEATABILITY.md).

The [bounded status-control protocol](STATUS-CONTROL.md) retains the saved-trace
audit and exactly four profiled trials comparing the original sequence with
status alone. Its observations cannot establish promotion or change v2's decision.

- Status: Complete — B inconclusive; C rejected; no production promotion.
- Decision record: [Results](RESULTS.md)
- B-only follow-up: [No-promotion qualification record](QUALIFICATION.md)
- Blocker diagnosis: [Host sleep and calibration investigation](DIAGNOSIS.md)
- Native replay: [Temporary-sort I/O and connection backlog](NATIVE-DIAGNOSIS.md)
- Merged-main study: [Dedicated-VM calibration and no-promotion outcome](MERGED-MAIN-CALIBRATION.md)
- Linux CI diagnosis: [Recovery correction, backlog evidence and verification failure](CI-DIAGNOSIS.md)
- Aggregation follow-up: [Red/green/reversal evidence and timing decision](AGGREGATION-RESULTS.md), [runnable protocol](AGGREGATION.md)
- Run: `yarn tsx experiments/list-responsiveness/run.ts`

This README records the original temporary A/B/C spike. Subsequent B-only
qualification uses the shared runner and frozen six-pair policy linked in the
[follow-up record](QUALIFICATION.md). The commands and screening criteria below
belong to the original spike; recorded measurements retain their original build
and harness fingerprints.

The current runner follows main's Workload/Deployment record naming and the
corresponding HTTP routes and database columns. To reproduce the original
measurements, use their recorded revisions; merging main does not reattribute
those results or qualify the current application.

This local experiment compares the actual current list HTTP path with a predicate
in its two outer VM joins. Candidate C also tries a partial workload-ID index
over IP-bearing attempts. No product source or migration is changed.

| Arm | Experimental change                                                 |
| --- | ------------------------------------------------------------------- |
| A   | Current production statements, unchanged.                           |
| B   | Add `AND v.ip IS NOT NULL` to the two outer list joins only.        |
| C   | B plus `vms(workload_id) WHERE ip IS NOT NULL` in synthetic copies. |

The predicate remains in `ON`, so workloads with no contributing VMs remain
visible. Empty-string IPs still contribute. Provider fallback, credential and
resubmission checks retain their original SQL. Statement-shape and replacement
assertions make an unexpected query shape a harness failure.

## Run

```sh
yarn build
yarn tsx experiments/list-responsiveness/run.ts --check-only
yarn tsx experiments/list-responsiveness/run.ts --small
yarn tsx experiments/list-responsiveness/run.ts --repetitions 3
```

The recorded default run took about 110 minutes on the measured machine; its
fixed-arrival load trials alone account for 54 minutes. Three additional
repetitions in both lanes took another 147 minutes. Use the small profile for a
quick harness smoke check.

Use `--profiles sparse,retry,ip-heavy,events,history,mixed` to select fixtures and
`--lane matrix` or `--lane load` to narrow execution. Load runs use the mixed
fixture. `--output .context/NEW_DIRECTORY` must name a fresh directory in this
workspace's ignored state. `--extend .context/PREVIOUS_DIRECTORY` adds trials to
a completed report using the same retained seeds, product build and harness;
failed or interrupted reports are rejected before any work starts. It writes a
new output directory and references the original seeds/raw trials. Keep both
output directories. The extension and request-journal corrections change the
harness fingerprint, so pre-correction measurements cannot be extended with
the corrected runner.

The full matrix uses 50 measured requests after 10 warmups per case. Explicit
limits 1, 200 and 1000 and omitted limits cover both list paths and ownership
scopes. Three repetitions rotate ABC/BCA/CAB. Each trial starts a fresh process
and database copy. Initial requests are retained separately. Business time is
frozen; timers use real monotonic time. This is a warm steady-state comparison,
not a cold OS-cache measurement. The small profile uses five observations and
short load intervals and cannot support a promotion decision.

The mixed load offers ordinary, terminatable and session list requests, a daily
cost report and a cleaned terminal status in equal rotation. Phases are 30
seconds at 2.4 requests/second, 60 seconds at eight/second, and 90 seconds at
2.4/second. The work driver uses fixed arrivals, a 15-second deadline and a
128-request client cap. It records scheduling/admission skips and drains full
bodies. Client limits do not bound server queues. A separate driver process
offers health at 10 Hz with a one-second deadline. Late HTTP 200 responses still
miss that deadline.

Load latency quantiles describe successful body completions. Timeouts and
transport failures remain separate outcomes in the offered/admitted counts;
successful-response quantiles do not describe those failed requests. The pending
handler snapshots are counts by operation name; an empty object means zero.

The API starts through the production app factory and test authentication.
It exposes only loopback measurement endpoints and never starts controllers.
Synthetic child environments reject networking and subprocesses. Violations
remain fatal even when application code catches their exceptions. The API waits
for health drainage before validation, query plans and shutdown.

Current-schema fixtures use real deployment/spec creation followed by synthetic
bulk inserts with foreign keys and ownership checks. Sparse history has few VMs;
retry and IP-heavy profiles vary the contributing fraction at the same depth;
events increases selected-page event depth; history adds older rows without
changing the hot page. Mixed uses 18,664 deployments, 285,564 VMs and 1,994,751
events. Its distribution is synthetic, not a reconstruction of production.

| Full fixture | Deployments |     VMs |    Events | Variable                                                      |
| ------------ | ----------: | ------: | --------: | ------------------------------------------------------------- |
| sparse       |       2,400 |   2,400 |     9,600 | Zero to two attempts per deployment.                          |
| retry        |       2,400 | 281,801 |     9,600 | 128 attempts in each hot deployment; only the last has an IP. |
| ip-heavy     |       2,400 | 281,801 |     9,600 | Same depth; approximately 99% of attempts have IPs.           |
| events       |       2,400 |   2,400 | 1,127,200 | 512 events in each hot deployment.                            |
| history      |      18,664 |  18,663 |    74,656 | Same hot page as sparse, with older history appended.         |
| mixed        |      18,664 | 285,564 | 1,994,751 | 60% of VM/event rows in hot deployments; 68,128 non-NULL IPs. |

The hot set contains 2,200 deployments, including active and pending-release
records, durable and legacy owners, renamed users, and foreign ownership.
The separate correctness fixture exercises 35 user-scope and 36 API-scope HTTP
cases per arm. It compares status, complete serialized bodies and ordering;
wrong-key list success is checked against full hydration with correct/wrong keys.

Raw JSON, complete correctness responses, actual SQL/plans, seeds and failed
copies stay in the output directory. Successful trial database copies are
removed. Each offer, skip and settlement is synchronously appended to
`request-journal.jsonl`, so a watchdog kill preserves partial accounting.
Use the last snapshot per request ID to recover its outcome; an admitted offer
without a settlement remains `unfinished`. Completed drivers also write
`requests.jsonl` with one final record per request, preserving its existing
format for measurement consumers.

SQL timing wraps synchronous preparation/execution/materialization,
never overlapping async query continuations. Index setup and rollback-only VM
write probes are excluded from read timing. The write probes insert ended VMs,
half with IPs, flip membership in both directions, then update costs/end times;
they exclude commit/fsync, live-write distributions and concurrent writers.
Index creation timing excludes the subsequent statistics optimization.
Peak RSS includes initialization, and sampled memory can miss short maxima.

The experiment adapts the completed billing responsiveness spike and the source
workspace's shared API responsiveness helpers. Billing workloads and historical
timings are not reused as list measurements. The source workspace is unchanged.
The helper snapshot preserves the `ready → start → started → go → work-finished →
health-drained → result` handshake and adds a separate HTTP workload process.
Temporary copies here must be reconciled with the shared helper change before
any permanent list benchmark is promoted.

## Promotion criteria

Subsequent promotion requires the fixed policy and complete evidence described
in [the qualification record](QUALIFICATION.md). The criteria below record the
original spike's screening rules; they do not qualify the B-only follow-up.

Require complete public-response equality, unchanged authorization and secret
projection, and repeatable gains across independent runs. Screen for at least
10% improvement without control regressions above 5%; add three trials where
variation prevents a clear decision. Remaining one-second health misses do not
automatically reject a useful optimization. An index must earn its additional
write/storage cost. Report inconclusive or negative results without promotion.
Sparse, IP-heavy, event-depth and outside-page-history cases are controls.
The automatic screen is preliminary: the final decision also inspects paired
variation, HTTP tails, mixed-workload controls, and incremental C-versus-B costs.

## Deletion criteria

After a successful production change and permanent regression coverage land,
rebase on the shared measurement helper change, move the qualified list scenario
into the permanent API responsiveness command/CI, and remove executable spike
alternatives. Delete rejected alternatives after their decision is reviewed.

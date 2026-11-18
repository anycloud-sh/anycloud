# API responsiveness

This probe compares two built revisions through their real billing monitor,
AWS allocator, and SQLite persistence. The same harness runs both revisions;
only the external Cost Explorer client receives synthetic responses. A read-only
observer verifies complete resource/account/group inputs, including empty bills.
The list scenario joins this runner after its independent spike is qualified.

## Run

Build both checkouts with their own frozen lockfiles and Node 22. Supply checkout
roots containing `dist/`, not the `dist/` directories themselves.

```sh
yarn probe:api-responsiveness \
  --base-dir /path/to/baseline-checkout \
  --candidate-dir /path/to/candidate-checkout \
  --profile standard \
  --output /path/to/new-results-directory
```

Run both arms against the same built checkout to qualify the harness:

```sh
yarn build
yarn probe:api-responsiveness --profile smoke --repetitions 6
yarn probe:api-responsiveness --profile standard --response empty --boundary yield
```

The default is six paired trials, alternating AB/BA. `--response all` covers empty
bills and a deterministic mixture of failed, empty, and successful bills; every
successful group receives a fixed $137 bill. `--response settled` settles every
group. `--boundary all` runs immediate and yielding responses. Each case records
its response mode, so a mixed run is never presented as full-backlog settlement.
Use `--help` for the complete command interface.

`--timeout-ms` controls the diagnostic child watchdog, including setup, and
defaults to 30 minutes. It does not change either health deadline. Scheduled and
manual CI give each case two hours, or four hours for the three-times backlog
with mixed bills:
older baselines retain hundreds of thousands of actual per-VM commits, and
slower runner disks can make one trial exceed ten minutes. Candidates use their
own production settlement behavior. All six pairs and fixture rows remain part
of the comparison.

| Profile   | Billable VM rows | Billing groups | Largest group |
| --------- | ---------------: | -------------: | ------------: |
| smoke     |            1,119 |             45 |           327 |
| standard  |          268,317 |         15,452 |           327 |
| backlog3  |          804,951 |         46,356 |           327 |
| oversized |           10,792 |             45 |        10,000 |

`--profile all` selects standard, backlog3, and oversized. Rows use two synthetic
AWS accounts, valid current-schema container specs, positive unequal runtimes,
and IP-null attempts. These are billing fixtures; list must supply its own sparse,
retry-heavy, IP-bearing, and mixed histories.

## Measurement and artifacts

The baseline creates one synthetic seed using its migrations and real
workload/spec writer. Both revisions receive independent copies; candidate
migrations run before measurement. A logical digest verifies identical input
records after migration and before every trial. Unsupported schema or boundary
changes fail visibly and require a reviewed fixture/observer update.

Each trial uses a fresh process/database. Both arms perform identical warm table
reads. Imports, migrations, fixture verification, and index preparation are
excluded from workload timing. Setup reports include initialization time, index
definitions, database size, and a bounded insert/update probe that rolls back.
Initialization time includes actual migration/index work. A separate probe
rebuilds added or changed indexes using their real DDL on the migrated fixture,
then rolls back, reporting each creation time. This warm rebuild probe and the
write probe exclude commit/fsync. Nonempty workload cases measure the actual
production settlement writes and commit behavior.

Synchronous workload SQL time includes explicit transaction begin/commit/rollback
as well as statements and implicit autocommit. The native transaction wrapper
subtracts its callback's duration so statements and nested savepoints are counted
once. Reports retain transaction overhead separately and record the maximum
whole synchronous transaction duration, including its callback. Provider awaits
are outside this measurement boundary.

An independent driver offers health requests every 100 ms. It retains planned
and actual arrival times, elapsed time, status, and phase. Responses after one
second count as deadline misses even if HTTP 200 arrives before an abort callback.
An unsampled short sweep has no health result. Delays in the driver are reported,
so delayed arrivals cannot be mistaken for the requested offered load.
Every offer is recorded before completion. The driver drains pending health
requests before validation or shutdown, so teardown cannot distort their results.

The report includes every trial, source/build/lockfile/harness hashes, runtime
and host details, CPU, event-loop delay, synchronous SQL time, query counts and
plans, returned rows, and memory. Query plans are captured after the workload,
outside timing. Peak RSS includes startup and fixture validation. Maximum rows
returned by one statement is not a maximum page-memory measurement. Group
membership observation adds identical verification work to both measured arms.

The output directory must be new. Successful trial copies are removed; seeds
and failures remain for local reproduction. Crash recovery preserves SQLite
journal/WAL sidecars. The driver terminates children on cancellation, and children
exit when their parent disconnects. Synthetic children reject outbound network
and subprocess calls and check rejection counters even when the monitor catches
an exception.

## CI and correctness

The existing unit suite runs billing identity, whole-group allocation,
bounded candidate discovery and range seeks, concurrency/fairness, cutoff,
rollback/retry, oversized-group, and measurement-validity tests.
Billing identity deliberately ignores unrelated SSH/storage secrets, container
payloads, and placement settings. Tests settle nonempty bills despite damaged
unrelated configuration while retaining owner/spec presence checks, selected
credential precedence, explicit NULL-credential skips, and cluster placement
guards. The general workload configuration loader keeps its existing validation.
The existing long-history integration test appends a real billing settlement
phase on a copy of its seeded history. Delayed synthetic responses ensure health
probes overlap that phase. Its existing six-second timeout remains authoritative;
the one-second result is reported separately.

The API Performance workflow runs daily at 13:17 UTC and on manual dispatch.
It adds no automatic PR comparison; the existing unit and long-history
integration gates, including interrupted settlement, remain in PR CI. Scheduled
runs compare the captured `main`
commit with the source tag of the latest published release in
`anycloud-sh/releases`. Resolve that tag in `anycloud-sh/anycloud`, where the
source lives, and pin both commits once before starting any matrix cases. A
missing release or source tag fails visibly without substituting `main`.
The selected refs and commit IDs are retained in `api-responsiveness-revisions`.

Every scheduled run covers standard, three-times backlog, and oversized
profiles with empty/mixed bills and immediate/yielding responses: twelve cases,
six alternating pairs per case, 144 trials. At most three cases run concurrently;
both arms of each pair run sequentially on one runner. The full comparison
previously used approximately five runner-hours. Scheduled and manual runs have
separate concurrency groups and do not cancel an active comparison.

Manual dispatch retains explicit revisions, profiles, responses, boundaries,
and repetition counts; its defaults also cover the full matrix. The baseline
defaults to `main`, while a blank candidate uses the selected workflow commit.
Both refs are resolved once to immutable commits. Supply the same revision for
both arms for a control, or explicit base/candidate refs to qualify a performance
PR. Keep complete-matrix evidence for claims about paid settlement, larger
backlogs, oversized groups, and control-case tradeoffs.

The workflow reuses Catalog Refresh's Slack notifier. After revision selection,
comparison, and reporting finish, any failed required job sends one
`API Performance failed: <run link>` message to the configured CI channel.
Successful and cancelled runs stay quiet. This alerts on execution, correctness,
and harness failures; timing regressions and one-second health misses remain
informational. Automated Codex performance review is a separate follow-up.

A combined report validates exactly the requested cases, rejecting missing cases,
incomplete pairs, and inconsistent build or harness revisions. Timing differences
are informational; fixture, outcome, process, and harness failures fail the job.
Workflow summaries and raw JSON/log artifacts are retained for seven days.
Comparison reports and billing integration measurements are required performance
evidence in the shared artifact-cleanup policy: uploads run on success and failure,
missing artifacts fail CI, and cleanup protects them for the full seven-day window.
This workflow does not change branch protection or claim production capacity.

## Paging and settlement qualification

Production discovery examines at most 20 group candidates per page using scalar
range seeks into `idx_vms_pending_cost_group`. Live parents, missing credentials,
and groups newer than the fixed cutoff consume budget too. Complete groups load
without a VM-row limit; the monitor yields to I/O between pages, including empty
and failed pages. Ready settlements run one at a time and yield before each
transaction, so a page of slow commits cannot form one uninterrupted burst.
Provider requests remain concurrent, and a failed settlement does not block the
next group. Settled groups can leave the index, and eligibility gained behind the
cursor is picked up on the next sweep.

Migration `0104_bound_billing_discovery.sql` creates the partial expression index
on pending ended VM attempts. Startup builds it before readiness, scanning VM
history and allocating additional disk space for pending entries. No operator
command or data rewrite is required. The old diagnostic history index remains.
Prepare each candidate clone through its actual migrations and retain index
creation, storage, and insert/update costs when evaluating this change.

Run the interruption qualification after `yarn build` (the constrained Vitest
member; its Bash driver retired under RFC 0017):

```sh
yarn test:billing-settlement:vitest
```

The driver is `test/integration/e2e/internal/read-models/billing-driver.ts`;
evidence lands under the run's `RESULTS_DIR`.

It exits the actual monitor after five cost updates, records that the transaction
is still open, preserves SQLite journal/WAL sidecars, then reopens and retries.
The baseline before the atomic-writer fix committed 5 of 18 members and retried only 13. The
atomic writer must leave every group entirely committed or rolled back, retry
with complete allocation membership, and make no further provider calls once
all groups settle. Any missing fault evidence, partial settlement, or incorrect
retry fails the command.

The command also injects a 75 ms synchronous storage delay into each real group
transaction while independent health requests run. This reproduces the risk of
several slow commits accumulating within a page. It retains the six-second
integration gate and reports one-second misses separately. Deterministic unit
tests require an I/O turn before every settlement, including after failures.

The existing long-history integration CI job also runs this blocking command.
Its JSON reports, fixture manifest, interruption record, and process logs are
uploaded as `billing-settlement-qualification`, retained seven days on success
or failure. It adds no new comparison job to PR CI.

Group-count paging does not bound one arbitrarily large group. The 10,000-member
case verifies membership and allocation, and its actual health/transaction
measurements remain part of qualification. Paging also adds range queries and
waits for each page's provider calls before advancing; compare elapsed work and
CPU as well as responsiveness. These synthetic results do not establish mixed
production API capacity or the original host-outage cause.

The [archived spike decision](billing-responsiveness-decision.md) retains the
experimental evidence. Its executable alternatives have been removed after
promotion into production code and permanent tests. Existing cost-report probes
remain separate from billing reconciliation.

## List integration contract

The billing workspace owns `test/helpers/api-responsiveness/` and the comparison
command/report protocol. The list workspace owns list fixtures and workload
execution. Reuse `runChild` (including its child/register entrypoint parameters),
`startHealthSampler`, synchronous SQL instrumentation, metadata, and report
helpers. The child IPC sequence is `ready → start → started → go → work-finished →
health-drained → result`; failures use `failure` and a nonzero exit. A child must
expose its loopback port in `ready` and await both driver handshakes before timed
work. After `work-finished`, it must await `health-drained` before validation or
shutdown.

Add the qualified list scenario to the same command and CI comparison, with its
own current-schema seed and real HTTP driver. Preserve raw offered/completed/
timed-out work and response comparisons. Rebase on the shared-helper change before
promotion; temporary spike copies must not become separate permanent runners.

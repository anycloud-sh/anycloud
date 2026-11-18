# Local billing spike decision

September 10, 2026. Source `02b2d81d8`, package `0.1.63`; Apple M4, macOS arm64,
Node 22.14.0, 24 GiB RAM. These are relative local results, not an Azure D4 rerun.

**Promote both narrow billing identity and bounded group discovery into separate
product PRs.** Narrow identity substantially reduces total sweep work; bounded
discovery is what removes the upfront responsiveness failure in this fixture.
The spike does not establish the cause of the original host outage.

The measurements below preserve the original three-arm experiment. Identity
promotion's approved behavior reconciles costs despite malformed unrelated
workload configuration while retaining required structure and compute
identity checks. The identity implementation landed separately. Paging and
atomic settlement were promoted after it;
the executable alternatives were removed after their coverage moved into
production code and permanent tests. [The permanent benchmark](api-responsiveness.md)
owns subsequent production comparisons. The measurements and decisions below
remain a record of the original experiment.

## Calibrated backlog

268,317 eligible VM rows, 15,452 groups, 14,218 owners. Three independent runs
per arm with rotated ordering and a yielding empty-bill provider boundary.
Sweep times are medians; pause ranges contain each run's maximum event-loop
delay. Health is offered independently at 10 Hz with a one-second deadline.

| Arm                              | Sweep time | Longest event-loop pause | Health deadline misses |
| -------------------------------- | ---------: | -----------------------: | ---------------------: |
| Current monitor                  |     5.11 s |              2.46–2.66 s |               47 / 154 |
| Narrow identity, bulk discovery  |     2.95 s |              2.40–2.45 s |                42 / 87 |
| Narrow identity, paged discovery |     2.69 s |                 20–26 ms |                 0 / 79 |

Both bulk arms returned all 268,317 VM rows from a single statement. Paged
discovery returned at most 327 rows from one statement and held at most 659 VM
rows in its current page. Its slowest measured statement was 5.0 ms, compared
with 2.43 s in the current monitor. Statement timing includes preparation and
row materialization, not just SQLite VM execution.

Paging trades additional queries for bounded work: about 90,246 statements per
sweep, versus 46,357 in the current monitor and 30,905 with identity projection
alone. The experimental index took 139–154 ms to build outside the measured
sweep. Write amplification and migration behavior still require product review.

## Larger backlog

One run per arm at three times the fixture size: 804,951 VM rows, 46,356 groups.

| Arm                              | Sweep time | Longest event-loop pause | Health deadline misses |
| -------------------------------- | ---------: | -----------------------: | ---------------------: |
| Current monitor                  |    13.17 s |                   4.55 s |               37 / 131 |
| Narrow identity, bulk discovery  |     6.55 s |                   5.08 s |                41 / 65 |
| Narrow identity, paged discovery |     7.05 s |                    25 ms |                 0 / 70 |

The paged arm again held at most 659 rows per page; its slowest statement was
6.0 ms. At this size it was slightly slower overall than the bulk identity arm,
while keeping health responsive. These single-run larger-backlog timings are a
scaling check, not precise throughput estimates.

The current arm recorded 36 aborted probes plus one successful response arriving
at 1001.4 ms. The table counts all 37 deadline misses. Raw transport success and
deadline compliance are distinct; the runner now reports `deadlineMisses`
explicitly alongside timeout counts.

## Scheduling and oversized-group controls

With an immediate empty-bill boundary, the current monitor blocked for almost its
entire 5.37-second sweep (43 / 53 health deadlines missed). Narrow identity alone
still blocked for roughly 3.10 seconds (21 / 31 missed). The paged arm took 2.87
seconds overall, with a 24 ms maximum event-loop pause and 0 / 28 misses. This
supports an actual event-loop yield between pages, even when provider promises
resolve immediately.

In a separate 45-group fixture containing one 10,000-VM group, the paged arm kept
all members together and held 10,342 rows in its largest page. Its longest pause
was 70 ms and its longest statement 54 ms. The run was shorter than the health
sampling interval and had no work-phase health offers; no health-rate conclusion
is drawn from it. Group count bounds do not impose a hard bound on one unusually
large group.

## Correctness

The final small-fixture checker passed on 1,119 rows and 45 groups:

- Exact canonical rows and group identities match the real repository at page
  sizes 1, 7 and 20, without duplicate or missing groups.
- All 45 projected billing identities match the real workload/config resolver.
  The existing nullable-VM-credential skip behavior is preserved.
- An unequal-runtime fixed group bill preserves its total; deliberately splitting
  that group is detected as double allocation.
- Fifteen failed groups, fifteen empty-bill groups and fifteen settled groups
  still allow the entire tail to be visited as successful rows leave the index.
- Ineligible candidates consume page budget. Eligibility gained behind the cursor
  is recovered by the next sweep, and the billing cutoff stays fixed.
- A forced exception after all group writes rolls back every cost; foreign keys
  and database integrity remain valid.

The earlier oversized-fixture run also passed group/identity equivalence and
rollback over 10,000 group members. These are synthetic checks, including a
transaction prototype; they do not substitute for real provider-contract tests
or claim that atomic settlement has already been implemented in the monitor.

Repository verification passed: `yarn verify`, including build, policy/lint/type
checks and 8,886 tests across 364 files. The documented `run.ts --check-only`
entrypoint also passed against a fresh fixture.

## Scope and follow-up

The current monitor and repository run unchanged. Only the provider boundary is
replaced. No lifecycle controllers or real cloud calls run, and no production
database is read. The fixture uses valid current-schema container specifications,
two synthetic Azure credentials and IP-null VM attempts. It does not reproduce
the full production provider/error mix or mixed HTTP traffic.

Before promotion, decide the behavior for unrelated malformed configuration that
the narrow identity path no longer loads. Review the ordered index as a migration,
measure write cost, add provider/credential and atomic-settlement tests, and
qualify the result under mixed HTTP load. Keep the single-large-group limit
explicit. Persistent cursors, backoff changes and database workers remain separate
decisions.

Raw local artifacts are under `.context/billing-spike-main`,
`.context/billing-spike-backlog3`, `.context/billing-spike-immediate`,
`.context/billing-spike-oversized`, and `.context/billing-spike-correctness`.
Each performance report records the source commit, host/runtime, exact fixture,
measured harness SHA-256, separate per-run results, and raw health observations.
The original commands are not part of this repository's history. New
qualification uses the permanent benchmark.

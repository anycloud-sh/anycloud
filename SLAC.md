# SLAC — Scale, Latency & Concurrency

How AnyCloud's background services stay **bounded under load** (no resource
blowup) while making **adequate progress** (bounded staleness) — and how the
scale tests verify both. Internal design doc; pairs with `test/STRATEGY.md` (the
scale-test harness) and `ARCHITECTURE.md` (the runtime topology).

> **Read the [Residual](#residual--what-this-does-not-guarantee) section before
> trusting any cap number.** The caps are provisional; the real guarantees are
> narrower than "throughput is fine."

## TL;DR

- Workload-state work uses one **single-process, in-memory controller**. SQLite
  remains authoritative; a lightweight 30-second discovery rebuilds a disposable
  `Map`, and a one-second safety pump continuously fills available in-flight positions.
  Multiple API processes sharing one SQLite database are unsupported until the
  controller has durable distributed claims/leases.
- Polling, retry, finalization, cleanup, and stuck recovery share one aggregate
  internal bound of **40** in-flight handlers. It is fixed, not an operator
  setting. Active-step recovery calls the same process-local pipeline runner
  used by new scheduler dispatch and releases its reconciliation position after
  bounded preparation.
- Two invariants, both now asserted by tests on a virtual clock:
  - **Safety** — peak concurrent in-flight ≤ cap (no socket/heap blowup).
  - **Throughput** — 2,000 modeled two-second job checks drain within the
    120-second completion-detection SLA.
- **The polling design has a structural ceiling.** You cannot both "process all `N`
  within the interval" and "stay within a fixed resource budget" as `N`→∞ on one
  box. Caps convert overload into **latency**, not collapse — the correct failure
  mode, _if_ the latency stays bounded and acceptable.
- **Caps are provisional**, derived from _modeled_ per-item latency, not
  measurement. If row-count admission proves too coarse for mixed-cost work, the
  next step is cost-weighted admission — not more per-monitor knobs.

## The model

Each tick fans out over `N` rows with per-item latency `D`, bounded to `C`
concurrent. Drain time:

```
drain ≈ ⌈N / C⌉ · D
```

- To keep cadence: `drain ≤ interval`, i.e. **`C ≥ N·D / interval`**.
- For safety: **`C ≤ resource_budget`** (sockets / FDs / heap — shared across all
  monitors).

As load `N` grows, the throughput floor `N·D/interval` rises until it exceeds the
safety ceiling — **no valid `C` exists.** That is the ceiling. The knobs only move
it:

| knob       | does it buy throughput?           | cost                                                 |
| ---------- | --------------------------------- | ---------------------------------------------------- |
| `C` (cap)  | yes, more concurrency             | blows the resource budget — the thing we're avoiding |
| `interval` | no (only lets the drain be later) | more detection latency; the **weakest** knob         |
| `D`        | no                                | it's a cloud/SSH round-trip — not ours to shrink     |

So the cap **makes the system safe**, and **overload shows up as latency** (the tick
cycles over multiple ticks), never as a crash.

## What "guarantee throughput without blowing up" means

You cannot guarantee "all `N` within the interval" AND "bounded resources" as `N`→∞
on one box. What we guarantee, in layers:

1. **No blowup (have it for workload-state work):** one controller cap bounds
   polling, retry, finalization, cleanup, and stuck recovery in aggregate;
   overload → latency. Independent provisioning and residual periodic services
   retain their own bounds.
2. **Adequate throughput (architectural, not a bigger number):**
   - **Event-driven > polling** — biggest lever. Don't poll `N` jobs asking "done?";
     have the daemon push completion (the `/v1/ack` heartbeat path already exists).
     Work then scales with the _completion rate_, not the _backlog `N`_; keep a slow
     poll as a reconciliation backstop (the k8s watch + resync pattern). **Not built
     for job-completion.**
   - **Adaptive concurrency** (AIMD / Little's-Law / Netflix concurrency-limits) —
     auto-tune `C` to the max the resource sustains; back off on `EADDRNOTAVAIL` /
     429 / rising RTT. No magic constant. **Not built.**
   - **Sharding** — when one box's safe rate < required rate, partition `N` across
     instances. "Queue length sets the number of waves/shards, not the width."
     **Not built.**

## Why per-monitor knobs don't scale

The caps below are keyed to monitor _identity_ — the wrong axis. What actually varies
is (1) **per-item cost class** — cloud-API (~0.5s, sockets), SSH+docker (~2s,
pool+heap), SSH+rclone (minutes, held connection), DB-only (~ms) — ~3–4 classes, not N
monitors; and (2) **one shared resource budget** (sockets / FD / heap / event-loop),
drawn by all of them. A cap per monitor hand-partitions that one budget into N static
slices — always either conservative (underutilize) or oversubscribed (Σ caps > budget →
the outage) — and **none of the N knobs bounds the _aggregate_, which is the only thing
that prevents the outage.**

The implemented shape uses **one internal aggregate bound** for reconciliation.
A process-local controller admits at most `K` IDs at a time across all
five lanes. The in-memory entry is only a timing and de-duplication hint: each
operation re-reads current durable state immediately before external work and
refreshes it afterward. If a plain row budget is too coarse (for example, many
long-running final rclone syncs occupying slots), evolve it into
**cost-weighted admission** with a few per-class weights (cloud=1, SSH=k,
rclone=big, DB=0), not new per-monitor caps. `MAX_ACTIVE_DEPLOY_PIPELINES` stays
separate because workload admission is a durable queued-work problem.

## Aggregate Budget + Residual Caps

`peak` ≈ the largest customer's observed peak (~825–988 concurrent spot workloads); "2x" ≈ 2000. Grounded in that customer's production DB: steady-state is only ~27 active spot workloads, but a batch spikes to that peak (one user, 3.7k spot workloads over 26 days) — so the caps bind _at peak_, not hypothetically. Line numbers are approximate (they drift).

| service / class        | cadence                  | per-item                           | admission / cap                                                                                     | status                                                                                   |
| ---------------------- | ------------------------ | ---------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| workload reconciler    | continuous; discover 30s | cloud + SSH + cleanup + retry + DB | fixed 40 in-flight handlers; one-second safety pump; weighted fair lanes                            | applied — bounded internal fan-out                                                       |
| active deploy pipeline | scheduler + recovery     | long-running cloud + SSH pipeline  | `MAX_ACTIVE_DEPLOY_PIPELINES=50` durable rows; one process-local in-flight map keyed by workload ID | applied — one wake/settlement path; recovery handoff does not consume reconcile capacity |
| preemption inner/VM    | inside reconcile         | cloud                              | `PREEMPTION_VM_CONCURRENCY=20`                                                                      | applied                                                                                  |
| cost-calc              | 1h                       | cloud billing                      | `COST_CALCULATION_CONCURRENCY=20`                                                                   | applied — bounds independent billing groups                                              |

Workload-state sub-arms (preemption, running-job completion, retry,
finalization, cleanup, stuck-active) share one fixed in-flight bound. An
active-step handler only validates and hands off replay, so the long-running
workload promise is outside that bound. Completion immediately requests another admission, so the live controller has
no page barrier and no catch-up mode. The 30-second discovery finds new/changed
durable rows; the one-second pump wakes entries whose in-memory deadline just
became due. Inner operation caps still make sense where one row can fan out
internally, such as checking a workload's VMs for preemption.

Fairness is also part of the invariant. The high-volume batch path is running
job completion, so it receives six turns for every one turn each for retry,
finalization, cleanup, and stuck recovery. At the fixed `K=40`, continuous
backlog therefore admits `24/4/4/4/4`. Empty lanes spill their turns to
available work. This prevents starvation without reserving idle capacity or
exceeding `K`.

On startup, every workload in an active pipeline state is an orphan because
its owning coroutine belonged to the previous process. Startup discovery places
those IDs in the stuck lane immediately, ignoring any legacy scheduler
timestamps. Bounded reconciliation operations hand them to the shared workload
pipeline runner as soon as they are admitted. Scheduler dispatch calls that same
`wakeWorkloadPipeline(id)` entrypoint, so placement reconstruction,
single-flight, runtime launch, and rejection policy do not fork. Because handoff
does not await the pipeline, the controller can promptly refill and resume all
previously admitted pipelines.
For `provisioning`, the scheduler's event persists exact placement before
handoff. A crash before the VM placeholder exists resumes from that intent;
legacy rows with neither intent nor an active attempt return to `queued`,
unresolved attempts are adopted, and completed VM rows replay the idempotent
Provisioning postamble before the next step event implicitly records completion.

An inconclusive provider read installs a five-minute active-recovery deadline.
Replacement-entry identity prevents the completing handoff from overwriting that
deadline, bounding repeated provider reads and event growth during an outage.
Restart intentionally forgets this disposable delay and probes orphaned work
immediately.

### Durable state versus process-local scheduling

- Durable: workload state, workload events, VM lifecycle, credentials, and
  all user-visible history in SQLite. The Provisioning event first stores the
  scheduler-selected provider/region/zone/VM type/credential; Provisioning then
  inserts an attempt target before bucket, network, or VM mutations and completes
  that same row with provider facts without replacing its resolved intent.
- Reconstructible: lane, deadline, in-flight membership, fairness cursor, and
  counters in the controller's `Map`.
- Retry preparation (cleanup/exhaustion) is immediate. Launch deadlines are the
  durable retry-event timestamp plus one random sample from the bounded backoff
  window per revision. Restart may resample within that same window; aggregate
  admission, rather than a stable hash, prevents a provider retry storm.
- The former `next_check_at` cursor and `last_checked` heartbeat columns are
  dropped; no process-local scheduling fact is persisted.

### Sizing a cap

- **Cheap, load-scaling, hold cadence (preemption):** `C = ⌈2·peak·D / interval⌉`.
  Cloud `D`~0.5s, interval 30s → ~33; set 100 with headroom.
- **Expensive, load-scaling, accept staleness (job-completion):** holding the 30s
  poll needs `C ≈ 2·1000·2/30 ≈ 130` — **unsafe**. Relax to a staleness SLA:
  `C = ⌈2·peak·D / SLA⌉ = ⌈2·1000·2 / 120⌉ ≈ 34` → **40**. The SLA (not the interval)
  is the budget; that's what makes a _safe_ cap possible.

## The Jun-2026 production outage (why this doc exists)

Peak ~825–988 concurrent spot workloads (one user). Unbounded `Promise.allSettled`
on cleanup/finalization/retry fan-outs + no container memory cap → V8 heap OOM (~4GB
default), later RSS wedged to ~11GB in 6 min during an Azure preflight storm. Root
cause: **no global backpressure across independently-ticking monitors** + no memory
boundary + uncoalesced identical Azure quota sweeps. The per-monitor caps here stop
any _single_ monitor from doing this; the process-local controller now bounds the
aggregate workload-state work.

## Memory / heap

Target: **2× the observed peak (~2000 concurrent) without raising the Node heap.** The
Jun-2026 OOM was _transient_ heap (∝ N — the unbounded fan-out built ~1000 simultaneous
promises / gateways / decrypted configs, ×the retry storm), not steady per-workload
cost. So the goal is heap that stays **flat in N**, not more RAM:

- Fan-out caps bound the _transient_ to the cap (~40 aggregate workload-state
  items, plus residual inner caps), not N — done.
- **Backpressure is on the critical path, not optional** — the unified controller
  kills the independently-ticking monitor multiplier that turns a spike into OOM.
  With it the default heap suffices; without it no heap size is safe (a bigger heap
  just OOMs at a higher N).
- The controller map is intentionally O(live candidates), but each entry is only
  lightweight scalar scheduling data. Heavy configs, credentials, promises, and
  provider clients remain O(`K`). The SSH connection pool is also N-sensitive and
  self-expiring; confirm both evict/shrink in real-substrate tests.
- `--max-old-space-size` is **insurance, not the plan**: on that customer's API host it's
  currently _unset_ (bare `node ./dist/api/server.js`, at V8's default while ~13 GiB
  sits free) and the flag _reverts on `anycloud api stop/start`_ — so it can't be the
  durable answer. Fix it in code (caps + backpressure); keep the flag only as margin.

**Gated on measurement:** the right cap numbers, any adaptive limiter's tuning, and the
flat-heap claim all need the sim to measure **aggregate in-flight, tick wall-time, AND
peak RSS / V8 heap at N≈2000 under _injected failure_** (the failure path is where the
retry storm lives). The Tier-1 scale tests measure concurrency + drain; the opt-in
nuke replay is the real-substrate lane that now samples API RSS/V8 heap during a
seeded production-shaped history plus bounded real-cloud overlay.

## How the scale tests verify it

`test/unit/services/{workload-reconcile,preemption,job-completion}-scale.spec.ts`,
built on:

- `ConcurrencyMeter` (`test/unit/helpers/concurrency-meter.ts`) — records peak
  concurrent in-flight per labeled op.
- `measureTickDrainMs` (same file) — runs a tick under **fake timers** and returns
  the **virtual** drain time. The fake per-item op does `await sleep(D)` to model
  latency; with cap `C` over `N`, drain ≈ ⌈N/C⌉·D.
- `seedSpotWorkloads` / `seedRunningJobs` (`test/unit/helpers/seed.ts`) — seed `N`
  rows into the real `:memory:` store so the real `list*` queries + the real
  `loadWorkloadConfigs` run.

The controller-path test is `workload-reconcile-scale.spec.ts`: it seeds 2,000
due running jobs, drives the same discovery, fair selection, and in-flight path as
the live controller, and verifies all rows drain with aggregate in-flight <= 40
and virtual drain <= 120s. `workload-reconciler.spec.ts` separately locks
startup reconstruction, bounded retry-window sampling, retry preparation versus
launch, stale-revision preflight, fairness, de-duplication, failure isolation,
per-lane outcomes, and bounded retry-history hydration. The preemption and
job-completion scale specs also enter through the unified dispatcher while
isolating each path's modeled latency.

Each scale test asserts **both** invariants at 2x load:

```
expect(meter.peak(op)).toBeLessThanOrEqual(CAP)        // safety
expect(drainMs).toBeLessThanOrEqual(freshnessBudget)   // throughput
```

Verified numbers (modeled `D`): preemption-path drain ≈ **25s** ≤ 30s;
job-completion-path drain ≈ **100s** ≤ 120s SLA; production
`workload-reconcile` drain ≈ **100s** at N=2000 with aggregate in-flight 40.
The tests **regression-lock** the `cap ↔ interval/SLA ↔ N ↔ D` relationship:
lower a cap, shorten an interval, or raise `D`, and throughput goes red.

## Residual — what this does NOT guarantee

**This section is the point. Do not read a green scale test as "the system scales."**

1. **`D` is modeled, not measured.** Every cap is only as good as its assumed
   per-item latency. tcpPing's "5s" is a _timeout_, not latency; the real `D` is the
   SSH `docker inspect` round-trip (~1–3s, **guessed**). Caps are **provisional**
   until `D` is measured (prod p95 / real-cloud soak, Tier 3); recompute with the
   sizing formula when known.
2. **Modeled unit scale, not memory proof.** The unified scale test proves the
   controller work path's aggregate in-flight and virtual drain under modeled latency.
   It still does not sample real RSS/V8 heap or real provider SDK object growth.
   That proof lives in the opt-in nuke replay, which gates RSS/heap peaks and
   post-warmup slopes while real cloud work is active.
3. **Throughput here is "bounded staleness," not "real-time."** At cap=40,
   job-completion detects completion within ~100s at 2x, not within one 30s poll. If
   the product needs tighter detection, the fix is **event-push / adaptive
   concurrency / sharding** (none built) — **never a bigger cap**, which only trades
   the latency problem for the heap problem.
4. **Falling behind is a queueing signal.** If `oldestDueAgeMs` grows while
   in-flight remains capped, arrival rate exceeds service rate. The fixes are
   event-push, sharding/workers with real processing leases, or lower per-item
   latency — not raising the cap.
5. **This is not multi-process coordination.** The in-memory owner map and
   fairness cursor are safe only when one API process owns a database. Starting
   multiple replicas against the same SQLite file can duplicate external work
   and multiplies both the workload and billing caps. Distributed operation
   requires durable claims/leases plus fencing before replicas are supported.

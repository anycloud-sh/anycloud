# Reconciliation machinery

`scheduler.ts` owns disposable schedule entries, fair admission, and in-flight
slots. The workload controller owns discovery, state interpretation, deadlines,
operation errors, and post-work refresh. The scheduler imports no application
modules, including types; `reconciliation-mechanism-boundary` enforces that direction.

## Scheduler contract

- Supply a lane cycle, positive integer slot limit, clock, `key(entry)` and
  `lane(entry)` selectors, `shouldRefill()`, and `run(entry)`. Lane repetitions
  determine weight; every entry's lane must occur in the cycle. Selectors must
  be pure and stable while an entry is installed or active, including any nested
  IDs they read. `run` returns a promise and owns its error handling.
- Entries are plain objects in the controller's shape with a numeric `dueAt`.
  `replace(entry)` installs a fresh, shallow-frozen copy at the tail, even when reusing the same
  input. It returns that copy; `run`, `get`, and the `entries()` snapshot use the
  same shape. Nested domain objects are not cloned or frozen.
- Entry identity is distinct from durable workload revisions. `isCurrent`,
  `replaceIfCurrent`, and `removeIfCurrent` preserve an explicit replacement
  when older work finishes. Conditional replacement keeps the same key. Plain
  `replace`/`remove` are unconditional decisions. Neither removing nor replacing
  a schedule cancels active work or releases its slot.
- `entryCount` counts stored schedules. `hasInFlight` and `inFlightCount` report
  unsettled callbacks independently of whether their schedules still exist.
- `pump()` fills available slots with entries due at the current clock time,
  skipping active keys. Selection follows insertion order within each lane,
  carries the cycle cursor across pumps, and spills empty lanes' turns to the
  next populated lane. It returns the selected entries. `pump(keys)` restricts
  that selection for a diagnostic pass.
- A slot covers the entire callback promise, including controller refresh.
  On settlement, `shouldRefill()` decides whether to pump again; the workload
  controller supplies its existing `running` state. The controller owns startup
  and periodic timers. Stopping refill does not stop existing work.
- `waitForInFlight()` awaits the current snapshot through slot release and returns
  its settlement results. Work admitted by completion refill may still be active
  when it returns. It neither drains future registrations nor cancels work.
- `backlog()` excludes active keys from scheduled count/age, counts future entries
  as scheduled, and computes age only for due entries.

## Where to make a change

For cleanup pacing, retry eligibility, or mapping a state to work, read
[`workload-reconciler.ts`](../workload-reconciler.ts) and its
[policy tests](../../../../test/unit/services/workload-reconciler.spec.ts).
Change the classification/deadline/refresh policy there. The scheduler accepts
those policy entries directly; a change using the existing contract does not
need scheduler implementation changes.

For queue ordering, slot accounting, or completion refill, read `scheduler.ts`
and [its mechanism tests](../../../../test/unit/services/reconciliation/scheduler.spec.ts).
Use plain keys, lanes, deadlines, and deferred promises. Workload rows and
provider fixtures belong to controller/integration tests.

For promise ownership, read
[`workload-work-registry.ts`](../workload-work-registry.ts) and
[its tests](../../../../test/unit/services/workload-work-registry.spec.ts).
This single module tracks pipeline and child operations until settlement without
changing their results or errors; its count is workloads, not promises. This
lifetime can outlast a scheduler callback or foreground timeout. Test-only drain
waits for observed registrations without closing future registration. Task and
monitor callers decide which operation lifetimes to register.

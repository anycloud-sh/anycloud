# RFC 0020: Knowing when the API stopped

> Status: Rejected
> Date: 2026-08-24
> Author: Claude draft

## Summary

The API can now tell an operator it is unhealthy, but not that it is gone. Every
signal added by an earlier change is sampled, thresholded, and delivered by the API
itself, so the one failure that costs the most — a control plane that stops
entirely while cloud machines keep billing — produces silence indistinguishable
from a healthy quiet hour.

This proposes a durable liveness marker: the API records a timestamped snapshot
of its own health every minute, clears it on clean shutdown, and on boot compares
the last one against the current time. A stale marker means the previous run
ended without saying goodbye, and the snapshot beside it carries the evidence for
why. It reports unresponsiveness after the fact rather than during, which is a
real limitation and also the reason it needs no external service, no new
credential, and no configuration.

## Context

The June 2026 outage had two phases. For days the API was degraded but
alive — `list` and `status` failing against a starved event loop. Then for five and a half hours it was
simply down, while roughly $338/hr of Azure compute ran with no completion
detection, teardown, or spend controls, and 51 VMs from finished jobs kept
billing.

An earlier change addresses the first phase. `src/api/services/api-health.ts` samples four
signals every 60s — event-loop stall, heap headroom, reconcile backlog, monitor
tick liveness — and alerts through the Slack channel configured in
`notification_channels`. Its own module comment and
[`docs/platform/notifications.md`](../docs/platform/notifications.md) both state
the limit plainly: the alerts come from the affected process, so a wedged or
dead API cannot send one.

Nothing covers the second phase. The relevant properties of the deployment:

- `anycloud api start` applies `--restart unless-stopped` to a confirmed-healthy
  container (`src/cli/commands/api.ts`), so most deaths do recover on their own —
  and recover silently.
- The container mounts only `${getAnycloudDir()}:/root/.anycloud`
  (`src/cli/commands/api.ts`). There is no Docker socket, so the API cannot
  inspect its own container.
- `SQLITE_PATH` points inside that bind mount, so database rows survive container
  replacement by `anycloud api update`. Anything written to the container layer
  does not.

## Goals

- Tell the operator the control plane was unresponsive, how long for, and what
  the last healthy reading looked like.
- Stay silent when a human stopped the API deliberately.
- Add no external dependency, no stored credential, and no configuration step.

## Non-goals

- Detecting that the API is down _right now_. Nothing running inside a stopped
  process can do that; see Alternatives.
- Distinguishing a crash from a wedge. See Risks.

## Proposal

### Durable liveness marker

A monitor writes a marker every 60s containing the current time and the
watchdog's most recent sample:

```
{ at, version, heapUsedBytes, heapLimitBytes, eventLoopStallMs, reconcileBacklogMs }
```

`stopBackgroundServices` clears the marker as part of ordinary shutdown, so a
deliberate `anycloud api stop`, an `anycloud api update`, or a host shutdown that
delivers SIGTERM all leave a clean slate.

On boot, the API reads the marker before starting background services:

- **Absent** — first run, or the previous run shut down cleanly. Silent.
- **Present and stale** — the previous run ended without clearing it. Alert once
  with the gap and the snapshot.

The message names what is certain and what is inferred:

> **anycloud: API was unresponsive**
> unresponsive for 47m, from 02:01 to 02:48 UTC
> last reading before the gap: heap 96% of 12.0 GiB, event loop stalled 3.2s

Storage is one row in `_metadata`, the free-form key/value table the migration
runner always ensures, behind a repository module — raw database access is
lint-restricted to `src/api/services/repositories/`. No migration.

An earlier draft proposed reusing `notification_receipts`. That table is
constrained to scheduled-delivery receipt categories, while a proof-of-life
marker is not a delivery receipt. The draft therefore had to describe the fit
as a mild stretch; `_metadata` is the honest home for process state.

### Best-effort crash report — proposed, not built

`setupProcessHandlers` in `src/api/server.ts` already catches `uncaughtException`,
logs the stack, and allows 1000ms to flush before exiting. It additionally posts
the stack to the configured channel within that window.

This is enrichment, not a mechanism. It covers one death mode and its delivery
is unreliable: a Slack POST needs DNS, TLS, and a round trip inside a
one-second budget. What it contributes is the one thing the marker structurally
cannot produce — _what threw_. The marker reports that the API died and what its
resources looked like; only the exception handler knows the stack.

Cut before merge. It produced a second Slack message for an event the marker
already reports, duplicated a stack the log already holds, and could not be
relied on for either — a POST inside a one-second flush window lands or does
not. Its only unique contribution was naming what threw, which is available in
`anycloud api logs` at the moment anyone investigates the outage report.

Worth revisiting only if a real incident turns out to be diagnosable from the
stack and not from the log.

## Alternatives considered

**Push a heartbeat to an external dead-man's-switch service.** The API pings a
customer-configured URL (healthchecks.io, Dead Man's Snitch, Better Stack) every
60s; the service alerts on absence and posts to the customer's own Slack. This is
the only option that detects a death which never recovers, and it remains the
right answer if that case ever bites.

Parked on cost, not correctness. The configuration cannot be an environment
variable — `anycloud api start` builds a fixed `docker run` env list with no
passthrough, the same gap that forced the June recovery to hand-run `docker run`
for `NODE_OPTIONS`. Config must therefore live in the API, which means a contract
family: schemas, contract, rpc, domain, CLI. That is roughly 570 lines across 16
files, of which about 155 exist only to carry one URL. The marker covers every
death that recovers for well under half that.

It also cannot live under `notifications`. `'slack'` is welded into that
contract — `notificationChannelSchema` is `z.enum(['slack'])`, and both the save
and test request schemas hardcode `webhook: slackWebhookSchema` — so a second
channel kind requires converting those to a discriminated union across contract,
rpc, domain, store, and CLI, plus the `Notifier` interface that a heartbeat does
not implement. It would belong under `anycloud api heartbeat <url>` instead.

**Run the observer ourselves.** An AnyCloud-operated endpoint that records
heartbeats and alerts on staleness removes all customer setup. Rejected on two
grounds. It would need the customer's Slack webhook on AnyCloud infrastructure;
today that secret lives only in the customer's own encrypted database
(`src/api/services/notifications-store.ts`), and moving it to our servers is a
custody obligation the product does not currently carry. And it would be the
first stateful, availability-critical service we operate — the existing Workers
(`worker/`, `slack-worker/`) are stateless proxies with no storage bindings and
no scheduled triggers, so there is no cheap precedent to extend. It also
contradicts the owner's decision under which
the API runs locally or as a customer-owned hosted Service.

**Report from process-death hooks alone.** Handle SIGTERM, SIGINT, and
`uncaughtException` and send the alert on the way out. This catches the polite
deaths and misses every rude one. Heap exhaustion aborts through SIGABRT with no
JavaScript executed, and that is exit 134 — the mechanism that actually killed
the API in June. SIGKILL, the cgroup OOM killer, and host loss are equally
unhookable, and a wedged process is not dying at all so nothing fires. Worse,
"we alert on process death" reads as covering OOM when OOM is precisely the
unreachable case. Retained only as the enrichment described above.

**Read the container's exit code on restart.** Authoritative in principle: exit
134 is SIGABRT, 137 is SIGKILL, 143 is SIGTERM. Unavailable in practice. The API
container has no Docker socket, and even with one, `--restart unless-stopped`
restarts the same container, whose `.State.ExitCode` reads 0 once running.
Docker retains no previous exit code; `RestartCount` reports that a restart
happened, never why.

**Docker `HEALTHCHECK`.** Orthogonal and worth doing separately — the Dockerfile
has none today. It makes `docker ps` honest and gives `anycloud api status`
something real to report, but Docker restart policies react to process exit, not
to health status, so it triggers no action and sends no alert. Roughly four
lines; it belongs in its own change, not here.

## Risks & caveats

**It reports after the fact.** An API that dies and stays dead — host destroyed,
container stopped and left stopped, restart policy removed — never reports
anything, because the report is written by the successor. This is the gap the
external heartbeat would close, and the reason that alternative is parked rather
than rejected.

**It cannot distinguish death from a wedge.** A starved event loop fails to write
the marker just as a dead process does. The alert therefore says _unresponsive_
rather than _down_. This is arguably the correct framing — a control plane that
cannot run its monitors is not doing its job whatever its process state — and it
means the marker covers the wedge case that death hooks cannot.

**The snapshot is a hypothesis, not a diagnosis.** It is up to 60 seconds stale
and it describes the last moment the API was healthy enough to write, not the
moment it failed. For heap exhaustion, which climbs over minutes, that is close
to a diagnosis. For an abrupt kill it will read as unremarkable, which is itself
informative: nothing was wrong inside the process, so look outside it.

**It adds a periodic database write.** One small upsert per minute, against
monitors already doing O(N) work per tick. The watchdog's own state was
deliberately kept in memory to avoid synchronous writes on a starved loop; this
marker accepts one because it must survive the process that failed to write it.

**Two alerts for one crash.** Accepted, and noted here so it is not a surprise in
Slack.

## Open questions

- Should the boot alert respect a minimum gap before firing, so that a fast
  crash-restart cycle does not post for a five-second outage? A floor of roughly
  two sample intervals seems right, but a crash loop arguably deserves the noise.
- Should the marker also record live deployment count, so the alert can say how
  much was unmanaged during the gap? It is the number that converts downtime into
  dollars, at the cost of a query per tick.
- Does the `notification_receipts` reuse hold, or does a liveness marker deserve
  its own table once it carries a payload rather than a sentinel string?

## Decision

**Rejected for now, 2026-08-26.** The proposal was fully implemented and
reviewed, then closed without merging: reporting an outage more
precisely mattered less than proving the alerts that precede one do not cry
wolf, and the implementation itself resolved the open questions above — the
marker moved to `_metadata` (the receipts constraint made the third question
moot) and the crash report was cut as unreliable duplication.

The gap is unchanged and real: an API that stops entirely reports nothing,
because every health signal is delivered by the affected process. Revisit if an
outage goes unnoticed in practice. The finished implementation is preserved on
`depombo/api-liveness-marker`, so reopening is a rebase, not a rewrite.

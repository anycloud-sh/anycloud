# RFC 0041: Primitive-aware Workload waits for agents

> Status: Accepted
> Date: 2026-08-20 (amended and accepted 2026-10-04)
> Author: Codex draft; amended by Claude

## Summary

Add one agent-safe lifecycle primitive:

```bash
anycloud wait <id...>
```

The command infers success from the Workload type. A Job succeeds at
`Completed`; a Service or VM is ready at `Running`; and a terminal failure
exits nonzero. Job, Service, and VM submission commands gain `--wait` and use
the same implementation.

Every wait emits initial state, state transitions, a mandatory periodic
heartbeat while state is unchanged, and a final result. The heartbeat proves
that the observer is alive; it does not claim that the application is making
progress.

The agent skill ships with the command and teaches it, version-gated, together
with `logs <id> --follow` and a terminating filter for application output.

`logs --follow` gains one narrow change so it composes with waiting: it waits
through setup instead of failing before the container exists, and exits at its
next write after the reader closes the pipe. It does not resume or deduplicate after a dropped
stream.

This RFC proposes no fleet watcher, log resume or storage, tracked VM-process
API, object waiter, generic condition language, or application stall detector.
The transcript audit found those other use cases, but they do not justify
expanding this Workload-wait proposal.

## Context / problem

Claude agents create shell polling loops around AnyCloud Workloads. Those
loops parse human output, reconstruct terminal states incompletely, and
sometimes remain alive after the Workload has finished. Telling the agent to
check in every hour makes silent failure visible, but leaves completion
ownership in generated shell.

`status --watch` already exists and is a valid lifecycle observer. With an
explicit ID it is non-interactive: TTY detection changes rendering, not
whether the watch can run. Without an ID, the command may use an interactive
picker, so an agent must pass the ID.

Its observation contract is different from an automation wait:

1. It accepts one ID.
2. It prints a full status response on every poll instead of only on change.
3. It returns process exit code zero for `Completed`, `Errored`, `Failed`,
   `Invalid`, and `Terminated`.
4. A transient status API error terminates the watch.
5. It has no total timeout.
6. It stops only at a terminal state. A healthy Service or persistent VM
   reaches `Running`, which is nonterminal, so `status --watch` used as “wait
   until ready” remains attached for the Workload's lifetime.

The last point is the important primitive distinction: `status --watch` can
observe a VM until it ends, but it cannot gate automation on that VM becoming
ready. The proposal keeps that observer and adds a separate synchronization
contract.

## Evidence used for this proposal

This RFC uses a point-in-time audit of real Claude Code transcripts on one
internal Azure workstation. The snapshot covers `2026-08-18T00:00:00Z` through
`2026-08-20T14:02:07Z`:

- 107 Monitor calls across five Claude sessions;
- 89 distinct Monitor command bodies;
- Claude Code versions 2.1.233 and 2.1.234;
- Claude Opus 4.8 and Opus 5; and
- AnyCloud CLI 0.1.60, the same version as this checkout.

### Findings ranked by intended outcome

This outcome-first classification accounts for every Monitor call exactly
once. It describes what the Claude was trying to accomplish; the AnyCloud
command is supporting evidence rather than the category definition.

| Rank | Intended outcome                                          | Calls | Share | What the Claude was trying to achieve                                                                 |
| ---: | --------------------------------------------------------- | ----: | ----: | ----------------------------------------------------------------------------------------------------- |
|    1 | Gate work on a known Workload set reaching its goal       |    34 | 31.8% | Continue collection, evaluation, or another stage after Jobs settled, or after a VM became ready      |
|    2 | Observe an operational condition inside a persistent VM   |    32 | 29.9% | Reuse a prepared VM while waiting for a child process, output file/count, remote log marker, or probe |
|    3 | Discover and react to a changing Workload fleet           |    19 | 17.8% | Notice newly completed screens or newly created downstream work when membership was not fixed         |
|    4 | Surface application progress, completion text, or failure |    12 | 11.2% | Report epochs, data milestones, `done`, tracebacks, OOMs, and CUDA/NCCL errors across Jobs            |
|    5 | Wait for a signal outside Workload lifecycle ownership    |    10 |  9.3% | Observe local scripts/processes/files, object availability, or machines reached through direct SSH    |

The top two outcomes account for 66 of 107 calls, but require different
owners. The first 34 are Workload lifecycle waits and motivate this RFC. The
next 32 concern conditions inside a VM whose Workload correctly remains
`Running`; a Workload waiter cannot determine those outcomes.

The 19 fleet observers were intentionally open-ended because matching
Workloads could appear later. The 12 log observers had mixed intent: five
used Workload lifecycle as their eventual stopping condition, while seven
were persistent application-milestone relays. Separate from those Monitor
calls, the broader audit found eight Bash commands that explicitly waited for
application output.

### Monitor use-case catalog

Each of the 107 Monitor calls was assigned one mutually exclusive primary
behavior according to the resource it repeatedly observed. These counts sum to
107; they are calls, not unique commands.

| Primary behavior              | Calls | Persistent | `while true` | Observed use                                                                                     |
| ----------------------------- | ----: | ---------: | -----------: | ------------------------------------------------------------------------------------------------ |
| `list`/`ls` snapshots         |    42 |          4 |            2 | 23 finite state predicates; 19 open-ended observers of changing pipeline membership              |
| `exec` inside a running VM    |    32 |         12 |            0 | Poll remote processes, log files, output files, and readiness probes for work launched in the VM |
| `logs` snapshots              |    12 |          9 |           11 | Five lifecycle-bounded progress/error checks; seven open-ended multi-Job milestone relays        |
| `status` snapshots            |    11 |         11 |            0 | Single- and multi-Job terminal predicates rebuilt from rendered status output                    |
| Local process/file/direct SSH |    10 |         10 |            0 | Poll scripts, local processes and files, object downloads, or machines outside AnyCloud          |

`Persistent` is Monitor registration metadata, not proof that the command has
no exit predicate. For example, all 11 `status`-primary calls were persistent
but contained a finite terminal predicate. Other overlapping characteristics
across the 107 calls were:

- 88 requested a one-hour Monitor timeout;
- 46 were marked persistent;
- 83 used a bounded `for ... seq ...` polling loop;
- 13 used `while true` directly;
- 63 inspected artifact or marker counts;
- 16 inspected `ps` or `pgrep`; and
- 9 delegated to one of three external monitor scripts.

The finite Workload-state subset is 34 calls: 23 `list`-primary plus all 11
`status`-primary calls. The other calls establish adjacent monitoring needs,
but they do not have the same owner or completion condition.

Representative finite state monitors reconstructed lifecycle semantics in
shell. One waited for a rendered state word:

```bash
while true; do
  state=$(anycloud list | grep '<job>' | awk '{print $(NF-1)}')
  case "$state" in
    completed|failed|terminated) break ;;
  esac
  sleep 180
done
```

Another polled 13 explicit Job IDs, parsed `completed [exit: 0]`, and created
`/tmp/<job>.done` files to remember settled members. Agents also searched for
nonexistent `succeeded` and `cancelled` states, sometimes omitted canonical
`errored` and `invalid` states, and once matched a historical state from the
human status event log instead of the current state.

The 19 open-ended `list` monitors were materially different. They observed
dynamic workflows in which new screens or downstream relaxations could appear,
so there was no stable membership set for a finite waiter. Two finite list
monitors also resubmitted failures; that action is workflow policy rather than
waiting.

The 32 `exec`-primary monitors observed work inside persistent VMs. Typical
predicates were process disappearance or a workload-specific line in a remote
file:

```bash
out=$(anycloud exec '<vm>' \
  "pgrep -f batch_singlepoint >/dev/null && echo RUNNING || echo DONE")
```

The VM correctly remained `Running` after that child process finished, so a
Workload-state waiter cannot determine the child outcome.

Nine Monitor calls delegated to three external scripts. `monitor_combined.sh`
and `monitor_prod_recipe.sh` queried Workload state and re-fetched logs,
reported a terminal state once, but never broke their outer `while true` loops.
`wait_prep.sh` terminated when an output object appeared, but tested existence
by downloading the object repeatedly. These are concrete examples of different
completion owners hidden behind the same Monitor surface.

### How agents used `anycloud logs`

A second pass counted all 2,469 tool-command bodies in the same time window,
not just Monitor calls. It found 135 bodies containing `anycloud logs`: 123
Bash calls and 12 Monitor calls, with 127 distinct command bodies. A loop may
execute `anycloud logs` many times, so 135 is a lower bound on actual API
requests.

- Zero used native `--follow` or its `--watch` alias.
- 134 of 135 filtered a complete log response with tools such as `grep`,
  `tail`, `tr`, `sed`, or `awk`.
- Seven Bash calls explicitly waited for a log predicate using
  `until anycloud logs ... | grep -qE ...; do sleep ...; done`.
- One additional Bash call polled two Jobs until both logs contained at least
  two epoch messages.
- Of the 12 Monitor calls, five used lifecycle state as the stopping condition
  and logs only for progress or errors. Seven were open-ended multi-Job relays
  that deduplicated epochs, errors, and `done`; seeing `done` did not stop them.

Monitor notification delivery worked in the inspected open-ended run: it
notified on epoch output at 20:15 and 20:44 UTC, later delivered `done` at
21:46, and still required an explicit TaskStop at 22:02 because the shell was
`while true`. That example attributes the hang to command lifetime, not a
missing Monitor trigger.

An observed finite application-output wait had this shape:

```bash
until anycloud logs '<job>' |
  grep -qE 'POOL_MATCH_DONE|Traceback|Killed'; do
  sleep 60
done
```

Observed marker vocabularies included epoch lines, `POOL_MATCH_DONE`, relaxed
structure counts, `Traceback`, out-of-memory messages, CUDA/NCCL errors,
`Killed`, and a literal `done`. These are application contracts, not AnyCloud
Workload states. One agent also changed a workload to copy its diagnostic log
to the output bucket after finding that `anycloud logs` returned nothing once
the VM had gone away.

For one Workload, `logs --follow` plus a terminating filter can replace the
repeated full-log fetch:

```bash
anycloud logs '<job>' --follow |
  grep -m1 -E 'POOL_MATCH_DONE|Traceback|Killed'
```

That composition is not a Workload wait. The shell still owns which marker
means success or failure, a missing marker may keep the stream attached, the
current client does not reconnect a dropped stream, and `logs --follow`
supports one Workload. Bare `--follow` would turn the finite predicate into
another open-ended observer.

### Broader CLI-surface findings

These command-body counts overlap and therefore do not sum to a session total:

| Surface                | Command bodies | Machine/streaming form observed   | Representative use                                   |
| ---------------------- | -------------: | --------------------------------- | ---------------------------------------------------- |
| `anycloud exec`        |            362 | 39 launched work with `nohup`     | Foreground commands and persistent-VM child work     |
| `anycloud list` / `ls` |            180 | 1 used JSON, CSV, or `--only-ids` | Human table parsing and fleet discovery              |
| `anycloud logs`        |            135 | 0 `--follow`; 0 `--watch`         | Filtered snapshots, marker waits, and progress relay |
| `anycloud status`      |            100 | 0 `--watch`; 0 `--json`           | Human-output snapshots and state regexes             |

The current AnyCloud agent skill mentions `status`, `logs`, and `exec`, but
does not teach `status --watch` or `logs --follow`. The audit proves
non-adoption and identifies a concrete discoverability gap; it does not prove
that discoverability is the only reason agents generated polling loops.

### Evidence-to-decision mapping

| Observed evidence                                                                                                  | Implication                                                      | RFC response                                                         |
| ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- | -------------------------------------------------------------------- |
| 23 `list`-primary monitors had a finite early-stop predicate                                                       | Agents were using fleet snapshots as a waiter                    | Support explicit multi-ID `wait`                                     |
| 11 `status`-primary monitors had a finite terminal predicate                                                       | Agents were rebuilding terminal-state ownership                  | Put primitive success and failure in the CLI                         |
| One monitor polled 13 explicit Job IDs and used `/tmp/*.done` files                                                | The need is not limited to one Workload                          | Wait an explicit ID set and aggregate results                        |
| Agents used incomplete or nonexistent state names                                                                  | Generated shell should not own state vocabulary                  | Use canonical `WorkloadState` helpers internally                     |
| A VM-readiness monitor polled `list`; others repeatedly ran `exec "echo VM_READY"`                                 | Terminal-only watch does not express VM readiness                | Infer `Running` as VM/Service success                                |
| Monitor notifications arrived for epochs and `done`, but a `while true` command continued until explicitly stopped | At least this failure was command lifetime, not Monitor delivery | Make the CLI process lifetime authoritative                          |
| No audited `status` body used `--watch`/`--json`; no `logs` body used `--follow`                                   | Shipped non-interactive paths are not being adopted              | Update the agent skill with exact commands and stopping semantics    |
| Eight Bash calls waited for workload-specific log output                                                           | Application-output waiting is real but not lifecycle waiting     | Teach filtered `logs --follow`; keep marker semantics outside `wait` |
| Seven Monitor calls relayed multiple Jobs' logs indefinitely                                                       | Single-ID follow does not replace every observer                 | Record the gap without adding multi-log streaming to this RFC        |

The audit is concentrated in five sessions from one team, so these counts are
design evidence rather than global product analytics. The proposal below is
intentionally narrower than the catalog: AnyCloud should own success and
process lifetime when an agent waits on an AnyCloud Workload. Dynamic
membership, application output, and child processes have different owners and
remain explicit scope boundaries.

## Current source of truth

The desired behavior mostly exists, but is split across surfaces:

- [`watchWorkloadStatus`](../src/cli/use-cases/workload-status.ts) polls one
  Workload until [`isTerminalState`](../src/shared/workload.ts) is true.
- `TERMINAL_STATES` is exactly `Completed`, `Errored`, `Failed`, `Invalid`, and
  `Terminated`.
- The Python SDK's
  [`Job.wait`](../python/extensions/anycloud_workflows/jobs.py) returns only for
  `Completed`, raises `JobFailedError` for every other terminal state, and
  raises `WorkloadWaitTimeout` without terminating the Job.
- [`logs --follow`](../src/cli/commands/logs.ts) already streams one
  Workload's application output.

The proposal ports the SDK's Job distinction into one CLI contract and extends
it to the Running target for Services and VMs. It does not invent a new
success model.

### Command taxonomy

The commands are complementary rather than Workload-type alternatives:

| Command                     | Contract                                                                   |
| --------------------------- | -------------------------------------------------------------------------- |
| `job/service/vm ... --wait` | Submit and gate automation on primitive-specific success                   |
| `wait <id...>`              | Apply the same gate to existing Workloads                                  |
| `status <id> --watch`       | Observe lifecycle state until terminal state or interruption               |
| `logs <id> --follow`        | Stream one workload's output until the backing stream ends or interruption |

Documentation reserves **wait** for synchronization, **watch** for repeated
lifecycle observation, and **follow** for append-only output. The `logs
--watch` alias is removed rather than kept for compatibility, so each verb has
one meaning.

## Proposal

### Command surface

Add a standalone command for Workloads, node pools, Kubernetes Deployments, and
clusters that already exist. A bare ID is a Workload; the others are typed
references, as in `kubectl wait deployment/<name>`:

```bash
anycloud wait <id...> [--json] [--timeout <duration>]
anycloud wait node-pool/<id> deployment/<id> cluster/<id> train-a
```

Reuse it from the commands that create or change them:

```bash
anycloud job ... --wait
anycloud service ... --wait
anycloud vm ... --wait
anycloud deployment create ... --wait
anycloud deployment upgrade ... --wait
anycloud node-pool create ... --wait
```

`wait` accepts an explicit, stable membership set. It does not accept `list`
filters or a generic `--for` expression. An agent that already has IDs should
not need to define when a query stops admitting new members.

### Primitive-aware success

| Target                | Successful wait target                   | Failure before target                           |
| --------------------- | ---------------------------------------- | ----------------------------------------------- |
| Job                   | `Completed`                              | `Errored`, `Failed`, `Invalid`, or `Terminated` |
| Service               | `Running`                                | Any terminal state                              |
| VM                    | `Running`                                | Any terminal state                              |
| Node pool, cluster    | `Running` (Ready)                        | `Failed` or `Terminated`                        |
| Kubernetes Deployment | The Pod on the awaited revision is ready | `Failed`, a failed upgrade, or `Terminated`     |

A Deployment's awaited revision is its latest requested one, or for `deployment
upgrade --wait` the upgrade's own revision; a later upgrade also satisfies it.
A node pool's `Failed` is final for `wait` even where the pool can recover:
that is a lifecycle defect to fix, not something the waiter absorbs.

For a mixed set, each Workload uses its own target. A member already at its
target is reported immediately. The command waits until every member has
either succeeded or reached a terminal failure, then exits zero only if all
succeeded. An early failure is printed immediately, even though the aggregate
command continues to collect the remaining outcomes.

Interrupting or losing the waiter never terminates a Workload. `--timeout`
is an optional caller deadline and is not required for correctness. There is no
default total timeout because legitimate Jobs may run for days.

### Mandatory observation output

The command always emits:

1. the initial state of every Workload;
2. state transitions;
3. an aggregate heartbeat after 30 minutes without a transition; and
4. the final aggregate result, except when interrupted with Ctrl-C.

The proposed 30-minute cadence is grounded in observed agents independently
choosing 15-, 20-, 25-, and 40-minute heartbeat loops. V1 should use one
constant rather than require every agent to guess a duration. It should not
offer a quiet mode that lets a supervising Monitor receive no evidence that
the waiter is alive.

Non-TTY output is concise and line-buffered:

```text
[12:00:00] train-a queued
[12:00:00] analysis-vm provisioning
[12:04:12] analysis-vm running (ready)
[12:30:00] observing: 1 running; elapsed 30m
[13:18:41] train-a completed
[13:18:41] succeeded: analysis-vm, train-a
```

`--json` emits NDJSON records with a small stable union:

```json
{"type":"state","observedAt":"2026-08-20T12:04:12Z","ref":"analysis-vm","kind":"workload","previousState":"starting","state":"running","ready":true}
{"type":"heartbeat","observedAt":"2026-08-20T12:30:00Z","states":{"running":1},"elapsedSeconds":1800}
{"type":"result","observedAt":"2026-08-20T13:18:41Z","succeeded":["analysis-vm","train-a"],"failed":[]}
```

While a Workload is `Retrying`, its state lines and records carry the retry
facts the status API reports: the attempt number, the diagnosed cause
(capacity or quota), the target, and the window in which the next attempt is
due. The window is the backoff curve's bounds anchored to the durable retry
event, so it is honest about jitter; once its end has passed, the line says the
retry is due now.

```text
[19:29:40] perforate-tylb retrying (attempt 3, spot capacity, g5.xlarge us-east-2b; next 19:31–19:35)
```

```json
{
  "type": "state",
  "observedAt": "2026-10-02T19:29:40Z",
  "ref": "perforate-tylb",
  "kind": "workload",
  "previousState": "provisioning",
  "state": "retrying",
  "retry": {
    "attempt": 3,
    "diagnosis": "capacity-exhausted",
    "earliestAt": "2026-10-02T19:31:00Z",
    "latestAt": "2026-10-02T19:35:00Z"
  }
}
```

`observedAt` is the time this CLI observed lifecycle state. It is not
`lastProgressAt`. The heartbeat means “the observer is alive and these are the
current Workload states,” not “the workload advanced.”

### Polling, errors, and exit behavior

V1 can poll the existing contracted status API with bounded parallelism, as
`JobGroup.wait` already does. A new server streaming route is unnecessary.

Retry transient connection failures and retryable server errors with capped
backoff. Emit one observer-error line when degraded and one recovery line after
a successful poll. Authentication, authorization, validation, and not-found
errors are fatal. Observation retry must never resubmit a Workload.

The process exit contract uses distinct codes:

| Code | Meaning                                                          |
| ---: | ---------------------------------------------------------------- |
|    0 | Every Workload reached its successful target                     |
|    1 | At least one Workload reached a terminal failure                 |
|    2 | Permanent observer error (authentication, not found, validation) |
|    4 | The `--timeout` deadline elapsed; the Workloads keep running     |
|  130 | Interrupted; the Workloads keep running                          |

Code 3 stays reserved for truncated output, as in `bucket list`. `--timeout`
takes a duration such as `90s`, `30m`, or `2h`.

### Logs during setup

`logs <id> --follow` started before the container exists waits instead of
failing. While the Workload has not ended, the API reports "no live VM yet" and
"no container yet" (for a Service or Deployment on a node pool, "no Pod yet",
"Pod has not started" and "cluster unreachable") with a dedicated retryable error code and the Workload's
state; the CLI prints that reason on stderr when it changes and every 30
minutes, and connects when the container appears. A Job's `--follow` then ends
when the Job does, not when its container exits: the Job stays running until
the API records the exit (on Spot about 2.5 minutes, while it rules out a
reclaim) and stays finalizing through any final artifact sync. A recovered or
retried Job's new container is followed. The Perforated spike's 37 reconnects
were setup failures plus replays in that window. Once the Workload has ended,
and for every other logs error, such as a Deployment-targeted Job, a deleted
node pool, or a cluster that refuses access, the error is final. Output goes straight to the file descriptor, so the CLI sees the closed
pipe at its next write and `logs -f <id> | grep -m1 MARKER` leaves no process
behind.

## Agent guidance

The agent skill ships with `wait` in the same change and teaches `wait` and
`--wait` first. The skill publishes on merge rather than on release, so it
names the release that adds `wait` and keeps this guidance only for earlier
versions:

1. For one finite Job, pass an explicit ID and use
   `anycloud status <id> --watch --json`. This is non-interactive. Inspect the
   terminal JSON state; the current command's exit code does not distinguish
   success from failure.
2. Do not use `status --watch` for VM or Service readiness. It waits for
   terminal state, not `Running`.
3. Never parse human status history, list columns, or emoji for lifecycle
   automation. Use JSON and canonical state names.
4. For one Workload's application milestone, use the already-shipped
   `anycloud logs <id> --follow` with a terminating, line-buffered filter that
   matches both expected output and known failure output. Do not use bare
   `--follow` as a finite wait. The filter owns the workload-specific marker;
   the log stream does not own Workload completion.
5. A finite workload inside a persistent VM remains outside Workload wait;
   prefer a Job when practical and state the unmanaged-process limitation when
   using `nohup` today.

This guidance explains both why current `status --watch` is useful for Jobs and
why it did not solve the VM-readiness monitors found in the audit.

## What this RFC does not solve

### Application stalls or silent non-progress

AnyCloud knows Workload state and receives log bytes. It does not know
whether an epoch, output-file count, process, warning, or repeated log line is
meaningful progress. One inspected run emitted `Epoch 60` twice with different
metrics, demonstrating that an epoch label is not a universal monotonic clock.

Therefore this RFC adds no `epoch`, progress sequence, `lastProgressAt`, or
automatic stall verdict. The mandatory heartbeat detects a silent **observer**,
not a stalled application. A filtered single-ID `logs --follow` can implement
an application-owned marker wait today. Multi-ID aggregation, reconnect/resume,
and any generic stall contract require separate evidence and design.

### Dynamic fleet workflows

Nineteen list-primary monitors intentionally observed a changing set of
screens and downstream relaxations. A finite waiter cannot decide when such a
selector stops admitting new Jobs. This RFC does not add `list --watch` or
selector-based waiting.

### Detached work inside VMs

Thirty-two Monitor calls inspected child processes, files, or logs through
`anycloud exec`, and 39 recent commands launched work with `nohup`. A VM
Workload correctly remains `Running` when one such child process exits, so a
Workload waiter cannot own that outcome. A tracked execution resource may be
worth a separate RFC, but is not proposed here.

### Retry and workflow actions

At least two finite list monitors also resubmitted failures. Resubmission can
spend money or repeat side effects and must remain an explicit policy. `wait`
is observational.

## Alternatives considered

### Only update the agent skill

This should happen immediately and fixes discoverability for one finite Job.
It cannot make terminal failure nonzero, wait multiple IDs, or return when a
VM/Service reaches `Running`.

### Change `status --watch` semantics

`status --watch` currently means “observe until terminal.” Changing it to stop
at `Running` for some primitives would alter documented behavior, and changing
its terminal process exits could break existing scripts. A separate `wait`
verb gives primitive success a clear contract while leaving terminal-lifetime
observation intact.

### Add `--for` or `--until`

This makes every caller know state spelling and choose a target, recreating the
observed shell bugs. AnyCloud already knows whether a Workload is a Job,
Service, or VM and can infer its normal successful wait target.

### Use a hard default timeout

A hard deadline prevents infinite attachment but falsely fails legitimate
multi-day Jobs. Authoritative completion plus mandatory observer heartbeat
fixes invisible waiting without guessing workload duration. Callers with a
real deadline can supply one.

### Treat log activity or API heartbeats as progress

Log bytes may be repetitive or irrelevant. The native API heartbeat proves
transport connectivity only. Neither signal justifies a workload-progress or
stall claim.

## Risks & caveats

- The audit is concentrated in five sessions from one team; it grounds this
  workflow but does not measure global demand.
- A mandatory heartbeat can wake a supervising agent when nothing changed.
  Thirty minutes is a proposed balance based on actual 15- to 40-minute loops.
- Waiting for all members after one fails delays the aggregate exit, although
  the transition output surfaces the failure immediately.
- `Running` must remain an operational readiness contract. If VM exec or SSH
  can still be unavailable after `Running`, that lifecycle bug must be fixed or
  the VM target made more precise before `vm --wait` ships.
- The interim `status --watch --json` path remains noisy because it emits every
  poll and still exits zero on terminal failure.

## Verification

The implementation must cover:

- explicit-ID non-TTY operation;
- Job success and every terminal failure;
- Service and VM readiness at `Running`;
- already-settled Workloads;
- mixed and multi-ID sets;
- immediate transition output plus fake-clock-tested mandatory heartbeats;
- no output on unchanged ordinary polls;
- transient observer failure and recovery;
- permanent error, timeout, and interrupt; and
- process exit status matching the final aggregate result.

When this ships, update the CLI docs, AnyCloud skill, and changelog. Dogfood it
against sanitized versions of the observed single-Job, 13-Job, and VM-readiness
monitors. The success criterion is that those finite state monitors no longer
contain state regexes, temp marker files, or polling loops.

## Open questions

All resolved at acceptance; see the Decision.

1. ~~Heartbeat cadence~~: a fixed 30 minutes.
2. ~~Timeout format~~: a duration string (`90s`, `30m`, `2h`).
3. ~~Distinct nonzero codes~~: yes, 1, 2, 4, and 130.
4. ~~Batch status API~~: deferred; bounded parallel status calls suffice until
   explicit-ID sets regularly exceed tens of Workloads.

## Decision

**Accepted, 2026-10-04 (owner), with amendments.** The decision record also
records the alternatives the owner compared: patching existing commands only, staying
attached to a submitted Job by default, and a lifecycle event stream. This
RFC's `wait` was chosen because it gives agents one command that owns success,
failure, and process lifetime.

Amendments to the 2026-08-20 draft:

1. **Terminology.** Job, Service, and VM records are **Workloads**; the draft's
   "deployment" wording and `deploymentId` field become Workload and
   `workloadId`. Deployment now means a Kubernetes Deployment.
2. **Scope.** `logs --follow` waits through setup and exits on a closed pipe;
   log resume stays out of scope.
3. **The `logs --watch` alias is removed** instead of kept for compatibility.
4. **Retry facts** (attempt, cause, target, next-retry window) appear in
   `wait` state lines and records.
5. **Open questions** are resolved as listed above.
6. **Agent guidance** ships with `wait`, version-gated, instead of first
   teaching `status --watch --json` alone.
7. **More targets (owner, 2026-10-04).** `wait` also takes typed references to
   node pools, Kubernetes Deployments, and clusters, and `deployment create`,
   `deployment upgrade`, and `node-pool create` take `--wait`. Records name a
   target by `ref` and `kind` instead of `workloadId`. Lines also show why a
   target waits (a queued Deployment Job's `jobsAhead`, a node pool blocking a
   Service) and why a Workload ended early (`reason`). Deletions are not
   waited on: `wait` treats `Terminated` as failure, and no evidence yet shows
   agents waiting for deletion.

Companion changes ship in the same pull request but are not part of this
decision: `status` shows the retry window, Spot checkpoint health from the
bucket, `finished, exit 0` for successful Jobs, and a runnable quota hint.

`retry` describes the VM-host retry window only; Jobs on a Deployment and
Services on a node pool retry on their own paths and report no window. A
Deployment reports `failed` while Kubernetes still retries a crashing
container, so `wait` fails fast there until a later change reports it as `starting`.

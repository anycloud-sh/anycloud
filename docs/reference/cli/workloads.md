---
title: Workload operations
description: Inspect and operate Job, Service, and VM workload records.
---

# Workload operations

These commands inspect and operate the shared workload records behind Jobs,
Services, and VMs.

## `anycloud status`

```bash
anycloud status [id]
anycloud status <id> --watch
anycloud status <id> --history
anycloud status <id> --json
```

| Option                | Description                                |
| --------------------- | ------------------------------------------ |
| `--verbose`           | Show detailed events and error information |
| `--history`           | Show every event and Service upgrade       |
| `-w, --watch`         | Poll until a terminal state                |
| `--interval SECONDS`  | Watch interval; default `5`, minimum `1`   |
| `-p, --period WINDOW` | Picker window, such as `7d` or `24h`       |
| `-n, --limit COUNT`   | Picker limit; default 200, maximum 1,000   |
| `--json`              | Raw `StatusResponse` JSON                  |

Status returns the 200 most recent events by default and reports how many
earlier events are hidden. For a Service that has been upgraded, human-readable
status also shows only the latest upgrade section and reports how many earlier
workload versions are hidden. Pass `--history` to fetch every event and show
the initial workload and every upgrade in chronological order. JSON keeps a
flat `events[]` array in every mode.

JSON contains `workload`, `vms[]`, `events[]` (the most recent 200 unless
`--history` is passed), and `eventsTotal`, the full event count. The workload's
`completedAt` is when its terminal outcome became known, and `endReason` why
it ended ([values](../../platform/jobs.md#lifecycle)), with
`lastAttemptEndReason` when retries ran out. `cleanedAt` is null
while provider resources are still being released and becomes the teardown
confirmation time afterward; while it is null, `cleanupError` carries the
reason the last cleanup attempt did not finish (the text output shows it as
`Cleanup pending`), and it is cleared when cleanup completes. Each VM's independent `endedAt` is its compute
spend cutoff. With `--watch --json`, stdout is newline-delimited JSON with one
response per poll.

`workload.gpuType` is the GPU alias the request named with `--gpu-type`, not
the hardware. It is `null` when `--vm-type` chose the VM, even a GPU VM.
`workload.vmType` is the VM type, or ordered fallback list, the request named;
each `vms[].vmType` is the type that VM launched as (absent on VMs recorded
before 0.1.23), which the text output shows after its address.
`anycloud vm-types <cloud> <region> --details` lists a type's accelerators.

On a VM, the `running` event's `metadata.bootMarks` says when each step of
the host's start happened, in seconds after its kernel started, such as
`network-online`, `docker-ready`, `pull-end`, `api-ssh` and
`container-started`; `pull-bytes` is the bytes the host's own pull fetched.
Only a CPU VM Job's host records marks, as its user data installs Docker and
pulls a public image. Marks a host didn't record are absent. Azure can hand
over a VM it booted ahead of time, so the marks from `cloud-init-network` on
can include minutes the VM waited before it was yours. On Azure, measure from
`cloud-init-network` rather than from the kernel's start.

While a Job, Service, or VM is `retrying`, JSON includes
`retry`: the `attempt` number and the `earliestAt` and `latestAt` times between
which the next attempt is due.
The text output shows the same window and, when the provider reported one, a
capacity or quota cause:

```text
→ Attempt 3, next 19:31–19:35: Spot capacity unavailable (g5.xlarge, us-east-2b). Automatic.
→ Run: anycloud quota status --region us-east-2 --spot
```

Times are UTC, like the event log. Once the window has passed, the line says
the retry is due now; a retry can wait longer, for example while credentials
are paused.

A workload with a checkpoint bucket reports `checkpoint`: the `bucket`, its
`mount` path (`/mnt/checkpoint`), and whether it is `retained` after the
workload or deleted at cleanup. While the workload is live, `checkpoint.health`
summarizes what has reached the bucket: `objects`, `bytes`, the newest
`lastModifiedAt`, and `truncated` when the bucket holds more than one listing
page (1,000 objects), in which case the counts are lower bounds. Health is read
from the bucket at most once a minute and is omitted when the listing fails.

A Job whose container exited with code 0 shows `✓ container finished, exit 0`.
Non-zero exits, out-of-memory kills, and any Service exit show `✗`.

### GPU health

On a running Job, Service, or VM on its own NVIDIA GPU VM, status reads each
GPU's health from the host and reports it per VM as `vms[].gpu`. It shows what
the GPU and its driver report, and never resets, reboots, or replaces anything:

```text
✗ gpu          GPU 1 needs a reset (Xid 154 at 2026-11-08T01:02:03.000Z)
```

- `state` is `unhealthy` when a GPU needs a reset: `nvidia-smi` reports Reset
  Required, Drain and Reset Recommended, a pending row remap, or a GPU
  Recovery Action, or the kernel logged one of these Xid errors this boot:
  48, 64, 74, 79, 95, 109, 119, 120 or 154. It is also `unhealthy`
  when `nvidia-smi` has not answered for 30 seconds, until it answers again.
  The Xids count even when `nvidia-smi` fails, as it does once a GPU falls off
  the bus. An unhealthy GPU makes the workload's `status` `down`. An Xid
  counts until the VM reboots, so a GPU reset by hand still reads unhealthy
  until then.
- `state` is `unknown` when the GPU could not be read: `nvidia-smi` failed
  with no such Xid or has not answered yet, or the kernel journal was
  unreadable. An unknown GPU leaves `status` unchanged. `nvidia-smi` runs on
  the host apart from any one read, one at a time, and status reports its
  latest answer from the last two minutes.
- `gpus[]` lists each GPU's `index` (null for a GPU `nvidia-smi` no longer
  lists), `pci` address, `resetRequired`, `recoveryAction`, and its latest
  Xids this boot (`code`, `at`, the driver's `message`, and `resetNeeded`):
  up to five that need a reset and five others. Other Xids, such as 63 (a
  row remap recorded) and 94 (a contained ECC error), are listed without
  making the GPU unhealthy.

The check sees only what the driver reports. A GPU that stalls without an Xid
error or a reset flag, for example a kernel that hangs at full utilization,
still reads as healthy. A workload reads its GPUs only when every VM type it
may run on has an NVIDIA GPU.

## `anycloud wait`

```bash
anycloud wait <id...> [--json] [--timeout DURATION]
anycloud wait cluster/<id>
```

Waits until every target succeeds. A bare ID is a Workload; prefix a cluster ID
with `cluster/`.

| Target         | Succeeds when           |
| -------------- | ----------------------- |
| Job            | it reaches `completed`  |
| Service, VM    | it reaches `running`    |
| `cluster/<id>` | it is Ready (`running`) |

Any other final state is a failure. `job`, `service`, and `vm` accept `--wait`
to make the change and wait in one command.

| Option               | Description                                                  |
| -------------------- | ------------------------------------------------------------ |
| `--json`             | One JSON record per line                                     |
| `--timeout DURATION` | Stop waiting after `90s`, `30m`, `2h`, and so on; no default |

`wait` prints the initial state of each target, then one line whenever its
state or the reason it is waiting changes, and the final result. A Job that
ended early shows the reason, such as `max retries (3) reached`. After 30 minutes without a change it prints a
heartbeat, so a supervising script or agent can tell that the wait is still
alive. A retrying workload's line includes its attempt, cause, and next-retry
window:

```text
[19:29:40] train-a retrying (attempt 3, Spot capacity unavailable, g5.xlarge us-east-2b; next 19:31–19:35)
[19:35:51] train-a running
[20:05:51] observing: 1 running; elapsed 36m
[20:41:18] train-a completed
[20:41:18] succeeded: train-a
```

With `--json`, each line is a record with a `type` of `state`, `heartbeat`,
`observer`, or `result`, and an `observedAt` time. `state` records carry
`ref` (the target as given), `kind` (`workload` or `cluster`), `previousState`, `state`, `ready` when a target that runs is ready,
`exitCode` for a failed Job when known, `endReason` and
`lastAttemptEndReason` once a Workload ends, `reason` for a Workload that ended
early, `message` for why a target is waiting, and `retry` while
retrying. `retry`
holds `attempt`, `earliestAt`, `latestAt`, and, when the provider reported a
capacity or quota cause, its `diagnosis` (such as `capacity-exhausted`) and
`target` (VM type and zone or region). The `result` record has an `outcome`
(`succeeded`, `failed`, `timeout`, or `observer-error`) and lists the
`succeeded`, `failed`, and `pending` references. Ctrl-C exits without a `result`
record. With `--wait` on a create or upgrade command,
`--json` first prints the created or upgraded resource as one line, then the
wait records.

Exit codes:

| Code  | Meaning                                                                  |
| ----- | ------------------------------------------------------------------------ |
| `0`   | Every workload reached its target                                        |
| `1`   | A workload reached a final state other than its target                   |
| `2`   | The wait could not observe a workload: not found, not authorized, no API |
| `4`   | The timeout elapsed                                                      |
| `130` | Interrupted with Ctrl-C                                                  |

Usage and sign-in errors also exit `2`. With `--wait` on a create or upgrade
command, a request that fails exits `1` before any waiting starts.

Waiting never changes what it waits on; after a timeout or Ctrl-C everything
keeps running. Temporary API errors are retried, with one line when
observation degrades and one when it recovers.

Use **wait** to continue only after workloads succeed, **status --watch** to
observe one workload until it ends, and **logs --follow** to stream output.

## `anycloud list`

Alias: `anycloud ls`.

```bash
anycloud list [options]
anycloud job list [options]
anycloud service list [options]
anycloud vm list [options]
```

The resource commands print only their own workload type and accept `ls`
as an alias. They use the same filters, limits, session scope, and output
formats as `anycloud list --type TYPE`, and print directly without a view
picker. Their type is fixed, so they do not accept `--type`.
Put listing options after the subcommand, for example
`anycloud job list --status running -n 400`.

| Option                | Description                                                             |
| --------------------- | ----------------------------------------------------------------------- |
| `-f, --filter TEXT`   | Substring over ID, type, image, cloud, region, state, session, or agent |
| `--status STATE`      | Exact state                                                             |
| `--type TYPE`         | Exact type: `job`, `service`, or `vm`                                   |
| `--credentials NAME`  | One named credential                                                    |
| `--user USER`         | One GitHub username or account ID                                       |
| `--session ID`        | Session ID, prefix, label, or `agent:hash`                              |
| `--agent NAME`        | Agent name                                                              |
| `-p, --period WINDOW` | Start-time window                                                       |
| `-n, --limit COUNT`   | Default 200, maximum 1,000                                              |
| `--json`              | Compact JSON array                                                      |
| `--csv`               | Header plus one row per workload                                        |
| `--only-ids`          | One workload ID per line                                                |

A bare interactive command opens a summary picker. Any filter or
machine-readable flag prints directly. Non-interactive agent
invocations default to their own detected session; an explicit `--session` or
`--agent` overrides that cooperative scope.

On a hosted API shared with other GitHub users, the listing covers everyone's
workloads. When the returned rows include another account's work, it adds a
`USER` column naming each creator even if that account is the result's only
creator. The interactive summary offers "by user" when several creators are
present. Narrow to one person with `--user`, which accepts a username or an
account ID. An account ID still matches work submitted before a username
change; the username does not, because it is recorded once at submit time.

Human-readable, JSON, and CSV output use Service terminology. Machine-readable
rows identify Services with `workloadType: "service"`.

## `anycloud exec`

```bash
anycloud exec [id] "<command>"
```

The command runs non-interactively under `/bin/sh` in the workload's
container, prints its output, and exits with its exit code. On VM-host
providers it runs over the API's SSH transport.

## `anycloud logs`

```bash
anycloud logs [id] [--follow]
anycloud logs <id> --follow | grep -m1 -E 'DONE|Traceback'
```

| Option         | Description                                        |
| -------------- | -------------------------------------------------- |
| `-f, --follow` | Stream new output, waiting for the container first |

`--follow` started before the workload's container exists waits for it,
printing why on stderr (for example
`Workload is queued; its container is not running yet. Waiting…`) when that changes and every 30 minutes, and
streams once the container runs. For a Job, it ends when the Job does: after
the container exits it prints `Container exited; waiting for the Job to
finish…` until the API records the exit and finishes any final artifact sync
(usually under a minute; about 2.5 minutes on Spot, while it rules out a
reclaim), so a reconnect never replays the log. If the Job is recovered or
retried instead, it prints `Job is <state>; waiting for its next container…`
and follows the new container once it runs. If the workload ends before its
container starts, the command fails with the logs error. Output stops at the
next line after the reader exits, or, once a Job's container has exited, when
the Job ends, so the second example ends soon after the first match. To wait for a workload's outcome rather than its output, use
[`anycloud wait`](#anycloud-wait).

Logs stream from the workload's Docker container.

## `anycloud ssh`

```bash
anycloud ssh [id]
anycloud ssh <id> --host
anycloud ssh <id> --vm
anycloud ssh <id> --snapshot
```

The default opens a shell inside the workload container. `--host` opens the
underlying host; `--vm` is its compatibility alias. `--snapshot` commits an
exited container and opens a shell in the snapshot. A stopped VM container is
never bypassed with an implicit host shell, and VMs do not support `--snapshot`.

## `anycloud terminate`

Terminate one or more workloads and clean up their cloud resources:

```bash
anycloud terminate [ids...]
```

With no ID in a terminal, choose workloads interactively.

## `anycloud resubmit`

Put eligible terminal workloads back in the queue:

```bash
anycloud resubmit [ids...]
```

VM-backed Jobs reuse their original container configuration; Services reuse
their current configuration.

VMs cannot be resubmitted; use `anycloud vm <image>` to create a new host.

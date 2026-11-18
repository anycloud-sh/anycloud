---
title: Spend commands
description: Exact syntax for cost reporting, live throttles, period budgets, and combined headroom.
---

# Spend commands

## `anycloud cost`

```bash
anycloud cost [workload-id] [options]
```

| Option                | Description                                  |
| --------------------- | -------------------------------------------- |
| `-p, --period PERIOD` | Whole days from `1d` to `90d`; default `30d` |
| `--session ID`        | Session ID, prefix, label, or `agent:hash`   |
| `--agent NAME`        | One detected agent                           |
| `--user USER`         | One GitHub username or account ID            |
| `--json`              | Compact cost report                          |

Without an ID, the report includes Jobs, Services, and VMs. A
long-running Service or VM overlapping the window is included even if it started
earlier, with duration and cost clipped to the overlap. Aggregate JSON includes
`totalJobs`, `totalServices`, `totalVms`, and Job / Service / VM counts in each
`byProvider`, `byAgent`, and `byUser` entry.

On an API shared with other GitHub users, the report covers the whole API and
adds a per-user table, so a shared total is not mistaken for one person's spend.
`--user` narrows to one account and accepts a username or an account ID; the ID
also matches work submitted before a username change, which the username does
not, because it is captured once at submit time. The human-readable per-user
table still appears when a teammate is the window's only contributor and is
omitted only when all reported spend belongs to the caller.

Cost follows provisioned VM lifetimes: accrual starts when a VM is created and
stops at its `endedAt` cutoff. A workload's `completedAt` is its outcome
timestamp and neither selects nor caps cost reporting.

With `--session`, the report also charges each Job on a Deployment for its slot
time: the replica's share of its node pool Node's hourly price, divided by
`--max-concurrent-jobs-per-replica`, for as long as each attempt runs. Without
`--session`, the report leaves this time out; the node pool VM's cost counts
toward account spend caps and `anycloud spend show`.

Billing reconciliation uses the compute credential recorded on each VM attempt.
Malformed unrelated SSH, storage, container payloads, or requested placement
settings no longer prevent available provider costs from settling. Missing
required workload or container-spec structure and unusable compute credentials
still leave the affected costs unsettled; other billing groups continue.

Billing processes historical work in small batches while keeping each resource's
credential group together. One billing query covers every group in a batch that
shares a credential, and each group's costs commit as one unit; an interruption
leaves a group fully saved or ready to retry, preserving its cost allocation. A
batch the provider rejects as malformed is retried one group at a time. One
unusually large group can still delay requests.
A group stops being queried a week after its last VM ended or its owner
finished or was deleted, whichever is later. A credential the billing API
rejects with 429 waits until the next hourly run. VMs left unbilled keep
showing their estimated cost.

Window reports are aggregated in SQLite and are not capped by workload
count. Their response size depends on provider, agent, and user cardinality
rather than the number of matching workloads; session, agent, and user filters
scope the accounting rather than prevent a partial or rejected total.

## `anycloud throttle`

```bash
anycloud throttle set [usd-per-hour] [--agent-session]
anycloud throttle show
anycloud throttle unset [--agent-session]
```

| Option            | Description                                                |
| ----------------- | ---------------------------------------------------------- |
| `--agent-session` | Set or remove an independent cap for each detected session |

Throttle gates a candidate when estimated running VM dollars per hour plus the
candidate is greater than or equal to the cap. Running workloads continue.

## `anycloud budget`

```bash
anycloud budget set [usd] --per <day|week|month> [--agent-session]
anycloud budget show
anycloud budget unset --per <day|week|month> [--agent-session]
```

| Option            | Description                                    |
| ----------------- | ---------------------------------------------- |
| `--per PERIOD`    | Required UTC window: `day`, `week`, or `month` |
| `--agent-session` | Set or remove a per-session budget             |

## `anycloud spend`

```bash
anycloud spend show [--json]
```

`--json` adds `percentUsed` and `headroomUsd` fields and omits terminal bars
and color.

On an API shared with other GitHub users, human-readable `anycloud spend show`
prefixes each agent-session row with the account that ran it, so a session
consuming the shared cap says whose run it is. The prefix is omitted when every
session in that cap section belongs to the same account. Work submitted without
an agent session has no row here; `anycloud cost` reports that spend per user.

See [Spend Controls](/platform/spend-controls) for dispatch behavior and scope.

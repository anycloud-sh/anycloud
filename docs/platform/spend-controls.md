---
title: Spend Controls
description: Gate new workloads with live burn-rate throttles and daily, weekly, or monthly budgets.
---

# Spend Controls

Spend Controls bound how quickly queued work can consume cloud resources.
They are separate from Notifications: controls change dispatch behavior, while
[Notifications](/platform/notifications) report activity.

Controls never kill a running Job or Service. They decide whether a queued
workload may begin provisioning.

| Guardrail | Purpose                    | Measurement                     | Clears           |
| --------- | -------------------------- | ------------------------------- | ---------------- |
| Throttle  | Limit concurrent burn rate | Estimated live dollars per hour | As VMs finish    |
| Budget    | Limit spend in a period    | Settled plus estimated spend    | At the UTC reset |

## Start with both controls

For an autonomous coding-agent session:

```bash
anycloud throttle set 20 --agent-session
anycloud budget set 200 --per day --agent-session
anycloud spend show
```

Add account-wide controls to bound all human and agent activity:

```bash
anycloud throttle set 100
anycloud budget set 3000 --per month
```

Account and per-session controls coexist; every applicable control is checked.

## Throttle live burn rate

Before dispatch, the scheduler compares:

```text
estimated running VM $/hr + candidate VM $/hr >= throttle cap
```

If true, the workload remains queued. The scheduler checks again every few
seconds and dispatches automatically when the live cost falls far enough below
the cap to accommodate the workload.

```bash
anycloud throttle set 20
anycloud throttle show
anycloud throttle unset
```

The candidate is pre-charged to prevent several queued Jobs from all passing
against the same pre-burst rate. If the candidate cannot be priced, the
throttle falls back to the current live rate.

## Budget a UTC period

Budgets compare settled cloud billing data plus estimated unsettled VM cost
against a calendar window:

```bash
anycloud budget set 100 --per day
anycloud budget set 500 --per week
anycloud budget set 2000 --per month
anycloud budget show
```

Windows reset at:

- Day: `00:00 UTC`
- Week: Monday `00:00 UTC`
- Month: the first day at `00:00 UTC`

Daily, weekly, and monthly budgets can coexist at account and agent-session
scope. A budget does not pre-charge the candidate, so a small amount of
overshoot is possible before the next scheduler check.

## When a cap is reached

`anycloud job` still returns a workload ID. The workload remains
`queued`, and `status` or `list` reports the binding cap and, for a budget, its
next reset:

```bash
anycloud status <workload-id>
anycloud list --status queued
```

If Slack Notifications are configured, Anycloud sends one waiting-on-cap alert
when a control begins blocking and at most one reminder every six hours while
it remains blocked.

## Agent-session scope

The CLI recognizes Claude Code, Codex, Cursor, and Aider sessions and tags
their workloads. Each `--agent-session` control is counted separately, so
one session reaching its limit does not block another.

Interactive terminal submissions have no agent session and therefore are not
covered by session-only controls. Pair them with account-wide controls when
you also need a global ceiling.

Use structured output to inspect remaining headroom:

```bash
anycloud spend show --json
```

See [Spend command reference](/reference/cli/spend) for exact scopes, filters,
and output fields.

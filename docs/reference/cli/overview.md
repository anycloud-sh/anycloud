---
slug: /reference/cli-reference
title: CLI Reference
sidebar_label: Overview
description: Command index and shared conventions for the Anycloud command-line interface.
---

# CLI Reference

Use this index to choose a command group. Each child page contains exact syntax,
options, defaults, and machine-readable output behavior.

Commands that take a workload ID (`status`, `exec`, `logs`, `ssh`,
`terminate`, and `resubmit`) let you omit it in an interactive terminal and
pick a recent workload. In CI or a pipe, pass the ID or set
`ANYCLOUD_WORKLOAD_ID`.

Commands that render tables generally accept `--json`. Human prompts and
progress go to stderr so structured stdout stays pipeable.

Commands exit `0` on success and `1` on failure. Some commands also use these
codes, which scripts can rely on:

| Code  | Meaning                                    | Commands                                       |
| ----- | ------------------------------------------ | ---------------------------------------------- |
| `1`   | A waited workload failed                   | `wait`, and `job`/`service`/`vm` with `--wait` |
| `2`   | The wait could not observe a workload      | `wait`, `--wait`                               |
| `3`   | The listing stopped at its limit           | `bucket list`                                  |
| `4`   | The wait timed out; workloads keep running | `wait`, `--wait`                               |
| `130` | Interrupted with Ctrl-C                    | Long-running commands                          |

| Task                                     | Reference                                                                                                               |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Create and list finite Jobs              | [`job`](/reference/cli/job)                                                                                             |
| Create, list, or upgrade Services        | [`service`](/reference/cli/service)                                                                                     |
| Create and list persistent VMs           | [`vm`](/reference/cli/vm)                                                                                               |
| Create the cluster and its node pools    | [`cluster`](/reference/cli/cluster) and [`node-pool`](/reference/cli/node-pools); guide: [Clusters](/platform/clusters) |
| Create and manage Kubernetes Deployments | [`deployment`](/reference/cli/deployments)                                                                              |
| Inspect, wait on, and operate workloads  | [Workload operations](/reference/cli/workloads)                                                                         |
| Browse hardware and prices               | [Catalog and pricing](/reference/cli/catalog-pricing)                                                                   |
| Inspect or request provider quota        | [`quota`](/reference/cli/quota)                                                                                         |
| Manage object storage                    | [`bucket`](/reference/cli/bucket)                                                                                       |
| Manage cloud accounts                    | [`credentials`](/reference/cli/credentials)                                                                             |
| Manage write-only values                 | [`secrets`](/reference/cli/secrets)                                                                                     |
| Inspect cost and configure caps          | [Spend commands](/reference/cli/spend)                                                                                  |
| Configure Slack notifications            | [`notifications`](/reference/cli/notifications)                                                                         |
| Manage the API, login, docs, and DB      | [`api` and utilities](/reference/cli/api-utilities)                                                                     |

Use `anycloud job list`, `anycloud service list`, or `anycloud vm list` for
one workload type. Each accepts `ls` as an alias. `anycloud list` shows
the combined overview. Filter Deployments by node pool with
`anycloud deployment list --node-pool <id-or-name>` and Jobs by Deployment with
`anycloud job list --deployment <id>`.

Put listing options after `list` or `ls`. Those bare names are reserved as
subcommands. To launch an image named `list` or `ls`, include a tag such as
`list:latest`.

The headings below preserve links to sections in the former single-page CLI
reference.

## `anycloud job`

See [`job`](/reference/cli/job).

## `anycloud service`

See [`service`](/reference/cli/service).

## `anycloud vm`

See [`vm`](/reference/cli/vm).

## `anycloud cluster` and `anycloud node-pool`

See [`cluster`](/reference/cli/cluster) and [`node-pool`](/reference/cli/node-pools).

## `anycloud deployment`

See [`deployment`](/reference/cli/deployments).

## `anycloud images`

See [Catalog and pricing](/reference/cli/catalog-pricing#anycloud-images).

## `anycloud status`

See [Workload operations](/reference/cli/workloads#anycloud-status).

## `anycloud wait`

See [Workload operations](/reference/cli/workloads#anycloud-wait).

## `anycloud list`

See [Workload operations](/reference/cli/workloads#anycloud-list).

## `anycloud exec`

See [Workload operations](/reference/cli/workloads#anycloud-exec).

## `anycloud logs`

See [Workload operations](/reference/cli/workloads#anycloud-logs).

## `anycloud ssh`

See [Workload operations](/reference/cli/workloads#anycloud-ssh).

## `anycloud terminate`

See [Workload operations](/reference/cli/workloads#anycloud-terminate).

## `anycloud resubmit`

See [Workload operations](/reference/cli/workloads#anycloud-resubmit).

## `anycloud cost`

See [Spend commands](/reference/cli/spend#anycloud-cost).

## `anycloud throttle`

See [Spend commands](/reference/cli/spend#anycloud-throttle).

## `anycloud budget`

See [Spend commands](/reference/cli/spend#anycloud-budget).

## `anycloud spend`

See [Spend commands](/reference/cli/spend#anycloud-spend).

## `anycloud db query`

See [`api` and utilities](/reference/cli/api-utilities#anycloud-db-query).

## `anycloud db schema`

See [`api` and utilities](/reference/cli/api-utilities#anycloud-db-schema).

## `anycloud docs`

See [`api` and utilities](/reference/cli/api-utilities#anycloud-docs).

## `anycloud regions`

See [Catalog and pricing](/reference/cli/catalog-pricing#anycloud-regions).

## `anycloud vm-types`

See [Catalog and pricing](/reference/cli/catalog-pricing#anycloud-vm-types).

## `anycloud gpus`

See [Catalog and pricing](/reference/cli/catalog-pricing#anycloud-gpus).

## `anycloud pricing`

See [Catalog and pricing](/reference/cli/catalog-pricing#anycloud-pricing).

## `anycloud bucket`

See [`bucket`](/reference/cli/bucket).

## `anycloud credentials`

See [`credentials`](/reference/cli/credentials).

## `anycloud secrets`

See [`secrets`](/reference/cli/secrets).

## `anycloud notifications`

See [`notifications`](/reference/cli/notifications).

## `anycloud api`

See [`api` and utilities](/reference/cli/api-utilities#anycloud-api).

## `anycloud login`

See [`api` and utilities](/reference/cli/api-utilities#anycloud-login).

## `anycloud update`

See [`api` and utilities](/reference/cli/api-utilities#anycloud-update).

## `anycloud quota status`

See [`quota`](/reference/cli/quota#anycloud-quota-status).

---
title: service
description: Exact syntax and options for creating, listing, and upgrading Services.
---

# `anycloud service`

Run, list, and upgrade long-running HTTP Services.

```bash
anycloud service [image] [-- command...] [options]
```

The Service container must listen on `0.0.0.0:$PORT`. `PORT`
defaults to `8088` and can be overridden with `--env PORT=9000`. When the
selected VM-backed provider supplies public ingress, the response includes
`https://<id>.anycloud.sh`.

Omitting the image in an interactive terminal opens the GHCR image picker. In
CI or another non-interactive shell, pass the image as the first argument.

The bare names `list` and `ls` select listing. To launch an image with either
name, include its tag, for example `anycloud service list:latest`.

## `anycloud service list`

```bash
anycloud service list [options]
anycloud service ls --status running
anycloud service list -n 400 --json
```

List only Services, using the same filters, limits, automatic agent session
scope, and JSON/CSV/ID output as
[`anycloud list`](/reference/cli/workloads#anycloud-list). The command prints
directly without a view picker. Put listing options after `list` or `ls`.
The type is fixed; `--type` is not accepted.

<span id="options"></span>

## Creation options

| Option                                  | Description                                          |
| --------------------------------------- | ---------------------------------------------------- |
| `-i, --id ID`                           | Custom Service ID and URL prefix                     |
| `-e, --env KEY=VALUE`                   | Environment value; repeatable                        |
| `--env-file FILE`                       | Load a dotenv file                                   |
| `--secret NAME`                         | Inject a named Secret; repeatable                    |
| `--credentials NAME`                    | Select a compute credential                          |
| `--region REGION`                       | Pin a compute region                                 |
| `--vm-type TYPE`                        | Exact VM; repeat for an ordered fallback pool        |
| `--gpu-type TYPE`                       | GPU model/count; repeat for an ordered fallback pool |
| `--disk-size GB`                        | Root disk capacity                                   |
| `--disk-tier TIER`                      | `medium`, `high`, or `ultra`                         |
| `--zone ZONE`                           | Availability zone                                    |
| `--checkpoint-bucket NAME`              | Existing bucket mounted at `/mnt/checkpoint`         |
| `--checkpoint-storage-credentials NAME` | Separate AWS credential for the checkpoint bucket    |
| `--checkpoint-storage-region REGION`    | Checkpoint bucket region                             |
| `--gpus VALUE`                          | Docker GPU exposure                                  |
| `--shm-size SIZE`                       | Docker shared memory                                 |
| `--memory LIMIT`                        | Docker memory limit                                  |
| `--cpus COUNT`                          | Docker CPU limit                                     |
| `--runtime RUNTIME`                     | Docker runtime                                       |
| `--ipc MODE`                            | Docker IPC mode                                      |
| `--ulimit VALUE`                        | Docker ulimit; repeatable                            |
| `--bind BIND...`                        | Host bind mounts                                     |
| `--wait`                                | Wait until the Service is running                    |

`--wait` submits, prints the ID, then waits like
[`anycloud wait`](/reference/cli/workloads#anycloud-wait) until the Service is
running.

`--spot` and input/output buckets are not supported for Services. Checkpoint
buckets work on VM-backed Services; the bucket must already exist and remains
user-owned. A checkpointed Service requires a selected compute credential, and
the compute identity supplies bucket access by default. Select a separate AWS
credential with `--checkpoint-storage-credentials NAME` for S3 on another
account or compute provider, including Lambda. The API renews temporary bucket
credentials while it is available; uploads pause after expiry if renewal cannot
reach the VM. See [Service storage](/platform/services#separate-s3-checkpoint-credentials)
for permissions and recovery behavior.

```bash
anycloud service ghcr.io/acme/api:v1 \
  --id model-api \
  --credentials my-aws \
  --vm-type t3.medium
```

## `anycloud service upgrade`

Replace a running Service's backing workload while preserving its workload ID
and, when present, public URL. A Service in any other state is refused:

```bash
anycloud service upgrade <id> <image> [options] [-- command...]
```

```bash
anycloud service upgrade model-api ghcr.io/acme/api:v2 \
  -- python -m myapp
```

Upgrade reuses the existing Service configuration. Along with the new image and
optional container command, it accepts these runtime changes:

| Option                | Description                                                 |
| --------------------- | ----------------------------------------------------------- |
| `-e, --env KEY=VALUE` | Add or replace an environment value; repeatable             |
| `--env-file FILE`     | Merge values from a dotenv file; `--env` takes precedence   |
| `--bind BIND...`      | Replace the complete bind list; include every mount to keep |

Omitted environment keys and mount options remain unchanged. Pass all desired
mounts when using `--bind`; it replaces the list rather than appending. Named
Docker volumes and host paths refer to the replacement VM, so their old contents
must be preserved separately.
Compute placement, Secrets, and checkpoint storage remain as
configured when the Service was created.

```bash
anycloud service upgrade model-api ghcr.io/acme/api:v2 \
  --env MODE=production \
  --bind model-api-data:/data model-api-workspaces:/workspace
```

The endpoint has downtime while the workload is replaced. When a VM-backed
Service has a checkpoint bucket, upgrade stops the workload, completes a final
upload, then removes the old VM; the new VM restores the bucket before startup.

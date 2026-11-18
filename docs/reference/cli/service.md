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
The type is fixed; `--type`, `--deployment`, and `--watch` are not accepted.

<span id="options"></span>

## Creation options

| Option                                  | Description                                          |
| --------------------------------------- | ---------------------------------------------------- |
| `-i, --id ID`                           | Custom Service ID and URL prefix                     |
| `-e, --env KEY=VALUE`                   | Environment value; repeatable                        |
| `--env-file FILE`                       | Load a dotenv file                                   |
| `--secret NAME`                         | Inject a named Secret; repeatable                    |
| `--node-pool ID-OR-NAME`                | Run on a node pool in the cluster                    |
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

### Services on a node pool

`--node-pool <id-or-name>` runs the Service on an existing
[node pool](/reference/cli/node-pools) in the cluster instead of
on its own VM host. The node pool owns the provider, credential, region, zone
and VM type, so `--credentials`, `--region`, `--vm-type`, `--gpu-type`,
`--zone`, `--disk-size` and `--disk-tier` are rejected, as are checkpoint
buckets and checkpoint storage credentials in this release. Environment values,
named Secrets, the command, and the Docker runtime options (`--memory`,
`--cpus`, `--shm-size`, `--bind` for anonymous volumes) apply unchanged, and the
container must still listen on `$PORT`.

```bash
anycloud service ghcr.io/acme/api:v1 --id model-api --node-pool aws-east
```

Admission requires the node pool to be `running` with at least one Ready VM and
its cluster to pass the connection check; otherwise the request is rejected
before anything is stored. `anycloud status` and `anycloud list` report the
node pool's cloud as the Service's cloud and name the node pool it runs on.
On a verified NVIDIA CUDA node pool the Service gets every GPU of one pool VM,
as a [Deployment](/reference/cli/deployments) Pod does; `--gpus N` takes
fewer, and more than one VM holds is rejected. Node pools with unknown or
non-CUDA accelerators are rejected. The GPUs share the pool's GPU reservation
with its Deployments, and admission is refused when they no longer fit. They
come from the pool's ingress entry VM, so on a multi-VM pool a replica whose VM
GPUs are taken stays `provisioning` with a scheduling block. The Service is
then reconciled to one replica in its
own namespace, with a Traefik `IngressRoute` for `<id>.anycloud.sh` that the
node pool's ingress (see [Ingress entry](/reference/cli/node-pools#ingress-entry))
serves at port 80 of the native Service named after the Workload. `anycloud
status` reports scheduling and startup blocks while the Service is
`provisioning`; `running` means the container accepted TCP connections on
`$PORT` for thirty seconds.

#### Public URL

The response to `anycloud service … --node-pool` carries
`url: https://<id>.anycloud.sh`, as for a VM-host Service. The DNS record is
published once the Service is `running` **and** the node pool's ingress is
serving (`node-pool status` shows the Traefik DaemonSet ready), so a record
never points at an entry nothing listens on; `anycloud status` then shows
`URL:` and a `Public endpoint:` line — `published at <entry IP>`,
`re-pointing …` while a publish or move is pending, or `stale …: <reason>`.
The replica itself runs on the ingress entry Node — pool VMs have no
node-to-node network, so Traefik must reach it locally. When the node pool
elects a new ingress entry the replica is recreated there (a short outage
while it starts), the record is updated in place (no gap), and every
reconcile pass re-checks it, so a missed signal heals on its own. Terminating the Service removes the route and the record after the
native objects.

**Whose record it is.** The record at the DNS Worker belongs to the GitHub
account of whoever created the Service — the same token the Worker validated
at admission, stored with the Service, exactly as VM-host Services work — not
to the account that created the cluster. Two Services on one cluster cannot
collide: ids are unique, and a Service whose hostname is already served by
another pool-labelled route on the cluster (an installer and a hosted API
targeting the same cluster) fails at its first reconcile with `hostname
<id>.anycloud.sh is already served by IngressRoute <namespace>/<name>`. If the
creator's token is revoked or expires, the Service keeps serving at its
current entry but reads `stale` after the next entry change (the Worker
refuses the re-point) and its record cannot be removed by the product at
termination. What to do then: recreate the Service under a valid token (a new
id gets a fresh record) and ask the record's owner to delete the old one
through the Worker; there is no installation-level DNS identity in this
release. Reusing a Service id on another installation under the same GitHub
account moves `<id>.anycloud.sh` to the new Service; terminating the old
Service later leaves the new record alone. Terminate the old Service once the
new one serves: until then, an old-installation republish (for example, after
replacing its host) takes the hostname back. If the old installation then
terminates its Service, the hostname is left with no record; republish from
the new installation, for example with `anycloud service upgrade` on a VM-host
Service. `anycloud service upgrade` is not available for Services on a node
pool yet; terminate and recreate instead.
If the cluster connection or its permissions fail while the Service is starting,
the error is shown as the Service's status reason and the Service fails after
the same ten-minute allowance. `anycloud logs` shows the Service's newest Pod
(see [`anycloud logs`](workloads.md#anycloud-logs)); `anycloud ssh` and
`anycloud exec` are not available for Services on a node pool.
Terminating the Service removes its route and record, then its namespace and
everything in it, and leaves the node pool, the cluster and other Services
untouched. A node pool cannot be
deleted while a Service on it has not finished cleanup, and a cleaned Service
can be resubmitted only while its node pool is `running`.

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

---
title: vm
description: Exact syntax, persistence, access, image, and recovery contracts for VMs.
---

# `anycloud vm`

Create one on-demand cloud host with one persistent VM container:

```bash
anycloud vm [image] [options]
```

Start with [VMs](/platform/vms) for when to use this primitive, its interactive
workflow, and its persistence and trust boundaries.

A compatible image is required for creation. Pass it explicitly, or omit it in
an interactive terminal to choose from your GHCR images. In CI or another
non-interactive shell, pass the image as the first argument. When it is omitted,
the error suggests these public starting points without selecting one for you:

- `mcr.microsoft.com/devcontainers/base:ubuntu24.04` — Ubuntu Development (CPU)
- `pytorch/pytorch:2.13.0-cuda12.6-cudnn9-runtime` — PyTorch + CUDA (NVIDIA GPU)

Anycloud does not provide a default VM image.

Interactive terminals can use the existing compute picker. In CI or another
non-interactive shell, pass `--vm-type` or `--gpu-type`; Anycloud never chooses
an implicit small VM.

The bare names `list` and `ls` select listing. To launch an image with either
name, include its tag, for example `anycloud vm list:latest`.

## `anycloud vm list`

```bash
anycloud vm list [options]
anycloud vm ls --status running
anycloud vm list -n 400 --json
```

List only VMs, using the same filters, limits, automatic agent session scope,
and JSON/CSV/ID output as [`anycloud list`](/reference/cli/workloads#anycloud-list).
The command prints directly without a view picker. Put listing options after
`list` or `ls`. The type is fixed; `--type` is not
accepted.

<span id="options"></span>

## Creation options

| Option                | Description                                                     |
| --------------------- | --------------------------------------------------------------- |
| `-i, --id ID`         | Custom workload ID                                              |
| `--credentials NAME`  | Select a saved credential; required when selection is ambiguous |
| `--region REGION`     | Pin a region within the selected account                        |
| `--zone ZONE`         | Pin an availability zone                                        |
| `--vm-type TYPE`      | Exact VM; repeat for an ordered fallback pool                   |
| `--gpu-type TYPE`     | GPU model/count; repeat for an ordered fallback pool            |
| `--disk-size GB`      | Root disk capacity                                              |
| `--disk-tier TIER`    | `medium`, `high`, or `ultra`                                    |
| `-e, --env KEY=VALUE` | Environment value; repeatable                                   |
| `--env-file FILE`     | Load a dotenv file                                              |
| `--secret NAME`       | Inject a named Secret; repeatable                               |
| `--wait`              | Wait until the VM is running, then exit `0`                     |

Examples:

```bash
anycloud vm alpine:3.22 --credentials my-aws --vm-type t3.large
anycloud vm ghcr.io/acme/dev:latest --gpu-type h100 --disk-size 200
anycloud vm alpine:3.22 --vm-type t3.large --id dev --wait && anycloud exec dev "uname -a"
```

VM creation supports AWS, Azure, GCP, and Lambda accounts. Kubernetes
does not support VMs.
Spot, capacity greater than one, startup commands, buckets, persistence flags,
and arbitrary Docker/bind/runtime options are rejected.

## Access and operations

```bash
anycloud ssh <id>             # shell in the VM container
anycloud ssh <id> --host      # shell on the underlying host
anycloud ssh <id> --vm        # compatibility alias for --host
anycloud exec <id> "command"  # command in the VM container
anycloud logs <id>
anycloud status <id>
anycloud vm list
anycloud cost <id>
anycloud terminate <id>
```

The container runs a platform keepalive, so `logs` is normally empty. Commands
started with `exec` or interactive SSH are not captured by that keepalive log.
VM resubmit is intentionally unsupported; create a replacement with
`vm <image>`.

## Persistence and trust boundary

`/workspace` is mounted from the identical host path and survives container
recreation and host reboot. It exists only for the life of the cloud VM:
`terminate` destroys the host and its local disk. Anycloud creates this shared
directory with mode `0777` so arbitrary image users can write to it.

The VM container keeps the image's configured user and `HOME` and receives the
host's rootful Docker socket. Anycloud adds the socket's numeric group ID as a
supplemental group so that user can access it. Container users can therefore
control the whole host; this is a single-user development boundary, not a
security sandbox. Anycloud does not place its private SSH key or an ambient
cloud storage identity on a VM host. Explicit environment values and named
Secrets are still injected into the VM container.

The supplied image must be Linux/amd64 (Linux/arm64 on an AWS Graviton, GCP or Azure Arm type),
provide `/bin/sh` and POSIX `sleep`, allow entrypoint and command replacement,
and tolerate `/workspace` as its working directory. Anycloud replaces the image entrypoint, command, and working
directory with its long-running VM container profile; it does not install or
probe development tools. Include the Docker CLI, Git, an interactive shell, or
other tools in the image when they are needed. The Docker CLI is not required
merely to create a VM.

## Networking

VMs expose SSH only. Setting `PORT` or publishing a port from a
Docker container on the host does not create an Anycloud-managed HTTP endpoint
or DNS record. Use SSH tunneling for temporary development access, or deploy a
Service when the application needs a stable public URL.

## Repair limits

While a VM workload remains `Running`, Anycloud observes its deterministic
VM-container name. Anycloud attempts to recreate a missing container on the
same live host without removing another container first. Exited, paused, or
restarting containers are reported and left untouched.

If the host is unreachable or container inspection fails, Anycloud asks the
cloud provider about that exact VM attempt. Provider-confirmed `alive` and
`unknown` results leave the workload `Running` indefinitely and are checked
again on later polls. Provider-confirmed absence changes the workload to
`Failed`, records a failure event explaining that the host-local `/workspace`
cannot be recovered, and hands the host to cleanup, which deletes the resources
the provider still associates with it and stops billing for the VM. A disk the
provider detached when the host was deleted outside Anycloud may still need
removing in your cloud console. The host is never replaced automatically; use
`anycloud vm <image>` to create a new environment.

If an intentionally stopped container should run again:

```bash
anycloud ssh <id> --host
docker start <id>
```

Host access remains the diagnostic path when repair is unavailable or the
container name/labels conflict.

---
title: VMs
description: Launch an on-demand CPU or GPU VM, connect over SSH, use host Docker, and understand its persistence and trust boundaries.
---

# VMs

A VM is one on-demand cloud host with a long-running container you
control directly. Use one for interactive exploration, debugging, development,
or a custom workflow that needs a shell instead of a managed Job or HTTP
Service lifecycle.

See [Primitives](/primitives) for a side-by-side comparison with Jobs, Services,
and Buckets.

## Create a VM

Supply a compatible container image and select an exact VM or GPU target:

```bash
anycloud vm ghcr.io/acme/dev:latest \
  --credentials my-aws \
  --gpu-type h100 \
  --disk-size 200
```

The command queues the workload and returns its ID. Omit the image in an
interactive terminal to choose from your GHCR images. Connect after its status
reaches `running`. An interactive terminal can also open the compute picker. In
CI or another non-interactive shell, pass both the image and either `--vm-type`
or `--gpu-type`; Anycloud does not choose an implicit small VM.

VM creation supports AWS, Azure, GCP, and Lambda accounts. It uses
on-demand capacity and creates exactly one host.

See [GPUs & VM Types](/platform/gpus-vm-types) for hardware selection and the
[`vm` reference](/reference/cli/vm) for every creation option.

## Connect and operate

The default shell opens inside the long-running VM container. Add `--host` when
you need the underlying cloud host:

```bash
anycloud ssh <id>                  # shell in the VM container
anycloud ssh <id> --host           # shell on the underlying host
anycloud exec <id> "nvidia-smi"    # command in the VM container
anycloud status <id>
anycloud cost <id>
anycloud terminate <id>
```

Use the container shell for normal work and the host shell to inspect Docker,
repair the workload container, or diagnose the machine. VMs do not support
resubmission; create a replacement with `anycloud vm <image>`.

## Workspace and host Docker

`/workspace` is mounted at the same path on the container and host. It survives
container recreation and host reboot, so it is the right place for work that
must remain available during the life of the VM. Terminating the VM destroys
the host and `/workspace`; it is not durable object storage.

The container receives the host's rootful Docker socket. If the supplied image
includes the Docker CLI, commands such as `docker ps` and `docker run` operate
the host daemon:

```bash
anycloud exec <id> "docker ps"
```

Docker socket access is effectively control of the host. A VM is a
single-user development boundary, not a security sandbox for untrusted code.
Anycloud does not place its private SSH key or an ambient cloud storage
identity on the host. Explicit environment values and named Secrets are still
injected into the VM container.

## Supply a compatible image

Anycloud does not provide a default VM image. The image must:

- Target Linux on `amd64`.
- Provide `/bin/sh` and POSIX `sleep`.
- Allow its entrypoint and command to be replaced.
- Tolerate `/workspace` as its working directory.

Anycloud preserves the image's configured user and `HOME`, but it does not
install development tools. Include Git, an interactive shell, the Docker CLI,
or other tools your workflow needs. See
[Container Images](/platform/container-images) for build and registry
guidance.

## Networking and data

VMs expose SSH only. Publishing a Docker port on the host does not create an
Anycloud-managed URL or DNS record. Use an SSH tunnel for temporary development
access, or choose a [Service](/platform/services) when an application needs a
stable public HTTP endpoint.

Buckets, startup commands, and custom Docker options are not supported on VMs.
Use a Job when data should be hydrated from object storage, results should be
synchronized, or a command should start automatically and release compute when
it exits.

## Repair and termination

While a VM remains `running`, Anycloud observes its workload container.
Anycloud attempts to recreate a missing container on the same live host.
Exited, paused, or restarting containers are reported and left untouched.

When the host cannot be reached, Anycloud checks the cloud provider using that
VM attempt's recorded credentials and placement. A provider response that the
host is alive, or an inconclusive provider response, leaves the workload
`running` and retries observation later. There is no reachability timeout that
replaces a persistent VM.

If the provider reports the host stopped, as GCP leaves a GPU VM after host
maintenance, Anycloud starts the same host again and records its new address.
`/workspace` and the container come back with it. When the start fails, for
example while the zone has no capacity for the VM's GPU, the workload stays
`running`, its status records the wait, and Anycloud retries in place with
growing intervals of up to 15 minutes. It never replaces the host. A host
stopped from the cloud console is started again too; remove a VM with
`anycloud terminate`. While a stopped VM waits, Anycloud's spend still counts
its full hourly price, although the cloud no longer bills its compute.

If the provider confirms that the host no longer exists, the workload becomes
`failed`. Anycloud then tears the host down and stops billing for it when
teardown finishes. It does not provision a replacement or recover the
host-local `/workspace`; the failure event records that data-loss boundary.
Create a new environment with `anycloud vm <image>` when a replacement is
needed.

Use host access for manual repair:

```bash
anycloud ssh <id> --host
docker start <id>
```

Terminate the workload when the machine is no longer needed:

```bash
anycloud terminate <id>
```

Termination removes the cloud host and its local disk. Use `anycloud cost <id>`
before or after termination to inspect the VM's compute cost.

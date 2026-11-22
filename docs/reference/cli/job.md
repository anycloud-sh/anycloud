---
title: job
description: Exact syntax and options for creating and listing Jobs.
---

# `anycloud job`

Run and list finite Jobs, each on its own VM.

The deprecated names `anycloud run` and `anycloud submit` still run
`anycloud job`, with a warning. They will be removed in a future release.

```bash
anycloud job [image] [-- command...] [options]
```

Use `--` before a container command that has its own flags.
Omitting the image in an interactive terminal opens the GHCR image picker. In
CI or another non-interactive shell, pass the image as the first argument.

The bare names `list` and `ls` select listing. To launch an image with either
name, include its tag, for example `anycloud job list:latest`.

## `anycloud job list`

```bash
anycloud job list [options]
anycloud job ls --status running
anycloud job list -n 400
anycloud job list --json
```

List only Jobs, using the same filters, limits, automatic agent session scope,
and JSON/CSV/ID output as [`anycloud list`](/reference/cli/workloads#anycloud-list).
The command prints directly without a view picker. Its type is fixed;
`--type` is not accepted. Put listing options after `list` or `ls`.

<span id="options"></span>

## Creation options

| Option                                  | Description                                                               |
| --------------------------------------- | ------------------------------------------------------------------------- |
| `-i, --id ID`                           | Custom workload ID                                                        |
| `-e, --env KEY=VALUE`                   | Environment value; repeatable. `-e KEY` reads the current shell           |
| `--env-file FILE`                       | Load values from a dotenv file                                            |
| `--secret NAME`                         | Inject a named Secret; repeatable                                         |
| `--max-retries N`                       | At most N retries after a loss                                            |
| `--no-checkpoint`                       | No checkpoint bucket, even on spot                                        |
| `--require-nested-virtualization`       | On a VM: only types with nested virtualization (KVM), launched with it on |
| `--host-docker`                         | On a VM: the host's Docker and `/workspace`; see [Docker in a VM Job][hd] |
| `--credentials NAME`                    | Select one saved compute credential                                       |
| `--region REGION`                       | Pin one compute region                                                    |
| `--regions A,B,C`                       | On a VM: the regions it may launch in, with failover between them         |
| `--vm-type TYPE`                        | Exact VM; repeat for an ordered fallback pool                             |
| `--gpu-type TYPE`                       | GPU model and optional count; repeat for an ordered fallback pool         |
| `--spot`                                | Use spot/preemptible capacity                                             |
| `--disk-size GB`                        | Root disk capacity                                                        |
| `--disk-tier TIER`                      | `medium`, `high`, or `ultra`                                              |
| `--disk-iops N`                         | AWS only: gp3 root IOPS, overriding the tier; see [gp3 performance][gp3]  |
| `--disk-throughput MiBps`               | AWS only: gp3 root throughput in MiB/s, overriding the tier               |
| `--zone ZONE`                           | Availability zone                                                         |
| `--input-bucket NAME`                   | Read-only input at `/mnt/input`                                           |
| `--output-bucket NAME`                  | Writable output at `/mnt/output`                                          |
| `--checkpoint-bucket NAME`              | Existing read-write checkpoint at `/mnt/checkpoint`                       |
| `--input-storage-credentials NAME`      | Cross-account input identity                                              |
| `--input-storage-region REGION`         | Cross-account input Bucket region; omit for Cloudflare R2                 |
| `--output-storage-credentials NAME`     | Cross-account output identity                                             |
| `--output-storage-region REGION`        | Cross-account output Bucket region; omit for Cloudflare R2                |
| `--checkpoint-storage-credentials NAME` | Cross-account checkpoint identity                                         |
| `--checkpoint-storage-region REGION`    | Cross-account checkpoint Bucket region; omit for Cloudflare R2            |
| `--gpus VALUE`                          | Docker GPU exposure: `all` or a count                                     |
| `--shm-size SIZE`                       | Shared memory, such as `8g`                                               |
| `--memory LIMIT`                        | Container memory limit                                                    |
| `--cpus COUNT`                          | Container CPU limit                                                       |
| `--runtime RUNTIME`                     | Docker runtime                                                            |
| `--ipc MODE`                            | `host`, `private`, or `shareable`                                         |
| `--ulimit VALUE`                        | Docker ulimit; repeatable                                                 |
| `--bind PATH`                           | Volume bind mount; repeatable                                             |
| `--privileged`                          | Deprecated: privileged container, root on its host; use `--host-docker`   |
| `--wait`                                | Wait until the Job completes; exit codes as in `anycloud wait`            |

`--wait` submits, prints the ID, then waits like
[`anycloud wait`](/reference/cli/workloads#anycloud-wait): it exits `0` when the
Job completes and `1` when it fails.

`--gpu-type` and `--vm-type` are mutually exclusive. `--credentials` may
appear once. If omitted for VM-backed compute, the CLI selects the sole saved
credential or shows a picker in an interactive terminal. Multiple credentials
in non-interactive use require `--credentials`. Local compute is
credentialless.

An explicit `--checkpoint-bucket` works with spot or on-demand Jobs, must
already exist, and is always retained. Without that flag, a spot Job uses its
automatic workload-named checkpoint bucket and deletes it when the Job
finishes.

AWS, Azure, and GCP dedicated Jobs use the selected compute identity for automatic spot
checkpoints and do not need explicit checkpoint storage flags. Lambda
and Local Jobs do not have a compatible native bucket identity, so
a checkpoint bucket requires explicit checkpoint storage credentials and
region. Scoped cross-identity storage currently requires AWS credentials.

## Examples

```bash
anycloud job ghcr.io/acme/train:latest \
  --credentials my-aws \
  --gpu-type h100:8 \
  --spot \
  --gpus all \
  -- python train.py --epochs 10
```

```bash
anycloud job ghcr.io/acme/app:latest \
  --credentials my-aws \
  --vm-type t3.medium
```

`GITHUB_TOKEN` supplies GitHub authentication in non-interactive use; see
[`anycloud login`](/reference/cli/api-utilities#anycloud-login).
`ANYCLOUD_CREDENTIALS_NAME` is the credentials-name fallback when the flag is
absent.

For field precedence and constraints, see
[Configuration](/reference/configuration).

[hd]: /platform/jobs#docker-in-a-vm-job
[gp3]: /reference/configuration#aws-gp3-performance

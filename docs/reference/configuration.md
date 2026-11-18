---
title: Configuration
description: Exact mappings, defaults, precedence, and constraints for Anycloud workload configuration.
---

# Configuration

This page is the exact lookup for where and how a Job, Service, or VM runs. For
decision guidance, start with [GPUs & VM Types](/platform/gpus-vm-types),
[Cloud Credentials](/platform/cloud-credentials), and
[Buckets](/platform/buckets).

## Configuration mappings

| Purpose               | CLI                                          | Python setting                                      | Notes                                                                                    |
| --------------------- | -------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Deployment target     | `job --deployment ID-OR-NAME`                | `submit(deployment=...)`                            | The Job carries only its ID; no per-Job overrides                                        |
| Node pool             | `deployment create --node-pool ID-OR-NAME`   | `create_deployment(node_pool=...)`                  | Target for the Deployment                                                                |
| Deployment GPU access | `deployment create --gpus all` or `--gpus N` | `create_deployment(docker_options={"gpus": "all"})` | `all` uses one VM's verified NVIDIA supply; `N` is a positive count (a string in Python) |
| Compute credential    | `--credentials NAME`                         | `credential_name`                                   | Required for remote VM compute                                                           |
| Region                | `--region REGION`                            | `cloud_config["region"]`                            | Omit for normal multi-region selection                                                   |
| Region allow-list     | `--regions A,B,C`                            | `cloud_config["regions"]`                           | VM Jobs only; not with `region` or a zone                                                |
| GPU model and count   | `--gpu-type TYPE`                            | `gpu`                                               | Mutually exclusive with exact VM                                                         |
| Exact VM              | `--vm-type TYPE`                             | `cloud_config["vm_type"]`                           | Mutually exclusive with GPU type                                                         |
| Spot                  | `--spot`                                     | `cloud_config["spot"]`                              | Jobs only                                                                                |
| Root disk capacity    | `--disk-size GB`                             | `cloud_config["disk_size_gb"]`                      | Independent of performance tier                                                          |
| Root disk tier        | `--disk-tier TIER`                           | `cloud_config["disk_tier"]`                         | `medium`, `high`, or `ultra`                                                             |
| gp3 root IOPS         | `--disk-iops N`                              | `cloud_config["disk_iops"]`                         | AWS VM Jobs only; 3,000–80,000                                                           |
| gp3 root throughput   | `--disk-throughput MiBps`                    | `cloud_config["disk_throughput_mibps"]`             | AWS VM Jobs only; 125–2,000 MiB/s                                                        |
| Availability zone     | `--zone ZONE`                                | `cloud_config["availability_zone"]`                 | Provider-specific value                                                                  |
| Input Bucket          | `--input-bucket NAME`                        | `cloud_config["input_bucket"]`                      | Jobs only; must exist                                                                    |
| Output Bucket         | `--output-bucket NAME`                       | `cloud_config["output_bucket"]`                     | Jobs only; created if needed                                                             |
| Checkpoint Bucket     | `--checkpoint-bucket NAME`                   | `cloud_config["checkpoint_bucket"]`                 | Jobs and VM-backed Services; must exist                                                  |
| Environment           | `-e`, `--env-file`                           | `env`                                               | Explicit values override Secret keys                                                     |
| Named Secret          | `--secret NAME`                              | `secrets`                                           | Sequence of saved names                                                                  |
| Container runtime     | Docker flags below                           | `docker_options`                                    | Applies after hardware resolution                                                        |

The Python column describes `Client.submit()` unless it names another method.
Pass dictionary entries together as `cloud_config={...}`. Services use generated
admission models with the corresponding fields; see [Services](/platform/services).
Deployment-targeted Jobs accept only `deployment` and optional `workload_id`, including
when other supplied values are empty mappings or lists.

## Python SDK

`from anycloud import Client` supplies the Job and Deployment client. It discovers
the API URL from `api_url=`, `API_URL`, the saved `api-url` file, then the local
default. An explicit `token=` is the bearer as given. Otherwise a loopback API
URL takes the `local-api-token` file `api start` wrote. A hosted API takes its
own API token: `ANYCLOUD_API_TOKEN` when `API_URL` names that API, then the
token `anycloud login <api>` saved in `api-tokens.json`. A hosted API never
accepts a GitHub token. Files live under `ANYCLOUD_DIR`, defaulting to `~/.anycloud`.
See [SDK configuration](/reference/python-sdk#install-and-configure) for details
and explicit generated-client setup. Authentication discovery does not choose
a cloud compute credential.

## Credential precedence

Select a saved compute credential on each dedicated Job submission:

```python
from anycloud import Client

with Client() as client:
    job = client.submit(
        "ghcr.io/acme/trainer:latest",
        credential_name="production-aws",
        gpu="h100",
        cloud_config={"region": "us-east-1"},
    )
    print(job.id)
```

For inline credentials in a `cloud_config` mapping, set `credentials` to a
provider-specific mapping or `credential_model.to_dict()` instead of
`credential_name`. Nested generated credential models are not accepted directly
inside a mapping.
The generated admission fields are `credentialName` and
`cloudConfig.credentials`. The Python client does not apply the CLI's automatic
compute-credential selection described below.

A CLI `--credentials` value wins over the
`ANYCLOUD_CREDENTIALS_NAME` environment fallback. If both are absent, the CLI
automatically selects the sole saved credential. With several saved
credentials, an interactive terminal shows a picker; non-interactive use must
pass `--credentials`. Inline credential environment variables are also
accepted. Local workloads do not require a cloud credential. Deployments use
their node pool's compute credential rather than a per-Job compute credential.

Remote API requests must contain one resolved named or inline compute
credential. If that credential fails authentication, the workload becomes
`invalid`; Anycloud does not switch accounts. Leave `region` unset to retain
regional failover within the selected account.

## Hardware constraints

Remote image submissions require exactly one of `gpu` / `--gpu-type` or
`cloud_config["vm_type"]` / `--vm-type`. A saved credential does not supply a
default hardware selector. Deployment-targeted Jobs use their Deployment's capacity.

- GPU selection accepts a model with optional count, such as `h100` or
  `a100:8`.
- VM selection accepts a provider-specific instance type, such as
  `g6e.xlarge`, `Standard_NC40ads_H100_v5`, or `n1-standard-8`.
- Repeating a CLI GPU or VM flag creates an ordered fallback pool. In Python,
  use `gpu=["h100:8", "a100:8"]` or
  `cloud_config={"vm_type": ["g6e.xlarge", "g5.xlarge"]}`.
- `--gpus` is a Docker exposure setting; it does not select the cloud VM.

```bash
# Ordered GPU preference
anycloud job IMAGE \
  --gpu-type h100:8 \
  --gpu-type a100:8

# Exact VM
anycloud job IMAGE \
  --credentials production-aws \
  --vm-type g6e.xlarge
```

Region pinning disables regional failover. Use it only for residency,
debugging, quota work, or another explicit constraint.

A Job on its own VM can instead name the regions it may run in, with
`--regions us-east-1,us-west-2` (`cloud_config["regions"]`). It chooses
among them as an unpinned Job chooses among all regions, and fails over to
another of them after a capacity, quota or regional failure. Each region must
be one the provider's catalog lists (`anycloud regions <cloud>`), with at most
64 and no wildcards. `--regions` takes neither `--region` nor `--zone`. A Job
whose VM types no listed region offers is `invalid`. The workload's `regions`
records the list, and each VM in `status` shows the region it launched in.

## `cloudConfig` fields

Pass cloud settings to each `Client.submit()` as a `cloud_config` mapping or a
generated `WorkloadAdmissionInputAnyOf1CloudConfig` model. Mappings accept
Python names such as `vm_type`, `disk_size_gb`, and `input_bucket`, or their wire
aliases `vmType`, `diskSizeGb`, and `inputBucket`.

The model also supports independent input, output, and checkpoint inline
storage credentials and regions. Saved storage credential names are top-level
admission fields and require a generated submission, shown below. There are no
client-level workload defaults or inheritance helpers. Generated admission
examples use `WorkloadAdmissionInput.from_dict()` with wire names.

## Bucket credential rules

For Jobs, input, output, and checkpoint storage credentials are independent.
When a storage credential is omitted, that Bucket uses compute credentials;
setting one Bucket's storage credential does not affect the others.

Service checkpoints always use the selected compute credential. A Service cannot
set a separate checkpoint storage credential, although it may set
`checkpoint_storage_region` for a same-identity bucket in another region.

On the CLI, cross-account storage requires a credential and region:

```bash
anycloud job IMAGE \
  --credentials compute-account \
  --input-bucket shared-data \
  --input-storage-credentials storage-account \
  --input-storage-region us-east-1
```

For saved storage credential names in Python, use generated admission through
the same configured client. `inputStorageCredentialName` is a top-level request
field; `inputStorageRegion` and `inputBucket` belong inside `cloudConfig`:

```python
from anycloud import Client
from anycloud.api.workload_admission_api import WorkloadAdmissionApi
from anycloud.models.workload_admission_input import WorkloadAdmissionInput

with Client() as client:
    submitted = WorkloadAdmissionApi(client.api_client).submit_workload_sync(
        client.sdk_version,
        WorkloadAdmissionInput.from_dict(
            {
                "workloadType": "job",
                "image": "ghcr.io/acme/trainer:latest",
                "credentialName": "compute-account",
                "inputStorageCredentialName": "storage-account",
                "gpuType": "h100",
                "cloudConfig": {
                    "inputBucket": "shared-data",
                    "inputStorageRegion": "us-east-1",
                },
            }
        ),
    )
    print(submitted.id)
```

Use the corresponding `outputStorageCredentialName` or
`checkpointStorageCredentialName` with nested output/checkpoint settings for
those bucket roles. These saved-name arguments are not accepted by
`Client.submit()` and cannot be put in its `cloud_config` mapping.

Cross-cloud storage currently supports S3. It uses scoped STS credentials that
last up to 12 hours and are not refreshed during periodic sync. VM-hosted
workloads mint a fresh token for their final copy. Deployment-targeted Jobs do
not support per-Job Buckets.

## Root disk tiers

Disk capacity and performance are independent. `--disk-size 100 --disk-tier
high` means a 100 GB root disk at the high tier. `high` is the default.

On AWS, tiers map to gp3 root-volume settings:

| Tier     |   IOPS |  Throughput |
| -------- | -----: | ----------: |
| `medium` |  3,000 |   125 MiB/s |
| `high`   |  8,000 | 1,000 MiB/s |
| `ultra`  | 16,000 | 1,000 MiB/s |

AWS reads the selected AMI's root-disk metadata before launch. When disk size is
omitted, it raises roots smaller than the capacity required for the requested
gp3 IOPS (16 GB for `high`, 32 GB for `ultra`) and leaves larger roots unchanged.
A CPU VM Job's root is at least 30 GB on AWS and GCP when disk size is omitted.
An explicit size is preserved when valid and rejected if it would shrink the AMI
root or fall below the tier's IOPS-to-capacity minimum.

On Azure, `medium` uses Standard storage; `high` and `ultra` use Premium SSD.
Azure currently maps `ultra` to the same Premium tier as `high`. The VM size
must support Premium storage.

On GCP, the root-disk type is machine-aware:

| Machine storage class | `medium`                    | `high`                   | `ultra`                   |
| --------------------- | --------------------------- | ------------------------ | ------------------------- |
| Persistent Disk       | Machine-compatible default  | `pd-ssd`                 | `pd-ssd`                  |
| Hyperdisk-only        | Hyperdisk Balanced defaults | 8,000 IOPS / 1,000 MiB/s | 16,000 IOPS / 1,000 MiB/s |

Leaving `--disk-tier` unset resolves to the shared `high` default before the
provider request is built. Pass `medium` explicitly to use the standard tier.

GCP `high` and `ultra` intentionally collapse to the same `pd-ssd` disk class
on Persistent Disk machines such as G2. For Hyperdisk `high` or `ultra`,
omitting `--disk-size` selects 100 GB. An explicit Hyperdisk size must be at
least 16 GB for `high` or 32 GB for `ultra`; Anycloud rejects a smaller size
instead of silently enlarging it. Known families that require Hyperdisk for
fast tiers use Hyperdisk; other families, including newly published ones,
optimistically use `pd-ssd` for `high` and `ultra`. In expanded fallback pools,
known incompatible disk/VM combinations are removed before target selection;
if none remain, Anycloud reports the disk requirement. A fully pinned target
stays on the direct provisioning path and GCP reports the same incompatibility
as an invalid request there.

The gateway's small Hyperdisk exception list is curated from GCP's
supported-disk sections for
[general-purpose](https://cloud.google.com/compute/docs/general-purpose-machines),
[compute-optimized](https://cloud.google.com/compute/docs/compute-optimized-machines),
[memory-optimized](https://cloud.google.com/compute/docs/memory-optimized-machines),
[storage-optimized](https://cloud.google.com/compute/docs/storage-optimized-machines),
and [accelerator-optimized](https://cloud.google.com/compute/docs/accelerator-optimized-machines)
machines. Those are provider compatibility facts; their mapping to Anycloud's
tiers and performance targets is Anycloud policy. GCP's MachineType and
DiskType APIs do not expose the machine-to-disk compatibility relationship.

Provisioned Hyperdisk performance is a disk limit, not a guarantee. GCP caps
actual performance at the lower of the disk's provisioned target and the VM
machine type's limit. Anycloud deliberately sends the tier target unchanged; it
does not clamp that target to the selected machine. GCP accepts such a disk even
when the machine cannot realize all of its performance, while billing Hyperdisk
capacity and provisioned performance separately. Choose a machine whose limits
match the tier to avoid paying for performance that the VM cannot use.

Disk tiers are supported on AWS, GCP, and Azure. Other providers reject a
non-default tier.

### AWS gp3 performance

A Job on its own AWS VM can set its gp3 root volume's IOPS and throughput
itself, instead of the tier's: `--disk-iops` and `--disk-throughput` (MiB/s).
Either one alone overrides only that value. With the default `high` tier
(8,000 IOPS, 1,000 MiB/s), `--disk-throughput` alone keeps 8,000 IOPS and is
checked against them. `--disk-iops` alone keeps the tier's throughput, lowered
to 0.25 MiB/s per IOPS, rounded down to a whole MiB/s, where AWS requires it
(750 MiB/s at 3,000 IOPS). AWS's
limits apply:

- IOPS from 3,000 to 80,000, at most 500 per GiB of the root volume;
- throughput from 125 to 2,000 MiB/s, at most 0.25 MiB/s per IOPS.

The root volume is never grown to fit the Job's own IOPS, since that changes
the Job's cost. A CPU VM Job's root is 30 GiB unless `--disk-size` says
otherwise, which carries up to 15,000 IOPS; a GPU VM Job's root is its AMI's,
and at least 30 GiB.
More IOPS than the root carries are refused with the `--disk-size` they need.
Any other cloud, a Service, a VM, or a Job on a node pool refuses them. The
workload's `diskIops` and `diskThroughputMibps` record what was asked.

## Docker runtime options

| CLI                       | `docker_options` key | Example           |
| ------------------------- | -------------------- | ----------------- |
| `--gpus`                  | `gpus`               | `all`, `2`        |
| `--shm-size`              | `shm_size`           | `8g`              |
| `--memory`                | `memory`             | `32g`             |
| `--cpus`                  | `cpus`               | `4`               |
| `--ipc`                   | `ipc`                | `host`            |
| `--ulimit`                | `ulimits`            | repeatable        |
| `--runtime`               | `runtime`            | `nvidia`          |
| `--bind`                  | `binds`              | repeatable volume |
| Deployment `--privileged` | `privileged`         | `true`            |

Anycloud configures GPU access automatically for GPU-backed VMs. `--gpus`
controls what Docker exposes; it is not normally necessary to specify an
NVIDIA runtime. Explicit `--gpus` and `--runtime nvidia` requests are rejected
on VMs known to have no NVIDIA GPU, and a numeric `--gpus` count cannot exceed
the resolved VM's GPU count. When a VM reports an accelerator the catalog
cannot identify, an explicit `--gpus` still forces GPU passthrough. With
ordered VM fallbacks, Anycloud skips targets that cannot honor the request.

The API validates option names, types, and values before image inspection or
provisioning. VM-host targets support the options above and accept the `runc`
and `nvidia` runtime names. A user bind cannot overlap an enabled Anycloud
bucket mount at `/mnt/input`, `/mnt/output`, or `/mnt/checkpoint`.

Deployments translate `--gpus`, `--runtime`, `--shm-size`, `--memory`, and `--cpus`
according to their [capacity and runtime rules](/reference/cli/deployments).
IPC and ulimit flags are unsupported. `--privileged`, deprecated and removed
in the next release, opts into broad node
device and capability access and requires trusted workloads. A Deployment
`--bind /absolute/path` creates a disposable Pod volume; host paths and named
Docker volumes are unsupported. In Python, use
`docker_options={"privileged": True, "binds": ["/runtime"]}`.

## Runtime environment

Every workload receives:

| Variable      | Meaning                                 |
| ------------- | --------------------------------------- |
| `WORKLOAD_ID` | The workload's unique ID                |
| `PORT`        | Service listen port; defaults to `8088` |

Containers also receive `DEPLOYMENT_ID`, equal to `WORKLOAD_ID`, for images
built for 0.1.64. It will be removed in a future release.

Workloads with Buckets receive the applicable fixed mount paths
`/mnt/input`, `/mnt/output`, and `/mnt/checkpoint`. See
[Buckets](/platform/buckets).

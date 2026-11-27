---
title: GPUs & VM Types
description: Select accelerators or exact cloud instances, use fallback pools, compare prices, and handle regional quota.
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# GPUs & VM Types

Hardware selection answers two different questions:

- Choose a **GPU type** when the accelerator model and count matter and
  Anycloud may choose the provider instance.
- Choose a **VM type** when you need an exact instance shape, including
  CPU-only machines.

They are mutually exclusive for one workload.

<span id="gpu-type-vs-vm-type"></span>

## Choose by GPU

<Tabs>
<TabItem value="cli" label="CLI">

```bash
anycloud job ghcr.io/acme/train:latest \
  --gpu-type h100:8 \
  --gpus all
```

</TabItem>
<TabItem value="python" label="Python">

```python
from anycloud import Client

with Client() as client:
    job = client.submit(
        "ghcr.io/acme/train:latest",
        credential_name="my-aws",
        gpu="h100:8",
        docker_options={"gpus": "all"},
    )
    print(job.id)
```

</TabItem>
</Tabs>

`h100:8` means eight H100 GPUs. A value without a count selects the GPU model
while the resolved VM type determines the available count.

## Choose an exact VM

```bash
anycloud job ghcr.io/acme/app:latest \
  --credentials my-aws \
  --vm-type g6e.xlarge
```

```python
from anycloud import Client

with Client() as client:
    job = client.submit(
        "ghcr.io/acme/app:latest",
        credential_name="my-aws",
        cloud_config={"vm_type": "g6e.xlarge"},
    )
    print(job.id)
```

Exact VM names are provider-specific. Prefer GPU selection when portability
matters more than a particular SKU.

<span id="arm64"></span>

### Arm64: AWS Graviton, GCP Axion and Azure Cobalt

AWS Graviton types, such as `m8g.xlarge` or `c8g.2xlarge`, GCP Arm types,
such as Axion's `c4a-standard-16` or `c4a-highmem-16`, and Azure Arm types,
such as Cobalt 100's `Standard_D4ps_v6` or Ampere's `Standard_D4ps_v5`, run
on arm64. The image
needs a `linux/arm64` build: a multi-platform image runs on Arm and x86-64
types alike. See [Container Images](/platform/container-images#architecture).

```bash
anycloud job alpine:3 --credentials my-aws --vm-type m8g.xlarge --spot -- uname -m
anycloud job alpine:3 --credentials my-gcp --vm-type c4a-standard-4 --spot -- uname -m
anycloud job alpine:3 --credentials my-azure --vm-type Standard_D4ps_v6 -- uname -m
```

A fallback pool can't mix Arm and x86-64 types. Arm GPU types, such as AWS
`g5g`, aren't supported yet.

## Use ordered fallbacks

Repeat a GPU or VM option to define an ordered pool. Anycloud tries the
available targets while preserving your preference order. Every option's
first-choice region comes before any option's second choice, so an option
without capacity yields to the next before it is retried elsewhere:

```bash
anycloud job ghcr.io/acme/train:latest \
  --gpu-type h100:8 \
  --gpu-type a100:8 \
  --spot
```

In Python, pass a list to `gpu` for the same ordered preference:

```python
from anycloud import Client

with Client() as client:
    job = client.submit(
        "ghcr.io/acme/train:latest",
        credential_name="my-aws",
        gpu=["h100:8", "a100:8"],
        cloud_config={"spot": True},
    )
    print(job.id)
```

For an exact VM pool, pass a list under `cloud_config["vm_type"]`, such as
`{"vm_type": ["p5.48xlarge", "p4d.24xlarge"]}`. See
[Configuration](/reference/configuration) for accepted options and precedence.

## Credentials and regions

Every remote workload selects one compute credential before queueing. Pass
`--credentials` explicitly, let the CLI select the sole saved credential, or
choose from the interactive picker. Non-interactive use with multiple saved
credentials must pass `--credentials`.

Leave `--region` unset for normal Jobs so Anycloud can rotate across healthy
regions. Pin it only for data residency, quota testing, debugging, or another
explicit constraint. Pinning prevents regional failover.

When a provider returns a capacity or quota error for an unpinned region,
Anycloud temporarily blocks that `(cloud, VM type, region)` target and tries
another. A literal zero quota or unavailable region is blocked longer because
it normally requires account action.

## Explore the catalog

```bash
anycloud gpus --type H100 --spot
anycloud vm-types aws us-east-1 --accelerator H100
anycloud regions aws --vm-type p5.48xlarge
anycloud pricing aws p5.48xlarge --spot
```

Use JSON output for scripts and agents:

```bash
anycloud gpus --type H100 --json
```

See [Catalog and pricing](/reference/cli/catalog-pricing) for all filters and
output modes.

## Check quota

```bash
anycloud quota status --credentials my-aws
```

Request an increase with the desired limit through the provider CLI or portal.
See the [`quota` reference](/reference/cli/quota).

## Disk capacity and performance

Root disk capacity and performance are separate:

```bash
anycloud job ghcr.io/acme/train:latest \
  --gpu-type h100 \
  --disk-size 400 \
  --disk-tier high
```

`high` is the default tier. `medium`, `high`, and `ultra` are supported on AWS,
GCP, and Azure; their provider mappings and constraints are documented in
[Configuration](/reference/configuration#root-disk-tiers).

Use [Buckets](/platform/buckets) for durable datasets and results. Root disks
belong to the workload VM and should not be treated as durable object storage.

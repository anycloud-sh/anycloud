---
title: Train MACE on spot GPUs
description: Build a MACE image, upload molecular data, train on a spot GPU with checkpoint recovery, and retrieve the model.
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Train MACE on spot GPUs

This example trains a
[MACE](https://github.com/ACEsuit/mace) interatomic potential on a spot GPU.
At the end, the trained model and results are in an output Bucket. If the spot
VM is reclaimed, MACE restarts from the latest synchronized checkpoint.

## Before you begin

You need:

- Anycloud installed, logged in, and connected to a cloud account
- Training and test data in extended XYZ format
- Docker if you want to build the optional custom image

Complete [Getting Started](/getting-started) first if the CLI is not configured.

## 1. Choose or build the image

The public `ghcr.io/anycloud-sh/mace:latest` image contains CUDA and
`mace-torch`, so this example can run without a build.

For a reproducible image you control, create:

```dockerfile
FROM pytorch/pytorch:2.2.0-cuda12.1-cudnn8-runtime

RUN pip install --no-cache-dir mace-torch
```

Build for the architecture used by cloud VMs and publish it:

```bash
docker buildx build \
  --platform linux/amd64 \
  -t ghcr.io/<your-github-user>/mace:latest \
  --push .
```

See [Container Images](/platform/container-images) for registry authentication,
immutable tags, and cold-start guidance.

## 2. Upload training data

Create an input Bucket and upload both files:

```bash
anycloud bucket create mace-training-data \
  --credentials my-aws \
  --region us-east-1

anycloud bucket upload mace-training-data \
  ./train.xyz train.xyz \
  --credentials my-aws \
  --region us-east-1

anycloud bucket upload mace-training-data \
  ./test.xyz test.xyz \
  --credentials my-aws \
  --region us-east-1
```

The explicit storage region identifies the Bucket; it does not pin the compute
VM. The input is available read-only at `/mnt/input`.

## 3. Submit training

<Tabs>
<TabItem value="cli" label="CLI">

```bash
anycloud job ghcr.io/anycloud-sh/mace:latest \
  --credentials my-aws \
  --gpu-type a100 \
  --gpus all \
  --spot \
  --disk-size 200 \
  --disk-tier high \
  --input-bucket mace-training-data \
  --output-bucket mace-results \
  -- mace_run_train \
    --name=my_model \
    --train_file=/mnt/input/train.xyz \
    --valid_fraction=0.1 \
    --test_file=/mnt/input/test.xyz \
    --model=MACE \
    --hidden_irreps='128x0e+128x1o' \
    --r_max=6.0 \
    --batch_size=32 \
    --max_num_epochs=500 \
    --device=cuda \
    --checkpoints_dir=/mnt/checkpoint \
    --restart_latest \
    --results_dir=/mnt/output
```

</TabItem>
<TabItem value="python" label="Python SDK">

```python
from anycloud import Client

with Client() as client:
    job = client.submit(
        "ghcr.io/anycloud-sh/mace:latest",
        credential_name="my-aws",
        gpu="a100:8",
        docker_options={"gpus": "all"},
        cloud_config={
            "spot": True,
            "disk_size_gb": 200,
            "disk_tier": "high",
            "input_bucket": "mace-training-data",
            "output_bucket": "mace-results",
        },
        command=[
            "mace_run_train",
            "--name=my_model",
            "--train_file=/mnt/input/train.xyz",
            "--valid_fraction=0.1",
            "--test_file=/mnt/input/test.xyz",
            "--model=MACE",
            "--hidden_irreps=128x0e+128x1o",
            "--r_max=6.0",
            "--batch_size=32",
            "--max_num_epochs=500",
            "--device=cuda",
            "--checkpoints_dir=/mnt/checkpoint",
            "--restart_latest",
            "--results_dir=/mnt/output",
        ],
    )
    print(job.id)
```

</TabItem>
</Tabs>

MACE writes checkpoints to `/mnt/checkpoint`. Anycloud copies changes to the
automatic checkpoint Bucket about every 60 seconds. After preemption, it starts
a replacement VM, restores that directory, and reruns the command;
`--restart_latest` tells MACE to continue from the restored state.

## 4. Monitor the run

```bash
anycloud job list --status running
anycloud logs <job-id> --follow
anycloud status <job-id>
anycloud exec <job-id> "nvidia-smi"
anycloud wait <job-id>
```

`logs --follow` waits for the container if the Job is still starting.
`wait` returns when training finishes: exit `0` if it completed, `1` if not.

The Job may return to `queued` and provisioning states after a spot
interruption. That is recovery, not a second submission.

## 5. Retrieve the trained model

List the object names in your cloud provider's object-storage console, then
download the model or result you need:

```bash
anycloud bucket download mace-results \
  <remote-model-path> ./my_model.model \
  --credentials my-aws \
  --region us-east-1
```

A Job reaches `completed` only after the final `/mnt/output` upload succeeds.
See [Jobs](/platform/jobs) for lifecycle and recovery, and
[Buckets](/platform/buckets) for the file-sync contract.

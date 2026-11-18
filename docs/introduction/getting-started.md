---
slug: /getting-started
title: Getting Started
description: Install Anycloud, connect a cloud account, and deploy your first GPU job.
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Getting Started

This guide takes you from a fresh installation to a completed GPU job. Docker
is required for local API operation and custom images.

## Install

To have a coding agent such as Claude Code or Codex do the setup, paste this
into it:

```text
set up https://anycloud.sh/SKILL.md
```

On macOS, install with Homebrew:

```bash
brew install anycloud-sh/tap/anycloud
```

Or use the installer:

```bash
curl -fsSL https://get.anycloud.sh | sh
```

The installer needs no sudo. It puts `anycloud` in `~/.local/bin` and adds that
directory to `PATH` in your shell startup file; pass `--no-modify-path` to skip
that, or `--install-dir <dir>` to choose another directory. An existing
`/usr/local/bin` installation is updated where it is.

The installer verifies the downloaded binary against the checksums published in
the public `anycloud-sh/releases` repository. To inspect it before running:

```bash
curl -fsSLo install.sh https://get.anycloud.sh
less install.sh
sh install.sh
```

For Python, install the SDK too. It requires Python 3.10 or newer:

```bash
pip install anycloud-sdk
```

## Sign in to GitHub when you need it

A local API runs public images without a GitHub sign-in. Sign in for private
GHCR images, Services (their public URLs), clusters and hosted APIs:

```bash
anycloud login
```

Login asks GitHub only for `read:org` and `read:packages`, so it can't push
images; [Container Images](/platform/container-images#build-and-publish) shows
how to push with the GitHub CLI. When a coding agent runs it, login prints the
sign-in URL and code for you to approve in your browser.

## Start the API

Every command talks to one active API. For a personal setup on this machine,
start the Anycloud API in Docker:

```bash
anycloud api start
```

`api start` writes a token to `~/.anycloud/local-api-token` that only you can
read. The local API admits nothing else, and the CLI sends it only to the local
API.

A hosted API runs in your cloud account and gives it a stable URL for use from
multiple machines or by a trusted team. Create the installation's Kubernetes
cluster, which hosts the API and later runs node pools, Deployments and
Services, through your cloud's own CLI (`aws`, `gcloud` or `az`) signed in on
this machine:

```bash
anycloud cluster create prod --cloud aws --region us-east-2 --vm-type t3.medium
anycloud api use https://<cluster-id>.anycloud.sh
```

[Clusters](/platform/clusters) walks that path end to end; [Hosted
APIs](/platform/hosted-apis) covers sharing and updating the API.

If you already own or have access to a hosted API, select it instead:

```bash
anycloud api use https://<cluster-id>.anycloud.sh
```

The selected URL is stored in `~/.anycloud/api-url`. `API_URL` is a temporary
override.

The Python SDK's `Client()` uses the selected API with the local API's token,
or with the token saved by `anycloud login` for a hosted API. You can also pass `api_url=` and `token=` explicitly; see
[Configuration](/reference/configuration#python-sdk).

<span id="-add-credentials"></span>

## Add cloud credentials

The interactive wizard can read durable local credentials, use supported
provider tooling, or accept values you paste:

```bash
anycloud credentials new my-aws
```

For non-interactive setup, pass the provider fields explicitly:

```bash
anycloud credentials new my-aws --provider aws \
  --access-key-id AKIA... \
  --secret-access-key ...
```

Anycloud never installs cloud CLIs. When `aws`, `gcloud` or `az` is missing,
the wizard prints how to install it. AWS still offers its other choices; for
Azure and GCP generation, rerun and pick another option. If
you have neither credentials nor permission to create them, choose **I don't
have AWS access keys** (or the Azure or GCP equivalent): it prints a request to
forward to your cloud administrator. See [Ask an
administrator](/reference/cli/credentials#ask-an-administrator). The identity
needs its provider's published role: AWS
[`AnycloudAccess`](/reference/cli/credentials#aws-permissions), Azure
[`Anycloud`](/reference/cli/credentials#azure-permissions) (or Contributor), or
GCP [`Anycloud`](/reference/cli/credentials#gcp-permissions) with the Security
Token Service API enabled for Buckets.

Azure, GCP, and Lambda use the same command with provider-specific fields. See
[Cloud Credentials](/platform/cloud-credentials) for setup paths and
[the credentials command reference](/reference/cli/credentials) for every flag.

<span id="-deploy"></span>

## Deploy a job

The fastest first run uses a public image, so no image build or source checkout
is needed.

<Tabs>
<TabItem value="cli" label="CLI">

```bash
anycloud job pytorch/pytorch:2.2.0-cuda12.1-cudnn8-runtime \
  --credentials my-aws \
  --gpu-type h100 \
  --gpus all \
  -- python -c "import torch; print('CUDA available:', torch.cuda.is_available())"
```

Follow it until completion:

```bash
anycloud status <job-id> --verbose
anycloud logs <job-id>
```

</TabItem>
<TabItem value="python" label="Python">

```python
from anycloud import Client

with Client() as client:
    job = client.submit(
        "pytorch/pytorch:2.2.0-cuda12.1-cudnn8-runtime",
        credential_name="my-aws",
        gpu="h100",
        docker_options={"gpus": "all"},
        command=[
            "python",
            "-c",
            "import torch; print('CUDA available:', torch.cuda.is_available())",
        ],
    )
    print(job.id)
    job.wait()
    print(job.last_status.workload.state)
```

</TabItem>
</Tabs>

Anycloud provisions a GPU VM, pulls the image, runs the command, and tears the
VM down after the job exits.

## Choose your next path

- **Learn the building blocks:** start with [Jobs](/platform/jobs), then add
  [Buckets](/platform/buckets), [Container Images](/platform/container-images),
  and [GPUs & VM Types](/platform/gpus-vm-types) as your workload needs them.
- **Work directly on provisioned compute:**
  [launch and connect to a VM](/platform/vms#create-a-vm).
- **Follow a complete workload:** [train MACE on spot GPUs](/examples/train-mace).
- **Look up exact syntax:** use [Configuration](/reference/configuration), the
  [CLI reference](/reference/cli-reference), or the
  [Python SDK reference](/reference/python-sdk).

To update an existing installation, run:

```bash
anycloud update
```

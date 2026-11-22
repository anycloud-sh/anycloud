---
title: Secrets & Environment
description: Configure visible environment values and inject reusable, write-only secret bundles into workloads.
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Secrets & Environment

Jobs, Services, and VMs accept ordinary environment variables and
named secret bundles. Use environment values for non-sensitive,
workload-specific configuration. Use Secrets for reusable API keys, tokens,
and passwords whose values should not appear in API responses.

|                          | Environment values       | Secrets                                                    |
| ------------------------ | ------------------------ | ---------------------------------------------------------- |
| Visible in API responses | Yes                      | Never                                                      |
| Reusable by name         | No                       | Yes                                                        |
| Rotation                 | Resubmit with new values | Update bundle; files update in place, env vars on resubmit |

## Pass environment variables

```bash
# Explicit value
anycloud job ghcr.io/acme/train:latest -e MODE=eval

# Read a value from the current shell
anycloud job ghcr.io/acme/train:latest -e DATASET_TOKEN

# Load a file; explicit -e flags win
anycloud job ghcr.io/acme/train:latest \
  --env-file .env \
  -e MODE=eval
```

In Python, pass the environment dictionary to `client.submit()`:

```python
from anycloud import Client

with Client() as client:
    job = client.submit(
        "ghcr.io/acme/train:latest",
        credential_name="my-aws",
        gpu="h100",
        env={"MODE": "eval", "RUN_NAME": "baseline"},
    )
    print(job.id)
```

The CLI warns when a likely-sensitive key is passed through `--env`, but the
submission proceeds.

## Create a Secret

Each Secret is a named bundle of one or more `KEY=VALUE` pairs:

```bash
anycloud secrets new hugging-face HF_TOKEN=hf_xxxxxxxxxxxx
anycloud secrets new tracking \
  WANDB_API_KEY=xxxxx \
  WANDB_ENTITY=my-team
```

Python can create or overwrite a bundle through `SecretsApi`:

```python
import os

from anycloud import Client
from anycloud.api.secrets_api import SecretsApi
from anycloud.models.save_secret_body import SaveSecretBody

with Client() as client:
    SecretsApi(client.api_client).save_secret_sync(
        "hugging-face",
        client.sdk_version,
        SaveSecretBody(values={"HF_TOKEN": os.environ["HF_TOKEN"]}),
    )
```

This example reads `HF_TOKEN` from your local environment and saves the bundle;
it does not inject it into a workload until you reference its name on submission.

The list command returns names and timestamps, never values:

```bash
anycloud secrets list
```

## Inject Secrets

<Tabs>
<TabItem value="cli" label="CLI">

```bash
anycloud job ghcr.io/acme/train:latest \
  --gpu-type h100 \
  --secret hugging-face \
  --secret tracking
```

</TabItem>
<TabItem value="python" label="Python">

```python
from anycloud import Client

with Client() as client:
    job = client.submit(
        "ghcr.io/acme/train:latest",
        credential_name="my-aws",
        gpu="h100",
        secrets=["hugging-face", "tracking"],
    )
    print(job.id)
```

</TabItem>
</Tabs>

Create both bundles above before submitting this Job. The same named Secrets
work with Services started through the JSON API or CLI, and with `anycloud vm`.

## Precedence and rotation

An explicit environment value wins over a same-named key from a Secret. That
supports a one-off override without editing the saved bundle.

Overwrite a bundle and resubmit to rotate it:

```bash
anycloud secrets new hugging-face HF_TOKEN=hf_rotated
anycloud resubmit <job-id>
```

Running containers keep the environment values injected when they started.
New Jobs, resubmissions, and spot replacements read the current bundle. The
[Secret files](#read-secrets-as-files) of a running Job, Service or VM change
within seconds.

Deletion is blocked while a non-terminal workload references the Secret.
`--force` bypasses that safeguard, but the next VM start for a workload that
still references the missing name will fail.

```bash
anycloud secrets delete hugging-face --force
```

## Read Secrets as files

In a Job, Service or VM, each key of each attached Secret is also a file:

```bash
anycloud secrets new hf HF_TOKEN=hf_old
anycloud job ghcr.io/acme/train:latest --secret hf
anycloud secrets new hf HF_TOKEN=hf_new
anycloud exec <job-id> -- sh -c 'echo "$HF_TOKEN"; cat /run/anycloud-secrets/hf/HF_TOKEN'
```

A few seconds after the second save this prints `hf_old`, then `hf_new`. Use a
file for a value that changes while the workload runs, such as a short-lived
token. The files are read-only and owned by root, with mode `0444`, so a
non-root container user can read them. A Secret changes all at once: a
program that opens a file by path sees all of the old keys or all of the new
ones, and a key removed from the Secret disappears. To react to a change, watch
the Secret's directory rather than one file. If the VM is briefly unreachable,
the update arrives once it answers again. A force-deleted Secret's last files
stay until the workload ends.

Programs that create short-lived Secrets can start their names with `_`, as
in `_job-123-token`. `anycloud secrets list` hides those unless you pass
`--all`.

## Git access from workloads

Anycloud doesn't pass your sign-in token into workloads. A workload that runs
`git clone`, `git fetch`, `git pull`, or `gh` against a private repository needs
a GitHub token that you give it through a Secret.

1. Create a [fine-grained personal access
   token](https://github.com/settings/personal-access-tokens/new). Set
   **Resource owner** to the organization that owns the repositories, select
   only the repositories your workloads use, and grant **Contents: Read-only**
   (read and write only if they push). Set an expiration. If your organization
   requires approval for fine-grained tokens, an owner approves it once.
   For a quick trial, `gh auth token` works too, but it's broader and tied to you.

2. Store it as a Secret named `github`:

   ```bash
   anycloud secrets new github GITHUB_TOKEN=github_pat_xxxxxxxxxxxx
   # or, with the GitHub CLI:
   anycloud secrets new github GITHUB_TOKEN="$(gh auth token)"
   ```

3. Add `--secret github` when you submit:

   ```bash
   anycloud job ghcr.io/acme/train:latest --secret github
   ```

   Inside the container, `GITHUB_TOKEN` holds the token. A credential helper or
   an `insteadOf` rewrite such as
   `git config --global url."https://x-access-token:${GITHUB_TOKEN}@github.com/".insteadOf "https://github.com/"`
   lets Git use it.

To rotate, save the new token under the same name. New Jobs, resubmissions,
and spot replacements pick it up; run `anycloud service upgrade` for a running
Service.

```bash
anycloud secrets new github GITHUB_TOKEN=github_pat_rotated
```

If Git reports `Authentication failed` or `Repository not found`, the workload
is missing `--secret github`, or the token doesn't cover that repository.

## Storage and threat model

Secret values are encrypted in the local Anycloud database with libsodium
(XSalsa20-Poly1305). The API offers create, list, and delete operations but no
operation that returns a value.

At workload startup, resolved Secret values are sent over SSH channel stdin,
so their contents never appear in the remote command or its retry logs. They are written to
`/run/anycloud-secrets/env` with mode `0600` and supplied to Docker through
`--env-file`, and each key to `/run/anycloud-secrets/files/<name>/<KEY>`,
mounted read-only into the container. A saved Secret's new values travel the
same way to running VM hosts. VM hosts use their memory-backed `/run`. Fresh submissions,
resubmissions, and service upgrades preflight named Secret references before
changing workload state or provisioning; workload startup resolves the
current values again to catch deletion or rotation between the request and
container start.

Anycloud uses your sign-in token only to pull private GHCR images and to
publish Service hostnames. Workload containers don't receive it.

Docker inlines environment values into the container's run configuration.
Anyone with root access on the VM can read them through `docker inspect` or a
process environment. Secrets keep values out of plaintext local storage and out
of Anycloud API responses such as list and status, but anyone who can open a
shell in the workload can read them. On a hosted API that includes every
admitted member, through `anycloud exec` or `anycloud ssh`, including a
`GITHUB_TOKEN` you supply through a Secret. Secrets are not a defense against a
VM-root attacker.

See [`secrets` reference](/reference/cli/secrets) for exact command syntax.

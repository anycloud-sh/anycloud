---
title: secrets
description: Exact syntax for creating, listing, and deleting write-only Secret bundles.
---

# `anycloud secrets`

```bash
anycloud secrets new <name> KEY=VALUE [KEY=VALUE ...]
anycloud secrets list [--all]
anycloud secrets delete <name> [--force]
```

`new` creates or replaces a named bundle; running Jobs, Services and VMs see
the new values in their [Secret files](/platform/secrets-environment#read-secrets-as-files)
within seconds. `list` returns names and timestamps, never values. A name may
start with one `_`, which hides it from `list` unless `--all` is passed.

| Option        | Description                                                                            |
| ------------- | -------------------------------------------------------------------------------------- |
| `--all`       | `list`: include Secrets whose names start with `_`                                     |
| `-f, --force` | `delete`: delete even when a non-terminal workload or a Deployment references the name |

Without `--force`, deleting a referenced Secret returns `409 Conflict` with
the blocking workload and Deployment IDs. Forced deletion does not remove
values or files already in a running container, but a future VM start that
still references the missing name fails, and a Deployment that references it
stops reconciling (see [Deployment Secrets](deployments.md#named-secrets)).

Inject a Secret by repeating `--secret` on `job`, `service`, `vm` or
`deployment create`:

```bash
anycloud secrets new model-access HF_TOKEN=hf_...

anycloud job IMAGE \
  --secret model-access \
  --secret experiment-tracking
```

See [Secrets & Environment](/platform/secrets-environment) for precedence,
rotation, and threat model.

---
title: quota
description: Exact syntax for inspecting cloud provider quota limits and request history.
---

# `anycloud quota`

Use the AWS or Azure CLI or portal to request an increase with the desired
limit. `anycloud quota status` then shows the provider's request history and
current limits, including requests made outside Anycloud.

## `anycloud quota status`

List requests and current quota:

```bash
anycloud quota status \
  [--credentials NAME] \
  [--region REGION] \
  [--spot | --on-demand] \
  [--json]
anycloud quota status --canceled [--json]
anycloud quota status --cloud aws|gcp|azure --region REGION \
  [--spot | --on-demand] [--json]
```

| Option               | Description                                             |
| -------------------- | ------------------------------------------------------- |
| `--credentials NAME` | Named credentials; prompted in a TTY when omitted       |
| `--region REGION`    | One region; omit to query every catalog region          |
| `--spot`             | Only spot/preemptible quota; without either, a TTY asks |
| `--on-demand`        | Only on-demand quota                                    |
| `--json`             | JSON; automatically enabled outside a TTY               |
| `--canceled`         | Show canceled local submissions without provider access |
| `--cloud CLOUD`      | Read current limits through that cloud's own CLI        |

AWS output includes recent Service Quotas request history and current EC2
limits, including partial grants. A limit AWS failed to return, such as for a
key still propagating or a throttled read, is a `kind: "unavailable"` row with
AWS's error. The API keeps that result 30 seconds, so retry after that. A region
whose read timed out gets one such row.

Azure output includes pending Quota API requests, open quota support cases, and
relevant GPU-family, aggregate, and public-IP limits.

Azure status uses Microsoft.Compute limits even when Microsoft.Quota is
unavailable. JSON output includes `kind: "unavailable"` rows naming missing
request or Network data; terminal output shows the same warnings above the
quota matrix. Results from successful regions remain visible when another
region cannot be read. A failed Compute read cannot be mistaken for a complete
GPU quota status: if every regional Compute read fails, the command reports an
error even if Network limits were available. A successful provider read with no
matching quotas shows no rows.

Use `anycloud quota status --canceled` to list canceled local submissions
across your credentials even if a credential has been removed or its provider
cannot be reached. This view reads local history only and takes no other
filter.

## Before an installation exists

`anycloud quota status --cloud CLOUD --region REGION` reads current limits
through the cloud's own CLI (`aws`, `gcloud` or `az`), signed in on this
machine. It needs no API and no saved credential, so you can check capacity
before `anycloud api create`. It shows current limits only, not request
history. It takes no `--credentials` or `--canceled`, and `--spot` or
`--on-demand` filter it without a prompt.

| Cloud | Reads                                                                                     | Right it needs                                                                |
| ----- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| AWS   | Service Quotas for the EC2 vCPU families, spot and on-demand                              | `servicequotas:GetServiceQuota` and `servicequotas:GetAWSDefaultServiceQuota` |
| GCP   | The region's `CPUS`, per-family `*_CPUS` and `*_GPUS` metrics, without committed-use ones | `compute.regions.get`                                                         |
| Azure | The region's regional and low-priority vCPUs and its GPU families                         | `Microsoft.Compute/locations/usages/read`                                     |

An AWS quota the account never changed shows AWS's default value. A quota
Service Quotas has no value for shows as `kind: "unavailable"`, as does any read
that fails for a reason other than rights, with the CLI's error. GCP's
`PREEMPTIBLE_*` metrics count as spot; its other metrics show under both
`--spot` and `--on-demand`, since they also limit spot VMs.

Once its flags parse, a failure prints `{"error": {"code", "message"}}` with
`--json`, using `anycloud api create`'s codes:

- `CLOUD_CLI_UNAVAILABLE` (exit 1): the CLI isn't installed or signed in.
- `CLOUD_RIGHTS_MISSING` (exit 1): the account lacks the right above.
- `INVALID_ARGUMENT` (exit 2): for example, `--region` is missing.
- `UNEXPECTED` (exit 1): any other failure outside the quota reads.

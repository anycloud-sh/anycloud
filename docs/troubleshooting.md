---
sidebar_position: 8
description: Troubleshooting anycloud — understand job states and fix credential, quota, API startup, image, and hardware-selection errors.
---

# Troubleshooting

Common errors and what to do about them. For the full state machine, see [Jobs — Lifecycle](/platform/jobs#lifecycle).

## Job states & failures

### My job is `Errored` — what happened?

`Errored` (🪲) means your container ran but exited non-zero — your code or command failed, not the infrastructure. anycloud does not retry errored jobs. Read the output with `anycloud status <id> --verbose`, fix the problem, and resubmit. See [Jobs — Lifecycle](/platform/jobs#lifecycle).

### What's the difference between `Failed` and `Errored`?

`Failed` (❌) is an infrastructure error — the VM never started. anycloud auto-retries these up to 100 times (through the `Retrying` state) before giving up and marking the job `Failed`. So `Failed` means every setup attempt failed, while `Errored` means your code ran and exited non-zero. See [Jobs — Lifecycle](/platform/jobs#lifecycle).

### My job went `Invalid` and never retried.

`Invalid` (🚫) means the config is wrong — for example, an input bucket that doesn't exist or a single credential the cloud rejected. Invalid jobs are never retried; fix the config and resubmit. Run `anycloud status <id>` for the reason. See [Jobs — Lifecycle](/platform/jobs#lifecycle) and [Cloud Credentials](/platform/cloud-credentials#select-credentials-for-compute).

### What does `Terminated` mean?

`Terminated` (🪦) is user-initiated — someone ran `anycloud terminate <id>` or called `job.terminate()`. It's a terminal state, not a failure. Once its resources finish releasing, run it again with `anycloud resubmit <id>`; an early resubmit tells you to retry after cleanup finishes.

### My job is stuck in `queued`.

Two common causes are:

1. More than 50 workloads are setting up VMs at once (the per-API provisioning cap), so the rest wait for a slot.
2. A spend control — throttle or budget — is at its cap.

The blocking reason shows in `anycloud status <id>` and `anycloud list`, and the job auto-dispatches once a slot frees or the cap clears. See [Jobs — Lifecycle](/platform/jobs#lifecycle) and [Spend Controls](/platform/spend-controls).

### My spot job keeps restarting (`Recovering`).

That's expected on spot. When the cloud preempts the VM, anycloud detects it and re-provisions from scratch through the `Recovering` (🔁) state. Write checkpoints to `/mnt/checkpoint` frequently so a restart resumes with minimal lost work. See [Jobs — Spot recovery](/platform/jobs#spot-recovery).

### How do I get logs from a job that already failed?

`anycloud status <id> --verbose` works after the fact. With an open Python
`Client`, use `client.get(job_id).status()` to inspect state and events. The SDK
does not provide log streaming or download helpers; use the CLI for logs.

### My job was killed (exit 137) or ran out of disk.

Exit code `137` means the container was killed — usually out of memory. Raise `--memory` (and `--shm-size` for PyTorch DataLoaders and other shared-memory use). `No space left on device` means the disk filled up — raise `--disk-size`. If the root disk is full when the image is pulled, the Job fails as `invalid` without retrying; submit it again with a larger `--disk-size`. See [Docker runtime options](/reference/configuration#docker-runtime-options).

## Setup & credentials

### `anycloud api start` fails, or the SDK can't reach the API.

The local API runs as a Docker container, so Docker must be running first. Check
`anycloud api status`; if it's down, run `anycloud api start`. Python's `Client`
uses an explicit `api_url=`, then `API_URL`, then the saved API target, falling
back to `http://localhost:8080`. Check for a stale override or pass
`Client(api_url="http://localhost:8080")`. Generated clients instead take
`Configuration(host="http://localhost:8080/v1")`. See
[SDK configuration](/reference/python-sdk#install-and-configure). The local API
binds to `127.0.0.1` and is not intended for LAN exposure.

### `anycloud api start` or `anycloud update` says the API is still starting.

The container is up but has not answered within 120 seconds, often because a
large database is migrating. It keeps starting by itself; don't stop it. Check
it with `anycloud api status` and `docker logs anycloud-api`.

### `anycloud api start` says the server is already running.

A container is already up. Stop it first with `anycloud api stop`, then `anycloud api start`. (`anycloud update` restarts a running API server for you, so you normally don't need to do this after an update.)

### `No local API token at …`.

The local API's token is missing from `ANYCLOUD_DIR`. Run `anycloud api start`
as the user that runs the CLI, with the same `ANYCLOUD_DIR`. A sandboxed agent
with its own `HOME` needs `ANYCLOUD_DIR` pointed at that directory.

### `A local API is running, but there is no local API token at …`.

The running API started before your CLI's release, for example after a
reinstall without `anycloud update`. Run `anycloud update` to restart it on
this release. If it is current, run the CLI as the user who started it, with the
same `ANYCLOUD_DIR`.

### `A local API accepts only clients on its own machine`.

A local API answers only requests addressed to `localhost`, `127.0.0.1` or
`[::1]`. Run the CLI on the machine that runs the local API, or use a hosted
API for remote access.

### `This hosted API takes only the API tokens it issues, not a GitHub token`.

The request carried a GitHub token, or a loopback URL's local API token
reached a hosted API through a localhost tunnel. Update the CLI, then run
`anycloud login <api-url>` with the hosted API's own URL. A personal access
token or a GitHub Actions token can't be exchanged; see
[API tokens](/reference/cli/api-utilities#api-tokens).

### `This API token was rotated or removed`.

Someone ran `anycloud api token rotate` for your account, or your access was
removed. Run `anycloud login <api-url>` for the current token, and update
`ANYCLOUD_API_TOKEN` wherever CI sets it.

### `GITHUB_SIGN_IN_REQUIRED`.

A 403 with this code means the request needs a GitHub sign-in, even on a local
API: a Service that publishes a public URL (Local Services publish none), or
cluster create, delete and forget. "Your GitHub sign-in was rejected" means
your GitHub token (saved or `GITHUB_TOKEN`) expired or was revoked. Run
`anycloud login`, then retry.

A hosted API keeps the sign-in from your last login to it, so its message names
`anycloud login <api-url>`. GitHub drops that copy when you revoke anycloud's
access, after a year unused, or when you sign in more than ten times elsewhere.
Commands that look up GitHub accounts, such as `api access add`, then answer
`GITHUB_SIGN_IN_REQUIRED`, and the CLI hands the API your current sign-in and
retries once by itself. A private GHCR image or a Service URL fails with its
own error instead; run `anycloud login <api-url>`.

### `No API token for …`.

The Python SDK needs a hosted API's own token: run `anycloud login <api-url>`,
pass `Client(token="acapi_...")`, or set `ANYCLOUD_API_TOKEN` together with
`API_URL`. `Client` checks the explicit token first, then
`ANYCLOUD_API_TOKEN` when `API_URL` names the same API, then
`$ANYCLOUD_DIR/api-tokens.json`. A loopback API takes `local-api-token`
instead; see `No local API token at …` above.
Generated `ApiClient` setup requires an explicit
`Configuration(access_token=...)`; it does not discover CLI state itself.

### Which credential does the SDK use?

For an image Job, pass `client.submit(..., credential_name="aws-prod")` or
inline `cloud_config={"credentials": ...}`. API token discovery does not choose
a cloud compute credential. See
[Credential selection](/reference/configuration#credential-precedence).

### A credential error sent my job to `Invalid` mid-run.

A selected credential the cloud rejects makes the workload `Invalid`
immediately. If the secret itself is unchanged, fix its cloud-side access,
re-save it to clear the invalid mark, and resubmit. Rotating or replacing the
secret creates a new credential identity, so create a new workload with that
credential instead. Anycloud does not switch accounts automatically. See
[Cloud Credentials — Select credentials for compute](/platform/cloud-credentials#select-credentials-for-compute).

## Capacity & quota

### Capacity errors keep my job in `Retrying`.

When the cloud denies capacity for the VM family, anycloud blocks that region and keeps retrying other regions — unless you pinned `--region`, in which case it can only retry the one region. Drop the region pin to let anycloud fail over. See [GPUs & VM Types — Credentials and regions](/platform/gpus-vm-types#credentials-and-regions).

### How do I raise my cloud quota?

Request the desired limit through the [AWS CLI](https://docs.aws.amazon.com/cli/latest/reference/service-quotas/request-service-quota-increase.html), [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/quota), or the provider portal. Then inspect current limits and provider request history:

```bash
anycloud quota status --credentials <name>
```

See the [`quota` reference](/reference/cli/quota).

## Images

### Image pull failed with `denied` or `401`.

For a private image, anycloud pulls it on the VM using your GitHub token. A `denied` / `401` pull error usually means that token is stale — re-run `anycloud login` to re-authenticate. Only private images on GHCR are supported. See [Container Images](/platform/container-images).

<span id="conflicterror--workload-id-already-exists"></span>

### `ConflictException` — workload ID already exists.

You reused a custom `workload_id`. Generated HTTP exceptions expose status
`409` through `ApiException.status`. Use a new ID, or reattach with
`client.get(job_id)` and call `job.resubmit()` once the existing Job is eligible
and cleanup has finished. The CLI equivalent is `anycloud resubmit <id>`. See
[Error handling](/reference/python-sdk#error-handling).

## GPU vs VM selection

### Should I use `--gpu-type` or `--vm-type`?

`--gpu-type` (Python `gpu`) names a GPU like `h100` or `a100:8`
and lets anycloud pick the cheapest matching instance across clouds and regions.
`--vm-type` (Python `cloud_config["vm_type"]`) pins an exact instance. They are
mutually exclusive.

### My container can't see the GPU.

`--gpu-type` / `--vm-type` choose the hardware; anycloud sets up GPU access for you, so the container sees the GPUs with no extra flags. Pass `--gpus` to set a specific device count. See [Container Images — GPU images](/platform/container-images#gpu-images).

### How do I see what GPUs, VM types, or regions are available?

Use the catalog commands: `anycloud gpus <provider>`, `anycloud vm-types <provider> <region>`, `anycloud regions <provider>`, and `anycloud pricing <provider> <vm-type>`. See [Catalog and pricing](/reference/cli/catalog-pricing).

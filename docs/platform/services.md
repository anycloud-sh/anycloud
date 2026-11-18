---
title: Services
description: Run long-lived HTTP workloads on cloud VMs.
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';
import WorkloadLifecycle from '@site/src/components/WorkloadLifecycle';

# Services

A Service is a long-running container that receives HTTP traffic. Use one for
model inference APIs, dashboards, internal web tools, and other HTTP processes
that should remain available instead of exiting after a finite task.

VM-backed Services on providers with public ingress receive a stable URL:

```text
https://<workload-id>.anycloud.sh
```

Use a [Job](/platform/jobs) for training, batch inference, or other work that
should complete and automatically release its VM. Use a [VM](/platform/vms)
for direct SSH access without a managed public HTTP endpoint.

## Start a service

The process inside the container must listen on `0.0.0.0` at the port in
`$PORT`. The default is `8088`.

<Tabs>
<TabItem value="cli" label="CLI">

```bash
anycloud service ghcr.io/acme/model-api:latest \
  --id model-api \
  --credentials my-aws \
  --gpu-type l40s \
  -- python -m myapp
```

The service becomes available at `https://model-api.anycloud.sh`.

</TabItem>
<TabItem value="python" label="Python">

Use the generated admission operation for Services. `Client.submit()` creates
Jobs, so the request below sets `workloadType` explicitly:

```python
from anycloud import Client
from anycloud.api.workload_admission_api import WorkloadAdmissionApi
from anycloud.models.workload_admission_input import WorkloadAdmissionInput

with Client() as client:
    service = WorkloadAdmissionApi(client.api_client).submit_workload_sync(
        client.sdk_version,
        WorkloadAdmissionInput.from_dict({
            "id": "model-api",
            "image": "ghcr.io/acme/model-api:latest",
            "workloadType": "service",
            "gpuType": "l40s",
            "command": ["python", "-m", "myapp"],
            "credentialName": "my-aws",
            "cloudConfig": {},
        }),
    )
    print(service.url)
```

</TabItem>
</Tabs>

Override the listening port with `--env PORT=9000` or
`"env": {"PORT": "9000"}` in the Python request. For a VM-backed Service,
the public URL still routes to the configured port.

## Lifecycle

<WorkloadLifecycle kind="service" />

A Service stops at `running` instead of completing. It remains there until you
terminate it or start an upgrade. An upgrade enters `recovering`, replaces the
backing workload, and returns through `queued` while preserving the Service
ID and, when present, public URL. This replacement has downtime while the old
workload stops and the replacement becomes ready.

Replacement waits for the provider to confirm release of the old VM. Pending
cleanup keeps the Service in `recovering` without consuming setup retry attempts.

For VM-backed Services with public ingress, startup waits up to 60 seconds for
both authoritative DNS servers to publish the Service hostname before reporting
`running`. A slow publication keeps its DNS diagnostic and goes through normal
startup recovery.

The API queries those servers directly, so its network must allow outbound DNS
on port 53 to them. If neither server answers, a VM-backed Service fails without
retrying, with an error naming port 53 and both servers.

## Service behavior

- Services use on-demand VM capacity. Spot is rejected because an HTTP endpoint
  cannot use the Job checkpoint-and-restart contract.
- Job input/output buckets do not apply.
- Services can attach one pre-existing checkpoint bucket at
  `/mnt/checkpoint`. The Service must use a selected compute credential, and that
  compute identity supplies bucket access by default. Use
  `--checkpoint-storage-credentials NAME` to select a separate AWS credential,
  including when compute runs on Lambda. Local Services do not support
  checkpoint buckets yet.
- Services use the same environment, secret, placement, disk, and Docker
  options as VM-backed Jobs.
- A service stays live until you terminate or upgrade it. It does not
  automatically shut down when a request completes.
- On VM-backed providers with public ingress, Anycloud exposes the application
  through its Anycloud URL.
  Your process should bind inside the container, not attempt to manage the URL.

## Separate S3 checkpoint credentials

Create the bucket first, then attach it using a saved AWS credential with
read-write access:

```bash
anycloud service ghcr.io/acme/app:v1 \
  --credentials my-lambda \
  --vm-type cpu_4x_general \
  --checkpoint-bucket app-state \
  --checkpoint-storage-credentials my-aws \
  --checkpoint-storage-region us-east-1
```

The API mints temporary credentials scoped to the bucket. The saved AWS
credential must be a long-term IAM user credential with `sts:GetFederationToken`
permission and bucket access. Its long-term keys stay on the API.

While the Service runs, the API renews credentials five minutes before their
actual expiration, retrying failures through workload reconciliation. An API
restart remints them. Each upload pass reads the current credential file. If
the API remains offline beyond expiration, uploads pause until renewal succeeds;
the application can continue writing locally. Inspect API diagnostics and bucket
sync status for renewal or upload failures.

After creating a Service with separate checkpoint credentials through a local
API, `anycloud service` prints this warning in both
interactive and non-interactive launches:

> This Service uses temporary S3 checkpoint credentials renewed by your local
> API. Keep this computer awake and the API running and connected. If credentials
> expire while the API is offline, checkpoint uploads pause until renewal
> succeeds. The Service keeps running.

Bucket sync copies files; applications must produce complete, consistent
snapshots of databases before publishing them under `/mnt/checkpoint`.
Recovery reaches the latest completed upload, not necessarily the latest local
write or snapshot.

## Upgrade in place

Upgrade replaces the backing workload while preserving its ID and, when
present, public URL:

```bash
anycloud service upgrade model-api ghcr.io/acme/model-api:v2 \
  -- python -m myapp
```

Use an immutable image tag or digest when you need an auditable rollout. See
[`service` reference](/reference/cli/service) for the complete upgrade syntax.

Use `--env` or `--env-file` to merge environment changes during upgrade.
`--bind` replaces the complete mount list, so include every mount you want to
keep. Named volumes and host paths belong to each VM; preserve working files
before replacement. Omitting these options keeps the existing configuration.

With `--checkpoint-bucket`, Anycloud stops the old workload and completes a
final checkpoint upload before removing its VM. The replacement restores that
bucket before starting the new container. If the final upload fails, the old VM
is retained for retry instead of continuing with stale state.

## Operate a service

Services share the common workload commands:

```bash
anycloud wait model-api
anycloud status model-api
anycloud logs model-api
anycloud exec model-api "nvidia-smi"
anycloud terminate model-api
```

`wait` returns once the Service is running (exit `0`), or exits `1` if it
fails first. Create and wait in one step with
`anycloud service <image> --wait`.

Termination safely flushes a configured checkpoint
before removing the backing VM. The `terminate` command schedules cleanup and
returns immediately.

Python uses the generated `WorkloadsApi` status and termination operations.
To inspect an existing Service:

```python
from anycloud import Client
from anycloud.api.workloads_api import WorkloadsApi

with Client() as client:
    workloads = WorkloadsApi(client.api_client)
    status = workloads.get_workload_status_sync("model-api", client.sdk_version)
    print(status.workload.state)
```

To terminate it:

```python
from anycloud import Client
from anycloud.api.workloads_api import WorkloadsApi

with Client() as client:
    WorkloadsApi(client.api_client).terminate_workload_sync(
        "model-api", client.sdk_version
    )
```

Termination schedules cleanup and returns immediately. Use the CLI for live
logs and exec; the Python SDK does not include those native transports.

# AnyCloud Python SDK

Submit Jobs, run persistent Kubernetes Deployments, and manage your cloud resources with
[AnyCloud](https://anycloud.sh/). Python 3.10 or newer is required. One
`anycloud-sdk` installation provides `anycloud` and `anycloud_workflows`.

## Install and configure

```bash
pip install anycloud-sdk
```

Follow [Getting Started](https://anycloud.sh/getting-started/) to start or select
an API, log in, and save a cloud credential. `Client()` reuses the CLI's API
target and authentication:

```python
from anycloud import Client

with Client() as client:
    print(client.sdk_version)
```

The API URL comes from an explicit `api_url=`, then `API_URL`, then
`$ANYCLOUD_DIR/api-url` (default `~/.anycloud/api-url`), falling back to
`http://localhost:8080`. Authentication comes from an explicit `token=`. A
loopback API URL then uses `$ANYCLOUD_DIR/local-api-token`, which
`anycloud api start` writes. A hosted API takes its own API token:
`ANYCLOUD_API_TOKEN` when `API_URL` names that API, then the token
`anycloud login <api-url>` saved in `$ANYCLOUD_DIR/api-tokens.json`. Explicit
arguments always win: `token=` is the bearer as given,
so against a local API pass its install token. The
context manager closes the client's connections.

API authentication does not select a cloud compute credential. Pass a saved
credential with `credential_name=` on each image-based submission.

## Submit a dedicated Job

Publish an image containing your code and dependencies. Select its command
with a list of arguments; use an immutable tag or digest when reproducibility
matters:

```python
from anycloud import Client

with Client() as client:
    job = client.submit(
        "ghcr.io/acme/trainer:git-a1b2c3d",
        credential_name="aws-prod",
        gpu="h100:8",
        cloud_config={"region": "us-east-1", "spot": True},
        env={"LR": "0.01"},
        command=["python", "-m", "training"],
    )
    print(job.id, job.status().workload.state)
    job.wait(timeout_seconds=3600)
    print(job.last_status.workload.state)
```

`submit()` returns a `Job` handle. Use `status()` to fetch current state,
`wait()` to wait for successful completion, and `terminate()` to request
termination. Keep the owning `Client` open while using its handles.

The async workflow uses the same arguments and completion behavior:

```python
import asyncio

from anycloud import AsyncClient


async def main() -> None:
    async with AsyncClient() as client:
        job = await client.submit(
            "ghcr.io/acme/trainer:git-a1b2c3d",
            credential_name="aws-prod",
            gpu="h100:8",
            cloud_config={"region": "us-east-1", "spot": True},
            env={"LR": "0.01"},
            command=["python", "-m", "training"],
        )
        print(job.id, (await job.status()).workload.state)
        await job.wait(timeout_seconds=3600)
        print(job.last_status.workload.state)


asyncio.run(main())
```

[`job_completion.py`](examples/job_completion.py) contains runnable examples
for both clients. HTTP calls and async polling allow other tasks to progress.

### Chain Jobs with shared storage

Wait for one Job before submitting its dependent Job. Attach bucket names
through `cloud_config` to pass data between workloads:

```python
from anycloud import Client

with Client() as client:
    prep = client.submit(
        "ghcr.io/acme/prep:latest",
        credential_name="aws-prod",
        gpu="h100",
        cloud_config={"output_bucket": "prepared-data"},
    )
    prep.wait()

    train = client.submit(
        "ghcr.io/acme/trainer:latest",
        credential_name="aws-prod",
        gpu="h100:8",
        cloud_config={
            "input_bucket": "prepared-data",
            "output_bucket": "trained-models",
        },
    )
    train.wait()
```

The first image writes `/mnt/output`; the next reads `/mnt/input`. Input
buckets must already exist, and output buckets can be created by the API. A
Job's input and output bucket names must differ. Use separate buckets or
application-managed output prefixes for concurrent workflows. See
[Buckets](https://anycloud.sh/platform/buckets/) for checkpoint storage and sync
guarantees.

## Submit to an existing Deployment

A Deployment supplies the container, credentials, and compute settings. Submit its
name or ID and, optionally, your own Job ID:

```python
from anycloud import Client

with Client() as client:
    job = client.submit(deployment="model-deployments", workload_id="request-123")
    status = job.status()
    state = status.workload.state

    if state in {"completed", "errored", "failed", "invalid", "terminated"}:
        print("Job finished:", state)
    elif state == "running":
        print("Deployment picked up the Job")
    elif state == "queued":
        if status.jobs_ahead is None:
            print("Queue position is unavailable")
        elif status.jobs_ahead == 0:
            print("First in the queue; waiting for pickup")
        else:
            print("Jobs ahead:", status.jobs_ahead)

        deployment = client.get_deployment("model-deployments")
        workload = deployment.workload
        if deployment.deletion_requested_at is not None or deployment.deleted_at is not None:
            print("Deployment is draining or deleted")
        elif workload is None or workload.observed_generation != deployment.generation:
            print("Current Deployment readiness is not yet known")
        elif not workload.container_ready:
            print("Current Deployment container is not ready")
        else:
            print("Current Deployment container is ready")
        print("Total queued:", deployment.jobs.queued)
        print("Jobs holding a slot:", deployment.jobs.unreleased)
    else:
        print("Job state:", state)
```

Supply exactly one of `image` or `deployment`. The Deployment must be a name/ID string,
not a `DeploymentSummary`; use `deployment.id` for a returned summary. Deployment-targeted
submissions reject execution options, including empty mappings or lists.

Queue position and capacity are advisory. `jobs_ahead` counts earlier Jobs in
the shared Deployment queue; `None` also applies outside a queued targeted Job.
Deployment lookup is a separate observation from Job status. `jobs.unreleased`
counts Jobs still holding a slot during cleanup, and readiness must describe
the current revision. Terminated Deployments cannot accept work. Zero
Jobs ahead and a ready Deployment do not guarantee immediate pickup; only Job state
`"running"` confirms it. See the
[queue-status reference](https://anycloud.sh/reference/python-sdk/#jobs-on-deployments)
for details.

## Async Deployment submission

Use `AsyncClient` in an async backend to submit a Deployment Job and await its first
durable claim with the same configuration and guarantees as `Client`:

```python
import asyncio

from anycloud import AsyncClient
from anycloud_workflows import JobSubmissionExpired, JobSubmissionUncertain


async def main() -> None:
    async with AsyncClient() as client:
        try:
            job = await client.submit(deployment="model-deployments", timeout=5, wait=True)
        except JobSubmissionExpired as error:
            print("Expired before pickup:", error.job.id)
        except JobSubmissionUncertain as error:
            print("Submission outcome unknown; retain this ID:", error.job.id)
        else:
            print("Claimed:", job.id)


asyncio.run(main())
```

`timeout=5` is the server's admission-to-first-claim deadline. Confirmed expiry
means that submission cannot start later, so another provider can be scheduled.
An HTTP timeout or lost response is uncertain; observe `error.job` or reattach
with `await client.get(saved_id)` before deciding whether to fall back.
Observation never resubmits work.

Share one `AsyncClient` across concurrent handlers on the same event loop.
`AsyncClient` supports every `Client` submission and Deployment management method,
including `await client.create_deployment(...)`, `list_deployments()`, `get_deployment()`,
`update_deployment()`, and `delete_deployment()`. Each async method takes the same
arguments and returns the corresponding generated models or `AsyncJob` handle.
`AsyncJob` provides `await job.wait()`, `wait_for_claim()`, `status()`,
`terminate()`, and explicit `resubmit(...)`.

Image Jobs use `await job.wait()` for completion. First-claim deadlines and
`wait=True` remain specific to Deployment submissions. Services and other API
families use generated operations through `client.api_client`. Task cancellation
propagates normally; supply and save `workload_id` before submission if you
need to recover after a local timeout or request cancellation. Close the client
with its async context manager or `await client.aclose()`.

See the [async reference](https://anycloud.sh/reference/python-sdk/#async-operations)
and the runnable [`async_deployment_submission.py`](examples/async_deployment_submission.py)
request-handler example.

Deployment management preserves the synchronous update rules. For example:

```python
from anycloud import AsyncClient


async def clear_deployment_environment(client: AsyncClient, deployment: str) -> None:
    updated = await client.update_deployment(deployment, env=None)
    print(updated.env_keys)
    for item in await client.list_deployments():
        print(item.name, item.jobs.queued)
```

Omitting `env` preserves it; explicit `None` clears it. Deleting a Deployment requests
draining and does not wait for Jobs or Pods to finish.

## Wait, terminate, or reattach

Save `job.id` to observe the same Job from another process:

```python
from anycloud import Client
from anycloud_workflows import WorkloadWaitTimeout, JobFailedError

with Client() as client:
    job = client.get("request-123")
    try:
        job.wait(timeout_seconds=900, poll_interval_seconds=2)
    except JobFailedError as error:
        print(error.workload_id, error.state)
        print(error.status.workload.state)
    except WorkloadWaitTimeout:
        print("Still waiting; requesting termination")
        job.terminate()
```

`wait()` returns the same handle after `completed`. Other terminal states raise
`JobFailedError`, whose `status` contains the terminal response.
`WorkloadWaitTimeout` only stops polling; this example explicitly chooses to
terminate afterward. Termination is a request and does not wait for cleanup.

`get(id)` fetches status and returns a handle with `last_status` populated and
`submission=None`. An eligible terminal Job can be submitted again with
`job.resubmit()`. It keeps the same ID, returns a generated `WorkloadResubmitResponse`,
and clears `last_status` after success. The API requires a resubmittable terminal
state and completed cleanup, so immediate resubmission after `terminate()` can
fail. Resubmission uses the client's configured request timeout as its elapsed
request budget.

## Handle Jobs inside a Deployment

Install the same SDK in the Deployment image. `current_deployment()` discovers the
injected Deployment identity and rotating workload token. This sequential example
defines a handler that performs ten short work steps and checks cancellation
between them:

```python
import time

import httpx

from anycloud.exceptions import ServiceException
from anycloud_workflows import CurrentJob, current_deployment


def handle(job: CurrentJob) -> None:
    for step in range(10):
        if job.cancellation_requested():
            job.cleanup()
            return
        print(f"Processing {job.id}: step {step}")
        time.sleep(1)  # Replace this step with your application's work.
    job.complete()


with current_deployment() as deployment:
    while True:
        try:
            job = deployment.next_job()
        except (httpx.HTTPError, ServiceException, TimeoutError):
            time.sleep(1)
            continue  # Replays the pending acquisition request safely.
        if job is None:
            continue
        handle(job)
```

`next_job(timeout=20)` waits up to 20 seconds to discover a candidate, claims it,
and returns its `CurrentJob`. A waiting receive wakes on committed availability
or Kubernetes Pod changes and checks current identity and readiness again.
An empty bounded receive needs no additional sleep. Pace repeated immediate
`timeout=0` lookups in application code. An attempted claim may resolve later within the
separate request budget. Omitting `timeout` uses the 20-second wait; passing
`timeout=0` performs one immediate lookup. `None` means this call
has no unresolved claim that can assign work later. Keep the same context after
an exception: it retries the exact pending claim before discovering other work,
even when the next call uses a different timeout. Request timeouts remain
exceptions. `current_deployment(timeout_seconds=...)` sets the separate elapsed
request budget, capped at 30 seconds and shared by caller serialization,
discovery, claim, decoding, and cancellation. Lifecycle calls remain usable
while discovery waits.

For submission, `client.submit(deployment="model-deployments", timeout=30, wait=True)`
returns after a durable first claim. Use `job.wait()` separately for completion.
With `wait=False`, `job.wait_for_claim()` observes the persisted deadline later.
Confirmed `JobSubmissionExpired` means the submission cannot start later;
`JobSubmissionTerminated` and `JobSubmissionChanged` distinguish other pre-claim
termination and explicit resubmission. These exceptions retain `.job`,
`.workload_id`, and `.revision` for recovery. Deployment `Client.submit()` raises
`JobSubmissionUncertain` with the unreturned `.job` and original `.cause` when
admission is uncertain or its internal claim wait fails. Definitive admission
rejections retain their generated exception types.
Existing-handle request errors keep their original types. These submission
exceptions are exported from `anycloud_workflows`.

`job.resubmit(timeout=..., wait=True)` keeps the ID and acknowledges a new
revision; omission clears the old deadline. Automatic retries preserve their
first-claim evidence. Use matching API/SDK releases.

Handlers need only the Job handle. Alongside `complete()`, they can report
`error(message)`, `invalid(message)`, or `retry(message)`.
`cancellation_requested()` returns a `bool`; outcome methods and `cleanup()`
return `None`. Cancellation is cooperative: stop work and release its resources
before calling `cleanup()`. Outcomes do not stop application tasks for you.

For a cancellation watcher running alongside the work, call
`job.cancellation_requested(timeout=20)`. It holds one request until termination,
the execution ends, or the wait expires. `timeout` accepts 0 through 20 seconds;
the default `0` checks immediately, as in the example above. A waiting call
blocks its calling thread, while completion and cleanup remain available through
separate connections. `False` means no termination was observed, including when
the wait expires or the Job completes or retries. Keep watching only while the
local task is active.

Transport and stale-execution errors remain exceptions. After a transient
disconnect or API restart, callers can repeat the wait on the same handle within
their own retry deadline; the API reads persisted state. Resubmission starts a
new submission and is not required to resume observation.

Your application owns invocation lookup, concurrency, capacity, and liveness.
Call `next_job()` only when there is capacity to handle another Job, keep the
context open until every handler finishes, and exit if the critical acquisition
loop dies so Kubernetes can replace the process. Every operation refreshes the
projected token and preserves generated API exceptions.

`job.selected` exposes the original generated `SelectedJob`. Context lifecycle
methods also accept handles or generated selections. For applications that own
their generated client, `DeploymentJobPoller.next_job()` returns `SelectedJob`
directly.

## Create and manage Deployments

Create a Deployment on an existing node pool and pass its ID to `submit()`:

```python
from anycloud import Client

with Client() as client:
    deployment = client.create_deployment(
        "model-deployments",
        "ghcr.io/acme/model-deployment:latest",
        node_pool="training",
        command=["python", "deployment.py"],
        max_concurrent_jobs_per_replica=4,
    )
    job = client.submit(deployment=deployment.id)
    print(job.id)
```

`create_deployment()`, `get_deployment()`, `update_deployment()`, and `delete_deployment()`
return generated `DeploymentSummary` models. Updates preserve omitted settings;
explicit `None` clears only `command`, `env`, `secrets`, or `docker_options`. Deletion
starts draining without waiting for active Jobs or Pods to finish.

List Deployments across node pools or filter by node pool name or ID:

```python
from anycloud import Client

with Client(request_timeout_seconds=10) as client:
    all_deployments = client.list_deployments()
    deployments = client.list_deployments(node_pool="training")
    print([deployment.name for deployment in deployments])
```

`list_deployments()` returns a list of `DeploymentSummary` models, or an empty list when
no Deployments match. Omitting `node_pool` or passing `None` lists all Deployments. The
optional request timeout is shared by the Client's operations and defaults to
30 seconds.

The node pool's VM type determines GPU capacity. On verified NVIDIA capacity, omitting GPU
options uses all GPUs on one capacity VM; CPU capacity requests none. Use
`docker_options={"gpus": "all"}` or a positive integer string such as
`{"gpus": "1"}` for explicit GPU access.
Deployments do not accept named application Secrets; use an application-owned
secret source rather than putting sensitive values in `env`.

## Other resource operations

Use generated API-family clients for credentials, secrets, bucket metadata,
Services, and other operations. They share the workflow client's connections
and SDK version:

```python
from anycloud import Client
from anycloud.api.buckets_api import BucketsApi
from anycloud.api.credentials_api import CredentialsApi
from anycloud.api.secrets_api import SecretsApi
from anycloud.models.save_secret_body import SaveSecretBody

with Client() as client:
    credentials = CredentialsApi(client.api_client).list_credentials_sync(
        client.sdk_version
    )
    print([credential.to_dict()["name"] for credential in credentials])

    SecretsApi(client.api_client).save_secret_sync(
        "training",
        client.sdk_version,
        SaveSecretBody(values={"TOKEN": "replace-with-your-application-token"}),
    )
    job = client.submit(
        "ghcr.io/acme/trainer:latest",
        credential_name="aws-prod",
        gpu="h100",
        secrets=["training"],
    )
    print(job.id)

    page = BucketsApi(client.api_client).list_buckets_sync(
        "aws-prod", client.sdk_version, page_size="100"
    )
    for bucket in page.buckets:
        print(bucket.to_dict()["name"])
```

Saving a secret stores it; `secrets=["training"]` injects its values into the
Job. Bucket listings return a page; use `next_cursor` to request subsequent
pages. Generated response models use Python field names on attributes and
wire names in `from_dict()` and `to_dict()`. Union models expose their selected
model through `actual_instance`; `to_dict()` also works across these variants.

### Generated clients and asynchronous calls

Generated API operations have asynchronous methods and synchronous `_sync`
variants. If you construct `ApiClient` directly, supply the API host ending in
`/v1`, authentication, and the exact installed SDK version:

```python
import asyncio
import os
from importlib.metadata import version

from anycloud.api.secrets_api import SecretsApi
from anycloud.api_client import ApiClient
from anycloud.configuration import Configuration


async def main() -> None:
    configuration = Configuration(
        host="http://localhost:8080/v1",
        access_token=os.environ["GITHUB_TOKEN"],
    )
    async with ApiClient(configuration) as client:
        secrets = await SecretsApi(client).list_secrets(version("anycloud-sdk"))
        print([secret.name for secret in secrets])


asyncio.run(main())
```

`Configuration` does not perform the workflow client's CLI discovery. The
lower-level `anycloud_workflows.wait_for_terminal_workload()` accepts an
existing generated client and returns a generated status response at any
terminal state. See the
[SDK reference](https://anycloud.sh/reference/python-sdk/) for generated
workload operations, method arguments, and return models.

## Errors and current limitations

Generated API exceptions retain their types, except for uncertain Deployment
submission wrapped in `JobSubmissionUncertain` with its recovery handle.
Catch `anycloud.exceptions.ApiException` or a status-specific subclass, such as
`ConflictException`. HTTP status is in `error.status`; declared error data is
in `error.data`. See
[error handling](https://anycloud.sh/reference/python-sdk/#error-handling) for
typed error examples.

`from anycloud import Client` and `from anycloud_workflows import Client` refer
to the same class; the corresponding `AsyncClient` imports also share one class.
Import `AsyncJob`, `current_deployment`, `CurrentJob`, and polling errors
from `anycloud_workflows`. Select compute credentials per submission with
`credential_name=`, and use `timeout_seconds=` for waiting.

Service handles, `JobGroup`, `submit_many()`, and `get_or_submit()` are not
available. Compose independent Jobs with ordinary Python loops and use
generated operations for Services. SDK log streaming, exec, bucket handles,
and bucket uploads and downloads are also absent; use the CLI for those
transports. Bucket metadata operations and workload storage attachments remain
available as shown above.

For contributor guidance, read [`extensions/README.md`](extensions/README.md).
Generated source lives under `generated/anycloud` and must not be edited by
hand. Run `yarn generate:python-sdk` from the repository root after a contract
or package-version change.

---
sidebar_position: 2
sidebar_label: Python SDK
description: Submit, wait on and manage Jobs with the Python SDK.
---

# Python SDK

Use Python to submit containerized Jobs and follow their progress. `Client`
handles API configuration and authentication for Job operations.
[`AsyncClient`](#async-operations) provides the same Job submission and
completion workflows with `await`. Other
operations, including Services and bucket management, are available through the
generated API clients.

<span id="prerequisites"></span>
<span id="install"></span>
<span id="configuration"></span>
<span id="environment-variables"></span>

## Install and configure

Install `anycloud-sdk` with Python 3.10 or newer. The distribution includes both
`anycloud` and `anycloud_workflows`:

```bash
pip install anycloud-sdk
```

You need a running AnyCloud API, a login token, and a saved compute credential
for remote VM Jobs. See [Getting Started](/getting-started) for setup. Use the
SDK version that matches your API version.

```python
from anycloud import Client

with Client() as client:
    print(client.sdk_version)
```

Both `Client` and `AsyncClient` discover configuration in this order:

| Setting   | Precedence, highest first                                                                                                                                |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API URL   | `api_url=` argument, `API_URL`, `$ANYCLOUD_DIR/api-url`, `http://localhost:8080`                                                                         |
| API token | `token=` argument; a loopback API: `$ANYCLOUD_DIR/local-api-token`; a hosted API: `ANYCLOUD_API_TOKEN` (with `API_URL`), `$ANYCLOUD_DIR/api-tokens.json` |

`ANYCLOUD_DIR` defaults to `~/.anycloud`. `anycloud api start` writes the local
API's token, `anycloud login` saves the GitHub token, and `anycloud api use`
saves the API target. A loopback API takes only its own token; a signed-in
GitHub token rides beside it for private images, Services and clusters, and an
unreadable saved one counts as signed out. A hosted API takes only its own API
token: `ANYCLOUD_API_TOKEN` when `API_URL` names that API, then the token
`anycloud login <api-url>` saved. See
[API tokens](/reference/cli/api-utilities#api-tokens). Upgrade a hosted API
with `anycloud api upgrade` before upgrading the SDK: an older one doesn't
accept API tokens. An
explicit `token=` is sent as the bearer as given: against a local API, pass its
install token. To override discovery, pass
`Client(api_url="https://api.example.com", token="acapi_...")`.
The client accepts an API URL with or without `/v1`. Empty explicit values,
invalid URLs, and unreadable configuration files raise `ValueError`.

API authentication does not select cloud compute credentials. Pass
`credential_name` on each remote image submission, or supply inline credentials
through `cloud_config`.

<span id="context-manager"></span>

Keep the `with Client()` context open while using its Job handles. The context
closes its connections when it exits; applications managing the lifetime
explicitly can call `client.close()`.
Use `async with AsyncClient()` or `await client.aclose()` for an async client.

<span id="job-convenience-client"></span>
<span id="quick-start"></span>
<span id="workload-images"></span>

## Submit and inspect a Job

A dedicated Job runs a published container image on its own VM. Select a saved
credential and GPU, then inspect the returned handle:

```python
from anycloud import Client

with Client() as client:
    job = client.submit(
        "ghcr.io/acme/trainer:latest",
        credential_name="aws-prod",
        gpu="h100:8",
        cloud_config={"spot": True},
        command=["python", "train.py"],
    )
    print(job.id)
    status = job.status()
    print(status.workload.state)
```

Build your application and its dependencies into the image. Use an immutable
tag or digest when reproducibility matters; `command` overrides the image's
default command. See [Container Images](/platform/container-images).

`submit()` returns after admission; provisioning and execution continue in the
background. `status()` fetches a fresh observation with the Job state and
events. States are strings such as `"queued"`, `"running"`, and `"completed"`.
See [Job lifecycle](/platform/jobs#lifecycle) for their meaning.

Status includes the most recent 200 events; `events_total` counts the full
history. To fetch every event, call the generated Workloads API with
`events_limit="all"`.

Use `cloud_config` for spot, region, VM type, disk, or bucket settings, `env` for
environment variables, and `secrets` for saved Secret names. The
[submission reference](#submit-options) lists the arguments, and
[Configuration](/reference/configuration) explains their constraints.

<span id="job-methods"></span>

## Wait and terminate

Use `job.wait()` to wait for successful completion. Save the Job ID to observe
it from another process with `client.get()`:

```python
from anycloud import Client
from anycloud_workflows import WorkloadWaitTimeout, JobFailedError

with Client() as client:
    job = client.get("request-123")  # An existing Job ID.
    try:
        job.wait(timeout_seconds=3600, poll_interval_seconds=2)
        print(f"Completed {job.id}")
    except JobFailedError as error:
        print(f"Job {error.workload_id}: {error.state}")
        print(error.status.events)
    except WorkloadWaitTimeout:
        print(f"Stopped waiting for {job.id}; check its status before deciding what to do")
```

`wait()` returns the same Job handle on `completed`. It raises `JobFailedError`
for `errored`, `failed`, `invalid`, or `terminated`; `error.status` contains the
terminal status response. Omitting `timeout_seconds` waits without a deadline.
A `WorkloadWaitTimeout` stops polling without terminating work.

To stop a Job, request termination explicitly:

```python
from anycloud import Client

with Client() as client:
    job = client.get("request-123")
    response = job.terminate()
    print(response.message)
```

Termination records the terminal state and starts cleanup. It does not wait for
resources to finish releasing. API and transport errors propagate from status,
wait, and termination calls; see [Error handling](#error-handling).

### Reattach to a Job

`client.get(workload_id)` fetches status immediately, checks that the
resource is a Job, and returns a handle. Missing or inaccessible IDs raise a
generated API exception; a Service or VM ID raises `ValueError`.
The handle starts with `last_status` populated and `submission=None`.

For an existing Job in a resubmittable terminal state, after cleanup completes:

```python
from anycloud import Client

with Client() as client:
    job = client.get("request-123")
    job.resubmit()
    job.wait()
```

Resubmission keeps the Job ID and returns a generated `WorkloadResubmitResponse`.
An early resubmission can fail while cleanup is pending. Success clears
`last_status`; a failed request leaves it intact. Any admission response known
to the handle stays available as `submission`.

A resubmitted Job reuses the container configuration accepted at submission.

<span id="chaining-jobs"></span>

## Chain Jobs

Submit the next Job after the previous one completes. Use an output bucket as
the next Job's input to pass data between their containers:

```python
from anycloud import Client

with Client() as client:
    prepared = client.submit(
        "ghcr.io/acme/prepare:latest",
        credential_name="aws-prod",
        gpu="h100",
        cloud_config={"output_bucket": "prepared-training-data"},
    )
    prepared.wait()
    trained = client.submit(
        "ghcr.io/acme/trainer:latest",
        credential_name="aws-prod",
        gpu="h100",
        cloud_config={"input_bucket": "prepared-training-data"},
    )
    trained.wait()
```

The first application writes to `/mnt/output`; the next reads `/mnt/input`.
Use distinct buckets or application prefixes for concurrent runs. A failed wait
raises before the next submission. For parallel independent Jobs, submit them
in a Python loop before waiting; the application owns partial-failure handling.

<span id="client-methods"></span>

## Client reference

`Client(api_url=None, token=None, request_timeout_seconds=30)` discovers any
omitted connection settings. The request timeout applies to submission, status,
termination, and resubmission. `job.wait()` has its own
polling deadline and interval.

### Submit options

`client.submit(image, *, ...)` accepts:

| Argument          | Meaning                                                                    |
| ----------------- | -------------------------------------------------------------------------- |
| `credential_name` | Saved compute credential name.                                             |
| `cloud_config`    | Cloud, region, VM, spot, disk, and bucket settings.                        |
| `gpu`             | GPU model/count string, or an ordered list such as `["h100:8", "a100:8"]`. |
| `env`             | Mapping of environment names to string values.                             |
| `secrets`         | Sequence of saved Secret names.                                            |
| `docker_options`  | Container settings such as `{"shm_size": "8g"}`.                           |
| `command`         | Sequence of command arguments, such as `["python", "train.py"]`.           |
| `workload_id`     | Optional custom Job ID.                                                    |

`cloud_config` and `docker_options` accept generated models or mappings with
Python field names (`vm_type`) or wire aliases (`vmType`). Pass `command` and
`secrets` as sequences rather than a single string.

See [Configuration](/reference/configuration) for field mappings, defaults,
hardware constraints, storage credentials, and environment precedence.

### Handle results

| Member            | Result                                                                          |
| ----------------- | ------------------------------------------------------------------------------- |
| `job.id`          | Job ID string.                                                                  |
| `job.submission`  | Generated `WorkloadAdmissionResponse`, or `None` after reattachment.            |
| `job.status()`    | Fresh generated `WorkloadStatusResponse`, also saved in `last_status`.          |
| `job.last_status` | Last cached status, or `None` before observation/after successful resubmission. |
| `job.wait(...)`   | The same handle on success; raises on unsuccessful terminal state or timeout.   |
| `job.terminate()` | Generated `MessageResponse`; cleanup continues asynchronously.                  |
| `job.resubmit()`  | Generated `WorkloadResubmitResponse`; Job ID stays the same.                    |

<span id="server-methods"></span>
<span id="service-methods"></span>

## Workload operations

Use generated API families for Services, workload listing, cost, and SSH
metadata. They can share a `Client`'s authentication and connections:

```python
from anycloud import Client
from anycloud.api.workload_admission_api import WorkloadAdmissionApi
from anycloud.api.workloads_api import WorkloadsApi
from anycloud.models.workload_admission_input import WorkloadAdmissionInput

with Client() as client:
    service = WorkloadAdmissionApi(client.api_client).submit_workload_sync(
        client.sdk_version,
        WorkloadAdmissionInput.from_dict(
            {
                "workloadType": "service",
                "image": "ghcr.io/acme/inference:latest",
                "credentialName": "aws-prod",
                "cloudConfig": {},
                "gpuType": "l40s",
                "command": ["python", "serve.py"],
            }
        ),
    )
    print(service.id, service.url)
    workloads = WorkloadsApi(client.api_client)
    for workload in workloads.list_workloads_sync(client.sdk_version, limit="20"):
        print(workload.id, workload.state)
```

Service admission does not wait for readiness. Use
`get_workload_status_sync(id, client.sdk_version)` and
`terminate_workload_sync(id, client.sdk_version)` on the same `WorkloadsApi`
instance while the client is open. See [Services](/platform/services) for a full
example; `Client.get()` supports Job handles only.

`list_workloads_sync()` returns generated workload models.
`get_workload_status_sync().workload` exposes identity, lifecycle, and
non-sensitive container metadata. Status responses omit environment,
registry-token, and SSH private-key fields.

### Wait for any workload

The lower-level wait helper returns a generated status response for any terminal
state, including failure, without raising `JobFailedError`:

```python
from anycloud import Client
from anycloud_workflows import wait_for_terminal_workload

with Client() as client:
    status = wait_for_terminal_workload(
        client.api_client,
        "request-123",
        client.sdk_version,
        timeout_seconds=900,
    )
    print(status.workload.state)
```

Use it when you want to handle every terminal state yourself. It raises
`WorkloadWaitTimeout` when the polling deadline expires and preserves API
exceptions. Services normally run until termination, so waiting for a terminal
state does not check Service readiness.

The async counterpart accepts the same arguments and returns the same generated
status type:

```python
from anycloud import AsyncClient
from anycloud_workflows import async_wait_for_terminal_workload


async def observe_terminal_state(workload_id: str) -> str:
    async with AsyncClient() as client:
        status = await async_wait_for_terminal_workload(
            client.api_client,
            workload_id,
            client.sdk_version,
            timeout_seconds=900,
        )
        return status.workload.state
```

Both helpers leave connection ownership with the caller. `timeout_seconds=None`
removes the polling deadline; generated transport errors still propagate.

## Other API families

Use generated API families for operations beyond the workflow helpers. They
share a Client's authentication and connections through `client.api_client`;
pass `client.sdk_version` to management methods.

| API family                                         | Operations                                                                  |
| -------------------------------------------------- | --------------------------------------------------------------------------- |
| `APIAccessApi`                                     | API access policy and admitted users.                                       |
| `BucketsApi`                                       | Bucket creation, deletion, existence, listing, and object listing/deletion. |
| `CredentialsApi`                                   | Saved compute and storage credentials.                                      |
| `DatabaseApi`                                      | Database inspection.                                                        |
| `WorkloadAdmissionApi`, `WorkloadsApi`             | Submit, list, inspect, terminate, resubmit, and query cost/SSH metadata.    |
| `NotificationsApi`, `QuotaApi`, `SpendControlsApi` | Notification, quota, and spending operations.                               |
| `SecretsApi`                                       | Create, list, and delete named Secrets.                                     |
| `ServiceUpgradesApi`                               | Service upgrades.                                                           |

Through a `Client` or `AsyncClient`, `list_buckets`, `list_bucket_objects`
and `bucket_exists` retry a call the cloud provider throttled (HTTP 503
`BUCKET_THROTTLED`) for up to 30 seconds, waiting at least its `Retry-After`,
then raise `ServiceException`. Bucket creation and deletion, and an `ApiClient`
you construct yourself, do not retry.

See [Buckets](/platform/buckets), [Secrets](/platform/secrets-environment), and
[Configuration](/reference/configuration#bucket-credential-rules) for examples.
Generated responses are models with attributes; method arguments and fields
follow the API contract.

## Generated client setup

Applications can construct an `ApiClient` directly. Generated clients require
explicit configuration and the installed SDK version as the
`any_cloud_client_version` argument to management methods; they do not discover
CLI settings themselves. The argument supplies the `AnyCloud-Client-Version`
header and must match the API version.

```python
from importlib.metadata import version

from anycloud.api.workloads_api import WorkloadsApi
from anycloud.api_client import ApiClient
from anycloud.configuration import Configuration
from anycloud.sync_helper import run_sync

api_client = ApiClient(Configuration(
    host="http://localhost:8080/v1",
    access_token="github-access-token",
))
try:
    workloads = WorkloadsApi(api_client).list_workloads_sync(
        version("anycloud-sdk"), limit="20"
    )
    print([workload.id for workload in workloads])
finally:
    run_sync(api_client.close())
```

Set `host` to your selected API URL including `/v1`. `access_token` supplies
Bearer authentication. The application owns this client's lifetime.

## Async operations

`AsyncClient` supports the same Job submission and lifecycle methods as
`Client`. Arguments, defaults, validation,
generated response types, and error meanings match. Use `async with` and
`await`; Job operations return `AsyncJob` handles.

It discovers the same configuration as `Client`. Concurrent request handlers
can share one instance within an event loop. Keep it open for the application's
lifetime and while using its handles.

Submit an image Job and await successful completion:

```python
import asyncio

from anycloud import AsyncClient


async def main() -> None:
    async with AsyncClient() as client:
        job = await client.submit(
            "ghcr.io/acme/trainer:latest",
            credential_name="aws-prod",
            gpu="h100:8",
            cloud_config={"spot": True},
            command=["python", "train.py"],
        )
        print(job.id)
        await job.wait(timeout_seconds=3600)
        print(job.last_status.workload.state)


asyncio.run(main())
```

`await job.wait()` returns the same handle after successful completion. An
unsuccessful terminal state raises `JobFailedError` with its generated status;
`WorkloadWaitTimeout` stops polling without terminating the Job. Image
submissions accept the same [execution settings](#submit-options) as synchronous
submissions.

Task cancellation propagates as `asyncio.CancelledError`. If you impose a local
timeout or need recovery after a disconnected request, supply and save
`workload_id` before awaiting submission, then reattach by that ID. Local
cancellation, including an outer `asyncio.wait_for()` timeout, does not terminate
the remote Job. Request errors and cancellation on an
existing `AsyncJob` propagate unchanged because the caller already holds its
recovery handle.

| Awaitable operation                                       | Result                                                                           |
| --------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `client.submit(image, **options)`                         | An `AsyncJob` after image admission; accepts the synchronous execution settings. |
| `client.get(job_id)`                                      | An `AsyncJob` attached to the current submission, with fetched status.           |
| `job.status()`                                            | Generated `WorkloadStatusResponse`, also cached in `job.last_status`.            |
| `job.wait(timeout_seconds=None, poll_interval_seconds=2)` | The same handle after successful completion.                                     |
| `job.terminate()`                                         | Generated `MessageResponse`; runtime cleanup continues asynchronously.           |
| `job.resubmit()`                                          | Generated `WorkloadResubmitResponse`; the Job ID stays the same.                 |
| `client.aclose()`                                         | Closes the owned generated client's connections.                                 |

`job.id`, `job.submission`, and `job.last_status` are ordinary properties.

Use generated API families for Services, credentials, secrets, and other
operations beyond these helpers. They can share `client.api_client` and
`client.sdk_version`; call methods without the `_sync` suffix. You can also
construct the generated client independently:

```python
import asyncio
from importlib.metadata import version

from anycloud.api.secrets_api import SecretsApi
from anycloud.api_client import ApiClient
from anycloud.configuration import Configuration


async def main() -> None:
    configuration = Configuration(
        host="http://localhost:8080/v1",
        access_token="github-access-token",
    )
    async with ApiClient(configuration) as api_client:
        secrets = await SecretsApi(api_client).list_secrets(version("anycloud-sdk"))
        print([secret.name for secret in secrets])


asyncio.run(main())
```

<span id="typed-errors"></span>

## Error handling

`JobFailedError` and `WorkloadWaitTimeout` describe
[waiting outcomes](#wait-and-terminate). Generated API exceptions retain their
types. Their HTTP status is in `ApiException.status`. Local
argument/configuration checks may raise
`ValueError`, `TypeError`, or model validation errors before a request.

For declared API errors, `error.data.actual_instance` contains the generated
error envelope. For example, deleting a Secret used by an active workload can
raise `ConflictException`:

```python
from anycloud import Client
from anycloud.api.secrets_api import SecretsApi
from anycloud.exceptions import ConflictException
from anycloud.models.secret_in_use_api_error import SecretInUseApiError

with Client() as client:
    try:
        SecretsApi(client.api_client).delete_secret_sync("training", client.sdk_version)
    except ConflictException as error:
        envelope = error.data.actual_instance
        if isinstance(envelope, SecretInUseApiError):
            print(envelope.code, envelope.data.workload_ids)
        else:
            raise
```

Unexpected envelopes are retained as `UndefinedApiError`. An API failure is
separate from a Job's terminal state: inspect status/events for workload
failures, and handle `httpx.HTTPError` for transport failures where appropriate.

<span id="jobgroup"></span>
<span id="buckets"></span>
<span id="upload-and-download"></span>

## Migrating existing code

`from anycloud import Client` is the public Job client.
`anycloud_workflows.Client` remains the same class. Import `JobFailedError` and
`WorkloadWaitTimeout` from
`anycloud_workflows`; API families, models, and HTTP exceptions live in
`anycloud`.

When updating older SDK code:

- Pass compute selection as `submit(credential_name=..., cloud_config=...)`.
  Constructor-level `credentials` and workload configuration defaults are
  unavailable. Token discovery does not automatically choose a compute account.
- Use `job.wait(timeout_seconds=...)` and handle `JobFailedError` or
  `WorkloadWaitTimeout`. Read state from `job.status().workload.state`;
  the old `DeploymentFailedError`, `ConflictError`, and `NotFoundError` types are
  replaced by workflow errors or generated API exceptions.
- Replace old `anycloud.types` and `Bucket` configuration objects with supported
  `cloud_config` mappings or generated models. Attaching a bucket to a Job is
  supported independently of SDK byte transfers.

The SDK has no Service handles, `JobGroup`, `submit_many()`, or `get_or_submit()`.
Use generated operations for Services and ordinary Python for orchestration.
SDK log streaming, exec, and bucket-byte upload/download helpers are also
unavailable; use the
[CLI](/reference/cli-reference) for those tasks. Generated bucket metadata
operations and Job bucket attachments remain available.

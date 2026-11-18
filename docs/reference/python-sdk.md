---
sidebar_position: 2
sidebar_label: Python SDK
description: Submit and manage Jobs, inspect Kubernetes Deployment queues, and write handlers with the Python SDK.
---

# Python SDK

Use Python to submit containerized Jobs, follow their progress, and run work
inside persistent Kubernetes Deployments. `Client` handles API configuration and authentication
for Job and Deployment operations. [`AsyncClient`](#async-operations) provides the
same Job submission, completion, and Deployment management workflows with `await`. Other
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
through `cloud_config`. A Job targeting an existing Deployment uses that Deployment's
node pool capacity and needs no per-Job compute credential.

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

## Jobs on Kubernetes Deployments {#jobs-on-deployments}

A targeted Job runs inside an existing Deployment's application. Pass its name or
ID as a string, with an optional Job ID:

```python
import httpx

from anycloud import Client
from anycloud.exceptions import ApiException

with Client() as client:
    deployment_name = "model-deployments"
    job = client.submit(deployment=deployment_name, workload_id="request-123")
    status = job.status()
    state = status.workload.state if status.workload is not None else None
    terminal_states = {"completed", "errored", "failed", "invalid", "terminated"}

    if state in terminal_states:
        message = f"Job {state}"
    elif state == "running":
        message = "Picked up"
    elif state is None:
        message = "Job status unknown"
    elif state != "queued":
        message = f"Job {state}"
    else:
        ahead = status.jobs_ahead
        if ahead is None:
            position = "Queue position unknown"
        elif ahead == 0:
            position = "First in the queue"
        else:
            position = f"{ahead} Jobs ahead"

        try:
            deployment = client.get_deployment(deployment_name)
        except (httpx.HTTPError, ApiException):
            availability = "Deployment observation unavailable"
        else:
            live = deployment.status
            if deployment.deletion_requested_at is not None or deployment.deleted_at is not None:
                availability = "Deployment is draining or deleted"
            elif live is None or live.observation == "unavailable":
                availability = "Deployment readiness unknown"
            elif not live.ready:
                availability = live.reason
            elif (free := deployment.max_concurrent_jobs_per_replica - deployment.jobs.unreleased) <= 0:
                availability = "All Deployment concurrency is currently held"
            elif ahead is not None and free > ahead:
                availability = "Capacity currently available for this queue position"
            else:
                availability = "Waiting for pickup"
        message = f"{position}; {availability}"

    print(message)
```

Supply exactly one of `image` or `deployment`. Targeted submissions accept only
`deployment` and optional `workload_id`. Image, compute, credential, and container
options are rejected even if you pass an empty mapping or list. Configure those
settings on the Deployment instead. Pass `deployment.id` when you have a `DeploymentSummary`,
rather than passing the summary itself.

`job.status().jobs_ahead` counts earlier queued Jobs on the same Deployment:

- `0` means first in the queue; positive values count Jobs ahead.
- `None` applies outside the queued Deployment-targeted case or when the response
  omits the field.
- The count covers the shared Deployment queue, including other callers' Jobs.
  Ordering uses original submission time, then Job ID. Retries and resubmissions
  retain that time, so older Jobs returning to the queue can move ahead.

Job state, events, and queue count come from one API database snapshot. Deployment
lookup is a separate observation: `deployment.jobs.queued` counts the whole queue,
and `deployment.jobs.unreleased` counts executions still holding concurrency,
including cleanup. A Deployment accepts work when `status.ready` is true:
it is `"running"` with its current revision ready. Terminated Deployments cannot accept work.

Only `"running"` confirms pickup. Capacity and queue position are advisory;
zero Jobs ahead does not guarantee immediate start or an ETA. Missing or failed
observations mean unknown rather than a confirmed capacity blocker. Refresh
status at a cadence appropriate to your application, checking terminal states
before displaying queue or Deployment messages.

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

VM-backed Jobs reuse the container configuration accepted at submission.
Deployment Jobs retain their Deployment target and use its current configuration when
selected for execution; resubmission can therefore run newer configuration.
Per-Job logs and exec are unavailable for Deployment Jobs.

<span id="workflow-helpers"></span>
<span id="code-running-inside-the-deployment"></span>

## Handle Jobs inside a Deployment

Inside a Deployment Pod, `current_deployment()` discovers the injected API URL, Deployment
ID, and rotating workload token. Its `next_job(timeout=20)` waits up to 20 seconds
to discover a candidate and returns a `CurrentJob` handle or `None`. An attempted
claim may resolve later within the separate request budget. Omitting `timeout`
uses the 20-second wait; pass `timeout=0` for one immediate lookup. A handler
needs only that handle:

```python
import time

import httpx

from anycloud.exceptions import ServiceException
from anycloud_workflows import CurrentJob, current_deployment


def handle(job: CurrentJob) -> None:
    # Replace these steps with your application work, using job.id to load inputs.
    for step in range(3):
        if job.cancellation_requested():
            # Stop local work and release its resources before acknowledging cleanup.
            job.cleanup()
            return
        print(f"Job {job.id}: step {step}", flush=True)
        time.sleep(1)
    job.complete()


with current_deployment() as deployment:
    while True:
        try:
            job = deployment.next_job()
        except (httpx.HTTPError, ServiceException, TimeoutError):
            time.sleep(1)
            continue
        if job is None:
            continue
        handle(job)
```

The example handles one Job at a time. Each default receive waits up to 20
seconds and wakes on committed availability or Kubernetes Pod changes, checking
current identity and readiness again. No extra sleep is needed after an empty
bounded receive; applications should pace repeated immediate `timeout=0` calls.
Applications own capacity, concurrency, and cooperative cancellation; a handle
does not interrupt work or clean up application resources. Keep the context
open until every handler has finished. `current_deployment(timeout_seconds=30)`
sets a separate elapsed request budget, capped at 30 seconds. Local caller
serialization, discovery, claim, response decoding, and cancellation share that
budget. Handler outcome and cleanup calls remain usable while discovery waits.

`None` means no unresolved claim from this call can assign work later. Discovery
does not reserve work. If a claim response is lost, keep the same Deployment context
and retry `next_job()`; it retains the exact Job, submission revision, previous
execution, and new execution UUID. A later call may use a different timeout.
Temporary capacity, readiness, authentication, and network errors preserve this
pending claim. Context and handle methods retry HTTP 502, 503, and 504 and lost
connections for about two minutes, so an API upgrade does not raise;
`next_job()` also retries a discovery or claim request that gets no answer
within the context's `timeout_seconds`, and a retried `next_job()` resumes the
pending claim. Otherwise a request timeout
raises an exception and never means empty.
The SDK checks both returned IDs before accepting a claim.

The hosted API's ServiceAccount grants the Pod `watch` this needs, and
Deployment preflight checks it.
The native exec probe supplies application readiness; without a configured
probe, application readiness remains unknown. Individual status reads current
observations and does not execute the probe.

| Member                                  | Purpose                                                                      | Return value |
| --------------------------------------- | ---------------------------------------------------------------------------- | ------------ |
| `job.id`                                | Identify the Job and load application inputs.                                | `str`        |
| `job.complete()`                        | Publish successful completion.                                               | `None`       |
| `job.error(message)`                    | Publish an application failure.                                              | `None`       |
| `job.invalid(message)`                  | Reject invalid input without retrying.                                       | `None`       |
| `job.retry(message)`                    | Report a retryable failure for the API to reschedule.                        | `None`       |
| `job.cancellation_requested(timeout=0)` | Observe whether local work should stop, optionally waiting up to 20 seconds. | `bool`       |
| `job.cleanup()`                         | Confirm that terminated local work has stopped and released its resources.   | `None`       |

Handle methods refresh the projected token before each operation and preserve
generated API exceptions. `job.selected` is the original generated `SelectedJob`
model, including its Job and execution IDs. Context methods such as
`deployment.outcome(job, "completed")` accept either handles or generated selections.
Ordinary handlers do not need to manipulate execution IDs.

A separate cancellation watcher can call
`job.cancellation_requested(timeout=20)` while the task runs. The API holds the
request until termination, the execution ends, or the wait expires. The default
`timeout=0` checks immediately for callers checking between work steps. A waiting
call blocks its calling thread. While the API restarts, any call, including
`timeout=0`, can block for about two more minutes as it retries. Concurrent waits use separate connections so
they cannot starve completion or cleanup calls.

`False` means no termination was observed: the wait may have expired, or the Job
may have completed or retried. Stop watching when the local task finishes.
Authentication and stale-execution failures remain exceptions, as do transport
failures that outlast the retry window. After one, repeat observation with the same handle
within the application's retry deadline; the API recovers the result from
persisted state. Do not resubmit solely to resume a wait.

The generated cancellation operation accepts `wait_ms` from `0` through `20000`
and retains its `cancelled` boolean response. Applications using generated
clients directly should give long waits a separate client from outcome and
cleanup calls and allow enough request time for the selected wait.

The lower-level `DeploymentJobPoller` accepts an application-owned generated
`ApiClient` and returns `SelectedJob` from `next_job()`. Keep one poller alive
across retries: it retains the complete claim identity after an uncertain
acquisition failure so the next request can safely replay it. Install the
matching API/SDK release in Deployment images.

<span id="deployments"></span>

## Manage Kubernetes Deployments {#manage-deployments}

Create a Deployment on a Ready NVIDIA GPU node pool with an application like the
handler above:

```python
from anycloud import Client

with Client() as client:
    deployment = client.create_deployment(
        "model-deployments",
        "ghcr.io/acme/model-deployment:latest",
        node_pool="training",
        docker_options={"gpus": "all"},
        command=["python", "deployment.py"],
        max_concurrent_jobs_per_replica=4,
    )
    print(deployment.id, deployment.generation)
```

Creation returns a `DeploymentSummary` before the application is ready. Use
`client.get_deployment(deployment.id)` to fetch current observations. The node
pool's VM type determines the accelerator model and per-VM supply. GPU options use the same
`docker_options` representation as VM Jobs (`dockerOptions` in the API):
`{"gpus": "all"}` or a positive integer string such as `{"gpus": "1"}`.
Omitting GPU options on verified NVIDIA capacity uses all GPUs on one capacity
VM; omitting them on CPU capacity requests none. Zero is invalid, and explicit
GPU access requires sufficient verified NVIDIA capacity. Image names and CUDA
metadata do not infer a GPU request.

Both `Client` and `AsyncClient` accept an optional native exec probe on
`create_deployment()` and `update_deployment()`:

```python
with Client() as client:
    client.update_deployment(
        "model-deployments",
        readiness_probe={"exec": {"command": ["/app/check-ready"]}, "period_seconds": 2},
    )
    deployment = client.get_deployment("model-deployments")
    print(deployment.status.state, deployment.status.application_ready)
    print(deployment.status.blocking_jobs.total)
    for blocker in deployment.status.blocking_jobs.jobs:
        print(blocker.id, blocker.generation, blocker.state)
```

The image provides the probe executable. Omitted timing fields use Kubernetes
defaults. An update preserves an omitted `readiness_probe`; an object replaces
it and `None` removes it. Probe changes use the existing generation drain.
Unconfigured application readiness is `None`, even when the container is ready.
Readiness loss prevents new claims while active Jobs retain their executions.

`list_deployments()` reads stored inventory, with `status=None`, and does not
fetch each Deployment's runtime status. `get_deployment()` observes Kubernetes
within a one-second runtime budget and exposes `status`, including at most ten
drain blockers and their total count. Unavailable Kubernetes returns stored
configuration with unknown runtime facts; transport or authorization errors
still raise. Status reads observe probe results and do not run the probe.

GPU Deployments select the NVIDIA runtime automatically. An explicit
`{"runtime": "nvidia"}` is supported on NVIDIA capacity. CPU
`{"runtime": "runc"}` selects the default managed runtime; combining `runc`
with GPU access is rejected by the current managed adapter because its device
injection requires the NVIDIA runtime. See the
[Deployment GPU rules](/reference/cli/deployments#create).
Per-Job buckets are not supported.

`secrets` names saved [Secrets](/platform/secrets-environment) whose keys the
container receives as environment variables. On `update_deployment()` a
sequence replaces the references, `None` removes them, and omission preserves
them. To move a value out of `env`, drop its key and add the Secret in one
update, since an `env` value wins over a same-named Secret key:

```python
with Client() as client:
    client.update_deployment(
        "model-deployments",
        env={"MODEL_REVISION": "v2"},
        secrets=["model-db"],
    )
```

See [Deployment Secrets](/reference/cli/deployments#named-secrets) for
resolution, rotation and deletion.

Update an existing Deployment by name or ID:

```python
from anycloud import Client

with Client() as client:
    deployment = client.update_deployment(
        "model-deployments",
        image="ghcr.io/acme/model-deployment:v2",
        env={"MODEL_REVISION": "v2"},
    )
    print(deployment.generation)
```

Updates preserve omitted fields. Use `docker_options` to change individual
container options while keeping the other settings and admitted GPU allocation:

```python
with Client() as client:
    client.update_deployment("model-deployments", docker_options={"cpus": "6"})
    client.update_deployment(
        "model-deployments",
        docker_options={"memory": None, "binds": [], "privileged": False},
    )
```

Each supplied value replaces that option; `None` removes it. Arrays replace the
whole array, so `binds: []` clears volumes. Only explicitly setting or clearing
`gpus`, or clearing all Docker options, recalculates GPU allocation.
`gpus: None` reapplies the capacity default, including all GPUs on NVIDIA
capacity. Other changes retain the admitted count and revalidate capacity and
runtime compatibility.

`docker_options` accepts a dictionary, `DockerOptions`, or the generated
`DeploymentDockerOptionsUpdate` model, using Python field names or API aliases.
Only explicitly supplied model fields are updated, including explicit `None`.
The generated `UpdateDeploymentBody` exposes these values as `dockerOptions` on
the wire.

`None` clears `command`, `env`, or the entire `docker_options` map; clearing all
Docker options also reapplies GPU capacity defaults. Empty `command` lists and
`env` maps remain explicit values. `image` and
`max_concurrent_jobs_per_replica` cannot be `None`. An empty update or empty
`docker_options` object raises `ValueError`. The Deployment's name and node pool
cannot change.
The server commits all changes with its existing generation check; a conflicting
update returns 409 without partial changes or automatic replay. Retry explicitly
to apply the supplied fields to the latest configuration.

Options objects now preserve omitted settings. Callers that previously relied
on full replacement must explicitly set unwanted options to `None` in the same
request. Replace clear-all `docker_options={}` calls with `docker_options=None`.
Upgrade the API and its CLI/Python clients to matching versions.

`client.delete_deployment("model-deployments")` starts draining/deletion and returns a
summary without waiting for active Jobs or Pods to finish.

List all Deployments or filter by a node pool name or ID:

```python
from anycloud import Client

with Client(request_timeout_seconds=10) as client:
    all_deployments = client.list_deployments()
    for deployment in client.list_deployments(node_pool="training"):
        print(deployment.name, deployment.jobs.queued, deployment.jobs.unreleased)
```

`list_deployments()` returns a list of generated `DeploymentSummary` models, or an empty
list when no Deployments match. Omitting `node_pool` or passing `None` lists
Deployments across node pools. The optional request timeout is configured once on `Client`
and defaults to 30 seconds.

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
Deployment management, termination, and resubmission. `job.wait()` has its own
polling deadline and interval.

### Submit options

`client.submit(image=None, *, deployment=None, ...)` requires exactly one target.
For image submissions:

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
`secrets` as sequences rather than a single string. For a Deployment target, only
`deployment`, `workload_id`, `timeout`, and `wait` are accepted. Deployment submission
allocates a valid Job ID locally when omitted, so a lost admission response can
still retain a reference.

`timeout` is an optional nonnegative number of seconds from admission to first
claim. `wait=True` blocks until that claim is durable, independently of handler
completion. `wait=False` returns after admission; `job.wait_for_claim()` can
observe the same persisted deadline later. Omitting `timeout` sets no claim
deadline, including with `wait=True`. A zero timeout expires an unclaimed
submission immediately. `job.resubmit(timeout=..., wait=True)` keeps the ID and records a new
submission; omitting its timeout clears the old deadline. Automatic retries
keep their submission revision and first-claim evidence.

`JobSubmissionExpired` confirms that this submission never claimed work and
cannot start later. `JobSubmissionTerminated` identifies other termination
before claim, and `JobSubmissionChanged` identifies an explicit resubmission
that superseded the handle's receipt. Each retains `.job`, `.workload_id`, and
the handle's submission `.revision`, so a failed blocking submission still
provides its recovery handle. These exceptions are exported from
`anycloud_workflows`. Deployment `Client.submit()` may raise `JobSubmissionUncertain`
with `.job` and the original `.cause` when admission is uncertain or its internal
claim wait fails. Definitive admission rejections, such as HTTP 401, retain their
generated exception types. Inspect or retry with the retained handle; uncertainty
does not confirm expiry. Request errors from existing-handle `resubmit()` and
`wait_for_claim()` retain their original types. Every Job resubmission uses the
client's configured request timeout as its elapsed request budget. Management API and SDK releases must
match exactly.

See [Configuration](/reference/configuration) for field mappings, defaults,
hardware constraints, storage credentials, and environment precedence.

### Handle results

| Member                 | Result                                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------- |
| `job.id`               | Job ID string.                                                                                            |
| `job.submission`       | Generated `WorkloadAdmissionResponse`, or `None` after reattachment.                                      |
| `job.status()`         | Fresh generated `WorkloadStatusResponse`, also saved in `last_status`.                                    |
| `job.last_status`      | Last cached status, or `None` before observation/after successful resubmission.                           |
| `job.wait(...)`        | The same handle on success; raises on unsuccessful terminal state or timeout.                             |
| `job.wait_for_claim()` | The same handle after this Deployment submission's first durable claim.                                   |
| `job.terminate()`      | Generated `MessageResponse`; cleanup continues asynchronously.                                            |
| `job.resubmit()`       | Generated `WorkloadResubmitResponse`, including the Deployment submission receipt; Job ID stays the same. |

Deployment creation accepts `name`, `image`, required keyword `node_pool`, and optional
`command`, `env`, `docker_options`, and `max_concurrent_jobs_per_replica`
(default `1`). Updates accept those mutable settings except `name` and `node_pool`.
`get_deployment(identifier)`, `update_deployment(deployment, ...)`, and
`delete_deployment(deployment)` accept name or ID strings.
`list_deployments(*, node_pool=None)` accepts an optional node pool name or ID and
returns a list of `DeploymentSummary` models.

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

`list_workloads_sync()` returns generated workload models. Deployment Jobs
have `deployment_id` set and `image`, `image_digest`, `command`, and
`docker_options` set to `None`; VM-backed workloads require an image.
Inspect the Deployment's configuration with
`client.get_deployment(workload.deployment_id)` while the client is open.

`get_workload_status_sync().workload` exposes identity, lifecycle, and
non-sensitive container metadata, including `deployment_id`. Deployment Jobs have the
same null container fields as list results. Status responses omit environment,
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
| `DeploymentsApi`, `DeploymentWorkloadApi`          | Deployment management and in-Pod Job lifecycle operations.                  |

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

`AsyncClient` supports the same image and Deployment submissions, Job lifecycle,
and Deployment management methods as `Client`. Arguments, defaults, validation,
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
submissions. First-claim `timeout`, `wait=True`, and `wait_for_claim()` apply
only to Deployment Jobs.

An async request handler can distinguish confirmed expiry from an unknown
submission outcome without assembling admission and observation API calls:

```python
import asyncio

from anycloud import AsyncClient
from anycloud_workflows import JobSubmissionExpired, JobSubmissionUncertain


async def submit_request(client: AsyncClient, deployment: str) -> dict[str, str]:
    try:
        job = await client.submit(deployment=deployment, timeout=5, wait=True)
    except JobSubmissionExpired as error:
        # This submission cannot start later; another provider may be scheduled.
        return {"outcome": "expired", "job_id": error.job.id}
    except JobSubmissionUncertain as error:
        # Retain the ID and reconcile before deciding whether to fall back.
        return {"outcome": "unknown", "job_id": error.job.id}
    return {"outcome": "claimed", "job_id": job.id}


async def main() -> None:
    async with AsyncClient() as client:
        print(await submit_request(client, "model-deployments"))


asyncio.run(main())
```

`timeout=5` sets the server's admission-to-first-claim deadline. `wait=True`
returns an `AsyncJob` after that claim, independently of handler completion.
The separate `request_timeout_seconds=30` constructor setting configures HTTP
timeouts. Deployment admission, claim observation, and resubmission enforce an
elapsed request budget; ordinary operations use the generated transport's
timeouts. Completion waiting passes its remaining polling budget to each status
request. A request timeout confirms neither expiry nor rejection. The
[submission outcomes](#submit-options) have the same meaning for both clients,
with an `AsyncJob` in the async exception's `.job` field. Definitive admission
rejections retain their generated exception types.

After `JobSubmissionUncertain`, await `error.job.wait_for_claim()` while its
client is open, or use `await client.get(saved_job_id)` to reattach later.
These observations do not resubmit work. Preserve the ID when an observation
fails again; an unknown outcome does not permit fallback on the strength of
the expiry guarantee. Explicit resubmission starts a new submission revision.

Task cancellation propagates as `asyncio.CancelledError`. If you impose a local
timeout or need recovery after a disconnected request, supply and save
`workload_id` before awaiting submission, then reattach by that ID. Local
cancellation, including an outer `asyncio.wait_for()` timeout, does not terminate
the remote Job or confirm expiry. Request errors and cancellation on an
existing `AsyncJob` propagate unchanged because the caller already holds its
recovery handle.

| Awaitable operation                                               | Result                                                                           |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `client.submit(image, **options)`                                 | An `AsyncJob` after image admission; accepts the synchronous execution settings. |
| `client.submit(deployment=..., timeout=None, wait=False)`         | An `AsyncJob`; optionally awaits the first durable claim.                        |
| `client.get(job_id)`                                              | An `AsyncJob` attached to the current submission, with fetched status.           |
| `job.status()`                                                    | Generated `WorkloadStatusResponse`, also cached in `job.last_status`.            |
| `job.wait(timeout_seconds=None, poll_interval_seconds=2)`         | The same handle after successful completion.                                     |
| `job.wait_for_claim()`                                            | The same handle after this submission's first durable claim.                     |
| `job.terminate()`                                                 | Generated `MessageResponse`; runtime cleanup continues asynchronously.           |
| `job.resubmit(timeout=None, wait=False)`                          | Generated `WorkloadResubmitResponse`; records a new submission receipt.          |
| `client.create_deployment(name, image, node_pool=..., **options)` | Generated `DeploymentSummary` after creation.                                    |
| `client.list_deployments(node_pool=None)`                         | A list of generated `DeploymentSummary` models.                                  |
| `client.get_deployment(identifier)`                               | Generated `DeploymentSummary` for a name or ID.                                  |
| `client.update_deployment(deployment, **changes)`                 | Generated `DeploymentSummary`; omitted settings are preserved.                   |
| `client.delete_deployment(deployment)`                            | Generated `DeploymentSummary`; draining and cleanup continue asynchronously.     |
| `client.aclose()`                                                 | Closes the owned generated client's connections.                                 |

`job.id`, `job.submission`, and `job.last_status` are ordinary properties.
Deployment updates use the same [omission and clearing rules](#manage-deployments)
as the synchronous methods. For example, `await client.update_deployment("model-deployments",
env=None)` clears the environment; omitting `env` preserves it.

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
types, except for uncertain Deployment submission wrapped with its recovery handle
as described above. Their HTTP status is in `ApiException.status`. Local
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

`from anycloud import Client` is the public Job and Deployment client.
`anycloud_workflows.Client` remains the same class. Import `current_deployment`,
`CurrentJob`, `JobFailedError`, and `WorkloadWaitTimeout` from
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
- Target a Deployment by its name or ID with `submit(deployment="name-or-id")`.
  Deployment summaries are generated data; use `Client` methods for management.
- Replace old `anycloud.types` and `Bucket` configuration objects with supported
  `cloud_config` mappings or generated models. Attaching a bucket to a Job is
  supported independently of SDK byte transfers.

The SDK has no Service handles, `JobGroup`, `submit_many()`, or `get_or_submit()`.
Use generated operations for Services and ordinary Python for orchestration.
SDK log streaming, exec, and bucket-byte upload/download helpers are also
unavailable; use the
[CLI](/reference/cli-reference) for those tasks. Generated bucket metadata
operations and Job bucket attachments remain available.

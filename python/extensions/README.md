# Python SDK extensions

`python/generated/anycloud` is the generated API client. Never edit it. This
directory holds small, handwritten top-level packages that compose the
generated client without becoming another client implementation.

## Choose the owner first

- Add a new API operation or language-neutral behavior to
  `src/shared/api-contract/`; generation then supplies it to Python.
- Add a Python-only composition helper here when it coordinates existing
  generated operations but does not invent wire behavior.
- Add NDJSON, byte-stream, exec, or live-log support to a narrow future
  `anycloud_native` package only when a concrete user needs it.

## Extension rules

- Place each extension in its own top-level package, such as
  `anycloud_workflows`; never add its implementation below `anycloud` or
  `generated/`. The qualified package-initializer template exposes the existing
  `Client` and `AsyncClient` classes through `from anycloud import Client,
AsyncClient` without moving them.
- Accept generated `ApiClient` instances and use generated API-family classes,
  request models, response models, and exceptions. Do not repeat paths, wire
  dictionaries, enums, or error envelopes.
- Return generated models unchanged where possible. An extension may define a
  local control-flow error, such as a timeout, but must not recreate API errors.
- Keep client construction and lifecycle with the application unless a helper's
  explicit contract says otherwise. An extension must not become a mandatory
  facade around the generated SDK.
- Add the package to both Hatch wheel and source-distribution inclusion in
  `python/pyproject.toml`, add focused tests, and extend the archive check.
- Generated API/model modules must never import an extension. The only
  exception is the qualified root initializer's lazy `Client` and `AsyncClient`
  exports and their typing aliases. The extension qualification enforces this boundary and checks
  both import orders; raw imports must not initialize the extension.

## Example: polling

`anycloud_workflows.wait_for_terminal_workload` is the reference pattern. It
constructs `WorkloadsApi` from a supplied generated `ApiClient`, repeatedly
calls its generated status operation, and returns the generated
`WorkloadStatusResponse`. Its only local behavior is polling and timeout
handling; it owns no API route, request schema, response schema, or retry
policy.

`async_wait_for_terminal_workload` has the same arguments and returns the same
generated status type. It awaits generated status calls and `asyncio.sleep` on
the caller's event loop. Both helpers pass the remaining polling budget to each
request and preserve API/transport errors. Cancellation only stops observation;
the caller still owns the generated client and remote workload.

## Example: Job submission and lifecycle

`anycloud.Client`, also available as `anycloud_workflows.Client`, explicitly
owns a generated `ApiClient`, discovers the same API target and token files as
the CLI, supplies the generated package version, and closes its connection pool.
Its `submit()` method constructs generated admission models and returns a
lightweight `Job` control-flow handle. Submissions to Kubernetes Deployments preallocate a valid
Job ID, accept a first-claim `timeout`, and support `wait=True` for confirmation
of the first durable claim. `Job.wait_for_claim()` observes that submission
revision; `Job.wait()` retains ordinary completion waiting. Confirmed expiry,
other pre-claim termination, and explicit resubmission have distinct errors.
Submission outcome exceptions retain `.job`, `.workload_id`, and `.revision`.
`JobSubmissionUncertain` retains an otherwise unreturned Job and the original
request error when Deployment admission is uncertain or its internal claim wait
fails. Definitive admission rejections and existing-handle request errors
propagate unchanged.
It accepts either an image with execution settings or a Deployment name/ID with an
optional Job ID. Deployment-targeted submissions reject execution overrides because
those settings belong to the Deployment. `create_deployment()`, `get_deployment()`,
`update_deployment()`, and `delete_deployment()` compose the generated Deployment operations
and return their `DeploymentSummary` unchanged. `list_deployments(*, node_pool=None)`
returns the generated response's list of summaries, optionally filtered by
node pool name or ID. These methods use the Client's configured request timeout.
Deployment updates preserve omitted settings; explicit `None` clears command,
environment, Docker options, or the native exec `readiness_probe`. A probe object
replaces the whole probe and participates in the generation drain. Individual
`get_deployment()` exposes bounded live `status`, including nullable application
readiness and drain blockers. Lists keep `status=None` and make no individual
status requests. Deletion requests drain/deletion without
waiting for Pods or Jobs to finish.

`Job` preserves generated responses through `submission`, `status()`,
`last_status`, `terminate()`, and `resubmit()`. `Client.get(id)` eagerly reads
status and reattaches a Job with no admission response; its `submission` is
`None`. A successful resubmission keeps the Job ID and clears the cached status,
returning the generated `WorkloadResubmitResponse`. Its authoritative revision
and deadline are also recorded on the handle; no later status lookup infers
the acknowledged revision. Every resubmission shares one elapsed request path
using the client's configured request timeout. `resubmit(timeout=..., wait=True)` replaces the
first-claim deadline and waits for that new submission to be claimed. Omitting
`timeout` clears the prior deadline. The API enforces lifecycle and
cleanup requirements. Its `wait()` method delegates polling to
`wait_for_terminal_workload`; only successful-versus-unsuccessful terminal
control flow belongs to the extension. The API calculates `status().jobs_ahead`;
the extension neither derives queue position nor defines a parallel status
model. See the [queue-status example](../../docs/reference/python-sdk.md#jobs-on-deployments)
for combining Job status with Deployment readiness and capacity. This bounded
Deployment management and Job lifecycle surface is the public synchronous Client
contract. Services, credentials, secrets, bucket metadata, and other server
operations remain generated API-family calls through
`Client.api_client`, with `Client.sdk_version` supplying their version argument.

`AsyncClient`, also exported from `anycloud`, owns the same configuration and
generated client on the application's event loop. It supports every public
`Client` operation, including image submission and Deployment management.
`AsyncJob` supports every `Job` operation, including completion waiting. The
paired methods have matching arguments, defaults, validation, generated response
types, and error meanings, with async handles for async operations. Use an async
context manager or `aclose()` for cleanup.

Submission and Deployment request construction are shared pure helpers. Submission
IDs, receipts, claim outcomes, and admission-rejection classification are shared
with the synchronous helper. Deployment admission/observation and all resubmissions
have elapsed request budgets; ordinary operations preserve generated transport
timeouts. Image admission keeps its existing ID and error behavior, without a
Deployment submission uncertainty wrapper. Requests await generated async methods
directly; they never use the synchronous bridge or create another event loop.
Other operations remain independently usable through the generated API families.

The acceptance criterion is a complete async request handler that submits and
awaits claim or confirmed expiry, keeping the recovery handle when the outcome
is uncertain. The runnable `python/examples/async_deployment_submission.py` is
exercised against the production HTTP API from the installed SDK, including
concurrent handlers and responses lost after server acceptance. Cancellation
remains ordinary `asyncio.CancelledError`; callers that need recovery after a
local timeout save a custom Job ID before awaiting submission. Qualification
also checks request deadlines, cancellation, and connection cleanup on Python
3.10 and newer.

The parity suite compares public signatures and runs paired image submission,
completion, unsuccessful terminal state, timeout, reattachment, and Deployment
management scenarios. The runnable `python/examples/job_completion.py` exercises
both clients through the production HTTP middleware from installed packages.
New `Client`/`Job` convenience operations require corresponding async workflows,
paired acceptance tests, and examples. Deployment-side `current_deployment()` and
`DeploymentJobPoller` remain synchronous helpers with their own acquisition contract.

## Example: idempotent Deployment Job acquisition

`anycloud_workflows.current_deployment()` is the reference for a helper whose
explicit contract owns client construction. It discovers the identity injected
into a Deployment Pod, refreshes the projected token before every operation, and
closes its generated clients as a context manager. Its `next_job()` returns a
lightweight `CurrentJob` control-flow handle, or `None` after read-only
discovery confirms no claim is outstanding. The default `timeout=20` waits up
to 20 seconds for a candidate; `timeout=0` performs one immediate lookup and at
most one new claim. The handle binds that context to the original generated
`SelectedJob`, available unchanged as `job.selected`.

`CurrentJob.id`, `complete()`, `error(message)`, `invalid(message)`,
`retry(message)`, `cancellation_requested(timeout=0)`, and `cleanup()` let an application
pass one handle to its Job handler. Lifecycle methods delegate to the context's
existing generated operations: cancellation returns a `bool`, while outcome and
cleanup methods return `None`. They do not translate generated exceptions or
add wire schemas, retry policy, automatic cleanup, or cancellation behavior.
Keep the context open while its handles are in use. The context's lifecycle
methods remain available to callers with generated `SelectedJob` models or
`CurrentJob` handles, including while another thread waits in discovery.
Call acquisition only when the application has capacity.

Cancellation supports waits up to 20 seconds through the generated operation
and the existing elapsed request-deadline helper. Positive waits use a separate
generated `ApiClient` and HTTPX pool, leaving lifecycle connections available.
Both clients share one configuration for workload token rotation and close with
the context. A wait returns `False` on expiry, completion, or retry; identity
and transport failures propagate. The application owns retrying observation
after disconnect and ending its watcher when local work finishes.

The narrower `DeploymentJobPoller` accepts a caller-owned generated client and
exposes `next_job(timeout=20)` without an idempotency-key argument, returning
generated `SelectedJob` models. Discovery creates no execution UUID. Before
claiming, the poller retains the UUID, Job ID, submission revision, and prior
execution UUID. Uncertain failures and temporary conflicts keep that exact
tuple across later calls, even when their waiting timeout differs. Only a
matching success or a conclusive stale/used response retires it. One elapsed
request deadline covers serialization, token refresh, both generated HTTP
operations, and decoding; a request timeout remains an exception. Discovery and
claim require a matching API release.

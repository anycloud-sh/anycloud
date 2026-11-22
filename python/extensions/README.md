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
Its `submit()` method constructs generated admission models from an image with
execution settings and returns a lightweight `Job` control-flow handle.
Admission request errors propagate unchanged.

`Job` preserves generated responses through `submission`, `status()`,
`last_status`, `terminate()`, and `resubmit()`. `Client.get(id)` eagerly reads
status and reattaches a Job with no admission response; its `submission` is
`None`. A successful resubmission keeps the Job ID and clears the cached status,
returning the generated `WorkloadResubmitResponse`. Every resubmission shares
one elapsed request path using the client's configured request timeout. The API
enforces lifecycle and cleanup requirements. Its `wait()` method delegates
polling to `wait_for_terminal_workload`; only successful-versus-unsuccessful
terminal control flow belongs to the extension. This bounded Job lifecycle
surface is the public synchronous Client contract. Services, credentials,
secrets, bucket metadata, and other server operations remain generated
API-family calls through `Client.api_client`, with `Client.sdk_version`
supplying their version argument.

`AsyncClient`, also exported from `anycloud`, owns the same configuration and
generated client on the application's event loop. It supports every public
`Client` operation. `AsyncJob` supports every `Job` operation, including
completion waiting. The paired methods have matching arguments, defaults,
validation, generated response types, and error meanings, with async handles
for async operations. Use an async context manager or `aclose()` for cleanup.

Submission request construction is a shared pure helper. Resubmissions have
elapsed request budgets; ordinary operations preserve generated transport
timeouts. Requests await generated async methods directly; they never use the
synchronous bridge or create another event loop. Other operations remain
independently usable through the generated API families. Cancellation remains
ordinary `asyncio.CancelledError`; callers that need recovery after a local
timeout save a custom Job ID before awaiting submission. Qualification also
checks request deadlines, cancellation, and connection cleanup on Python 3.10
and newer.

The parity suite compares public signatures and runs paired image submission,
completion, unsuccessful terminal state, timeout, and reattachment scenarios.
The runnable `python/examples/job_completion.py` exercises both clients through
the production HTTP middleware from installed packages. New `Client`/`Job`
convenience operations require corresponding async workflows, paired
acceptance tests, and examples.

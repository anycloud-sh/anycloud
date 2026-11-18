# RFC 0035: Generate the Python SDK from the API contract

> Status: Proposed
> Date: 2026-09-03
> Author: Codex draft

## Summary

Replace the handwritten Python SDK with the direct output of OpenAPI Generator
7.24.0. Generate an ephemeral OpenAPI 3.1 document from the canonical Zod/oRPC
contract, verify it, generate an isolated public `anycloud` package using
Pydantic v2 and httpx, and publish that package without a compatibility façade.
The current OpenAPI export must first be corrected; the research proof is
intentionally not release-ready.

## Context / problem

The JSON API is authored once under `src/shared/api-contract/` and consumed
directly by the TypeScript client through inferred oRPC/Zod types. Python is a
separate handwritten implementation:

- `python/anycloud/` contains about 3,300 lines of paths, dictionaries,
  Pydantic models, error translation, handles, workflow helpers, and custom
  transports;
- paths and wire fields are repeated in `client.py`, `storage.py`, and
  `current_deployment.py`;
- `types.py` repeats input and response models and sometimes ignores fields
  the contract would reject;
- broad status classes replace most declared error codes and typed data; and
- a contract change requires coordinated TypeScript, server, Python,
  documentation, and test edits.

There are currently no SDK users. Preserving `Client`, `Job`, `Service`,
`Bucket`, `Submission`, current models, custom exceptions, method signatures,
or aliases would spend maintenance effort on compatibility nobody needs and
would retain two sources of truth.

RFC 0018 made Zod/oRPC the conventional JSON authority and kept NDJSON and
bytes as native transports. RFC 0019 normalized the paths and Bearer-only
authentication. This RFC applies those decisions to Python generation; it does
not move native streams into oRPC.

The spike generated the real 54-operation OpenAPI output with OpenAPI
Generator 7.24.0. Output was byte-identical across clean runs and included
Pydantic models, httpx, and sync methods. It also exposed blockers in the
current export: user authentication and the mandatory client-version header
are absent; 16 `204` responses advertise impossible JSON; no schemas are
reused; and the result cannot import because `AnyOf` is undefined. Structural
OpenAPI validation and the existing four repository tests all miss those
errors.

## Goals

- Define wire models, paths, parameters, success shapes, and declared errors
  only in the Zod/oRPC contract.
- Support Python 3.10 with generated Pydantic v2 models, httpx transport, and
  synchronous calls.
- Make generation local, checksum-pinned, deterministic, inspectable, and part
  of both CI and release without committing derived source.
- Publish generated code as the public SDK directly, with no initial façade.
- Keep future workflow helpers and native transports isolated from generated
  files and dependent on generated models/clients.
- Make a wrong or incomplete OpenAPI export fail before generation or publish.

## Non-goals

- Preserving any current Python public API or behavior for compatibility.
- Reproducing every CLI convenience in Python.
- Publishing, committing, or manually editing OpenAPI.
- Generating the TypeScript client.
- Moving native NDJSON or binary streams into the bounded JSON contract.
- Implementing the SDK or API-contract corrections in this RFC.

## Proposal

### Package layout and ownership

Use this layout when implementation begins:

```text
python/
  pyproject.toml                  # handwritten packaging and dependency bounds
  README.md                       # handwritten package entry documentation
  generator/
    openapi-generator.yaml        # reviewed generator configuration
    openapi-generator.sha256      # version/artifact checksum
  generated/
    anycloud/                     # ignored public-package build input
  extensions/
    anycloud_workflows/           # handwritten composition helpers
    anycloud_native/              # optional future NDJSON/byte transports
  tests/
    contract/                     # generated-client/real-server conformance
    extensions/                   # only when handwritten modules exist
```

Hatch packages `python/generated/anycloud` as the top-level import
`anycloud`. Generated code is therefore the public SDK, not an implementation
detail behind a wrapper. `python/pyproject.toml` is deliberately handwritten:
packaging metadata, dependency bounds, and repository release wiring are not
wire models and OpenAPI Generator's source-only mode should not own them.

`python/generated` is gitignored. A supported generation command always creates
and verifies clean temporary outputs before replacing
`python/generated/anycloud` as a complete build input. Humans never edit files
below that directory. CI generates and tests the package from the current
contract, and uploads one generated tree as a short-lived inspection artifact.
Release generation runs from the immutable release commit before Hatch builds
the wheel and source distribution, both of which include generated source so
installing published artifacts does not require the generator toolchain.

Keep the generated configuration, API client, family operation classes, request
models, response models, and exceptions independently usable. Optional
`Client` and `AsyncClient` workflows live in `anycloud_workflows`; the qualified
root initializer exposes them lazily for discovery. They must not become a
mandatory façade or a parallel implementation of the wire contract.

### Canonical contract and ephemeral OpenAPI

Zod schemas and oRPC procedures remain the sole authored wire contract. The
OpenAPI document is an internal language-neutral build artifact produced in a
temporary directory for validation and generation. It is gitignored, never
edited, never committed, never attached to a release, and never served as a
public contract.

The document describes the bounded JSON surface only. The omission of native
health/version, exec/log NDJSON, and bucket object bytes is intentional, but
every included operation must exactly describe what the real handler accepts
and returns.

`generateApiOpenApiDocument` must produce:

- one unique operation for every oRPC procedure, with stable operation ID and
  family tag;
- stable component names and references for every public request, response,
  reusable nested value, and declared error;
- exact path, query, header, and body placement, including requiredness,
  nullability, defaults, constraints, strict object membership, and unions;
- exact success and declared-error status codes and media types;
- no content schema on a no-content response;
- `userBearer` security on every user operation and `workloadBearer` only on
  projected-workload operations;
- required `AnyCloud-Client-Version` metadata on every user-authenticated
  management request, but not projected-workload requests;
  and
- a usable configurable API base with `http://localhost:8080/v1` as the local
  default, without preventing hosted URLs.

Middleware behavior that changes the wire contract is part of OpenAPI even if
oRPC does not infer it automatically. It must be expressed at the contract
builder/export layer, not added by a post-generation patch.

### Generator and dependency decision

Use Maven artifact `org.openapitools:openapi-generator-cli:7.24.0`, SHA-256
`4b83ccc6fd43056c8c631cd0195e5100bd0550912502527bab09ac76152dab0c`.
CI downloads that exact artifact from Maven Central and rejects a checksum
mismatch before executing it. A generator upgrade is a reviewed dependency
change with a new proof, checksum, and generated diff.

The initial configuration is:

```yaml
generatorName: python
additionalProperties:
  buildSystem: hatchling
  disallowAdditionalPropertiesIfNotPresent: false
  generateSourceCodeOnly: true
  hideGenerationTimestamp: true
  library: httpx
  packageName: anycloud
  packageVersion: ${PACKAGE_VERSION}
  projectName: anycloud-sdk
  supportHttpxSync: true
  useOneOfDiscriminatorLookup: true
```

Disable generated API/model tests and docs at invocation time; repository tests
and documentation own those surfaces. Enable discriminator lookup for declared
error unions because the contract supplies an exact `code` mapping for every
known error. Non-discriminated domain unions, including workload admission,
continue to use normal one-of validation. The corrected-artifact proof must
still qualify this behavior before SDK cutover.

The pinned generator requires one template override when standards-compliant
additional-properties handling is enabled. Its generic model template omits
the `List` import used by closed models and fails to enforce explicit
`additionalProperties: false` schemas in Pydantic construction and
`from_dict`; it also compares boolean enum values to lowercase strings. Vendor
that upstream template and correct those three behaviors.
The generation pipeline verifies the override through full annotation,
strictness, runtime, and deterministic-output qualification. No additional
template override or generated-source patch is permitted without revisiting
this decision.

The handwritten package metadata declares:

```toml
requires-python = ">=3.10"
dependencies = [
  "httpx>=0.28.1,<1",
  "pydantic>=2.11,<3",
  "python-dateutil>=2.8.2,<3",
  "typing-extensions>=4.12.2,<5",
]
```

These are the selected generator's runtime floors with explicit major-version
bounds, installed together during the Python 3.10 proof. The
typing-extensions floor is raised above the generator's emitted 4.7.1 because
Pydantic 2.11 requires 4.12.2. Raising a floor or upper bound requires the
normal dependency review and Python-version matrix.

### Authentication, versioning, and declared errors

The generated configuration accepts an absolute API base and a Bearer token.
User and workload Bearer schemes are distinct in OpenAPI even though both use
the HTTP `Authorization` header. A caller creates a client for one identity
kind; no operation accepts tokens in query parameters or request bodies.

`AnyCloud-Client-Version` is a required management-operation header because
the real management API rejects its absence or mismatch before authentication.
OpenAPI Generator exposes it as a required operation argument even when a
default header is configured, so initial callers pass the generated package
version explicitly. Workload operations do not take this argument. Hiding it
later would require a deliberate generated-template change or operation
wrapper, not an inaccurate optional header in OpenAPI.

Every declared error remains a named contract model with stable `defined`,
`code`, `status`, `message`, and typed `data`. OpenAPI Generator raises its
generated status exception and retains the decoded declared model on `.data`.
Do not hand-author code-specific Python exception classes. Conformance tests
assert the runtime type and data for every declared code so generator behavior
cannot silently collapse to an untyped string.

Unexpected errors retain the contract's undefined envelope. Error unions must
be structurally disjoint and named; an ambiguous or anonymous generated union
is a contract-export failure.

### Generation pipeline

One supported repository command performs these steps:

1. Read the version from `package.json`.
2. Generate OpenAPI from `apiContract` into a newly created temporary
   directory.
3. Canonically serialize it and run the repository's semantic contract checks.
4. Run OpenAPI Generator's validator as an additional structural check.
5. Download or use the cached 7.24.0 JAR only after verifying its SHA-256.
6. Generate source-only output into two empty temporary directories.
7. Reject unexpected output files, generated warnings selected as fatal,
   formatting failures, import failures, type-check failures, or test failures.
8. Recursively compare both outputs byte-for-byte, then atomically replace the
   ignored `python/generated/anycloud` build input.
9. Delete the temporary OpenAPI/output directories while retaining only the
   verified generated package copied into the ignored build directory.

No formatter rewrites generated Python unless it is part of this pinned
pipeline and is itself pinned. The proof needed no formatter for deterministic
output.

### CI and release integration

Documentation-only adoption work does not change CI now. The implementation
adds:

- a Python 3.10 and 3.12 matrix that generates the package from a clean
  checkout, imports every generated module, runs contract tests, and executes
  sync smoke calls;
- a short-lived artifact containing the Python 3.12 generated tree for
  inspection without making derived source part of repository history;
- existing TypeScript contract tests, expanded to cover the export requirements
  above; and
- package build/install smoke tests against the wheel rather than only an
  editable checkout.

The release workflow continues to publish `anycloud-sdk==X.Y.Z` in lockstep
with the CLI/API. After the release job checks out the immutable version-bump
commit, it generates the SDK, builds the wheel and source distribution from the
verified source, installs them under Python 3.10 and 3.12, runs the generated
sync/auth/error smoke suite, and only then invokes trusted publishing. It never
publishes OpenAPI or generator output produced from a different commit.

`scripts/verify-release-state.js` continues to compare package versions, but
reads the handwritten Python packaging version. The generation command also
passes that exact version into generated source and checks it against the
OpenAPI info version.

### Extension boundaries

The initial release includes
`anycloud_workflows.wait_for_terminal_workload` and the stateful
`anycloud_workflows.DeploymentJobPoller`, plus the in-Pod
`anycloud_workflows.current_deployment` context, as deliberately narrow examples.
Later additions follow these rules:

- generated files stay under the ignored `python/generated/anycloud` build
  directory and are never manually edited;
- helpers use separate top-level packages under `python/extensions`, so a clean
  generation cannot overwrite them;
- helpers accept or construct generated clients and consume/return generated
  models instead of duplicating dictionaries, enums, error schemas, or paths;
- a helper may compose several generated operations, but it must not hide the
  generated SDK behind a new mandatory façade;
- language-neutral workflow semantics move into the API contract when an API
  operation can own them safely; and
- adding an extension package requires explicit Hatch inclusion, dedicated
  tests, and a dependency-direction check forbidding generated code from
  importing extensions, except for the qualified root initializer's lazy
  `Client` and `AsyncClient` exports and typing aliases.

The optional `anycloud_workflows.Client` and `Job` handles extend that pattern
for common synchronous submission and lifecycle calls. `AsyncClient` and
`AsyncJob` provide the same image submission, Deployment submission and management,
and Job lifecycle operations on the application's event loop. Paired methods
have the same arguments, defaults, generated result types, and error meanings;
async methods return async handles where appropriate. Both client variants own only discovery,
client cleanup, automatic version arguments, and polling control flow; request
validation, response data, operations, and API errors remain generated.

Shared pure helpers construct admission and Deployment-management requests for both
clients. Image admission retains generated errors and server-assigned IDs when
the caller supplies none. First-claim waiting and its expiry guarantee apply
only to Deployment Jobs. `Job.wait()` and `AsyncJob.wait()` share completion outcomes
and polling validation; their low-level terminal-wait helpers return the
generated status even for unsuccessful terminal states. Ordinary request
timeouts retain generated transport behavior, while Deployment admission/observation
and resubmission enforce elapsed request budgets. Completion polling passes its
remaining wait budget to each status request. Local timeout or cancellation
does not terminate the remote Job.

Candidate future conveniences include batch submission and a full workload
loop. `get_or_submit`'s deterministic hashing is not copied: if restart-safe
submission remains valuable across clients, design an API-owned idempotency
contract.

### Deployment submission and acquisition composition

Deployment `Client.submit(timeout=..., wait=True)` waits for a durable first claim;
`Job.wait()` waits for completion. Preallocate a valid public Job ID before
admission, retain it on uncertain submission, and consume authoritative revision
and deadline receipts from admission/resubmission. `Job.resubmit()` returns the
generated `WorkloadResubmitResponse` and records its receipt on the handle.
Every Job uses one resubmission request path with the client's configured elapsed
request timeout. Existing-handle request errors retain their types; only
Deployment `Client.submit()` and `AsyncClient.submit()` wrap request failures with
the unreturned handle. The async client uses generated async operations directly
and shares submission validation, receipts, and outcomes with the synchronous
client. Local task cancellation propagates unchanged and does not confirm expiry;
callers needing recovery after cancellation save a custom Job ID before awaiting
submission. Async context management owns connection cleanup.
Confirmed expiry, other pre-claim termination, and changed submissions remain
distinct outcomes. Management API and SDK release versions must match exactly.

`DeploymentJobPoller.next_job(timeout=20)` serializes callers using a timed lock and
composes generated `discoverDeploymentJobCandidate` and `claimDeploymentJob` operations.
The timeout defaults to 20 seconds; callers can request immediate pickup with zero.
Its immutable pending tuple holds execution UUID, Job ID, submission revision,
and required-nullable previous execution UUID. Preserve it before sending claim
and through temporary failures, including generic conflicts. Matching success
validates both returned IDs before clearing it. Typed stale candidates allow
rediscovery while positive waiting time remains; typed used UUIDs clear pending
and propagate. Missing Jobs, future revisions, and unknown previous UUIDs remain
inconclusive.

Capture monotonic waiting and request deadlines at public entry, before token
refresh or lock acquisition. The request deadline caps the entire call at the
configured budget or 30 seconds, including both HTTP requests, decoding, and
cancellation settlement. Positive waiting time is at most 20 seconds; discard
late candidates before a new claim, with request-budget expiry taking precedence
over safe empty. Zero timeout permits one lookup and at most one claim; with
pending state it retries only that claim. After stale, pause at most 100 ms,
clipped to both budgets. A later call may use a different waiting timeout.

Only individual generated HTTP tasks may outlive cancellation settlement. No
background coroutine can initiate claims or mutate pending state after the call
returns. Handler outcome and cleanup calls stay usable during discovery. These
boundaries are qualified on Python 3.10 and 3.12 using source and installed
artifacts. Required-nullable decoding is a generic generator rule: omission
fails while explicit null remains valid, with no Deployment-specific exception.

### Native transports

Do not implement a native Python transport initially unless a concrete user
needs exec/log streams or bucket bytes. The generated SDK already covers every
bounded JSON operation, including bucket metadata, Deployment discovery/claim, submission observation,
and workload lifecycle operations.

If needed, add a narrow `anycloud_native` package that owns only:

- NDJSON framing, heartbeat/error/exit handling, cancellation, and
  backpressure for exec/logs; or
- streaming request/response bytes, content length, integrity, and atomic
  destination handling for bucket objects.

It must import shared generated parameter/error models where applicable and
may depend on generated client configuration/auth providers. It must not copy
JSON operations, credential models, bucket metadata models, or path inventories.
Native transport paths remain declared once in the existing TypeScript native
inventory until a language-neutral transport description is introduced.

### Testing

The contract-export suite is a semantic gate, not only an OpenAPI parser:

- procedure count and unique operation IDs;
- stable tags and component references;
- correct user/workload security and required version headers;
- exact request placement, strictness, union discrimination, nullability, and
  constraints;
- exact status/media pairs, especially empty `204` responses;
- no native route leakage;
- no anonymous generated public model or unresolved annotation; and
- a snapshot/hash used as diagnostic evidence, never as the authority.

Generated-client contract tests start the real in-process Express/oRPC server
and call every operation through generated Python. They cover representative
valid and invalid values for each model, both synchronous and asynchronous
calls, Bearer and client-version failures, every declared error code, all
success statuses including `204`, and configured local/hosted bases.

Convenience-layer qualification compares paired public method signatures and
exercises complete customer workflows through both clients: image submission
and completion, Deployment management, reattachment, resubmission, terminal errors,
claim expiry, and uncertainty. Native async tests also exercise concurrent
callers, cancellation, and connection ownership. Runnable sync and async image
completion examples and the async Deployment request handler run through real HTTP
using installed wheel and source-distribution packages.

Python 3.10 and 3.12 each compile and import every generated module. The build
is run twice from clean directories and compared byte-for-byte. Wheel tests
assert only intended generated and extension packages are present. Native
tests remain separate and transport-specific if those modules are later added.

The existing handwritten façade tests are deleted with the façade. Valuable
server/wire scenarios are rewritten against generated operations; valuable
helper behavior moves only with an approved extension.

## Implementation requirements

1. Every generated JSON path, parameter, wire model, and declared error comes
   from the same Zod/oRPC contract used by the server.
2. OpenAPI is temporary and is never tracked or included in a package or
   release asset.
3. `python/generated` is ignored, recreated by the supported command, and never
   manually edited.
4. All user operations declare user Bearer auth and the client-version header;
   workload operations declare workload Bearer auth and no version header.
5. A `204` response has no content and every declared error decodes to its
   named generated model.
6. The published wheel imports and executes synchronous calls on Python 3.10.
7. Handwritten extensions depend on generated code and never the reverse, and
   they do not restate contract models or paths.
8. A generator upgrade cannot modify handwritten packaging, documentation,
   tests, or extensions.
9. New `Client`/`Job` convenience operations include corresponding
   `AsyncClient`/`AsyncJob` workflows, matching argument and outcome coverage,
   and customer examples. Generated async method tests alone do not satisfy
   this requirement.

The generation script and conformance suite described above become the
enforcement mechanisms when this RFC is implemented. This proposed RFC does
not claim that those mechanisms already exist.

## Acceptance scenarios

| ID  | Scenario                                                                                        | Required result                                                                                                                                                                   |
| --- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | A contract field, path, or error changes                                                        | CI generates and qualifies the corresponding Python source from that commit                                                                                                       |
| S2  | OpenAPI omits management auth or version metadata                                               | Semantic export validation fails before code generation                                                                                                                           |
| S3  | An endpoint returns no content                                                                  | Generated sync and async calls return cleanly without an invented `AnyOf` model                                                                                                   |
| S4  | The API returns a declared conflict                                                             | Generated status exception contains the named generated error model and typed data                                                                                                |
| S5  | A wheel is installed on Python 3.10                                                             | Every generated module imports and a synchronous real-HTTP call succeeds                                                                                                          |
| S6  | Generation runs twice from the same commit                                                      | Every generated byte and path is identical                                                                                                                                        |
| S7  | A future helper is added                                                                        | It composes generated clients/models from outside the generated directory and survives regeneration                                                                               |
| S8  | Concurrent async request handlers submit Deployment Jobs                                        | The installed SDK's public `AsyncClient` runs the customer example through real HTTP; claim and confirmed expiry have distinct outcomes while peer handlers can progress          |
| S9  | An async Deployment admission or observation response is lost or hits its HTTP request deadline | `JobSubmissionUncertain` retains the Job and original cause; observation never resubmits work or treats the request timeout as expiry                                             |
| S10 | A synchronous or async application submits an image Job and waits for completion                | Both installed clients run the matching customer examples through real HTTP; admission settings, completion results, terminal errors, and polling timeouts have matching meanings |
| S11 | An application manages Deployments through either convenience client                            | Creation, listing/filtering, lookup, update, and deletion have matching arguments and generated models; omitted settings are preserved and explicit nulls clear nullable settings |
| S12 | An async image submission or completion wait is cancelled while other requests run              | Cancellation propagates without remote termination; peer requests can progress and the client remains usable until its owner closes it                                            |

## Alternatives considered

- **openapi-python-client 0.28.4.** It supports Python 3.10, httpx, and sync and
  async functions, but its generated public models are attrs-based rather than
  Pydantic. Its newer 0.29 release also drops Python 3.10.
- **Kiota.** It supports Python 3.10 and httpx through a request adapter, but
  uses Kiota abstraction/serialization packages rather than Pydantic and is
  async-first.
- **Stainless or Speakeasy.** They produce polished clients; Speakeasy is the
  closest Pydantic/httpx match. Both put generation behavior and part of the
  release/custom-code workflow behind a managed service. This RFC prefers a
  checksum-pinned local compiler while the team is small.
- **A custom OpenAPI generator.** It could create a smaller surface but makes
  AnyCloud responsible for a Python compiler, serializers, auth, exceptions,
  and JSON Schema edge cases.
- **Generate directly from Zod/oRPC internals.** This can see client policy but
  creates a second language-specific interpretation and weakens OpenAPI as the
  reproducible language-neutral boundary.
- **Keep or wrap the handwritten SDK.** It preserves conveniences at the cost
  of duplicated contract representations. With no users, there is no reason to
  retain it as a façade or compatibility layer.
- **Check in generated source.** This makes arbitrary Git checkouts immediately
  usable without Node/Java and preserves the exact generated tree in history,
  but duplicates fully derived output, adds large low-signal diffs and merge
  conflicts, and can exceed code-host review limits. Deterministic CI, an
  inspection artifact, and release generation from an immutable commit retain
  reproducibility without committing the generated tree.

## Risks & caveats

- OpenAPI Generator's OpenAPI 3.1 support is documented as beta even though the
  Python generator is stable. The exhaustive real-server suite and pinned
  upgrade process are the mitigation.
- Generated names and file counts can be poor when schemas are anonymous. The
  contract must provide stable component names and tags; generator name maps
  are not a substitute for canonical contract names.
- The generated sync implementation runs the async httpx client through a
  helper. It must be qualified in ordinary synchronous code and in environments
  with an active event loop before release.
- Required version-header setup is less ergonomic than today's implicit file
  discovery. There are no current users; validate the direct generated surface
  before adding a construction helper.
- A source checkout must run the supported generation command before building
  or testing the generated package. CI and release own that prerequisite, while
  published wheels and source distributions already contain generated source.
- Managed generators may later become worthwhile for documentation, release
  automation, pagination, or richer errors. Reconsider them from the same
  ephemeral OpenAPI artifact rather than changing the source of truth.
- Removing the façade also removes batching, polling handles, recursive bucket
  I/O, and current-Deployment ergonomics until individually justified. This is
  deliberate, not an accidental compatibility regression.

## Rollout

1. Correct and semantically test OpenAPI authentication, headers, no-content
   responses, server configuration, component naming, tags, and declared errors.
2. Add the checksum-pinned generation command and the proposed Python layout;
   regenerate until all proof gates pass on Python 3.10 and 3.12.
3. Port only real JSON/server conformance coverage to generated operations.
   Do not port façade-shape tests merely to preserve old behavior.
4. In one breaking release, delete handwritten Python implementation/models,
   publish generated code directly, and replace the Python reference with the
   generated surface and explicit auth/version construction.
5. Observe internal use. Add separate helpers or native transports only after
   a concrete workflow requires them; move cross-language semantics server-side.

Because clients and API versions already move in lockstep, the cutover needs no
dual package, aliases, deprecation period, route compatibility, or migration
adapter.

## Resolved implementation decisions

- OpenAPI Generator 7.24.0 is selected; its Maven JAR and SHA-256 are fixed
  above.
- OpenAPI is ephemeral, internally generated, semantically tested, and never
  committed or published.
- Generated code is the direct public `anycloud` package, but remains ignored
  build output; CI publishes a short-lived inspection artifact and no façade is
  added.
- Packaging metadata remains handwritten and generator output uses source-only
  mode.
- Python 3.10 and 3.12, Pydantic 2.11+, and httpx 0.28.1+ are the initial
  qualification targets/floors.
- Generated files and future handwritten extensions occupy disjoint directories
  and top-level packages.
- No native Python transport ships initially. NDJSON and byte streaming remain
  eligible for narrow handwritten modules later.
- No current public Python class, model, exception, method, alias, or workflow
  helper is retained for compatibility.

## Open questions

None for the initial architecture. Implementation may reject the selected
generator only if the corrected-contract proof still fails an acceptance
scenario; that outcome requires updating this RFC rather than silently adding
a façade, generated-source patch, or additional custom template.

## Decision

Pending review.

# RFC 0018: Contract-first TypeScript JSON APIs

> Status: Accepted
> Date: 2026-08-18
> Author: Codex draft

## Summary

Adopt oRPC and Zod as the shared TypeScript contract and runtime-validation
boundary for AnyCloud's conventional JSON API endpoints. Keep Express as the
HTTP listener, preserve native implementations for streaming and binary
transports, and migrate one route family at a time behind transport-free domain
services.

The API and TypeScript CLI consume the same contract directly; this proposal
introduces no TypeScript client generation. Existing HTTP paths and successful
JSON response shapes remain compatible during migration. One deliberate
lockstep wire break moves the client version from individual request bodies and
query strings to the required `AnyCloud-Client-Version` header on every
operational request. The three bucket metadata mutations normalize their legacy
plain-text `ok` body to the contract's literal `"ok"` output for TypeScript
callers while preserving the existing `text/plain` bytes on the HTTP wire.
Generating a private Python client is explicitly deferred and is not part of
this decision.

RFC 0019 subsequently supersedes this RFC's wire-compatibility constraint and
explicit numeric retry metadata. Its canonical resource paths, Bearer-only
authentication, HTTP success semantics, and method-derived replay guarantees
are the current surface; the oRPC/Zod/Express architecture selected here is
unchanged.

## Context / problem

AnyCloud currently has three overlapping sources of truth for many API calls:

- Express routes parse and validate request bodies, query parameters, and path
  parameters in `src/api/routes/`;
- TypeScript request and response interfaces live in `src/shared/types.ts` and
  adjacent modules;
- client wrappers in `src/shared/services/api-client.ts` repeat HTTP methods,
  paths, serialization, and error behavior.

The Python SDK adds a fourth handwritten HTTP consumer, but it is not the
primary subject of this RFC.

This arrangement makes local code understandable, but it has recurring system
costs:

- a server validation change can leave the TypeScript client type unchanged;
- a client path or query serializer can drift from the route that accepts it;
- response bodies are generally trusted rather than checked at the boundary;
- error bodies and status handling vary by route family;
- structural and stateful validation are interleaved with authentication,
  repositories, provider operations, and HTTP response shaping;
- an agent adding an endpoint has several plausible places to define the same
  shape and no enforced default path through the architecture.

Zod is already a production dependency, but it is not consistently the runtime
authority for API boundaries. Adding isolated Zod middleware would improve
individual routes without eliminating the parallel client contract.

The transport surface is not uniform. Most management operations use ordinary
JSON, while exec and logs use NDJSON, bucket upload and download move bytes or
streams, and some routes deliberately control response headers and
backpressure. A framework decision that forces those transports through one
JSON abstraction would make the system less clear.

A production-shaped spend-controls slice has established feasibility for the
proposed boundary: six JSON operations can share Zod schemas, run through an
authenticated oRPC router on the existing Express listener, delegate to a
transport-free domain service, and be called directly from a typed TypeScript
client. That slice is evidence for review, not acceptance of the broader
migration.

## Goals

- Define each migrated JSON request, response, and declared error once.
- Enforce structural validation at runtime on both inputs and outputs.
- Give TypeScript callers end-to-end inferred types without generated code.
- Establish one conventional path for authentication, errors, timeouts,
  retries, abort propagation, and domain delegation.
- Make transport, domain, persistence, and provider boundaries mechanically
  recognizable to reviewers and coding agents.
- Preserve current public HTTP behavior unless a separate change explicitly
  changes it.
- Allow incremental adoption without replacing Express or rewriting native
  streaming routes.

Reducing physical LOC is not a goal. The proposal accepts some contract and
adapter code in exchange for one runtime-checked boundary and fewer independent
representations.

## Proposal

### Make the oRPC contract the TypeScript wire authority

For each migrated route family, organize code into four layers:

```text
src/shared/api-contract/<family>-schemas.ts
    Zod wire schemas and inferred TypeScript types

src/shared/api-contract/<family>.ts
    oRPC methods, paths, input structures, outputs, and declared errors

src/api/rpc/<family>.ts
    authentication-aware handlers that translate and delegate

src/api/services/<family>-domain.ts
    stateful rules and repository/provider coordination
```

The root contract composes family contracts. It must not become a single file
containing every schema and procedure.

Schema modules define transport structure: required fields, primitive ranges,
enums, strict object membership, and structurally checkable relationships.
They may export `z.input` and `z.output` types. They must not import Express,
oRPC server implementations, repositories, or provider gateways.

Contract modules define HTTP method, path, parameter placement, successful
output, and declared error codes. They do not implement business behavior.

RPC handlers authenticate and delegate. They may translate a domain error into
a declared transport error, but they do not query repositories or call provider
gateways directly.

Domain services own authorization-independent stateful semantics, persistence,
and provider coordination. Examples include whether a secret is in use, whether
a budget window is valid against stored state, or whether a credential may be
deleted. Domain modules do not import Express or oRPC.

### Classify endpoint structure separately from operational policy

Every conventional authenticated JSON procedure is created through one of two
builders. A **query** reads state and a **command** may change state. These are
structural categories, not retry archetypes: retry attempts and timeouts remain
orthogonal procedure policy.

| Builder   | Allowed HTTP methods             | Default total attempts | Retry condition        | Default timeout |
| --------- | -------------------------------- | ---------------------- | ---------------------- | --------------- |
| `query`   | `GET`, `HEAD`, `POST`            | 3                      | 5xx or transport error | 6 seconds       |
| `command` | `POST`, `PUT`, `PATCH`, `DELETE` | 1                      | None with one attempt  | 6 seconds       |

`maxAttempts` always counts the initial request. It is constrained to 1–5 so a
configuration cannot accidentally create an unbounded or unexpectedly long
client retry chain. HTTP method does not infer retries. An idempotent command
must opt into more than one attempt explicitly; a query may explicitly reduce
its attempts without becoming a different endpoint kind.

The reviewed exceptions are:

| Procedures                                                                     | Kind    | Total attempts | Retry condition        | Timeout                                                          |
| ------------------------------------------------------------------------------ | ------- | -------------- | ---------------------- | ---------------------------------------------------------------- |
| Spend set/unset, secret delete, API-access revoke, bucket mutations, terminate | Command | 3              | 5xx or transport error | 6 seconds                                                        |
| Workload admission, quota request, service upgrade                             | Command | 5              | Declared 503 only      | None                                                             |
| Managed-cluster creation                                                       | Command | 1              | None                   | 60 seconds                                                       |
| Managed-cluster deletion                                                       | Command | 3              | 5xx or transport error | 60 seconds                                                       |
| Database query                                                                 | Query   | 3              | 5xx or transport error | 60 seconds                                                       |
| Quota status                                                                   | Query   | 1              | None                   | Env/default, or `max(5s, waitMs + 2s)` when `waitMs` is supplied |

The declared-503 condition means the contract server rejected the operation
before domain side effects. An undefined 503 from a proxy and a raw transport
failure are ambiguous and are therefore not retried for those commands. Native
NDJSON and byte-stream procedures remain outside these JSON builders and keep
transport-specific lifecycle policy. Ordinary retries wait 500 milliseconds;
declared pre-side-effect retries retain their one-second recovery interval.

### Keep Express as the listener

Mount one oRPC OpenAPI handler on the existing Express application under the
`/v1` prefix. It must run before `express.json()` so it can parse and validate
matched requests itself. An unmatched request must fall through without its
body being consumed so legacy JSON and native transports continue to work.
Matched contract bodies retain Express's 100 KiB JSON limit, including chunked
requests without a declared content length; the limit does not apply to native
byte-stream routes that fall through the handler.

The listener boundary is therefore:

```text
request
  -> native health/version routes
  -> oRPC handler for migrated JSON procedures
       -> exact client-version gate
       -> authentication
  -> Express JSON parser
  -> native transport routers
       -> exact client-version gate
       -> authentication
  -> Express error middleware
```

`GET /v1/version` remains unguarded for diagnostics and lifecycle recovery.
Every operational oRPC and native endpoint requires
`AnyCloud-Client-Version` to equal the API package version before
authentication or domain logic runs. Version is transport metadata, not an
endpoint DTO field.

This RFC does not replace Express with Fastify or NestJS. Express remains the
composition root and escape hatch for transports that do not benefit from the
contract abstraction.

### Migrate only conventional JSON endpoints

An endpoint is eligible when its request and response can be represented as a
bounded JSON document plus ordinary path, query, header, or cookie parameters.
Examples include spend controls, secrets, credentials, API access management,
database query/schema metadata, quota metadata, and JSON bucket-management
operations.

Every eligible family in the inventory is in scope for this migration program.
The inventory order is a delivery decision, and each family must demonstrate
wire compatibility before its legacy route is removed. Families whose current
Express handlers mix transport and orchestration first receive a tested,
transport-free domain operation; that prerequisite is a migration stage, not
an indefinite deferral.

Keep these native unless a later RFC establishes a better abstraction:

- NDJSON exec and log streams;
- request or response streams with explicit backpressure;
- bucket object upload and download;
- raw bytes, multipart bodies, protocol upgrades, or long-lived bidirectional
  connections;
- health, version, and process-local test endpoints where a contract adds no
  useful consumer guarantee.

A route family may therefore be split: bucket list/create/delete metadata can
be contract-backed while upload/download remain native.

### Migration inventory

This table tracks implementation disposition separately from the RFC decision
status. `Complete` means the migration has landed; `Native` identifies a
deliberate transport boundary rather than deferred work.

> Last updated: 2026-08-21. Endpoint shapes reflect RFC 0019.

| Family              | Endpoints                                                                 | Target         | Migration status | Notes                                                                                      |
| ------------------- | ------------------------------------------------------------------------- | -------------- | ---------------- | ------------------------------------------------------------------------------------------ |
| Health and version  | `GET /health`, `GET /v1/version`, process-local test endpoints            | Native Express | Native           | Public diagnostics are exempt from the operational client-version gate.                    |
| Spend controls      | `/v1/spend/throttles`, `/v1/spend/budgets` resource collections and items | oRPC JSON      | Complete         | Feasibility slice for auth, validation, domain delegation, retries, and direct TS client.  |
| Secrets             | `GET /v1/secrets`, `PUT/DELETE /v1/secrets/:name`                         | oRPC JSON      | Complete         | Typed in-use conflicts and explicit query coercion; legacy handler removed.                |
| Credentials         | `/v1/credentials` items, list, and `/:name/material`                      | oRPC JSON      | Complete         | Preserves redaction, write-only fields, provider-specific input, and material-read policy. |
| API access          | `GET/POST /v1/api-access/users`, `DELETE /v1/api-access/users/:userId`    | oRPC JSON      | Complete         | Policy semantics retain owner and allowlist authorization behavior.                        |
| Database            | `POST /v1/database/queries`, `GET /v1/database/schema`                    | oRPC JSON      | Complete         | Query rows and schema metadata now have explicit checked output contracts.                 |
| Bucket metadata     | bucket and object resources nested under `/v1/credentials/:name/buckets`  | oRPC JSON      | Complete         | Split from native transfer operations; metadata mutations use no-content responses.        |
| Bucket transfer     | `PUT/GET .../buckets/:bucket/object-content`                              | Native stream  | Native           | Request/response bytes, content-length metadata, piping, and backpressure stay explicit.   |
| Workload admission  | `POST /v1/workloads`                                                      | oRPC JSON      | Complete         | Admission, persistence, capability checks, and scheduling extracted into a domain service. |
| Service upgrade     | `POST /v1/workloads/:id/upgrades`                                         | oRPC JSON      | Complete         | Checkpoint and upgrade orchestration extracted into a transport-free domain service.       |
| Workload management | cost, list, terminate, status, SSH access, and resubmit                   | oRPC JSON      | Complete         | Route orchestration extracted; `routes/cli.ts` now contains native NDJSON only.            |
| Exec and logs       | `POST /v1/workloads/:id/exec`, `GET /v1/workloads/:id/logs`               | Native NDJSON  | Native           | Preserve target resolution before headers, framing, aborts, timeouts, and backpressure.    |
| Quota               | `/v1/quota/operations` creation/lookup and `/v1/quota/status`             | oRPC JSON      | Complete         | Retains the durable operation behavior specified by RFC 0010.                              |
| Managed clusters    | create, list, status, and delete under `/v1/clusters`                     | oRPC JSON      | Complete         | Preserves fixed-capacity validation, provider checks, durable intent, and reconciliation.  |

Migration-status meanings:

- **Complete:** implemented and landed.
- **Native:** intentionally excluded from the oRPC JSON migration.

Cross-cutting consolidation is tracked separately so endpoint migration cannot
be mistaken for completion of the client and compatibility work.

| Concern                   | Migration status | Evidence                                                                                                                           |
| ------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript JSON transport | Complete         | CLI JSON calls use the direct contract client; the path-based client façade is deleted.                                            |
| Retry and timeout policy  | Complete         | Builders derive replay guarantees from HTTP methods; reviewed semantic exceptions and timeout profiles are inventoried and tested. |
| Native client transport   | Native           | Exec/log NDJSON and bucket byte transfer use endpoint-specific native functions.                                                   |
| Wire DTO ownership        | Complete         | Legacy shared names, where still consumed, resolve to Zod-inferred contract types.                                                 |
| Python compatibility      | Complete         | Real HTTP covers every contract-backed family currently called by the handwritten Python client.                                   |
| Architectural enforcement | Complete         | ESLint and boundary checks reject unapproved routes, façade reintroduction, and layer cycles.                                      |
| Version compatibility     | Complete         | TS and Python transports send one required header; server gates run before auth/domain work.                                       |

> Implementation status: Complete. Every conventional JSON
> family and every consolidation concern above is migrated. Entries marked
> Native are deliberate transport boundaries, not deferred migration work.

### Separate structural validation from semantic validation

Zod is authoritative for structural wire validation. Schemas should be strict
by default and prefer primitives that accurately describe the wire format.

Transport representations must be modeled as they actually arrive. Query
parameters, for example, arrive as strings; a query flag should be declared as
`"true" | "false"` and transformed to a boolean rather than declared as a raw
`z.boolean()` that rejects HTTP input.

Stateful and side-effectful checks remain in domain services. Zod does not
decide whether a named resource exists, a secret is referenced, a user may
mutate stored state, a provider supports an operation, or a database transition
is legal.

This separation is required even when a semantic rule could technically be
placed in an asynchronous Zod refinement. Boundary validation should remain
deterministic and free of repositories and providers.

### Make authentication and errors conventional

Authenticated procedures are the default. A shared authenticated procedure
base must:

- reject a missing or mismatched `AnyCloud-Client-Version` header before auth;
- require a Bearer token;
- use the existing API authentication and hosted-access policy;
- define stable authentication and authentication-availability errors;
- propagate the request abort signal;
- report unexpected/server failures once without treating declared client
  errors as internal failures.

Public procedures require a separate, explicit base or remain native Express
routes. A developer should not obtain a public endpoint by forgetting to add
middleware.

Expected domain failures map to declared error codes with stable HTTP statuses
and, where useful, typed data. For example, deleting an in-use secret should
carry a stable code and the relevant workload identifiers. Unexpected errors
remain internal and must not expose causes or secrets.

Generic route-entry messages are not part of the application logging contract.
Domain lifecycle diagnostics, warnings, failures, and semantic usage telemetry
remain explicit, while request/access logging—if required—belongs at the shared
listener or hosting boundary rather than in individual JSON or native routes.

Migration must preserve successful response bodies and status codes used by
existing TypeScript and Python clients. An error-envelope change that affects a
public consumer must be called out and tested as a compatibility change rather
than treated as an implementation detail.

While the handwritten Python SDK remains supported, its exception types and
HTTP status mapping are the compatibility boundary rather than either server
envelope's raw JSON text. Its decoder accepts the legacy top-level `error`
message and oRPC's top-level `message`, and preserves unrecognized bodies
verbatim. A real-HTTP compatibility test must exercise that decoder against the
production oRPC middleware whenever the contract transport changes.

### Use a direct TypeScript contract client

The CLI and other TypeScript consumers use one client constructed from the
shared contract. They do not consume generated code or a separately maintained
OpenAPI type layer.

The common client owns:

- selected API target and `/v1` prefix normalization;
- Bearer authentication;
- the required `AnyCloud-Client-Version` header on each actual request;
- request timeout and abort composition;
- retry policy based on explicit total attempts and eligible transport outcome;
- decoding of declared outputs and errors.

Retries remain conservative. Queries receive a three-attempt default. Commands
receive one attempt and opt into additional attempts only when their operation
is idempotent or a declared 503 proves that processing did not begin. Quota status
is an explicit one-attempt query because one request can already fan out across
providers and consume its 120-second default timeout. This policy is read from
contract metadata; neither HTTP method nor procedure path supplies hidden
behavior.

The client does not run a separate `/v1/version` preflight. A preflight creates
a second request, a cache, and retry coupling without making the subsequent
operation atomic. The server authoritatively checks the header on the operation
itself. `GET /v1/version` is retained only for explicit diagnostics, API target
selection, and the local/hosted API update lifecycle. A stale hosted API is
upgraded through its already-updated local manager; the incompatible hosted API
does not receive an operational bypass.

CLI commands retain orchestration, slurping, local-file handling, progress,
formatting, prompts, and user-facing error presentation. The contract client is
a transport layer, not a generated CLI.

During migration, legacy wrappers may coexist temporarily, but a migrated
procedure must have one canonical TypeScript transport path. At completion,
generic path-based JSON helpers and the legacy client façade are deleted.
Domain-oriented CLI orchestration remains only where it adds behavior beyond
transport. Native helpers name their fixed streaming endpoint instead of
accepting arbitrary JSON paths. Legacy shared type names may remain only as
aliases to contract-inferred types; they must not restate a wire shape.

### Enforce architectural boundaries

CI must reject at least these dependency violations:

- new Express HTTP-method registrations in API source modules,
  unless one native transport registration has a narrow, justified lint
  exception;
- contract/schema modules importing Express, server implementations,
  repositories, gateways, or API-only services;
- direct oRPC `.route(...)` or policy `.meta(...)` construction outside the
  shared query/command builder;
- schema-only modules importing oRPC;
- RPC handlers importing repositories or provider gateways directly;
- domain services importing Express or oRPC;
- shared client modules importing server-only oRPC packages.

Tests supplement import rules with behavior. Boundary scripts are not intended
to encode every architectural preference through regexes; they enforce the
small set of dependencies whose violation would recreate the original
coupling.

### Delivery plan

1. **Foundation and decision:** review this RFC and the spend-controls evidence.
   If accepted, stabilize the authenticated base, Express adapter, direct
   TypeScript client, and boundary checks.
2. **Inventory:** classify every `/v1` endpoint as contract-backed JSON or a
   native transport, recording the reason for native cases and the domain
   extraction prerequisite for large JSON handlers.
3. **Representative families:** migrate secrets, then credentials. These prove
   path/query parameters, write-only values, redaction, typed conflicts, and
   compatibility with the existing Python SDK without generating Python code.
4. **Incremental expansion:** migrate API access, database, bucket metadata,
   and quota in that order. Then extract and migrate workload management,
   workload admission, and service upgrade. Do not move large Express
   handlers wholesale into RPC procedures.
5. **Consolidation:** split family contracts, standardize reusable error and
   query schemas, remove migrated legacy routes/client wrappers, and update
   architecture documentation.

Each family is independently reversible until its legacy route is removed. Do
not keep two active implementations for the same method and path after parity
tests pass.

## Required invariants and tests

- A matched oRPC route validates its input and successful output at runtime.
- An unmatched oRPC request reaches the next Express middleware with its body
  unread.
- Contract JSON bodies larger than 100 KiB are rejected before authentication
  or domain work, while native byte streams remain unaffected.
- Native NDJSON and byte-stream routes retain framing, headers, abort behavior,
  and backpressure.
- Authentication runs before domain mutation and preserves hosted API access
  policy.
- Every operational request is rejected with `CLIENT_VERSION_MISMATCH` before
  authentication and domain logic when the client-version header is missing or
  does not exactly match. Version is absent from endpoint body/query schemas.
- Declared errors retain their stable status, code, message, and typed data.
- Unexpected errors are logged once and return no sensitive cause data.
- Paths, methods, query serialization, success statuses, content types, and
  response bodies remain compatible for migrated endpoints.
- Query coercion is tested through a real HTTP listener, not only an in-process
  client or mocked transport.
- The TypeScript client type covers every migrated procedure without generated
  declarations or duplicated request/response interfaces.
- Version-header propagation, timeout, caller abort, and retry behavior remain
  covered at the common client boundary. No ordinary operation performs a
  `/v1/version` preflight.
- Every contract procedure appears in one executable policy inventory covering
  its method, path, kind, total attempts, retry condition, and timeout.
- Quota status issues exactly one HTTP request after a 503 or timeout, retains
  the `QUOTA_STATUS_TIMEOUT_MS` default, and derives a longer deadline from an
  explicit `waitMs` query.
- API-access revoke is replay-idempotent: an already-absent user returns a
  successful nullable output so a retry after a lost success cannot report a
  false failure.
- Non-idempotent calls are not retried automatically.
- RPC handlers delegate to domain services and do not access repositories or
  provider gateways directly.
- Existing Python methods continue to work against migrated routes through the
  committed real-HTTP wire test in
  [`python-api-wire.spec.ts`](../test/integration/python-api-wire.spec.ts); no
  generated Python client is required. The test covers admission, workload
  management, credentials including full reads, secrets, and bucket metadata;
  native stream behavior remains covered by its transport-specific tests.
- Full unit verification and API contract-boundary checks pass after every
  family migration.

## Non-goals

This RFC does not:

- replace Express with Fastify or NestJS;
- force streaming, exec, upload, or download endpoints through oRPC;
- generate TypeScript code, commands, or DTOs;
- generate or redesign the Python SDK;
- make OpenAPI or JSON Schema the primary authored contract;
- move persistence or provider calls into Zod validation;
- eliminate semantic validation from domain services;
- introduce compatibility windows, content negotiation, or multi-version API
  behavior;
- force all eligible routes into one inseparable change or release;
- promise immediate net LOC reduction.

Generating a private Python transport from the eventual OpenAPI document is
tracked separately as
a future effort. It only
becomes proportional if most stable JSON endpoints are covered.

## Alternatives considered

### Keep Express and add Zod middleware ad hoc

This has the lowest migration cost per route, but it leaves methods, paths,
client types, error behavior, and output decoding independently maintained. It
improves validation without creating one end-to-end contract or a default
architecture for new endpoints.

### Adopt express-zod-api

This would provide a structured Zod-centric Express route layer. It still
requires migrating route composition and client conventions, and it provides
less value than oRPC for the direct shared TypeScript client and declared error
model. Native streaming endpoints would still need a separate path.

### Adopt ts-rest

ts-rest is a credible TypeScript contract-first REST alternative. It could
cover the same conventional JSON subset and export OpenAPI. oRPC is proposed
because its contract, implementation, middleware, declared errors, OpenAPI
transport, and direct client form one composable model while still attaching to
the current listener. The spend-controls slice has also validated that model in
this repository.

This is a close architectural alternative, not a claim that ts-rest is
incapable. Reconsider it if oRPC's error or transport model blocks a concrete
route family.

### Replace Express with NestJS

NestJS supplies stronger application-wide conventions, dependency injection,
decorator-based DTOs, and OpenAPI tooling. It would also turn a boundary
migration into a server-framework rewrite, introduce a second object model for
DTO validation, and require a new integration strategy for native streams. The
current problem does not justify that blast radius.

### Replace Express with Fastify and author TypeBox/JSON Schema

Schema-first Fastify routes would make JSON Schema and OpenAPI fidelity more
direct. They would not eliminate Python client generation if typed Python
clients are later desired, and they would replace the listener without solving
a current blocker. This becomes relevant only if cross-language OpenAPI
fidelity becomes a primary requirement rather than an optional export.

### Author OpenAPI first

A language-neutral source is attractive if TypeScript and Python become equal
contract authorities. Today the server and CLI are both TypeScript and benefit
from shared types with no generation. OpenAPI-first would impose generation on
the primary development path to solve a deferred SDK concern.

### Migrate every route through one abstraction

Uniformity at the framework level would hide real transport differences.
NDJSON, exec, and byte streams need explicit lifecycle and backpressure
ownership. A deliberate native boundary is safer than nominal uniformity.

## Risks & caveats

- Native and contract transports intentionally coexist. Conventional JSON no
  longer has two active implementations; the native side is limited to the
  exclusions recorded in the inventory.
- oRPC and its OpenAPI transport become production dependencies. Major upgrades
  require contract and integration-test review.
- Zod transforms can make input and output types differ. Reviewers must inspect
  wire input, handler input, and emitted OpenAPI rather than assuming one type.
- Query strings are an easy coercion footgun. Every non-string query value needs
  a real HTTP integration test.
- Default oRPC error envelopes may change. The Python compatibility decoder and
  real-HTTP CI test keep those changes from leaking raw envelope JSON to SDK
  callers.
- Arbitrary Zod refinements are not always faithfully representable in emitted
  OpenAPI. This does not weaken TypeScript runtime validation, but it matters if
  OpenAPI later becomes a cross-language input.
- Large existing route handlers mix transport and domain behavior. Moving them
  without first extracting a domain service would preserve the coupling under
  a new directory name.
- Boundary scripts can create false confidence. Behavioral tests and review of
  responsibilities remain necessary.
- Explicit retries on commands are a semantic assertion of idempotency. The
  complete policy inventory makes additions and changes review-visible, but a
  reviewer must still verify that assertion against domain behavior.
- Generated OpenAPI may be useful for documentation, but publishing it creates
  a compatibility surface that needs an explicit policy.
- Exact lockstep means an upgraded client cannot operate directly on a stale
  API. Hosted API recovery therefore depends on the documented manager chain:
  update the local manager first, then have it replace the hosted API.

## Open question

- Should the API publish its oRPC-generated OpenAPI document, or should it
  remain a build/test artifact until a cross-language client is approved?

This affects publication, not the TypeScript contract boundary.

## Decision

Accepted on 2026-08-18.

AnyCloud will define conventional JSON request, response, and declared-error
boundaries once with Zod and oRPC; consume those contracts directly from the
TypeScript API and CLI without generated code; retain Express as the listener;
and migrate route families incrementally behind transport-free domain services.

NDJSON, exec, byte streams, uploads, and downloads remain native transports.
Python client generation remains a separate, deferred decision. This boundary
was chosen because it removes TypeScript contract drift and adds runtime
validation without requiring a server-framework replacement or forcing unlike
transports through one abstraction.

Implementation completed on 2026-08-18, including all
inventory migrations, deletion of the legacy TypeScript client façade,
contract-owned retry/timeout policy and wire types, endpoint-specific native
transport exceptions, query/command builders with a complete executable policy
inventory, exact per-request client-version enforcement without a
preflight/cache layer, architectural guards, and the handwritten Python
client's production-wire compatibility check across every contract-backed
family it currently consumes.

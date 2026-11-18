# RFC 0019: Canonical control-plane HTTP surface

> Status: Accepted
> Date: 2026-08-19
> Author: Codex draft
> Outcome: Implemented on 2026-08-20.

## Summary

Normalize AnyCloud's control-plane endpoints around resource-shaped paths,
Bearer-only authentication, HTTP method semantics, and repeat-safe PUT and
DELETE behavior. The TypeScript CLI, Python SDK, API, tests, and integration
helpers move in lockstep. This change deliberately provides no route aliases,
dual request schemas, or compatibility window.

RFC 0018 remains the decision for oRPC, Zod, Express composition, and native
stream ownership. This RFC supersedes its requirement to preserve the HTTP
paths and successful response bodies that predated the contract migration.

## Context

RFC 0018 made the API structurally explicit without redesigning its existing
wire surface. That preserved several historical shapes:

- ten JSON procedures and two native procedures authenticate from a request
  body even though the direct contract client also sends a Bearer token;
- five read-only JSON procedures use POST;
- workload operations are top-level verbs such as `/new`, `/status`, and
  `/terminate` rather than resources;
- create-or-replace resources use POST while their identifier is in the body;
- DELETE inputs and successful action messages retain legacy wire choices;
- native request metadata has handwritten validation and a separate error
  envelope;
- retry policy is configured numerically even when the HTTP method and server
  semantics can supply the safe default.

Exact client/API version enforcement means incompatible clients already fail
before authentication or domain work. Keeping the old surface therefore adds
implementation choices and agent footguns without providing a supported
compatibility benefit.

## Goals

- Make Bearer authentication the only operational authentication source.
- Make the HTTP method the default authority for mutability and replay safety.
- Give each resource one canonical collection or item path.
- Make repeated PUT and DELETE requests safe after a lost response.
- Keep arbitrary SQL bodies and byte/NDJSON streams on suitable transports.
- Validate native path, query, and JSON metadata with shared Zod schemas.
- Keep retry attempt counts, delay, cancellation, and deadlines in the client.
- Remove compatibility-only fields, aliases, bodies, and interceptors.

## Non-goals

- Replacing Express, oRPC, or Zod.
- Moving NDJSON or byte streams through the JSON contract handler.
- Generating a Python client.
- Adding a generic idempotency-record store for POST requests.
- Normalizing response envelopes that have no semantic or safety benefit.
- Refactoring unrelated domain behavior.

## Authentication

Every operational request carries `Authorization: Bearer <token>`. Request
bodies and query strings never contain the authentication token. The
authenticated boundary yields a `User`; its existing `token` property remains
available to domain operations that need GHCR access.

The exact client-version gate continues to run before authentication. Health
and version diagnostics remain public.

## Canonical endpoint inventory

All paths below are under `/v1` except the explicitly root-level health probe.
`JSON` procedures are oRPC/OpenAPI procedures. `NDJSON` and `bytes` procedures
remain native Express transports with shared Zod metadata schemas.

| Family         | Method and path                                                         | Transport   | Success      | Replay default         |
| -------------- | ----------------------------------------------------------------------- | ----------- | ------------ | ---------------------- |
| Diagnostics    | `GET /health` (root)                                                    | native      | `200`        | probe-owned            |
| Diagnostics    | `GET /version`                                                          | native JSON | `200`        | safe                   |
| Spend          | `GET /spend/throttles`                                                  | JSON        | `200`        | safe                   |
| Spend          | `PUT /spend/throttles/{scope}`                                          | JSON        | `204`        | idempotent             |
| Spend          | `DELETE /spend/throttles/{scope}`                                       | JSON        | `204`        | idempotent             |
| Spend          | `GET /spend/budgets`                                                    | JSON        | `200`        | safe                   |
| Spend          | `PUT /spend/budgets/{period}/{scope}`                                   | JSON        | `204`        | idempotent             |
| Spend          | `DELETE /spend/budgets/{period}/{scope}`                                | JSON        | `204`        | idempotent             |
| Secrets        | `GET /secrets`                                                          | JSON        | `200`        | safe                   |
| Secrets        | `PUT /secrets/{name}`                                                   | JSON        | `204`        | idempotent             |
| Secrets        | `DELETE /secrets/{name}`                                                | JSON        | `204`        | idempotent             |
| Credentials    | `GET /credentials`                                                      | JSON        | `200`        | safe                   |
| Credentials    | `GET /credentials/{name}`                                               | JSON        | `200`        | safe                   |
| Credentials    | `GET /credentials/{name}/material`                                      | JSON        | `200`        | safe                   |
| Credentials    | `PUT /credentials/{name}`                                               | JSON        | `204`        | idempotent             |
| Credentials    | `DELETE /credentials/{name}`                                            | JSON        | `204`        | idempotent             |
| API access     | `GET /api-access/users`                                                 | JSON        | `200`        | safe                   |
| API access     | `POST /api-access/users`                                                | JSON        | `200`        | unsafe                 |
| API access     | `DELETE /api-access/users/{userId}`                                     | JSON        | `204`        | idempotent             |
| Database       | `POST /database/queries`                                                | JSON        | `200`        | declared safe read     |
| Database       | `GET /database/schema`                                                  | JSON        | `200`        | safe                   |
| Clusters       | `POST /clusters`                                                        | JSON        | `202`        | unsafe                 |
| Clusters       | `GET /clusters`                                                         | JSON        | `200`        | safe                   |
| Clusters       | `GET /clusters/{id}`                                                    | JSON        | `200`        | safe                   |
| Clusters       | `DELETE /clusters/{id}`                                                 | JSON        | `202`        | idempotent             |
| Workloads      | `POST /workloads`                                                       | JSON        | `202`        | declared not processed |
| Workloads      | `GET /workloads`                                                        | JSON        | `200`        | safe                   |
| Workloads      | `GET /workloads/{id}`                                                   | JSON        | `200`        | safe                   |
| Workloads      | `DELETE /workloads/{id}`                                                | JSON        | `202`        | idempotent             |
| Workloads      | `GET /workloads/{id}/cost`                                              | JSON        | `200`        | safe                   |
| Workloads      | `GET /workload-costs`                                                   | JSON        | `200`        | safe                   |
| Workloads      | `GET /workloads/{id}/ssh-access`                                        | JSON        | `200`        | safe                   |
| Workloads      | `POST /workloads/{id}/resubmissions`                                    | JSON        | `202`        | unsafe                 |
| Workloads      | `POST /workloads/{id}/upgrades`                                         | JSON        | `202`        | declared not processed |
| Workloads      | `POST /workloads/{id}/exec`                                             | NDJSON      | `200` stream | no generic retry       |
| Workloads      | `GET /workloads/{id}/logs`                                              | NDJSON      | `200` stream | no generic retry       |
| Quota          | `POST /quota/operations`                                                | JSON        | `202`        | declared not processed |
| Quota          | `GET /quota/operations/{id}`                                            | JSON        | `200`        | safe                   |
| Quota          | `GET /quota/status`                                                     | JSON        | `200`        | no retry               |
| Buckets        | `GET /credentials/{credentialName}/buckets`                             | JSON        | `200`        | safe                   |
| Buckets        | `PUT /credentials/{credentialName}/buckets/{bucketName}`                | JSON        | `204`        | idempotent             |
| Buckets        | `GET /credentials/{credentialName}/buckets/{bucketName}`                | JSON        | `200`/`404`  | safe                   |
| Buckets        | `DELETE /credentials/{credentialName}/buckets/{bucketName}`             | JSON        | `204`        | idempotent             |
| Bucket objects | `GET /credentials/{credentialName}/buckets/{bucketName}/objects`        | JSON        | `200`        | safe                   |
| Bucket objects | `DELETE /credentials/{credentialName}/buckets/{bucketName}/objects`     | JSON        | `204`        | idempotent             |
| Bucket objects | `PUT /credentials/{credentialName}/buckets/{bucketName}/object-content` | bytes       | `204`        | no generic retry       |
| Bucket objects | `GET /credentials/{credentialName}/buckets/{bucketName}/object-content` | bytes       | `200` stream | no generic retry       |

Bucket object keys remain query parameters because they may contain arbitrary
slashes. Provider region remains an optional query parameter. The credential
and bucket names move into the resource path.

## Input and output conventions

- Path parameters own resource identity and are not repeated in bodies.
- GET filters use query schemas that model and transform their wire strings.
- DELETE modifiers such as `force` remain query parameters because they change
  deletion semantics rather than resource identity.
- Replacement PUT bodies contain the desired resource fields except its path
  identity.
- Queued work returns `202`; completed deletion or replacement without a
  useful representation returns `204`.
- DELETE treats an already-absent resource as success when the caller's desired
  state is absence.
- Authenticated control-plane responses and byte downloads emit
  `Cache-Control: no-store`; NDJSON streams use their stream-specific
  no-cache policy.
- Native failures before stream headers use the declared structured error
  envelope. Failures after NDJSON headers use a typed stream error event.

The admission schema no longer accepts `accessToken`, `persist`,
`sshPublicKey`, `sshPrivateKey`, `imageDigest`, or the legacy workload type
`server`. Workload-management schemas no longer accept `accessToken` or the
ignored `credentials` field.

## Retry and timeout policy

The contract declares replay guarantees; the client performs attempts,
backoff, deadlines, and cancellation.

Here, "the client" means the shared TypeScript contract client used by the
CLI. The handwritten Python SDK adopts the canonical wire surface in this RFC;
cross-language generation or a shared retry engine remains outside its scope.

| Method/guarantee       | Default total attempts | Eligible failures         |
| ---------------------- | ---------------------- | ------------------------- |
| GET or HEAD            | 3                      | transport or 5xx          |
| PUT or DELETE          | 3                      | transport or 5xx          |
| POST or PATCH          | 1                      | none                      |
| Declared safe read     | 3                      | transport or 5xx          |
| Declared not processed | 5                      | branded declared 503 only |
| Explicit no retry      | 1                      | none                      |

`AUTHENTICATION_UNAVAILABLE` is emitted before a domain operation begins and is
therefore eligible whenever the endpoint's replay guarantee permits a retry,
including a declared-not-processed POST. An explicit `never` endpoint remains
single-attempt. An undefined proxy 503 and a raw transport error never prove
that a POST was not processed.

Attempt counts and backoff are central profiles, not endpoint-authored numeric
knobs. Timeouts remain independent profiles because request cost cannot be
derived from HTTP method. Quota status retains its `waitMs`-derived deadline;
provider-backed JSON bucket operations share a 60-second deadline.

Native uploads do not receive automatic retries because their input streams
are not generally replayable. Native response streams do not restart after
headers or partial output.

## Enforcement

- The executable endpoint-policy inventory covers every contract procedure
  and every native production route.
- Contract builders derive their default policy from the route method.
- The inventory test names every exception and rejects unreviewed exceptions.
- Every user-controlled body, path, and query object is strict and the policy
  test rejects a schema that reintroduces `accessToken`. The oRPC detailed
  envelope itself remains stripping because the adapter adds headers and empty
  structural sections before validation.
- Every fixed-shape response object is strict so a newly returned field fails
  loudly instead of being silently stripped before it reaches a client.
- ESLint continues to forbid conventional Express routes and direct oRPC
  builder/meta construction outside their owners.
- Real-HTTP TypeScript and Python tests exercise the canonical wire paths.
- Repeated-desired-state tests cover each retryable PUT and DELETE family;
  real lost-response tests cover representative replacement and deletion
  resources through the TypeScript client.
- Ambiguous POST failures and caller aborts prove that no second domain request
  is sent.

## Rollout

The API, TypeScript CLI, Python SDK, integration helpers, and tests change in
one release. No old route remains mounted and no removed field remains accepted
by a strict schema. The release version must change so an older client receives
the existing loud version-mismatch response rather than reaching an unknown
route.

## Tracking

- Canonical endpoint, authentication, replay-policy, and client migration.

## Decision

Accepted and implemented on 2026-08-20. Anycloud has one version-locked
control-plane HTTP surface with resource-shaped paths, Bearer-only operational
authentication, method-derived replay defaults, and no compatibility aliases.
RFC 0018 continues to own the contract and transport architecture; this RFC
owns the canonical wire shape that architecture exposes.

# RFC 0034: Configurable cloud endpoints and the fake-provider test layer

> Status: Accepted
> Date: 2026-09-01
> Author: Claude draft

## Summary

The API talks to each cloud at a hardcoded URL, so tests cannot point it at a
fake server. This RFC makes those URLs configuration: one small module
resolves each provider's base URL, with the real URL as the default and an
environment variable as the override. On top of that seam it defines the
fake-provider test layer — local servers and fake `aws`/`az`/`gcloud`
binaries that imitate each cloud's real requests, responses, and error
messages — so credential handling can be tested on every PR without cloud
accounts, and it writes down what that layer can and cannot prove. Three
efforts need these rules (RFC 0027's recovery tests, the control-plane-load
draft's real-socket option, possible sovereign-cloud support later), so they
should be agreed once, in writing, before code depends on them.

## Context / problem

What happens to a credential after it is saved cannot be tested against a
fake cloud today. The Azure client factories always use the public management
URL (`src/api/services/provider-clients/azure.ts`), the GCP factories never
pass an endpoint option (`src/api/services/provider-clients/gcp.ts`), and the
Lambda and Vast URLs are constants (`src/api/services/gateways/lambda.ts`,
`src/api/services/gateways/vast.ts`). So deploy-time credential checks, the
invalid-credential (`auth_failed_at`) handling, and first-use permission
recovery can only be tested by replacing the SDK clients with stubs —
which skips the code that parses real provider errors and runs the real
login handshakes, the code most likely to be wrong.

The CLI side can already be redirected — `AWS_ENDPOINT_URL[_STS]`
(`src/cli/services/credential-onboarding/aws-validation.ts`) and
`AZURE_RESOURCE_MANAGER_ENDPOINT` / `AZURE_AUTHORITY_HOST`
(`src/cli/services/credential-bootstrap/azure.ts`) — but each read is an
inline `process.env` lookup at the spot where a client is built. Nothing
states which variables exist, when they are read, or who may read them.

The test setup that uses these overrides also has no written rules. The
credentials terminal harness (`test/integration/credentials-onboarding/`)
predates RFCs on this surface. RFC 0008 describes three
test layers — in-process fakes, local microVMs, real cloud — and this fourth
kind, fakes that imitate the providers themselves, appears in none of them.
RFC 0027 says what must be verified but not what test infrastructure hosts
it. RFC 0028 showed the cost of leaving such rules unwritten: reviewers
re-argue them until someone writes them down.

## Proposal

### Endpoint configuration

One module, `src/api/services/cloud-endpoints.ts`, exports a function per
configurable endpoint: `armEndpoint()`, `azureAuthorityHost()`,
`gcpApiEndpoint()`, `gcpUniverseDomain()`, `lambdaApiBase()`,
`vastApiBase()`. Each function returns the environment variable if set,
otherwise the real production URL — and it reads the variable every time it
is called, not once at startup. The per-call read matters: the Azure gateway
builds fresh clients on every retry (to avoid stale cached tokens), and
tests that run the API in-process must be able to set a variable and have
the next client pick it up. The two GCP functions return the override or
nothing, because the Google SDKs compute per-service defaults
(`compute.googleapis.com`, `storage.googleapis.com`) that a single accessor
cannot restate.

The variable names reuse what the CLI already honors —
`AZURE_RESOURCE_MANAGER_ENDPOINT`, `AZURE_AUTHORITY_HOST` — plus new
`GCP_API_ENDPOINT`, `LAMBDA_API_BASE_URL`, and `VAST_API_BASE_URL`. The GCP
universe override reuses Google's own `GOOGLE_CLOUD_UNIVERSE_DOMAIN`, which
the compute clients already honor natively. Google's token-service URL is
hardcoded in its auth library, so no token URL override exists; instead a
non-default universe domain switches service-account auth to self-signed
tokens that never contact a token service, and the credentials object
carries the same universe domain to satisfy the SDK's consistency check.
The compute clients additionally receive the override as separate hostname,
port, and protocol options (`gcpGapicEndpointOptions()`), because unlike
storage and BigQuery they do not parse a full URL. `GCP_API_ENDPOINT` is
therefore an HTTP(S) origin, not an arbitrary base URL: the resolver rejects
credentials, a path prefix, a query, a fragment, or port zero rather than let
Storage and BigQuery retain URL components that Compute would drop. Storage
explicitly retains authentication for the custom endpoint; its SDK otherwise
assumes a custom endpoint is an unauthenticated emulator. Because Storage and
BigQuery give their legacy `STORAGE_EMULATOR_HOST` and
`BIGQUERY_EMULATOR_HOST` variables precedence over constructor options, the
resolver rejects either variable when `GCP_API_ENDPOINT` is active rather than
silently splitting traffic across different servers.

Only the client factory modules
(`provider-clients/azure.ts`, `provider-clients/gcp.ts`) and the Lambda/Vast
gateways may call these functions. AWS needs none: the AWS SDK itself honors
`AWS_ENDPOINT_URL` and its per-service variants, and this RFC treats that
built-in behavior as part of the contract rather than wrapping it.

If any function returns something other than its default, the API logs it
once. An API that has been pointed somewhere unexpected must be visible in
its own logs.

### The fake-provider test layer

The layer is a set of local HTTP servers and fake `aws`/`az`/`gcloud`
binaries that imitate the clouds precisely: the same XML and JSON bodies, the
same login flows, and the same error strings the product code branches on
(`InvalidClientTokenId`, `AADSTS7000215`, `invalid_grant`). The real CLI and
the real API talk to them over real network connections and real terminal
sessions; nothing in the product is stubbed.

Where it sits among the other layers: RFC 0008's in-process fakes (the
`local` provider) test scheduling and retry behavior at scale and stay free
of credentials and provider response formats; the smolvm layer tests real VM
execution; this layer tests the one thing the others cannot — that our code
handles each provider's exact responses correctly. The layers stay separate.
Credential onboarding runs in the CLI process, where no in-process API fake
can intercept it, and these fake servers never try to model scheduling load.

How tests reach it: tests that spawn the CLI or the API as a separate process
pass the variables in that process's environment; tests that run the API
in-process rely on the per-call reads above. Shared fake-server code lives
under `test/integration/`; which journeys exist and what they cover stays in
`journeys.ts` and `test/STRATEGY.md`, not in RFCs.

### Personas

A persona is a short recorded description of real provider behavior — for
example, "one account passes the identity check but is denied listing storage"
— that the fake servers replay. Every persona must come from something actually
observed: an incident, a support case, a captured live run, or a
provider-published troubleshooting record that includes the wire response,
cited in the persona file. Made-up provider behavior is not allowed, because a
test against an imagined response proves nothing. When a customer's account
fails in a new way, its responses are captured once and become a permanent
regression test.

What this layer does not prove, stated so nobody assumes otherwise: it
replays provider behavior we have already seen and cannot detect when a
provider changes its responses — the small live tier (one journey per cloud,
plus RFC 0027's live gate) remains the only check for that — and it says
nothing about how long real permission propagation takes.

## Required invariants

1. Production API code gets the overridable provider endpoints only from
   `cloud-endpoints` functions; no hardcoded management URLs and no endpoint
   environment reads exist anywhere else.
   _Enforcement: lint — `local/environment-access-ownership` grants these
   six overrides and two GCP conflict-detection variables to
   `cloud-endpoints.ts` alone; the hardcoded-URL half rests on review until a
   mechanical check exists (open question 1)._
2. Endpoint functions read their variable on every call: an override set
   while the process runs is used by the next client built.
   _Enforcement: test — a unit spec changes the variable mid-process and
   asserts a newly built factory uses it._
3. GCP endpoint overrides accept only HTTP(S) origins and preserve authenticated
   requests across Compute, Storage, and BigQuery clients.
   _Enforcement: test — a unit table rejects non-origin URL components, and a
   local HTTP server observes the real SDK requests and asserts each request
   path and bearer authorization header._
4. The API logs any active endpoint override.
   _Enforcement: test — the same spec asserts the log line._
5. Every persona file cites the real-world observation it came from.
   _Enforcement: review — the citation is prose; no mechanical check
   exists._

## Alternatives considered

- **Keep reading `process.env` inline where clients are built** (the current
  CLI pattern). Works, but nothing documents the variables, and behavior
  depends on when each module happens to read them.
- **Pass endpoints as arguments from `startApiServer` through composition
  into every gateway.** The most explicit option, but it threads four URLs
  through many layers and through `ResolvedCloudConfig`, which was just
  restricted on purpose — and spawned processes still need environment
  variables anyway.
- **Replace the SDK clients with fakes in tests.** Skips request building,
  response parsing, and login handshakes — the exact code these tests exist
  to check.
- **Intercept HTTP inside Node (nock or undici mocks), no product change.**
  Patches Node internals differently for each of three SDK network stacks,
  cannot reach spawned binaries, and this suite deliberately tests over real
  sockets.
- **Redirect at the network level (hosts file or an intercepting proxy).**
  Machine-global state, needs root in CI, and two suites cannot run
  different fakes at once.
- **Give the `local` provider the real providers' response formats.**
  Onboarding runs in the CLI process where the `local` provider cannot see
  it, and it would push a test-only provider toward the user-facing
  credential schema.
- **Store an endpoint set on each credential** — the shape real support for
  Azure Government or China clouds would take. The right long-term home, but
  it changes the API contract and needs a migration; deferred until a real
  need exists.

## Risks & caveats

- An endpoint variable accidentally set in production silently redirects
  cloud traffic; invariant 3 turns silent into logged.
- The fake responses go stale as providers change their wording; the live
  tier and the capture-a-persona practice are the mitigation, and the
  limitation is stated above.
- Azure fakes must serve HTTPS with a certificate the process trusts
  (Microsoft's auth library refuses plain HTTP); the existing
  `NODE_EXTRA_CA_CERTS` approach from the terminal harness carries over.
- Under a universe-domain override, GCP clients send self-signed bearer
  tokens and never request one; a GCP fake must accept those tokens without
  verifying them.
- Out of scope: validating non-AWS imports at save time (tracked
  separately), any change to the live tier, and migrating the CLI's existing
  inline env reads onto this module (possible later cleanup).

## Open questions

1. Whether to add a mechanical check for the hardcoded-URL half of
   invariant 1 (a repository-policy grep); the environment-read half is
   already wired through `local/environment-access-ownership`.

## Tracking

- `cloud-endpoints` accessors, provider-client wiring, the GCP
  GAPIC hostname/port/protocol translation, lint-owned environment access,
  and the endpoint unit spec.
- GCP origin resolver consolidation (`resolveGcpApiEndpoint`), the
  emulator-variable conflict rejection, and the authenticated round-trip
  test.
- The persona library with cited captures, operation pinning in the
  fake STS, and the terminal journeys for import rejection, Entra identity
  collision, and malformed key upload.
- The fake provider servers under
  `test/integration/fake-clouds/`, the credential-lifecycle lane (five
  per-provider deploy-time validation rejections plus a fake-S3 bucket
  listing), four newly captured personas, and the declared admission error
  for failed credential validation.

## Decision

Accepted 2026-09-02: the endpoint contract, the persona rules, and the
fake-provider lane described above shipped; the layer's non-claims stand as
written.

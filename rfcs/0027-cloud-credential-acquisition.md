# RFC 0027: Cloud credential acquisition and generation boundaries

> Status: Accepted
> Date: 2026-08-28
> Author: Codex draft

On 2026-09-14, [RFC 0038](./0038-aws-gcp-acquisition-and-recovery.md) superseded
only this RFC's AWS/GCP generation prohibition. The import/manual, Azure,
stored-credential, and ambient-identity boundaries below remain authoritative.

## Summary

Make cloud credential onboarding import-first: AWS and GCP accept existing
durable credentials, Azure additionally offers explicit local generation, and
the API never uses a host's ambient provider identity. Keep Azure generation on
an ownership-safe, contained Azure CLI transport, and handle authorization
propagation where the API first consumes the stored credential instead of in a
client-side readiness gate.

## Glossary

- **Stored credential:** durable workload credential material saved under a
  name in the selected AnyCloud API and encrypted at rest.
- **Import:** copy existing durable credential material from a local profile or
  file into a stored credential.
- **Manual entry:** supply durable credential fields directly through flags,
  environment variables, or the interactive flow.
- **Provider-CLI generation:** use a logged-in `aws`, `az`, or `gcloud`
  operator session to create a new durable workload identity and secret.
- **Ambient authentication:** let the API resolve cloud access at runtime from
  its host, metadata service, mounted provider configuration, or an SDK default
  credential chain instead of a stored credential.
- **First-use recovery:** retry a provider operation within its existing budget
  while a newly assigned permission propagates.

The provider CLI session is an operator identity. Imported or generated
material is a workload identity. The proposal keeps those identities distinct.

## Context / problem

Credential onboarding currently combines four separate concerns: discovering
local material, authenticating an operator, creating provider resources, and
deciding when a stored credential is usable. That makes a single `--generate`
flag mean substantially different mutations across providers:

- AWS creates an IAM user, policies, and an access key.
- Azure creates an Entra application, service principal, password, and two
  subscription role assignments.
- GCP creates a service account, project grants, and a key file.

The relevant implementation is split between
`src/cli/services/credential-onboarding/`,
`src/cli/services/credential-bootstrap/`, and
`src/cli/services/slurp/`. The resulting credentials are persisted by
`src/api/services/credentials-domain.ts` and consumed by provider gateways
under `src/api/services/gateways/`.

AWS static profiles and GCP service-account JSON already expose the durable
secret AnyCloud stores. Generating a second identity is not required to import
either. Dynamic AWS profiles and GCP user ADC do not expose a durable workload
secret. Using them as a route into identity creation is a separate capability,
not import, and expands the permissions onboarding requires.

Azure is the exception. An Azure CLI user session identifies a tenant and
subscription but cannot reveal an existing service principal's client secret.
Without generation, a user who has only `az login` must leave AnyCloud, create
an application and assignments elsewhere, capture its one-time secret, and
return to manual entry. Retaining an explicit generator materially shortens
that path.

The AWS and Azure generators historically waited in the CLI for generated
credentials to pass readiness probes. An earlier incident records the
counterexample: an Azure action succeeded and then returned
`AuthorizationFailed` seconds later for the same principal, scope, and action.
A client-side probe cannot make an eventually consistent, non-monotonic
authorization cache ready for a later API process. Readiness and recovery are
different: only recovery at the consuming operation can cover the observed
failure.

A later live qualification journey exposed the equivalent Entra case: the API created a
container with a generated credential, then a fresh management client received
`AADSTS7000215` for that exact secret two seconds later. This code is ordinarily
a terminal bad-secret signal, and a permanently broken secret has the same
shape. The practical tradeoff is therefore a narrow, bounded retry at the real
consumer operation: propagation can recover, while a bad secret incurs only the
fixed delay before failing normally.

### Supported behavior over time

The historical entries describe shipped support, not evidence that every path
was used in production. The target row records the accepted end state still
being delivered.

| Period       | Supported behavior                                                                                                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nov–Dec 2025 | Import and manual entry launched; provider-CLI generation expanded from Azure to AWS and GCP.                                                                                                                       |
| Apr–Jun 2026 | Stored credentials moved behind the API, onboarding consolidated under `credentials new`, and browser-authenticated provider CLI sessions could act as operator identities for generation.                          |
| Aug 2026     | Generation gained ownership, rollback, least-privilege, live-lifecycle, and readiness protections; static AWS import was restored after a regression; onboarding was reorganized without an intended policy change. |
| Target       | AWS and GCP become import/manual-only; Azure retains explicit provider-CLI generation; ambient authentication remains unsupported; API first-use recovery replaces client readiness gates.                          |

The main history spans many prior onboarding changes across this period.
Across those versions, local provider state was an acquisition input; it was
not a supported ambient identity for API provider operations.

## Proposal

### Acquisition policy

| Provider | Manual entry             | Import                                     | Provider-CLI generation           | API ambient authentication |
| -------- | ------------------------ | ------------------------------------------ | --------------------------------- | -------------------------- |
| AWS      | Access-key ID and secret | Durable static profile                     | Unsupported                       | Unsupported                |
| Azure    | Service-principal fields | Unsupported from an Azure CLI user session | Explicitly supported through `az` | Unsupported                |
| GCP      | Service-account fields   | Service-account key JSON                   | Unsupported                       | Unsupported                |
| Lambda   | API key                  | Unsupported                                | Unsupported                       | Unsupported                |
| Vast     | API key                  | Unsupported                                | Unsupported                       | Unsupported                |

Import rejects temporary, refreshable, or indirect sources with an actionable
explanation. In particular, AWS SSO, role, web-identity,
`credential_process`, and session-token profiles are not importable stored
credentials. GCP user ADC is likewise not a service-account key. Neither case
falls through to generation.

Removing generation changes acquisition only. Existing stored AWS and GCP
credentials, including credentials generated by an older AnyCloud release,
remain valid records. The migration does not delete their IAM users, service
accounts, access keys, key files, policies, or role grants.

### Explicit Azure generation

Azure onboarding presents two distinct actions:

1. **Enter Azure credentials** accepts an existing application ID, client
   secret, subscription ID, and directory ID.
2. **Create Azure credentials with Azure CLI** uses the current authenticated
   `az` session after showing the tenant, subscription, scope, and roles it will
   create.

Interactive generation requires confirmation. Non-interactive generation
requires an explicit `--provider azure --generate`; missing fields never cause
generation implicitly.

Generation keeps the current ownership-safe transaction rather than restoring
`az ad sp create-for-rbac`. Provider logic owns operation identifiers,
ownership tags, ambiguous-write reconciliation, role assignment, and guarded
rollback. A narrow transport owns every `az` invocation and:

- invokes `az` with argument arrays and no shell;
- requests and validates structured output;
- preserves Azure error codes and request IDs where available;
- applies timeouts and cancellation;
- redacts generated secrets and diagnostics; and
- never obtains or persists the operator session's bearer token.

There is no reliable universal permission preflight across Entra and Azure
RBAC. The flow therefore explains the required permissions before confirmation,
reports the precise failed operation, and rolls back only resources proven to
belong to that generation attempt. It does not claim success merely because an
operator can list a subscription.

### Stored-secret API boundary

Import and generation run in the user's AnyCloud CLI process even when the
selected target is a hosted API. The client sends only the resulting workload
credential and non-secret metadata through the normal credential contract. A
hosted API does not need `aws`, `az`, or `gcloud`, and it does not mount the
user's provider configuration.

The API continues to resolve provider access from a named stored credential.
It does not add a server-default mode or invoke SDK default chains for
control-plane actions. This does not change workload-native identity: a VM may
still use the instance identity AnyCloud deliberately assigned to it, and Local
compute remains credentialless.

Credential-bearing AWS, Azure, and GCP SDK constructors live only in three
audited provider-client factory modules. Their exact named constructor imports
are allowlisted; default imports, package namespaces, GCP version namespaces,
and ambient credential-provider packages are rejected. Direct construction from
an otherwise-unmapped provider SDK import is also rejected outside the matching
factory; AWS command constructors are the explicit safe exception. Factory APIs
accept the selected stored credential separately from other client options and
inject it last, so later option spreads cannot silently restore SDK fallback
behavior. Azure permits only `ClientSecretCredential` in its factory.

Credential acquisition may authenticate the exact imported material to catch a
bad key, but this is not broad permission validation and does not establish
readiness. `credentials-domain.save()` remains persistence, not a provider
mutation or a multi-minute propagation barrier.

### First-use recovery

The API retries only provider failures classified as propagation-shaped at the
operation that observed them. For Azure, that begins with the storage operation
identified by the earlier incident's evidence. Retry shares the operation's existing deadline and retry
budget, refreshes authentication where required, respects provider backoff, and
surfaces exhaustion as a declared provider error rather than an opaque HTTP 500.
A generic 403 is not automatically retryable.

An earlier change implements the first slice for Azure storage. It retries the specific ARM
`AuthorizationFailed` shape at the consuming operation, refreshes management
clients between attempts, and leaves unrelated authorization failures terminal.
A later change additionally introduced short-lived, process-local evidence before
retrying `AADSTS7000215`. The final qualification caught the remaining
first-token case: a newly generated secret can return that code before any
successful token acquisition exists.

That final change removes that evidence gate instead of carrying credential timestamps or
authentication history through the workload model. Compute validation,
runtime storage, and shared-identity role assignment give only exact
`AuthorizationFailed` and `AADSTS7000215` failures up to nine attempts over 39.5
seconds, refreshing clients where required. Ordinary compute failures retain
three attempts. An unrelated 403, `AADSTS7000222`, or generic `invalid_client`
failure gets no special recovery. A persistently broken secret uses the same
bounded budget as propagation and then follows normal terminal handling. Typed
bucket operations translate exhaustion into a declared retryable 503; native
upload and download retain their existing error contract. A canceled caller
stops waiting without aborting coordinated recovery for other callers, and
credential saving remains free of provider calls and waits.

With consuming recovery deployed and exercised, the final delivery deletes the
Azure CLI readiness loop and statically rejects runtime Azure SDK imports in the
CLI. SDK packages remain while provider gateways or other non-CLI source still
use them.

### Delivery sequence

1. **Complete.** Add bounded Azure first-use recovery in the API,
   without changing credential saving.
2. **Complete.** Extract the Azure generation transaction behind an
   `AzureTransport` interface without changing behavior.
3. **Complete.** Replace command strings with the contained Azure CLI
   transport and retain the live lifecycle test.
4. **Complete.** Apply the acquisition matrix atomically: make Azure
   generation explicit and remove AWS/GCP generation from public surfaces,
   services, tests, and documentation.
5. **Complete.** After first-use recovery is available on every
   supported API target, remove the client readiness gates and only the
   dependencies made unused.

The implementation umbrella supersedes earlier related work. It retains their
observed propagation failures and additive-before-subtractive ordering, but rejects
save-time readiness verification and blanket SDK-package deletion.

### Verification strategy

Acquisition and provider use are separate contracts. Deterministic tests prove
source selection, mutation boundaries, retries, and diagnostics. Live tests
prove that the exact stored material works against the provider; they do not
replace fault injection for a propagation condition that cannot be induced on
demand.

| Provider    | Deterministic PR contract                                                                                                                     | Live contract                                                                                                                                                        |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AWS         | Static-profile and manual-key acquisition work; dynamic profiles and `--generate` fail before provider mutation.                              | A test-owned fixture creates disposable static keys, AnyCloud imports them, the API performs a bucket operation, and the fixture cleans up.                          |
| Azure       | Manual entry and explicit generation are distinct; confirmation, cancellation, structured failures, reconciliation, and rollback are covered. | A test-owned principal proves manual entry; a separate product-generation journey saves and immediately uses the generated principal through the API; both clean up. |
| GCP         | Service-account JSON and manual fields work; user ADC and `--generate` fail before provider mutation.                                         | A test-owned fixture creates a disposable service-account key, AnyCloud imports it, the API performs a bucket operation, and the fixture cleans up.                  |
| Lambda/Vast | Existing masked manual-token and API contracts remain unchanged.                                                                              | Existing provider integration coverage remains authoritative; no identity-generation lifecycle is added.                                                             |

Test-owned AWS/GCP/Azure fixture provisioning lives under `test/`, uses an
administrative identity unavailable to product code, and never calls a product
generator. Creating disposable import material in setup does not restore a
shipped generation path.

Fixture readiness is separate from product readiness. AWS setup pins the new key
to the exact user ARN returned by IAM, independent of whether the bootstrap
principal is an IAM user or assumed role, and probes both S3 and IAM capabilities
rather than treating permissionless STS identity discovery as policy readiness.
Azure manual setup uses its new principal to run Provider-level validation of a
tagged empty resource-group declaration and to create and delete a deterministic
redundant role assignment. This proves Contributor and User Access Administrator
without creating a readiness resource or relying on storage created by another
journey. The subsequent API bucket CRUD proves the complete storage path. GCP
setup strips documented ambient gcloud identity overrides, activates and
asserts the exact generated account, and pins every validation command to it.
The probe returns immediately on success or retries for up to 90 seconds when a
new key initially fails, then checks compute, firewall, and storage capabilities
and calls `serviceAccounts.testIamPermissions` as that principal to require
`iam.serviceAccounts.actAs` on the VM service account. An unexpected active
principal is terminal rather than retryable. GCP IAM mutations retry the whole
idempotent command on both new-service-account propagation and concurrent policy
conflicts. Injected environments, clocks, waits, and randomness keep these
boundaries deterministic in unit tests.

| Fixture capability requirement                   | Readiness observation under the disposable identity                                                             |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| AWS exact identity, S3, and IAM                  | Provider-returned user ARN through STS, S3 bucket listing, and exact IAM lookup                                 |
| Azure Contributor                                | Provider-level ARM validation of one tagged, empty resource-group declaration; no resource is created           |
| Azure User Access Administrator                  | Create and delete one deterministic, redundant Reader assignment; bootstrap cleanup reconciles ambiguous writes |
| GCP compute, firewall, and storage control plane | List one page from each corresponding control-plane surface                                                     |
| GCP service-account impersonation                | `serviceAccounts.testIamPermissions` returns `iam.serviceAccounts.actAs` for the exact VM service account       |

Adding or changing a fixture grant requires changing this table, its readiness
probe, and a deterministic absent-then-present regression test in the same pull
request. Authentication-only probes cannot stand in for authorization readiness.
Probe resources are owned and cleaned by that journey; fixture setup cannot
depend on test order, shared leftovers, or identifiers inferred from the
bootstrap principal's display form.

The required layers are:

1. **Static boundaries.** Repository policy restricts provider CLI generation
   to the Azure CLI transport, rejects API dependencies on provider profile
   readers and default credential chains, and confines exact allowlisted SDK
   constructor imports to the provider-client factories. The credential API
   contract has no operator-session token field.
2. **Unit contracts.** Table-driven cases cover every accepted and rejected AWS
   profile/GCP key shape. An injected Azure transport covers every ambiguous
   create and rollback stage. Marker credentials prove that structured errors,
   cancellation, and timeout paths do not disclose secrets.
3. **Terminal contracts.** `test:credentials-terminal` remains the per-PR
   user-facing suite. Its journey inventory removes AWS/GCP generation and
   readiness cases, adds rejection-before-mutation cases, and adds Azure's
   explicit enter/create choice, permission preview, and cancel-before-mutation
   behavior.
4. **Consumer recovery.** Fake-clock API tests cover compute validation,
   storage, and role-assignment recovery for `AuthorizationFailed` and
   first-token `AADSTS7000215`, including success, bounded exhaustion,
   cancellation, client refresh, and unrelated or terminal failures that must
   not receive propagation retries. Saving a credential performs none of these
   waits or provider mutations. These tests replace rather than move the client
   readiness-loop tests.
5. **Live provider use.** The three onboarding jobs retain provider-owned
   cleanup but change their contracts according to the matrix above. Live
   assertions use the saved credential through the API, not a second direct
   provider client as a substitute for product behavior.
6. **Packaging and hosting.** The installed CLI artifact exercises the same
   acquisition dispatch and Azure transport boundary. A hosted-style API test
   runs without mounted provider configuration, poisons ambient provider
   variables, and proves that local acquisition sends only workload credential
   material to the selected API.
7. **Security.** Canary operator tokens and imported/generated secrets pass
   through fake provider output and failures. Assertions cover process
   arguments, terminal output, structured errors, and API/CLI logs; only the
   credential-save payload may contain workload secret material.
8. **Compatibility.** API integration fixtures load ordinary AWS/GCP stored
   credential rows with no acquisition provenance. They remain selectable and
   usable, and no migration or onboarding cleanup discovers or deletes their
   provider resources.

Before the final candidate that removes the Azure client readiness gate is
merged, it must complete 27 consecutive conclusive live journeys of:

```text
explicit generation -> save -> immediate API bucket operation -> cleanup
```

The journey contains no client readiness probe. Twenty-seven runs give greater
than 95% probability of observing the historical approximately 11% failure mode
if it remains unchanged. Every attempted run is recorded; an unexplained
failure or unconfirmed cleanup is not discarded and does not count as a
success. After qualification, the ordinary live onboarding job remains the
continuous end-to-end check while deterministic tests own the retry branches.

## Required invariants

Each invariant records its current enforcement layer per
[RFC 0025](./0025-enforcement-ledgers.md). Delivery is staged, so each completed
mechanism replaces its corresponding review entry while unfinished portions
remain explicit.

1. API control-plane provider operations use an explicitly selected stored
   credential and never a process-default or ambient provider identity.
   _Enforcement: lint:explicit-api-provider-credentials — API imports of
   registered provider SDK families fail closed at the import declaration;
   type-only imports, named AWS commands, and exact allowlisted helpers remain
   available to call sites, while exact named SDK constructors are confined to
   audited AWS, Azure, and GCP factories that inject credentials after all
   other options; landed and hardened in a later change._
2. Provider CLI operator sessions and their bearer tokens remain in the local
   client and are never credential payload fields or persisted API material.
   _Enforcement: graph:module-ownership:credential-bootstrap.azure-transport.ts — the
   Azure transaction is the sole consumer of its semantic transport, that
   transport is the sole consumer of the argument runner
   (graph:module-ownership:credential-bootstrap.azure-cli-runner.ts), and focused
   tests lock token-free argv and redacted diagnostics; landed earlier, ported
   to the graph in a later change._
3. Azure is the only provider that supports generation, and generation occurs
   only after an explicit interactive confirmation or non-interactive flag.
   _Enforcement: runtime —
   `src/cli/services/credential-onboarding/acquisition.ts` rejects every
   non-Azure generation request and gates interactive Azure mutation on the
   explicit create choice and confirmation; landed in a later change._
4. Import accepts only durable credential material and never turns a temporary
   or indirect source into implicit generation.
   _Enforcement: test — `test/unit/services/slurp/aws.spec.ts` covers static,
   temporary, incomplete, and indirect profile classification, while the
   credential terminal specs prove rejected sources make no provider calls;
   landed in a later change._
5. Every Azure generation attempt is ownership-tagged, reconciles ambiguous
   writes, and rolls back only resources proven to belong to that attempt.
   _Enforcement: test — `test/unit/services/slurp/azure.spec.ts` exercises
   ownership tags, ambiguous-write reconciliation, and guarded rollback through
   the injected transport, while
   `test/unit/services/credential-bootstrap/azure-transport.spec.ts` locks the
   adapter commands; landed in an earlier change and hardened in a later one._
6. Azure compute and storage consumers retry only propagation-shaped
   authorization failures at the consuming API operation. Compute validation,
   runtime storage, and shared-identity role assignment use one bounded policy
   for exact ARM `AuthorizationFailed` and Entra `AADSTS7000215` failures,
   without inferring readiness from credential age or prior authentication.
   Other secret and authorization failures remain terminal, exhaustion is
   declared, and one caller's cancellation does not abort coordinated recovery
   for another caller.
   _Enforcement: test — `test/unit/services/gateways/azure.spec.ts`,
   `test/unit/services/workload-admission-checks.spec.ts`,
   and `test/unit/routes/bucket.spec.ts` cover classification, bounded recovery,
   terminal exceptions, authentication refresh, caller isolation, and the API
   error contract; landed in an earlier change and hardened in two later ones._
7. Saving or probing a credential is never treated as proof that a later
   provider operation is ready. Retry eligibility comes only from the failure
   observed by the consuming operation, not stored lifecycle metadata.
   _Enforcement: test — `test/unit/eslint-plugin/local-plugin.spec.mjs` proves
   the CLI-wide runtime Azure SDK import boundary,
   `test/integration/credentials-onboarding/azure/terminal.spec.ts` saves after
   the generation transaction without a readiness server, and the invariant 6
   API suites own consuming recovery; completed across an earlier change and a later one._
8. Credential acquisition errors and logs expose neither operator tokens nor
   imported or generated secrets.
   _Enforcement: test — the credential terminal specs register AWS, Azure, and
   GCP canary secrets and assert they are absent from output, while Azure
   transport tests cover token-free arguments and redacted failures; completed
   across two later changes._
9. Removing a generation path neither invalidates existing stored credentials
   nor automatically deletes provider resources created by older releases.
   _Enforcement: test — `test/unit/routes/credentials.spec.ts` round-trips
   ordinary pre-existing AWS/GCP rows without provenance, and rejection
   terminal journeys assert zero provider mutation; landed in a later change._

**2 of 9 verified wired, 7 cited, and 0 resting on review**.

## Alternatives considered

### Keep generation for AWS and GCP

Rejected. Import already has the durable material AnyCloud needs. Generation
adds IAM mutation, cleanup, propagation, and permission requirements, while
turning an authenticated dynamic profile into broader creation authority.

### Support ambient/default credentials

Rejected. Local and hosted APIs would resolve different identities from their
hosts, credential selection would no longer name the authority used for a
deployment, and insufficient permissions would surface only during unrelated
provider work. Mounting provider configuration into a local API would not give
the hosted API an equivalent contract.

### Remove Azure generation too

Rejected. An Azure CLI user login cannot be imported as the durable
service-principal secret the API needs. Azure-only explicit generation avoids a
portal/manual detour while preserving the stored-credential runtime model.

### Rewrite Azure generation around SDK clients

Rejected based on a 2026-08-28 read-only transport spike. Both implementations
completed five paired Graph/ARM reads; the SDK probe's median was 1.16 seconds
versus 1.70 seconds for CLI, and it returned a structured
`SubscriptionNotFound` error. The compiler bundled 449 modules for the SDK
lower bound versus one AnyCloud module for the argument-array CLI probe; both
compiled for every release target.

That speed difference is useful but not a reliability result for an infrequent
operation. [`AzureCliCredential`](https://learn.microsoft.com/en-us/javascript/api/%40azure/identity/azureclicredential)
still invokes `az` for operator tokens, Graph creation still needs a separate
generic client or HTTP adapter, and changing transport does not address
authorization propagation. A contained CLI adapter preserves the
operator-token boundary and can provide structured errors without rewriting
the transaction.

### Restore `az ad sp create-for-rbac`

Rejected. The compact command cannot preserve the current ownership tags,
ambiguous-write reconciliation, and ownership-guarded rollback contract. Its
historical path could also continue after an incomplete role assignment.

### Verify readiness while saving

Rejected. Every import shares the save path, a live provider barrier would add
new latency and failure semantics to persistence, and a successful check still
cannot guarantee the next call against a non-monotonic authorization cache.

## Risks and caveats

- Users relying on AWS/GCP `--generate` must provision durable credentials
  outside AnyCloud or import existing static material. The removal therefore
  needs a changelog entry and direct migration guidance.
- Import-only AWS/GCP retains long-lived secrets rather than solving workload
  federation or rotation. OIDC, workload identity federation, and secret
  rotation remain separate designs.
- Azure generation still requires powerful operator permissions and creates a
  long-lived secret. Explicit consent, least privilege, ownership, and rollback
  reduce but do not remove that cost.
- The Azure CLI remains a versioned external dependency for generation. The
  contained transport must preserve useful diagnostics without depending on
  human-formatted output.
- First-use retry mitigates known propagation failures; it does not make broad
  authorization errors retryable or prove every permission a future workload
  may need.
- Existing generated AWS/GCP cloud resources remain the user's responsibility;
  removing the generator does not create a safe basis for discovering and
  deleting historical identities.

## Open questions

None at the policy or qualification level. Retry classifiers, budgets, exact
terminal copy, and test-file layout remain implementation details constrained
by the invariants and verification strategy above.

## Tracking

Accepted and tracked for delivery. An early change completed Azure first-use
recovery, a later one extracted the behavior-preserving `AzureTransport`, and
another contained Azure CLI execution behind argument arrays, typed results,
and bounded redacted failures. A further change applies the acquisition
policy matrix and replaces AWS/GCP generation with durable import-only
onboarding. It also confines credential-bearing API SDK construction to
audited factories and hardens import-fixture permission and propagation
readiness. The final change removes the Azure save-time readiness gate and
the API's credential-evidence gate, extends
bounded consumer recovery to the first-token case found by live qualification,
and keeps that separation enforceable with a CLI-wide runtime Azure SDK import
boundary.

## Decision

Accepted.

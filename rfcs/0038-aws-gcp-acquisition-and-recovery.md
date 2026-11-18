# RFC 0038: Explicit AWS/GCP credential generation

> Status: Accepted
> Date: 2026-09-09
> Updated: 2026-09-14
> Author: Codex draft

## Summary

A customer with an AWS CLI `login_session` and no durable keys had to create an
IAM user, policy, and key externally before successfully importing them. Restore
explicit AWS/GCP provider-CLI generation alongside import and manual entry, so
an authenticated operator can create a distinct workload credential, save it
through the existing API, and use the exact material. Reuse
[credential onboarding](../src/cli/services/credential-onboarding/) and accept
manual reconciliation after interruption or uncertainty.
This decision supersedes only the AWS/GCP generation prohibition in
[RFC 0027](./0027-cloud-credential-acquisition.md). Its import/manual, Azure,
stored-credential, and ambient-identity boundaries remain authoritative.

## Proposal

### Smallest useful release

An authenticated `aws` or `gcloud` operator explicitly creates a workload identity,
saves its credential, and immediately performs an ordinary selected-API operation
with that material. Interactive creation previews and confirms the resolved
account/project, identity, and grants. Non-interactive callers explicitly select
`--provider aws --generate` or `--provider gcp --generate` with an unambiguous
target. Missing fields, failed imports, dynamic AWS profiles, and GCP user ADC
never trigger generation implicitly. Import/manual entry and Azure acquisition
retain RFC 0027's policy.

For AWS, non-interactive generation requires both `--profile` and `--account-id`;
the resolved STS account must match. The interactive generation choice previews
the resolved operator/account before confirmation.
GCP requires `--gcloud-account` and `--project-id`; the wizard can suggest local
configuration values, then previews and confirms the selected account/project.

AWS creates an IAM user, policies, and access key; GCP creates a service account,
project grants, and service-account key. Preserve the generator grants from
pre-removal commit `6b3c2b6c`; the customer's custom policy is not that baseline.
This release excludes durable recovery, S3 lifecycle changes, broad gateway or
transfer rewrites, permission narrowing, runtime refreshable authentication,
and disposable-runner CI migration.

### Simplest implementation

Use the existing save flow in `src/cli/commands/credentials/new.ts` and lease in
`src/cli/services/credential-onboarding/acquired-credential.ts`. Confirmed saving
commits the lease. A definitive rejection permits guarded cleanup; an uncertain
save retains resources for manual reconciliation. GCP's redacted service-account
identity cannot establish which key was saved.

S1's focused correction has landed.
Generated-credential saves disable automatic replay and reconcile the original
failure. A later rejection cannot prove an earlier request did not commit.

S2 and S3 require provider-local CLI adapters with bounded argument-array
execution, structured results, selected operator/target binding, and secret
redaction. Operator sessions stay local; only workload material and non-secret
metadata reach the API. Track immutable identity/resource IDs within the
invocation. Never adopt an existing identity by matching name or blindly repeat
uncertain key issuance. Report known resources when guarded cleanup fails.

AWS CLI mutation subprocesses override inherited retry settings with
`AWS_MAX_ATTEMPTS=1` and `AWS_RETRY_MODE=standard`. A loopback audit
observed three CreateAccessKey requests from one CLI invocation without this
override. Lost creation responses cannot cause replay or name-based adoption. Cleanup
checks account, the immutable UserId returned by CreateUser, and the invocation
marker before destructive phases, then removes only attributed keys and grants.
IAM deletion remains name-addressed; these checks do not provide an atomic lock
against concurrent administrator replacement.

The runner retries only the read operations `GetCallerIdentity`, `GetUser`,
and `ListUserTags`, and the idempotent teardown deletes `DeleteAccessKey`,
`DeleteUserPolicy`, and `DeleteUser`, whose replay after a lost success
answers `NoSuchEntity`, which teardown accepts. Each has at
most three attempts sharing a 60-second deadline for subprocess execution and
backoff. Each subprocess still uses
`AWS_MAX_ATTEMPTS=1`. Only recognized connection failures, throttling, and
temporary service errors permit retry; authentication, permission, invalid
output, and ownership failures remain terminal. Sanitized diagnostics retain
the operation, error category or recognized provider code, attempts, and
elapsed time. CI regressions cover interrupted generation and cleanup reads,
deadline exhaustion, lost teardown-delete responses, and single-dispatch
creation writes.

GCP uses `gcloud` only to obtain the selected operator's local access token;
its provider-local HTTP adapter dispatches each IAM mutation once. A loopback
probe of gcloud 547.0.0 observed repeated key-creation requests from one command.
Live generation also observed new-account read `404/NOT_FOUND` and exact
`400/INVALID_ARGUMENT` grant rejection naming the new account. Only these
visibility failures permit bounded retry (six attempts, 23 seconds of backoff),
with a fresh policy read for rejected grants. Cleanup verifies project number,
returned service-account unique ID, invocation description, and attributed keys
and grants. The key stays in memory until normal encrypted API saving.

Keep the shared `CloudCompute` and `CloudStorage` capability/outcome contracts.
Implement authentication, retry, mutation reconciliation, transfer handling,
and cleanup fixes within the provider only where S2/S3 requires them, using
existing operation budgets. Generic permission denial is not propagation,
and introduced retries cannot replay uncertain
mutations or restart exposed transfers. Credential saving remains persistence,
without a provider-readiness barrier. No new table, API, recovery service, or
shared execution framework is needed; [RFC 0007](./0007-cloud-contracts.md) is
not revised.

The AWS CI journey first failed after saving because S3 returned structured
`InvalidAccessKeyId` for the new key. The focused consumer fix retries only that
code in bucket listing, at most six SDK calls with 23 seconds of application
backoff, carrying the existing request signal through waits and SDK calls. Other permission and
signature failures remain terminal. It adds no fixture wait, save barrier, or
mutation retry; live qualification must still establish the full S2 route.

S4 preserves the canonical GCP proof: without `GCP_API_ENDPOINT`, the tested
default-universe Compute client used a self-signed JWT. Explicit
`https://www.googleapis.com/auth/cloud-platform` scope forced OAuth exchange
and preserved structured HTTP 400 `invalid_grant` / `Invalid JWT Signature.`
failures. The GCP change adds that correction through the installed Compute
SDK and retries only this exact failure in bucket listing (six attempts,
23 seconds of backoff, cancellable waits). Generic permission failures remain
terminal; saving adds no readiness barrier.

### Accepted limitations

Generation requires privileged operator access and creates long-lived secrets.
Interruption or ambiguous mutation/save can leave identities, keys, or grants
for manual inspection and cleanup; report the known target when possible.
Cleanup must not endanger a credential the API may have saved. The runner-loss
proof destroyed the runner-local journal and its recovery information. Provider
markers cannot establish run death or enumerate all dependents, and generated
secrets cannot be retrieved again. Automatic resume, journal reconstruction,
fencing, recovery commands, and independent cleanup services are excluded.
Normal encrypted API credential storage remains the only required secret persistence.

Generation does not create or reconcile S3 buckets. The fresh-process proof
could not distinguish an unconfigured attempt-created bucket from a pre-existing
bucket using `HEAD` after a lost create response. `BucketAlreadyOwnedByYou` is
also insufficient; in `us-east-1`,
[CreateBucket HTTP 200 can reuse an existing bucket and reset its ACLs](https://docs.aws.amazon.com/AmazonS3/latest/API/API_CreateBucket.html#API_CreateBucket_Errors).
These observations cannot authorize adoption, configuration, or cleanup. The
earlier draft's persisted-blocker choice is withdrawn. Arbitrary-name creation
with reservation, reserved-name-only creation, and persisted manual reconciliation
remain separate bucket-lifecycle decisions. This RFC claims no automatic S3
reconciliation or cross-process blocking without durable state.

Revisit automation when a supported customer workflow demonstrates that manual
recovery is insufficient. A demonstrated onboarding blocker needs a focused
fix; a broader bucket/recovery design returns for its own scope decision.
Runner-destruction qualification belongs to such a future proposal.

Evidence comes from historical implementation `d438b21f`, archive `f82bfe6`,
and the preserved Biarritz decision proofs, salvage manifest, GCP-auth,
fresh-process S3, and runner-loss records from 2026-09-09; their scratch paths
are now unavailable. The historical proposal records the customer conversation
reviewed on 2026-09-05; no failed AnyCloud import was observed. These local/loopback
counterexamples are not live qualification. No new exploratory spikes or
historical code transplant are proposed.

## Required invariants

Current enforcement includes merged AWS/save changes and the GCP implementation,
based on `origin/main` at `13c6112db`.
Design acceptance and each provider's live qualification are separate records.

1. Each provider's activation requires human acceptance and its respective
   qualification requirements.
   _Enforcement: review — human acceptance is recorded below. AWS generation
   is already enabled by an earlier merge; there is no runtime qualification gate,
   and real S2 evidence is still missing. The GCP change implements S3/S4;
   real gcloud generation/save/first-use/cleanup passed on 2026-09-14. Its final
   committed-head CI, built-in review, and merge evidence remain outstanding._
2. API provider clients use explicitly selected stored credentials, never an
   ambient identity.
   _Enforcement: lint:explicit-api-provider-credentials — audited provider-client
   factories receive selected credentials separately and inject them
   authoritatively; landed earlier._
3. Generation requires explicit consent for the selected target. Operator
   sessions stay local, and logs and diagnostics never expose secrets.
   _Enforcement: review — AWS target validation, explicit generation dispatch,
   and redacted provider-CLI execution shipped through
   `credential-bootstrap/aws.ts`, `aws-cli-runner.ts`, and the credential save
   command. GCP target validation/consent in `credential-onboarding/acquisition.ts`
   and redacted local authentication in `credential-bootstrap/gcp-cli-runner.ts`
   have focused consent, save-path, and ambient-identity regressions._
4. A committed or uncertain credential save never triggers automatic rollback
   of its generated identity.
   _Enforcement: runtime — `src/cli/commands/credentials/new.ts` disables replay
   for generated saves and reconciles the original failure through the lease;
   an earlier fix landed the correction and real save-path regressions._
5. Generation cleanup removes only resources attributed to this invocation;
   uncertain mutations are not blindly repeated or treated as successful.
   _Enforcement: review — AWS `cleanupAWSGeneration` verifies account, returned
   UserId, invocation marker, and attributed resources; `runAWSCLI` forces one
   attempt for each creation write and replays only idempotent teardown
   deletes. These protections and their regressions shipped earlier. GCP's
   `cleanupGCPGeneration` checks creation-time ownership;
   `gcp-transport.ts` sends each mutation once. Ownership, lost-response, bounded
   visibility retry, and CI sweep regressions cover this boundary._
6. First-use authentication retries are exact and bounded at the consumer;
   canonical default-universe GCP Compute uses explicit OAuth scope and preserves
   structured failures without an endpoint override.
   _Enforcement: review — an earlier change implements and tests AWS's bounded S3
   `InvalidAccessKeyId` retry described above. Real S2 qualification is still
   missing. GCP's provider-client factory now supplies explicit Compute OAuth
   scope; `test/unit/services/gcp-authentication.spec.ts` exercises the actual
   installed Compute and Storage SDKs and consuming gateway, including bounded
   signature retries, cancellation, and terminal unrelated failures._

**1 of 6 verified wired, 1 cited, and 4 resting on review**: invariants 1, 3, 5, and 6.

## Acceptance scenarios

Human acceptance approves this limited design. Activate AWS after S1/S2 and
GCP after S1/S3/S4 are qualified, independently. Each provider's focused cases
cover consent, target binding, redaction, uncertain creation/save, guarded
cleanup, and exact bounded authentication retries; these protections remain
required even when the happy-path journey succeeds.

| ID  | Scenario                                                                                                              | Required result                                                                                                                                                               | Coverage                                                                     |
| --- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| S1  | A save commits but loses its response; a repeated PUT would receive a definitive rejection.                           | Never delete the possibly saved identity. If replay is disabled, assert no second PUT. AWS can reconcile its exact access key; uncertain GCP key identity requires retention. | test:0038/S1 — `test/unit/cli/use-cases/save-credential.spec.ts`; landed     |
| S2  | An AWS `login_session` profile has no durable keys.                                                                   | Complete explicit generation, normal API saving, and an immediate ordinary selected-API operation using the exact newly saved material.                                       | review — missing                                                             |
| S3  | A logged-in `gcloud` operator needs a workload credential.                                                            | Complete explicit generation, normal API saving, and an immediate ordinary selected-API operation using the exact newly saved material.                                       | review — real operator journey passed 2026-09-14; final evidence outstanding |
| S4  | Canonical default-universe GCP Compute authentication, without `GCP_API_ENDPOINT`, receives an invalid-grant failure. | Use explicit OAuth scope and preserve structured failure details through the actual installed SDK and consuming path.                                                         | test:0038/S4 — `test/unit/services/gcp-authentication.spec.ts`               |

Exercise the actual authentication route and fresh credentials early in the
provider implementation. Declare the operation's permissions and workload
prerequisites: GCP controller grants do not automatically give a VM service
account bucket access. Passing mocks, warm resources, skips, or administrator
rescue cannot qualify an unexercised path. Broader operation coverage and
recovery after runner destruction are not first-release requirements.

Each provider adds automatic live generation coverage to its existing trusted-PR
onboarding CI job while retaining import coverage. Exercise the product's
generation, normal saving, and an immediate ordinary API operation with the exact
saved credential, without fixture readiness waits or administrator repair.
CI bootstrap authentication does not replace the real AWS `login_session` or GCP
operator-route qualification. AWS also runs installed-CLI loopback regressions
for mutation retries and lost responses. Both providers' generation teardown uses a
non-secret creation-time ownership record. GCP's before/after sweeps exclude
its namespace and invocation markers; AWS's onboarding sweep also deletes
exact `anycloud-onb-gen-<uuid>` users carrying an invocation marker, which a
teardown that failed left behind. Missing records require manual
reconciliation, not name-based reconstruction or a recovery service.
GCP's live generation case is in the existing
`test/integration/credentials-onboarding/gcp/live.spec.ts` job, alongside import.
Its first operation is `storage.buckets.list`; it verifies that the saved key's
fingerprint matches the key-creation response, without a fixture readiness wait.
The test recorder persists only non-secret ownership evidence for that invocation.

## Alternatives / open questions

| Option                                                        | Decision                                                                                                                                                          |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Retain RFC 0027's import/manual-only policy                   | Avoids identity creation costs but preserves the external provisioning detour for users with only an operator login. Not selected.                                |
| Explicit provider-CLI generation with existing save contracts | Selected. Delivers the requested workflow with local provider adapters and explicit manual handling of uncertain outcomes.                                        |
| Provider-native refreshable authentication                    | Defer. Requires a selected runtime identity reference, refresh sources, and trust/revocation behavior; it is a different capability from generating a stored key. |
| General durable recovery subsystem                            | Exclude from this MVP. It adds persistent state, APIs, liveness coordination, and operator obligations beyond the chosen manual failure contract.                 |

AWS and GCP implementation proceed independently.

## Tracking

Delivery status and qualification evidence are tracked through three work
streams:

- Shared save-safety fix: closed by an earlier merge.
- AWS generation. The implementation and a
  login-cache regression follow-up
  are merged. Real `login_session` qualification remains outstanding;
  CI bootstrap credentials and synthetic-cache tests do not establish it.
- GCP generation, including canonical OAuth. The implementation
  includes the independent GCP generation/save/first-use journey and OAuth regression.

The shared save dependency is satisfied. Both provider issues own their complete
generation/save/first-use journeys. The RFC retains the decision and scope;
issues record implementation progress. Broader review findings return here for
a scope decision rather than automatically expanding a child issue.
An earlier PR is paused and
excluded; its historical recovery roadmap is superseded by this MVP scope.
Publishing the backlog, implementing a provider, or passing review does not
establish live qualification.

## Decision

Accepted on 2026-09-14 by depombo in Conductor: “go ahead with 1” approved the
step to record explicit acceptance of RFC 0038, qualify the real AWS
`login_session` generation/save/API-use/cleanup journey, and then close out that work.
This approves restoring explicit AWS/GCP generation with the existing save/lease
model, focused consumer fixes, and manual handling of interruption and uncertainty.
It supersedes only RFC 0027's AWS/GCP generation prohibition. Durable recovery,
S3 lifecycle redesign, broad gateway or transfer rewrites, permission narrowing,
and CI migration remain excluded.

Acceptance approves the design; it does not assert that an unexercised provider
route is qualified. AWS S2 and GCP S3/S4 retain their independent requirements.

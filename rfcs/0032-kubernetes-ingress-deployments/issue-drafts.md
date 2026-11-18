# RFC 0032 implementation issues

These six issue bodies implement the delivery breakdown in
[RFC 0032](../0032-kubernetes-ingress-deployments.md) as sub-issues of a parent
task. The parent and its
sub-issues are assigned to the
[Anycloud Releases project](https://github.com/orgs/anycloud-sh/projects/3),
iteration **0.1.65**. A–F are the local identifiers mapped to those issues below.
The published issues link the immutable proposed RFC revision
until the contract lands.
GitHub issues own implementation progress; this file records the published scope.
All priorities remain **Untriaged**, and the iteration target preserves the
qualification and checkpoint prerequisites.

The preferred candidate is Traefik with Gateway API, cert-manager with Let's
Encrypt DNS-01, a provider L4 load balancer passing TLS through to Traefik,
Cloudflare Full (strict), and Flannel WireGuard for cross-node Pod traffic.
A qualifies one managed provider; the candidate is not yet supported or shipped.
Anycloud remains authoritative for desired Service and Cluster configuration;
native resources are generated runtime details and cert-manager owns certificate
material and renewal.

The separate Kubernetes Service bucket-sync investigation supplies the
checkpoint decision. Its issue/result URL is still unknown; link that decision
before C starts. An earlier merged change
is the VM credential-renewal foundation, not that decision.

## Dependencies and release boundary

| Issue | Type           | Depends on                                           | Completion enables              |
| ----- | -------------- | ---------------------------------------------------- | ------------------------------- |
| A     | Investigation  | Existing managed Cluster substrate                   | B and the networking input to C |
| B     | Change request | A's selected configuration and evidence              | C                               |
| C     | Change request | A, B, and the separate checkpoint decision           | D                               |
| D     | Change request | C                                                    | E and final behavior for F      |
| E     | Change request | B, C, D, and coordinated shared-harness changes      | Release qualification           |
| F     | Change request | C/D for drafting; E before publishing release claims | User and operator documentation |

The known issue prerequisites are also recorded as GitHub blocking dependencies.
F can be drafted after C/D define behavior, but E blocks its release claims.

Networking/TLS qualification includes provider load-balancer integration, DNS
authorization and challenge issuance, and scoped Cloudflare settings that
preserve existing VM Services. B owns that infrastructure implementation; A's
experiment is evidence rather than an implicit production integration.

The runtime and operations drafts own product integration of the accepted
checkpoint design, including required Cluster storage support. The investigation
does not implicitly supply that implementation. A and B can proceed while the
checkpoint investigation is separate; C cannot assume its outcome.

Intermediate implementation PRs must preserve unsupported admission until the
complete Service lifecycle can be released with its qualification and
documentation. Each resource-creating change includes cleanup of its own partial
failures; D completes lifecycle cleanup rather than making earlier leaks acceptable.

New tests use the constrained fixture and native observations. Coordinate shared
fixture, observation, cleanup, registration, and workflow edits with
the Bash-retirement migration,
the shared integration work, and
the queued provider-boundary work.
Use the agreed combined handoff and interfaces without restarting active
campaigns. Isolated design and product work need not wait for final Bash
retirement. Existing VM-host Service migration membership and evidence remain
separate from this new Kubernetes feature.

<span id="a-qualify-managed-cluster-service-ingress-and-networking"></span>

## A. Qualify conventional Kubernetes ingress and TLS on one managed provider

Template: Investigation. Depends on: existing managed Cluster substrate.

### Question

Can RFC 0032's preferred conventional stack deliver verified origin TLS,
encrypted cross-node Pod traffic, and a stable public URL on one managed
provider while Anycloud retains desired configuration authority? Qualify Traefik
with Gateway API, cert-manager with Let's Encrypt DNS-01, a provider L4 load
balancer passing TLS through to Traefik, Cloudflare Full (strict), and Flannel
WireGuard. Current jobs-only capacity has neither this networking contract nor a
qualified provider load-balancer integration.
Sources: [RFC ingress/TLS profile](https://github.com/anycloud-sh/anycloud/blob/main/rfcs/0032-kubernetes-ingress-deployments.md#preferred-ingress-and-tls-profile),
[configuration authority](https://github.com/anycloud-sh/anycloud/blob/main/rfcs/0032-kubernetes-ingress-deployments.md#status-and-authority),
[managed Cluster design](https://github.com/anycloud-sh/anycloud/blob/main/rfcs/0015-anycloud-managed-kubernetes-clusters.md), and
[jobs-only networking](https://github.com/anycloud-sh/anycloud/blob/main/rfcs/0033-peer-networkless-jobs-capacity.md).

### Smallest check

- Select one initial provider and pin k3s, Gateway API CRDs, Traefik, cert-manager,
  and its load-balancer integration. Record compute/gateway capacity, replicas,
  network rules, WireGuard kernel requirements, controller credentials, recurring
  cost, quotas, and the actual TLS passthrough path. Preserve private capacity
  Nodes; installing a native `LoadBalancer` Service or enabling k3s ServiceLB is
  not evidence of provider integration.
- Assign installation, reconciliation, DNS, TLS, renewal, and cleanup ownership.
  Desired Service and Cluster configuration stays in Anycloud; native manifests
  and certificate material have the RFC's distinct owners. Define capability
  checks before admission and per-Service DNS/certificate/route readiness after
  admission, including namespace, RBAC, and gateway/certificate reference rules,
  without introducing a public Kubernetes configuration interface.
- Specify the stable address and DNS record type, including hostname-valued
  provider endpoints. Qualify stable owner/Service identity and concurrent
  hostname claims, then select isolated DNS-01 delegation or an authorized
  central challenge service. Reject issuance for unowned names. Keep shared-zone
  credentials and shared wildcard keys outside customer Clusters, and issuer
  credentials/gateway keys out of application Pods. Name any existing DNS
  authorization changes required before B can expose this capability.
- Qualify ACME account ownership, reusable authorizations, outstanding
  certificates, and hostname retention/handoff. Removing DNS challenge access
  or deleting a Secret alone is not evidence that a name can be reassigned
  safely; retain the reservation until the selected policy permits release.
- Demonstrate scoped Full (strict), edge HTTP redirection, and certificate
  validation without changing existing VM Service behavior. Record policy
  limits and cleanup. Use disposable test hostnames; a zone-wide mode change
  that breaks existing origins is not a qualifying result.
- Run two HTTP fixtures sharing the gateway on a disposable managed Cluster
  with enough Nodes to exercise cross-node routing and DNS. Show a stable HTTPS
  hostname across Pod replacement without pointing DNS at the application Pod.
  Observe synthetic request traffic on the inter-node network before and after
  Pod movement to prove WireGuard encryption on the actual backend path.
- Verify missing, untrusted, expired, and wrong-host origin certificates fail
  without HTTP fallback or SSL-mode downgrade. Exercise certificate renewal/key
  rotation and Traefik Secret reload without changing the application revision;
  record issuer-outage observation, retry, and expiry behavior.
- Exercise slow startup, failed readiness, and bounded shutdown. Record the
  application readiness signal, startup allowance, termination grace period,
  and gateway behavior for requests already in flight. Demonstrate the policy
  for ordinary requests, SSE, and WebSockets rather than assuming endpoint
  withdrawal is instantaneous.
- Exercise gateway/controller restart and partial provider load-balancer
  provisioning/deletion. Delete one fixture and verify the other still serves;
  finish with an ownership-scoped inventory of native, provider, DNS, edge, and
  challenge resources. Prevent stale issuance after hostname ownership changes.
- Keep temporary proof code in `experiments/` with promotion/deletion criteria,
  test fixtures in `test/`, and evidence tied to exact versions and configuration.
  This investigation does not repeat the checkpoint spike or qualify every cloud.

### Decision

Proceed only with a documented qualified configuration and observed evidence
for RFC scenarios S9, S12, S13, S15, and S20–S25. Record the provider, exact
versions, ownership model, limits, and evidence in the RFC before B/C rely on
them. A failed or unavailable prerequisite remains failed or incomplete. If the
preferred candidate is blocked, document the cause and amend the RFC before
substituting Tunnel, Origin CA, another controller, or another ingress path.

### Priority and rationale

Untriaged; a design prerequisite, with no requested scheduling priority.

## B. Implement Service-capable managed Cluster networking

Template: Change request. Depends on: A.

### Problem

Jobs-only Clusters intentionally omit peer routing and cluster DNS guarantees
needed by Services. The preferred stack also needs provider load-balancer,
gateway, certificate, DNS authorization, and edge integrations. Shared
infrastructure needs a Cluster owner and admission capability.
Sources: [RFC networking contract](https://github.com/anycloud-sh/anycloud/blob/main/rfcs/0032-kubernetes-ingress-deployments.md#cluster-networking)
and [ingress/TLS profile](https://github.com/anycloud-sh/anycloud/blob/main/rfcs/0032-kubernetes-ingress-deployments.md#preferred-ingress-and-tls-profile),
plus [RFC 0033](https://github.com/anycloud-sh/anycloud/blob/main/rfcs/0033-peer-networkless-jobs-capacity.md).

### Smallest useful outcome

Implement A's qualified configuration through the existing managed Cluster
lifecycle: WireGuard Pod networking, cluster DNS, shared Traefik Gateway,
provider L4 load balancer, cert-manager/issuer infrastructure, and the authorized
DNS/challenge/scoped-edge integration. Expose the qualified capability to Service
admission.
Keep existing jobs-only Clusters on their existing contract. Attached Clusters
and unqualified provider/networking combinations remain outside this issue.

### Done when

- Cluster-owned installation, reconciliation, recovery, and cleanup implement
  the selected ownership model, including cleanup after partial provisioning.
  Anycloud owns desired Cluster configuration; native controllers reconcile
  runtime state without becoming a separate user configuration API.
- Implement the provider controller, private target/network rules, stable
  address discovery and DNS record support, and TCP 443 passthrough qualified
  in A. Keep exact versions/configuration and ownership observable; prevent
  competing load-balancer controllers from managing the same resources.
- Implement A's central DNS authorization and isolated challenge path, including
  required hostname-claim hardening. Enforce stable ownership for concurrent
  claims, issuance, renewal, and cleanup. Ship required central integration
  before advertising capability; customer Clusters hold no shared-zone token or
  shared wildcard key, and application Pods have no issuer/gateway credentials.
- Reconcile scoped Full (strict) and edge HTTP redirection within A's qualified
  limits. Existing VM endpoints keep working. Certificate failure never enables
  HTTP fallback or weaker validation. cert-manager renewal and Traefik reload
  work independently of application revision changes.
- Cross-node traffic and DNS work on the supported configuration; capability
  checks distinguish missing network, ingress, and TLS prerequisites. Tier
  labels alone do not imply a usable public endpoint.
- Service admission can reject unsupported Clusters before Service persistence
  or resource creation. Existing jobs-only admission and Node readiness do not
  begin depending on Service networking, DNS, gateway, or certificate health.
- Tests cover cross-node routing/encryption, issuer and gateway recovery, provider
  partial failures, DNS authorization, shared infrastructure ownership, scoped
  edge compatibility, and jobs-only regressions (S8–S10 and S20–S25).
- Document configuration/enablement and compatibility consequences from A;
  do not silently convert existing jobs-only Clusters to the new configuration.

### Priority and rationale

Untriaged; implementation follows the qualified design in A.

## C. Add Cluster placement and native execution for Services

Template: Change request. Depends on: A,
B, and the linked checkpoint decision.

### Problem

The Service runtime currently selects VM-host execution, and upgrade validation
still constructs Docker commands. Users need Cluster placement while retaining
an ordinary Service Workload and a consistent configuration owner.
Sources: [RFC native execution](https://github.com/anycloud-sh/anycloud/blob/main/rfcs/0032-kubernetes-ingress-deployments.md#native-execution-and-shared-machinery),
[Service runtime](https://github.com/anycloud-sh/anycloud/blob/main/src/api/services/serve/runtime.ts), and
[upgrade domain](https://github.com/anycloud-sh/anycloud/blob/main/src/api/services/service-upgrade-domain.ts).

### Smallest useful outcome

Add the canonical Service admission/API, CLI `--cluster`, and Python
`serve(..., cluster=...)` path for qualified managed Clusters. Reconcile one
native Kubernetes Deployment, one stable native Service, an HTTPRoute through
the shared Gateway, and an owned hostname-specific Certificate resource.
Anycloud retains desired configuration and revision authority; native resources
remain runtime details and cert-manager owns keys and renewal. Implement the
accepted storage prerequisites, restore, periodic sync, and scoped credential
renewal without imposing them on stateless Services. D completes
upgrade/termination finalization.

### Done when

- CLI and Python admission create a Service Workload with one warm replica and
  `$PORT`, not a Deployment record. Generated interfaces follow the repository's
  canonical API contract. Reject attached Clusters, incompatible placement or
  VM-only options, and missing capabilities before persisting Service intent.
- Shared validation and configuration remain outside the runtime-specific
  Docker/VM logic. Reuse Cluster connections, Pod parts, deterministic native
  identity, apply, and cleanup helpers without adopting targeted-Job protocols.
- Existing Anycloud interfaces remain authoritative for image, command,
  environment/secret references, resources, placement, revision, permissions,
  and intent. Render owned native specifications from that configuration;
  observed native changes never replace it. Reconcile only owned desired fields
  and preserve controller-managed status and renewed certificate material (S5).
- The Pod template implements A's startup/readiness policy. Status distinguishes
  scheduling, startup, and routing blocks; probes and EndpointSlices determine
  traffic eligibility. Partial resource creation has owned cleanup.
- Own each Service's HTTPRoute, Certificate, dedicated TLS Secret, and authorized
  DNS/challenge bindings under A's namespace/reference rules. DNS/certificate/route
  provisioning may remain pending after admission; explain the block and require
  the requested ready application revision and verified public HTTPS before
  reporting readiness. Do not expose gateway keys to application Pods (S20/S23).
- The separate checkpoint decision is linked and its required Cluster storage
  support and credential integration are implemented and tested. Long-lived
  compute/storage credentials are not exposed to application Pods. Existing
  VM checkpoint behavior remains intact.
- Application revisions and routing remain separate from Service identity;
  applying the same desired revision is idempotent. Do not add replica controls,
  a public native-object API, or Kubernetes-owned configuration authority.
- Focused tests cover S1, S4, S5, S8, S12, S20/S23, and the startup/renewal
  portions of S19.
  Existing VM Service admission and Kubernetes Deployment/Job behavior pass
  the relevant regressions.

### Priority and rationale

Untriaged; blocked on the networking prerequisites and checkpoint decision.

## D. Complete Kubernetes Service upgrades and operations

Template: Change request. Depends on: C
and its accepted storage integration.

### Problem

The VM Service lifecycle assumes host replacement. The Kubernetes path must
upgrade application revisions and recover partial operations while retaining
Service identity, routing, checkpoint guarantees, and shared infrastructure.
Sources: [RFC upgrades](https://github.com/anycloud-sh/anycloud/blob/main/rfcs/0032-kubernetes-ingress-deployments.md#upgrades-on-the-existing-cluster),
[cleanup](https://github.com/anycloud-sh/anycloud/blob/main/rfcs/0032-kubernetes-ingress-deployments.md#ownership-and-recoverable-cleanup),
and [checkpoint boundary](https://github.com/anycloud-sh/anycloud/blob/main/rfcs/0032-kubernetes-ingress-deployments.md#checkpoint-integration-boundary).

### Smallest useful outcome

Implement ordinary upgrade, status, wait, logs, termination, and deletion for the
native runtime. Persist revision and cleanup intent, reconcile native resources,
and resume after API restart. V1 uses `Recreate` with accepted downtime and
without provisioning replacement capacity solely to change the application.

### Done when

- Validate a new revision before disturbing the serving one. Update the native
  Kubernetes Deployment's Pod template while retaining its identity, the native
  Service, HTTPRoute, DNS, and Certificate resource identities. Normal
  certificate/key renewal remains independent of the application revision.
  A stateless upgrade succeeds with resources for one application Pod and no
  spare allocation (S3/S11).
- Completion requires the requested revision/generation, application readiness,
  and verified public HTTPS. Expose certificate/route/issuer failures alongside
  application failures without weakening transport. Stale observations, failed
  image pulls, exhausted startup allowance, and scheduling failures cannot report
  success. Preserve existing public lifecycle states and expose actionable
  reasons (S2/S12/S18).
- Apply the qualified finite drain policy. Record the behavior of requests and
  long-lived connections during termination; do not promise instantaneous
  routing withdrawal, zero downtime, or automatic rollback (S13).
- Native controllers replace a deleted stateless application Pod while the API
  is unavailable. API restart, a lost apply response, and interrupted cleanup
  resume without duplicate resources or stale writes overriding termination
  or a newer revision (S14/S16).
- Implement the accepted checkpoint finalization, writer handoff, and retention
  mechanism. Failed upload blocks destructive replacement and storage cleanup;
  restarting the API resumes safely. A shutdown timeout is not proof of a
  successful upload (S19).
- Use native garbage collection for native dependents and owner/UID checks for
  explicit deletion. Confirm cleanup before completing deletion; preserve
  another Service, shared gateways, Cluster capacity, operator certificates,
  and user-owned buckets, including same-name ownership collisions (S15/S17).
- Stop owned certificate issuance and remove challenge grants before releasing
  hostname ownership under A's ACME authorization and retention/handoff policy.
  Resume interrupted native and external cleanup without letting stale work
  issue certificates or alter DNS for a new owner. Preserve shared load
  balancers, issuer infrastructure, and another Service's scoped edge
  configuration (S23/S25).
- Public HTTPS and diagnostic access follow the intended revision, and manual
  recovery from a failed revision is documented using supported operations.
  Existing VM Service upgrade and cleanup regressions pass (S2/S20).

### Priority and rationale

Untriaged; required to complete the existing Service lifecycle on the new substrate.

## E. Qualify the managed-Cluster Service lifecycle

Template: Change request. Depends on: B,
C,
D, and coordinated fixture interfaces.

### Problem

Current Service migration coverage targets VM hosts. Native resources and shared
Cluster infrastructure require their own observations and cleanup evidence while
the same public Service behavior remains covered.
Sources: [RFC acceptance scenarios](https://github.com/anycloud-sh/anycloud/blob/main/rfcs/0032-kubernetes-ingress-deployments.md#acceptance-scenarios),
[constrained fixture](https://github.com/anycloud-sh/anycloud/blob/main/test/integration/e2e/README.md), and
migration integration.

### Smallest useful outcome

Extend the shared Service lifecycle through a native Kubernetes adapter and
qualify the supported configuration selected in A. Keep temporary networking
proofs separate from permanent product tests and preserve existing VM-host
coverage and migration evidence.

### Done when

- Use the constrained fixture, tracked Service/Cluster identities, native
  resource observations, and ownership-scoped cleanup. Shared contracts have
  no new provider-name branches; coordinate shared changes through the shared
  integration and the agreed provider-boundary interfaces. Place tests in
  `test/`, not `scripts/`.
- Cover every active RFC scenario with named `0032/S<id>` tests and update the
  RFC coverage cells to the actual tests. S6/S7 stay deferred. Demonstrate CLI
  and Python admission, standard operations, stable HTTPS upgrades, and failure
  reporting rather than only checking that manifests were accepted.
- Show that API/CLI/Python configuration produces the intended native resources
  while native drift and controller observations do not become authoritative
  Service/Cluster configuration. Certificate renewal must not require an
  application configuration or revision change (S5/S22).
- Prove constrained-capacity upgrade, slow/failed startup, bounded drain,
  cross-node routing/DNS, API-unavailable Pod replacement, interrupted
  reconciliation, and ownership-safe cleanup with another Service still live.
- Cover L4 TLS passthrough, invalid-origin-certificate rejection, no plaintext
  fallback, edge redirects, and coexistence with existing VM endpoints. Exercise
  certificate renewal/rotation/reload and issuer outage/retry. Prove rejected
  unowned hostname requests, concurrent claims, credential isolation, and
  cleanup across ownership changes, including authorization reuse and the
  required hostname retention/handoff (S21–S23).
- Observe synthetic request traffic on the inter-node network before/after Pod
  movement to verify encryption on the actual backend path. Exercise gateway
  and controller restart, partial load-balancer provisioning/cleanup, and a
  broken encrypted path without insecure fallback (S24/S25). Infrastructure
  qualification does not imply a highly available single-replica application.
- Include the selected checkpoint mechanism's restore, renewal, successful
  finalization, failed-flush retention, and restarted-coordinator behavior.
  Storage-investigation results alone do not qualify product integration.
- Run focused local coverage and the selected managed-cloud profiles. Claims
  of GPU-constrained behavior require evidence on that resource profile; CPU
  coverage does not silently qualify every accelerator or provider.
- Run affected VM Service and Kubernetes Deployment/Job regressions, relevant
  typechecks, `yarn verify`, and applicable CI. Preserve failed attempts and
  cleanup evidence; missing credentials/capacity are failures, not skipped tests.
- Keep current Bash authority and retirement obligations unchanged. This new
  feature neither advances old migration counts nor blocks final migration
  cleanup on delivering Kubernetes Services.

### Priority and rationale

Untriaged; required before claiming the complete supported lifecycle.

## F. Document managed-Cluster Services and upgrade behavior

Template: Change request. Depends on: C
and D for behavior;
E before release claims.

### Problem

The existing shipped Service documentation describes VM-host placement. Users
and operators need accurate instructions for the newly qualified Cluster path,
particularly upgrades, capability requirements, and failure recovery.
Sources: [RFC scope](https://github.com/anycloud-sh/anycloud/blob/main/rfcs/0032-kubernetes-ingress-deployments.md),
[current Service guide](https://github.com/anycloud-sh/anycloud/blob/main/docs/platform/services.md), and
[documentation ownership](https://github.com/anycloud-sh/anycloud/blob/main/CONTRIBUTING.md#documentation).

### Smallest useful outcome

Update architecture, Service/Cluster guides, CLI/Python references, and release
guidance to describe only the implementation qualified by E. Preserve the
distinction between a Service Workload, a Deployment record, and native objects.

### Done when

- Show CLI `--cluster`, Python `serve(..., cluster=...)`, ordinary operations,
  and the qualified managed Cluster configuration. Explain unsupported attached
  Clusters and the explicit capability/enablement prerequisites.
- State that desired Service and Cluster configuration stays in Anycloud and
  native objects remain runtime details. Distinguish application configuration,
  Cluster infrastructure settings, controller observations, and cert-manager's
  certificate material/renewal. Users configure Services through the existing
  interfaces rather than authoring Gateway or Certificate manifests.
- Explain that upgrades preserve Service ID, HTTPS URL, and Cluster placement
  while replacing the Pod with downtime and without requiring a second
  application replica. Document readiness, bounded shutdown, failed-rollout
  diagnosis/recovery, and the absence of an automatic rollback promise.
- Document the accepted checkpoint contract, credential renewal and API
  availability implications, failed-flush retention/retry, and any required
  storage/operator actions. State only the cross-cloud guarantees proved by
  the storage decision and product qualification.
- Record the qualified provider, component versions, provider integration,
  recurring cost, and configuration limits. Explain the TLS termination points,
  WireGuard transport boundary, scoped edge settings, isolated challenge path,
  certificate renewal/failure recovery, and shared-resource cleanup ownership.
  State the remaining host trust boundary and the separate VM origin TLS work.
  Keep blue/green, canaries, replica controls, autoscaling, and scale-to-zero
  explicitly deferred.
- Update the architecture and RFC tracking/coverage as implementation ships.
  Add a PR-numbered changelog entry for the material product release; the
  present RFC and draft-only change receives no entry. Preserve frozen release
  snapshots for functional additions.
- Run Prettier and relevant documentation/release checks; validate examples
  against the supported CLI and generated Python interfaces from C/D.

### Priority and rationale

Untriaged; documentation must accompany the qualified product release.

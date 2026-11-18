# RFC 0033: Peer-networkless jobs capacity

> Status: Accepted
> Date: 2026-09-01
> Author: Claude draft
> Depends on: RFC 0015 (amends its capacity-networking outcome); RFC 0029's
> Kubernetes Deployment candidate for Jobs (consumer of the workload DNS contract); RFC 0032
> (restoration home for the removed design).
> Number claim: 0031 is claimed by the in-flight teardown-provenance draft and
> 0032 by the cluster-backed Services draft.

## Summary

A jobs-only managed Kubernetes cluster requires no node-to-node connectivity:
agents join the control plane over an outbound-only reverse tunnel, targeted
Jobs are selected through a pull-based next-Job API call from the Pod, and RFC 0029's
Kubernetes model has no cluster Services to resolve. This RFC removes the
peer-connectivity half of RFC 0015's shipped capacity networking — the
scope-peer firewall rules, the cross-node CoreDNS readiness gate, and the
`ClusterFirst` DNS dependency — while keeping the isolation half unchanged.
Jobs capacity becomes one uniform shape on every provider: an outbound-
connected VM. Providers without private-network primitives become admissible
jobs capacity without any overlay or peer firewall work.

## Context / problem

RFC 0015 shipped managed cluster capacity with a scope-peer network intent:
`peerIngress` rules admitting UDP 8472 (flannel VXLAN) and TCP 10250 (kubelet
and metrics) between VMs attached to the same cloud-resource scope, mapped to
an AWS scope security group, an Azure scope VNet/NSG, and GCP scope network
tags. Its readiness contract keeps CoreDNS replicas Ready on distinct
capacity Nodes, and its qualification asserts cross-node Pod, Service, DNS,
logs, and exec traffic. One goal required every supporting gateway to supply
"an isolated private peer network."

The jobs-only narrowing of RFC 0029 makes that machinery vestigial on the
active path. Walking a jobs Deployment's traffic:

- **Control plane to node** rides the k3s agent's outbound websocket tunnel;
  the server never dials the agent. RFC 0015 already relies on this.
- **Getting work** is a Pod-initiated call to the Anycloud API; next-Job
  selection, outcomes, and cancellation all travel outbound.
- **Doing work** — image pulls, application stores, buckets — is outbound.
- **Serving traffic** does not exist: RFC 0029 Deployments accept Jobs only. RFC
  0032 separately owns cluster-backed Services and their networking.

The two peer rules therefore carry only incidental traffic: cluster DNS
forwarding external lookups through a CoreDNS Pod that may sit on another
node, and a kubelet port with no consumer at all — the control-plane
configuration already disables metrics-server. Keeping the rules provisioned
while unused makes them read as load-bearing, keeps a provider-capability
requirement alive for workloads that do not need it, and forks jobs capacity
into peer-capable and peer-incapable shapes for no workload reason.

## Proposal

### Capacity connectivity tiers

Node-to-node connectivity becomes a declared capacity capability consumed at
admission, not a universal cluster property:

```text
tier none          no peer connectivity provisioned or required; jobs mode
tier private-peer  provider private network + peer rules (RFC 0032 restores)
tier overlay       encrypted WireGuard mesh over public addresses (RFC 0032)
```

A fabric tier for gang data planes is reserved for future multi-node RFCs.
Every managed jobs cluster provisions tier `none`. No tier column or schema
is added: until RFC 0032 is implemented there is exactly one tier, and the
vocabulary lives in admission logic and documentation.

Tier `none` is a provisioning contract, not a guarantee of physical
isolation between a cluster's own nodes: Anycloud opens no peer paths and
workloads must not depend on any, while whether cross-node traffic is
additionally blocked depends on the provider substrate (see "Effective
connectivity after removal").

### Removed from the active path

- The `peerIngress` request for cluster capacity: managed clusters stop
  opening UDP 8472 and TCP 10250 between scope peers on every provider.
- The provider-neutral `PeerIngressRule` intent and its per-gateway mappings.
  The design is parked verbatim in RFC 0032.
- The CoreDNS distinct-node readiness gate. Cluster readiness derives from
  signals a tier-`none` cluster can honestly provide: registered capacity
  Nodes Ready and schedulable. Cross-node DNS ceases to be a health input.
- Cross-node assertions in the managed-cluster qualification. The rewritten
  qualification proves outbound-only join, Node readiness, a scheduled
  single-node Pod, and external name resolution through the node resolver.

Flannel remains installed for node-local Pod networking; its cross-node
routes are simply never opened. Metrics collection is not a readiness or
scaling input — RFC 0030 scales from durable backlog, and the control plane
already ships with metrics-server disabled, so nothing scrapes 10250 today.

### Kept unchanged

- The isolation half of RFC 0015's network boundary: the scoped network with
  no public ingress on capacity VMs, idempotent preparation before VM
  creation, and teardown after every VM is confirmed ended. On providers with
  private-network primitives, capacity VMs continue to live in a
  scope-specific network that admits nothing.
- The stable public control-plane join endpoint, its TLS identity rules, and
  the agent reverse tunnel.
- The `vms` ledger, capacity reconciler, and RFC 0048's seam.

Two shipped couplings key the isolation half on peer-rule presence and must
be re-keyed rather than deleted with it: the AWS gateway selects the scoped
security group only when peer rules are present (falling back to the shared
VM group otherwise), and the shared firewall planner emits GCP's public-deny
pair only when peer rules exist. The removal keys the scoped group on the
resource scope and the deny pair on an explicit no-public-ingress intent so
both survive with empty peer rules. On GCP the deny pair is the entire
isolation mechanism, and its rule names are retained so re-preparation of
existing scopes stays idempotent.

### Effective connectivity after removal

Removing the peer rules yields one provisioning intent everywhere but
different effective node-to-node connectivity per substrate:

- **AWS**: the scoped security group carries no peer rules, and security
  groups are default-deny, so cross-node traffic is physically blocked.
- **GCP**: the scope network's deny pair remains, so cross-node traffic is
  physically blocked.
- **Azure**: the scope NSG denies public ingress, but the platform's
  built-in `AllowVNetInBound` rule keeps VMs in the scope VNet mutually
  reachable. No higher-priority deny is added: blocking same-tenant
  intra-scope traffic has no threat-model payoff and would churn
  qualification for a boundary no workload may depend on.
- **Local acceptance substrate**: capacity nodes share one Docker bridge
  network, so node-to-node traffic stays open.

Physical absence of cross-node connectivity is therefore enforced only on
AWS and GCP capacity legs; Azure and the local substrate prove the
provisioning contract, not the physical boundary.

### Workload DNS contract

Workload paths that author Pod templates for tier-`none` clusters must set
`dnsPolicy: Default` so Pods resolve external names through the node resolver.
Cluster DNS is not part of the Deployment contract. The RFC 0029 Deployment builder
inherits this setting from shared Pod construction, and the managed-cluster E2E
contract runs a resolution-only Job to completion as standing evidence.

### Gateway admission

The RFC 0015 goal "support the same managed-capacity lifecycle on every cloud
gateway that can supply an isolated private peer network" is superseded for
jobs capacity: the requirement becomes the ability to create an
outbound-connected VM and, where the provider offers network primitives, the
isolation scope. Providers without private-network primitives — account-global
firewalls, unavoidable public addresses — are no longer structurally excluded.
Enabling any specific new gateway for cluster capacity remains separate work
with its own qualification.

### RFC 0015 amendment

RFC 0015 remains Accepted; its record gains an outcome note and change-log
entry pointing here when the removal ships. This RFC, not an edit to 0015's
accepted design sections, is the decision record for the removal.

## Decision requirements

**R1 — One jobs-capacity shape.** After removal, managed jobs clusters
request identical network intent on every supporting provider: isolation
scope where available, no peer rules anywhere. Identical intent does not
promise identical effective connectivity; the per-substrate outcome is
recorded in "Effective connectivity after removal".

**R2 — Do not regress isolation.** Providers with private-network primitives
keep the no-public-ingress scope network and its lifecycle unchanged.

**R3 — No hidden cross-node dependency.** The jobs workload contract must not
depend on cross-node reachability. Physical enforcement exists only where
the substrate blocks cross-node traffic — AWS and GCP capacity legs — while
Azure and the local substrate leave node-to-node open, so acceptance
evidence must include at least one qualification run with aws or gcp
capacity, where any hidden dependency fails rather than silently working.

**R4 — Restore with fidelity.** RFC 0032 holds the removed design; restored
code is diffed against its pre-deletion state, and the retired cross-node
qualification returns with it.

**R5 — Keep tier vocabulary schema-free for now.** No tier column, cluster
mode flag, or second capacity record is introduced while tier `none` is the
only implemented tier.

## Acceptance scenarios

| ID  | Scenario            | Required result                                                                                                                                                                 |
| --- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | Peer-rule-free      | A managed cluster provisions with no 8472/10250 peer rules; the agent joins over the reverse tunnel and reports Ready.                                                          |
| S2  | Isolation retained  | Capacity VMs still receive the scoped no-public-ingress network on providers that support it.                                                                                   |
| S3  | External resolution | A `dnsPolicy: Default` Pod resolves external names with no reachable CoreDNS replica on another node; the managed-cluster E2E contract asserts this with a resolution-only job. |
| S4  | Qualification       | The rewritten cluster qualification passes with no cross-node Pod, Service, DNS, logs, or exec assertions.                                                                      |
| S5  | Teardown            | Network teardown after the last VM ends is unchanged.                                                                                                                           |

## Delivery

1. This RFC and the RFC 0029/0030 narrowing land as documentation.
2. A capacity pull request removes the peer-rule intent, gateway mappings,
   and call sites; replaces the CoreDNS gate; rewrites the cluster
   qualification; and adds RFC 0015's outcome note. It lands **before** the
   RFC 0029 implementation so the new workload machinery is built on the
   final substrate and its Pod template and E2E contract are shaped by a real
   cluster, not an anticipated one.
3. A follow-up pull request sets `dnsPolicy: Default` in shared Pod
   construction and adds the resolution-only E2E Job; the RFC 0029 Deployment
   implementation inherits the field and asserts no cross-node behavior in
   the rewritten workload E2E contract.

## Alternatives considered

### Keep the peer rules provisioned while unused

Rejected. Provisioned-but-unused firewall openings read as load-bearing, are
asserted by qualification tests that then defend dead behavior, and keep the
peer-network gateway requirement alive for workloads that never use it.

### Persist a capacity tier on the cluster record

Rejected while one tier exists. A column with a single legal value is
configuration theater; RFC 0032 adds durable tier selection when a second
tier becomes real.

### Disable flannel entirely

Rejected. Node-local Pod networking still requires a CNI; leaving the default
flannel installed with unopened cross-node paths is smaller than replacing
the CNI story, and RFC 0032's overlay tier reconfigures flannel rather than
reintroducing it.

## Risks and caveats

- On providers where capacity VMs hold public addresses and only an
  account-global firewall exists, the kubelet's authenticated port is
  network-reachable even though nothing is opened by Anycloud. k3s requires
  certificate authentication there, but the exposure differs from
  private-network providers and needs an explicit hardening review before
  such a gateway is enabled for cluster capacity.
- `kubectl top` and other metrics conveniences remain absent, as they already
  are with metrics-server disabled; nothing in scaling or readiness consumes
  them.
- The cluster qualification thins until RFC 0029's workload E2E lands: it
  proves join, readiness, scheduling, and resolution, but no workload
  round-trip.
- Restoring RFC 0032 later pays a second qualification pass for the
  cross-node contract; this is the accepted price of the split.
- RFC 0032 cannot implement cluster-backed Services on tier `none`; it must
  restore and qualify a Service-capable network before admitting that
  placement.

## Non-goals

- restoring or redesigning cluster-backed Service networking, peer rules, or
  the overlay (RFC 0032);
- multi-node gang capacity, fabric tiers, or placement (future RFCs);
- enabling any new provider gateway for cluster capacity;
- changing direct-provider VM networking, VM-host Services, or dedicated Job
  behavior; and
- changing the control-plane hosting topology.

## Open questions

1. What replaces the CoreDNS gate as the minimal readiness contract — Node
   Ready alone, or Node Ready plus a scheduled smoke Pod?
2. What does the kubelet-exposure hardening review require before a
   public-address, account-global-firewall provider is enabled as cluster
   capacity?

## Tracking

An earlier pull request
delivered the removal: the peer-rule intent and gateway mappings deleted,
the CoreDNS gate replaced, the cluster qualification rewritten, and RFC
0015's outcome note added.
A follow-up pull request
applies the workload DNS contract to the shipped Job and Serve paths, adds
the E2E resolution assertion, and corrects this RFC's connectivity claims.
Acceptance-bearing
qualification evidence (R3: at least one aws or gcp capacity leg at the
final SHA) is recorded in Decision when the runs complete.

## Implementation outcome (2026-09-27)

Current state as shipped on `main`; the decisions above are unchanged.
Tier-`none` capacity shipped as **node pools**: fixed-size groups of
outbound-only VMs that join a cluster and host Deployment-targeted Jobs and
node-pool Services.

- **Records and commands.** `anycloud node-pool create|status|delete` and
  `/v1/node-pools`.
  A node pool is fixed for its whole life: credential, VM type and any
  region or zone pin are set at creation, and `--min-vms` must equal
  `--max-vms` (at least one) until scale-out ships; the API refuses anything
  else at admission. Without a region pin each VM launches in a catalog
  region and moves past one without capacity. After the cluster collapse, an
  installation
  has one cluster record, so `--cluster` on `node-pool create` is optional and
  must resolve to that record when given.
- **Provisioning and join.** Each VM is one
  attempt in the shared `vms` ledger, provisioned in an outbound-only scope
  (deny-all public ingress, no peer rules, no SSH key, no cloud credential on
  the VM); it downloads a checksum-pinned K3s agent and joins with a
  short-lived, per-VM bootstrap token pinned to the cluster CA, removed once the
  Node object exists. GPU pools install the cluster-scoped NVIDIA add-ons;
  Deployment
  Jobs run on pools.
- **Cross-cloud pools.** The cluster
  advertises its public address, apiserver → kubelet reads ride the agent
  tunnel (`egress-selector-mode: cluster`), and a crashed agent rejoins on
  restart, so a pool in another cloud than the cluster needs no inbound port.
  Live evidence: the `e2e-cluster-cloud` member's cross-cloud variant (AWS cluster,
  GCP pool) —
  run 8 (36225709258,
  journey passed; the workflow then failed in its post-run GCP firewall sweep
  on a malformed `gcloud` filter, a harness defect) and
  36254590063
  (passed end to end, 2026-09-26).
- **Acceptance scenarios.** S1 holds: no 8472/10250 peer rules exist on any
  provider and agents join over the tunnel. S2 holds with one recorded
  departure: a pool that hosts Services admits TCP 80 from the Cloudflare edge
  ranges to its elected ingress entry
  (RFC 0032); no
  other public ingress exists. S3 shipped with `dnsPolicy: Default` in the
  shared Pod parts. S4 and S5 are exercised by the live cluster check,
  which verifies no provider leftovers after teardown. R3 did its job: the
  first Service URL run found a hidden cross-node dependency (a replica placed
  off the ingress entry answered 504) and it was resolved inside this RFC's
  model by co-locating the replica with the entry.
- **Pending.** A design for a pool-internal Pod network (UDP 8472 between the
  members of one pool only, nothing across pools, clouds or to the management
  Node) is with the owner as the prerequisite for multi-replica Services. It
  would amend S1 and R1; that amendment is not part of this note and waits for
  the owner's read.

## Change log

- **2026-09-01:** Created from the jobs-only split of RFCs 0029/0030: removed
  the peer-connectivity half of RFC 0015's capacity networking from the
  active path, kept the isolation half, defined capacity connectivity tiers,
  and parked the restoration design in RFC 0032.
- **2026-09-01:** Corrected after the post-merge review of a pull request.
  Tier `none` is defined at the provisioning level — no peer access
  provisioned or required — rather than as guaranteed physical isolation;
  effective per-substrate connectivity is documented (AWS and GCP block
  cross-node traffic, Azure retains intra-VNet reachability through the
  built-in `AllowVNetInBound` rule, the local substrate stays open); R3's
  physical enforcement is narrowed to aws/gcp capacity legs; and the
  workload DNS contract now covers the shipped native Job and Serve paths,
  which the original text wrongly recorded as unused, with a standing E2E
  resolution assertion. Declined with rationale: an Azure intra-VNet deny
  rule (no threat-model payoff for same-tenant traffic, and it would remove
  the substrate where the interim DNS gap self-mitigated), early rejection
  of `service --cluster` (would break the current E2E gate to protect zero
  users from a path RFC 0029 removes), and a `dnsPolicy` configuration knob
  (speculative surface for a one-value contract).
- **2026-09-03:** Updated the jobs-only consumer to Worker terminology and
  made RFC 0032's restoration target cluster-backed Anycloud Services rather
  than a Worker ingress mode.
- **2026-09-27:** Status set to Accepted and the implementation outcome
  recorded: node pools as the shipped tier-`none` capacity, cross-cloud pools with live evidence, the
  fixed-size rule, the collapse's optional `--cluster`, the recorded
  TCP 80 edge departure from S2, and the pending pool-internal Pod
  network design. No earlier entry was changed.
- **2026-10-09:** Open question 2 answered for Lambda by the owner: "yes to
  lambda firewall". Lambda node pool VMs launch with a regional firewall
  ruleset that opens nothing, so the kubelet port stays closed
  (run 36331594383).
  TCP 22 and ICMP stay open through the account-wide global rule, which a
  ruleset cannot close; this is documented. A pool VM never launches without
  its ruleset: in a region without rulesets, which
  run 37831607151
  found to be us-south-1 alone, Lambda rejects the ruleset and the launch fails
  closed. Arm64 types are refused before launch, and Lambda still hosts no
  cluster management VM: the gateway refuses that scope before any Lambda call.

## Decision

Accepted, recorded 2026-09-27. The removal held:
every managed cluster provisions outbound-only capacity with no peer rules,
and the node pools built on it ship on every supporting
provider, including across clouds, without reopening 8472 or 10250. R3's
acceptance evidence is the AWS-cluster live check with AWS and GCP pool legs
(runs 36225709258 and 36254590063). The one departure from the isolation
half — TCP 80 from the Cloudflare edge to a Service-hosting pool's ingress
entry — is recorded in the implementation outcome and owned by RFC 0032.
Restoring node-to-node connectivity within a pool is a separate, pending
decision and will be recorded as a dated amendment here when the owner takes
it.

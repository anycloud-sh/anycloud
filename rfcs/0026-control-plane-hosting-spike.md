# RFC 0026: Control-plane hosting spike for RFC 0015

> Status: Superseded — the host supervisor was deleted when each
> installation moved to one cluster whose hosted API runs in-cluster. The spike
> itself was deleted afterwards; its last source is at `480e131bc`.
> Date: 2026-08-18
> Production qualification: Completed on 2026-08-23

## Question

Can a host-owned supervisor run one isolated Kubernetes control plane per
managed cluster, admit separately provisioned capacity VMs, survive API and
host replacement without changing cluster identity, and do so without giving
the Anycloud API container the Docker socket?

## Executable proof

`experiments/managed-kubernetes-control-plane/run.ts` ran a constrained
supervisor as a process outside disposable API-client containers:

```text
disposable API container
  (no Docker socket)
          |
          | ensure / prepare / status / delete
          v
constrained host supervisor
          |
          +-- agentless k3s control plane A
          +-- agentless k3s control plane B

two k3s agents on capacity network A -- stable host endpoint --> A
one k3s agent on capacity network B --- stable host endpoint --> B
```

The supervisor is the only component in the proof with Docker authority. Its
HTTP transport and bearer token are spike scaffolding, not the production
transport. The production API should receive a dedicated authenticated socket
or equivalent narrow channel, never the Docker socket.

The proof performs these operations:

1. Creates two agentless, embedded-etcd k3s control planes with isolated data,
   network, port, token, and ownership labels.
2. Starts two k3s agents on cluster A's isolated capacity network and one on
   cluster B's network through their host-published join endpoints, then
   verifies that each Kubernetes API observes only its own labeled agents. The
   control planes advertise the stable host endpoint back to the agents rather
   than leaking their isolated container addresses.
3. Pins a server and client Pod to different cluster A agents and proves
   cross-node Pod, ClusterIP Service, DNS, logs, and exec traffic. Cluster B
   cannot observe cluster A's resources and shares no capacity network.
4. Recreates the API-client container and calls `ensure` again, proving that
   adoption does not replace either control plane.
5. Restarts one control-plane process and verifies stable identity and agent
   reconnection.
6. Produces an on-demand etcd snapshot plus recovery metadata for each cluster.
7. Removes both control-plane containers, networks, and live host data; starts
   a new supervisor with fresh host state; and restores both snapshots with the
   original server tokens.
8. Verifies that the server-CA fingerprint and `kube-system` namespace UID are
   unchanged, the existing agents reconnect through unchanged endpoints, and
   the connection revisions advance. It repeats the cross-node data path after
   recovery and after replacing one capacity agent.
9. Deletes one cluster and proves that the other remains healthy before
   deleting it independently.

The extended proof passed locally on Docker 28.5.1 with k3s v1.35.5-k3s1. It
uses one isolated Docker capacity network per cluster as the
provider-private-network analogue and creates no billable cloud resources.

## Promoted production foundation

The production implementation now preserves the spike's authority boundary:
the hosted API container receives a mode-`0600` Unix socket exposed by a
constrained sidecar, never the Docker socket. The sidecar owns one labeled,
agentless k3s control plane per managed cluster and exposes only lifecycle
operations for those control planes.

For hosted APIs, the implementation also provides:

- one deterministic unproxied hostname and a bounded raw-TLS port range;
- stable per-cluster port assignment across host replacement;
- controller-identity fencing before mutation;
- encrypted, crash-safe, generational etcd recovery points in the hosted API's
  checkpoint tree;
- planned replacement preparation before final checkpoint sync;
- recovery that preserves the original server token, controller identity, and
  VM join endpoint; and
- final-deletion refusal while managed control planes or their durable live
  state remain.

The local Kubernetes E2E, since retired, exercised this production supervisor
through RFC 0017's constrained fixture against the real Docker Engine and pinned
k3s image.
The fixture destroys the control-plane container, network, and live host state,
starts a fresh supervisor, restores from encrypted recovery material, verifies
the same controller identity and endpoint, and waits for an already joined k3s
agent to reconnect. It also carried the API-driven two-cluster local Kubernetes
workload contract.

Hosted API identity enables this composition by construction; no positive
runtime flag can disappear during an upgrade. Local Docker proves the promoted
implementation and recovery protocol, but it does not prove hosted ingress,
checkpoint upload, provider-private networking, or separated-placement
behavior on real infrastructure. The live qualification subsequently
proved those properties with Lambda-hosted control planes and both Azure and
GCP capacity.

## Decisions supported by the spike

- Run a single agentless k3s server with embedded etcd per managed cluster.
  The control plane does not register as workload capacity.
- Pin the k3s image/version as part of the host capability.
- Treat the SHA-256 fingerprint of the k3s server CA as the durable controller
  identity. Also verify a datastore-owned identity such as the `kube-system`
  namespace UID during recovery.
- A recovery point consists of an etcd snapshot, the original server token,
  the immutable control-plane intent, and the expected controller identity.
  K3s requires the original token to decrypt bootstrap data when restoring to a
  different host; see the
  [K3s snapshot restore documentation](https://docs.k3s.io/cli/etcd-snapshot#restoring-to-new-hosts).
- Keep that recovery material inside the encrypted opaque runtime payload. The
  generic `clusters` table does not need a snapshot-format column or a separate
  recovery-reference column.
- Increment `connection_revision` after host recovery, but not after an
  ordinary API process restart or idempotent adoption.
- Give each control plane a stable internal identity and an independently
  allocated external join endpoint. Internal container names, addresses, and
  snapshot paths remain supervisor implementation details.
- Refuse to initialize empty state when a cluster is expected to recover. A
  missing snapshot or controller-identity mismatch is a hard failure.

## Production qualification outcome

The production foundation selects one unproxied hostname per hosted API plus a
small reserved port range. Each managed cluster receives one durable port in
its encrypted recovery state. Host replacement republishes the hostname to the
replacement VM and restores the same port assignment before agents are
expected to reconnect. This avoids a second public IP per cluster and an
SNI-routing layer in v1.

Encrypted recovery points are written beneath the hosted API's checkpoint
tree. `prepareForHostReplacement` completes only after a snapshot is crash-safe
locally, after which the existing final checkpoint flush can upload it.
Periodic snapshots provide the unplanned-loss recovery point.

The hosted follow-up placed the control plane and cluster capacity in
separate infrastructure locations and proved:

- raw TLS ingress and an unproxied stable hostname;
- two real capacity VMs joining through that hostname, communicating over a
  provider-private peer network, and remaining isolated from another scope;
- cross-node Pod, Service, DNS, logs, and exec traffic;
- snapshot upload through the hosted-API checkpoint path;
- hosted-API VM replacement, DNS repointing, identity preservation, and agent
  reconnection;
- capacity-VM replacement with private-network adoption; and
- ownership-safe teardown with no remaining Lambda, Azure, GCP, or checkpoint
  resources.

The Azure qualification completed in 24m36s and the GCP qualification in
25m37s. Both replaced the Lambda API host while preserving controller identity,
advanced the connection revision, reconnected existing agents, replaced a
capacity VM, retained ended capacity history, and completed independent
account-wide cleanup. Separated placement therefore remains the accepted
initial topology; the fallback that colocates control plane and capacity was
not needed.

A separate tracking item
covers explicit control-path partition injection and accepted latency, RPO, and
RTO objectives. That additional operational evidence does not block RFC 0015's
accepted topology.

Each enabled compute gateway separately requires live acceptance for the
generic resource-scope network contract: peer-only ingress, VM attachment,
interrupted preparation adoption, independent-scope isolation, and teardown
after the last VM. Those tests validate adapters and need not repeat the hosted
replacement architecture proof.

Azure and GCP passed that network acceptance as part of the live qualification. Each additional
compute provider remains gated on its own adapter qualification; none of those
qualifications changes cluster identity, VM ownership, or the opaque
runtime-state boundary.

## Decision

Accepted as an executable architecture spike on 2026-08-18 and promoted into
the production foundation by earlier changes. The live qualification
completed on 2026-08-23 and validated the separated Lambda-hosted control-plane
topology with Azure and GCP capacity. RFC 0015 owns the resulting product
decision; this RFC retains the proof and the implementation constraints that
support it.

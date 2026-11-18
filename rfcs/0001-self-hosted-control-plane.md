# RFC 0001: Self-hosted always-on control plane (`serve`)

> Status: Accepted
> Date: 2026-06-15
> Author: Luis Fernando De Pombo
> Updated: 2026-08-16 to record the hosted API outcome.

> Outcome: The customer-owned, always-on control-plane goal shipped through
> `anycloud api serve`.
> It did not ship as an `anycloud serve` mode: Service is now the public HTTP
> workload primitive. The command shape and security design below are historical;
> [the current architecture](../ARCHITECTURE.md#api-modes) and
> [`api` CLI reference](../docs/reference/cli/api-utilities.md) define the shipped
> contract.

## Summary

Give anycloud a first-class **self-hosted, always-on control plane** — an `anycloud
serve` mode the user runs on a box **they own** — so a laptop can submit work, close,
and have pipelines keep advancing. The control plane (API + monitors + encrypted creds

- SQLite) lives on the user's own infra; the laptop is a remote client. This delivers
  Modal-style "close the laptop, it keeps running" **without anycloud ever holding the
  user's credentials** — preserving BYOC. Durable multi-step pipelines then fall
  out for free: the orchestrator is just a regular job reaching the always-on API.

Two increments:

- **v1 — BYO box.** The user runs `anycloud serve` on a box they already have. The
  server shape mostly exists today (the API binds `0.0.0.0`, has Bearer-token auth, is
  managed by `anycloud api`, and a customer already self-hosts on EC2). Net-new is
  **secure remote client access** — see Security.
- **v2 — managed BYOC.** anycloud auto-provisions + manages a cheap always-on
  control-plane VM in the user's **own** cloud, so a laptop-only user gets the
  run-nothing _feel_ while creds stay on their infra.

## Context / problem

- The target user is a **Modal refugee who runs everything from their laptop** — they
  will not stand up and operate infra (that's why they chose Modal).
- They want Modal's core experience: **submit, close the laptop, the pipeline keeps
  advancing.**
- Today the control plane is local; on a laptop, closing it **kills the workflow** —
  and not cleanly: the running GPU VM keeps burning _unmonitored_, the chain never
  advances, and a spot preemption during sleep goes unrecovered.
- `{durable, local/BYOC, run-nothing}` is **pick-two** — durability for a laptop-only
  user requires an always-on control plane the user doesn't hand-run. The only
  BYOC-preserving form is a control plane on the **user's own** always-on infra.
- Verified (2026): **Modal is not a DAG/workflow engine** — composition is
  imperative Python over Function calls (`.remote()`, `.map()`, `.spawn()`), with
  background execution, Queues, Dicts, and Volumes available as primitives. Modal can
  keep detached/deployed work running after the laptop disconnects because Modal
  _hosts_ the control plane, but it does not provide automatic workflow-step replay or
  result caching; long-run resume is user-implemented with checkpoints, typically in
  Volumes. This RFC is the **BYOC equivalent**: the user's own box plays the role
  Modal's cloud plays.

## Proposal

`anycloud serve` runs the existing control plane (API + monitors + encrypted SQLite) as
a **long-lived, network-reachable server on a box the user owns**; the laptop's CLI/SDK
become **remote clients**. Because the control plane is always-on and reachable:

- **Orchestration is just a regular job.** A pipeline script
  (`prep.wait(); train.wait(); …`, `python/anycloud/job.py`) runs as an ordinary
  workload that reaches the serve API to submit its GPU children. It can run on a
  cloud VM. Durability = the box stays up.
- **Creds never leave the user's infra.** The API still holds them encrypted on the box
  (the user's own machine / cloud account). anycloud-the-company is never in the
  credential path — BYOC intact.

**v1 (BYO box):** document + harden `anycloud serve` for a box the user already runs.
The server shape mostly exists; the work is secure remote access (Security).

**v2 (managed BYOC):** `anycloud serve` can auto-provision + manage a cheap always-on
control-plane VM in the user's own cloud, giving a laptop-only user run-nothing
ergonomics with creds still on their infra.

### Hosted API deployment surface

The concrete hosted-control-plane command is `anycloud api serve`,
which asks the API to create a managed hosted API instance through the hosted
API creation path. That command is the right place to create a hosted API
instance; it should not grow a separate Local-specific startup mode.

Hosted API deployment does not include a host-local workload capability. The
API container receives only its durable state mount; it does not receive the
host Docker socket or bootstrap a second workload substrate. RFC 0002 records
the retired Local product design and the internal test-harness replacement.

## Security / threat model

> ⚠️ **This is the crux of the RFC and is written from first principles.** A
> self-hosted `serve` exposes the **credential-holding control plane** to the network —
> strictly more sensitive than the removed server-deployment feature, which only
> exposed a _workload_. **Reconcile with the team's in-flight `serve`-vulnerability
> discussion before accepting.**

**Blast radius.** If the serve endpoint is compromised, the attacker can do **arbitrary
cloud provisioning in the user's account with their own creds** (mining, exfil) —
because the API can decrypt creds to provision. So exposure must be _minimized_, not
merely authenticated.

**Precedent.** `serve` existed before (opened ports 8088 / 80 / 443 in the user's
AWS SG / Azure NSG / GCP firewall, + DNS/HTTPS ingress) and was **removed** (deletes `isServer` firewall/SG plumbing and ingress). The project already retreated from
opening inbound ports on the user's cloud — a control-plane `serve` must **not** naively
re-introduce that, and now the thing behind the port is far more sensitive.

**Today's gaps for safe remote exposure.** The API binds `0.0.0.0` (`server.ts:111`,
"for container accessibility"); `accessToken` is accepted in **query params**
(`middleware/validation.ts` — leaks into logs/proxies); TLS is self-signed / `-k` in
tests.

**Proposed posture (validate against the real discussion):**

- **No inbound public port on the control plane.** Prefer an **outbound tunnel** — the
  box dials out to a relay; the laptop reaches it through the relay — so the
  cred-holding API never directly listens on the internet. A relay can be
  transport-only (anycloud-blind to creds), preserving BYOC.
- **Real TLS; header-only tokens; short-lived + scoped** (submit-only, not admin), with
  rotation. Drop query-param tokens.
- **Tight decryption boundary** — the API decrypts creds only to provision, never
  returns them; the token surface can submit but cannot exfiltrate creds.
- If inbound is unavoidable (BYO box, no tunnel): bind to a **private/VPC interface**,
  not public `0.0.0.0`; require firewall scoping.

**This section may gate the RFC.** If the discussion concludes remote control-plane
exposure isn't acceptable at acceptable cost, the answer narrows to "BYO always-on box
on a trusted network" (no laptop-over-internet), or the tunnel becomes mandatory rather
than optional.

## Recovery & retry

With an always-on control plane, recovery is _better than the laptop case_ — the
monitors run continuously on the box, so children are monitored, preemptions recovered,
and the chain advances with the laptop closed.

- **Children (GPU jobs)** are normal workloads: infra retries (`computeRetryWait`
  backoff) **plus native spot-preemption recovery** — and they are independent durable
  workloads that survive the orchestrator dying. Modal also has hosted
  preemption/retry semantics for its own fleet (`modal.Retries`; preempted Functions
  restart on the same input), so the difference is not "Modal can't survive
  preemption." The difference is **BYOC spot control**: anycloud can recover jobs on
  spot VMs in the user's own cloud account while keeping durable workload records.
- **The orchestrator itself** re-runs from the top on its own crash unless idempotent —
  **parity with Modal** (neither checkpoints orchestration state; Modal's resume is also
  user-implemented). Because every child is a durable `workloads` row, a restarted
  orchestrator can **reattach** (skip completed, await in-flight) — same idempotency
  effort as Modal's Volume-checkpoint, but the record is built-in. Requires deterministic
  child identity (pipeline id + per-step tag).
- **Automatic resume-from-step** is the shared gap neither tool has — the embedded
  SQLite durable-execution-lib refinement (Reflow/honker); not v1.

Gaps to close: a clean user-facing **retry policy** on workloads, and a
**dead-letter / recovery-attempt ceiling** so a poison orchestrator doesn't re-queue
forever (the reconciler currently has a workload retry ceiling, but no
orchestrator-level dead-letter policy).

## Alternatives considered

- **Local execution target** — the public API-host execution product was retired;
  [RFC 0002](./0002-local-execution-target.md) records that decision.
- **anycloud-hosted, multi-tenant control plane** — true Modal "run nothing," but the
  BYOC reversal: customer creds at rest in _anycloud's_ service. Rejected: we don't
  want the creds.
- **Hosted Cloudflare-worker control logic + DB-with-the-user** — doesn't escape the
  creds problem: a worker that provisions must reach the creds (→ hosted-reachable); a
  worker that only relays adds nothing over a transport tunnel. Self-host is cleaner.
- **Client-side `.wait()` chaining only (status quo)** — dies with the laptop; the exact
  failure this RFC fixes.

## Risks & caveats

- **Demand-gated.** One Modal user asking is the trigger; validate the shape (ordered
  chaining vs fire-and-forget durability vs caching/fan-out) before building.
- **Always-on box required.** `{durable, local/BYOC, run-nothing}` is pick-two. v1
  BYO-box trades away run-nothing; v2 managed-BYOC buys it back at the cost of anycloud
  managing a VM lifecycle in the user's cloud + a small 24/7 cost.
- **Security is the gate** (above): exposing the cred-holding control plane is the
  central risk; the safe design likely requires tunnel + TLS + scoped tokens, not naive
  `0.0.0.0` exposure.
- **Orchestrator self-crash** re-runs from the top unless idempotent (resume-from-step is
  a later durable-lib refinement).
- **Does NOT** make anycloud a workflow engine — no DAG / caching / lineage / typed
  artifacts. That's compose-an-orchestrator territory, out of scope.

## Open questions

- Tunnel vs inbound-port for remote client access; if tunnel, who runs the relay
  (anycloud-hosted-but-creds-blind?).
- Token model: scope (submit-only), lifetime, rotation; drop query-param tokens.
- v1 BYO-box vs v2 managed-BYOC sequencing; is v2's auto-provision in scope now or later?
- The reattach contract — deterministic child identity for orchestrator recovery.
- **Reconcile the Security section with the team's in-flight `serve`-vulnerability
  discussion** (location TBD).

## Decision

Accepted retrospectively on 2026-08-16 based on the shipped hosted API path. The
product decision is a customer-owned, durable API target created with `anycloud
api serve`; the proposal's overloaded `serve` command and first-principles
security mechanics were not adopted as written. Current architecture and product
docs are authoritative.

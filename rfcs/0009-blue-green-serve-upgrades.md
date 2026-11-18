# RFC 0009: Blue-green Service upgrades

> Status: Proposed
> Date: 2026-06-26
> Author: Luis
> Updated: 2026-08-16 for the canonical Service primitive and shipped replacement upgrade.

> Current baseline: `anycloud service` is now the canonical public command and
> `serve` is an alias. `anycloud service upgrade` exists, but it stops the old
> workload and replaces it under the same Service ID and URL, causing downtime.
> Revisions, retained rollback targets, health-gated cutover, and an edge route
> table remain unimplemented.

## Summary

Add immutable revisions and blue-green cutover to the existing Service primitive.
A Service already owns a stable ID and public URL; each upgrade would create a
new backing revision, and the AnyCloud edge would switch the Service route only
after that revision is running and optionally healthy. The old revision would
remain alive for a rollback window, then be garbage-collected.

## Context / problem

Current Service is intentionally small: one Service record, one running workload,
one stable URL, and no AnyCloud-owned revision router or drain
semantics. On VM-host providers it has one VM; on Kubernetes it has one replica.
RFC 0003 introduced the distinct long-running lifecycle, while RFC 0005 recorded
the customer-managed node-pool use case.

That is the right primitive for node pools, but it leaves two upgrade problems for
normal HTTP services:

- `service upgrade` currently terminates and recreates the same workload ID,
  preserving the URL but introducing downtime and removing the prior workload
  before the replacement is known-good;
- AnyCloud version/runtime changes have no clear, explicit path for moving a long-running
  service from old bootstrap/runtime behavior to new behavior without silently changing
  the live container.

The roadmap now tracks blue-green upgrades and rollback retention under Service
evolution. The old pre-removal server path could overwrite a proxied DNS A
record for the same subdomain, but that is not enough for blue-green: DNS caching
makes rollback inconsistent, and DNS does not model revision health, retention,
or drain.

## Proposal

Keep Service as the existing public primitive and add a revision layer beneath
it for users who want AnyCloud-owned blue-green upgrades. Do not introduce a
second public "service above serve" abstraction.

### Concepts

Use three layers:

- `Service`: the existing user-facing workload, stable ID, and URL, such as
  `api` and `https://api.anycloud.sh`. The stored workload discriminator
  remains `server` for compatibility.
- `ServiceRevision`: a new immutable backing workload, such as `api-r0001` or
  `api-r0002`. It records the image reference/digest, command, env/secrets names,
  cloud config, AnyCloud version, optional source commit, lifecycle state, and
  backing workload/VM identity.
- `Edge route`: a mapping from the existing Service hostname to its active
  revision.

The stable service URL routes to the service's active revision. Revision URLs may remain
addressable for debugging, but users should treat the service URL as the production
entrypoint.

```text
service: api
public URL: https://api.anycloud.sh

blue revision:  api-r0001 -> workload api-r0001 -> VM A
green revision: api-r0002 -> workload api-r0002 -> VM B

active route: api.anycloud.sh -> api-r0001
upgrade:      api.anycloud.sh -> api-r0002
rollback:     api.anycloud.sh -> api-r0001
```

### User-facing surface

Extend the existing Service command instead of adding a nested `serve service`
namespace:

```bash
anycloud service ghcr.io/org/app:v1 --id api
anycloud service upgrade api ghcr.io/org/app:v2
anycloud service rollback api
anycloud service promote api --revision api-r0002
anycloud service revisions api
anycloud terminate api
```

The Python SDK mirrors the same distinction:

```python
service = client.serve("ghcr.io/org/app:v1", workload_id="api")
service.upgrade(image="ghcr.io/org/app:v2")
service.rollback()
```

`Client.serve(...)` remains the Python Service constructor. Existing users may
still treat independent Services as customer-managed nodes; blue-green behavior
does not add AnyCloud-owned replicas, scheduling, or session dispatch.

### Upgrade lifecycle

`service upgrade` would perform a blue-green rollout instead of today's
replacement rollout:

1. Read the current active revision for the service.
2. Create a new revision ID and backing Service workload using the requested image,
   command, env, secrets, Docker options, cloud config, and current AnyCloud version.
3. Wait for the backing workload to reach `Running`.
4. If the service has a health check, poll it until it succeeds or times out.
5. Atomically move the service route from the previous revision to the new revision.
6. Mark the new revision `active` and the previous revision `retained`.
7. Keep the previous revision alive for the rollback retention window.
8. Garbage-collect retained revisions after the retention window or explicit promotion.

If the new revision fails before route switch, the service keeps routing to the old
revision and the failed green workload is left for inspection or cleaned up according
to the user's requested policy.

### Edge routing

Do not implement service cutover as a DNS A-record swap.

Instead, put service hostnames behind the AnyCloud edge and maintain a route table:

```text
service host -> active revision -> origin IP / revision URL
```

The Cloudflare Worker, or its successor front door, reads the active revision mapping and
proxies requests to that revision's origin. This gives near-instant cutover and rollback,
keeps the stable service hostname independent of a specific VM IP, and leaves room for
future route behaviors without changing the user's URL.

Origin ingress follows the shipped RFC 0004 slice: public Service traffic enters
through Cloudflare, and origin VMs accept managed HTTP ingress only from
Cloudflare ranges.

### Health checks

MVP readiness has two levels:

- default: backing workload reaches `Running`;
- optional: user supplies `--health-path`, such as `/healthz`, and AnyCloud waits for a
  successful HTTP response through the service/revision path before route switch.

Health checks should be service configuration, not per-upgrade ad hoc flags only. The
same path is reused for later upgrades and rollback validation.

This RFC does not define app-level session health. A passing health check means "safe to
start routing new HTTP requests," not "all existing sessions can move without
interruption."

### Rollback and retention

Rollback is a route operation:

```bash
anycloud service rollback api
```

It switches the service route back to the most recent retained revision. Rollback is only
available while that revision still exists and is healthy enough to route to.

Default retention should be conservative, for example one hour, with an explicit
promotion command to terminate retained revisions early:

```bash
anycloud service promote api --revision api-r0002
```

Promotion means "this revision is accepted; clean up older retained revisions according
to policy."

### AnyCloud version upgrades

AnyCloud runtime upgrades use the same mechanism as user-code upgrades.

Existing blue revisions keep running with the runtime/bootstrap behavior they were
started with. A new green revision uses the currently installed AnyCloud version, API
image, bootstrap script, Docker command construction, and edge contract. Route switch is
explicit; live containers are not silently restarted or mutated because the CLI/API was
updated.

### Data model sketch

The concrete schema can vary, but the model should be durable:

```text
workloads (existing Service row)
  id                  # stable Service ID and hostname
  workload_type       # persisted value remains "server"

service_revision_state
  service_id
  active_revision_id
  rollback_revision_id
  health_path
  retention_ms
  updated_at

service_revisions
  id
  service_id
  workload_id
  revision_number
  state              staging | active | retained | failed | garbage_collected
  image
  image_digest
  anycloud_version
  source_repo
  source_commit
  activated_at
  retained_at
  created_at
  updated_at
```

The existing Service workload remains the user-facing identity. Revision state
points at internal backing workloads/VM attempts; it does not create a second
public Service resource or replace the provisioning ledger.

### Failure handling

Failure policy should be explicit:

- green fails before cutover: service remains on blue, green is marked `failed`;
- route switch fails: service remains on blue, green is marked `failed` or
  `staging_failed`;
- blue cleanup fails after successful cutover: service remains on green, cleanup is
  retried by a background cleanup path;
- API restarts mid-upgrade: a service-upgrade reconcile loop observes staging revisions
  and either resumes health/cutover or marks the revision failed after timeout.

The route switch must be idempotent and must not leave the service without an active
revision.

### Relationship to customer-managed Service nodes

This RFC does not replace RFC 0005.

Use independent `Client.serve(...)` Services when the customer's backend already
owns node selection, capacity reservation, session dispatch, and drain. Use the
revision path when the user wants AnyCloud to own health-gated cutover and basic
rollback behind the Service's existing stable URL.

## Implementation slices

1. Add revision persistence and API/SDK/CLI read paths beneath existing Services.
2. Adopt a Service's current backing workload as revision 1 without changing its
   ID or URL.
3. Add edge route-table cutover for service hostnames.
4. Add upgrade, rollback, retention, and cleanup.
5. Add optional HTTP health checks.
6. Add reconcile behavior for interrupted upgrades.

The first shippable version should be single-replica only.

## Tests and validation

Required test coverage:

- an existing Service can be adopted as revision 1 without changing its ID or URL;
- upgrade failure before route switch keeps the old revision active;
- successful upgrade flips the active revision and retains the old revision;
- rollback flips back to the retained revision;
- promotion/retention cleanup terminates only inactive retained revisions;
- service/revision routes cannot be modified by a different user;
- API restart during staging is reconciled without losing the active route;
- Worker route lookup and switch are covered with deterministic tests;
- one provider smoke path validates real HTTP traffic reaches the active revision.

## Alternatives considered

### DNS A-record swap

This is the smallest implementation because the old server path already knew how to
replace a DNS record. It is not the right blue-green primitive: DNS caches make rollback
inconsistent, route state is hard to reason about, and DNS does not carry revision health
or retention state.

### In-place update on the live VM

SSH into the VM, pull a new image or git commit, and restart the container. This is cheap
and preserves the URL, but it destroys the strongest property of blue-green: the old
revision is no longer intact for rollback. It also creates drift that is hard to audit.

### Replace the same workload ID

Terminate the current workload and create a replacement with the same Service ID.
This is the behavior currently shipped on main. It keeps the URL but introduces
downtime and makes failed upgrades awkward because the old revision is already
gone.

### Customer-owned node-pool rolling replacement

This is the RFC 0005 answer and remains valid for serving customers that run their own control plane. Their
control plane can launch green nodes, wait for app health, stop assigning sessions to
blue nodes, and terminate them. That should not be forced on users who just want one HTTP
service URL with rollback.

### Full serving platform now

Build request routing, replicas, percentage canaries, autoscaling, session affinity,
drain, and multi-region policies. This is closer to SkyServe, but it is too large for
the next step. The proposed service/revision layer gives a narrow useful product without
committing to the full serving platform.

### dstack-style rolling replicas

Rolling replacement is useful once AnyCloud owns more than one replica per service. It
is not the first step because the current Service is single-replica and RFC 0005
models node pools as many independent workloads. Start with single-replica
blue-green; rolling replacement can layer on later if replicas become first-class.

## Risks & caveats

- This adds an AnyCloud-owned revision and route abstraction beneath Service,
  which increases controller and recovery state.
- Running blue and green at the same time doubles compute cost during rollout.
- Health checks are app-specific; a generic HTTP 200 is not proof that a model is loaded
  or that session traffic can move cleanly.
- Rollback only works while the old revision is retained and still healthy.
- The edge route table becomes production-critical state.
- WebSocket or long-lived HTTP sessions may be interrupted during cutover unless the app
  handles reconnects.
- Service hostnames introduce name ownership, collision, and deletion semantics that are
  stricter than direct workload IDs.
- Existing Services need an adoption/migration rule that preserves their current
  ID, URL, and backing workload without an implicit restart.

## Non-goals

- No percentage canaries in the first version.
- No autoscaling policy.
- No request-level session affinity.
- No app-level session drain protocol.
- No multi-region routing.
- No multi-replica service behind one URL in the first version.
- No automatic mutation or restart of existing live containers after AnyCloud updates.
- No change to `Client.serve(...)` as the Service constructor.

## Open questions

- Should `service upgrade` become blue-green by default, or require an explicit
  rollout policy while replacement upgrades remain available?
- Should revision URLs be internal-only or use a distinct debug namespace while
  the existing `https://<service>.anycloud.sh` URL remains stable?
- Where should the edge route table live: API SQLite mirrored to the Worker, Cloudflare
  KV/D1, or another managed store?
- Is the default rollback retention one hour, one day, or explicit-only cleanup?
- Should rollback validate health before switching back, or should it be a forced route
  operation?
- Should a revision be represented by an internal child workload, a durable
  workload attempt, or a separate backing-workload record?
- What is the minimum health check contract: status code only, timeout, expected body,
  headers, or all of the above?
- How should service names interact with existing workload IDs and DNS records?
- Should AnyCloud eventually support rolling multi-replica upgrades under the same
  service model, or should that remain customer-owned?

## Decision

Pending. Main has URL-preserving replacement upgrades with downtime, not the
revision, retention, health-gated cutover, or rollback model proposed here. Any
accepted revision must extend the canonical Service primitive and define a safe
adoption path for existing Services.

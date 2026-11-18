# RFC 0003: Revive `anycloud serve` with a dedicated serve lifecycle

> Status: Accepted
> Date: 2026-06-16
> Author: Luis
> Updated: 2026-08-16 to record the shipped outcome and Service rename.

> Outcome: The dedicated persistent HTTP lifecycle shipped.
> The public primitive
> was later renamed Service: `anycloud service` is the command (the `anycloud serve`
> alias was removed in 0.1.65), and `server` remains the persisted/API discriminator.

Primary issue: Revive serve workload type.
Source material: `.context/attachments/1Dmn4j/pasted_text_2026-06-16_09-46-49.txt`.

This RFC turns the prior implementation-planning transcript into a durable proposal for
restoring `anycloud serve`. It preserves the core v0 goal from the primary issue above, but incorporates the
later architecture correction from planning: servers should share the existing data model
and cloud leaves, while getting their own orchestration/lifecycle path.

## Summary

Restore `anycloud serve` as a v0 persistent HTTP server workload type.

The v0 behavior is intentionally close to the previously removed feature:

- one VM per server workload;
- public HTTP endpoint at `https://<workload-id>.anycloud.sh`;
- workload container listens on port `8088`;
- host publishes port 80 to container port `8088`;
- container restarts with Docker `unless-stopped`;
- workloads do not complete when the container keeps running;
- no service liveness, TLS/origin hardening, token down-scoping, or real IP whitelist.

The important architecture change is that `serve` should not be modeled as "just another
job branch" in orchestration code. It should have a dedicated serve lifecycle seam:

```text
job lifecycle:   provision -> run workload -> observe completion -> final sync/checkpoint
serve lifecycle: provision -> start healthy -> publish endpoint -> keep running
```

Data model and low-level cloud/runtime code remain shared.

## Context / problem

An earlier change, squash-merged as `161ebf2a` on 2026-06-06, removed customer-facing persistent
server workloads. After that change, creation is job-only and `/v1/new` rejects non-job
workload types with:

```text
Server deployments have been removed. Use anycloud submit to run a job.
```

The primary issue asks for a minimal v0 revival: effectively port the removed feature forward
onto the current tree. A clean `git revert 161ebf2a` is not appropriate because the tree
has drifted since that removal: the CLI was refactored, new gateways were added, and the old
deleted `serve.ts` depended on image-validation helpers that no longer exist.

The practical approach is:

- use `git show 161ebf2a^ -- <path>` as reference material for the removed behavior;
- port the behavior onto current code paths;
- clone current `submit.ts` patterns when authoring the new CLI command;
- make the small structural improvement that gives serve its own lifecycle module.

## Proposal

Use the same storage model and shared cloud leaves, but introduce a separate serve
orchestration path.

### Same data model

Do not add a `servers` table for v0.

The current schema already models workload-to-VM history through `workloads` and
`vms`. The `vms` table has a `workload_id` foreign key and `workload-store.ts`
describes it as the workload's provisioning ledger. Jobs are single-VM by business
logic, not because the schema requires a workload to have exactly one VM.

This matters for future programmatic serve-node workflows: users may manage many
independent server workloads as a node pool, but each node can still be represented by
the existing workload and VM ledger rather than a parallel `servers` table.

### Shared leaves

Do not fork low-level cloud/runtime code.

These components should stay shared, but they should not learn about "server" as a
business concept:

- cloud gateways receive cloud primitives such as ingress rules and launch networking,
  not `workloadType` or `isServer`;
- VM provisioning remains shared and receives any cloud network handle needed for VM
  launch;
- Docker command construction remains shared and derives runtime differences from the
  workload row;
- workload store;
- credentials;
- termination and cleanup.

Forking these would duplicate provider behavior. Passing workload-type booleans into
gateways would also put product semantics at the wrong layer. The serve lifecycle should
compute the network intent; gateways should apply that intent using provider primitives.

### Separate orchestration seam

Add a serve lifecycle module that owns server-specific orchestration.

This module starts small in v0: it publishes the endpoint by managing DNS records after a
VM has started and the workload container is healthy. It also gives future serve-node
workflow work a real home without putting product semantics into cloud gateways.

This is deliberately a little more structured than a literal revert of that removal. The extra
surface should be small: one new service module and delegation from `conduct` and
`monitor`.

## Alternatives considered

### Literal revert

A clean revert is not viable because the tree drifted after that removal. The CLI was refactored,
new gateway implementations were added, and the deleted `serve.ts` depended on image
helpers that no longer exist.

### Keep serve inline as job branches

This matches the old implementation more closely, but it is the wrong seam for the stated
future direction. Servers will need multi-VM fleet behavior that is not a job concept.
Keeping endpoint publication and non-completion behavior as scattered `if (isServer)`
branches would make that later split harder.

### Pass `isServer` through gateway APIs

This is also the wrong boundary. Gateways should not understand whether a workload is a
job or a server. They should understand requested cloud networking: open SSH, open HTTP,
attach this security group, apply these source ranges. The route/lifecycle layer owns the
server decision; the gateway applies provider primitives.

### Add a dedicated `servers` table

This duplicates state the current model already has. `workloads` plus the `vms` ledger
can represent workload-to-many-VM history. The code path should diverge at lifecycle
orchestration, not at the storage layer.

### Build an anycloud-owned router now

A request-path router, affinity ledger, app-level health, drain logic, and autoscaling
policy are not part of this v0 revival. The next customer-driven milestone is the
programmatic serve-node workflow in [RFC 0005](./0005-programmatic-serve-nodes.md), where
customers own routing/session control and anycloud owns node lifecycle.

## Non-goals

Do not solve the broader hardening work in this RFC. DNS Worker safety is the
exception: it is part of the revived endpoint publication path, so the Worker must
not fail open or authorize unrelated callers before `serve` is treated as revived.

Out of scope for v0:

- down-scoped or App-minted GitHub tokens in workload containers;
- Cloudflare-only origin ingress, TLS, per-workload security groups, or service
  liveness;
- real `ipWhitelist` behavior;
- budget semantics for indefinite runtime;
- monitor scaling for many never-completing workloads;
- request-path routing, session affinity, cordon/drain, or autoscaling;
- the programmatic node-pool workflow in [RFC 0005](./0005-programmatic-serve-nodes.md).

The v0 feature intentionally restores the insecure-but-functional internal dogfooding
shape. The sibling issues own hardening.

## V0 Architecture

### API shape

`WorkloadType` becomes:

```ts
export enum WorkloadType {
  Job = 'job',
  Server = 'server',
}

export type WorkloadTypeValue = 'job' | 'server';
```

`/v1/new` accepts `workloadType: 'server'`, with server-specific validation:

- exactly one VM;
- no spot/preemptible;
- no buckets/checkpoint storage;
- no scheduler-native clouds such as Kubernetes, and no providers without
  ingress support such as Vast;
- current credential-resolution behavior.

Keep `/v1/new` as the only public creation route. Internally, split the route into
separate handlers:

```text
POST /v1/new
  workloadType=job    -> createJobWorkload(...)
  workloadType=server -> createServerWorkload(...)
```

The route can dispatch by `workloadType`; the validation and request shaping should not
stay interleaved. Shared helper code should cover auth, ID generation, credential
resolution, image preflight, and workload-row creation.

The single-VM rule is a v0 constraint. Programmatic node pools should launch multiple
independent serve workloads as described in
[RFC 0005](./0005-programmatic-serve-nodes.md). Gate capacity fields explicitly in this
RFC:

- if `minVmCount` / `maxVmCount` (or a later `replicas` alias) are absent, v0 defaults to
  one VM;
- if capacity fields are present, v0 accepts only the single-VM shape
  (`minVmCount <= 1` and `maxVmCount <= 1`, or `replicas === 1`);
- any value requesting more than one VM is rejected with a message to launch multiple
  serve workloads for node pools, not silently ignored;
- TypeScript and Python request models should agree on these fields so direct API, CLI,
  and SDK callers get the same validation.

### Lifecycle

`conduct` should delegate server-specific endpoint publication to a new serve service
module instead of carrying inline DNS logic.

Proposed module:

```text
src/api/services/serve.ts
```

Initial responsibilities:

- delete stale DNS records for the subdomain;
- create a DNS record for `<workload-id>.anycloud.sh`;
- persist `dnsRecordId` on the workload;
- expose a clear seam for future serve control-plane behavior.

Endpoint publication should run after `startStep` confirms the container is healthy, not
inside provisioning. `provisionStep` intentionally returns early when VMs already exist;
if DNS publication lived there, a DNS failure after VM creation could be skipped on retry.

`monitor` should branch by lifecycle type:

- jobs keep completion/resume/final-sync behavior;
- servers skip job-completion handling and rely on Docker restart behavior for VM reboot
  recovery;
- service liveness remains out of scope for v0.

### Docker runtime

The Docker command builder remains shared, with server behavior parameterized:

- jobs use `--restart no`;
- servers use `--restart unless-stopped`;
- servers publish `0.0.0.0:80:8088`;
- servers set `PORT=8088` in workload environment.

### Networking and DNS

Restore the DNS client functions in `src/api/services/dns.ts`:

- `upsertDNSRecord(subdomain, ip, githubToken)`;
- keep `deleteDNSRecord(recordId, githubToken)` for termination cleanup.

The Worker's by-subdomain delete route stays available for manual cleanup of a record
whose ID was lost from the DB, but the API itself has no client for it: `upsertDNSRecord`
reconciles same-owner duplicates on the next publication.

Restore the deleted `worker/` source directory for version-control hygiene and promote it
through `.github/workflows/dns-worker.yml`. Unlike `docs.yml` and `install-script.yml`,
the DNS Worker must not auto-deploy on `main` pushes or `Release` completion yet. Its
workflow is a manual promotion path that runs Worker unit tests, a Wrangler dry-run,
production deploy, and a `/v1/health` smoke. Before dispatching it from `main`, run the
serve smoke tests locally with a real GitHub token:
`yarn test:e2e:serve:aws`, `yarn test:e2e:serve:azure`, and
`yarn test:e2e:serve:gcp` (or `yarn test:e2e:serve` to run all three), plus the
self-bootstrap recursion check `yarn test:e2e:recursion:aws`. These checks intentionally
validate the published/versioned images used by the serve path, not necessarily the exact
workspace commit. The planning transcript found the hosted DNS worker still alive and
auth-gated, but v0 must update and redeploy it for the safety prerequisites below before
relying on the revived publish path.

### DNS Worker safety prerequisites

The DNS Worker (`worker/src/index.ts`) is on the critical path for `serve` because endpoint
publication calls `upsertDNSRecord(id, vm.ip, githubToken)`. The Worker creates a record
when none exists and updates a same-owner record in place, avoiding the public routing gap
caused by delete-then-create publication. These are not deferred hardening items: they are
the authorization and correctness checks that make the revived public DNS path safe enough
to operate.

Required fixes:

- **Remove or replace the GitHub Actions public-repo fallback.** The Worker currently falls
  back from `GET /user` to `GET /repos/anycloud-sh/anycloud` and then assigns the caller the
  shared owner `github-actions`. Because the repo is public, readability is not proof that
  the token belongs to this repository's workflow. Either remove this fallback for v0 or
  replace it with a verifiable CI identity, such as GitHub OIDC claims for
  `repository == anycloud-sh/anycloud` or a backend-signed DNS request. Until CI has that
  replacement, DNS Worker deploys remain manual promotions after local serve smoke
  validation rather than automatic release/push deploys. If a staging Worker is added later,
  put it on a separate domain or zone rather than sharing production `*.anycloud.sh` names.
- **Enforce ownership on both delete paths.** `DELETE /v1/dns-records?subdomain=...` and
  `DELETE /v1/dns-records/:recordId` must not delete records whose
  `comment !== auth.username`. Delete-by-subdomain should reject mixed-owner result sets
  without deleting any record, and delete-by-id should read the record first and reject
  non-owner deletes, mirroring the POST path's existing non-owner rejection. Otherwise the
  lifecycle's delete-then-create sequence and termination cleanup can bypass the create-time
  ownership check.
- **Fail closed when Cloudflare record lookup fails.** If listing existing A records returns
  a non-OK Cloudflare response, the Worker must return an error and avoid creating or
  deleting records. Treating lookup failure as `[]` makes rate limits, bad credentials, or
  transient Cloudflare errors look like an available subdomain.
- **Validate subdomain names before Cloudflare writes.** `subdomain` must match the
  workload-id format accepted by `validateId` so callers cannot create dotted, wildcard,
  or otherwise arbitrary `anycloud.sh` records.

The serve lifecycle computes network intent. Gateways apply that intent without knowing
whether it came from a server workload.

Example shape:

```ts
type IngressRule = {
  name: string;
  port: number;
  protocol: 'tcp';
  sourceRanges: string[];
};

type NetworkSpec = {
  ingress: IngressRule[];
};

type CloudNetworkHandle = {
  securityGroupId?: string;
  networkSecurityGroupName?: string;
  targetTags?: string[];
};
```

For jobs, the network intent is SSH only. For v0 serve, it is SSH plus public HTTP on
port 80:

```ts
const serveNetwork: NetworkSpec = {
  ingress: [
    { name: 'ssh', port: 22, protocol: 'tcp', sourceRanges: ['0.0.0.0/0'] },
    { name: 'http', port: 80, protocol: 'tcp', sourceRanges: ['0.0.0.0/0'] },
  ],
};
```

Provider behavior:

- AWS: create/select a security group that satisfies the requested ingress and return
  its `securityGroupId`; `newVM` attaches that handle at launch;
- Azure: create/update an NSG that satisfies the requested ingress and return any handle
  the NIC path needs;
- GCP: create firewall rules from the requested ingress and use the target tags already
  used by VM launch;
- Vast, Lambda, and Local either reject unsupported ingress or no-op only where their
  execution model makes the rule irrelevant.

## Implementation Plan

### 1. Shared types

Update `src/shared/types.ts`:

- add `WorkloadType.Server = 'server'`;
- widen `WorkloadTypeValue`;
- update `dnsRecordId` comments to mention server workloads.

### 2. Cloud networking interface and gateways

Update `src/api/services/gateways/cloud.ts` so networking is expressed as provider-neutral
intent, not as a workload type boolean.

Replace or evolve `upsertFirewall(...)` into a method that accepts `NetworkSpec` and
returns a `CloudNetworkHandle` when launch-time networking is needed:

```ts
prepareNetwork(
  spec: NetworkSpec,
  workloadId: string,
  version: string,
  userId: string,
): Promise<CloudNetworkHandle | undefined>;
```

Thread that network intent through:

- `aws.ts`;
- `azure.ts`;
- `gcp.ts`;
- `vast.ts`;
- `lambda.ts`;
- `local.ts`.

Restore server-specific port-80 rules only where the provider supports them.
Do not pass `isServer` or `WorkloadType` into gateway methods.

### 3. VM provisioning

Add network intent/handle plumbing to:

- `src/api/services/entities.ts` `NewVMsProps`;
- `src/api/services/vm-provisioner.ts` `ProvisionParams`.

The provisioner should call the cloud networking method before creating VMs, then pass the
returned handle into VM creation. This matters for AWS, where the security group must be
attached during `RunInstances`; it is not enough to create ingress during firewall setup.

### 4. Docker runtime

Update `src/api/services/docker.ts`:

- import `WorkloadType`;
- define `DEFAULT_SERVER_PORT = 8088`;
- derive job/server behavior from `workloadType`;
- publish port 80 for servers;
- set restart policy by workload type;
- set `PORT=8088` for servers.

### 5. Serve lifecycle module

Create `src/api/services/serve.ts`.

Initial exported behavior should cover:

- building the v0 serve network intent (SSH plus HTTP 80);
- endpoint publication after container health succeeds:

```text
upsertDNSRecord(id, vm.ip, githubToken)
store.updateDnsRecordId(id, recordId)
```

Keep this module focused on lifecycle orchestration. Do not move shared provisioner,
gateway, or Docker construction code into it.

### 6. Conduct and monitor

Update `src/api/services/conduct.ts`:

- pass network intent to VM provisioning;
- for server workloads, call the serve lifecycle module after `startStep` and before
  marking the workload `Running`;
- leave job-only checkpoint behavior on the job path.

Update `src/api/services/monitor.ts`:

- keep completion/resume logic job-only;
- add an explicit server branch/comment explaining why servers do not complete;
- defer service liveness to a follow-up.

### 7. API route

Update `src/api/routes/cli.ts`:

- remove the "Server deployments have been removed" rejection;
- keep `POST /v1/new` as the public route;
- dispatch internally to `createJobWorkload(...)` or `createServerWorkload(...)`;
- stop hardcoding persisted workloads to `WorkloadType.Job`;
- restore server validation in the server handler;
- reject invalid server combinations before workload persistence.

### 8. CLI

Create `src/cli/commands/serve.ts` by cloning current `submit.ts` patterns, not the
deleted previously-removed file.

Keep:

- `--id`;
- `--env`;
- `--env-file`;
- `--secret`;
- `--region`;
- `--vm-type`;
- `--gpu-type`;
- `--disk-size`;
- `--zone`;
- Docker runtime flags.

Drop job-only flags:

- `--persist`;
- `--persist-bucket`;
- `--spot`;
- bucket/checkpoint storage flags.

Register `serve` in `src/cli/index.ts`.

On success, print:

```text
ID: <id>
URL: https://<id>.anycloud.sh
```

Restore status output for server URLs.

### 9. Python SDK

Restore Python SDK server helpers:

- `Client.serve(...)`;
- `workload_type="server"`;
- `Job.url` returning `https://{id}.anycloud.sh`;
- relevant docstring references.

### 10. Worker source and DNS client

Restore `worker/` from `161ebf2a^`.

Restore DNS client creation/list-delete functions in `src/api/services/dns.ts`.

Update the Worker source and redeploy the live Worker with the DNS safety prerequisites
above. The repository copy is not sufficient by itself if `dns.anycloud.sh` still serves an
older Worker bundle.

### 11. Tests

Restore or re-author focused unit coverage:

- route accepts server creation;
- route rejects invalid server combinations;
- Docker command publishes port 80 and uses `unless-stopped`;
- gateway networking applies HTTP ingress from `NetworkSpec` without receiving
  `isServer`;
- AWS attaches the returned security-group handle during VM launch;
- monitor keeps job completion job-only;
- CLI registers `serve` and sends `workloadType: 'server'`;
- workload store preserves DNS record state;
- Worker rejects unrelated or unverifiable GitHub Actions tokens instead of assigning them
  the shared `github-actions` owner;
- Worker delete-by-subdomain and delete-by-id do not delete records owned by a different
  authenticated user, including mixed-owner subdomain result sets;
- Worker create/delete fail closed when Cloudflare record lookup fails;
- Worker rejects subdomains that do not match workload-id syntax.

Restore real-cloud e2e parity:

- `aws-serve.test.sh`;
- `azure-serve.test.sh`;
- `gcp-serve.test.sh`;
- `aws-recursion.test.sh`, which deploys the API with `serve`, submits a parent job to
  that remote API, and has the Python SDK submit and wait for a child job;
- integration helpers for `cli_serve`, DNS cleanup, HTTP readiness, remote API requests,
  and remote workload polling.

Azure and AWS e2e legs were called out in the transcript as known flaky, so rerun once
before treating a failure as actionable.

### 12. Docs

Restore user-facing docs for:

- `anycloud serve` CLI reference;
- Python SDK reference;
- server URL in status output;
- a simple HTTP-server or Marimo tutorial if still product-relevant;
- provider-authoring notes for server HTTP ingress;
- changelog entry under the next unreleased version.

Avoid leaking internal enum names into user-facing docs.

## Verification

Minimum verification before merge:

```bash
yarn build
yarn fmt
yarn vitest run test/unit/routes/new.spec.ts test/unit/services/docker.spec.ts test/unit/services/gateways/aws.spec.ts test/unit/services/monitor.spec.ts --exclude='**/.context/**'
node dist/cli/index.js serve --help
cd python && pytest
```

Manual/dry API checks:

- `/v1/new` accepts `workloadType: 'server'`;
- `/v1/new` rejects server + spot;
- `/v1/new` rejects server + buckets;
- `/v1/new` rejects server capacity greater than one and points users at multiple serve
  workloads for node pools;
- response includes enough data for the CLI to print `https://<id>.anycloud.sh`.

Real-cloud e2e checks:

- run the serve smoke tests locally with a real GitHub token:
  `yarn test:e2e:serve:aws`, `yarn test:e2e:serve:azure`,
  `yarn test:e2e:serve:gcp`, or `yarn test:e2e:serve` for all three;
- run the recursive API self-bootstrap check locally with a real GitHub token:
  `yarn test:e2e:recursion:aws`;
  it defaults to `ghcr.io/anycloud-sh/api:<package version>` for the served API and
  `ghcr.io/anycloud-sh/recursion-test:latest` for the parent-job fixture; override with
  `ANYCLOUD_RECURSION_API_IMAGE` or `ANYCLOUD_RECURSION_IMAGE` only when intentionally
  testing alternate published images;
- deploy a tiny HTTP image such as nginx;
- wait for `Running`;
- curl `https://<id>.anycloud.sh`;
- terminate;
- confirm DNS cleanup.
- after DNS Worker promotion, smoke-test `https://dns.anycloud.sh/v1/health`.

## Risks & caveats

### Reintroducing known insecure behavior

v0 intentionally restores public port-80 ingress and broad workload token behavior. This is
only acceptable because the broader hardening issues are explicit and separate. DNS Worker
authorization is not in that bucket: the Worker safety prerequisites above block reviving
the public endpoint lifecycle.

### Lifecycle confusion

Servers do not complete. If that rule is not isolated in code, job completion and final
sync logic can accidentally touch servers. The serve module and monitor branch exist to
make that boundary obvious.

### Future serve-node pressure

This RFC stops at the primitive: one long-running VM with one stable endpoint. The chosen
seam lets [RFC 0005](./0005-programmatic-serve-nodes.md) define the customer-facing SDK
workflow for many independent serve nodes without adding an anycloud-owned router,
affinity ledger, or autoscaling policy.

### Gateway interface drift

`lambda.ts` and `local.ts` were added after that removal. A literal revert would miss them. Any
gateway interface change must update all current implementations.

The interface should not expose `isServer`; use network intent so new gateways implement
cloud behavior rather than product categories.

## Open Questions

- Should the v0 CLI expose any health-check option, or should liveness remain completely
  deferred to a follow-up?
- Should the Marimo tutorial be restored as-is, or replaced with a smaller generic HTTP
  server tutorial?
- Should docs label `serve` as internal/dogfooding until the follow-up hardening lands?
- Should the provider-neutral networking method be named `prepareNetwork`,
  `upsertNetwork`, or remain `upsertFirewall` with a new argument shape?

## Decision

Accepted and implemented on 2026-06-18. The implementation retained
the shared workload/VM ledger and a distinct long-running workload lifecycle.
Later hardening and naming changes do not reverse the decision: Service is the
public name, while the stored `server` value remains compatible.

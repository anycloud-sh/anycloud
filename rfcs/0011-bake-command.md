# RFC 0011: Make image baking a first-class deployment type

> Status: Superseded by [RFC 0013](./0013-standardize-gpu-image-delivery.md)
> Date: 2026-06-30
> Author: Codex draft
> Updated: 2026-08-16 to route directly to the final full-pull contract.

> Historical note (2026-07-13): AnyCloud no longer creates or reuses customer
> workload AMIs, and the create/list/copy/require-baked workflow proposed here
> was not implemented. The `bake` and `baked` command surfaces do not exist. RFC
> 0012 recorded the intermediate removal/lazy-loading design; RFC 0013 is the
> current image-delivery decision.

## Summary

Replace `submit --bake` and `serve --bake` with a first-class bake workflow:

```bash
anycloud bake create <image> --credentials <name> --region <region> --vm-type <type>
anycloud bake list
anycloud bake copy
anycloud bake prune
```

Jobs and servers continue to opportunistically boot from baked images when one
exists, but they no longer create baked images themselves. Add an explicit
preflight guard for workloads that must not cold-pull:

```bash
anycloud submit <image> --require-baked ...
anycloud serve <image> --require-baked ...
```

`--require-baked` is a preflight check. It rejects the request before creating a
deployment row or provisioning a VM if the exact target cannot boot from an
existing baked image.

## Context / problem

Today image baking is embedded inside normal job/server deploys:

```text
job/server: provision -> initialize -> pull -> maybe bake -> sync/start
```

That creates ambiguous semantics:

- If baking fails, should the workload still start?
- Should a server deployment block on cache creation?
- Should `serve upgrade` support bake?
- Should spot recovery re-run bake?
- What does retry mean after a bake failure?
- Did `--bake` mean "run my workload" or "produce a reusable cache artifact"?

Making baking its own deployment type removes that ambiguity:

```text
bake:      provision -> initialize -> pull -> bake -> completed
job:       provision -> initialize -> pull-or-cache-hit -> sync/start
server:    provision -> initialize -> pull-or-cache-hit -> start
```

`anycloud bake create` is allowed to fail if cache creation fails. A job/server
is about running the workload. A bake deployment is about producing the baked
image.

Relevant local code:

- `src/cli/commands/baked.ts`
- `src/cli/commands/submit.ts`
- `src/cli/commands/serve.ts`
- `src/api/routes/cli.ts`
- `src/api/services/conduct.ts`
- `src/api/services/cloud-config.ts`
- `src/api/services/gateways/aws.ts`
- `src/api/services/gateways/azure.ts`
- `src/shared/types.ts`

## Proposal

### Goals

- Remove user-facing `--bake` from `submit` and `serve`.
- Add `anycloud bake create`.
- Rename the artifact-management command group from `baked` to `bake`.
- Keep `list`, `copy`, and `prune` under the new `bake` command group.
- Add `--require-baked` to `submit` and `serve` as a preflight guard.
- Keep normal jobs/servers opportunistically consuming baked images.
- Keep provider snapshot retries/idempotency inside provider implementations.
- Keep the first implementation scoped enough to avoid scheduler rewrites.

### Non-goals

- No backward-compatible `baked` alias.
- No backward-compatible `submit --bake` or `serve --bake`.
- No unpinned baked-only scheduling in v1.
- No new terminal state unless needed.
- No cloud-image baking for providers that do not already support
  `CloudImageBaker`.

### User-facing design

Create a baked image:

```bash
anycloud bake create ghcr.io/org/app:tag \
  --credentials aws-prod \
  --region us-east-1 \
  --vm-type g6e.xlarge \
  --disk-size 100 \
  --gpus all \
  --runtime nvidia
```

For v1, require:

- `--credentials`
- `--region`
- a concrete launch target, preferably `--vm-type`

Rationale: baked images are scoped by cloud account, region, image digest, and
base image family. A true preflight guarantee needs the exact target.

List/copy/prune baked images:

```bash
anycloud bake list --credentials aws-prod
anycloud bake copy --credentials aws-prod --image ghcr.io/org/app:tag --to us-west-2
anycloud bake prune --credentials aws-prod --unused-for 30d --yes
```

These are the existing `baked` subcommands moved under `bake`.

Require an existing baked image:

```bash
anycloud submit ghcr.io/org/app:tag \
  --credentials aws-prod \
  --region us-east-1 \
  --vm-type g6e.xlarge \
  --require-baked
```

If the baked image is not found for the exact digest/base-family/region/account,
the API rejects the submit before creating a deployment.

Example error:

```text
No baked image found for ghcr.io/org/app:tag digest sha256:... in aws-prod/us-east-1 for base family gpu-ubuntu22. Run `anycloud bake create ...` first or remove `--require-baked`.
```

### API and data model

Add:

```ts
export enum DeploymentType {
  Job = 'job',
  Server = 'server',
  Bake = 'bake',
}

export type DeploymentTypeValue = 'job' | 'server' | 'bake';
```

The `deployments.deployment_type` column is already `TEXT`, so this does not
need a schema migration.

Remove public `bake?: boolean` from `DeploymentRequest`.

Add:

```ts
requireBakedImage?: boolean;
```

For bake-create requests:

```ts
deploymentType: DeploymentType.Bake;
requireBakedImage: false | undefined;
```

The existing DB `bake` column can remain for legacy rows and diagnostics. For
new bake deployments, set `bake = true` if that simplifies status output, but
the deploy path should key off `deploymentType === DeploymentType.Bake`, not the
boolean column.

### Server validation

For `DeploymentType.Bake`, reject:

- bucket sync options
- `persist`
- `persistBucket`
- server-only ingress behavior
- command overrides that only affect `docker run`

Require:

- resolvable linux/amd64 digest
- provider supports `CloudImageBaker`
- pinned credential
- pinned region
- concrete launch target for v1

For `requireBakedImage === true`, reject:

- missing image digest
- providers without baked-image lookup support
- unpinned compute in v1
- missing region in v1
- ambiguous target in v1

Then perform a provider preflight lookup before `createDeployment`.

### Preflight design

Current launch-time lookup happens inside providers:

- AWS computes `baseImageFamily` in `getAmiId(gpuRuntime)`, then calls
  `getPrebakedImage(digest, baseImageFamily)`.
- Azure computes `baseImageFamily` in `newVM`, then calls
  `getPrebakedImage(digest, baseImageFamily)`.

For `--require-baked`, do not duplicate this logic in the route. Instead expose a
provider-level preflight helper that shares the same base-family logic as launch.

Suggested interface:

```ts
interface BakedImageLaunchResolver {
  resolveLaunchBakedImage(params: {
    imageDigest: string;
    gpuRuntime: ImageRuntime;
  }): Promise<{
    imageId: string;
    baseImageFamily: string;
  } | null>;
}
```

AWS implementation:

- call the same `getAmiId(gpuRuntime)` helper used by launch
- use returned `baseImageFamily`
- call `getPrebakedImage(imageDigest, baseImageFamily)`
- return `{ imageId, baseImageFamily }` on hit

Azure implementation:

- factor the existing `wantsNvidiaImage` / VM-family base-family selection out of
  `newVM`
- call `getPrebakedImage(imageDigest, baseImageFamily)`
- return `{ imageId, baseImageFamily }` on hit

The preflight route should fail if the result is null.

### Deploy flow

Current flow:

```ts
await provisioning;
await initializing;
await downloading;
if (props.bake) await baking;
if (hasBuckets) await syncing;
await starting;
await running;
```

Proposed flow:

```ts
await provisioning;
await initializing;
await downloading;

if (props.deploymentType === DeploymentType.Bake) {
  await baking;
  await updateState(Completed);
  return;
}

if (hasBuckets) await syncing;
await starting;
await updateState(Running);
```

Bake failure should move the bake deployment through existing retry behavior and
eventually to `failed` if retry attempts are exhausted.

### State semantics

Use `DeploymentState.Completed` for successful bake deployments in v1.

Pros:

- No new state enum.
- Existing terminal cleanup path works.
- Existing list/status terminal behavior mostly works.

Cons:

- `completed` means "bake completed", not "container exited 0".

This is acceptable because `deploymentType: bake` disambiguates the meaning. If
that proves confusing in status output, add presentation text later rather than
introducing a new terminal state in the first PR.

### Retry and cleanup

Bake deployments should reuse existing retry mechanics:

- failures in `downloading` or `baking` transition to `retrying`
- retry keeps existing VM for post-provisioning failures where possible
- retries can reuse Docker layers after a failed bake
- exhausted retries mark deployment `failed`
- terminal cleanup reconciliation removes VMs after `completed` or `failed`

No workload ever starts for `DeploymentType.Bake`.

### Interaction with cache hits

If a bake deployment provisions a VM that already booted from a matching baked
image, treat it as success and complete without re-baking.

The artifact already exists for the requested digest/base-family/account/region.
Completing quickly is idempotent and avoids creating redundant cloud images.

## Alternatives considered

### Keep `submit --bake` / `serve --bake`

This preserves the current UX, but it keeps bake semantics mixed with workload
semantics. It also leaves the hard question of whether bake failure should fail
the workload.

### Add a `bakeOnly` flag to jobs

This is smaller than a deployment type at first, but it obscures status and
validation. A bake run is not a job: it has no workload start, no app exit code,
and no server endpoint.

### Add `DeploymentState.Baked`

This is semantically clean, but it touches more transition/status/list/test
surface than is justified for v1. `deploymentType: bake` plus
`state: completed` is enough to disambiguate successful bake deployments.

### Enforce `--require-baked` inside provider launch only

This is safer than silent cold launch, but it still creates a deployment row and
may enter provisioning before failing. The requested behavior is a preflight, so
the API should reject before deployment creation.

## Risks & caveats

Production code impact:

- CLI command changes: 100-200 LOC
- request/types/validation: 150-300 LOC
- provider preflight helper: 150-300 LOC
- deploy-flow changes: 50-120 LOC

Tests/docs impact:

- unit tests: 500-900 LOC touched
- docs/changelog/reference updates: 150-300 LOC
- integration helper updates: 200-500 LOC touched

Expected total: 1,000-2,000 lines touched, mostly tests and docs.

Risk is medium. The highest-risk areas are:

- route validation and preflight target exactness
- avoiding duplicated base-family logic
- state transitions around `completed` and terminal cleanup
- removing existing `--bake` assumptions from tests and docs

This RFC does not solve unpinned baked-only scheduling. Supporting that later
would require the scheduler to consider baked-image availability across
candidate accounts, regions, VM types, and base families before target
selection.

## Implementation plan

1. Add `DeploymentType.Bake` and `requireBakedImage`.
2. Remove `--bake` from `submit` and `serve`.
3. Rename CLI command group from `baked` to `bake`.
4. Add `bake create`.
5. Update `/v1/new` parsing and validation for deployment type `bake`.
6. Add provider preflight helper for baked launch resolution.
7. Enforce `--require-baked` in `/v1/new` before `createDeployment`.
8. Change deploy flow to stop after successful `bakeStep` for bake deployments.
9. Keep normal job/server cache-hit behavior unchanged.
10. Update docs and CLI reference.
11. Update unit and integration tests.

## Test plan

### CLI

- `anycloud bake create` sends `deploymentType: 'bake'`.
- `anycloud bake list/copy/prune` call the existing baked-image APIs.
- `submit --bake` is rejected/unknown.
- `serve --bake` is rejected/unknown.
- `submit --require-baked` forwards `requireBakedImage: true`.
- `serve --require-baked` forwards `requireBakedImage: true`.

### Routes

- bake create stores `deployment_type = 'bake'`.
- bake create rejects missing digest.
- bake create rejects unsupported providers.
- bake create rejects buckets/persist/server-only options.
- `requireBakedImage` rejects unpinned compute in v1.
- `requireBakedImage` rejects when preflight lookup misses.
- `requireBakedImage` succeeds when preflight lookup hits.

### Deploy service

- bake deployment runs provisioning, initializing, downloading, baking.
- bake deployment does not run syncing, starting, or publish server endpoint.
- bake success marks deployment completed.
- bake failure records `bake:failed` and transitions to retrying.
- normal job/server no longer enters `baking`.
- normal job/server still skips pull on `prebakedImageId` hit.

### Providers

- AWS preflight uses same base-family logic as launch.
- Azure preflight uses same base-family logic as launch.
- Preflight miss does not create any VM/cloud resource.

## Open questions

1. Should v1 require `--vm-type`, or is a single `--gpu-type` acceptable if it
   resolves to exactly one launch target?
2. Should `bake create` allow servers' Docker runtime flags like `--gpus` and
   `--runtime`, or should it accept only flags that influence base-image family
   and disk layout?
3. Should status render successful bake deployments as `completed` or as a
   command-specific label like `baked` while keeping the stored state
   `completed`?
4. Should a bake deployment that boots from an existing baked image append
   `bake:completed` or only `bake:hit`?

## Decision

Superseded without implementation. Workload baking was removed in
an earlier change, and the final
delivery contract in RFC 0013 uses full registry pulls rather than a separate
bake artifact or command.

# Adding Providers

This is the internal playbook for adding an AnyCloud compute provider. It is both a mechanical checklist and a record of lessons learned from earlier provider work.

Do not start by designing a new abstraction. Start with the cheapest spike that proves the provider can satisfy the AnyCloud control-plane contract, then make the smallest code change that the spike justifies.

## Current State

Audited on 2026-10-08, after the Cloudflare Containers spike, and updated when node pools, Kubernetes Deployments, and node pool Services were removed. The `Kubernetes` cloud provider value was retired on 2026-10-02.

AnyCloud currently has one shipped workload-control shape:

| Shape   | Providers                      | Workload shape                                                                  | Completion                |
| ------- | ------------------------------ | ------------------------------------------------------------------------------- | ------------------------- |
| VM host | AWS, Azure, GCP, Lambda, Local | Provision VM, SSH in, install Docker and rclone, run the user image with Docker | `docker inspect` over SSH |

The important seam is lifecycle ownership. VM-host runtimes use SSH endpoint data (`CloudVM.sshHost` and `CloudVM.sshPort` let a provider return an address that differs from `ip:22`, as with Local's mapped SSH port).

**Capability is declared by the provider object it returns, not by a central table.** Base compute,
storage, and some optional capabilities are constructed through the shared factories in
`gateways/cloud.ts`; branded capabilities such as `CloudStorage` and
`CandidateRegionFilter` must come from those factories. Optional compute capabilities such as
Spot launch and terminal auth classification must be explicitly attached by `createCloudCompute`,
not inferred from same-named methods on a provider class. There is no
`CLOUD_CAPABILITIES` table. Inert per-provider data
(credential mode, defaults, catalog file) lives in the split registry
(`PROVIDER_DATA` shared + `PROVIDER_IMPL` server-only). Runtime provider roles
live in `PROVIDER_IMPL` as explicit compute, storage, API-ownership, and
account-catalog-overlay constructors. The one account-level concern that isn't
compute-gateway behavior
— the quota-increase API — instead lives in a small server-side `QUOTA_PROVIDERS` registry (a cloud is
quota-capable iff it's registered; same drift-free principle, just not hung off the compute gateway).

Cross-identity S3 access uses scoped, short-lived tokens (AWS STS, or Cloudflare R2 temporary credentials) minted through the `ScopedStorageTokenMinter` capability on branded `CloudStorage`; `validateStorageCapabilities` checks `canMintScopedStorageToken(storage)` rather than a hardcoded cloud or parallel flag.

## Hard Rules

1. Spike before designing.
   Prove the provider shape with its real control transport, real readiness polling, and the smallest live or local resource that exercises the unknowns. Use the spike result to decide the interface.

2. Use one control plane.
   One runtime must own the whole workload lifecycle. Providers are VM hosts operated over SSH; scheduler-controlled execution belongs to a substrate that owns creation, readiness, completion, operations, and deletion through its own API, as RFC 0046 plans for Slurm.

3. Persist a reconstructible control identity.
   For SSH this is provider identity plus endpoint facts, such as a marketplace VM's mapped SSH port. Never persist only a process-local port-forward, socket, or generated Pod name. A restarted API must be able to observe and clean up the same resource.

4. No speculative capability axes.
   Add flags, migrations, and branches only when the provider being landed consumes them. Dead columns and unused interfaces were a failure mode in an earlier provider effort.

5. Live-resource tests cannot be the only merge gate.
   Unit tests and local deterministic tests should gate CI. Real cloud, marketplace, cluster, and capacity tests are required for release confidence, but they must not be the only path to green CI.

## Execution Models

### VM Host

This is the default path. Implement `CloudCompute.newVM()` so it returns a routable `CloudVM`. After that, the existing deploy path does the rest:

- `provisionVMs()` creates VMs through `compute.newVM()`.
- `initializeStep()` SSHs into each VM and installs Docker and rclone.
- `downloadStep()` pulls the image.
- `syncStep()` uses supervisor-managed rclone services for buckets.
- `startStep()` runs the Docker container.
- `checkJobCompletion()` uses `DockerManager.getContainerStatus()`.

Use this model when the provider gives us a machine where we can SSH as root or an equivalent user and run Docker.

When a provider boots GPU guests from templates, qualify guest GPU initialization and workload CUDA execution whenever a template changes: a compatible host driver does not establish guest driver compatibility. GPU-only bucket-sync profiles run a CUDA computation inside the workload so MACE's CPU fallback cannot produce a GPU qualification pass.

### Container Platforms

Classify a container platform by what its container can do, not by what it is called. If a container gives root SSH and `dockerd` starts inside it, it is a VM host: `newVM()` returns it and the steps above run unchanged. The Cloudflare Containers spike (run 37738433193) passed `initializeVM` and `verifyVmContainerProfile` this way inside Cloudflare's microVM, and a Modal Sandbox on its `vm` runtime ran the startup steps, bucket sync, and confirmed release through a draft gateway (run 37800321693). Runtimes on one platform differ: under Modal's gVisor, its only GPU runtime, Docker starts only without its bridge network, and containers reach the GPU through CDI (`--device nvidia.com/gpu=all`) rather than `--gpus` (run 37814473423). Probe for this first, alongside KVM templates and machine images.

A platform whose containers cannot host Docker over SSH is not a provider. Scheduler-controlled execution belongs to a substrate with its own records and runtime, as RFC 0046 plans for Slurm; see the Provider registry in [ARCHITECTURE.md](ARCHITECTURE.md#provider-registry).

### Hosted API

Kubernetes is not a provider: it runs only the hosted API on its management VM; see [Cluster lifecycle and restore](ARCHITECTURE.md#cluster-lifecycle-and-restore). A provider that hosts the management VM passes the `resourceScoped` operations (`CloudResourceCompute`) to `createCloudCompute`, as AWS, Azure, and GCP do.

## Provider Qualification

Before writing a gateway, classify the provider shape and write probes for the facts the code would rely on.

| Shape                                    | Status              | Main question                                                                       |
| ---------------------------------------- | ------------------- | ----------------------------------------------------------------------------------- |
| VM with SSH and Docker                   | Supported           | Can `newVM()` return an SSH-reachable host that satisfies the complete VM contract? |
| Container with root SSH and Docker       | Supported (VM host) | Does it pass the qualification sequence below?                                      |
| Container without SSH or Docker          | Not a provider      | Its scheduler belongs to a substrate                                                |
| Ephemeral job erased immediately on exit | Out of scope        | Breaks exit-code and log inspection before AnyCloud can publish terminal state      |
| Provider-managed ingress only            | Partial             | Jobs may work; `serve` likely needs a separate ingress path                         |
| Multi-node or gang-scheduled jobs        | Not supported       | The VM runtime executes one workload target                                         |
| Dynamic marketplace pricing              | Special handling    | Static catalog and launch-time offer ranking diverge                                |
| Provider-durable volumes                 | Special handling    | Must decide whether provider volume or AnyCloud bucket sync owns persistence        |

Qualify a provider in an `experiments/<name>/` proof dispatched through the Spike workflow, in this order, through the real `createCloudCompute()` wrapper, recording each phase's duration:

1. `newVM()` returns a `CloudVM` and SSH becomes ready. Gate on SSH, not on the provider's status: Cloudflare reported a container running before it was placed.
2. `initializeVM` installs Docker and rclone, and `docker info` reports `overlay2`; `vfs` works but copies every layer. A host without systemd gets `overlay2` from an `/etc/docker/daemon.json` in its image.
3. A Job's exit code and logs read back through `DockerManager.getContainerStatus()`.
4. `verifyVmContainerProfile` (`test/integration/helpers/vm-container-profile.ts`) passes.
5. `syncStep` moves data through a real bucket.
6. `terminateVMs()` returns the ID, a fresh observation finds it gone, and `getAllVMs()` no longer lists it.

Also probe what the sequence cannot show: identity that survives an API restart, maximum lifetime and provider-initiated restarts (Modal caps a Sandbox at 24 hours; Cloudflare rollouts send SIGTERM), eviction, and GPU behavior for arbitrary images. Promote the accepted behavior into `src/` and `test/`, then delete the experiment.

## Mechanical Checklist

### 1. Add Provider Values to Their Owners

Update the canonical owners:

- add `CloudType`, provider credential classes, discriminated credential
  interfaces, `CloudCredentials`, and `CloudConfig.credentials` in
  `src/shared/cloud.ts`
- add API request or response fields to the owning schema under
  `src/shared/api-contract/` only when they are client-visible

Import these definitions directly from their owners; do not add a convenience
re-export. Avoid adding workload or VM columns unless a shipped path reads
them.

### 2. Add the provider to the registry

There is no `CLOUD_CAPABILITIES` table. Capability is a gateway interface (Step 3); only inert
classifications/facts live in the registry, which is split in two (both full `Record<CloudType, …>`, so
adding a `CloudType` won't compile until both have an entry):

- **`src/shared/providers.ts` — `PROVIDER_DATA`** (pure data, imported by both the CLI and the server,
  no gateway/SDK imports). Add an entry: `computeCredentialMode`, `defaultRegion`, `defaultVmType`,
  `catalogFile` (`null` for no static catalog, e.g. Local).
- **`src/api/services/cloud-config.ts` — `PROVIDER_IMPL`** (server-only; imports the gateway classes).
  Add an entry: `construct(config)` (and `credsFromRawInlineEnv` once inline-env creds are server-side).

Update `extractCredentials()` for the new credential shape (its `default:` is an `assertNever`, so a
missing case fails the build).

### 3. Implement the Gateway

Create `src/api/services/gateways/<provider>.ts`.

Every compute provider returns `CloudCompute` through `createCloudCompute(...)`
from `src/api/services/gateways/cloud.ts`. Provider files pass raw operations
into the factory and keep the gateway lifecycle helpers private; API/scheduler
code should not call same-named methods on a provider class.

| Provider op                     | Contract                                                                                     |
| ------------------------------- | -------------------------------------------------------------------------------------------- |
| `rawValidateCredentials()`      | Make a cheap real API or SSH call and throw on bad credentials                               |
| `rawCleanupOrphanedResources()` | Find AnyCloud-owned abandoned resources; support dry-run                                     |
| `rawClassifyError()`            | Map provider errors to retry behavior                                                        |
| `rawNewVM()`                    | Create or acquire one workload endpoint and return immutable `CloudVM` data                  |
| `rawRequestVMTermination()`     | Request deletion of one real provider VM ID; throw if the request fails                      |
| `observeVMReleaseOnce()`        | Return one `present`, `release-candidate`, or `unknown` provider observation for an exact ID |
| `rawTerminateNetworking()`      | Delete workload-scoped networking; no-op if none exists                                      |
| `rawGetAllVMs()`                | Return active provider resources for cleanup and diagnostics                                 |
| `rawUpsertFirewall()`           | Idempotently configure access, or warn/no-op when unsupported                                |

For NAT or tunnels, `rawNewVM()` must set `sshHost` and `sshPort`. Leave `ip` as the public or diagnostic provider IP, but assume SSH callers use `sshHost ?? ip` and `sshPort ?? 22`. `ip` may be only diagnostic, such as the address of Modal's shared TCP proxy, so code that keys a VM by `ip` (as `waitForSshReady` and `waitForContainerHealth` poll keys do) must not assume it is unique. A host reachable only through a provider CLI, such as Cloudflare's `wrangler containers ssh` as an OpenSSH `ProxyCommand`, has no `CloudVM` field yet; adding one is that provider's first `src/` change, and the proxy command must be rebuilt from the provider ID (Hard Rule 3). The host-startup and storage helpers also open their transports as `root`, so a provider whose SSH user differs (Cloudflare accepts only `cloudchamber`, which lands as uid 0) needs `sshUsername` threaded through them.

`createCloudCompute()` owns the public `terminateVMs()` fan-out. Providers
supply one-ID `rawRequestVMTermination()`, an optional `isPlaceholderVMId()` predicate
for locally recorded placeholder IDs, and an optional `terminateVMsConcurrency`
cap. The shared wrapper returns only placeholders and IDs whose request succeeded
and whose release observations satisfy `releaseConfirmationPolicy` (one
observation by default). A provider observation cannot return final `released`;
`present`, `unknown`, and a still-unconfirmed candidate keep the durable VM row
open so retry cleanup can safely try again. Providers with eventually
consistent views declare multiple observations and a minimum interval, as
Lambda does with two complete point/list observations ten seconds apart.

Beyond the base `CloudCompute`, expose optional capabilities through the
shared factories in `gateways/cloud.ts`. Do not rely on a provider class
structurally matching a public interface; public compute and storage objects are
branded, and constructed capabilities are the capability declaration.

| Capability                | Declaration path                                           | Guard                          |
| ------------------------- | ---------------------------------------------------------- | ------------------------------ |
| object storage            | `createCloudStorage(...)` via the provider registry        | `isCloudStorage`               |
| scoped bucket-sync tokens | `ScopedStorageTokenMinter` on `createCloudStorage`         | `canMintScopedStorageToken`    |
| Spot launch               | `spotLaunch` on `createCloudCompute(...)`                  | `canLaunchSpotPools`           |
| stopped-VM observation    | `stoppedVmObservation` on `createCloudCompute(...)`        | `canObserveStoppedVms`         |
| stopped-VM restart        | `stoppedVmRestart` on `createCloudCompute(...)`            | `isPreemptible`                |
| terminal auth detection   | `terminalAuthErrorClassifier` on `createCloudCompute(...)` | `canClassifyTerminalAuthError` |
| per-account region filter | `createCandidateRegionFilter(...)` on `CloudCompute`       | `canFilterCandidateRegions`    |

Spot is three capabilities. A VM spot Job needs Spot launch, the exact-ID
stopped-VM observation, and restart: `isPreemptible` is observation plus
restart. A provider that deletes evicted VMs omits `stoppedVmRestart`; don't
add no-op methods.
Only clouds that can positively distinguish terminal stored-secret failures
pass `terminalAuthErrorClassifier`; otherwise bad credentials remain on the
self-healing transient block path.
`CandidateRegionFilter` is optional pre-deploy hygiene: AWS, Azure, and GCP use
it to drop known-unusable account/region candidates before a provisioning
attempt is spent (the optimizer narrows on `canFilterCandidateRegions`). Clouds
without a per-account region gate omit `candidateRegionFilter`. The
quota-increase API is _not_ in this table — it's the `QUOTA_PROVIDERS` registry
(Step 10), since it's an account-level concern rather than compute-gateway
behavior.

When VM launch resolves a provider-owned base image, expose that lookup through
`CloudBaseImageResolver` and call the same provider implementation from its
canary. The resolver accepts only image-selection context and an authenticated
image client; do not construct a full compute gateway or supply a placeholder
VM type for an image-only check.

An expensive account-specific inventory can feed that filter through the
separate `CatalogOverlayProvider` role. `PROVIDER_IMPL.catalogOverlay` is an
exhaustive factory-or-null decision; Azure implements it, while every other
provider currently declares `null`. Overlay reads must be synchronous and
fail-open. Refresh/parse/diff work stays off the placement path, and a stale
negative fact ranks a target as unknown rather than deleting a structural
catalog target. The snapshot has no freshness TTL: keep the last good account
observation until an explicit invalidation removes it or a catalog target
fingerprint makes it incompatible. Provider-owned durable caches may preserve
compatible observations across process restarts, as Azure's does, but
credential-scoped overlay data must remain separate from the shared catalog
cache.

Candidate preflight must be latency-safe. Construct it with
`createCandidateRegionFilter(...)`, which owns identical-sweep coalescing,
pending-share limits, wait timeouts, fail-open logging, and cache completeness.
Use `runCandidatePreflightUnitSweep` inside provider preflight code for any
per-region / per-zone fan-out so one slow control-plane endpoint fails open for
that unit instead of timing out the entire scheduler decision. Tests must cover
coalescing, whole-sweep fail-open, partial-result cache rejection, and one hung
regional read with the rest of the regions still returning useful filter data.

### 4. Register the gateway constructor

Add the provider's runtime constructors to `PROVIDER_IMPL` in
`src/api/services/cloud-config.ts` (Step 2): `compute`, optional `storage`, and
an explicit `catalogOverlay` factory or `null`.
Storage is an explicit registry entry, not an interface discovered from the
compute gateway. (Quota is the exception — it's reached through the
`QUOTA_PROVIDERS` registry, not by constructing the compute gateway; see Step
10.) Check credential encryption/decryption paths still round-trip.

### 5. Wire CLI Provider UX

Update CLI code:

- `src/cli/utils/providers.ts` for provider string normalization
- `src/cli/commands/credentials/new.ts` for interactive and non-interactive credential creation
- `src/cli/services/non-interactive.ts` (`getCredentialsFromEnv`) and `src/cli/services/config.ts` (`hasInlineCredentialEnv`) for the inline env-credential submit path — a provider wired only into `credentials new` still cannot be submitted with `PROVIDER_API_KEY` env vars until both of these recognize it
- `src/cli/services/slurp/<provider>.ts` only if there is a native credential importer
- config commands if provider-specific defaults or prompts are needed
- `anycloud gpus`, `anycloud regions`, and pricing output if catalog behavior changes

Provider names in user-facing copy should be lower-case CLI names, but internal types should continue using `CloudType`.

### 6. Add Catalog Support, If Applicable

Only inventory-backed providers need catalog wiring. VM clouds and marketplaces usually have SKU or offer inventory that can be approximated by catalog rows.

The current catalog path is:

- CSVs live under the user's `~/.anycloud/catalogs`
- `PROVIDER_DATA[cloud].catalogFile` (`src/shared/providers.ts`, consumed by `src/shared/catalog/index.ts`) gives the CSV filename, or `null` for no static catalog
- `parseCatalogCSV()` builds indexes for regions, VM types, prices, spot prices, and accelerators
- `CATALOG_BASE` fetches from `anycloud-sh/catalog`
- `needsCatalogBootstrap()` and `getCatalogs()` bootstrap missing local CSVs
- `getRegionsForVMType()`, `getVMTypes()`, `resolveWorkloadPrice()`, and GPU helpers consume the indexes

If a catalog must be generated from a provider API, implement `CloudCatalogFetcher` in `src/shared/catalog/<provider>.ts`, wire it into `scripts/fetch-catalog.ts`, and publish the resulting CSV to `anycloud-sh/catalog`. The fetch script supports Azure, GCP, and Lambda; AWS uses a prebuilt CSV.

The catalog workflow runs every three hours. Keep the previous catalog commit
for rollback, validate the candidate through `validate-generated-catalog.ts`,
and publish it before qualifying new CI GPU choices. Catalog publication does
not establish VM or Job qualification; inspect individual real-cloud results
and native cleanup evidence.

CSV columns are parsed by header name. Include at least:

- `InstanceType`
- `Region`
- `AvailabilityZone` when zones matter, especially GCP
- `vCPUs`
- `MemoryGiB`
- `Price`
- `SpotPrice`
- `AcceleratorName`
- `AcceleratorCount`
- `GpuInfo`
- `Generation`

If provider catalog names differ from runtime API names, normalize in `parseCatalogCSV()` and add unit tests in `test/unit/shared/catalog.spec.ts`.

If a provider has dynamic offers, static CSV is only a hint. The gateway must still search and rank live offers at launch, then rotate when an offer disappears or never becomes SSH-ready.

A marketplace reliability/"verified" score reflects compute uptime, not SSH routing: a top-reliability host can still expose an unusable control-plane endpoint. Marketplace VM hosts should therefore require **direct** SSH through the public IP and mapped guest port; a missing or unreachable direct mapping fails that host and rotates the offer. Do not add a provider proxy as a secondary endpoint without separately qualifying it and demonstrating a provider-independent need for multi-endpoint failover.

### 7. Check Lifecycle Branches

Most VM providers should not touch `src/api/services/workload-workflows/vm-host-startup.ts`. They should satisfy the VM-host contract and use the existing steps.

Only touch lifecycle code when the execution model demands it:

- VM-host providers use the full `vm-host-startup.ts` state machine, Docker-over-SSH completion, Docker exec/logs, and supervisor rclone health
- multi-node jobs are not supported by the current VM runtime

If a lifecycle change looks general, first prove it with a provider spike. Do not land an unused interface.

### 8. Storage, Buckets, and Credentials

Native storage providers return branded `CloudStorage` through
`createCloudStorage(...)`. Cross-cloud bucket sync uses separate input and
output storage credentials.

Name storage capability interfaces after the provider operation they expose, not the orchestration scenario that first needs them. For example, a provider that can mint scoped bucket-sync credentials passes `ScopedStorageTokenMinter` operations into `createCloudStorage(...)`; the orchestrator checks `canMintScopedStorageToken(storage)` and calls `mintScopedStorageToken(grants)` on the branded storage object. Do not add a parallel cloud-config boolean or name the boundary after the current caller/use case.

For VM-host providers, bucket sync runs on the VM through supervisor and the rclone primitives in `src/api/services/rclone-config.ts`.

Scoped cross-identity bucket credentials are **shipped for AWS S3 and Cloudflare R2**:

- The minting lives behind the `ScopedStorageTokenMinter` capability (`gateways/cloud.ts`), exposed on branded AWS and Cloudflare `CloudStorage`. AWS owns the STS GetFederationToken logic. Cloudflare (`gateways/cloudflare.ts`) mints one-bucket R2 temporary credentials returned as S3 session credentials, and exposes `s3Endpoint` so rclone's shared `[r2]` remote reaches the account and jurisdiction per bucket.
- AWS source storage credentials used for `GetFederationToken` must be long-term IAM-user keys. Temporary AWS source credentials with `sessionToken` are rejected by the AWS `ScopedStorageTokenMinter`; the minted scoped credentials returned for rclone still include `AWS_SESSION_TOKEN`.
- Each `ScopedStorageTokenMinter` implementation must throw rather than return standing credentials; the AWS gateway enforces the STS `SessionToken` shape.
- GCP/Azure don't implement `ScopedStorageTokenMinter` (no scoped cross-cloud cred path yet); same-cloud GCS access boundaries / Azure user-delegation SAS are a future tier.

**Workload env and named secrets.** On the VM path, user env rides `docker run -e` and named secrets ride `--env-file` written over SSH to tmpfs (`docker.ts:writeSecretsEnvFile`).

### 9. Migrations

Add migrations only for data the shipped path reads. Use the next sequential file in `migrations/`.

If a provider needs new per-VM connection data, follow the pattern of `0051_add_vm_ssh_endpoint.sql` and update:

- `src/api/services/entities.ts`
- `src/api/services/repositories/provisioning-attempts.ts` and `repositories/workload-queries.ts`
- API route response shapes in `src/api/routes/cli.ts`
- CLI SSH context in `src/cli/services/ssh.ts`

Check for migration-number collisions before pushing.

### 10. Cost, Quota, and Cleanup

If the provider has a quota-increase API, add the provider's `requestQuota`/`getQuotaStatus` orchestration
to a `quota/<provider>.ts` module and register a `QuotaProvider` factory under the cloud in
`QUOTA_PROVIDERS` (`src/api/services/quota/handler.ts`). Quota is account-level, not compute-gateway
behavior, so it lives in this registry rather than on the gateway: a cloud is quota-capable iff it's
registered. The CLI forwards quota requests and the server errors for clouds not in the registry — there
is no static "quota clouds" list. If the provider has no quota API, do nothing (no entry to add).

If the provider has no billing API integration, make cost calculation no-op or catalog-price based. Do not invent precision. Marketplace launch prices can differ from static catalog prices, so show estimates as estimates.

Cleanup must be conservative:

- only clean resources with AnyCloud labels or names
- use age guards for orphan cleanup
- treat not-found as success during delete
- return only confirmed-deleted IDs from `terminateVMs()`

### 11. Tests

Minimum tests for a normal catalog-backed provider:

- catalog parser and normalization unit tests
- cloud config defaults and capability tests
- credential wizard tests
- gateway unit tests for pure ranking, parsing, and error classification
- cleanup tests for orphan filtering and confirmed-deleted semantics
- integration sad-path test, following `test/integration/*-sad.spec.ts`
- integration cleanup test, following `test/integration/*-cleanup.spec.ts`
- bucket sync shell test if storage is supported
- one real-resource happy-path run before release

For a marketplace VM-host provider, add a target to the Dedicated
Job bucket-sync contract (`test/integration/e2e/specs/contracts/dedicated-job/`).
In addition to the standard Docker/rclone checks,
cross-check the persisted SSH host/port and base-image ID against the provider's
live instance response, prove the temporary account key is gone, and exercise
`ssh-access`, `exec`, and `logs` through the production API.

## Branch-Audit Checklist

Before publishing a provider PR or updating this playbook:

1. Run `git status --short --branch` and record the branch you verified.
2. Grep every symbol you cite. Do not copy line numbers from old plans or agent transcripts.
3. Trace the newest provider end to end through enum, credentials, capabilities, catalog or explicit no-catalog decision, gateway factory, CLI credentials, deploy lifecycle, monitor, and tests.
4. Identify what is shipped, what is spiked, and what is only proposed.
5. Check that every user-facing docs change belongs under `docs/`, while internal symbol-heavy guidance stays in this file.

## External Reference Points

These are not designs to copy blindly, but they validate the direction:

- SkyPilot's Slurm docs require SSH access to a login node, submit with `sbatch`, inspect with Slurm CLI commands, cancel with `scancel`, and explicitly say Slurm support does not provision clusters or support serving yet: https://docs.skypilot.co/en/latest/reference/slurm/slurm-getting-started.html
- SkyPilot's Kubernetes docs describe in-container SSH servers and port handling for pods, including host-network cases: https://docs.skypilot.co/en/latest/reference/kubernetes/kubernetes-setup.html
- dstack's Kubernetes backend requires a kubeconfig plus a proxy jump for SSH traffic into containers: https://dstack.ai/docs/guides/kubernetes/
- dstack's Slurm material is framed as migration and fleet mapping, not a Slurm backend equivalent to Kubernetes: https://dstack.ai/docs/guides/migration/slurm/

The lesson is to pick one complete control plane per substrate. SSH is the provider control plane for machines and for containers that can host Docker; a scheduler API belongs to a substrate that covers the entire lifecycle through it.

# RFC 0012: Remove workload baking and use best-effort eStargz lazy loading

> Status: Superseded by [RFC 0013](./0013-standardize-gpu-image-delivery.md)
> Date: 2026-07-13
> Updated: 2026-07-19 to record the GPU MACE performance findings and
> qualification contract
> Author: Codex draft

This RFC records an intermediate implementation, not the current contract.
Workload-image baking remains removed, but RFC 0013 subsequently removed eStargz
detection and host configuration in favor of full pulls. The material below is
historical and is retained for the rationale and benchmark record.

## Historical summary

Remove workload-specific VM images and always use the registry image as the
workload artifact. When the selected `linux/amd64` manifest has an eStargz layer
annotation, AnyCloud records that manifest as an acceleration candidate and
tries to run Docker on the stargz snapshotter. If activation safely completes
on another driver, the deployment continues through Docker's ordinary full-pull
path and reports the observed outcome. Unexpected initialization faults use the
normal deployment retry path.

The accelerated artifact remains a normal OCI image. It has no separate
top-level acceleration index, no AnyCloud-specific descriptor graph, and no
special deployment flag. Users produce it in their existing build system with
`docker buildx` or convert an existing image with `nerdctl`.

For GPU MACE, "lazy-loaded" is not itself a performance result. A reliable
upgrade requires a profiled derivative of the same logical image to reach first
inference in at most 60% of the full-pull time on one controlled pair on each of
AWS, Azure, and Lambda. The July Azure runs did not meet that contract.

This RFC also records the hard removal of `--bake`, `--no-bake-cache`,
`--warm-image`, `anycloud baked`, workload AMI creation and lookup, and their
API, database, provider, status, and test surfaces. Historic `baking` events
remain readable.

This RFC supersedes RFC 0011.

## Context

### Workload baking moved I/O instead of removing it

The removed bake path fully pulled and unpacked a workload image, captured the
VM root volume as a cloud image, and launched future deployments from that
image. A new volume created from the cloud snapshot still began with cold
snapshot-backed blocks and an empty Linux page cache.

```text
fresh pull:   registry → disk + page cache → workload
workload AMI: snapshot store → fresh volume → page cache → workload
lazy image:   registry ranges → snapshotter cache + page cache → workload
```

Workload baking also created a second artifact system alongside the registry:

- cloud images were scoped to account, region, base family, and workload digest;
- images and snapshots needed lookup, copying, retention, pruning, and recovery;
- launch behavior depended on cache hits and snapshot state;
- the CLI, SDK, state machine, database, providers, status, and CI all carried
  bake-specific behavior.

The implementation therefore removed the workload-image system instead of
keeping it as a fallback or compatibility path.

### Historical prototype evidence

The investigation compared a normal registry pull, cold and partially warmed
workload AMIs, and a SOCI prototype on one AWS MACE inference run:

| Leg                       | Download/warm | Queue → running | Process → inference | Derived queue → inference |
| ------------------------- | ------------: | --------------: | ------------------: | ------------------------: |
| Fresh GHCR                |      123.176s |        181.148s |              4.997s |                  186.145s |
| Baked cold                |        0.006s |         73.965s |             98.485s |                  172.450s |
| Baked partial warm        |       76.510s |        140.378s |             38.567s |                  178.945s |
| Historical SOCI prototype |        9.187s |         77.919s |             29.563s |                  107.482s |

This was one image, workload, region, availability zone, and sequence of Spot
instances. It supported removing broad workload-volume warming and the regional
workload-image system. It does **not** validate eStargz, establish an eStargz
readiness target, or create a performance SLA.

The historical SOCI result is the comparison target for GPU MACE qualification:
approximately a 40% reduction in total time to first inference. It is not an
eStargz baseline. SOCI used a different snapshotter, image, cloud, and image
size, so later eStargz runs must not be presented as reproducing it unless they
meet the controlled-pair contract below.

SOCI did incur deferred-I/O cost: its process-to-inference phase rose from
4.997 seconds to 29.563 seconds. It still won because the approximately
114-second download saving was much larger than that approximately 25-second
penalty. Likely contributors were SOCI's coarser 4 MiB zTOC spans, which
amortized scattered Python and CUDA reads, and its gentler default background
fetch schedule. In contrast, stargz v0.18.2 defaults to 50,000-byte remote
fetch granularity, whole-layer background fetch, and two concurrent background
tasks. These are mechanism-level hypotheses, not a controlled explanation: the
SOCI run also used an older, larger image on AWS.

### July 2026 GPU MACE findings

Two Azure eStargz runs used the same small source manifest and its converted
lazy derivative. Both completed the same CUDA inference with the same energy in
`westus2`, but neither demonstrated a reliable time-to-first-inference win:

| Run and snapshotter policy                         | Standard download | Lazy mount | Standard in-container | Lazy in-container | Standard total | Lazy total | Lazy / standard |
| -------------------------------------------------- | ----------------: | ---------: | --------------------: | ----------------: | -------------: | ---------: | --------------: |
| 29681616849, default background fetch              |          183.827s |     4.923s |               13.590s |          197.556s |       398.811s |   418.712s |           1.050 |
| 29692792159, `no_background_fetch=true` diagnostic |          184.037s |     5.007s |               13.992s |          192.701s |       345.161s |   338.824s |           0.982 |

The approximately 179-second download-to-mount saving in the second run was
almost exactly consumed by approximately 179 seconds of deferred in-container
I/O. Comparing the two runs also rules out `no_background_fetch=true` as the
primary explanation: restoring default background fetch did not return the
lazy in-container phase to the 14-second full-pull baseline. The roughly
five-second difference between lazy process times is too small, and the
cross-run total includes infrastructure variance, to establish a causal tuning
result.

Artifact inspection found that every converted layer carried
`.no.prefetch.landmark`. The tested image was therefore **unprofiled**; there
was no prioritized region and no existing profiled artifact to redispatch. A
static import and native-library audit produced a candidate list of 3,816 paths,
approximately 3.77 GB by uncompressed file size. NVIDIA libraries accounted for
about 2.05 GB, PyTorch for 0.97 GB, and Triton for 0.46 GB. This was not a GPU
runtime trace and must not be treated as proof of the first-inference working
set.

The first two attempts to produce that missing GPU profile,
29700383662
and
29700386360,
failed before the producer executed. The transient `Type=exec` systemd unit was
created with `TimeoutStartSec=0`; on the Azure Ubuntu 24.04 builder, systemd
reported `start operation timed out` in the same second and exited with status 15. Neither run published a profile proof or reached a benchmark, so they are
not performance samples and cannot be reused. An earlier change removed that property,
retained the independent 6,000-second `RuntimeMaxSec` bound, and added a static
regression test for the launch contract.

The next attempt,
29701526123,
reached the remote producer and pulled the pinned source, but rejected the
authenticated optimizer before tracing. Both the release archive and extracted
`ctr-remote` binary matched the pinned official v0.18.2 SHA-256 values; however,
that binary's `--version` output identified its embedded containerd client as
`2.2.0+unknown`. The producer had incorrectly required that output to contain
the stargz-snapshotter release version. The corrected contract authenticates
the binary by digest and retains the reported build string only as evidence.
This run also published no derivative or profile proof and is not a performance
sample.

The corrected producer in
29702061448
passed that identity gate and pulled the pinned source, but failed before the
CUDA trace because it treated `ctr-remote images inspect` as JSON. In containerd
2.2 that command renders a human image tree, so `jq` rejected its first line.
The source manifest digest now comes directly from the required digest-pinned
reference and is validated by reading the corresponding content. The target
manifest digest is taken from the optimizer's final bare digest line, with
exactly one such line required. This run likewise produced no derivative or
profile proof and is not a performance sample.

The small source image was approximately 3.04 GB compressed, while the image in
the historical SOCI run was approximately 9.83 GB compressed. Shrinking the
source can be a valid user-facing build optimization, but a result obtained by
comparing the smaller lazy image to the older larger full-pull image is not
apples to apples. Image optimization must happen before the benchmark pair
forks.

## Historical decision

### Goals

1. Keep the registry image as the portable workload artifact.
2. Remove workload-specific cloud images and their product surface.
3. Start an eStargz image lazily when the selected host can support it.
4. Preserve deployment reliability by falling back to an ordinary pull when the
   acceleration path is unavailable.
5. Resolve and persist immutable image identity when registry inspection can do
   so.
6. Show whether an acceleration candidate reached `running` with Docker on the
   stargz storage driver.

### Non-goals

- AnyCloud does not verify an eStargz TOC graph or certify every annotated layer.
- Lazy loading is not fail-closed and is not promised on every cloud, host image,
  VM family, or registry.
- There is no public `--estargz`, `--soci`, or runtime-mode flag.
- There is no persisted `soci`/`standard` mode enum.
- AnyCloud does not own a versioned lazy-loading AMI or private Azure Compute
  Gallery release pipeline.
- AnyCloud does not build, convert, sign, or attest customer images.
- `anycloud build`, a Build API, remote BuildKit workers, build context upload,
  build secrets, and GPU build steps are outside this decision. Reintroducing a
  remote builder requires a separate RFC.
- This RFC does not claim that lazy loading improves time to first inference for
  every image.

### GPU MACE performance qualification contract

GPU MACE performance claims use one immutable logical source image `S`:

```text
optimized source S ── ordinary manifest ──> full-pull leg
                   └─ format/profile only ─> lazy derivative L(S)
```

The full-pull leg runs `S`; the lazy leg runs `L(S)`. Conversion necessarily
changes registry and layer digests, so equality means identical filesystem
payload, metadata, image configuration, command, model, and runtime inputs—not
an identical manifest digest. Dependency pruning, base-image changes, model
changes, and other size reductions are allowed only while producing `S`, before
the two legs fork.

Before a timed run, the artifact verifier must prove:

- immutable source and lazy manifest digests and source-to-derivative
  provenance;
- filesystem contents, modes, ownership, links, xattrs where supported, and
  image runtime configuration are equivalent after decompression;
- every layer named by the access record has a readable TOC and a
  `.prefetch.landmark`; layers with no recorded access may intentionally carry
  `.no.prefetch.landmark`, but an artifact with no profiled layer is rejected;
- the profile was recorded with the exact pinned MACE command, model, and
  producer version; and
- both legs produce the same finite CUDA result within the test tolerance.

AWS, Azure, and Lambda must each produce at least one clean controlled pair on
the same provider target, region or zone, VM shape, disk tier, and test version.
Provider retry or failover differences invalidate the pair. The qualification
target is:

```text
lazy observer-arm → first inference
----------------------------------- <= 0.60
full observer-arm → first inference
```

This matches the approximate historical SOCI improvement instead of merely
requiring eStargz to avoid a regression. One passing pair per provider is a
release qualification signal, not a latency SLA or a statement about the
distribution of all launches.

## Artifact and inspection contract

### Ordinary OCI image with eStargz annotations

An eStargz image is an ordinary OCI image. The selected `linux/amd64` platform
manifest has normal layer descriptors, and converted layers carry:

```text
containerd.io/snapshot/stargz/toc.digest
```

The submit-time classifier treats the manifest as an eStargz candidate when
**any** layer descriptor has that annotation. It does not:

- require every layer to be annotated;
- parse or verify the referenced TOC;
- apply a minimum indexed-layer size;
- validate media-type or compression compatibility beyond ordinary manifest
  parsing;
- fetch every layer blob or perform authenticated range probes;
- distinguish a malformed advertised candidate from an ordinary image.

This is intentionally a weak capability hint. Docker and the snapshotter
determine what happens when the image is pulled.

There is no separate acceleration artifact. In particular, the shipped
contract has no SOCI Index Manifest v2 descriptor, reciprocal
`com.amazon.soci.*` annotations, sidecar zTOC graph, or top-level acceleration
digest.

### Image verdicts

`ImageVerdict` describes whether the image can run on AnyCloud's x86-64 VM
fleet, not whether its lazy-loading metadata is valid:

| Verdict        | Meaning                                                        | Submit behavior |
| -------------- | -------------------------------------------------------------- | --------------- |
| `ok`           | A `linux/amd64` manifest was found                             | Proceed         |
| `no_amd64`     | The registry definitively exposed no `linux/amd64` manifest    | Reject          |
| `not_found`    | The registry definitively returned not found                   | Reject          |
| `unauthorized` | Access remained unauthorized after the supported auth exchange | Reject          |
| `unknown`      | Network, timeout, unsupported shape, or incomplete inspection  | Proceed         |

Unknown inspection is fail-open so a transient or unsupported registry probe
does not make submit less reliable than the VM-side Docker pull. It is never a
positive acceleration verdict: if the platform manifest or its digest cannot be
read, `stargzDigest` remains null.

The authenticated product path is GHCR, using the GitHub credential for
manifest inspection and VM-side `docker login`. Public registries that implement
the ordinary OCI Distribution flow may also work, but this RFC does not qualify
them as authenticated eStargz targets.

### Digest persistence and pull identity

The deployment stores:

- `image_digest` / `imageDigest`: the resolved `linux/amd64` manifest digest,
  when inspection exposes one;
- `stargz_digest` / `stargzDigest`: the same manifest digest when at least one
  layer carries the eStargz TOC annotation, otherwise null.

`stargz_digest` is therefore an acceleration-candidate signal, not the identity
of a second artifact. Migration 0072 originally added `soci_digest`; migration
0073 renamed that column after the runtime switched to eStargz.

For a mutable tag, Docker pulls and runs the resolved digest when available.
When no digest was resolved, it uses the submitted reference and the VM-side
pull remains authoritative. An already digest-qualified reference remains as
submitted. Container start uses `--pull never` so the run step uses the image
completed by the download step.

### Producing an image

AnyCloud does not provide a build service. Users build and push externally.
BuildKit can emit eStargz directly:

```bash
docker buildx build -t ghcr.io/YOUR_ORG/model:latest -o type=registry,oci-mediatypes=true,compression=estargz,force-compression=true .
```

An existing image can be converted without rebuilding:

```bash
nerdctl image convert --estargz --oci ghcr.io/YOUR_ORG/model:latest ghcr.io/YOUR_ORG/model:esgz
nerdctl push ghcr.io/YOUR_ORG/model:esgz
```

Generic conversion is not sufficient for the GPU MACE performance claim. The
repository includes `test/docker/build-profiled-mace-stargz.sh` to run the exact
first-inference command on a Linux x86-64 GPU while `ctr-remote` v0.18.2 records
file access, then produce a zstd:chunked derivative with `--period 300`. The
producer pins the binary checksum and records the source, target, workload,
access-record, producer, and conversion settings in an artifact lock. A
profiled artifact is usable for qualification only after it is pushed by
immutable digest and the verifier confirms its landmark and provenance.

The July Azure candidate predates that artifact: it is a valid annotated
zstd:chunked image but contains only `.no.prefetch.landmark`. Calling it
"profiled," increasing a mount-time prefetch timeout, or redispatching it as a
profile test would be incorrect.

The image is submitted normally. AnyCloud has no `--estargz` flag and does not
modify the registry artifact in place.

## Runtime contract

### Eligibility

The control plane requests stargz initialization when `stargzDigest` is
non-null. Activation is opportunistic:

- the provider must use AnyCloud's VM-host execution model;
- the selected base image must already provide Docker;
- the VM must use systemd and support the snapshotter/containerd integration;
- the service, Docker configuration, registry access, and image must work
  together at runtime.

There is no provider allowlist or persisted qualification record. Kubernetes'
scheduler-native path bypasses host initialization entirely. When AnyCloud
installs Docker from its static binary because the base image does not provide
Docker, the current install path does not install or activate stargz and returns
to the full-pull path.

### Host initialization

For an eStargz candidate on a host that already provides Docker, initialization:

1. Checks whether `stargz-snapshotter.service` is active.
2. If absent, downloads `containerd-stargz-grpc` v0.18.2 from the upstream
   GitHub release, installs and starts a systemd unit, appends a
   `proxy_plugins.stargz` entry to containerd configuration, and restarts
   containerd.
3. Backs up the existing `/etc/docker/daemon.json` so a stargz configuration
   that breaks Docker can be rolled back.
4. Removes a hard-coded Docker `--storage-driver` service flag through a systemd
   override when one is present.
5. Reads the existing `/etc/docker/daemon.json`, refuses to replace a non-object
   or invalid JSON document, preserves existing daemon keys, sets
   `storage-driver` to `stargz`, and enables Docker's `containerd-snapshotter`
   feature.
6. Restarts Docker and reads `docker info --format '{{.Driver}}'`.

The installer is best effort. If the snapshotter install leaves the service
inactive, initialization keeps the current Docker driver. If the stargz daemon
configuration stops Docker from restarting, it restores the previous
`daemon.json` and restarts Docker on the default driver. If Docker starts but
reports a different driver, that observed driver is returned.

Unexpected transport failures, an invalid existing daemon configuration, or a
failed rollback can still fail the initialization step and enter the ordinary
deployment retry path. Best effort means acceleration failure is not itself a
reason to reject the image; it does not mean every host mutation error is
swallowed.

The runtime does not currently pin or validate the version of a snapshotter
already present on the base image, verify a host configuration digest, or
perform post-pull FUSE/remote-snapshot proof.

The `no_background_fetch=true` change used in one GPU MACE diagnostic is not
part of the accepted runtime contract. It changes a host-global snapshotter
policy, and the Azure comparison did not show that it caused the in-container
regression or improved total readiness. Qualification begins from the
snapshotter's defaults; tuning requires its own controlled evidence and product
decision.

### Pull and private-registry credentials

The normal Docker pull/run pipeline remains the execution interface. For
private GHCR, AnyCloud performs `docker login` before starting the detached
pull. Docker's root-owned credential file remains available to the snapshotter
for later background or on-demand reads and disappears when the VM is deleted.

The pull always uses Docker. The control plane does not switch to `nerdctl`,
direct containerd commands, or a second artifact reference.

### Fallback and status

For an eStargz candidate, the successful `running` event records:

```json
{
  "stargz": true,
  "storageDriver": "stargz"
}
```

The CLI renders:

- `[lazy-loaded]` when `stargz === true` and `storageDriver === "stargz"`;
- `[full pull]` when `stargz === true` and the observed driver is anything else,
  including null;
- no image-loading suffix for an image that was not classified as eStargz.

This is observation of Docker's selected storage driver. Product status does not
independently inspect FUSE mounts, snapshot metadata, bytes fetched, TOC
integrity, or whether every read was remote. The manual MACE harness adds
download-duration evidence, but that proof is not part of every deployment's
public status contract.

There is no separate public runtime-mode field. `stargz_digest` remains internal
deployment state, while the running-event metadata reports the outcome users
can see.

## Provider behavior

Lazy-loading activation is attached to the common VM initializer rather than a
cloud-specific scheduler mode. Current provider evidence is:

| Provider | Current host path                                                                                                                           | eStargz evidence                                       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| AWS      | The selected current Amazon Deep Learning Base OSS NVIDIA AMI; an active preinstalled stargz service is reused when present                 | Manual MACE workflow and shared assertions             |
| Azure    | dstack public community-gallery GPU definitions `dstack-cuda-0.14` and `dstack-grid-0.14`; install stargz during initialization when absent | Manual MACE workflow and shared assertions             |
| Lambda   | Lambda's provided GPU host stack; install stargz during initialization when absent                                                          | Manual MACE workflow exists; no automatic release gate |

Azure GPU scheduling is restricted to the regions where the selected community
gallery definitions are replicated. A base-image canary resolves those
competitor-owned definitions, requires at least one available image version, and
warns when a newer definition exists. The gateway supplies a community-gallery
image definition rather than an AnyCloud-owned private gallery image version.

Other VM-host providers can reach the common initializer, but this RFC makes no
qualification claim for them. The implementation does not infer support from a
provider name, and the absence of an allowlist means a compatible base image may
work before it has a dedicated MACE workflow.

This architecture accepts two forms of drift:

- a preinstalled AWS or other base-image snapshotter is used without an
  AnyCloud-owned version matrix;
- Azure depends on external public gallery definitions and their regional
  replication.

The fallback path and Azure base-image canary reduce their impact but do not turn
them into immutable AnyCloud runtime releases.

## Workload-baking removal

### Removed public and runtime surface

The shipped hard cut removed:

- `--bake`, `--no-bake-cache`, and `--warm-image`;
- `anycloud baked` and its list, copy, and prune operations;
- Python SDK bake/cache/warm arguments;
- active API and cloud-config bake fields;
- the active `Baking` state and bake orchestration;
- workload AMI lookup, launch selection, creation, copying, tagging, and pruning;
- provider image-baker interfaces and bake-only tests;
- deployment `bake`, `use_bake_cache`, and `warm_image` columns;
- VM `base_image_family` and `prebaked_image_id` columns.

These names have no compatibility semantics. The current HTTP handlers do not
special-case stale `bake`, `useBakeCache`, or `warmImage` JSON properties; as
unknown request keys they are ignored by ordinary request destructuring. They
do not restore baking behavior. Exact client/API version checks can still reject
an obsolete client for the normal version-mismatch reason.

Generic provider base images remain. They are the operating system and runtime
used to launch a workload VM, not a cache of the customer's image.

### Migration and historical events

Migration 0070:

1. Inserts a `retrying` event with reason
   `"workload image baking removed"` for every active deployment whose state is
   `baking`.
2. Moves those deployment rows to `retrying` and clears `next_check_at`.
3. Drops the active bake and workload-image provenance columns.

The retried deployment follows the ordinary provider-base-image and registry
pull path. No launch path can select the removed workload AMI.

Historic deployment events are immutable audit records. TypeScript exposes
`DeploymentEventState = DeploymentState | "baking"`, and the Python SDK accepts
the same historical literal. `baking` is not an active state and no new
transition can enter it.

### Existing cloud artifacts

The hard cut does not discover or delete previously created workload AMIs,
managed images, or their snapshots. They remain unmanaged in the owning cloud
account until the account owner identifies and removes them with
provider-native tooling.

AnyCloud retains no workload-image cleanup bridge. Generic provider base images
must not be mistaken for legacy workload artifacts.

## Telemetry and verification

### Unit and contract coverage

The committed tests cover:

- eStargz detection for both a single manifest and a `linux/amd64` child of an
  OCI index;
- ordinary OCI manifests leaving `stargzDigest` null and using the full-pull
  path;
- persistence through submit and serve-upgrade flows;
- digest-qualified Docker pull/run selection;
- non-lazy deployments skipping all stargz configuration;
- daemon configuration merging and idempotent activation;
- unavailable snapshotter fallback;
- rollback when the stargz Docker configuration stops the daemon;
- `[lazy-loaded]` and `[full pull]` status formatting;
- migration of active `baking` rows and preservation of historical events in
  TypeScript and Python.

`ImageVerdict.Unknown` remains non-blocking, while definitive missing,
unauthorized, and wrong-architecture images are rejected before provisioning.

### Manual MACE workflows

AWS, Azure, and Lambda each have a `workflow_dispatch` MACE workflow built on
the same helper. Each compares a normal image with a zstd:chunked derivative and
requires:

- valid persisted `imageDigest` values for both legs;
- a valid `stargzDigest` only for the eStargz leg;
- Docker driver `stargz` for the candidate and a different driver for standard;
- the candidate's longest download phase to be less than half of standard;
- the same command, finite CUDA result, and equivalent image runtime
  configuration on both legs;
- positive observer-arm-to-first-inference and in-container phase timings;
- candidate total time to first inference no greater than 2× standard in the
  existing diagnostics; and
- workload completion, artifact capture, and provider cleanup.

The 2× diagnostic threshold is a catastrophe guard, not the accepted
performance target. Those three existing workflows remain diagnostics and
retain their legacy manifest-existence checks.

Two separate Azure-first manual workflows implement the stronger preflight. The
profile-spike workflow runs a real GPU access profile on a disposable T4 VM,
proves decompressed layer payload and metadata parity during conversion, binds
that proof and the exact producer, workload, access record, manifests, configs,
and layers in a schema-v2 lock, and pushes one immutable derivative. This is an
explicit artifact-production step, not part of measured deployment time and not
repeated for each benchmark.

The A/B workflow requires a successful spike run and attempt. It downloads that
proof, range-fetches every published TOC, verifies its compressed and raw
digest, and proves every recorded file and all of its chunks precede that
layer's `.prefetch.landmark`. Untouched layers may carry
`.no.prefetch.landmark`, but an all-no-profile artifact fails. Both benchmark
jobs then consume the same reverified proof and immutable candidate digest.

The A/B pins the current `main` and experimental revisions, requires that the
latter contain the former, and runs a main-default pair followed by a fixed-600
pair. Each pair receives fresh simultaneous full-pull and profiled VMs, distinct
deployment names, the same region/VM/disk policy, and zero retries. Main retains
the 2.0 diagnostic guard while separately reporting the 0.60 release result;
fixed-600 enforces 0.60 and must log the applied timeout with background fetch
enabled. This is a same-artifact comparison of main product behavior versus the
branch setting, although it does not directly observe the main host's effective
config file and should not be labeled a verified compiled-10-versus-600 test.

These workflows are manual and credentialed. Their presence is not proof that
every provider/region/base-image combination passed a release matrix. The
functional product contract remains best-effort activation plus observed
fallback until AWS, Azure, and Lambda each pass the qualification contract.

## Implementation outcome

| Work item                              | Outcome                                                                                             |
| -------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Remove workload-image baking           | Shipped through migration 0070 and the public/runtime hard cut                                      |
| Initial SOCI implementation            | Superseded by eStargz and retained only as historical context                                       |
| Detect and persist eStargz candidates  | Implemented in image inspection and migrations 0072/0073                                            |
| Activate stargz on compatible VM hosts | Implemented in the common VM initializer with install, daemon merge, restart, and fallback behavior |
| Report the observed pull path          | Implemented through running-event metadata and CLI status formatting                                |
| Exercise AWS, Azure, and Lambda        | Manual provider workflows exist with a shared diagnostic MACE contract                              |
| Produce a profiled GPU MACE derivative | Separate one-off Azure profile-spike workflow exists; no attempt has yet published a valid proof    |
| Prove source/lazy artifact equivalence | Strict lock, payload-parity, TOC, landmark, and access-order verification is implemented            |
| Run the Azure profiled pair            | Separate same-artifact main-default/fixed-600 A/B exists; no valid profile is available yet         |
| AnyCloud remote builds                 | Not implemented as a product surface; the disposable CI builder is test infrastructure              |

The primary code sources for this record are
`src/api/services/image-manifest.ts`,
`src/api/services/stargz-runtime.ts`,
`src/api/services/vm-initializer.ts`,
`src/api/services/conduct.ts`, migrations 0070–0073, and
`test/integration/helpers/mace-stargz.sh`. The qualification-specific producer
and verifier live under `test/docker/`; they do not change the general
best-effort product classifier.

## Alternatives considered

### Keep workload-image baking

This preserves a regional artifact and lifecycle system while still starting
from cold snapshot-backed storage and empty page cache. It was removed because
its complexity and cloud-resource footprint were not justified by the measured
readiness behavior.

### Use SOCI Index Manifest v2

The original RFC selected a top-level OCI index containing a runnable payload
and a SOCI descriptor, with reciprocal annotations and fail-closed
verification. The first runtime implementation followed that direction, but it
was replaced before the larger artifact verifier, host-image release pipeline,
and remote builder were built.

eStargz was selected because it remains an ordinary OCI image, can be emitted
directly by BuildKit or converted with common containerd tooling, and does not
require a separate index artifact. The tradeoff is weaker classification and
runtime fallback rather than a verified fail-closed artifact contract.

### Fail the deployment when lazy loading is unavailable

Fail-closed behavior would make acceleration predictable but turn snapshotter,
base-image, and boot-time configuration drift into workload outages. The shipped
choice treats eStargz as an optimization and prioritizes running the image.

### Publish AnyCloud-owned snapshotter-ready host images

Owned, versioned AWS AMIs and private Azure gallery images could pin the entire
runtime matrix and configure Docker before first boot. The shipped system
instead reuses provider or third-party GPU images and configures stargz during
initialization. This reduces image-distribution machinery but accepts boot-time
mutation and upstream drift.

### Restore `anycloud build`

Remote builds are not part of this decision. Users build or convert images
externally, and restoring `anycloud build` requires a separate RFC.

### Expose an acceleration flag

A flag cannot make an incompatible image or host lazy-load correctly. The
control plane already has the annotation and observed storage driver, so the
product keeps submit syntax unchanged and reports what happened.

## Risks and caveats

| Risk                                                         | Consequence                                                               | Current response                                                                                            |
| ------------------------------------------------------------ | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Any annotated layer classifies the image                     | A partial or invalid conversion can be treated as a candidate             | Let Docker determine the pull result; report the observed driver or fail through the normal pull path       |
| Lazy loading defers workload reads                           | First useful work can be slower even when `downloading` is much faster    | Measure both phases in MACE and make no general readiness claim                                             |
| Snapshotter installation occurs at boot                      | Network or upstream release availability can delay initialization         | Pin the installed version to 0.18.2, retry the download, and fall back when the service remains unavailable |
| The downloaded tarball is not checksum-verified by this path | Upstream distribution is part of the runtime supply chain                 | Treat checksum/signature verification as unresolved hardening                                               |
| Docker/containerd configuration is mutated after boot        | A bad merge or integration mismatch can restart or stop Docker            | Preserve existing JSON keys, write atomically, back up `daemon.json`, and roll back restart failures        |
| An invalid existing `daemon.json` is rejected                | Initialization retries instead of silently discarding host configuration  | Surface the failure through the normal deployment retry path                                                |
| Preinstalled snapshotter versions are not qualified          | Base-image updates may change behavior without an AnyCloud release        | Observe the active driver and retain full-pull fallback                                                     |
| Azure relies on dstack's public gallery                      | Removal or replication drift can block Azure GPU provisioning             | Filter regions and run the resolve-only base-image canary                                                   |
| Status checks the storage driver, not remote snapshots       | `[lazy-loaded]` is weaker than end-to-end filesystem proof                | Keep stronger proof in the manual harness and describe the product signal precisely                         |
| Private registry credentials remain on the VM                | Background reads need access for the container lifetime                   | Use root-owned Docker auth and rely on VM deletion for cleanup                                              |
| Provider coverage is opportunistic                           | Compatible and tested are not the same set                                | Claim manual AWS/Azure/Lambda coverage only; do not publish a universal qualification matrix                |
| Profile proof shares the CI trust boundary                   | A compromised builder could fabricate its lock and parity evidence        | Pin producer inputs, verify published descriptors and TOCs independently, and retain all evidence artifacts |
| Snapshotter tuning is host-global                            | A benchmark setting can affect unrelated or later containers              | Start from defaults and separately qualify any proposed product policy                                      |
| One cloud pair has high launch variance                      | A passing ratio can be caused by provisioning or failover noise           | Invalidate asymmetric retries and retain phase-level artifacts; do not interpret one pair as an SLA         |
| The profiled working set may be large                        | Blocking prefetch can move most of the full pull ahead of container start | Measure total observer-arm-to-inference time; reject optimizations that only relabel where I/O occurs       |
| The Azure pair consumes two T4 VMs concurrently              | Insufficient `NCASv3_T4` quota makes an otherwise-valid pair fail         | Require at least 8 family vCPUs in `westus2`; fail cleanly rather than accepting a retried sample           |
| The pair shares registry/CDN paths                           | Throttling or cache fill can couple the full-pull and lazy samples        | Start both legs together, retain phase-level artifacts, and require replicated follow-up evidence           |

## Open questions

1. Should the static Docker installation path also install and configure stargz,
   so CPU and minimal base images can attempt lazy loading?
2. Should acceleration become an explicit provider/base-image allowlist with a
   versioned qualification result?
3. Should inspection require every eligible layer to carry a valid TOC
   annotation or perform registry range checks before provisioning?
4. What GPU-observed prefetch set and snapshotter policy can meet the 0.60
   cross-cloud gate without merely moving full-pull I/O ahead of container
   start?
5. Should snapshotter downloads be checksum- or signature-verified before
   installation?
6. Should public status add stronger remote-snapshot evidence or a persisted
   runtime-mode field?
7. If remote image building becomes a product priority again, what separate RFC
   should define its API, isolation, credential, and artifact contracts?

## Decision

Historical final outcome:

The registry image is the workload artifact. Workload-specific AMIs and their
product machinery remain removed.

Supported eStargz or zstd:chunked layer annotations make a `linux/amd64`
manifest eligible for a best-effort attempt to run Docker on the stargz
snapshotter. AnyCloud may install and
configure the snapshotter during VM initialization, but it does not reject an
otherwise runnable image merely because acceleration is unavailable. Status
reports the Docker driver observed when the workload reached `running`.

A GPU MACE performance claim compares an immutable source manifest with a
format/profile-only derivative whose decompressed payload and runtime behavior
are equivalent. Build and size optimization may be required of the user, but it
must occur before that pair forks. A candidate is qualified only after a real
GPU access profile, stronger artifact verification, and one valid pair on each
of AWS, Azure, and Lambda reaches total time to first inference no greater than
0.60× full pull. The current unprofiled zstd:chunked candidate and the two Azure
runs do not satisfy this requirement.

Changing background-fetch or prefetch-timeout policy is not a substitute for a
profile. Host-global snapshotter settings need separate controlled evidence and
a product decision before they can become runtime policy.

AnyCloud does not build or convert the image, does not expose an acceleration
flag, does not maintain a fail-closed SOCI artifact verifier, and does not own a
cross-provider snapshotter-ready host-image release pipeline. Those would be
new product decisions and require new RFCs.

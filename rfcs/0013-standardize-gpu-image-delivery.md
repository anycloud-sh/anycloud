# RFC 0013: Standardize GPU image delivery on full pulls

> Status: Accepted
> Date: 2026-07-20
> Author: Codex draft
> Supersedes: [RFC 0012](./0012-replace-workload-baking-with-estargz.md)
> Updated: 2026-08-16 for the four-provider GPU qualification matrix.

> Outcome: Implemented.

## Summary

Anycloud uses one image-delivery contract for GPU workloads: resolve and pin the
normal `linux/amd64` OCI manifest, fully pull it before container startup, and
use containerd's same-layer concurrent transfer when the selected VM runtime can
support it safely. Every unsupported or failed acceleration attempt falls back
to an ordinary Docker pull.

The decision removes eStargz detection and host configuration. An image that was
published with eStargz metadata remains a valid OCI image, but Anycloud treats
it like any other image and fully pulls its normal manifest digest. There is no
public image-delivery mode or concurrency control.

## Decision

GPU image delivery has these invariants:

1. Registry inspection resolves the ordinary `linux/amd64` manifest digest and
   compressed layer size. It does not classify an acceleration-specific image
   format.
2. A GPU VM with a provided Docker daemon is prepared once during VM
   initialization. Anycloud enables Docker's containerd image store and applies
   the transfer plugin controls only when the host has a configurable system
   containerd version 2.1 or newer with an active transfer plugin.
3. Pull-time capability detection is read-only. It never rewrites daemon
   configuration or restarts services.
4. A qualified host uses three concurrent download lanes and 128 MiB range
   chunks. These are runtime-owned defaults rather than user inputs.
5. The container starts only after the full image is locally available. The
   pulled digest is also the digest passed to `docker run --pull never`.

This contract is model-agnostic. It is based on OCI layers and runtime
capabilities, not framework, model family, GPU model, registry tag, or cloud
provider.

## Fallback and rollback contract

Containerd transfer is an optimization, never a workload requirement. The
pull uses Docker when any of these conditions holds:

- containerd is missing or older than 2.1;
- Docker is not wired to a configurable system containerd;
- the transfer plugin or containerd image store is unavailable;
- existing host configuration cannot be migrated safely;
- registry throttling occurs, including HTTP 429 responses;
- the transfer worker fails or times out.

Initialization preserves the effective containerd and Docker configuration,
including sentinels for files that did not previously exist. After restarting
the services, Anycloud verifies both daemons and the Docker image store. A
failure restores all prior files, removes files that were originally absent,
restarts the original services, and leaves the workload on the Docker path.

The detached transfer worker retries one non-throttling failure after the same
15-second delay used by Docker pulls. Registry throttling skips that retry so
Docker fallback begins promptly. A failed transfer may leave completed content
in containerd; the fallback remains correct because Docker owns the same image
store on qualified hosts.

## Why not retain lazy loading

Lazy loading adds an image-format classifier, a provider-image dependency, a
host snapshotter service, Docker storage-driver mutation, runtime telemetry, and
a separate status vocabulary. Provider base images did not expose a uniform
snapshotter substrate, so the behavior differed across Azure, Lambda, and other
GPU environments. It also moved some reads onto the running workload's critical
path, making a shorter download phase insufficient evidence of a better time to
first inference.

Concurrent full pulls have a narrower failure surface and preserve Docker's
ordinary image semantics. They can accelerate large individual layers without
requiring a converted artifact, while the fallback works on every provider
already supported by Anycloud.

## MACE qualification scope

The pinned MACE image is a stress fixture, not a universal workload contour. It
is useful because it is a large GHCR-hosted CUDA image with substantial layers
and a deterministic first-inference marker. It exercises provisioning, registry
delivery, framework import, model initialization, GPU visibility, and inference
in one expensive cold start.

It does not establish an optimal concurrency for every image or registry, nor
does it represent training jobs, many-small-layer images, custom weight-loading
patterns, or every provider network. Runtime defaults therefore remain
conservative, and qualification records absolute TTFI without imposing a MACE
performance ratio on unrelated workloads.

The manual GPU qualification workflow can select AWS, Azure, GCP, Lambda, or all
four. Selected provider legs run in parallel; within each provider it runs,
sequentially:

1. a `python:3.12-slim` GPU serve/passthrough smoke;
2. the digest-pinned MACE full pull and first CUDA inference.

The default MACE targets are AWS `g6e.xlarge`, Azure
`Standard_NC4as_T4_v3`, GCP `g2-standard-4`, and Lambda `gpu_1x_a10`; all use
on-demand capacity. Provider-specific disk and region settings remain in the E2E
harness. Each MACE run must show successful inference plus either successful
containerd transfer or an explicit successful Docker fallback.

## Image-size guidance

The portable way to improve cold start is to reduce bytes that must be
delivered. User guidance therefore favors runtime CUDA bases, multi-stage
builds, `.dockerignore`, same-layer cache cleanup, `pip --no-cache-dir`, avoiding
duplicate toolkits and build artifacts, copying frequently changing code after
dependency layers, and input storage for independently versioned weights or data. Moving weights to storage
moves rather than eliminates transfer cost, so compressed size, layer
composition, and cold TTFI must be measured together.

## State migration

Migration 0074 drops `deployments.stargz_digest`. Migrations 0072 and 0073 stay
in the chain so fresh and existing databases reach the same schema. No runtime
state backfill is needed: the removed value affected only the abandoned
acceleration choice, while image identity remains in `image_digest` and event
history remains unchanged.

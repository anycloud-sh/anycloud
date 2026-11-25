# GCP C4A in europe-west4

- Status: Running.
- Decision record: should anycloud and backmesh run Jobs on GCP C4A (Axion,
  arm64) in europe-west4 for a design partner's Rust CI? It measures C4A's
  spot capacity per zone, its launch-to-container time and a ripgrep release
  build's time and cost, against C4D and N2 in the same region.
- Run: `experiments/gcp-c4a/run.ts` through the
  [Spike workflow](../../.github/workflows/spike.yml), with
  `cleanup_arguments` `["cleanup"]`. `arguments` `["preflight"]` records
  quotas, machine types and images and creates nothing. `["run"]` runs the
  builds: `--rounds=<n>` (default 10), `--first-round=<n>` and
  `--max-vcpus=<n>` (running vCPUs at once, default 32) and
  `--max-c4a-vcpus=<n>` (running C4A vCPUs, default 24, the family quota). `["spot"]` runs the
  spot probe. `report <results.json...>` rewrites the build report without a
  cloud.

anycloud can't run a VM Job on C4A yet: its GCP catalog is SkyPilot's
`gcp/vms.csv`, which has no C4A rows and no `Arch` column. So every arm
launches here through the Compute API, alike. This harness is not
anycloud's Job host: compare arms within this experiment only.

## Builds

The arms are `c4a-standard-4`, `c4a-standard-16` and `c4a-highmem-16`
(arm64), with `c4d-standard-4` and `n2-standard-4` (amd64) as controls, each
on demand and on spot. Each round starts every arm once, in random order, as
long as the running VMs stay under `--max-vcpus`. A VM goes to the first of
europe-west4-a, -b and -c that accepts it; the zones that refused it are
recorded with GCP's code.

Each VM boots Canonical's newest Ubuntu 24.04 minimal image for its
architecture, as a Job host does, with a 30 GB boot disk (a Job host's
size). The disk is what an anycloud VM Job's default tier gets: Hyperdisk
Balanced on C4A and C4D, which take no Persistent Disk, and GCP's default,
`pd-standard`, on N2. Its startup script installs anycloud's pinned static
Docker for its architecture, pulls `rust:1.83-bookworm` and, in it, clones
ripgrep 14.1.1, runs `cargo fetch --locked` and times
`cargo build --release --locked`, as
[m8a-vs-m8i's `guest.sh`](../m8a-vs-m8i/guest.sh) does. Each step prints a
mark with the kernel's uptime and the epoch, so the report gives:

- launch to kernel: the insert request to the guest kernel's boot;
- kernel to container: the kernel's boot to the build container's first
  command, including Docker's install and the image pull;
- launch to first step: the two together.

The VM uploads its log to a signed URL on a run-owned GCS bucket in
europe-west4 and powers off; the run then deletes it. No cloud credential
reaches a VM. GCP deletes any VM 40 minutes after it starts
(`maxRunDuration`), and a spot VM it preempts (`instanceTerminationAction`).

Cost per build is the build's time at the list price; per VM, the kernel's
boot to the build's end. The prices are europe-west4's on 2026-11-25:

| Type              | vCPUs | Memory | On demand ($/h) | Spot ($/h) |
| ----------------- | ----- | ------ | --------------- | ---------- |
| `c4a-standard-4`  | 4     | 16 GB  | 0.1886          | 0.0289     |
| `c4a-standard-16` | 16    | 64 GB  | 0.7543          | 0.1156     |
| `c4a-highmem-16`  | 16    | 128 GB | 0.9902          | 0.1517     |
| `c4d-standard-4`  | 4     | 15 GB  | 0.1965          | 0.0887     |
| `n2-standard-4`   | 4     | 16 GB  | 0.2138          | 0.0718     |

They come from [gcloud-compute.com](https://gcloud-compute.com), which
publishes Google's Cloud Billing SKUs per type. The Cloud Billing Catalog
API, which would give them directly, is disabled in CI's project
(`preflight` tried it). N2's and C4D's on-demand prices match anycloud's
catalog; spot prices move.

## Spot capacity

`spot` tries one spot launch of each type in each of europe-west4's three
zones, one at a time, with a 10 GB disk and no startup script, and deletes
each VM as soon as GCP accepts it. `spot.md` gives, per type, the zones that
launched and each refusal's code.

## Cost

The cap is $25. Ten rounds of ten arms, at about 5 minutes a VM, come to
about $3 on demand and under $1 on spot. The run stops starting VMs once
its builds reach $20. A spot sample launches 15 VMs for under a minute each.

## Cleanup and ownership

Instances and their disks are labelled `anycloud-spike=gcp-c4a`, and the
buckets are named `c4a-spike-builds-<run>`. `run` and `spot` end with the
cleanup, which `cleanup` repeats: it deletes every labelled instance and
disk in europe-west4's zones and every such bucket, then fails unless the
listings come back empty. Nothing is kept on the runner, so `cleanup` works
after a lost runner. It isn't scoped to one run, which is safe because the
Spike workflow runs one command of an experiment at a time. anycloud's
shared Jobs network stays.

## Promotion criteria

None as an experiment. A go justifies GCP arm64 VM Jobs in anycloud (a GCP
price and architecture source for the catalog first) and EU, high-memory
and spot-fallback runner labels in backmesh, each a separate change.

## Deletion criteria

Delete this directory once the result is recorded and the pilot's design
is decided.

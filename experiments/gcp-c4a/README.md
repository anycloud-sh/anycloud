# GCP C4A in europe-west4

- Status: Complete. Results are below.
- Decision record: should anycloud and backmesh run Jobs on GCP C4A (Axion,
  arm64) in europe-west4 for a design partner's Rust CI? It measures C4A's
  spot capacity per zone, its launch-to-container time and a ripgrep release
  build's time and cost, against C4D and N2 in the same region.
- Run: `experiments/gcp-c4a/run.ts` through the
  [Spike workflow](../../.github/workflows/spike.yml), with
  `cleanup_arguments` `["cleanup"]`. `arguments` `["preflight"]` records
  quotas, machine types and images and creates nothing. `["run"]` runs the
  builds: `--rounds=<n>` (default 10), `--first-round=<n>`, and caps on
  what runs at once: `--max-vcpus=<n>` (default 32), `--max-c4a-vcpus=<n>`
  (default 24, C4A's family quota here) and `--max-vms=<n>` (default 6,
  under the region's 8 external addresses). `["spot"]` runs the spot probe. `report <results.json...>` rewrites the build report without a
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

## Result

Builds ran in three slices of four rounds on 2026-11-25, 14:15–16:50 PST,
at `e7d8a8751` (rounds 1–4) and `a3a4cf1e9`:
[45711718589](https://github.com/anycloud-sh/anycloud/actions/runs/45711718589)
(rounds 1–4),
[45716264467](https://github.com/anycloud-sh/anycloud/actions/runs/45716264467)
(5–8) and
[45723334476](https://github.com/anycloud-sh/anycloud/actions/runs/45723334476)
(9–12). 115 of 120 VMs reported, at least 10 per arm, and every cleanup
found nothing left. The 5 that didn't were in the first slice and never
launched: the region's `IN_USE_ADDRESSES` quota (8) refused them in every
zone, which `--max-vms` now stays under. No spot VM was preempted, and no
zone refused a VM for capacity: every VM in the last two slices launched in
europe-west4-a at its first try. The builds and spot samples cost about
$1.50 together.

**C4A boots fastest and, on spot, costs the least per build by a wide
margin; on demand it is about C4D's cost, and its 4-vCPU build is 1.27×
slower than C4D's.** Medians in seconds, with ranges:

| Arm                       | Launch → first step | cargo build --release | $ per build | $ per VM |
| ------------------------- | ------------------- | --------------------- | ----------- | -------- |
| c4a-standard-4 on demand  | 41.5 (40.4–44.6)    | 24.8 (23.9–25.3)      | 0.0013      | 0.0030   |
| c4a-standard-4 spot       | 41.7 (39.8–44.2)    | 27.0 (23.8–28.0)      | 0.0002      | 0.0005   |
| c4a-standard-16 on demand | 43.0 (41.3–48.9)    | 11.8 (11.5–12.2)      | 0.0025      | 0.0098   |
| c4a-standard-16 spot      | 43.1 (42.0–50.2)    | 11.6 (11.1–12.3)      | 0.0004      | 0.0015   |
| c4a-highmem-16 on demand  | 43.7 (42.0–44.8)    | 11.5 (11.1–12.4)      | 0.0032      | 0.0128   |
| c4a-highmem-16 spot       | 43.9 (42.2–46.7)    | 11.7 (11.1–12.5)      | 0.0005      | 0.0020   |
| c4d-standard-4 on demand  | 51.5 (49.9–53.4)    | 19.5 (19.0–20.9)      | 0.0011      | 0.0030   |
| c4d-standard-4 spot       | 52.8 (48.8–54.9)    | 19.7 (19.3–22.2)      | 0.0005      | 0.0014   |
| n2-standard-4 on demand   | 74.3 (70.4–77.9)    | 40.0 (34.0–43.5)      | 0.0024      | 0.0058   |
| n2-standard-4 spot        | 71.0 (68.8–79.1)    | 31.8 (30.4–33.4)      | 0.0006      | 0.0017   |

- **Spot price is where C4A wins.** C4A's spot price is 15% of its on-demand
  price here; C4D's is 45% and N2's 34%. So `c4a-standard-4` on spot costs
  0.4× C4D's per build and 0.3× N2's, though C4D builds faster.
- **Launch to first step.** C4A reaches the build container's first command
  about 10 s before C4D and 30 s before N2. Most of the gap is before the
  startup script: launch to kernel is 10 s on C4A and 17–18 s on the others,
  and the kernel to the startup script 9 s against 16 s (C4D) and 20 s
  (N2). Docker's install takes about 1.5 s on every arm; the Rust image's
  pull takes 12 s on C4A, 10 s on C4D and 19 s on N2.
- **16 vCPUs build ripgrep 2.1× faster than 4, not 4×.** ripgrep's release
  build is too small to use them; a larger workspace would scale better.
- **`c4a-highmem-16` builds no faster than `c4a-standard-16`.** ripgrep
  doesn't need the memory, so this run can't show what the partner's
  high-memory label buys; it costs 1.3× as much.
- **N2 is hurt by its disk.** A VM Job's default tier gives N2
  `pd-standard`, and its pulls and builds are the slowest. Its on-demand
  builds were also slower than its spot ones (40.0 s and 31.8 s), on the
  same disk, for reasons this run didn't capture.
- **CPUs.** C4A is Neoverse-V2, one thread per core; C4D is AMD EPYC 9B45
  and N2 Intel Xeon at 2.80 GHz, both two threads per core.

`report.md` in each run's evidence has every arm's marks, and
`report <results.json...>` merges the three.

### Disk

Each C4A and C4D VM got a 30 GB Hyperdisk Balanced volume, for which GCP
provisions 3,180 IOPS and 185 MiB/s by default. Hyperdisk Balanced includes
3,000 IOPS and 140 MiB/s free, so 180 IOPS and 45 MiB/s are billed on top of
capacity. The europe-west4 disk prices weren't confirmed. At $0.10 per
GiB-month, 30 GiB adds $0.004 an hour, about 2% of `c4a-standard-4`'s
on-demand price and 14% of its spot price. C4A takes no Persistent Disk, so
Hyperdisk is required; anycloud already picks it for C4A
(`GCP_HYPERDISK_MEDIUM_SERIES`).

### Spot capacity

Two samples each tried one spot launch of every type in each of the three
zones:
[45706159064](https://github.com/anycloud-sh/anycloud/actions/runs/45706159064)
at 13:38 PST on 2026-11-25 (22:38 CET) and
[45731650171](https://github.com/anycloud-sh/anycloud/actions/runs/45731650171)
at 16:51 PST (01:51 CET). Both cleanups found nothing left.

| Type              | Zones launched | Refusals                               |
| ----------------- | -------------- | -------------------------------------- |
| `c4a-standard-4`  | 6 of 6 (3, 3)  |                                        |
| `c4a-standard-16` | 5 of 6 (2, 3)  | first sample: b `QUOTA_EXCEEDED`       |
| `c4a-highmem-16`  | 4 of 6 (1, 3)  | first sample: b and c `QUOTA_EXCEEDED` |
| `c4d-standard-4`  | 6 of 6 (3, 3)  |                                        |
| `n2-standard-4`   | 6 of 6 (3, 3)  |                                        |

The three refusals were C4A's family quota, `CPUS_PER_VM_FAMILY` (24), held
by the probe's VMs just deleted; the second sample retries a quota refusal
after 30 s and had none. No zone refused any type for capacity
(`ZONE_RESOURCE_POOL_EXHAUSTED`) in either sample or in the 115 build
launches. Both samples were in Europe's evening and night; a sample in
European working hours, when the partner's CI runs, would test the busiest
time.

### Quotas

The CI project's europe-west4 quotas, from `preflight` and the refusals:

- `CPUS_PER_VM_FAMILY` for C4A: 24, so one 16-vCPU C4A at a time. Compute
  API's `regions.get` doesn't list it; only a refusal names it. The design
  partner's project will have its own, which they raise.
- `IN_USE_ADDRESSES`: 8 external addresses, so 8 VMs at once with public
  IPs.
- `CPUS`: 200. `PREEMPTIBLE_CPUS` is 0, so spot VMs count against `CPUS`.
- `CPUS_ALL_REGIONS` (project-wide) was raised to 128 for this run.

### For anycloud

anycloud's GCP catalog has no C4A: SkyPilot's `gcp/vms.csv` lacks it and
has no `Arch` column. Running VM Jobs on C4A needs a GCP price source
(Cloud Billing's per-vCPU and per-GiB SKUs times the Machine Types API's
shapes, as gcloud-compute.com does) and an architecture column. The arm64
image (`ubuntu-minimal-2404-lts-arm64`), anycloud's static Docker for
`aarch64` and Hyperdisk Balanced all worked here unchanged.

## Promotion criteria

None as an experiment. A go justifies GCP arm64 VM Jobs in anycloud (a GCP
price and architecture source for the catalog first) and EU, high-memory
and spot-fallback runner labels in backmesh, each a separate change.

## Deletion criteria

Delete this directory once the result is recorded and the pilot's design
is decided.

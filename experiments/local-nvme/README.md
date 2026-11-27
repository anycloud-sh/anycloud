# Local NVMe for CI builds

- Status: Complete. [Result](#result): a design on GCP and Azure; none on
  AWS. [GCP's on-demand runner disk](#gcps-on-demand-runner-disk): keep the
  `high` tier.
- Decision record: backmesh CI speed tracker row C25 asks whether running a
  job's workspace and Docker data on a VM's local NVMe disk builds faster
  than today's network disk, at about the same cost per build, on each
  cloud. It is a spike before any design: a design follows only where a
  cloud's builds get significantly faster without costing more.
- Run: `experiments/local-nvme/run.ts` through the
  [Spike workflow](../../.github/workflows/spike.yml), with `arguments`
  `["run", "--parallel=5"]`, `cleanup_arguments` `["cleanup"]` and
  `azure_subscription` `own`. One dispatch runs all three clouds at once,
  each with its own APIs; `--cloud=<aws,gcp,azure>` picks some. AWS and GCP
  Jobs run on spot VMs, Azure's on demand. The [Result](#result)'s Azure
  Jobs ran in eastus on the former CI subscription; on 2026-11-27 ours had
  no `DADSv5` quota in eastus, centralus or the six regions `run.ts` lists
  ([run 46069225284](https://github.com/anycloud-sh/anycloud/actions/runs/46069225284),
  [run 46070272894](https://github.com/anycloud-sh/anycloud/actions/runs/46070272894)),
  so its Jobs failed before starting a VM.
  `--rounds=<n>` (default 10), `--parallel=<n>` (rounds at a time per
  cloud, default 3) and `--arms=<arm,...>` change the run, and `--on-demand`
  runs every arm on demand. GCP's 24 `C4` vCPUs in us-east4 take 3 rounds
  at once, so 5 exceeds them; see [Result](#result).
  `report <results.json...>` rewrites the report from saved results without
  a cloud.

## Promotion criteria

A design on GCP and Azure, per the [Result](#result). On GCP it would move
the stores and `/workspace` onto the local SSD in anycloud's Job host
preparation (`src/api/services/job-host.ts`), formatted eagerly, and have
backmesh pick the `-lssd` type and a smaller OS disk. On Azure it would add
`/workspace` to the resource disk's binds. None on AWS. A go on GCP's
on-demand runner disk would have extended backmesh's spot override to
on-demand runners.

## Deletion criteria

Delete this directory once C25's decision is recorded, or when the Job host
preparation changes enough that `variant-nvme.patch` no longer applies.

## What it measures

The run builds the branch, starts its API and uses its CLI, the way a user
does. It also builds a second API from this checkout with
[`variant-nvme.patch`](variant-nvme.patch) applied, which only that API's
Jobs use. Each round starts one Job per arm at once, in a random order, so
drift over the run hits every arm alike. Each Job runs
[`guest.sh`](guest.sh) in `docker:27-cli` with `--host-docker`, as
backmesh's runners run, and:

1. prints which device `/`, `/workspace` and `/var/lib/containerd` are on, and
   the CPU;
2. pulls `rust:1.83-bookworm` and `node:22-bookworm` (timed together);
3. runs three of the first run's builds, from backmesh's
   [`benchmarks/builds/bench.yml`](https://github.com/backmesh/backmesh/blob/main/benchmarks/builds/bench.yml),
   with the same sources and commands as
   [`m8a-vs-m8i`](../m8a-vs-m8i/README.md): `docker build` of grafana/k6
   v0.54.0, `cargo build --release --locked` of ripgrep 14.1.1, and `npm ci`
   and `npx hereby local` of TypeScript v5.6.3;
4. runs two disk-heavy steps, whose IO exceeds the VMs' 15–16 GiB page
   cache, with the page cache dropped before each step that reads:
   - **A CUDA image**, as an ML repository's CI builds one: `docker pull` of
     `nvidia/cuda:12.4.1-cudnn-devel-ubuntu22.04`, pinned by digest (4.5 GB
     compressed in 18 layers, about 10 GB unpacked); `docker build` of a
     Dockerfile on it that installs `python3-pip` and PyTorch 2.5.1 with its
     CUDA wheels (2.5 GB, about 5 GB installed); `docker save` of the
     resulting image to `/workspace`; and, after the image and the build
     cache are removed, `docker load` of that tarball, as a cache of images
     restores it. The pulls and layer commits are fsync-heavy too. NVIDIA's
     CUDA images on Docker Hub and PyPI's wheels are public, versioned and
     immutable; torch pins its NVIDIA wheels exactly, and the Dockerfile
     pins torch's other dependencies.
   - **A cache's restore and save**, as `actions/cache` restores dependencies
     or build output: an uncompressed tarball of 400,000 random files of 1
     to 33 KiB (6.5 GiB) is written untimed to `/workspace`, then extracted
     there and archived back, each timed until `sync` returns. Generated
     data needs no download and is the same in every Job (its sizes come
     from a fixed seed). It is uncompressed so the steps wait on the disk,
     not on zstd: a gain that doesn't show here wouldn't show compressed.

As on a backmesh runner, the sources, build output, `HOME` and the cargo and
npm caches are in the host's `/workspace`, which anycloud binds into the
Job; images, the Docker build's layers and containers' own files are in the
image stores. Clones and `cargo fetch` are untimed. The Job's VM time and
its boot marks are read from the API: `boot kernel-to-container-start`, and,
for the variant, `boot local-disk-setup` (the format, mount and binds).

### The arms

All are 4 vCPUs. On each cloud the two arms are the same type, so the
comparison isolates the disk from the CPU. Today's runner types, `m8a.xlarge`
and `c4d-standard-4`, were in the first run (see [Result](#result)) and
aren't in this one, to save money; the first run had already compared them.

| Cloud           | Type on the runners' disk                                        | `@nvme` variant                                   |
| --------------- | ---------------------------------------------------------------- | ------------------------------------------------- |
| AWS (us-east-2) | `m8id.xlarge` (237 GB NVMe), 100 GB gp3 at 4,000 IOPS, 500 MiB/s | `m8id.xlarge`, 30 GB gp3 at baseline              |
| GCP (us-east4)  | `c4-standard-4-lssd` (375 GiB), 100 GB Hyperdisk, 3,000 / 750    | `c4-standard-4-lssd`, 30 GB Hyperdisk at baseline |
| Azure (eastus)  | `Standard_D4ads_v5`, stores on its 150 GiB resource disk         | the same, with `/workspace` there too             |

- **AWS.** There is no `m8ad`; `m8id` is `m8i`'s Xeon 6 with an instance
  store. us-east-2 on-demand list prices: `m8a.xlarge` $0.2434/h,
  `m8id.xlarge` $0.2610/h.
- **GCP.** `c4d`'s smallest `-lssd` type has 8 vCPUs, so the 4-vCPU local SSD
  is on `c4` (Intel). us-east4 list prices: `c4d-standard-4` $0.1833/h,
  `c4-standard-4-lssd` $0.1977/h (the local SSD included).
- **Azure.** anycloud already binds Docker's and containerd's stores onto a
  `Dadsv5`'s resource disk, so the only thing left on the OS disk is
  `/workspace`.
- **The variant's OS disk.** With the stores and `/workspace` off it, the OS
  disk holds only the OS, so the variant takes the Job host's default 30 GB
  at the cloud's baseline (`--disk-tier medium`) and its cost per Job counts
  that disk. Azure's resource disk must be at least the OS disk's size for
  anycloud to use it, so Azure's stays at 100 GB.

### `variant-nvme.patch`

On AWS and GCP the Job host's user-data preparation finds the local NVMe disk
(model `Amazon EC2 NVMe Instance Storage`, or GCP's
`google-local-nvme-ssd-0`; `c4`'s local SSD reports model `nvme_card0`),
formats it as ext4 with no discard and with its inode tables and journal
written at format time (`lazy_itable_init=0,lazy_journal_init=0`), so no
background zeroing competes with the Job's writes, as the first run's lazy
format may have. It mounts the disk at `/mnt/local` and binds
`/var/lib/docker`, `/var/lib/containerd` and `/workspace` onto it with the
unit anycloud uses for Azure's resource disk, before containerd first
starts. It runs beside Docker's install, and `boot local-disk-setup` times
it, the format included. On every cloud the patch adds `/workspace` to that
unit's binds; Azure's resource disk is formatted by cloud-init in both
arms, as before. A variant Job whose `/workspace` is
still on the OS disk counts as failed.

## Report

`report.md` gives, for each cloud's pair:

- the median and p90 of each timed command, of the first run's builds and
  of the disk-heavy steps together, of the Job's whole VM time, and of its
  cost;
- the ratio of the medians;
- a two-sided Mann-Whitney p (normal approximation with tie correction);
- the cost per Job: its VM time at the price the API recorded for the VM
  (spot or on demand), plus its OS disk's list price (constants in `run.ts`).

`report.md` covers every cloud; `report-<cloud>.md` and
`results-<cloud>.json` are each cloud's, and every Job's log is in the
evidence too.

## Cost

Within the $5 the owner approved for the rerun (hard cap $10). A Job takes
15–20 minutes; the one-round smoke run's 6 Jobs cost $0.31, so 10 rounds
cost about $3. Each cloud stops starting rounds once its VMs' and disks'
cost reaches $3, so a run can't exceed $9.

## Cleanup and ownership

Jobs are named `ln-<run>-r<round>-<arm>` and run with `--max-retries 0` and
`--no-checkpoint`, so they create no bucket. The APIs' databases, each
cloud's inventory and the API logs live in `$RUNNER_TEMP/local-nvme/<cloud>`. `run` ends each
Job's VM when its log ends. At the end it terminates every Job, waits until
each API has cleaned them up, then asks the cloud for anything tagged
(labelled, on GCP) `anycloud_deployment` with the run's Job IDs, and fails if
any remain: EC2 instances and volumes, GCP instances and disks in every zone,
and every Azure resource. `cleanup` reuses the run's APIs if they are still
up, or restarts them from the same state, and repeats that check. No round
starts after 50 minutes, so a run ends inside the Spike step. If the runner
is lost with its state, the Job IDs are in the run log; delete their
resources by that tag. The region's shared anycloud network and security
group are not the run's; they stay.

## Result

[Spike run 45932521337](https://github.com/anycloud-sh/anycloud/actions/runs/45932521337)
(`5498862ba`, 2026-11-26, about 19:10–20:15 PST, `--parallel=5`): ten
rounds on each cloud, 60 Jobs. On GCP 2 variant Jobs failed: 5 rounds at
once asked for 40 of the project's 24 `C4` vCPUs in us-east4, so one Job
never got a VM and one started too late to finish. [Run
45939221896](https://github.com/anycloud-sh/anycloud/actions/runs/45939221896)
(same commit, `--cloud=gcp --rounds=2 --parallel=2`) added two GCP rounds,
so GCP has 10 variant Jobs and 12 on Hyperdisk; GCP's figures are both
runs' (`report` over both `results-gcp.json`, the failed Jobs left out).
Keep GCP at `--parallel=3` or less. With the
[smoke run](https://github.com/anycloud-sh/anycloud/actions/runs/45929733399)
(one round, 6 Jobs), the VMs and disks cost $3.34, and cleanup found nothing
left on any cloud. Every variant Job had `/workspace` and both image stores
on the local disk; the CUDA image was 21.6 GB.

**On GCP and Azure local disks make the disk-heavy steps significantly
faster and each Job cheaper, with the first run's builds unchanged; a
design follows on both. On AWS the gain is in reading the cache and the
image back, and every other Docker step is slower; no design.** Seconds are medians, with p90 in parentheses; ratios
are the variant's median over the same type's on the runners' disk.

| Measure          | `m8id` NVMe   | `m8id` gp3    | Ratio (p)     | `c4-lssd` NVMe | `c4-lssd` Hyperdisk | Ratio (p)     | `D4ads_v5` +workspace | `D4ads_v5`    | Ratio (p)     |
| ---------------- | ------------- | ------------- | ------------- | -------------- | ------------------- | ------------- | --------------------- | ------------- | ------------- |
| container start  | 28.6 (29.2)   | 12.3 (12.7)   | 2.32 (0.0002) | 30.4 (31.6)    | 13.7 (14.1)         | 2.22 (0.0001) | 21.3 (22.4)           | 20.8 (22.1)   | 1.02 (0.68)   |
| first run's five | 125.8 (127.5) | 120.3 (120.6) | 1.05 (0.0002) | 124.9 (130.0)  | 126.3 (131.4)       | 0.99 (0.28)   | 175.9 (178.6)         | 176.0 (179.0) | 1.00 (0.91)   |
| ml pull          | 50.5 (53.6)   | 41.9 (42.1)   | 1.21 (0.0002) | 47.0 (49.5)    | 44.9 (46.6)         | 1.05 (0.011)  | 53.1 (55.1)           | 53.4 (55.5)   | 1.00 (0.47)   |
| ml build         | 261.1 (264.1) | 245.5 (253.5) | 1.06 (0.0003) | 256.1 (314.8)  | 251.3 (321.1)       | 1.02 (0.53)   | 317.7 (325.4)         | 320.6 (326.2) | 0.99 (0.31)   |
| ml save          | 93.8 (97.0)   | 114.1 (116.9) | 0.82 (0.0002) | 102.7 (106.3)  | 116.5 (121.9)       | 0.88 (0.0001) | 110.1 (114.0)         | 108.7 (113.7) | 1.01 (0.21)   |
| ml load          | 112.1 (113.2) | 105.7 (106.5) | 1.06 (0.0002) | 117.4 (119.4)  | 120.8 (123.6)       | 0.97 (0.0017) | 115.1 (115.9)         | 114.9 (116.9) | 1.00 (0.85)   |
| cache restore    | 36.9 (37.1)   | 36.3 (36.5)   | 1.02 (0.0002) | 33.7 (33.7)    | 74.0 (77.2)         | 0.46 (0.0001) | 37.9 (38.0)           | 65.4 (71.3)   | 0.58 (0.0002) |
| cache save       | 37.7 (50.2)   | 384.7 (386.4) | 0.10 (0.0002) | 72.2 (72.9)    | 285.4 (302.8)       | 0.25 (0.0001) | 109.1 (145.8)         | 131.7 (186.5) | 0.83 (0.076)  |
| **disk-heavy**   | **592.9**     | **930.0**     | 0.64 (0.0002) | **634.6**      | **895.3**           | 0.71 (0.0001) | **756.9**             | **803.7**     | 0.94 (0.0006) |
| VM time per Job  | 869.0         | 1164.7        | 0.75 (0.0002) | 918.3          | 1196.2              | 0.77 (0.0001) | 1089.6                | 1156.7        | 0.94 (0.0008) |
| cost per Job     | $0.0200       | $0.0382       | 0.52 (0.0002) | $0.0309        | $0.0540             | 0.57 (0.0001) | $0.0705               | $0.0749       | 0.94 (0.0008) |

- **GCP: go.** The cache restore takes 0.46 of Hyperdisk's time and its
  save 0.25, `docker save` 0.88 and `docker load` 0.97; the pulls are 5–12%
  slower. The disk-heavy steps take 0.71 of the time and the Job costs 0.57,
  part of that the 30 GB disk in place of 100 GB at 3,000 IOPS and 750
  MiB/s. Without the cache save they still take about 0.92.
- **Azure: go,** for `/workspace` on the resource disk, where the image
  stores already are: the cache restore takes 0.58 of the OS disk's time,
  nothing is slower, and the Job's VM time and cost are 0.94 of today's.
  Its disk stays the same, so the saving is the VM's shorter time.
- **AWS: no design.** The disk-heavy total (0.64) and the cost (0.52) pass
  the rule, but all of it is two steps that read the image or the cache
  back: the cache save takes 0.10 of gp3's time, which at 4,000 IOPS spends
  385 s reading 400,000 small files, and `docker save` 0.82. Everything else
  is slower on the instance store, significantly: the CUDA pull 1.21, the
  builds 1.06 and 1.07, `docker load` 1.06, and the first run's builds 1.05.
  Without the cache save the disk-heavy steps take about 1.02 of gp3's time. More
  provisioned IOPS on the runners' gp3 is the cheaper lever to test for that
  one step.
- **The format, eagerly.** Writing the inode tables and journal at format
  time takes `boot local-disk-setup` to 20.0 s on AWS and 21.2 s on GCP
  (medians; it was 1.6–4.1 s lazily), and the container starts 16–17 s
  later, a cost the VM time and cost per Job include. It settles the
  first run's question only in part: the toolchain pulls on AWS are now
  even (1.00, from 1.30), but the CUDA pull is 1.21, and GCP's pulls are
  still 1.05–1.12 (1.18 before). Writing a pulled image is slower on these
  local disks than on the runners' network disks with their provisioned
  throughput; lazy initialization wasn't all of it. A design would weigh
  the eager format's 17 s against that.
- **Scope.** The page cache is dropped before each step that reads, so
  those steps read from the disk. A cache saved at the end of a Job whose
  IO fit in memory would mostly be read from memory instead, which favours
  the network disk. The cache is uncompressed; zstd would make its steps
  partly CPU-bound and shrink the ratios.

`m8id` and `c4` are Intel (Xeon 6975P-C and 6985P-C), the `D4ads_v5` AMD
(EPYC 7763). Today's runner types weren't run; each cloud's pair is one
type.

### 2026-11-26, the first run

[Spike run 45898586097](https://github.com/anycloud-sh/anycloud/actions/runs/45898586097)
(`9b7bb72ed`) ran only the first five builds, with a lazily formatted local
disk, on all three clouds and today's runner types. On no cloud did they get
faster: 1.08 of the network disk's time on AWS, 0.99 on GCP and 0.98 on
Azure, with the pulls 1.30× and 1.18× slower on AWS and GCP. `m8id` built
1.38× slower than today's `m8a`, and `c4-standard-4-lssd` with the variant
took 1.04 of `c4d-standard-4`'s time at 0.88 of its cost.

## GCP's on-demand runner disk

[anycloud#43](https://github.com/anycloud-sh/anycloud/pull/43) measured a
`c4d-standard-4` Job host on Hyperdisk Balanced at 3,000 IOPS and 750 MiB/s
at 0.84 of the `high` tier's (8,000 and 1,000) cost per Job, VM time 1.02
(p = 0.51), and kept the tier because the toolchain pulls (1.04, p = 0.014),
`docker build` (1.03, p = 0.026) and boot (1.06, p = 0.050) were slower.
backmesh's spot `c4d` runners already take 3,000 and 750
(`GCP_SPOT_RUNNER_DISK_IOPS` in backmesh's `src/listener/runner-jobs.ts`,
owner, 2026-11-24; backmesh v0.7.2), so the task's premise that today's
runners all use the tier was wrong: only on-demand runners do. This
confirmatory A/B runs on demand, with the owner's rule: ship 3,000 and 750
for on-demand runners if no step is significantly slower by more than 5% and
whole-Job VM time isn't significantly longer.

`c4d-standard-4#high` is the type on the branch's API with `--disk-tier
high`; `--on-demand` runs every arm on demand. Arguments
`["run","--cloud=gcp","--arms=c4d-standard-4,c4d-standard-4#high","--on-demand","--rounds=20","--parallel=3"]`,
cleanup `["cleanup","--cloud=gcp"]`.

[Spike run 45952579645](https://github.com/anycloud-sh/anycloud/actions/runs/45952579645)
(`e68aea9bb`, 2026-11-26, about 22:30–23:15 PST): 20 rounds, 40 Jobs, all
in us-east4-a, all succeeded, cleanup found nothing left. The VMs and disks
cost $0.58. The API log shows every `#high` launch at 8,000 and 1,000 and
every other at 3,000 and 750. Ratios are 3,000 / 750's median over the
tier's.

| Measure                 | 3,000 / 750   | `high`        | Ratio (p)     |
| ----------------------- | ------------- | ------------- | ------------- |
| boot to container start | 12.9 (14.1)   | 12.8 (13.9)   | 1.01 (0.43)   |
| pull toolchains         | 15.8 (17.5)   | 16.1 (17.6)   | 0.98 (0.80)   |
| docker build            | 67.8 (70.0)   | 59.8 (61.5)   | 1.13 (6.8e-8) |
| rust build              | 19.7 (20.6)   | 19.6 (21.1)   | 1.00 (0.95)   |
| npm ci                  | 1.9 (2.0)     | 1.9 (2.1)     | 1.01 (0.96)   |
| typescript build        | 13.7 (14.1)   | 13.6 (14.3)   | 1.00 (1.0)    |
| **all builds**          | **119.3**     | **111.3**     | 1.07 (3.0e-7) |
| VM time per Job         | 200.9 (209.3) | 201.7 (213.0) | 1.00 (0.92)   |
| cost per Job, on demand | $0.0127       | $0.0154       | 0.82 (9.1e-7) |

**No-go: on-demand runners keep the `high` tier.** `docker build` of k6 is
13% slower at 3,000 and 750, and the two arms' times don't overlap (63.7–70.8
s against 59.0–63.3 s), so the rule fails though VM time is unchanged and a
Job costs 0.82 of the tier's. The other builds and the pulls didn't move. The
gap is larger than #43's 1.03, where k6's sources were in the Job's
container rather than the host's `/workspace`; the run doesn't establish
why. The same 3,000 and 750 are what
spot `c4d` runners use today, so this also measures their `docker build`
cost, which the owner took on 2026-11-24 for 0.6 of `n2`'s VM time at about
1.05 of its cost.

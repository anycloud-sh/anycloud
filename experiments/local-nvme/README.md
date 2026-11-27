# Local NVMe for CI builds

- Status: Complete. [Result](#result): no design on any cloud.
  [GCP's on-demand runner disk](#gcps-on-demand-runner-disk): keep the
  `high` tier.
- Decision record: backmesh CI speed tracker row C25 asks whether running a
  job's workspace and Docker data on a VM's local NVMe disk builds faster
  than today's network disk, at about the same cost per build, on each
  cloud. It is a spike before any design: a design follows only where a
  cloud's builds get significantly faster without costing more.
- Run: `experiments/local-nvme/run.ts` through the
  [Spike workflow](../../.github/workflows/spike.yml), with `arguments`
  `["run"]` and `cleanup_arguments` `["cleanup"]`. One dispatch runs all
  three clouds at once, each with its own APIs; `--cloud=<aws,gcp,azure>`
  picks some. AWS and GCP Jobs run on spot VMs, Azure's on demand, since
  CI's subscription has 3 spot vCPUs a region. `--rounds=<n>` (default 10),
  `--parallel=<n>` (rounds at a time per cloud, default 3) and
  `--arms=<arm,...>` change the run. `report <results.json...>` rewrites the
  report from saved results without a cloud.
- Promotion: none. A design for a cloud that gains would move the stores and
  `/workspace` onto the local disk in anycloud's Job host preparation
  (`src/api/services/job-host.ts`), and have backmesh pick the NVMe types
  and a smaller OS disk.
- Deletion: once C25's decision is recorded, or when the Job host
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
3. runs three of the builds of backmesh's
   [`benchmarks/builds/bench.yml`](https://github.com/backmesh/backmesh/blob/main/benchmarks/builds/bench.yml),
   with the same sources and commands as
   [`m8a-vs-m8i`](../m8a-vs-m8i/README.md): `docker build` of grafana/k6
   v0.54.0, `cargo build --release --locked` of ripgrep 14.1.1, and `npm ci`
   and `npx hereby local` of TypeScript v5.6.3.

As on a backmesh runner, the sources, build output, `HOME` and the cargo and
npm caches are in the host's `/workspace`, which anycloud binds into the
Job; images, the Docker build's layers and containers' own files are in the
image stores. Clones and `cargo fetch` are untimed. The Job's VM time and
its boot marks are read from the API: `boot kernel-to-container-start`, and,
for the variant, `boot local-disk-setup` (the format, mount and binds).

### The arms

All are 4 vCPUs. Today's runner type is first; the second has a local NVMe
disk but keeps the runners' network disk, so the comparison of the last two
isolates the disk from the CPU.

| Cloud           | Today's runner                                           | NVMe type, runners' disk               | `@nvme` variant                                   |
| --------------- | -------------------------------------------------------- | -------------------------------------- | ------------------------------------------------- |
| AWS (us-east-2) | `m8a.xlarge`, 100 GB gp3 at 4,000 IOPS and 500 MiB/s     | `m8id.xlarge` (237 GB NVMe), same disk | `m8id.xlarge`, 30 GB gp3 at baseline              |
| GCP (us-east4)  | `c4d-standard-4`, 100 GB Hyperdisk Balanced, 3,000 / 750 | `c4-standard-4-lssd` (375 GiB), same   | `c4-standard-4-lssd`, 30 GB Hyperdisk at baseline |
| Azure (eastus)  | `Standard_D4ads_v5`, stores on its 150 GiB resource disk | —                                      | the same, with `/workspace` there too             |

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
`google-local-nvme-ssd-0`; `c4`'s local SSD reports model `nvme_card0`), formats it as ext4 with lazy inode-table and
journal initialization and no discard, mounts it at `/mnt/local`, and binds
`/var/lib/docker`, `/var/lib/containerd` and `/workspace` onto it with the
unit anycloud uses for Azure's resource disk, before containerd first
starts. It runs beside Docker's install. On every cloud the patch adds
`/workspace` to that unit's binds. A variant Job whose `/workspace` is
still on the OS disk counts as failed.

## Report

`report.md` gives, for each pair (each arm against today's, and the variant
against its type on the runners' disk):

- the median and p90 of each timed command, of all of them together, of the
  Job's whole VM time, and of its cost;
- the ratio of the medians;
- a two-sided Mann-Whitney p (normal approximation with tie correction);
- the cost per Job: its VM time at the price the API recorded for the VM
  (spot or on demand), plus its OS disk's list price (constants in `run.ts`).

`report.md` covers every cloud; `report-<cloud>.md` and
`results-<cloud>.json` are each cloud's, and every Job's log is in the
evidence too.

## Cost

Within the $25 the owner approved. A Job takes about 6–10 minutes; 10 rounds
of three spot arms cost under $1 on AWS and GCP, and 10 rounds of Azure's two
on-demand arms about $0.70. Each cloud stops starting rounds once its VMs'
and disks' cost reaches $8, so a run can't exceed $24.

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

[Spike run 45898586097](https://github.com/anycloud-sh/anycloud/actions/runs/45898586097)
(`9b7bb72ed`, 2026-11-26, about 13:30–14:45 PST): ten rounds on each cloud,
80 Jobs. The VMs and disks cost $0.82, plus about $0.10 for a one-round
smoke run, and cleanup found nothing left on any cloud. The run failed on its
own check: EC2 refused `m8a.xlarge` spot in us-east-2 for rounds 5–10, as in
[`m8a-vs-m8i`](../m8a-vs-m8i/README.md#spot-capacity), so today's AWS arm
has 4 Jobs, not 10. Every other arm has 10. Every variant Job had
`/workspace` and both image stores on the local disk.

**On no cloud does local NVMe make these builds faster. No design is
worthwhile.** With the CPU held equal, the timed builds took 1.08 of the
network disk's time on AWS (p = 0.00018), 0.99 on GCP (p = 0.19) and 0.98 on
Azure (p = 0.24). The compiles (`cargo build`, `hereby local`, `npm ci`)
didn't change: their writes fit in the page cache, so the disk under them
doesn't matter. The image pulls were slower on local NVMe, 1.30× on AWS and
1.18× on GCP. `docker build` was 1.10× on AWS and 0.94× on GCP. Seconds are
medians, with p90 in parentheses; ratios are the variant's median over its
type's on the runners' disk.

| Measure          | `m8id` NVMe | `m8id` gp3  | Ratio (p)     | `c4-lssd` NVMe | `c4-lssd` Hyperdisk | Ratio (p)     | `D4ads_v5` +workspace | `D4ads_v5`  | Ratio (p)   |
| ---------------- | ----------- | ----------- | ------------- | -------------- | ------------------- | ------------- | --------------------- | ----------- | ----------- |
| pull toolchains  | 19.8 (20.2) | 15.2 (16.3) | 1.30 (0.0002) | 20.5 (21.1)    | 17.4 (18.0)         | 1.18 (0.0002) | 24.3 (25.6)           | 24.1 (26.6) | 1.01 (0.97) |
| docker build     | 70.9 (72.1) | 64.6 (65.9) | 1.10 (0.0002) | 67.8 (69.7)    | 72.5 (74.2)         | 0.94 (0.0002) | 92.0 (96.6)           | 93.5 (94.4) | 0.98 (0.21) |
| rust build       | 22.6 (23.1) | 22.7 (22.9) | 0.99 (0.43)   | 22.1 (22.6)    | 21.8 (22.7)         | 1.02 (0.97)   | 30.2 (31.8)           | 31.0 (31.5) | 0.98 (0.27) |
| npm ci           | 2.5 (2.6)   | 2.5 (2.6)   | 0.99 (0.31)   | 2.5 (2.5)      | 2.4 (2.5)           | 1.02 (0.096)  | 4.4 (4.5)             | 4.5 (4.5)   | 0.97 (0.02) |
| typescript build | 15.0 (15.7) | 15.0 (15.3) | 1.00 (0.91)   | 14.6 (15.2)    | 14.8 (15.2)         | 0.98 (0.24)   | 23.0 (23.8)           | 23.6 (24.2) | 0.97 (0.05) |
| **all builds**   | **130.3**   | **120.3**   | 1.08 (0.0002) | **127.8**      | **128.9**           | 0.99 (0.19)   | **173.4**             | **176.5**   | 0.98 (0.24) |
| VM time per Job  | 199.8       | 195.5       | 1.02 (0.38)   | 226.1          | 227.0               | 1.00 (0.73)   | 294.2                 | 287.3       | 1.02 (0.05) |
| cost per Job     | $0.0046     | $0.0064     | 0.72 (0.0008) | $0.0076        | $0.0102             | 0.74 (0.0002) | $0.0190               | $0.0186     | 1.02 (0.05) |

- **Against today's runners.** `m8id`'s Xeon builds 1.38× slower than
  today's `m8a` (n = 4; every `m8a` run was faster), so on AWS local NVMe
  could only come with a slower CPU. On GCP, `c4-standard-4-lssd` with the
  variant built in 1.04 of `c4d-standard-4`'s time (p = 0.064), with a
  container start 2.0 s later (p = 0.0017), at 0.88 of its cost per Job.
- **Cost.** The variant's cost per Job is 0.72–0.74 of the same type's on
  AWS and GCP, but that saving is the smaller network disk (30 GB at the
  baseline against 100 GB provisioned), not the NVMe. Lowering the runners'
  provisioned IOPS and throughput may save much of it without new types or
  a new host layout; [anycloud#43](https://github.com/anycloud-sh/anycloud/pull/43)
  measured that on GCP. On GCP the variant's whole Job cost 0.88 of today's
  `c4d`, most of it from the disk.
- **Boot.** Format, mount and binds took 1.6–2.5 s on AWS and 2.5–4.1 s on
  GCP (`boot local-disk-setup`, all 10 Jobs), beside Docker's install. The
  container's start from kernel boot didn't change significantly on either
  cloud (0.97, p = 0.14; 1.04, p = 0.21).
- **Why the pulls were slower.** The run doesn't establish it. A likely
  cause is ext4's lazy inode-table initialization, which zeroes the freshly
  formatted disk in the background during the Job's first minutes and
  competes with the pull's writes. Formatting without lazy init would move
  that cost into boot. Since the compiles gain nothing either way, a
  follow-up isn't worth it.
- **Azure.** Its image stores were already on the resource disk. Adding
  `/workspace` changed nothing significant.
- **Scope.** These builds have small workspaces and outputs that fit in
  4-vCPU VMs' page cache (15–16 GiB). Jobs that write or read much more than
  that, such as large Docker images or big monorepo caches, may still be
  disk-bound. This run doesn't measure them.

`m8id` and `c4` are Intel; today's `m8a` and `c4d` are
AMD Zen 5 (`lscpu`: EPYC 9R45 and 9B45; Xeon 6975P-C and 6985P-C).
The run's evidence has each cloud's `report-<cloud>.md`, with each NVMe
type against today's too. The run failed before writing the combined
`report.md`; `report` rebuilds it from the three `results-<cloud>.json`.

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

# Local NVMe for CI builds

- Status: Built; results pending.
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
(model `Amazon EC2 NVMe Instance Storage`, or GCP's `nvme_card` or
`google-local-nvme-ssd-0`), formats it as ext4 with lazy inode-table and
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

Pending.

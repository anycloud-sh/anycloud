# m8a against m8i, and GCP's and Azure's newer CPUs

- Status: Complete. Results are below: AWS first, then a preliminary
  [comparison with GitHub's 4-core runner](#against-githubs-4-core-runner),
  then [GCP and Azure](#gcp-and-azure), then
  [`c4d`'s Hyperdisk settings](#c4ds-hyperdisk-settings).
- Decision record: it asks how much faster AWS m8a (AMD EPYC, Zen 5) builds
  than m8i (Intel Xeon 6), which backmesh's runners land on today, at the same
  vCPU count. backmesh's labels can't choose a VM family, so this runs in
  anycloud VM Jobs. Speed claims compare equal vCPUs, so any gain comes from
  the CPU generation. An m8a vCPU is a whole core and an m8i vCPU is a
  hyperthread; the `lscpu` lines record it. `--cloud=gcp` and `--cloud=azure`
  ask the same of GCP's and Azure's newest AMD families against the ones
  backmesh's runners use there today (`VM_TYPES` in backmesh's
  `src/runners/classes.ts`).
- Run: `experiments/m8a-vs-m8i/run.ts` through the
  [Spike workflow](../../.github/workflows/spike.yml), with `arguments` `[]`
  and `cleanup_arguments` `["cleanup"]`. `--rounds=<n>` (default 10),
  `--parallel=<n>` (rounds at a time, default 3) and `--region=<region>`
  (default us-east-2) change the run. `--cloud=gcp` or `--cloud=azure` runs
  that cloud's arms instead, and `--vcpus=4,16` picks the sizes (AWS's default
  is both, the others' 4), and `--arms=<type,...>` keeps just those.
  `--spot` runs the Jobs on spot VMs.
  `--variants=<name,...>` also runs each arm as `<type>@<name>` from a second
  API, built from this checkout with `variant-<name>.patch` applied, and
  compares it with the branch's arm; each round runs every variant.
  `["spot"]` measures spot capacity instead (below).
  `report <results.json|hosted .log...>` rewrites the report from saved
  results, and GitHub-hosted rounds' logs, without a cloud. `["sweep", "--cloud=gcp", "--prefix=<run's Job ID prefix>"]` deletes
  a lost run's GCP VMs and disks by label.

## What it measures

The run builds the branch, starts its API and uses its CLI, the way a user
does. Each round starts four on-demand VM Jobs at once, in random order:
`m8a.xlarge`, `m8i.xlarge`, `m8a.4xlarge` and `m8i.4xlarge`. Starting them
together means drift over the run hits every arm alike. Each Job runs
[`guest.sh`](guest.sh) in `docker:27-cli` with `--host-docker` and a 100 GB
gp3 root disk:

1. `lscpu`, then `sysbench cpu` for 10 s on one thread and on every vCPU.
   These are comparable with RunsOn's public CPU figures.
2. The five builds of backmesh's
   [`benchmarks/builds/bench.yml`](https://github.com/backmesh/backmesh/blob/main/benchmarks/builds/bench.yml),
   with the same sources and commands. Each build runs in its toolchain's
   official image:
   - docker: `docker build` of grafana/k6 v0.54.0.
   - rust: `cargo build --release --locked` of ripgrep 14.1.1, with
     `rust:1.83`.
   - go: `go build ./...` and `go test ./pkg/cmd/pr/...` of cli/cli v2.62.0,
     with Go 1.22.6, its `go.mod` toolchain.
   - typescript: `npm ci` and `npx hereby local` of TypeScript v5.6.3, with
     Node 22.
   - python: `uv sync --frozen` and the three pytest files of pydantic
     v2.11.7, with Python 3.12 and uv 0.13.9.

Only the benchmark's own commands are timed, and the five toolchain images'
pulls together (`pull toolchain-images`), which the host's Docker writes to
the root disk. Clones are not. Neither are `cargo fetch` and
`go mod download`, so rust and go time the compile rather than the crate and
module downloads. `npm ci`, `uv sync` and `docker build` keep their
downloads, as in the benchmark. In the docker build these are k6's base
images and modules. Each Job also records two of the host's boot marks from
its Running event: `boot kernel to container start` and `boot image pull`,
the user data's pull of `docker:27-cli`. The pull's end mark is written only
once Docker has started, so `boot image pull` includes the rest of Docker's
start when the pull finishes first.

On GCP the arms are `n2-standard-4` (backmesh's first today), `n2d-standard-4`
(its second, AMD Zen 3), `c3d-standard-4` (Zen 4), and `c4d-standard-4` and
`n4d-standard-4` (Zen 5), in us-central1, falling back to us-east1. On Azure
they are `Standard_D4ads_v5` (backmesh's first, Zen 3), `D4ads_v6` and
`D4as_v6` (Zen 4), and `D4ads_v7` and `D4as_v7` (Zen 5), in eastus2. The
disk is anycloud's default `high` tier at 100 GB, as on backmesh's runners:
pd-ssd for n2, n2d and c3d, Hyperdisk Balanced with 8,000 IOPS and
1,000 MB/s provisioned for c4d and n4d, which can't take pd-ssd, and Premium
SSD on Azure.

`report.md` gives, for each build command and size:

- the median and range for each family;
- the ratio of the medians against today's family (m8a/m8i on AWS);
- a two-sided Mann-Whitney p (normal approximation with tie correction);
- the median's cost at the catalog's on-demand list price;
- each Job's whole VM time and its cost at the VM's and the disk's list
  prices (constants in `run.ts`: gp3, pd-ssd, Hyperdisk Balanced with its
  provisioned IOPS and throughput, and Premium SSD P10).

Every Job's log and the raw `results.json` are in the evidence.

## Spot capacity

`spot` asks EC2's `GetSpotPlacementScores` for one instance of each arm in
us-east-1, us-east-2 and us-west-2, by region and by zone. Scores run from 1
to 10. Then it starts one spot VM Job (`alpine:3.20`, `sleep 60`) per arm and
region through anycloud, 10 s apart. For each, it records whether a VM
launched within 10 minutes, the zone, the time to the VM, and how many
capacity refusals the API logged for that Job. The results go to
`spot-scores.json` and `spot-launches.json`. The twelve Jobs cost a few
cents.

On GCP, which has no placement score, `spot` starts the same Jobs in
us-central1, us-east4 and us-east1. On Azure it asks the Spot Placement Score
API (High, Medium or Low) for eastus2, eastus and centralus, by region and by
zone, and starts no Jobs: CI's subscription has 3 spot vCPUs a region.

## Cost

At most $10. The catalog's us-east-2 on-demand prices are `m8a.xlarge`
$0.243/h, `m8i.xlarge` $0.212/h, `m8a.4xlarge` $0.974/h and `m8i.4xlarge`
$0.847/h. At about 12 minutes per Job, ten rounds cost about $4. The run stops
starting rounds once its VMs' and disks' cost reaches $8. GCP's and Azure's
4-vCPU arms cost $0.17–0.23/h before the disk; their runs below cost about
$6.90 together at list price, $1.45 of it the held spot samples.

## Cleanup and ownership

Jobs are named `m8-<run>-r<round>-<type>` (`cg-` on GCP and Azure) and run with `--max-retries 0` and
`--no-checkpoint`, so they create no bucket. The API's database, the
inventory and the API log live in `$RUNNER_TEMP/m8a-vs-m8i`. `run` ends each
Job's VM when its log ends. At the end it terminates every Job and waits
until the API has cleaned them up. It then asks the cloud for anything tagged
(labelled, on GCP) `anycloud_deployment` with the run's Job IDs, and fails if
any remain: EC2 instances and volumes, GCP instances and disks in every zone,
and every Azure resource. `cleanup` reuses the run's API if it is still up,
or restarts it from the same state, and repeats that check. No round starts
after 45 minutes (55 in the runs below), so a run ends inside the Spike step. If the runner is lost
with its state, the Job IDs are in the run log; on GCP `sweep` deletes them,
elsewhere delete their resources by that tag. The region's shared anycloud network and
security group are not the run's; they stay.

## Result

[Run 45240701982](https://github.com/anycloud-sh/anycloud/actions/runs/45240701982)
(`473102d35`, 2026-11-23, us-east-2, every VM in us-east-2a): ten
rounds, 40 Jobs, none failed. The VMs cost $1.41 at list price, and cleanup
found no instance or volume left.

**At the same vCPU count, m8a takes 0.64–0.88 of m8i's time on every build
command. Over a Job's whole VM time it costs 0.91 of m8i at xlarge and 0.98
at 4xlarge.** The 0.88 is `uv sync` at 4xlarge, which takes under a second. Every m8a run
beat every m8i run in each command but the sub-second `uv sync`. Seconds are
medians over 10 Jobs, with ranges in parentheses. Ratio is m8a over m8i.

| Build command      | m8a.xlarge       | m8i.xlarge       | Ratio | m8a.4xlarge      | m8i.4xlarge      | Ratio |
| ------------------ | ---------------- | ---------------- | ----- | ---------------- | ---------------- | ----- |
| docker build       | 46.7 (45.7–47.7) | 64.4 (63.4–66.6) | 0.72  | 35.0 (34.4–36.0) | 45.3 (43.9–46.4) | 0.77  |
| go build           | 18.9 (18.4–19.8) | 29.5 (28.9–31.6) | 0.64  | 7.5 (7.5–7.5)    | 10.4 (10.2–10.9) | 0.72  |
| go test            | 3.5 (3.4–3.8)    | 5.3 (5.2–5.7)    | 0.66  | 1.2 (1.2–1.3)    | 1.7 (1.6–1.8)    | 0.73  |
| python install     | 0.5 (0.4–0.6)    | 0.6 (0.5–0.7)    | 0.80  | 0.5 (0.4–0.6)    | 0.6 (0.6–0.7)    | 0.88  |
| python test        | 5.3 (4.8–5.7)    | 6.1 (6.0–6.4)    | 0.87  | 4.8 (4.8–4.9)    | 6.1 (6.0–6.3)    | 0.79  |
| rust build         | 14.5 (13.8–15.8) | 22.8 (22.5–24.1) | 0.64  | 6.1 (6.1–6.2)    | 8.6 (8.4–8.8)    | 0.72  |
| typescript build   | 11.3 (10.3–11.7) | 15.2 (14.8–16.4) | 0.74  | 10.2 (10.1–10.3) | 12.7 (12.1–13.4) | 0.80  |
| typescript install | 1.7 (1.6–1.8)    | 2.6 (2.5–2.7)    | 0.66  | 1.7 (1.7–1.8)    | 2.3 (2.2–2.6)    | 0.74  |
| **All eight**      | **102.4**        | **146.5**        | 0.70  | **67.0**         | **87.7**         | 0.76  |
| Cost of all eight  | $0.0069          | $0.0086          | 0.80  | $0.0181          | $0.0206          | 0.88  |
| VM time per Job    | 229 s            | 288 s            | 0.80  | 199 s            | 232 s            | 0.86  |
| Cost per Job       | $0.0155          | $0.0169          | 0.91  | $0.0537          | $0.0547          | 0.98  |

- **Significance.** Mann-Whitney p is 0.00018 for every command but
  `uv sync` (0.0073 at xlarge and 0.0017 at 4xlarge). 0.00018 is the normal
  approximation's floor at n = 10 with no overlap. The exact two-sided p for
  no overlap is 1.1 × 10⁻⁵. `report.md` in the evidence has the p and cost
  of each command.
- **CPUs.** m8a is an AMD EPYC 9R45 with one thread per core. m8i is an Intel
  Xeon 6975P-C with two threads per core, so a 4-vCPU m8i has two cores.
- **sysbench cpu.** On one thread, m8a does 5,577 events/s and m8i 3,325
  (1.68×). On every vCPU it is 3.2× at both sizes: 22,190 against 6,999,
  and 88,429 against 28,006. sysbench's prime loop gains almost nothing from
  a core's second thread, so the all-vCPU figure overstates the build gain.
  The builds' 0.64–0.88 is the figure to quote.
- **Size.** The gain is larger at 4 vCPUs (0.70 overall) than at 16 (0.76).
  A likely cause is that the builds' serial parts, such as linking, weigh
  more at 16 vCPUs; the run doesn't measure it.
- **Cost.** "Cost of all eight" prices only the timed commands. A Job's VM
  time also includes boot, image pulls, clones and the untimed fetches, all of
  which m8a's higher hourly price applies to. "Cost per Job" is the median of
  each Job's VM time multiplied by its price, and is the figure to quote.
- **Scope.** The figures are for on-demand capacity and say nothing about
  spot capacity for m8a. The builds ran in containers on the VM, with
  `cargo fetch` and `go mod download` untimed, so they aren't GitHub
  workflow times. [Against GitHub's 4-core runner](#against-githubs-4-core-runner) compares
  them with `ubuntu-latest`.

### Spot capacity

Two `spot` samples, both on 2026-11-23 at 11:20 and 11:34 PST:
[run 45247427638](https://github.com/anycloud-sh/anycloud/actions/runs/45247427638)
and [run 45249880642](https://github.com/anycloud-sh/anycloud/actions/runs/45249880642).
In the first, twelve launches at once hit the account's RunInstances rate
limit twice, so the second spaced them 10 s apart. The second's report step
failed on the API's non-JSON migration lines, which is fixed since. Both
samples' figures below come from the retained `api.log`, with the fixed
parser's rules. Both cleanups found nothing left.

**In these two samples, m8a spot is not a viable first choice.** EC2 refused m8a in at least one
zone on 9 of the 10 m8a launches that weren't throttled. m8i was refused on 2
of 12. Every refused zone costs the launch 25–55 s before anycloud tries the
next, which is about the 44 s m8a saves over the eight timed xlarge commands.
`m8a.4xlarge` got no spot VM in us-east-2, backmesh's region, in either
sample: all three zones refused it, twice each time. This matches the 22 of
24 m8a spot refusals in us-east-2 that backmesh's `classes.ts` cites.

| Arm           | Region    | Launch (sample 1, 2)   | Zones refused (sample 1, 2) |
| ------------- | --------- | ---------------------- | --------------------------- |
| `m8a.xlarge`  | us-east-1 | 82 s, 24 s             | 2, 1                        |
| `m8a.xlarge`  | us-east-2 | 143 s (throttled), 3 s | 0, 0                        |
| `m8a.xlarge`  | us-west-2 | 78 s, 37 s             | 2, 1                        |
| `m8a.4xlarge` | us-east-1 | 55 s, 37 s             | 1, 1                        |
| `m8a.4xlarge` | us-east-2 | none (throttled), none | 3, 3 (each tried twice)     |
| `m8a.4xlarge` | us-west-2 | 31 s, 38 s             | 1, 1                        |
| `m8i.xlarge`  | us-east-1 | 4 s, 94 s              | 0, 2                        |
| `m8i.xlarge`  | us-east-2 | 3 s, 3 s               | 0, 0                        |
| `m8i.xlarge`  | us-west-2 | 4 s, 3 s               | 0, 0                        |
| `m8i.4xlarge` | us-east-1 | 128 s, 3 s             | 5, 0                        |
| `m8i.4xlarge` | us-east-2 | 3 s, 2 s               | 0, 0                        |
| `m8i.4xlarge` | us-west-2 | 4 s, 3 s               | 0, 0                        |

The 9 of 10 leaves out sample 1's two throttled m8a launches, both in
us-east-2. The `m8a.4xlarge` one was also refused in all three zones.
Launch is the time from the API resolving the target to the VM initializing,
read from `api.log`. `spot-launches.json` records something different: the
time from submitting the Job to the first poll that saw the VM's zone, polled
every 10 s. The refusals were `InsufficientInstanceCapacity`, except one
`Unsupported` in us-east-1e.

EC2's placement scores (1–10, for one instance) agreed in both samples. By
region, `m8a.xlarge` scored 1 in all three and `m8i.xlarge` scored 3.
`m8a.4xlarge` scored 3 in us-east-1 and us-west-2 and 1 in us-east-2;
`m8i.4xlarge` scored the same, except us-east-2 rose from 1 to 3 in the
second sample. By zone, `m8a.xlarge` scored 1 everywhere, and `m8i.xlarge`
scored 3 in most us-west-2 zones and in use2-az3.

Both samples are from one time of day. Re-dispatching `["spot"]` at other
times would show whether m8a spot frees up. On-demand m8a launched all 20 of
its Jobs at once in the build run.

## Against GitHub's 4-core runner

A preliminary check of whether `m8a.xlarge` on spot builds about twice as fast
as GitHub's `ubuntu-latest`, which has 4 vCPUs in a public repository. The
GitHub-hosted arm is [`hosted.yml`](hosted.yml): ten rounds of the same
`guest.sh`, in the same `docker:27-cli` container with the host's Docker
socket, three at a time. It runs from a branch of a public repository we own,
since `workflow_dispatch` needs the workflow on the default branch.

[Spike run 45342533189](https://github.com/anycloud-sh/anycloud/actions/runs/45342533189)
(`36e6d2e15`, arguments `["run", "--vcpus=4", "--spot",
"--region=us-east-2,us-east-1,us-west-2", "--rounds=10", "--parallel=3"]`)
and
[hosted run 45342571455](https://github.com/backmesh/benchmarks/actions/runs/45342571455)
on the `experiment/m8a-vs-github-4core` branch of `backmesh/benchmarks`
ran together on 2026-11-23 from 22:43 to 23:05 PST. All 30 rounds
succeeded. The spot VMs cost $0.22 with their disks, and cleanup found no
instance or volume left. The hosted runs cost nothing.

**`m8a.xlarge` took 0.56 of `ubuntu-latest`'s time over the eight timed
commands (99.5 s against 178.1 s, medians of each round's total), so it was
1.8× as fast. By build, over each build's timed commands, it took 0.49 of
the time for Go (2.0×), 0.55 for TypeScript, 0.58 for docker, 0.59 for rust
and 0.65 for Python. `m8i.xlarge`, which backmesh used before `m8a`, took
0.83.** These are build steps at the same vCPU count, not Job times. Seconds
are medians over 10 rounds, with ranges. For `m8a` every p is 0.00018, the
normal approximation's floor at n = 10 with no overlap; the exact two-sided p
is about 1.1 × 10⁻⁵.

| Build command      | m8a.xlarge spot  | m8i.xlarge spot  | ubuntu-latest    | m8a / hosted | m8i / hosted (p) |
| ------------------ | ---------------- | ---------------- | ---------------- | ------------ | ---------------- |
| docker build       | 46.0 (45.2–47.7) | 65.1 (63.9–66.3) | 79.4 (64.5–90.7) | 0.58         | 0.82 (0.0046)    |
| go build           | 18.6 (18.4–19.5) | 29.9 (29.0–30.9) | 37.4 (29.5–47.9) | 0.50         | 0.80 (0.0036)    |
| go test            | 3.4 (3.4–3.7)    | 5.3 (5.1–5.5)    | 7.1 (5.2–8.7)    | 0.49         | 0.75 (0.0046)    |
| python install     | 0.4 (0.3–0.4)    | 0.6 (0.6–0.7)    | 0.7 (0.6–0.8)    | 0.52         | 0.94 (0.57)      |
| python test        | 4.9 (4.8–5.5)    | 6.2 (6.1–6.4)    | 7.4 (5.9–9.5)    | 0.66         | 0.83 (0.31)      |
| rust build         | 14.0 (13.9–15.0) | 23.0 (22.5–23.6) | 23.7 (20.2–31.2) | 0.59         | 0.97 (0.24)      |
| typescript build   | 10.6 (10.3–11.3) | 15.4 (14.8–15.8) | 18.8 (15.2–24.4) | 0.56         | 0.82 (0.021)     |
| typescript install | 1.6 (1.6–1.8)    | 2.6 (2.5–2.7)    | 3.5 (2.6–4.5)    | 0.47         | 0.73 (0.0010)    |
| **All eight**      | **99.5**         | **148.6**        | **178.1**        | **0.56**     | **0.83**         |

- **Same vCPU count, not the same cores.** `m8a.xlarge`'s 4 vCPUs are 4
  cores, one thread each. `ubuntu-latest`'s, on every round, and `m8i`'s are
  2 cores with two threads each. Part of `m8a`'s lead is the extra cores.
- **GitHub's CPUs vary.** The ten hosted rounds landed on five CPUs: AMD EPYC
  7763 (2), 9V74 (3) and 9V45 (2), and Intel Xeon Platinum 8573C (1) and
  6975P-C (2). The 6975P-C is `m8i`'s CPU, and those rounds took `m8i`'s
  time, 147 and 148 s. The 7763 rounds took the longest, 216 and 217 s. So
  `m8a`'s 99.5 s is 0.46 of the slowest rounds (2.2×) and 0.68 of the
  fastest (1.5×): the ratio depends on which CPU GitHub draws. The
  spread is why `ubuntu-latest`'s ranges are wide and some of `m8i`'s p are
  weak. Ten rounds sample this mix only roughly.
- **Spot.** EC2 refused `m8a.xlarge` in us-east-1a on all 10 Jobs, and each
  then launched in us-east-1b; none failed to launch. anycloud tried
  us-east-1 before us-east-2 for both types: it orders the regions by its
  catalog, not by `--regions`, as it does for backmesh's Jobs. `m8i.xlarge`
  launched first time in us-east-2a every time. The spot prices were $0.0531/h
  for `m8a` and $0.0649/h for `m8i`.
- **Build steps, not Job time.** No queue, boot, image pull, clone or
  untimed fetch is in these figures, on either side. A spot `m8a` Job's whole
  VM time was 220–254 s against its 99.5 s of builds, while `ubuntu-latest`
  starts in seconds.
- **Not backmesh's runner.** The VM arms ran `guest.sh` in a container on an
  anycloud VM Job's raw host, not in backmesh's runner image. Both sides ran
  the same container, but the host's Docker, disk and network differ.
  backmesh's own benchmark on its labels is the check to quote.

## GCP and Azure

**At 4 vCPUs, GCP's Zen 5 `c4d` takes 0.50 of `n2`'s time over the eight
build commands, and Azure's Zen 5 `Dasv7` takes 0.74 of `Dadsv5`'s. Over a
Job's whole VM time with its disk, `c4d` costs 0.78 of `n2` and `Dasv7` 0.94
of `Dadsv5`.** Every newer family beat today's on every command at 4 vCPUs. For `c3d`, `c4d`,
`n4d` and both v7 sizes, Mann-Whitney p is below 0.001 on every command but
`c3d`'s sub-second `uv sync` (0.0014). `n2d`'s is 0.0017–0.0073 (`uv sync`
0.39), and v6's is below 0.001 except `docker build` (0.0013 and 0.021) and
`uv sync` (0.002–0.003). `report.md` in each run's evidence has every p.
Seconds are medians, with the ratio to today's
family in parentheses. The CPUs, from `lscpu`, all have two threads per core:
`n2` an Intel Xeon at 2.80 GHz (Cascade Lake), `n2d` an EPYC 7B13 (Zen 3),
`c3d` an EPYC 9B14 (Zen 4), `c4d` and `n4d` an EPYC 9B45 (Zen 5), `Dadsv5` an
EPYC 7763 (Zen 3), v6 an EPYC 9V74 (Zen 4) and v7 an EPYC 9V45 (Zen 5).

GCP, us-central1 with us-east1 as a fallback (`n4d` always ran in us-east1,
below):
[run 45260033603](https://github.com/anycloud-sh/anycloud/actions/runs/45260033603)
(its four complete rounds) and
[run 45278176294](https://github.com/anycloud-sh/anycloud/actions/runs/45278176294)
(eight rounds), merged with `report`.

These runs aren't in backmesh's anchor regions: its runners start in
us-east4 on GCP and eastus on Azure (`SUGGESTED_REGION` in backmesh's
`src/runners/regions.ts`). The hardware per family is the same, but capacity
and host mix may not be. 3 of the 14 `n2` Jobs (both sizes) landed on a host
whose sysbench single-thread score was 2.5 times the others' (2,885 against
1,155 events/s). The two of them at 4 vCPUs built the eight commands in 212
and 224 s, against 263–300 s on the rest. `c4d`'s 136 s is still 0.62 of
their median.

| Build command      | n2-4 (n=12) | c3d-4 (n=12)   | c4d-4 (n=12)   | n4d-4 (n=9)    | n2d-4 (n=12)   |
| ------------------ | ----------- | -------------- | -------------- | -------------- | -------------- |
| docker build       | 116.2       | 88.1 (0.76)    | 60.5 (0.52)    | 70.0 (0.60)    | 100.8 (0.87)   |
| go build           | 55.7        | 38.7 (0.70)    | 27.0 (0.48)    | 31.0 (0.56)    | 48.5 (0.87)    |
| go test            | 10.6        | 7.2 (0.68)     | 4.8 (0.46)     | 5.5 (0.52)     | 8.8 (0.83)     |
| python install     | 1.2         | 0.8 (0.62)     | 0.5 (0.43)     | 0.6 (0.50)     | 1.2 (0.95)     |
| python test        | 11.6        | 7.9 (0.68)     | 5.5 (0.47)     | 6.4 (0.55)     | 10.2 (0.87)    |
| rust build         | 38.8        | 25.5 (0.66)    | 20.0 (0.51)    | 23.1 (0.60)    | 31.8 (0.82)    |
| typescript build   | 30.7        | 19.0 (0.62)    | 13.8 (0.45)    | 15.5 (0.51)    | 24.7 (0.80)    |
| typescript install | 5.3         | 3.6 (0.67)     | 2.0 (0.38)     | 2.6 (0.49)     | 4.9 (0.91)     |
| **All eight**      | **270.8**   | 192.1 (0.71)   | 136.4 (0.50)   | 154.6 (0.57)   | 232.0 (0.86)   |
| VM time per Job    | 472 s       | 379 s (0.80)   | 289 s (0.61)   | 314 s (0.67)   | 425 s (0.90)   |
| Cost per Job       | $0.0285     | $0.0216 (0.76) | $0.0222 (0.78) | $0.0229 (0.80) | $0.0227 (0.80) |

Azure, eastus2:
[run 45279526845](https://github.com/anycloud-sh/anycloud/actions/runs/45279526845)
(ten rounds).

| Build command      | D4ads_v5  | D4as_v6        | D4ads_v6       | D4as_v7        | D4ads_v7       |
| ------------------ | --------- | -------------- | -------------- | -------------- | -------------- |
| docker build       | 92.3      | 86.7 (0.94)    | 86.0 (0.93)    | 79.7 (0.86)    | 81.3 (0.88)    |
| go build           | 46.6      | 36.6 (0.79)    | 36.2 (0.78)    | 30.0 (0.64)    | 30.0 (0.64)    |
| go test            | 8.7       | 7.0 (0.80)     | 6.9 (0.79)     | 5.8 (0.67)     | 5.6 (0.65)     |
| python install     | 0.9       | 0.7 (0.81)     | 0.7 (0.84)     | 0.6 (0.72)     | 0.6 (0.73)     |
| python test        | 9.3       | 7.3 (0.79)     | 7.2 (0.77)     | 5.5 (0.59)     | 5.5 (0.59)     |
| rust build         | 30.4      | 23.8 (0.78)    | 23.6 (0.77)    | 19.8 (0.65)    | 19.5 (0.64)    |
| typescript build   | 22.7      | 17.9 (0.79)    | 17.7 (0.78)    | 14.1 (0.62)    | 13.3 (0.59)    |
| typescript install | 4.3       | 3.4 (0.79)     | 3.4 (0.80)     | 2.7 (0.62)     | 2.7 (0.63)     |
| **All eight**      | **215.3** | 186.2 (0.86)   | 182.3 (0.85)   | 159.6 (0.74)   | 158.6 (0.74)   |
| VM time per Job    | 404 s     | 472 s (1.17)   | 463 s (1.15)   | 423 s (1.05)   | 434 s (1.07)   |
| Cost per Job       | $0.0261   | $0.0274 (1.05) | $0.0328 (1.25) | $0.0246 (0.94) | $0.0307 (1.18) |

- **GCP's disk.** `c4d` and `n4d` can't take pd-ssd, so their 100 GB disk is
  Hyperdisk Balanced at the `high` tier's 8,000 IOPS and 1,000 MB/s, which
  costs $0.092/h against pd-ssd's $0.023/h. That is a third of a
  `c4d-standard-4` Job's cost. With both disks left out, `c4d` would cost 0.58
  of `n2` per Job, and with Hyperdisk at its free baseline, about 0.55
  ([anycloud#41](https://github.com/anycloud-sh/anycloud/issues/41)). `c3d` keeps pd-ssd, which is why it is the cheapest per Job (0.76)
  although `c4d` is the fastest.
- **Azure's VM start and retries.** 7 of the 40 v6 and v7 Jobs, and none on
  v5, had a VM that anycloud failed seconds after creation with
  `powerState=stopped`. It labelled each one capacity-exhausted, deleted it
  and retried, 8 times in all, costing those Jobs about 2.5 minutes each
  ([anycloud#39](https://github.com/anycloud-sh/anycloud/issues/39)). This
  run's `run.ts` counted only a Job's last VM in its VM time, so the table
  leaves out the failed VMs' minutes; `run.ts` now sums every VM. Without
  retries, the last VM still took 34–76 s at 4 vCPUs from "Creating VM" to
  initializing, against 12 s for `D4ads_v5`, but not at 16 vCPUs (22 s
  against 30 s).
- **Azure's persistent cost: the OS disk.** A Job's untimed part (image
  pulls, clones, `cargo fetch`, `go mod download`, sysbench) took a median
  41–59 s longer on v6 and v7 than on v5 at 4 vCPUs and 60 s longer at 16.
  On those sizes it all runs on the P10 OS disk (below), so a Job's VM time
  is 1.05–1.17 of v5's and v7's build gain doesn't reach its whole cost.
- **Azure's resource disk.** The API logged "Image stores on the resource
  disk" for all 10 `D4ads_v5` Jobs and for no v6 or v7 Job, so on v6 and v7
  the stores stay on the OS disk
  ([anycloud#40](https://github.com/anycloud-sh/anycloud/issues/40)). v6 and v7's local disk is NVMe, which
  Azure doesn't format or mount the way it mounts v5's at `/mnt`; the run
  doesn't check that directly. Either way, the `ads` sizes there gain nothing
  over `as` and cost more. At 16 vCPUs this shows in `docker build` (below).
- **GCP on-demand capacity.** us-central1 refused `n4d-standard-4` in all four
  zones on every attempt in both runs (`ZONE_RESOURCE_POOL_EXHAUSTED`), so
  every `n4d` Job ran in us-east1. In the first run, which had only
  us-central1, `n4d` waited out its Jobs. us-central1-a also refused
  `n2d-standard-4` 8 times in the second run, and `c4d` once.

### 16 vCPUs

[GCP run 45297922161](https://github.com/anycloud-sh/anycloud/actions/runs/45297922161)
and
[Azure run 45298016320](https://github.com/anycloud-sh/anycloud/actions/runs/45298016320),
with `--arms` limiting them to today's family, the Zen 4 `c3d` and the
fastest Zen 5 per cloud.

| Build command    | n2-16 (n=2) | c3d-16 (n=4)   | c4d-16 (n=3)   | D16ads_v5 (n=10) | D16as_v7 (n=10) |
| ---------------- | ----------- | -------------- | -------------- | ---------------- | --------------- |
| docker build     | 74.8        | 56.1 (0.75)    | 38.0 (0.51)    | 59.0             | 62.9 (1.07)     |
| go build         | 17.1        | 13.4 (0.79)    | 9.4 (0.55)     | 16.7             | 11.6 (0.70)     |
| rust build       | 12.9        | 10.0 (0.78)    | 7.6 (0.59)     | 11.7             | 8.2 (0.70)      |
| typescript build | 21.3        | 15.1 (0.71)    | 10.5 (0.49)    | 18.9             | 10.8 (0.57)     |
| **All eight**    | **143.6**   | 108.2 (0.75)   | 74.4 (0.52)    | **123.7**        | 103.5 (0.84)    |
| VM time per Job  | 314 s       | 295 s (0.94)   | 231 s (0.73)   | 318 s            | 348 s (1.09)    |
| Cost per Job     | $0.0699     | $0.0615 (0.88) | $0.0534 (0.76) | $0.0752          | $0.0728 (0.97)  |

- **GCP quota.** CI's GCP project allows 32 vCPUs across all regions
  (`CPUS_ALL_REGIONS`) and 24 per VM family in us-central1, so only two
  16-vCPU VMs ran at a time. 9 of the 18 Jobs timed out waiting. The GCP
  figures are indicative only (n = 2–4, p ≥ 0.11), though they agree with
  4 vCPUs.
- **Azure's docker build.** `D16as_v7` is 0.57–0.73 of `D16ads_v5` on every
  CPU-bound command, but its `docker build` is 1.07 (p = 0.017): with no
  resource disk, its image store is on the P10 Premium SSD (500 IOPS,
  100 MB/s), while v5's is on the local disk.

### Spot capacity on GCP and Azure

GCP has no placement score. Two `spot` samples on GCP started one spot Job of
each 4-vCPU arm in us-central1, us-east4 and us-east1. The first,
[run 45258034276](https://github.com/anycloud-sh/anycloud/actions/runs/45258034276),
ended each Job as soon as the API had named its zone, which GCP does before
it accepts the VM, so it doesn't count; `spot` now waits for the VM to start
initializing. In the second,
[run 45260079313](https://github.com/anycloud-sh/anycloud/actions/runs/45260079313)
at 14:00 PST, **all 15 launched in the region's first zone with no refusal**,
within 12–32 s of submission, including `n4d-standard-4` in us-central1-a,
which on-demand refused there the same afternoon. Both samples' cleanups found
nothing left.

**`c4d` spot in us-east4, held.** `spot --regions=us-east4 --hold=1800`
starts spot Jobs that sleep 30 minutes and records whether each ran to the
end. Four samples, about 35 minutes apart, between 18:32 and 20:50 PST:
[45313105469](https://github.com/anycloud-sh/anycloud/actions/runs/45313105469),
[45317319456](https://github.com/anycloud-sh/anycloud/actions/runs/45317319456)
and
[45325418364](https://github.com/anycloud-sh/anycloud/actions/runs/45325418364)
with four `c4d-standard-4` each, and
[45321460371](https://github.com/anycloud-sh/anycloud/actions/runs/45321460371)
with two `c4d-standard-16`. **All 12 `c4d-standard-4` and the one
`c4d-standard-16` that started launched in us-east4-a within 23 s with no
refusal, and none was preempted in its 30 minutes.** The second
`c4d-standard-16` hit CI's 32-vCPU quota and didn't start (that sample
counted it as launched; `spot` now doesn't). Every cleanup found nothing left.

At the catalog's us-east4 spot prices, `c4d-standard-4` is $0.0967/h,
`c3d-standard-4` $0.0899/h and `n2-standard-4` $0.0569/h, which is a quarter
of its on-demand price. With the VM times measured above (us-central1,
on-demand), a spot Job would cost about $0.0105 on `n2` and $0.0119 on `c3d`,
both with pd-ssd, and $0.0152 on `c4d` with its Hyperdisk, 1.45 of `n2`. With
Hyperdisk at its free baseline
([anycloud#41](https://github.com/anycloud-sh/anycloud/issues/41)), `c4d`
would cost about $0.0087, 0.82 of `n2`, for 0.61 of its VM time.

Azure's Spot Placement Score API answered for CI's identity
([run 45258012801](https://github.com/anycloud-sh/anycloud/actions/runs/45258012801),
12:18 PST), and launches can't be sampled with 3 spot vCPUs a region. By
region, every v6 and v7 size scored High in eastus2 and eastus, while
`D4ads_v5` scored Medium in eastus2 and Low in centralus, where `D4ads_v6`
was also Low. By zone, `D4ads_v5` was Low in eastus2-2 and not offered in
eastus2-3 or any eastus zone. Both v7 sizes were not offered in eastus2-1 and
scored High everywhere else. Every score is flagged `isQuotaAvailable: false`,
CI's 3 spot vCPUs a region.

### Cleanup on GCP and Azure

Every run's cleanup found nothing left, with one exception. The first GCP run
reached the Spike step's 85-minute limit, because its `n4d` Jobs waited
40 minutes each for us-central1 capacity. Its runner, API and state were lost
with three round-6 VMs still running. Its cleanup step then failed: it
started a second API with a new token while the first still served the port.
`sweep` deleted the three VMs and their disks about 22 minutes later
([run 45275286428](https://github.com/anycloud-sh/anycloud/actions/runs/45275286428)),
and
[run 45278096799](https://github.com/anycloud-sh/anycloud/actions/runs/45278096799)
confirmed nothing labelled with that run's IDs remains. The fixes are in
`run.ts`: Jobs time out after 20 minutes, no round starts after 45, and
`cleanup` reuses a running API. In the Azure 4-vCPU run, the run step's check
saw one virtual network still being deleted. The owned cleanup step found
nothing minutes later.

## c4d's Hyperdisk settings

[anycloud#41](https://github.com/anycloud-sh/anycloud/issues/41) asks whether a
VM Job host on `c4d` needs the `high` tier's Hyperdisk Balanced at 8,000 IOPS
and 1,000 MiB/s, which costs $0.092/h at 100 GB. GCP bills IOPS over 3,000
($0.000006849/h each) and throughput over 140 MiB/s ($0.000054795/h per
MiB/s), and caps throughput at a quarter of the IOPS. `--variants` ran today's
setting beside cheaper ones, each from its own API, one Job of each per
round: `c4d-standard-4`, on demand, in us-east4 (every Job in us-east4-a),
`--rounds=12 --parallel=2`, n = 12 per arm.

- [Run 45336210940](https://github.com/anycloud-sh/anycloud/actions/runs/45336210940)
  (`a72beffa9`): today against 6,000 IOPS and 240 MiB/s (pd-ssd's per-VM
  baseline, $0.037/h) and 3,000 and 140 (Hyperdisk's free baseline,
  $0.011/h).
- [Run 45353870772](https://github.com/anycloud-sh/anycloud/actions/runs/45353870772)
  (`cee978edf`): today against 3,000 IOPS at 750 MiB/s ($0.044/h, the most
  GCP allows at 3,000 IOPS) and at 500 ($0.031/h).

Both runs used an older layout of this directory: the branch carried a
variant's setting (6,000 / 240 in the first run, 3,000 / 750 in the second),
`@baseline` built today's from a `baseline.patch`, and `@free` and `@t500`
patched the branch. `variant-t750.patch` and `variant-t500.patch` now patch
today's setting instead. `report` prices those runs' `@baseline` and `@free`
arms, but takes their unpatched arm for today's: it prices that arm at
8,000 / 1,000 and compares the other arms with it rather than with
`@baseline`.

Both runs' 36 Jobs succeeded and their cleanup found nothing left; each cost
$0.69. [Run 45343058302](https://github.com/anycloud-sh/anycloud/actions/runs/45343058302)
asked for 3,000 IOPS at 1,000 MiB/s, which GCP refuses (above), so it
doesn't count.

Each cell is the setting's median over today's in the same run, with the
Mann-Whitney p. Today's medians: VM time 268 s and 277 s, toolchain pulls
26.1 s in both, `docker build` 57.9 s and 58.0 s.

| Measure                        | 6,000 / 240    | 3,000 / 140    | 3,000 / 750  | 3,000 / 500   |
| ------------------------------ | -------------- | -------------- | ------------ | ------------- |
| boot kernel to container start | 1.03 (0.21)    | 1.14 (0.0001)  | 1.06 (0.050) | 1.04 (0.31)   |
| boot image pull                | 1.22 (0.011)   | 1.40 (0.0006)  | 1.02 (0.20)  | 1.03 (0.14)   |
| pull toolchain-images          | 1.17 (<0.0001) | 1.51 (<0.0001) | 1.04 (0.014) | 1.06 (0.0002) |
| docker build                   | 1.04 (0.0014)  | 1.15 (<0.0001) | 1.03 (0.026) | 1.04 (0.017)  |
| go, rust, typescript, python   | 0.97–1.00      | 0.97–1.02      | 0.97–1.00    | 0.98–1.01     |
| VM time per Job                | 1.06 (0.0073)  | 1.19 (0.0006)  | 1.02 (0.51)  | 1.04 (0.75)   |
| Cost per Job, on demand        | 0.85           | 0.84           | 0.84         | 0.81          |
| Cost per Job, spot, vs `n2`    | 1.01           | 0.90           | 1.05         | 0.97          |

**Every cheaper setting slows image extraction.** The CPU-bound builds don't
change, but the toolchain pulls and `docker build`, which write image layers
to the root disk, are 3–6% slower even at 3,000 IOPS and 750 MiB/s, and
15–51% slower at the free baseline. No setting met the bar of no significant
slowdown (p ≥ 0.05 and within about 2% on VM time, pulls, `docker build` and
boot), so anycloud keeps 8,000 IOPS and 1,000 MiB/s.

**Spot.** At the catalog's us-east4 spot price for `c4d-standard-4`
($0.0967/h), a Job at today's setting costs $0.0146 in the second run, 1.39
times `n2`'s $0.0105 (from the spot section above, which used us-central1's
on-demand VM time). At 3,000 IOPS and 750 MiB/s it would cost $0.0110, 1.05
times `n2`, for about 0.6 of `n2`'s VM time.

A side finding: the 3,000 / 1,000 Jobs never started. GCP's 400 "Requested
provisioned throughput is too high for the provisioned iops" was diagnosed as
a temporary provider failure, so anycloud retried it in the same zone until
the Job's 20-minute timeout.

## Promotion criteria

None. m8a's build gain is clear, but its spot capacity isn't there in these
samples, so no backmesh change is proposed for spot classes. Putting m8a
first for backmesh's on-demand classes would be a separate backmesh change,
filed with these figures.

For GCP and Azure, none here either: the figures go to backmesh, which owns
its VM families. For its on-demand classes they suggest `c4d` (or `c3d`,
which keeps pd-ssd) ahead of `n2` on GCP. For spot classes, `c4d` launched
and held every time in us-east4, but `n2`'s cheap spot price keeps it cheaper
per Job until
[anycloud#41](https://github.com/anycloud-sh/anycloud/issues/41) cuts
Hyperdisk's cost; [the A/Bs above](#c4ds-hyperdisk-settings) found no cheaper
setting without a small slowdown in image extraction, so that trade-off is
open. On Azure, `Dasv7` isn't ahead of `Dadsv5` over a whole Job
until anycloud fixes
[anycloud#39](https://github.com/anycloud-sh/anycloud/issues/39) and
[anycloud#40](https://github.com/anycloud-sh/anycloud/issues/40).

## Deletion criteria

Delete this directory once the result is recorded and backmesh has decided
on its VM family.

# m8a against m8i

- Status: Complete. Results are below.
- Decision record: it asks how much faster AWS m8a (AMD EPYC, Zen 5) builds
  than m8i (Intel Xeon 6), which backmesh's runners land on today, at the same
  vCPU count. backmesh's labels can't choose a VM family, so this runs in
  anycloud VM Jobs. Speed claims compare equal vCPUs, so any gain comes from
  the CPU generation. An m8a vCPU is a whole core and an m8i vCPU is a
  hyperthread; the `lscpu` lines record it.
- Run: `experiments/m8a-vs-m8i/run.ts` through the
  [Spike workflow](../../.github/workflows/spike.yml), with `arguments` `[]`
  and `cleanup_arguments` `["cleanup"]`. `--rounds=<n>` (default 10),
  `--parallel=<n>` (rounds at a time, default 3) and `--region=<region>`
  (default us-east-2) change the run. `["spot"]` measures spot capacity
  instead (below). `report <results.json...>` rewrites the report from saved
  results without a cloud.

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

Only the benchmark's own commands are timed. Image pulls and clones are not.
Neither are `cargo fetch` and `go mod download`, so rust and go time the
compile rather than the crate and module downloads. `npm ci`, `uv sync` and
`docker build` keep their downloads, as in the benchmark. In the docker build
these are k6's base images and modules.

`report.md` gives, for each build command and size:

- the median and range for each family;
- the m8a/m8i ratio of the medians;
- a two-sided Mann-Whitney p (normal approximation with tie correction);
- the median's cost at the catalog's on-demand list price.

Every Job's log and the raw `results.json` are in the evidence.

## Spot capacity

`spot` asks EC2's `GetSpotPlacementScores` for one instance of each arm in
us-east-1, us-east-2 and us-west-2, by region and by zone. Scores run from 1
to 10. Then it starts one spot VM Job (`alpine:3.20`, `sleep 60`) per arm and
region through anycloud, all at once. For each, it records whether a VM
launched within 10 minutes, the zone, the time to the VM, and how many
capacity refusals the API logged for that Job. The results go to
`spot-scores.json` and `spot-launches.json`. The twelve Jobs cost a few
cents.

## Cost

At most $10. The catalog's us-east-2 on-demand prices are `m8a.xlarge`
$0.243/h, `m8i.xlarge` $0.212/h, `m8a.4xlarge` $0.974/h and `m8i.4xlarge`
$0.847/h. At about 12 minutes per Job, ten rounds cost about $4. The run stops
starting rounds once its VMs' cost reaches $8.

## Cleanup and ownership

Jobs are named `m8-<run>-r<round>-<type>` and run with `--max-retries 0` and
`--no-checkpoint`, so they create no bucket. The API's database, the
inventory and the API log live in `$RUNNER_TEMP/m8a-vs-m8i`. `run` ends each
Job's VM when its log ends. At the end it terminates every Job and waits
until the API has cleaned them up. It then asks EC2 for instances and volumes
tagged `anycloud_deployment` with the run's Job IDs, and fails if any remain.
`cleanup` restarts the API from the same state and repeats that check. If
the runner is lost with its state, the Job IDs are in the run log; delete
their instances by that tag. The region's shared anycloud network and
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
  workflow times. There is no comparison with GitHub's runners.

## Promotion criteria

None. A clear m8a gain would become a separate backmesh change that prefers
m8a for its labels, filed with these figures.

## Deletion criteria

Delete this directory once the result is recorded and backmesh has decided
on its VM family.

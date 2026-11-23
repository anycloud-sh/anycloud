# m8a against m8i

- Status: Ready, not yet dispatched.
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
  (default us-east-2) change the run. `report <results.json...>` rewrites
  the report from saved results without a cloud.

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

Pending.

## Promotion criteria

None. A clear m8a gain would become a separate backmesh change that prefers
m8a for its labels, filed with these figures.

## Deletion criteria

Delete this directory once the result is recorded and backmesh has decided
on its VM family.

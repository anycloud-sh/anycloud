# Azure arm64 runners

- Status: Ready, not yet dispatched.
- Decision record: backmesh tracker row N1 asks whether backmesh's arm labels
  can run on Azure, as they do on AWS Graviton and GCP Axion, and which class
  to ship first. It measures Cobalt 100 (`Standard_D4ps_v6`) and Ampere
  Altra (`Standard_D4ps_v5`) against an x86-64 runner backmesh runs,
  `Standard_D4s_v5`, as anycloud VM Jobs: launch to the container, and
  three of backmesh's builds. It also samples Arm spot capacity in eastus2,
  centralus and westeurope, and is the live check of the pull request that
  marks Azure's Arm types arm64.
- Run: `experiments/azure-arm64/run.ts` through the
  [Spike workflow](../../.github/workflows/spike.yml), with
  `cleanup_arguments` `["cleanup"]`. `["preflight"]` records the catalog's
  rows, the SKUs' capabilities, Canonical's Ubuntu 24.04 SKUs and the
  quotas, and creates nothing. `["run"]` runs the builds: `--rounds=<n>`
  (default 8), `--parallel=<n>` (rounds at a time, default 2) and
  `--arms=<type,...>`. `["spot"]` runs the spot probe.
  `report <results.json...>` rewrites the report without a cloud.

## What it measures

`run` and `spot` first run the preflight: they build the Azure catalog with
the branch's fetcher, which reads each SKU's `CpuArchitectureType`
capability (`Arm64` or `x64`) into the catalog's `Arch` column, and fail
unless every Arm type is marked `arm64` and Canonical's `ubuntu-24_04-lts`
offer has `minimal-arm64` and `server-arm64`. They write that catalog to the
API's and CLI's catalog directories, and point `raw.githubusercontent.com`
and `api.github.com` at `0.0.0.0` in `/etc/hosts` while they run, so the
API's refresh fails and keeps it (the published catalog has no Azure `Arch`
until the fetcher runs on main). Then they start the branch's API with the
spike's Azure credentials and use its CLI, the way a user does.

Each `run` round starts one on-demand Job per arm in centralus at once, in a
random order, on backmesh's Azure runner disk (100 GB, Premium SSD). Each
runs `uname -m` and then [`local-nvme`'s `guest.sh`](../local-nvme/guest.sh)
in `docker:27-cli` with `--host-docker`, as backmesh's runners do: pulls of
`rust:1.83-bookworm` and `node:22-bookworm`, `docker build` of grafana/k6
v0.54.0, `cargo build --release --locked` of ripgrep 14.1.1, and `npm ci`
and `npx hereby local` of TypeScript v5.6.3. A Job passes when every build
ran and `uname -m` matches its type's architecture.

`report.md` gives, for each Arm arm against `Standard_D4s_v5`, the median
and p90 of each timed command, of the builds together, of the VM's launch to
the Job's Running event (`boot launch-to-container`), of the kernel's boot to
the container's start (`boot kernel-to-container`), of the Job's VM time and
of its cost (VM time at the price the API recorded, plus the disk's list
price), with the ratio of medians and a two-sided Mann-Whitney p.

The spike runs in our subscription ("backmesh e2e"), whose only quota for
an x86-64 type backmesh runs is DSv5's 10 vCPUs in centralus; its first
4-vCPU type, `Standard_D4ads_v5`, has none. `D4s_v5` is backmesh's third
choice, Intel Ice Lake rather than AMD Milan, and like the Arm types has no
resource disk, so all three keep Docker's and containerd's stores on the OS
disk.

`spot` submits one spot Job (`uname -m`) of `Standard_D2ps_v6` and
`Standard_D2ps_v5` in each of eastus2, centralus and westeurope, one at a
time, as CI's subscription has 3 spot vCPUs a region. `spot.json` records
whether each launched, its times, and the refusal's events and log if not.

## Cost

Within the $10 the owner approved. A build Job takes about 6–10 minutes; 8
rounds of three 4-vCPU arms on demand come to about $2. `run` stops starting
rounds once its VMs and disks reach $8. The spot probe's six 2-vCPU VMs run
for a few minutes each, under $0.10.

## Cleanup

The API's database, the inventory and the API log live in
`$RUNNER_TEMP/azure-arm64`. `run` and `spot` end by terminating every Job,
waiting until the API has cleaned each up, and listing the subscription's
resources tagged `anycloud_deployment` with one of the run's Job IDs;
`cleanup` restarts the API from the same state and does the same, and fails
if anything is left. If the runner is lost with its state, the Job IDs
(`aa-<run>-...`) are in the run log: delete the resources whose
`anycloud_deployment` tag names them.

## Promotion criteria

None as an experiment. A go supports backmesh's Azure arm labels, a
separate change; the unit tests cover the catalog's `Arch` column and the
image SKU.

## Deletion criteria

Delete this directory once the result is recorded and N1's class order is
decided.

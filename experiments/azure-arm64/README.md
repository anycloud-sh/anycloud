# Azure arm64 runners

- Status: Done, a go: ship Cobalt (`Dpsv6`) first, then Ampere (`Dpsv5`).
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
  `--arms=<type,...>`. `["spot"]` runs the spot probe, and `["vm"]` a
  persistent VM of each 2-vCPU Arm type.
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

## Result

[Spike run 46069074060](https://github.com/anycloud-sh/anycloud/actions/runs/46069074060)
(`41d27148c`, 2026-11-27, about 13:15–13:55 PST) in our subscription
("backmesh e2e", `azure_subscription` `own`): 8 rounds of the three arms in
centralus, 24 Jobs, all passed with the `uname -m` their type should have. The
VMs and disks cost $0.50. The run failed on its own cleanup check: Azure still
listed one Job's VNet seconds after anycloud deleted it, and a preflight
about 10 minutes later
([run 46073738886](https://github.com/anycloud-sh/anycloud/actions/runs/46073738886))
found nothing left, so `verifyClean` now waits up to 5 minutes
for the list to catch up.

**Go. Cobalt 100 is faster and cheaper than the x86-64 runner; Ampere is
cheaper and a little slower.** Cobalt took 0.83 of `D4s_v5`'s time for the
builds together (p = 0.00094) at 0.68 of its cost a Job (p = 0.010). Ampere
took 1.05 of its time (p = 0.0019) at 0.83 of its cost (p = 0.00094). Cobalt
was faster at `docker build` (0.70) and boot (kernel to container 0.82),
slightly slower at the Rust and TypeScript compiles (1.03 and 1.09).
Ampere's compiles were 1.43 and 1.56. So backmesh's Azure arm labels launch
Cobalt's `Dpsv6` first and Ampere's `Dpsv5` where Cobalt has no capacity or
quota. Seconds are medians, with p90 in parentheses; ratios are the Arm type's
median over `D4s_v5`'s, with a two-sided Mann-Whitney p.

| Measure                  | `D4ps_v6` (Cobalt) | `D4ps_v5` (Ampere) | `D4s_v5`        | Cobalt ratio | Ampere ratio |
| ------------------------ | ------------------ | ------------------ | --------------- | ------------ | ------------ |
| boot launch-to-container | 32.7 (36.1)        | 34.6 (38.2)        | 35.3 (38.3)     | 0.93         | 0.98         |
| boot kernel-to-container | 18.4 (22.1)        | 21.0 (23.5)        | 22.3 (24.3)     | 0.82         | 0.94         |
| pull toolchain-images    | 32.1 (38.3)        | 37.1 (45.4)        | 36.9 (40.0)     | 0.87         | 1.01         |
| docker build             | 86.9 (93.3)        | 107.6 (109.7)      | 123.9 (125.5)   | 0.70         | 0.87         |
| rust build               | 32.0 (32.8)        | 44.3 (46.7)        | 31.1 (31.5)     | 1.03         | 1.43         |
| typescript install       | 4.2 (4.4)          | 5.5 (5.7)          | 4.2 (4.3)       | 1.00         | 1.31         |
| typescript build         | 22.7 (23.2)        | 32.2 (33.8)        | 20.7 (21.2)     | 1.09         | 1.56         |
| all builds               | 180.1 (189.1)      | 227.3 (235.9)      | 217.1 (221.0)   | 0.83         | 1.05         |
| VM time per Job          | 321.4 (392.9)      | 358.7 (368.6)      | 357.0 (381.3)   | 0.90         | 1.00         |
| cost per Job ($)         | 0.0165 (0.0202)    | 0.0200 (0.0206)    | 0.0242 (0.0258) | 0.68         | 0.83         |

Only `D4ps_v6` and `D4ps_v5` were measured. The other sizes and the
high-memory `Epsv6` and `Epsv5` are the same CPUs, so the order carries over
to them, but none was timed.

The VMs' list prices in centralus were $0.158, $0.174 and $0.217 an hour, and
the disk's $0.027. The CPUs were Neoverse-N2 (Cobalt), Neoverse-N1 (Ampere)
and Intel Xeon Platinum 8573C. `D4s_v5` is backmesh's third Azure choice:
`D4ads_v5`, its first, has no quota in our subscription.

### Spot

[Spike run 46073800412](https://github.com/anycloud-sh/anycloud/actions/runs/46073800412)
(`b0860e658`): one spot Job of each type a region. In eastus2 and centralus
all four launched at the first try, in 32 to 38 s from launch to container.
In westeurope Azure refused every launch of both types with
`RequestDisallowedByAzure`, "The selected region is currently not accepting
new customers": a restriction on our new subscription in that region, not
on Arm or spot. Cleanup found nothing left. An earlier
[run 46069090606](https://github.com/anycloud-sh/anycloud/actions/runs/46069090606)
submitted nothing: its Job IDs were over anycloud's 28 characters.

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

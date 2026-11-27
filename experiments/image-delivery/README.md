# Image delivery

- Status: Runs
  [45239008856](https://github.com/anycloud-sh/anycloud/actions/runs/45239008856)
  (AWS and Azure, source `7c5312a1a`),
  [45246753247](https://github.com/anycloud-sh/anycloud/actions/runs/45246753247)
  (GCP disks, `6eb525b24`),
  [45251963955](https://github.com/anycloud-sh/anycloud/actions/runs/45251963955)
  (GCP registries, lazy and baked on pd-standard, `6eb525b24`) and
  [45257355410](https://github.com/anycloud-sh/anycloud/actions/runs/45257355410)
  (GCP and Azure on the shipped disks, `296b6f7b7`), 2026-11-23: ten VMs per
  arm, interleaved; cleanup left nothing. The results are below. They
  replace run 45189626411's, whose baked arm started in bursts after the
  others. Azure's `regional` and `lazy` arms are still to run.
- Decision record: backmesh/backmesh#97, row C14 (owner, 2026-11-23: "it
  would be useful to spike same region mirror vs baking to understand how
  much we would win"). C14's boot marks
  ([vm-boot-marks](../vm-boot-marks/README.md), run 45099715079) put the
  runner image's pull as the largest piece of a VM Job host's kernel →
  container start on every cloud. This run sizes what each way of delivering
  that image would win. The owner ruled out baked VM images (#2182); the
  baked arm is here only as the upper bound.
- Run: `experiments/image-delivery/run.ts` through the
  [Spike workflow](../../.github/workflows/spike.yml), with `arguments` `[]`
  and `cleanup_arguments` `["cleanup"]`. `["run", "<cloud>", ...]` runs only
  the named clouds (`aws`, `gcp`, `azure`); `--count=N` sets the VMs per arm
  (default 5), `--arms=a,b` the arms, `--parallel=N` the VMs per cloud at
  once (default 5), and `--disk=fast` or `--disk=balanced` the disk of every
  arm that doesn't set its own.

## What it measures

Each VM boots with the branch's own CPU Job-host user data
(`generateJobHostUserData`, with #26's boot marks): Ubuntu minimal, Docker
29 on the system containerd, and the image pulled through containerd's
transfer service while the host starts. The run changes that user data only
where an arm changes delivery. A unit beside it waits for the pull, then
starts the image at once and runs a first step that reads the image's tools
(`node`, `npm`, `python3` with `ssl` and `sqlite3`, `git`, and a `gcc`
compile). The API's own SSH steps are left out, so `container-started` is
when the host could start the container. The runner reads each VM's marks
over SSH, then deletes it.

The image is backmesh v0.5.6's runner, pinned by digest (724 MB of zstd
layers). VMs are `backmesh-4`-shaped and on demand, 100 GB root disk:

| Cloud | Region    | VM types, in order                       | Root disk (baseline)                                                                                                           |
| ----- | --------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| AWS   | us-east-2 | `m8i.xlarge`, `m7i.xlarge`, `m7a.xlarge` | gp3, 4,000 IOPS, 500 MiB/s: backmesh's setting (anycloud's default tier is 8,000 / 1,000)                                      |
| GCP   | us-east4  | `n2-standard-4`, `n2d-standard-4`        | pd-standard: anycloud's medium tier on n2. The shipped disk, anycloud's default tier and backmesh's, is pd-ssd (`--disk=fast`) |
| Azure | eastus2   | `Standard_D4ads_v5`                      | Standard_LRS; the image stores go on the resource disk. backmesh ships Premium_LRS (`--disk=fast`)                             |

| Arm                | What changes                                                                                                                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ghcr`             | Nothing: the baseline, from GHCR.                                                                                                                                                                  |
| `regional`         | The same digest, copied into ECR private / Artifact Registry / ACR (Standard) in the VM's region. The transfer pull reads a pull-scoped token from a hosts directory.                              |
| `ghcr-c10`         | The transfer service's `max_concurrent_downloads` 10 instead of 3, from GHCR. The image is already zstd, so zstd is the baseline.                                                                  |
| `regional-c10`     | Both.                                                                                                                                                                                              |
| `lazy`             | The image converted to eStargz (buildx, no prefetch landmarks) in the regional registry; stargz-snapshotter v0.19.1 installed beside Docker; `ctr-remote rpull`, then `ctr run`.                   |
| `baked`            | A VM image made from a baseline VM after its pull: Docker installed and the image in containerd's store at boot. Azure's builder and baked VMs are `Standard_D4as_v5`, which has no resource disk. |
| `fast-disk`        | AWS gp3 16,000 IOPS and 1,000 MiB/s; GCP pd-ssd (`--disk-tier high`); Azure Premium_LRS.                                                                                                           |
| `balanced-disk`    | GCP only: pd-balanced. AWS's gp3 baseline is already its SSD tier.                                                                                                                                 |
| `no-resource-disk` | Azure only: `ghcr` on `Standard_D4as_v5`, the baked arm's VM type, so its stores sit on the OS disk. The baked arm's control.                                                                      |

ECR's pull-through cache is not measured: a GHCR rule needs a Secrets
Manager credential, and its warm pulls are the `regional` arm. Azure's
`regional` and `lazy` arms wait on its registry: the Azure CI subscription
had no `Microsoft.ContainerRegistry` provider until it moved to our own
(ee1e6fe6, 2026-11-27), and they haven't been run since. The run skips an
arm whose registry it can't make and records why.

Arms are interleaved. Each cloud bakes its image first; then each round
starts one VM of every arm, at most five at once. `summary.json` records the
VM type each trial landed on, and `trials.json` each baked trial's launch
in seconds after its image was ready (`sinceBake`).

Per cloud and arm, `summary.json` gives medians of: the pull (`pull-start` →
`pull-end`, its bytes and MB/s), kernel → container start, the first step,
launch → kernel (the create call to the kernel's start, from the VM's
clock), launch → first step's end, and that last figure's win over `ghcr`.
For kernel → container and launch → first step's end it also gives each
arm's range and the two-sided exact Mann-Whitney U p-value against `ghcr`.
`trials.json` has every VM's marks; `table.md` the table below.

## Result

Medians of ten VMs per arm, in seconds, with the range. "Win" is the arm's
launch → first step's end against `ghcr`'s in the same run; positive is
faster. p is the exact two-sided Mann-Whitney U test of that figure
against `ghcr`'s. Every VM landed on its arm's first VM type.

Against what ships (backmesh's `backmesh-4` classes: gp3 4,000 / 500 on
AWS, pd-ssd on GCP, Premium_LRS on Azure):

| Cloud | Baseline | Arm                          | Win   | p      |
| ----- | -------- | ---------------------------- | ----- | ------ |
| AWS   | 25.2     | `baked`                      | +9.1  | <0.001 |
| AWS   |          | best other: `ghcr-c10`       | +1.7  | 0.052  |
| GCP   | 48.9     | `baked`                      | +15.3 | 0.001  |
| GCP   |          | `lazy`                       | −1.3  | 0.58   |
| Azure | 42.3     | `baked` (`Standard_D4as_v5`) | −1.4  | 0.53   |

So baking is the only lever that beats the shipped configuration, on AWS
and GCP. On Azure the product's resource disk already matches it. Neither a same-region registry nor more download lanes wins where
measured; Azure's registry isn't yet, and GCP's only on pd-standard.

On the shipped disks, run 45257355410 (`--disk=fast`; Azure's `lazy` skipped):

| Cloud | Arm                                     | ok    | pull | MB/s | launch → container | first step | launch → step end | win   | p      |
| ----- | --------------------------------------- | ----- | ---- | ---- | ------------------ | ---------- | ----------------- | ----- | ------ |
| GCP   | `ghcr`                                  | 10/10 | 19.1 | 40.2 | 48.7 (45.8–62.8)   | 0.2        | 48.9 (46.0–63.1)  | 0     | —      |
| GCP   | `lazy`                                  | 10/10 | 3.5  | 34.7 | 37.5 (35.3–38.8)   | 13.6       | 50.2 (46.6–53.8)  | −1.3  | 0.58   |
| GCP   | `baked`                                 | 10/10 | 1.8  | —    | 32.4 (28.0–58.9)   | 1.1        | 33.6 (28.8–60.1)  | +15.3 | 0.001  |
| Azure | `ghcr`                                  | 10/10 | 13.3 | 58.9 | 42.1 (36.5–69.9)   | 0.2        | 42.3 (36.6–70.0)  | 0     | —      |
| Azure | `baked` (`Standard_D4as_v5`)            | 10/10 | 3.4  | —    | 38.0 (34.6–46.0)   | 5.3        | 43.7 (40.0–52.8)  | −1.4  | 0.53   |
| Azure | `no-resource-disk` (`Standard_D4as_v5`) | 10/10 | 35.7 | 21.6 | 73.5 (65.8–81.4)   | 0.2        | 73.7 (66.0–81.6)  | −31.4 | <0.001 |

AWS, run 45239008856 (`m8i.xlarge`, gp3 4,000 IOPS / 500 MiB/s, as shipped):

| Arm            | ok    | pull | MB/s  | launch → container | first step | launch → step end | win  | p      |
| -------------- | ----- | ---- | ----- | ------------------ | ---------- | ----------------- | ---- | ------ |
| `ghcr`         | 10/10 | 8.5  | 89.6  | 25.1 (23.0–35.1)   | 0.1        | 25.2 (23.1–35.2)  | 0    | —      |
| `regional`     | 10/10 | 9.4  | 78.5  | 24.7 (23.7–32.1)   | 0.1        | 24.9 (23.8–32.2)  | +0.3 | 0.68   |
| `ghcr-c10`     | 10/10 | 8.5  | 89.2  | 23.4 (22.3–25.6)   | 0.1        | 23.5 (22.4–25.7)  | +1.7 | 0.052  |
| `regional-c10` | 10/10 | 9.1  | 81.0  | 24.5 (23.3–34.7)   | 0.1        | 24.6 (23.4–34.8)  | +0.6 | 0.63   |
| `lazy`         | 10/10 | 1.8  | 88.1  | 22.1 (17.8–32.6)   | 6.3        | 28.9 (23.9–38.9)  | −3.7 | 0.14   |
| `fast-disk`    | 10/10 | 6.9  | 110.4 | 24.6 (20.6–29.0)   | 0.1        | 24.7 (20.7–29.2)  | +0.5 | 0.35   |
| `baked`        | 10/10 | 1.2  | —     | 15.1 (13.8–23.1)   | 0.9        | 16.1 (14.6–25.1)  | +9.1 | <0.001 |

GCP, `n2-standard-4`, on pd-standard (anycloud's medium tier) unless the
arm changes it. Disks, run 45246753247:

| Arm             | ok    | pull | MB/s | launch → container | first step | launch → step end | win   | p      |
| --------------- | ----- | ---- | ---- | ------------------ | ---------- | ----------------- | ----- | ------ |
| `ghcr`          | 10/10 | 38.1 | 19.4 | 76.3 (72.5–82.3)   | 0.2        | 76.6 (72.6–82.5)  | 0     | —      |
| `ghcr-c10`      | 10/10 | 37.3 | 20.0 | 75.5 (72.7–79.3)   | 0.2        | 75.7 (72.8–79.5)  | +0.9  | 0.48   |
| `balanced-disk` | 10/10 | 24.2 | 31.1 | 60.3 (53.2–63.8)   | 0.2        | 60.5 (53.4–64.0)  | +16.1 | <0.001 |
| `fast-disk`     | 10/10 | 20.0 | 37.8 | 53.5 (44.5–79.0)   | 0.2        | 53.7 (44.7–79.3)  | +22.9 | <0.001 |

Registries, lazy and baked, run 45251963955:

| Arm            | ok    | pull | MB/s | launch → container | first step | launch → step end | win   | p      |
| -------------- | ----- | ---- | ---- | ------------------ | ---------- | ----------------- | ----- | ------ |
| `ghcr`         | 10/10 | 37.7 | 19.5 | 75.3 (73.8–80.4)   | 0.2        | 75.5 (74.0–80.6)  | 0     | —      |
| `regional`     | 10/10 | 38.0 | 19.5 | 75.2 (70.5–93.8)   | 0.2        | 75.4 (70.6–94.0)  | +0.1  | 0.91   |
| `regional-c10` | 10/10 | 37.8 | 19.6 | 75.3 (71.5–78.2)   | 0.2        | 75.5 (71.6–78.4)  | 0     | 0.74   |
| `lazy`         | 10/10 | 4.0  | 32.5 | 48.2 (45.0–51.0)   | 14.0       | 62.5 (54.5–74.0)  | +13.0 | <0.001 |
| `baked`        | 10/10 | 5.1  | —    | 54.4 (47.6–69.6)   | 5.7        | 60.1 (53.0–74.3)  | +15.4 | <0.001 |

Azure on Standard_LRS, run 45239008856 (`Standard_D4ads_v5` unless noted):

| Arm                                     | ok    | pull | MB/s | launch → container | first step | launch → step end | win   | p      |
| --------------------------------------- | ----- | ---- | ---- | ------------------ | ---------- | ----------------- | ----- | ------ |
| `ghcr`                                  | 10/10 | 12.8 | 60.3 | 44.7 (41.0–58.4)   | 0.2        | 44.8 (41.2–58.6)  | 0     | —      |
| `ghcr-c10`                              | 10/10 | 13.4 | 60.1 | 46.4 (40.3–59.5)   | 0.2        | 46.5 (40.5–59.7)  | −1.7  | 1.0    |
| `fast-disk`                             | 10/10 | 13.5 | 58.5 | 39.0 (37.3–46.1)   | 0.2        | 39.2 (37.5–46.3)  | +5.6  | 0.004  |
| `no-resource-disk` (`Standard_D4as_v5`) | 10/10 | 42.4 | 18.0 | 82.9 (70.5–92.3)   | 0.2        | 83.1 (70.6–92.5)  | −38.3 | <0.001 |
| `baked` (`Standard_D4as_v5`)            | 10/10 | 4.6  | —    | 41.5 (37.3–52.8)   | 7.5        | 48.6 (43.9–67.6)  | −3.8  | 0.25   |

Each pull fetched 730–800 MB; a baked VM's pull fetches only the manifest,
about 50 KB. `summary.json` also has kernel → container and launch →
kernel, with ranges and p-values.

- **GCP's pull is disk-bound.** On pd-standard the pull writes at 20 MB/s,
  and nothing that speeds the download helps: Artifact Registry in the
  region and ten download lanes each win 0–1 s (p ≥ 0.48). pd-balanced
  wins 16.1 s and pd-ssd 22.9 s (both p < 0.001); pd-ssd beats pd-balanced
  by 6.8 s (p = 0.04). The pd-standard runs' `lazy` (+13.0 s) and `baked`
  (+15.4 s) wins there mostly make up for its slow writes.
- **On the shipped pd-ssd, baking still wins 15.3 s on GCP**, to 33.6 s,
  and its first step takes 1.1 s (5.7 s on pd-standard). `lazy` is even
  with `ghcr` (p = 0.58): its container starts 11 s sooner, then its first
  step takes 13.6 s.
- **A fresh GCP image is slow only when many VMs start from it at once.**
  Run 45189626411 started six baked VMs together on a minute-old image:
  about 70 s from the create call to the kernel. Started one a round,
  17 of 20 took 19–28 s, like Ubuntu's image; the first after each bake took
  36–46 s, and one other 37 s.
- **Baking wins 9.1 s on AWS**, to 16.1 s, with a 0.9 s first step. No
  other arm's win there is significant: ten lanes +1.7 s (p = 0.052), the
  faster gp3 +0.5 s (p = 0.35; run 45189626411 had +2.1 s, p = 0.16), ECR
  in the region +0.3 s at 78 against 90 MB/s.
- **On Azure, the resource disk is the lever, and baked doesn't beat it.**
  The baked image needs `Standard_D4as_v5` (no resource disk). On that
  type it wins 30.0 s on Premium_LRS and 34.5 s on Standard_LRS over
  pulling to the OS disk (both p < 0.001). But the product's
  `Standard_D4ads_v5` pulls to its resource disk at 59 MB/s on either OS
  disk, and ends 1.4 s sooner than baked on Premium (p = 0.53) and 3.8 s
  sooner on Standard (p = 0.25). Premium_LRS over Standard_LRS wins 5.6 s
  on that type (p = 0.004).
- **Azure hands out pre-booted VMs.** Every `Standard_D4ads_v5` VM from
  Ubuntu's image, and three of the twenty `Standard_D4as_v5` ones from it, had a kernel
  that started before the create call (`pre-booted` in `summary.json`):
  Azure keeps marketplace-image VMs booted and assigns them. A custom image
  never was. Kernel-relative figures are meaningless on those VMs, so the
  Azure figures here count from the create call. Run 45189626411's Azure
  VMs weren't pre-booted, and its `ghcr` ended at 63.5 s.
- **Lazy pulling moves the time; only a slow disk makes it pay.** The lazy
  pull fetches about 127 MB, and the first step then reads about 80–90 MB
  more. On AWS, `lazy` pulls from ECR, so it compares with `regional`: the
  container starts 2.6 s sooner, but the first step takes 6.3 s, so it ends
  4.0 s later (p = 0.06). Only on GCP's pd-standard does it end sooner
  (13.0 s before `regional`, p < 0.001). A job that reads more of the
  image pays more.
- Run 45189626411's AWS baked VMs that skipped their user data (five of
  ten, all in its first burst) didn't recur: all ten ran it here.

## Ongoing cost

List prices in these regions, for one image version in one region. A
`backmesh-4` VM costs $0.17–0.20 an hour. GCP's disks in us-east4 are
$0.044 (pd-standard), $0.11 (pd-balanced) and $0.187 (pd-ssd) per
GB-month.

| Arm                          | AWS                                                                                              | GCP                                                | Azure                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------- | ---------------------------------------------- |
| `ghcr`, `ghcr-c10`           | None                                                                                             | None                                               | None                                           |
| `regional`                   | ECR: $0.10/GB-month, about $0.08; same-region pulls free                                         | Artifact Registry: $0.10/GB-month past 0.5 GB      | ACR Basic $5/month (10 GB), Standard $20/month |
| `lazy`                       | `regional`, plus an eStargz copy of the image                                                    | The same                                           | The same                                       |
| `baked`                      | EBS snapshot $0.05/GB-month of used blocks (about 5 GB): $0.25, and a build VM per image version | Image storage $0.05/GB-month: about $0.25          | Managed image $0.05/GB-month: about $0.25      |
| `fast-disk`, per VM-hour     | 16,000 IOPS / 1,000 MiB/s over 4,000 / 500: about $0.11                                          | pd-ssd over pd-standard, 100 GB: about $0.020      | Premium P10 over Standard S10: about $0.019    |
| `balanced-disk`, per VM-hour | —                                                                                                | pd-balanced over pd-standard, 100 GB: about $0.009 | —                                              |

Registry and image costs repeat for each region and image version a fleet
keeps; the baked arm also needs a build per version, region and cloud.

## Cost

About $9 across eleven dispatches: about 530 four-vCPU VMs for 3–6 minutes
each at $0.17–0.20 an hour, a VM image per cloud and run for under an hour,
and a few GB in ECR and Artifact Registry. No ACR was made.

## Cleanup

Everything the run makes is named `image-delivery-*` (the ACR,
`imagedelivery*`, sits in an `image-delivery-*` resource group) and tagged or
labelled `anycloud-spike=image-delivery`. `cleanup` needs no state from the
run: it deletes by those names and tags, on all three clouds, the
instances, VM images and snapshots, security groups, GCP firewall rules and
networks, ECR and Artifact Registry repositories, and Azure resource groups,
then lists them again and fails if any is left. If the runner is lost,
dispatch `arguments` `["cleanup"]`. The buildx builder on the runner is
`image-delivery-<run>` and is removed after the build.

## Promotion criteria

None. A lever this run favours gets its own design row and its own A/B.

## Deletion criteria

Delete this directory once the image-delivery decision it informs is made,
with the permissions `ci/gcp-ci-role.json` holds for it (its description
names them).

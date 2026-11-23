# Image delivery

- Status: Run
  [45189626411](https://github.com/anycloud-sh/anycloud/actions/runs/45189626411)
  (`8988d12da`, 2026-11-23): ten VMs per arm per cloud; cleanup left
  nothing. The results are below. GCP's and Azure's `regional` and `lazy`
  arms are still to run.
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
  (default 5), `--arms=a,b` the arms, and `--parallel=N` the VMs per cloud at
  once (default 5).

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

| Cloud | Region    | VM types, in order                       | Root disk (baseline)                                            |
| ----- | --------- | ---------------------------------------- | --------------------------------------------------------------- |
| AWS   | us-east-2 | `m8i.xlarge`, `m7i.xlarge`, `m7a.xlarge` | gp3, 4,000 IOPS, 500 MiB/s                                      |
| GCP   | us-east4  | `n2-standard-4`, `n2d-standard-4`        | pd-standard (the API's default, which the product leaves on n2) |
| Azure | eastus2   | `Standard_D4ads_v5`                      | Standard_LRS; the image stores go on the resource disk          |

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
(Angstrom's) has no `Microsoft.ContainerRegistry` provider, and the owner
deferred them to the move to our own subscription. The run skips an arm
whose registry it can't make and records why.

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

Run 45189626411 (`8988d12da`, 2026-11-23). Medians of ten VMs per arm, in
seconds. "Win" is the arm's launch → first step's end against `ghcr`'s on
the same cloud; positive is faster. Every non-baked VM landed on the first
VM type (AWS `m8i.xlarge`, GCP `n2-standard-4`, Azure `Standard_D4ads_v5`).

| Cloud | Arm            | ok    | pull | MB/s  | kernel → container | first step | launch → kernel | launch → step end | win   |
| ----- | -------------- | ----- | ---- | ----- | ------------------ | ---------- | --------------- | ----------------- | ----- |
| AWS   | `ghcr`         | 10/10 | 8.6  | 88    | 17.8               | 0.1        | 6.2             | 24.0              | 0     |
| AWS   | `regional`     | 10/10 | 9.4  | 77.6  | 19.0               | 0.1        | 6.4             | 26.3              | −2.3  |
| AWS   | `ghcr-c10`     | 10/10 | 8.2  | 92    | 16.6               | 0.1        | 6.1             | 23.3              | +0.7  |
| AWS   | `regional-c10` | 9/10  | 8.4  | 88.4  | 17.0               | 0.1        | 6.3             | 23.7              | +0.3  |
| AWS   | `lazy`         | 9/10  | 1.9  | 83.7  | 12.6               | 6.3        | 6.2             | 24.6              | −0.6  |
| AWS   | `fast-disk`    | 9/10  | 6.4  | 117.5 | 15.5               | 0.1        | 6.3             | 21.9              | +2.1  |
| AWS   | `baked`        | 5/10  | 1.2  | —     | 9.7                | 1.1        | 6.5             | 17.4              | +6.6  |
| GCP   | `ghcr`         | 10/10 | 37.8 | 19.6  | 55.1               | 0.2        | 19.2            | 75.0              | 0     |
| GCP   | `ghcr-c10`     | 10/10 | 37.8 | 19.8  | 54.8               | 0.2        | 20.1            | 75.5              | −0.5  |
| GCP   | `fast-disk`    | 10/10 | 18.6 | 39.8  | 35.8               | 0.2        | 20.2            | 56.7              | +18.3 |
| GCP   | `baked`        | 10/10 | 4.3  | —     | 25.6               | 3.6        | 68.6            | 97.9              | −22.9 |
| Azure | `ghcr`         | 10/10 | 13.5 | 57.9  | 34.5               | 0.2        | 29.0            | 63.5              | 0     |
| Azure | `ghcr-c10`     | 10/10 | 13.2 | 61.5  | 34.1               | 0.2        | 30.4            | 64.7              | −1.2  |
| Azure | `fast-disk`    | 10/10 | 13.0 | 61.3  | 30.1               | 0.2        | 28.0            | 58.5              | +5.0  |
| Azure | `baked`        | 10/10 | 4.5  | —     | 21.9               | 7.0        | 19.8            | 48.0              | +15.5 |

Each pull fetched 730–810 MB; a baked VM's pull fetches only the manifest,
about 50 KB.

- **GCP's pull is disk-bound.** On pd-standard, the product's default disk
  on n2, the pull writes at 20 MB/s. pd-ssd doubles that and wins 18.3 s,
  more than any other arm on any cloud. Ten download lanes change nothing.
- **Baking wins on AWS and Azure, and loses on GCP.** It cuts kernel →
  container by 8.1 s on AWS, 29.5 s on GCP and 12.6 s on Azure. But the
  first read of a baked disk is slow: the first step takes 1.1 s on AWS,
  3.6 s on GCP and 7.0 s on Azure, against 0.1–0.2 s. And on GCP a VM
  from a custom image takes 68.6 s from the create call to its kernel,
  against 19.2 s from Ubuntu's, so the baked arm ends 22.9 s later.
  Azure's baked VMs are `Standard_D4as_v5`, whose stores can't sit on a
  resource disk.
- **AWS has little to win.** Its baseline is 24.0 s from the create call to
  the first step's end. The best non-baked arm, `fast-disk`, wins 2.1 s.
  ECR in the same region is 2.3 s slower than GHCR: 78 against 88 MB/s.
- **Lazy pulling moves the time; it doesn't remove it.** On AWS the
  container starts 5.2 s sooner, but the first step then fetches 80 MB and
  takes 6.3 s, so it ends 0.6 s later. A job that reads more of the image
  pays more.
- Five of AWS's ten baked VMs never ran their user data: no preparation or
  measurement unit, no marks. The image was taken from a stopped VM after
  `cloud-init clean`; why cloud-init skipped half the boots isn't known. The
  AWS `baked` row is the other five.
- Three AWS launches hit EC2's request rate limit and didn't start.

## Ongoing cost

List prices in these regions, for one image version in one region. A
`backmesh-4` VM costs $0.17–0.20 an hour.

| Arm                      | AWS                                                                                              | GCP                                           | Azure                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------ | --------------------------------------------- | ---------------------------------------------- |
| `ghcr`, `ghcr-c10`       | None                                                                                             | None                                          | None                                           |
| `regional`               | ECR: $0.10/GB-month, about $0.08; same-region pulls free                                         | Artifact Registry: $0.10/GB-month past 0.5 GB | ACR Basic $5/month (10 GB), Standard $20/month |
| `lazy`                   | `regional`, plus an eStargz copy of the image                                                    | The same                                      | The same                                       |
| `baked`                  | EBS snapshot $0.05/GB-month of used blocks (about 5 GB): $0.25, and a build VM per image version | Image storage $0.05/GB-month: about $0.25     | Managed image $0.05/GB-month: about $0.25      |
| `fast-disk`, per VM-hour | 16,000 IOPS / 1,000 MiB/s over 4,000 / 500: about $0.11                                          | pd-ssd over pd-standard, 100 GB: about $0.018 | Premium P10 over Standard S10: about $0.019    |

Registry and image costs repeat for each region and image version a fleet
keeps; the baked arm also needs a build per version, region and cloud.

## Cost

About $4 across six dispatches: about 230 four-vCPU VMs for 3–6 minutes
each at $0.17–0.20 an hour, a VM image per cloud for under an hour, and a
few GB in ECR. No ACR or Artifact Registry repository was made.

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

Delete this directory once the image-delivery decision it informs is made.

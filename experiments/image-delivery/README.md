# Image delivery

- Status: built; not yet run.
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

| Arm            | What changes                                                                                                                                                                                       |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ghcr`         | Nothing: the baseline, from GHCR.                                                                                                                                                                  |
| `regional`     | The same digest, copied into ECR private / Artifact Registry / ACR (Standard) in the VM's region. The transfer pull reads a pull-scoped token from a hosts directory.                              |
| `ghcr-c10`     | The transfer service's `max_concurrent_downloads` 10 instead of 3, from GHCR. The image is already zstd, so zstd is the baseline.                                                                  |
| `regional-c10` | Both.                                                                                                                                                                                              |
| `lazy`         | The image converted to eStargz (buildx, no prefetch landmarks) in the regional registry; stargz-snapshotter v0.19.1 installed beside Docker; `ctr-remote rpull`, then `ctr run`.                   |
| `baked`        | A VM image made from a baseline VM after its pull: Docker installed and the image in containerd's store at boot. Azure's builder and baked VMs are `Standard_D4as_v5`, which has no resource disk. |
| `fast-disk`    | AWS gp3 16,000 IOPS and 1,000 MiB/s; GCP pd-ssd (`--disk-tier high`); Azure Premium_LRS.                                                                                                           |

ECR's pull-through cache is not measured: a GHCR rule needs a Secrets
Manager credential, and its warm pulls are the `regional` arm.

Per cloud and arm, `summary.json` gives medians of: the pull (`pull-start` →
`pull-end`, its bytes and MB/s), kernel → container start, the first step,
launch → kernel (the create call to the kernel's start, from the VM's
clock), launch → first step's end, and that last figure's win over `ghcr`.
`trials.json` has every VM's marks; `table.md` the table below.

## Result

Not yet run.

## Cost

About $3 (proposed): about 110 four-vCPU VMs for 3–6 minutes each at
$0.17–0.20 an hour, three VM images and snapshots for under an hour, ACR
Standard for a day ($0.67), and a few GB in ECR and Artifact Registry.

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

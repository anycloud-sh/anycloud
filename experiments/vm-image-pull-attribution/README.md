# VM image-pull attribution

- Status: Complete. Results are below.
- Decision record: VQ-3.
  It asks what bounds a cold pull of the 9.8 GB MACE image on a new VM:
  the network, the disk, the unpack or the registry. The question comes from
  Azure `Standard_NC4as_T4_v3`, which takes a median of 353 s where AWS and
  Lambda take 76 s. It also covers large images on CPU VMs, which have never
  been measured.
- Run: `experiments/vm-image-pull-attribution/run.ts` through the
  [Spike workflow](../../.github/workflows/spike.yml), with `arguments` `[]`
  and `cleanup_arguments` `["cleanup"]`. `["run", "<target>", ...]` runs only
  the named targets. `--aws-region=<region>` (default us-east-1) moves the AWS
  targets; pass it to `cleanup` too. Announce the dispatch first.

## What it measures

The run boots one VM per target, each on the image, root disk and network
the product gives a VM Job there. The GPU targets use e2e-gpu's MACE legs
(`maceFullPull` in `job-profiles.ts`). Every target gets a 100 GB disk.

| Target       | Type                   | Region     | Image                        | Root disk                                |
| ------------ | ---------------------- | ---------- | ---------------------------- | ---------------------------------------- |
| `aws-gpu`    | `g6e.xlarge`           | us-east-2  | Deep Learning Base OSS 24.04 | gp3, high tier: 8,000 IOPS, 1,000 MB/s   |
| `azure-gpu`  | `Standard_NC4as_T4_v3` | westus2    | dstack CUDA (community)      | Premium_LRS, high tier                   |
| `gcp-gpu`    | `g2-standard-4`        | us-east4   | NVIDIA DLVM                  | pd-balanced, medium tier                 |
| `lambda-gpu` | `gpu_1x_a10`           | first free | Lambda Stack 24.04           | Lambda's local disk                      |
| `aws-cpu`    | `t3.medium`            | us-east-1  | Ubuntu 24.04                 | gp3, medium tier                         |
| `azure-cpu`  | `Standard_D2s_v5`      | westus2    | Ubuntu 24.04                 | Standard_LRS, medium tier                |
| `gcp-cpu`    | `e2-standard-2`        | us-east4   | Ubuntu 24.04                 | image default (pd-standard), medium tier |

Azure NICs have no accelerated networking, as in `azure.ts`. A host without
Docker gets the pinned static Docker that `vm-initializer.ts` installs. On a
host whose system containerd is 2.1 or newer and wired into dockerd, the guest
sets up the transfer store as `configureContainerdTransferStore` does. That is
the transfer table with the product's lanes and range size, plus Docker on the
containerd image store. Otherwise it records why the transfer is unavailable.

Each guest then runs these steps in order, timing each one:

1. `disk-write`: 2 GiB of sequential direct writes beside Docker's root.
2. `net-single`: 1 GiB of the image's largest layer (5.7 GB) from GHCR, as
   one stream.
3. `net-ranges`: the same 1 GiB as eight 128 MiB ranges, three at a time,
   which is the transfer's shape.
4. `docker-pull`: `docker pull` of e2e-gpu's pinned MACE digest from a cold
   store and page cache.
5. `transfer-pull`, where available: the product's
   `CONTAINERD_TRANSFER_PULL_COMMAND`, unchanged, from a cold cache again.
6. `unpigz-pull` (R2):
   `docker pull` again from a cold cache, with the product's pinned unpigz
   installed by `installUnpigzCommand`. `docker-pull` is its baseline: the
   guest moves aside any unpigz the image ships before that pull and records
   it in `meta`. `unpigz-ps` lists the unpigz processes 90 s into the pull,
   which shows Docker using it.

A sampler records, every second, the bytes the NICs received, the sectors
written to the disks and the CPU's busy and iowait time. For every step,
`summary.json` gives:

- the wall time and the bytes fetched;
- the time to the last byte, taken as 99.5% of the bytes fetched;
- the unpack tail (the wall time after the last byte) and the fetch rate;
- the bytes written, with the mean and peak 5-second write rates;
- CPU busy and iowait.

A pull that fetched less than 95% of the image's 9.8 GB is marked
`cold: false` and fails the run. A target that fails to launch, upload or
finish a step also fails it.

Two limits apply when reading the table:

- **The registry's cache is warm.** The probes fetch the largest layer first,
  the transfer pull follows `docker pull`, and all seven VMs pull the same
  digest at once. Only the VM's own store and page cache are cold, so the table
  doesn't name the registry as a bound from the order of the pulls alone.
- **The unpack column is only the tail.** Docker unpacks earlier layers while
  later ones download, so the time after the last byte undercounts unpacking.
  CPU and iowait cover the overlap.

The guest reads the image anonymously, so the product's GHCR login path is
not exercised. Evidence goes to signed URLs on a spike-owned GCS bucket, and
no cloud credential reaches a VM.

## Cost

About $3–4 (proposed). Seven VMs run for 30–60 minutes at on-demand list
prices. `g6e.xlarge` is about $1.86 an hour, and the other GPU types are
$0.53–0.75. The registry and the probes add no egress charge.

## Cleanup and ownership

Every guest shuts down when it has uploaded its evidence, and 60 minutes after
boot at the latest. Each pull stops after 25 minutes, so a slow disk still
leaves evidence. A halt ends billing only on AWS, where the instance
terminates, and on GCP, where compute stops. Azure (stopped, not deallocated)
and Lambda keep billing until `cleanup`. The workflow always runs it, but a
lost runner needs a `cleanup` dispatch. `cleanup` deletes every
AWS instance, Azure resource group, GCP instance (in any zone), Lambda
instance and GCS bucket tagged or labelled
`anycloud-spike=vm-image-pull-attribution`. It fails unless the listings come
back empty. Re-dispatch with `arguments` `["cleanup"]` if a run was
interrupted.

## Result

Run 39879172452
(`c3c6a9b80`, 2026-10-23); the table and the recommendations are below.

- **Azure GPU is disk-bound.** Writes hold at 70 MB/s on both paths, and the
  transfer (470 s) is slower than `docker pull` (321 s).
- **Unpack bounds the CPU VMs and GCP GPU.** One core decompresses gzip for a
  168–394 s tail after the last byte.
- **GHCR is not the bound.** Three ranged streams reach 425–517 MB/s.
- **GCP GPU never uses the transfer.** Its image has no Docker, so the host
  installs static Docker with containerd 1.7.
- **AWS GPU is bound by one stream per layer.** In
  run 39981159784
  (`3a54eb6a4`, us-east-2, since us-east-1 had no capacity), `docker pull`
  took 101 s with a 30 s tail. Its DLAMI already has a transfer table, so the
  guest skipped the transfer.
- **Cleanup** confirmed every listing empty.

### R2: unpigz

Paired run `["run", "gcp-cpu", "gcp-gpu"]`, the two targets with the longest
unpack tails: result pending. The pairs share a VM, so the host doesn't vary,
but `unpigz-pull` runs after `docker-pull`, so GHCR is warmer for it.

## Promotion criteria

None as an experiment. A finding that pulls need byte counts or a split
between download and unpack would become a separate `ImagePullTelemetry`
change, filed with its size.

## Deletion criteria

Delete this directory once the results table above and the follow-up
fixes are filed, or if VM Jobs stop pulling with Docker and the containerd
transfer.

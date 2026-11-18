# Runner disk tier: gp3 IOPS and throughput against start time

- Status: Running. Results are below once the run finishes.
- Decision record: owner decision, 2026-11-18 (chat-only; no tracking issue).
  backmesh's AWS runner disks stay at 4,000 IOPS / 500 MiB/s until their cost
  is measured against gp3's free baseline of 3,000 / 125. On a 100 GB disk,
  4,000 / 500 costs about $0.027/h more than the baseline. The only earlier
  measurement compared 4,000 / 500 with 8,000 / 1,000 (about 0.6 s, from the
  image-pull spike).
- Run: `experiments/runner-disk-tier/run.ts` through the
  [Spike workflow](../../.github/workflows/spike.yml), with `arguments`
  `["run"]` and `cleanup_arguments` `["cleanup"]`. `render` prints a VM's
  user data without touching a cloud.

## Method

Each VM is shaped like a `backmesh-4` runner Job on AWS: `m8i.xlarge` (the
class's first type), spot, in us-east-2, Ubuntu 24.04 minimal, and a 100 GB
gp3 root. Its IOPS and MiB/s come from `gp3VolumePerformance`, as
`--disk-iops` and `--disk-throughput` would set them. There are three arms:

| Arm        | IOPS  | MiB/s |
| ---------- | ----- | ----- |
| `baseline` | 3,000 | 125   |
| `today`    | 4,000 | 500   |
| `high`     | 8,000 | 1,000 |

There are 5 rounds, and each round runs every arm in a rotated order. Two
rounds' VMs run at once.

The VM boots on the product's Job host user data (`generateJobHostUserData`).
That installs Docker on the containerd image store and pre-pulls backmesh
v0.4.1's runner image through containerd's transfer service. A
cloud-boothook beside it starts `guest.sh`, which does what the API's SSH steps
would:

1. It waits for cloud-init (`settleFirstBootUpgrade`), the user data's Docker
   and its pull.
2. It starts the runner container with the `docker run` the API builds for
   backmesh's runner Job (`DockerManager.getCommand` with host Docker, host
   networking, its shm size and binds). It runs without a JIT config, so the
   GitHub runner's own registration isn't timed.
3. It pulls `node:22` through the host's Docker and runs `npm ci` for express
   v5.1.0 in it, in `/workspace`. The lockfile is resolved once per run on the
   workflow's runner, so every VM installs the same 389 packages.

Each VM uploads its marks to a signed URL on a run-scoped GCS bucket and then
terminates. The reported times are:

- **Boot to ready**: from the kernel's boot time to the runner's `docker run`
  returning.
- **Launch to ready**: from the `RunInstances` call to the same point.
- **Pull**: the runner image's pull and unpack in the user data.
- **node:22 pull** and **npm ci**.

The API's SSH round trips aren't included. They're the same in every arm.

## Runs

| Run | Arguments | Outcome |
| --- | --------- | ------- |

## Results

Pending.

## Cost

Estimated at about $0.30: 15 spot VMs for about 8 minutes each, at
m8i.xlarge's spot price of about $0.064/h plus the disks. The Spike
workflow's runner adds about an hour. Each gp3 arm costs, over 100 GB at
$0.08/GB-month:

| Arm        | Extra IOPS cost | Extra MiB/s cost | Over baseline, $/h | Per 10-minute job |
| ---------- | --------------- | ---------------- | ------------------ | ----------------- |
| `baseline` | 0               | 0                | 0                  | 0                 |
| `today`    | $5.00/month     | $15.00/month     | 0.0274             | 0.0046            |
| `high`     | $25.00/month    | $35.00/month     | 0.0822             | 0.0137            |

The rates are $0.005 per IOPS-month above 3,000 and $0.04 per MiB/s-month
above 125.

## Cleanup

`cleanup` terminates every us-east-2 instance tagged
`anycloud-spike=runner-disk-tier`, deletes the `ac-spike-disk-*` buckets with
that label, and fails unless no tagged instance, volume or bucket remains.
Re-dispatch with `arguments` `["cleanup"]` if a run was interrupted.

## Promotion criteria

None: the result sets backmesh's runner disk settings, not anycloud's.

## Deletion criteria

Delete this directory once backmesh's runner disk settings follow the result.

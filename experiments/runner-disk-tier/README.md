# Runner disk tier: gp3 IOPS and throughput against start time

- Status: Complete. Every resource is deleted; see Cleanup.
- Decision: after this run (owner, 2026-11-18), backmesh's AWS runner disks
  stay at 4,000 IOPS / 500 MiB/s. Against gp3's free baseline of 3,000 / 125
  they start a runner about 25 s sooner and run this job's disk steps about
  11 s faster, for about $0.027/h more on a 100 GB disk.
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

| Run                                                                             | Source      | Outcome                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [44359549478](https://github.com/anycloud-sh/anycloud/actions/runs/44359549478) | `dc46dfbae` | 15 of 15 VMs finished every step. 7 VMs had 2 spot launches each refused for capacity in us-east-2a and 2b, and all 7 moved to us-east-2c. The arms' zone mix differs slightly: baseline 2a×2 and 2c×3, the others 2a×3 and 2c×2. Cleanup left nothing. |

Each VM's instance ID is in the run's `summary.json`:

- `baseline`: `i-005e879d3ea7da4c0`, `i-0f5755c01599a4732`,
  `i-0584277d5aad88762`, `i-0b2a25fb682dbf222` and `i-0504d0f2f8d0711d3`.
- `today`: `i-080674b0823ab851a`, `i-00a759eb567ee2378`,
  `i-040fb44c8255e373c`, `i-0c8204a1d98c30458` and `i-08d540203e6430edc`.
- `high`: `i-078e9e1e04017b858`, `i-059dd796bebd21fee`,
  `i-040eb6a60c27de3bf`, `i-0554a3c5484eaeef9` and `i-099e474070ebe0e8a`.

## Results

All times are in seconds, as the median with the range in brackets, n = 5
per arm. Every user data pull used the containerd transfer.

| Arm         | Boot to ready        | Launch to ready      | Runner image pull | node:22 pull      | npm ci            |
| ----------- | -------------------- | -------------------- | ----------------- | ----------------- | ----------------- |
| `baseline`  | 57.4 (48.6–59.1)     | 61.8 (53.5–63.0)     | 33.7 (31.2–35.9)  | 9.2 (8.7–9.8)     | 12.2 (10.9–14.1)  |
| **`today`** | **32.5** (28.5–33.7) | **36.7** (31.8–37.8) | **8.0** (7.7–8.1) | **6.3** (6.2–6.7) | **3.9** (3.7–4.0) |
| `high`      | 30.0 (21.6–30.2)     | 34.1 (29.0–35.8)     | 6.0 (5.7–6.5)     | 6.5 (6.3–6.9)     | 3.9 (3.8–4.0)     |

- **The baseline is about 25 s slower to start a runner.** Nearly all of it
  is the runner image's pull: 33.7 s against 8.0 s. The pull writes the
  image's compressed layers (about 690 MiB) and then their unpacked contents,
  so 125 MiB/s bounds it. The ranges don't overlap.
- **A job's own disk work is slower too.** `npm ci` for express takes 12.2 s
  against 3.9 s, and the `node:22` pull 9.2 s against 6.3 s. That adds about
  11 s to this job.
- **8,000 / 1,000 saves about 2.5 s more than 4,000 / 500.** The pull takes
  2 s less. The `node:22` pull and `npm ci` take the same time.
- The boot to Docker (about 24 s) and the `docker run` (0.17 s) are the same
  in every arm.

**Baseline compared with today, per job:**

- About 36 s slower: 25 s to start and 11 s in this job's steps.
- The disk saves $0.0046 per 10-minute job. The extra 36 s of spot VM time
  costs about $0.0007 at $0.064/h.

## Cost

About $0.05: 15 spot VMs for 1–2 minutes each, at m8i.xlarge's spot price of
$0.061–0.067/h plus the disks. The Spike workflow's job ran for about
5 minutes.

Each arm's disk costs this much more than the baseline's, for 100 GB at
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

In run 44359549478, cleanup found one tagged VM still shutting down
(`baseline-r5`) and terminated it. Its listing then came back empty for
instances, volumes and buckets (`cleanup.json`).

## Promotion criteria

None: the result sets backmesh's runner disk settings, not anycloud's.

## Deletion criteria

Delete this directory once backmesh's runner disk settings follow the result.

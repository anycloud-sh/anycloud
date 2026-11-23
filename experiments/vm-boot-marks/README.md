# VM boot marks

- Status: Written, not yet run. The coordinator dispatches it after review.
- Decision record: backmesh/backmesh#97, row C14. A backmesh runner's
  queued→first step is 44 s against GitHub's 4 s; 18–22 s of it is between
  the runner VM's kernel start and its container's start, and nothing split
  that time. This run splits it on every cloud, so the cuts go to the largest
  pieces.
- Run: `experiments/vm-boot-marks/run.ts` through the
  [Spike workflow](../../.github/workflows/spike.yml), with `arguments` `[]`
  and `cleanup_arguments` `["cleanup"]`. `["run", "<target>", ...]` runs only
  the named targets (`aws`, `gcp`, `azure`); `--count=N` sets the Jobs per
  target (default 5).

## What it measures

The run builds the branch, starts its API and uses its CLI. For each target it
starts five VM Jobs at once, shaped like backmesh's `backmesh-4` runners: the
runner image of backmesh v0.5.6 (724 MB of zstd layers, pinned by digest),
`--host-docker`, 100 GB disk, on demand, `--max-retries 0`.

| Target  | VM types, in order                                         | Regions                    |
| ------- | ---------------------------------------------------------- | -------------------------- |
| `aws`   | `m8i.xlarge`, `m7a.xlarge`, `m7i.xlarge`, `m6a.xlarge`     | us-east-2, us-east-1       |
| `gcp`   | `n2-standard-4`, `n2d-standard-4`                          | us-east4, us-central1      |
| `azure` | `Standard_D4ads_v5`, `Standard_D4as_v5`, `Standard_D4s_v5` | eastus2, centralus, eastus |

AWS gets backmesh's gp3 4,000 IOPS and 500 MiB/s. The Job's argument is
`timings`, which the runner's entrypoint answers at once and exits 0 when it
has no job, so each Job boots exactly as a runner does and then completes.

The branch keeps each host's boot marks on the Job's Running event
(`bootMarks`): seconds since the kernel started, from the user data, systemd,
the API's SSH steps and Docker. `summary.json` gives each target's median per
piece, and per mark:

| Piece                        | From → to                             |
| ---------------------------- | ------------------------------------- |
| kernel and initrd            | kernel → `userspace`                  |
| systemd to cloud-init        | `userspace` → `cloud-init-local`      |
| cloud-init local stage       | `cloud-init-local` → `network-online` |
| network online to user data  | `network-online` → `prepare-start`    |
| Docker install and start     | `prepare-start` → `docker-ready`      |
| image pull (user data)       | `pull-start` → `pull-end`             |
| kernel to sshd               | kernel → `sshd`                       |
| sshd to the API reaching SSH | `sshd` → `api-ssh`                    |
| cloud-init status --wait     | `api-ssh` → `cloud-init-done`         |
| API host setup               | `cloud-init-done` → `api-pull`        |
| pull wait to docker run      | `api-pull` → `container-run`          |
| docker run to start          | `container-run` → `container-started` |
| kernel to container start    | kernel → `container-started`          |

The user data's pieces and the API's run side by side; `container-run` waits
for both. `jobs.json` has every Job's marks, the bytes its pull fetched
(`pull-bytes`), its image-pull telemetry and the API's step times. The run
fails unless every target has marks from all its Jobs.

## Cost

About $1 (proposed): fifteen 4-vCPU VMs, each up for 2–5 minutes, at on-demand
prices of $0.17–0.20 an hour.

## Cleanup

The API's database, the inventory and the API log live in
`$RUNNER_TEMP/vm-boot-marks`. `run` waits until every Job has ended, then
terminates them and waits until the API has ended every VM. `cleanup` restarts
the API from the same state and does the same for the inventory's Jobs. If the
runner is lost with its state, the run's Job IDs
(`boot-marks-<target>-<run>-<n>`) are in the run log: delete their VMs by
those names.

## Promotion criteria

None. The unit tests cover the marks; this run reads them on real hosts.

## Deletion criteria

Delete this directory once the cuts it informs are measured.

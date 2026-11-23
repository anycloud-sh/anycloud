# VM boot marks

- Status: Run 45099715079 (`2f01caa2d`, 2026-11-23): all 15 Jobs gave
  marks, and cleanup was confirmed. The results are below.
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

## Result

Run 45099715079 (`2f01caa2d`, 2026-11-23). Each value is the median of five
Jobs, in seconds; the marks are seconds after the kernel started.

| Piece                         | AWS  | GCP  | Azure |
| ----------------------------- | ---- | ---- | ----- |
| kernel to user data           | 5.5  | 7.8  | 8.1   |
| Docker install and start      | 5.1  | 17.3 | 8.5   |
| image pull (user data)        | 8.9  | 19.7 | —     |
| kernel to sshd                | 7.8  | 10.7 | 14.5  |
| sshd to the API reaching SSH  | 1.5  | 14.6 | 2.5   |
| cloud-init status --wait      | 2.5  | 2.7  | 1.2   |
| API host setup                | 1.2  | 2.0  | 2.9   |
| pull wait to docker run       | 5.0  | 15.6 | 16.5  |
| docker run to start           | 0.1  | 0.1  | 2.2   |
| **kernel to container start** | 20.1 | 47.7 | 38.6  |

The pulls fetched 777 MB on AWS and 753 MB on GCP.

- **AWS (20.1 s): the user data is the critical path.** It starts at 5.5 s,
  then installs and starts Docker (5.1 s, of which 4.4 s is the static
  archive's download and unpack) and pulls the image (8.9 s). The API's
  steps end at 16.0 s and then wait for the pull.
- **GCP (47.7 s): something stalls for about 15 s.** Docker's archive lands at
  11.2 s, but `start_docker` doesn't finish until 25.8 s. The API's first SSH
  command runs at 25.4 s, although sshd was up at 10.7 s. On every Job the two
  land within 0.6 s of each other, which points to one blocker for both. After
  it, the pull takes 19.7 s, twice AWS's time for the same bytes.
- **Azure (38.6 s): the pull is on the API's path.** `Standard_D4ads_v5` has a
  resource disk, so the user data skips its pull (initializeVM moves the image
  stores there). The pull then runs over SSH from `api-pull` (20.7 s) and takes
  16.5 s. The boot itself is slow: the network is online at 14.5 s.
- `cloud-init status --wait` and the API's host setup are off the critical
  path on AWS and GCP, where the API waits for the pull anyway. On Azure they
  matter only until the pull moves into the user data.

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

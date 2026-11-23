# VM boot marks

- Status: Run 45099715079 (`2f01caa2d`, 2026-11-23) split the time. Run
  45170484343 (`5b8adaed5`) measured the first cuts against it, and run
  45179926574 (`095d1965a`) added a snapd mask. Run 45186881279 (`2ca4bab54`)
  compared the branch with its baseline, interleaved, ten Jobs per arm on AWS
  and GCP. Every run gave marks from all its Jobs and confirmed cleanup. The
  results are below.
- Decision record: backmesh/backmesh#97, row C14. A backmesh runner's
  queued→first step is 44 s against GitHub's 4 s; 18–22 s of it is between
  the runner VM's kernel start and its container's start, and nothing split
  that time. This run splits it on every cloud, so the cuts go to the largest
  pieces.
- Run: `experiments/vm-boot-marks/run.ts` through the
  [Spike workflow](../../.github/workflows/spike.yml), with `arguments` `[]`
  and `cleanup_arguments` `["cleanup"]`. `["run", "<target>", ...]` runs only
  the named targets (`aws`, `gcp`, `azure`); `--count=N` sets the Jobs per
  target (default 5). `--rounds=R` runs R rounds
  of them. `--baseline` also builds this checkout with `baseline.patch`
  applied, which removes the cut under test: now the serial-console cut
  (`b204608b1`). It runs that API beside the branch's and alternates each
  round's submissions between the two, so both arms meet the same cloud at
  the same time. Regenerate the patch for each cut:
  `git diff HEAD <cut>~1 -- src/api/services/job-host.ts`.
  `["diagnose", "gcp"]` holds three `ubuntu:24.04` Jobs running and saves
  each host's systemd ordering, critical chains, journal, pressure and disk
  counters, PID 1's counters and what writes to the serial console
  (`diagnose-<id>.txt`), then cleans up.

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

### A/B: the pull starts once containerd is up

`5b8adaed5` starts containerd as soon as Docker's archive is in and pulls
while iptables installs and dockerd starts. On Azure it first binds the image
stores onto the resource disk, so the pull runs from the user data there too.
Run 45170484343 against run 45099715079, medians in seconds:

| Piece                         | AWS         | GCP         | Azure       |
| ----------------------------- | ----------- | ----------- | ----------- |
| Docker archive to containerd  | — → 0.4     | — → 9.9     | — → 6.8     |
| image pull (user data)        | 8.9 → 8.3   | 19.7 → 20.2 | — → 13.3    |
| of which the final `sync`     | — → 2.8     | — → 5.3     | — → 3.8     |
| pull wait to docker run       | 5.0 → 5.3   | 15.6 → 6.4  | 16.5 → 7.9  |
| docker run to start           | 0.1 → 0.1   | 0.1 → 0.1   | 2.2 → 0.05  |
| **kernel to container start** | 20.1 → 18.3 | 47.7 → 48.2 | 38.6 → 30.7 |

- **AWS −1.8 s** and **Azure −7.9 s**. The Azure pull no longer waits for the
  API's SSH steps, so `cloud-init status --wait` and rclone's install are off
  the critical path on every cloud. Azure's containerd waits 6.8 s for
  cloud-init to mount the resource disk (17.2 s).
- **GCP: sshd waits for Google's guest agent.** `ssh.socket` listens at about
  10 s, but `ssh.service` becomes active 0.5–2 s after
  `google-guest-agent.service`, which becomes active at 17–26 s. The delay
  comes from that ordering, not from the API's 2 s polling or from firewall
  propagation. On three of five Jobs, containerd's start in the user data
  (`daemon-reload` and `systemctl start`) also stalled until about the same
  time, and those three took 48–49 s. On the other two, containerd was up at
  13–14 s, and they took 33.5 s and 36.6 s.
- The GCP pull itself is slow: 15–19 s to fetch and unpack 758 MB and 5 s to
  sync, against AWS's 5.5 s and 2.8 s.

### GCP's stall, and snapd masked

`diagnose` (runs 45174806678 and 45181016123) held three GCP Jobs running
and read each host's systemd evidence:

- `google-guest-agent.service` declares `Before=sshd.service`, Ubuntu's alias
  for `ssh.service`, so sshd starts only after the guest agent (about 19 s).
  Connections wait in `ssh.socket` until then. This ordering is by design: the
  agent regenerates the host keys.
- From 10 s to 30 s, systemd started about one unit every 0.67 s.
  `snapd.seeded` took 20 s seeding the `google-cloud-cli` snap, and
  `cloud-config.service` waits for it. containerd's start sat in that queue.

`095d1965a` masks snapd from bootcmd, as apt's timers already are. In run
45179926574, every Azure VM's uptime jumped about 54 minutes between
`cloud-init-local` and the network stage, as a pre-provisioned VM's does. So
this table counts from `cloud-init-network` to the container's start, in
seconds (medians of five):

| Run                   | AWS  | GCP  | Azure |
| --------------------- | ---- | ---- | ----- |
| 45099715079 (before)  | 14.9 | 40.0 | 31.5  |
| 45170484343 (pull)    | 12.5 | 40.6 | 23.4  |
| 45179926574 (+ snapd) | 12.6 | 35.4 | 23.1  |

Masking snapd cut GCP by 5 s and changed nothing on AWS or Azure. GCP still
lags: with snapd masked, a second `diagnose` shows every unit slow from 10 s
to 30 s. `setvtrgb` took 3.5 s, containerd 7–11 s and sshd 4–9 s. That points
to the whole host being saturated, by I/O or CPU, rather than to one unit.

### Interleaved A/B, ten Jobs per arm

Run 45186881279 (`2ca4bab54`) ran the branch beside its baseline
(`baseline.patch`: no early pull, Azure's user data skips its pull, and no
snapd mask). It alternated submissions in two rounds of five per arm, on AWS
and GCP. Every Job landed on `m8i.xlarge` or `n2-standard-4` and gave marks.
Cleanup left 0 VMs. Network stage to container start, in seconds:

| Target | Baseline median (range) | Branch median (range) | Mann-Whitney  |
| ------ | ----------------------- | --------------------- | ------------- |
| AWS    | 13.3 (11.8–57.2)        | 12.1 (11.6–19.3)      | U=15, p=0.008 |
| GCP    | 43.4 (27.0–56.1)        | 38.2 (27.2–55.4)      | U=49, p=0.94  |

- **AWS: faster.** The branch arm ran at `2ca4bab54`, with the snapd mask
  still in, but run 45179926574 showed the mask changes nothing on AWS, so
  this gain is the early pull's. It starts about 0.8 s sooner on every Job.
  Slow GHCR pulls made the tails (three baseline Jobs at 29–62 s to
  `pull-end`, one branch Job at 23.5 s), so the median's 1.2 s overstates the
  typical gain a little.
- **GCP: no measured change**, either from the early pull or from masking
  snapd, so `524c38acd` drops the mask. GCP's stall goes to a follow-up.
- Azure's cut stands on runs 45099715079 and 45170484343. Per Job, network
  stage to container start went from 26.5–32.9 s to 21.6–24.4 s.

## Cost

About $1 a run of fifteen 4-vCPU VMs, each up for 2–5 minutes, at on-demand
prices of $0.17–0.20 an hour. The interleaved run's 40 VMs cost about $3.

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

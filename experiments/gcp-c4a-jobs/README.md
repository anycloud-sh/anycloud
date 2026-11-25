# GCP C4A Jobs

- Status: Ready, not yet dispatched.
- Decision record: the live check for the pull request that runs Jobs on GCP
  C4A (Axion, arm64) types. It asks whether the branch's catalog fetcher
  prices C4A from Cloud Billing and marks it arm64, and whether spot and
  on-demand VM Jobs on C4A in europe-west4 boot the arm64 Ubuntu image on
  Hyperdisk Balanced, pull the arm64 build of a multi-arch public image and
  run it.
- Run: `experiments/gcp-c4a-jobs/run.ts` through the
  [Spike workflow](../../.github/workflows/spike.yml), with `arguments`
  `["run"]` and `cleanup_arguments` `["cleanup"]`.

## What it checks

The run builds the GCP catalog with the branch's fetcher and CI's GCP key,
writes it to the API's and CLI's catalog directories, and points
`raw.githubusercontent.com` and `api.github.com` at `0.0.0.0` in
`/etc/hosts` while it runs, so the API's refresh fails and keeps the seeded
catalog (the published one has no C4A rows until the fetcher runs on main).
It then starts the branch's API with CI's GCP key and uses its CLI:

| Submission                  | VM types                          | Expected                                    |
| --------------------------- | --------------------------------- | ------------------------------------------- |
| `alpine:3.20`, spot         | `c4a-highmem-16`                  | completes, prints `aarch64`                 |
| `alpine:3.20`, on-demand    | `c4a-standard-4`                  | completes, prints `aarch64`                 |
| `alpine:3.20`, spot         | `t2a-standard-4` (us-central1)    | completes, prints `aarch64`                 |
| `amd64/alpine:3.20`, spot   | `c4a-standard-4`                  | refused: `has no linux/arm64 build`, no VM  |
| `alpine:3.20`, a mixed list | `c4a-standard-4`, `n2-standard-4` | refused: `mixes arm64 ... and amd64`, no VM |

The C4A Jobs run in europe-west4 and the T2A Job, an Arm series SkyPilot
prices and the Machine Types API marks arm64, in us-central1, with no
checkpoint bucket. The run passes when every Job completes, prints `arch=aarch64` and pins the digest of the image's
`linux/arm64` build (read from the registry), and both refusals happen with no
VM row. `catalog.json` records the catalog's C4A rows in europe-west4 and the
regions it prices C4A in; `summary.json` records each result, the Jobs' VM
rows, log tails and times from submission to completion.

## Cost

One spot `c4a-highmem-16`, one on-demand `c4a-standard-4` and one spot
`t2a-standard-4` for a few minutes each: under $0.10.

## Cleanup

The API's database, the inventory and the API log live in
`$RUNNER_TEMP/gcp-c4a-jobs`. `run` terminates each Job and waits until the API
has ended its VMs. `cleanup` restarts the API from the same state and does the
same. If the runner is lost with its state, the Jobs' IDs (`c4a-spot-<run>`,
`c4a-on-demand-<run>`, `c4a-t2a-spot-<run>`) are in the run log: delete their instances by the
`anycloud_deployment` labels that name them.

## Promotion criteria

None. The unit tests cover the catalog's Billing pricing and Arch column, the
image family and the boot disk; this run proves a C4A VM Job works end to end.

## Deletion criteria

Delete this directory once a green run is recorded on the pull request.

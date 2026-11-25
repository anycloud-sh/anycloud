# Graviton Jobs

- Status: Ready, not yet dispatched.
- Decision record: the live check for the pull request that runs Jobs on AWS
  Graviton (arm64) types. It asks whether a spot VM Job on `m8g.xlarge` boots
  the arm64 Ubuntu image, pulls the arm64 build of a multi-arch public image
  and runs it, and whether an amd64-only image or a mixed arm64/amd64 type
  list is refused before any VM starts.
- Run: `experiments/graviton-jobs/run.ts` through the
  [Spike workflow](../../.github/workflows/spike.yml), with `arguments`
  `["run"]` and `cleanup_arguments` `["cleanup"]`.

## What it checks

The run builds the branch, starts its API with CI's AWS key and uses its CLI,
the way a user does. It submits:

| Submission                      | VM types                   | Expected                                    |
| ------------------------------- | -------------------------- | ------------------------------------------- |
| `alpine:3.20`, spot, `uname -m` | `m8g.xlarge`, `m7g.xlarge` | completes, prints `aarch64`                 |
| `amd64/alpine:3.20`, spot       | `m8g.xlarge`               | refused: `has no linux/arm64 build`, no VM  |
| `alpine:3.20`, a mixed list     | `m8g.xlarge`, `m8a.xlarge` | refused: `mixes arm64 ... and amd64`, no VM |

The Job runs in us-east-2, us-east-1 or us-west-2, in that order, with no
checkpoint bucket. The run passes when the Job completes, its log shows
`arch=aarch64`, its container spec pins the digest of the image's
`linux/arm64` build (read from the registry), and both refusals happen with
no VM row. `summary.json` records each result, the Job's VM rows, its log
tail and its time from submission to completion.

## Cost

One `m8g.xlarge` spot VM for a few minutes: under $0.01 at the catalog's
spot prices.

## Cleanup

The API's database, the inventory and the API log live in
`$RUNNER_TEMP/graviton-jobs`. `run` terminates the Job and waits until the
API has ended its VMs. `cleanup` restarts the API from the same state and
does the same. If the runner is lost with its state, the Job's ID
(`graviton-job-<run>`) is in the run log: terminate its instance by the
`anycloud` tags that name it.

## Promotion criteria

None. The unit tests cover the AMI lookup, the image inspection and the
admission checks; this run proves an arm64 VM Job works end to end.

## Deletion criteria

Delete this directory once a green run is recorded on the pull request.

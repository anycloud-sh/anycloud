# Scheduler kick A/B

- Status: complete. Run 45333929623 (`5133162`, 2026-11-23 PST) ran 20
  rounds per shape; its cleanup check failed on 6 volumes EBS was still
  deleting, and run 45337485927 (`check --run=ebb559`, at `2e39f07`) found
  nothing left.
- Decision record: the A/B for the pull request that kicks the provisioning
  scheduler when a Workload is submitted, and makes a detached run's poll
  wait on the VM. Both come from the closed anycloud-sh/anycloud#12, whose
  Azure resource-disk pre-pull shipped in #26. Before the change a submitted
  Job waited for the scheduler's next 5 s tick, and an SSH-delivered pull's
  polls backed off from half a second to 15 s, so a pull that finished
  between polls was seen up to 15 s late.
- Run: `experiments/scheduler-kick-ab/run.ts` through the
  [Spike workflow](../../.github/workflows/spike.yml), with `arguments`
  `["run"]` and `cleanup_arguments` `["cleanup"]`. `--rounds=N` (default 20),
  `--workers=W` per shape (default 4) and `--minutes=M` (default 75, when no
  new round starts) bound the run.

## What it does

The run builds two APIs from the dispatched commit: `fix`, the commit itself,
and `main`, a worktree of it with [`fix.patch`](fix.patch) (the change's
`src/` diff against main) reversed. Both start on the runner with CI's AWS
key, and an on-demand Job per region through each makes sure the Jobs VPC
exists before the trials.

Each round runs both arms once, in random order, for two on-demand Job
shapes in us-east-1, us-east-2 and us-west-2:

| Shape | VM type       | Image                                 | Pull path                                  |
| ----- | ------------- | ------------------------------------- | ------------------------------------------ |
| `cpu` | `m7i.large`   | `alpine:3.20`                         | the Job host's user data, while it boots   |
| `gpu` | `g4dn.xlarge` | `nvidia/cuda:12.4.1-base-ubuntu22.04` | over SSH, through `runDetachedOnVm` polled |

A trial reads the API's own records: submission (`workloads.submitted_at`)
to the first VM launch request (the `vms` row written just before the
provider call), submission to the Running event, and the Downloading event's
pull telemetry (`imagePull.elapsedMs` and method). The Job is terminated as
soon as it runs.

Cleanup terminates every Job of the run through its API, waits for both APIs
to finish cleaning up, and fails if any instance or volume tagged with one of
the run's Jobs is left. The inventory (run ID and Job IDs per arm) is in the
runner's temp directory; re-run `["cleanup"]` from the same job to resume,
or `["check", "--run=<runId>"]` from any job to check AWS by the Jobs' tag.
The check waits up to ten minutes for EBS to finish deleting, and deletes a
volume of the run left `available`.

## Results

[Run 45333929623](https://github.com/anycloud-sh/anycloud/actions/runs/45333929623):
80 trials, n = 20 per arm and shape, all of which ran. Seconds from
submission; median, with p90 in parentheses. Paired is the median of each
round's main − fix, and in how many of the 20 rounds fix was faster.

| Shape | Mark                   | main         | fix          | Paired, fix faster |
| ----- | ---------------------- | ------------ | ------------ | ------------------ |
| cpu   | launch request         | 3.5 (5.8)    | 1.7 (2.1)    | 1.7 s, 16/20       |
| cpu   | running                | 25.3 (35.1)  | 22.4 (28.9)  | 2.6 s, 17/20       |
| cpu   | pull (user data)       | 0.1 (6.1)    | 0.1 (0.6)    | 0.0 s, 9/20        |
| gpu   | launch request         | 3.6 (4.4)    | 0.4 (2.8)    | 1.7 s, 18/20       |
| gpu   | running                | 65.7 (427.5) | 61.5 (417.2) | 5.2 s, 15/20       |
| gpu   | pull (SSH, containerd) | 3.6 (3.8)    | 3.1 (4.0)    | 0.5 s, 17/20       |

- **Launch request**: the kick removes the wait for the scheduler's next
  5 s tick. What remains on the fix's side, 0.4–1.7 s, was not split.
- **Pull**: the cpu shape's image is pulled by the user data, so the poll
  doesn't touch it. The gpu shape's 3.1 s pull was seen at 3.6 s on main,
  the ramp's third poll (0.5 + 1 + 2 s); a pull finishing later in the ramp
  waits up to 15 s on main and half a second with the fix.
- **gpu running** has a slow tail of 260–445 s: 6 of main's 20 trials and
  2 of fix's. Nothing in the change acts on that tail, so the paired median
  is the figure to read, not the p90.

## Promotion criteria

None: the unit tests in `test/unit/services/monitor.spec.ts`,
`test/unit/routes/new.spec.ts` and `test/unit/services/vm-exec.spec.ts`
cover the behaviour.

## Deletion criteria

Delete once the change has merged and these results are in its pull request.

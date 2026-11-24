# Scheduler kick A/B

- Status: written; not yet run.
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
runner's temp directory; re-run `["cleanup"]` from the same job to resume.

## Results

None yet.

## Promotion criteria

None: the unit tests in `test/unit/services/monitor.spec.ts`,
`test/unit/routes/new.spec.ts` and `test/unit/services/vm-exec.spec.ts`
cover the behaviour.

## Deletion criteria

Delete once the change has merged and these results are in its pull request.

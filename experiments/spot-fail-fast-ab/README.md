# Spot fail-fast A/B

- Status: running. Results are below once the run finishes.
- Decision record: the A/B for the fix that sends RunInstances through a
  client that doesn't retry a zone's capacity refusal. The
  [spot launch strategies spike](https://github.com/anycloud-sh/anycloud/pull/34)
  (run 45259208859) found that EC2 refuses a full zone in 0.7 s with HTTP 500,
  and the AWS gateway's client then retries it for 25–55 s before the launch
  tries the next zone.
- Run: `experiments/spot-fail-fast-ab/run.ts` through the
  [Spike workflow](../../.github/workflows/spike.yml), with `arguments`
  `["run"]` and `cleanup_arguments` `["cleanup"]`. `--rounds=N` (default 20),
  `--workers=W` per size (default 2) and `--minutes=M` (default 70, when no
  new round starts) bound the run.

## What it does

The run builds two APIs from the dispatched commit: `fix`, the commit itself,
and `main`, a worktree of it with [`fix.patch`](fix.patch) (the fix's
`src/` diff against main) reversed. Both start on the runner with CI's AWS
key, and an on-demand Job per region through each makes sure the Jobs VPC
exists before the trials.

Each round runs both arms once, in random order, for `xlarge` and `4xlarge`:
the spike's arm (a), a spot Job with
`--vm-type m8a.<size> --vm-type m8i.<size> --regions us-east-2,us-east-1,us-west-2`.
A trial records the time from submitting the Job to the API recording its
VM's zone, the type and zone it landed on, and how many zones refused it (the
gateway's "EC2 refused the launch in this zone" log lines). The Job is
terminated as soon as its VM is recorded.

Cleanup terminates every Job of the run through its API, waits for both APIs
to finish cleaning up, and fails if any instance or volume tagged with one of
the run's Jobs is left. The inventory (run ID and Job IDs per arm) is in the
runner's temp directory; re-run `["cleanup"]` from the same job to resume.

## Results

Pending.

## Promotion criteria

None: the fix's unit test in `test/unit/services/gateways/aws-jobs-network.spec.ts`
covers the behaviour through the SDK's own retry path.

## Deletion criteria

Delete once the fix has merged and these results are in its pull request.

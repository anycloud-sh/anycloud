# Spot fail-fast A/B

- Status: complete. Run 45271638175 (`0a1fcc8`, 2026-11-23 PST) ran 20
  rounds per size, and its cleanup found nothing left.
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

[Run 45271638175](https://github.com/anycloud-sh/anycloud/actions/runs/45271638175):
160 trials, n = 20 per arm and size, all of which landed a VM. Accepted is
the time from submitting the Job to the API recording its VM's zone; median,
with p90 in parentheses. Refused zones counts the gateway's "trying the next"
log lines, which main writes only when a zone still refuses after the SDK's
retries.

| Arm  | Size    | On m8a | Accepted s  | Refused zones per launch, median |
| ---- | ------- | ------ | ----------- | -------------------------------- |
| main | xlarge  | 20/20  | 40.2 (59.7) | 1                                |
| fix  | xlarge  | 20/20  | 9.6 (11.2)  | 1                                |
| main | 4xlarge | 15/20  | 46.6 (301)  | 0                                |
| fix  | 4xlarge | 9/20   | 13.7 (25.5) | 2                                |

- **xlarge**: both arms landed m8a in us-east-1 every time, mostly in 1b
  after 1a refused. The fix saves the ~30 s main spends retrying 1a.
- **4xlarge**: m8a in us-east-2 came and went. Main's retries in us-east-2a
  sometimes outlasted the shortage and got m8a there after 25–200 s (for
  example rounds 10–14), where the fix, refused in 2a and 2b within a second,
  moved on to m8i in 2a in 9–18 s. So the fix trades some m8a landings for
  speed when m8a capacity flickers; main's worst launches took 172–445 s.

## Promotion criteria

None: the fix's unit test in `test/unit/services/gateways/aws-jobs-network.spec.ts`
covers the behaviour through the SDK's own retry path.

## Deletion criteria

Delete once the fix has merged and these results are in its pull request.

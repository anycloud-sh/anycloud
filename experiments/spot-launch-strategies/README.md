# Spot launch strategies

- Status: in progress.
- Decision record: the spot section of anycloud#30 (`experiments/m8a-vs-m8i`).
  EC2 refused m8a spot in at least one zone on 9 of 10 launches, and each
  refused zone added 25–55 s to the launch. m8a builds 1.3–1.4× faster than
  m8i at equal vCPUs. This experiment finds where a refused zone's time goes
  and which launch strategy lands a VM on m8a whenever it has capacity,
  without that cost.
- Run: `experiments/spot-launch-strategies/run.ts` through the
  [Spike workflow](../../.github/workflows/spike.yml), with `arguments`
  `["run"]` and `cleanup_arguments` `["cleanup"]`. `--rounds=N` (default 20),
  `--workers=W` per size (default 2) and `--minutes=M` (default 70, when no
  new round starts) bound the run.

## What it does

Each round runs one trial of every arm, in random order, for `xlarge` and
`4xlarge`, with m8a preferred over m8i in us-east-2, us-east-1 and us-west-2:

| Arm          | Launch                                                                                                                                                    |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `anycloud`   | (a) An anycloud spot Job with `--vm-type m8a.<size> --vm-type m8i.<size> --regions us-east-2,us-east-1,us-west-2`: today's path.                          |
| `sequential` | (b) One-attempt spot RunInstances per zone that offers the type, m8a in every region before m8i, the next zone on a capacity refusal.                     |
| `parallel`   | (c) (b) for m8a in each region and m8i in us-east-2, all at once; the most preferred VM is kept and the others terminated, then the rest in turn if none. |
| `fleet`      | (d) EC2 Fleet `instant`, `capacity-optimized-prioritized`, m8a's overrides at priority 0 and m8i's at 1 across every subnet, one region at a time.        |
| `scores`     | (e) (b) over single zones ordered by `GetSpotPlacementScores`, cached 10 min, best first, ties in preference order.                                       |
| `od-run`     | (b) on-demand.                                                                                                                                            |
| `od-fleet`   | (d) on-demand, `prioritized`.                                                                                                                             |

The direct arms launch Amazon Linux 2023 from a run-owned launch template
into anycloud's Jobs VPC (one warm-up Job per region creates it if missing).
A trial records the time from its request to EC2 accepting the kept VM and
to that VM running, which type and zone it got, every API call with its
latency, HTTP status and error code, and extra VMs with their cost (spot
price, or on-demand list price, for at least EC2's one-minute minimum).

Attribution: after each of the first eight rounds per size, a zone that just
refused the `sequential` arm is retried with the client options the AWS
gateway uses (`maxAttempts: 10`, the SDK's standard retry). Its error's
`$metadata` says how many attempts the SDK made and how long it waited. The
API log gives the time between two refusals of one anycloud launch.

Cleanup terminates the run's Jobs through the API, deletes everything tagged
`spot-launch-spike=<run>` (instances, instant fleets, launch templates),
waits for the instances to end, and fails if any instance, volume, fleet or
template of the run, or any instance or volume of its Jobs, is left. The
inventory (run ID and Job IDs) is in the runner's temp directory; re-run
`["cleanup"]` from the same job to resume.

## Results

Pending.

## Deletion

Delete this directory once the proposal it supports is decided.

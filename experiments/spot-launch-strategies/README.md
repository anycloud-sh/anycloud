# Spot launch strategies

- Status: complete. Run 45259208859 (`c609a8ca7`, 2026-11-23 12:27–13:08
  PST) measured every arm 20 times per size, for about $1.81, and its cleanup
  found nothing left. A one-round smoke run, 45257542148, came before it.
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

[Run 45259208859](https://github.com/anycloud-sh/anycloud/actions/runs/45259208859):
280 trials, n = 20 per arm and size, all of which landed a VM. The cleanup
found no instance, volume, fleet or launch template left.

### Where a refused zone's time goes

**EC2 answers a zone's capacity refusal in 0.7 s. The rest of the 25–55 s is
the AWS SDK retrying it.** Each refusal is
`InsufficientInstanceCapacity` with HTTP 500. The SDK's standard retry
treats HTTP 500 as a transient server error. The gateway's EC2 client
(`maxAttempts: 10`, `src/api/services/gateways/aws.ts`, constructor) sends
the same RunInstances 10 times with exponential backoff before the
subnet loop moves to the next zone.

- One-attempt RunInstances: 544 zone refusals came back in a median of
  714 ms (max 1,314 ms), all HTTP 500. 223 acceptances took a median of
  1,288 ms.
- The gateway's client against a zone that had just refused: the first five
  probes made 10 attempts, waited 12–32 s in SDK backoff and took 19–38 s
  in all. Later probes made one attempt, because the client's shared retry
  quota (500 tokens, 5 per retry) had run out. The gateway makes its client
  per gateway instance, so a launch normally starts with a full quota.
- The anycloud arm's API log: 43 refusals came a median of 30.4 s after
  the previous refusal of the same launch (range 12.7–59.5 s). Only that
  zone's RunInstances runs between the two. Moving to the next
  (type, region) candidate adds about 5 s more, for the requeue.

The fix is to fail fast: send RunInstances once and let the subnet loop
move on. The SDK's ten attempts also send ten RunInstances per refused zone
into the account's request rate limit, which the other launches share.

### Strategies

Accepted is the time from the request to EC2 accepting the kept VM, and
Running is the time to that VM's `running` state. Medians, with p90 in
parentheses. "On m8a" counts VMs that landed on m8a. Cost is the estimated
EC2 cost of every VM the arm launched (spot price, or on-demand list price,
for at least one billed minute). Calls are EC2 calls per trial.

| Arm                            | Size    | On m8a | Accepted s    | Running s     | Calls | Extra VMs (cost) | Failure modes seen               |
| ------------------------------ | ------- | ------ | ------------- | ------------- | ----- | ---------------- | -------------------------------- |
| (a) anycloud today             | xlarge  | 20/20  | 69.4 (91.6)   | 72.6 (94.1)   | —     | 0                | 2 refused zones per launch       |
| (b) sequential, fail fast      | xlarge  | 20/20  | 4.8 (7.9)     | 8.3 (12.3)    | 6     | 0                | 89 ICE, 8 throttled              |
| (c) parallel, keep best        | xlarge  | 20/20  | 2.9 (3.1)     | 7.2 (10.5)    | 10    | 39 ($0.052)      | 136 ICE, 12 throttled            |
| (d) Fleet, cap-opt-prioritized | xlarge  | 4/20   | 1.7 (2.5)     | 5.2 (6.1)     | 1     | 0                | 6 ICE, 4 UnfulfillableCapacity   |
| (e) placement-score order      | xlarge  | 18/20  | 1.3 (2.4)     | 5.0 (6.0)     | 1     | 0                | 2 ICE, 1 throttled               |
| on-demand RunInstances         | xlarge  | 20/20  | 1.0 (1.0)     | 4.4 (4.6)     | 1     | 0                |                                  |
| on-demand Fleet, prioritized   | xlarge  | 20/20  | 1.5 (1.6)     | 5.0 (5.0)     | 1     | 0                |                                  |
| (a) anycloud today             | 4xlarge | 2/20   | 138.6 (283.8) | 141.1 (285.2) | —     | 0                | up to 565 s                      |
| (b) sequential, fail fast      | 4xlarge | 20/20  | 7.9 (13.1)    | 11.8 (17.7)   | 10    | 0                | 149 ICE, 14 throttled            |
| (c) parallel, keep best        | 4xlarge | 20/20  | 2.2 (3.2)     | 6.0 (8.8)     | 11.5  | 24 ($0.131)      | 168 ICE, 22 throttled            |
| (d) Fleet, cap-opt-prioritized | 4xlarge | 2/20   | 1.7 (4.5)     | 5.2 (8.9)     | 1     | 0                | 14 ICE, 18 UnfulfillableCapacity |
| (e) placement-score order      | 4xlarge | 20/20  | 1.3 (1.5)     | 4.9 (5.3)     | 1     | 0                |                                  |
| on-demand RunInstances         | 4xlarge | 20/20  | 1.0 (2.3)     | 4.4 (5.7)     | 1     | 0                | 2 throttled                      |
| on-demand Fleet, prioritized   | 4xlarge | 20/20  | 1.5 (1.5)     | 4.9 (6.0)     | 1     | 0                |                                  |

ICE is `InsufficientInstanceCapacity`; throttled is `RequestLimitExceeded`,
which the arms retried after 1 s. The arms' calls (not anycloud's) are in
`trials.json`, and `report.md` lists where each arm landed.

- **(a) anycloud today.** At xlarge it resolved m8a in us-east-1 first,
  where 1a and 1b refused and 1c took it every time, so its 69 s is two
  refusals of about 30 s each. At 4xlarge it resolved m8a in us-east-2 and
  got it twice. Otherwise all three zones refused (about 100 s), and it moved
  to m8i in us-east-2, the next candidate in `byRegionRank`'s region-first
  order, and landed m8i there.
- **(b) sequential, fail fast** got m8a on every launch in 4.8 and 7.9 s.
  It walked a median of 5–9 refused zones across regions first: us-east-2 refused m8a
  almost every time, and the VMs landed in us-east-1c, us-west-2a/b.
- **(c) parallel** is the fastest way to m8a in preference order (2.2–2.9
  s), but launched 63 VMs it then terminated (1.6 per trial) and was
  throttled most often. It would cost about $0.003 per launch at xlarge and
  $0.007 at 4xlarge, and anycloud would have to stop the extra VMs reliably.
- **(d) EC2 Fleet** with `capacity-optimized-prioritized` honoured m8a's
  priority only 6 times in 40: capacity comes first and priority is
  best-effort. It answers in one call per region but doesn't meet "m8a
  whenever it has capacity".
- **(e) placement-score order** got there fastest, in one RunInstances, and
  on m8a 38 times in 40: the cached single-zone scores put us-west-2b/c
  first, and those zones took the VM. Scores were fetched 10 times in
  the run (two types per refresh), so a launch usually costs no extra call.
  It moves the launch out of the preferred region when another region's
  zone scores higher.
- **On-demand** had no refusals. Fleet took 0.5 s longer than RunInstances
  to accept and to run, and landed on m8a every time, as did RunInstances.

All of it is one 40-minute window on a Monday afternoon (PST). Capacity
varies by hour; the mechanism (0.7 s refusals, the SDK's 10 attempts)
doesn't.

## Proposal

No product code in this change. Estimates exclude tests.

1. **Fail fast (the fix; about 20 lines).** In the AWS gateway's subnet loop
   (`newVM`'s `RunInstancesCommand` loop), send RunInstances through a
   one-attempt client and retry only `RequestLimitExceeded` there, with
   jittered backoff. The other EC2 calls keep `maxAttempts: 10`. Expected
   effect, from (b): today's 69 s at xlarge becomes about 5 s. No Job
   record or event changes; each refusal is already logged.
2. **Prefer the type over the region (about 15 lines).** `byRegionRank`
   tries every type's first region before any type's second, so a Job asking for
   m8a then m8i gets m8i in its first region before m8a in its second. If
   repeated `--vm-type` means a preference order, rank by type first, as (b)
   did. This changes what `--vm-type` ordering means, so it needs the
   owner's decision.
3. **Order zones and regions by placement score (about 80 lines plus one
   permission).** The AWS candidate preflight
   (`classifyCandidateRegions`, `providesLiveCapacitySignal`) can call
   `GetSpotPlacementScores` once per (types, regions) set, cache it for
   10 minutes, and order regions and each region's subnets by score.
   Within one region that only reorders the subnet loop. Across regions it
   moves a Job to wherever capacity is. Adds `ec2:GetSpotPlacementScores` to the
   published policy (`src/shared/cloud-policies/aws-anycloud-access.json`).
   After (1), this saves about 0.7 s per refusal avoided; measured, 1.3 s
   against 4.8–7.9 s.
4. **Not recommended: parallel launches.** Extra VMs, rate limiting, and a
   new failure path for leaked instances, to save about 2–5 s over (1)+(3).

### EC2 Fleet as the default launch path

Not recommended, for spot or on-demand. Karpenter and RunsOn both launch
through `CreateFleet` with `Type: instant`, which suits them: they let EC2
choose among many interchangeable types. anycloud's Jobs ask for specific
types.

- **Speed.** On-demand Fleet took 1.5 s to accept against RunInstances'
  1.0 s, and 5.0 s to run against 4.4 s. With fail-fast, spot RunInstances
  costs 0.7 s per refused zone, so Fleet's one call saves little.
- **Preference.** `capacity-optimized-prioritized` landed m8a 6 times in
  40 while m8a had capacity ((b) and (e) got it 40 and 38 times). A strict
  preference needs a fleet per type, which works like (b).
- **Lost behavior.** A Job's spot VM is a `persistent` request that
  stops on interruption and restarts in place. EC2 Fleet supports
  stop-on-interruption only for `maintain` fleets with the `lowest-price`
  strategy ([SpotOptionsRequest](https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_SpotOptionsRequest.html),
  [interruption behavior](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/interruption-behavior.html)),
  so an instant fleet's spot Job VM would be terminated and replaced.
- **Launch templates.** Fleet needs one, and a fleet's overrides can't
  carry user data, which differs per anycloud VM. So each launch would
  create a template (or a version), and delete it afterwards, with orphans
  to clean up. Karpenter can share templates because its node user data is
  shared per node class. This run used one template per region because its
  VMs had no user data; instance tags can go in the fleet request.
- **Errors.** Refusals come back per override in the response's `Errors`
  (`InsufficientInstanceCapacity`, `UnfulfillableCapacity`) and not as
  exceptions. The gateway's diagnosis (`CloudFailureDiagnosis`), the zone-refusal
  handling and the client-token adoption (`findRecoverableInstanceByClientToken`) all work
  on RunInstances exceptions and tokens, and would need a second path. An instant fleet can only be
  deleted with its instances.
- **Permissions.** The published policy would add `ec2:CreateFleet`,
  `ec2:DeleteFleets`, `ec2:DescribeFleets`, `ec2:CreateLaunchTemplate`,
  `ec2:DeleteLaunchTemplate` and `iam:CreateServiceLinkedRole` for
  `ec2fleet.amazonaws.com`. anycloud passes no instance profile, so it
  needs no `iam:PassRole`. Fleet launches still need `ec2:RunInstances`
  and `ec2:CreateTags`.
- **Estimate.** About 250 lines in `aws.ts` (template lifecycle, fleet
  request, error mapping, adoption by fleet), plus policy and docs.

### Other clouds

Not measured here. Whether GCP's and Azure's gateways spend the same SDK
retries on a zone refusal is worth one probe each before porting (1).

- **GCP.** `regionInstances.bulkInsert` with a `locationPolicy` (the
  allowed zones) and an `instanceFlexibilityPolicy` (ranked machine types)
  is the equivalent of (d) with ranks, in one call. About 120 lines in
  `gcp.ts`.
- **Azure.** The Spot Placement Score API is the equivalent of (e), about 80
  lines in `azure.ts`. A Flexible VM scale set with an instance mix is
  the Fleet equivalent and changes how anycloud models a VM, so it isn't
  proposed.

## Deletion

Delete this directory once the proposal it supports is decided.

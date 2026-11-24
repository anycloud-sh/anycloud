# m8g against m8a and m8i

- Status: Complete. Results are below.
- Decision record: it asks whether AWS Graviton `m8g` (arm64) builds faster
  or cheaper than `m8a` (AMD) and `m8i` (Intel) at the same vCPU count. It
  also asks whether `m8g` has the spot capacity that
  [m8a-vs-m8i](../m8a-vs-m8i/README.md) found `m8a` lacks, and repeats that
  spot probe at other times of day.
- Run: `experiments/m8g-vs-m8a-vs-m8i/run.ts` through the
  [Spike workflow](../../.github/workflows/spike.yml), with
  `cleanup_arguments` `["cleanup"]`. `arguments` `["run"]` runs the builds:
  `--rounds=<n>` (default 10) and `--parallel=<n>` (rounds at a time,
  default 2). `["spot"]` runs the spot probe. `report <results.json...>`
  rewrites the build report without a cloud.

anycloud's AWS gateway resolves only amd64 images (`aws.ts`, the Ubuntu AMI
lookup's `architecture` filter), so a VM Job can't run on `m8g`. This
experiment therefore launches every arm itself through the EC2 API, so all
six arms share one harness. That harness is not anycloud's: it uses
Ubuntu's `docker.io` rather than anycloud's pinned Docker, and boot times
aren't comparable with VM Jobs'.

## Builds

Each round launches six on-demand VMs at once, in random order: `m8g`,
`m8a` and `m8i`, each at `xlarge` (4 vCPUs) and `4xlarge` (16). They run in
us-east-2, in the first zone of anycloud's `anycloud-jobs` network that
accepts the launch. Each VM gets Canonical's newest Ubuntu 24.04 image for
its architecture and a 100 GB gp3 root. Its user data installs Docker and
runs [m8a-vs-m8i's `guest.sh`](../m8a-vs-m8i/guest.sh) in `docker:27-cli`
with the host's socket. That script runs `lscpu`, `sysbench cpu` and
backmesh's five builds, each in its toolchain's official multi-arch image,
so arm64 VMs build natively. A build that fails prints `BENCH_FAIL` and the
next one still runs; the report lists the failures by arm.

The VM uploads its log, with its uptime, to a signed URL on a run-owned
GCS bucket, then halts, which terminates it. No cloud credential reaches a
VM. A VM halts 35 minutes after boot regardless.

`report.md` compares `m8g` with `m8i` and with `m8a` at each size: medians,
ranges, the ratio of the medians and a two-sided Mann-Whitney p for each
build command and for sysbench. Cost per VM is the median uptime (boot to
upload) times the catalog's us-east-2 on-demand price. It is also given at
the median of the region's zones' spot prices.

## Spot capacity

`spot` measures capacity only, not launch strategy. It records EC2's
`GetSpotPlacementScores` for one instance of each of the six types, by
region and by zone, in us-east-1, us-east-2 and us-west-2. Then it tries one
spot launch of each type in every zone of anycloud's Job network in those
regions, one at a time, 2 s apart. An attempt EC2 rate-limits
(`RequestLimitExceeded`, a limit the account shares with CI) is retried up
to three times rather than counted as a refusal. It terminates each launch as soon as EC2
accepts it. `spot.md` gives, per type and region, the zones that launched,
the refusal codes and the scores.

## Cost

At most $10 for the builds and the spot samples together. The catalog's
us-east-2 on-demand prices per hour are `m8g.xlarge` $0.180, `m8a.xlarge`
$0.243 and `m8i.xlarge` $0.212. At 4xlarge they are `m8g` $0.718, `m8a`
$0.974 and `m8i` $0.847. Ten rounds at about 6 minutes a VM come to about
$2.50. The run stops starting rounds at $8. Each spot sample launches up to
about 90 instances for under a minute each, for well under $1.

## Cleanup and ownership

Instances and their volumes are tagged `anycloud-spike=m8g-vs-m8a-vs-m8i`,
and buckets are named `m8g-builds-<run>`. `run` and `spot` end with the
cleanup, which `cleanup` repeats. It terminates every tagged instance in the
three regions and waits up to 10 minutes for their volumes to go. It deletes
every `m8g-builds-` bucket, then fails unless the listings come back empty.
Nothing is kept on the runner, so `cleanup` works after a lost runner too.
anycloud's shared Job network is not the run's, and stays.

## Result

### Builds

[Run 45257034278](https://github.com/anycloud-sh/anycloud/actions/runs/45257034278)
(`8431c0d97`, 2026-11-23, us-east-2) ran ten rounds of six VMs. 59 of 60
reported; one `m8i.xlarge` never uploaded its log, for reasons the run
didn't capture. Cleanup found nothing left. Every arm built all five
projects: no build failed on arm64.

**m8g is about as fast as m8i at the same vCPU count and about 30% slower
than m8a. It costs the least per build on demand because its price is the
lowest.** The table gives each arm's median for the eight timed commands
together, in seconds, then that time's on-demand cost.

| Size    | m8g             | m8i             | m8a             | m8g/m8i | m8g/m8a |
| ------- | --------------- | --------------- | --------------- | ------- | ------- |
| xlarge  | 145.9 ($0.0073) | 155.5 ($0.0091) | 109.1 ($0.0074) | 0.94    | 1.34    |
| 4xlarge | 99.8 ($0.0199)  | 96.6 ($0.0227)  | 75.9 ($0.0205)  | 1.03    | 1.31    |

- **Against m8i, by command.** m8g is faster on `docker build` (0.87 at
  xlarge, 0.91 at 4xlarge) and on Go (0.84–0.89; `go build` ties at
  4xlarge, p = 0.38). It is slower on rust (1.14 and 1.43), TypeScript
  (1.08–1.24) and Python (1.07–1.13). Every difference but that `go build`
  has p < 0.01.
- **Against m8a.** m8a is faster on every command, by 1.11–2.03×. All have
  p = 0.00018, the normal approximation's floor at n = 10 with no overlap.
- **sysbench cpu.** On one thread, m8g does 3,331 events/s, the same as m8i
  (3,325); m8a does 5,553. On every vCPU, m8g is 1.90× m8i, because a
  Graviton vCPU is a whole core. m8a is 1.66× m8g there.
- **CPUs.** m8g is Neoverse-V2 (Graviton4), one thread per core.
- **This harness's figures differ from anycloud's.** m8a's `docker build`
  takes 54.7 s here and 46.7 s in [m8a-vs-m8i](../m8a-vs-m8i/README.md)'s VM
  Jobs. Ubuntu's `docker.io` stands in for anycloud's Docker, so compare arms
  within one experiment only.

`report.md` in the evidence has every command's medians, ranges, ratios and
p values.

### Cost per VM

[Run 45272188687](https://github.com/anycloud-sh/anycloud/actions/runs/45272188687)
repeated three rounds with marks for where each VM's time goes. 18 of 18
reported and cleanup found nothing left. Whole-VM time is mostly this
harness's own setup. Installing `docker.io` took a median 21 s on arm64,
but 45–113 s on amd64, where Ubuntu's EC2 archive mirror was slower. So
whole-VM cost here overstates m8g's lead. The build phase leaves that setup
out: it runs from sysbench's end to the builds' end, and covers the clones,
fetches and builds that a CI job does. Costs are medians at the catalog's
us-east-2 list prices.

| Arm           | Uptime | Uptime cost | Build phase | On demand | Spot ($/h)       |
| ------------- | ------ | ----------- | ----------- | --------- | ---------------- |
| `m8g.xlarge`  | 293 s  | $0.0146     | 173 s       | $0.0086   | $0.0029 (0.0606) |
| `m8a.xlarge`  | 325 s  | $0.0220     | 142 s       | $0.0096   | $0.0026 (0.0651) |
| `m8i.xlarge`  | 364 s  | $0.0214     | 179 s       | $0.0105   | $0.0034 (0.068)  |
| `m8g.4xlarge` | 258 s  | $0.0515     | 136 s       | $0.0272   | $0.0099 (0.2619) |
| `m8a.4xlarge` | 307 s  | $0.0831     | 109 s       | $0.0293   | $0.0110 (0.3653) |
| `m8i.4xlarge` | 271 s  | $0.0638     | 135 s       | $0.0317   | $0.0100 (0.2662) |

On demand, m8g's build phase costs 0.82 of m8i's at xlarge and 0.86 at
4xlarge. Against m8a it is 0.90 and 0.93. At spot list prices the three
are within about 30% of each other, and m8a is cheapest at xlarge. Running
m8g in anycloud would first need arm64 VM Jobs.

### Spot capacity

Each sample tries one spot launch of every type in every zone of anycloud's
Job network, one at a time. There were three samples, with retries on rate
limiting:

- [45302114722](https://github.com/anycloud-sh/anycloud/actions/runs/45302114722)
  at 17:04 PST on 2026-11-23;
- [45337619456](https://github.com/anycloud-sh/anycloud/actions/runs/45337619456)
  at 22:04 PST;
- [45409656275](https://github.com/anycloud-sh/anycloud/actions/runs/45409656275)
  at 06:02 PST on 2026-11-24.

None was throttled, and every cleanup found nothing left. The table gives
the zones that took a spot launch, over the three samples, with each
sample's count in parentheses in that order. us-east-1e offers none of the
six types (`Unsupported`) and is left out. Every other refusal was
`InsufficientInstanceCapacity`.

| Type          | us-east-1          | us-east-2        | us-west-2          | All            |
| ------------- | ------------------ | ---------------- | ------------------ | -------------- |
| `m8g.xlarge`  | 4 of 15 (0, 4, 0)  | 2 of 9 (0, 2, 0) | 9 of 12 (3, 2, 4)  | 15 of 36 (42%) |
| `m8a.xlarge`  | 6 of 15 (2, 2, 2)  | 3 of 9 (1, 2, 0) | 7 of 12 (3, 2, 2)  | 16 of 36 (44%) |
| `m8i.xlarge`  | 12 of 15 (4, 4, 4) | 5 of 9 (2, 2, 1) | 12 of 12 (4, 4, 4) | 29 of 36 (81%) |
| `m8g.4xlarge` | 12 of 15 (4, 5, 3) | 3 of 9 (2, 1, 0) | 12 of 12 (4, 4, 4) | 27 of 36 (75%) |
| `m8a.4xlarge` | 6 of 15 (2, 2, 2)  | 2 of 9 (1, 1, 0) | 11 of 12 (4, 4, 3) | 19 of 36 (53%) |
| `m8i.4xlarge` | 11 of 15 (3, 5, 3) | 5 of 9 (1, 2, 2) | 10 of 12 (2, 4, 4) | 26 of 36 (72%) |

- **m8i has the most spot capacity at both sizes.** In us-east-2,
  backmesh's region, it is the only family that got 5 of 9 zones. m8a and
  m8g got 2 or 3 of 9, and none at all at 06:00.
- **m8a's spot is thin at all three times.** It got 44% of zones at
  xlarge and 53% at 4xlarge, steady across the samples. This agrees with
  [m8a-vs-m8i](../m8a-vs-m8i/README.md)'s two samples, so time of day
  doesn't explain it.
- **m8g's spot depends on size.** At 4xlarge it is close to m8i (75%),
  except in us-east-2. At xlarge it varies most by time: us-east-1 took 0, 4
  and 0 of 5 zones.
- **us-west-2 has the most spot capacity** for every type.
- **Placement scores agree but are coarse.** By region, m8i scored 3 in
  every region in every sample. m8a and m8g scored 1 in us-east-2 in two of
  the three samples, and 3 elsewhere. `m8g.xlarge` is the exception: it
  scored 3, 3 and 2 in us-east-1, 3, 3 and 1 in us-east-2, and 1, 3 and 3
  in us-west-2. Its 1 in us-west-2 came at 17:00, when 3 of 4 zones there
  took it. `spot-scores.json` in each run has the zone scores.

The earlier sample,
[45271021250](https://github.com/anycloud-sh/anycloud/actions/runs/45271021250)
(13:37 PST), ran before the retry on rate limiting. Six of its us-east-2
attempts were throttled, so it is left out of the table. Its us-east-1 and
us-west-2 counts are in line with it.

## Promotion criteria

None as an experiment. A clear `m8g` gain with spot capacity would justify
arm64 VM Jobs in anycloud and arm64 runner classes in backmesh. Both are
separate changes, filed with these figures.

## Deletion criteria

Delete this directory once the result is recorded and backmesh has decided
on its VM families.

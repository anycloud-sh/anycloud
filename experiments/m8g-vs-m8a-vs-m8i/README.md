# m8g against m8a and m8i

- Status: Ready, not yet dispatched.
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
regions, one at a time, 2 s apart. It terminates each launch as soon as EC2
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

Pending.

## Promotion criteria

None as an experiment. A clear `m8g` gain with spot capacity would justify
arm64 VM Jobs in anycloud and arm64 runner classes in backmesh. Both are
separate changes, filed with these figures.

## Deletion criteria

Delete this directory once the result is recorded and backmesh has decided
on its VM families.

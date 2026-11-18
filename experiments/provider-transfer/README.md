# Provider transfer matrix

- Status: Built and reviewed, not yet dispatched. It waits for the Nebius,
  Hyperstack and Verda secrets: the owner chose one paid run with every column
  once those accounts exist (2026-10-19).
- Decision record: PROV-XFER. It measures how long input staging and
  checkpoint upload and restore take between our storage and each candidate
  cloud, and what they cost. The matrix comes from this experiment's
  research.
- Run: `experiments/provider-transfer/run.ts` through the
  [Spike workflow](../../.github/workflows/spike.yml), with `arguments` `[]`
  and `cleanup_arguments` `["cleanup"]`.
  - `["preflight"]` creates nothing. It checks every credential, Lambda
    capacity, the Nebius subnet, the Hyperstack flavor and image, Verda
    availability, and every cleanup listing.
  - `["run", "--compute", "aws,gcp", "--storage", "azure"]` limits the matrix.
    `--size <compute>=<type>` replaces a worker's type, for example
    `nebius=gpu-l40s-a/1gpu-8vcpu-32gb` if the CPU quota isn't granted.
  - A plain `run` selects every target. It refuses before creating anything
    until `NEBIUS_SERVICE_ACCOUNT_ID`, `NEBIUS_PUBLIC_KEY_ID`,
    `NEBIUS_PRIVATE_KEY`, `NEBIUS_PROJECT_ID`, `HYPERSTACK_API_KEY`,
    `VERDA_CLIENT_ID` and `VERDA_CLIENT_SECRET` reach the workflow. Without
    them, run only with `--compute aws,gcp,azure,lambda`.
  - Nothing here dispatches a workflow. Announce the dispatch first.

## What it measures

The storages are Azure Blob, R2, AWS S3 and GCS in US East, each a
spike-owned bucket with grants from the product's own minters. Azure's are
signed as `mintPoolJobGrants` signs them. The compute targets are one worker
per cloud, each with at least 4 vCPUs and 16 GiB; `COMPUTES` in `clouds.ts`
lists each default type and the reason for it. `clouds.ts` holds each
provider's credentials, prices, launch and owned resources; `run.ts` holds the
measurement.

The data is fixed:

- **Input:** one 2 GiB file and 1,024 shards of 2 MiB (4 GiB, 1,025 files),
  written once on the runner and copied to every storage.
- **Checkpoint:** one 1 GiB file and 1,024 shards of 1 MiB (2 GiB, 1,025
  files), written by each guest.

Each guest takes the selected storages in turn. It times three TCP connects,
then runs the transfers the removed pool runner made, with rclone 1.68.2, its
flags, and the product's rclone config and env:

1. stage: `rclone sync` of the input;
2. checkpoint upload: `rclone copy` to `checkpoint/<compute>/`;
3. checkpoint restore: `rclone copy` back.

The data sits in a tmpfs, so the network and the storage service are what get
measured: pool Nodes stage onto local NVMe. A small worker's NIC can cap
throughput below a GPU node's. The runner publishes each guest's grants behind
a signed GCS URL once the inputs are seeded, and re-mints them every 20
minutes because GCS tokens last an hour. No cloud credential reaches a VM.

`summary.json` and `summary.md` give each pair's throughput, checks, and
list-price cost (`STORAGES` and `COMPUTES`). W1 (RFC 0043's 527 GB input) gets
staging hours and egress cost. Downloads pay the storage's egress and uploads
pay the compute cloud's; Nebius and Verda compute egress are unconfirmed and
counted as 0. The decision record adds each provider's GPU price.

## Cost

The estimate for every column (proposed, 2026-10-19) is **about $14–18**:

- Storage egress: 18 cross-cloud pairs × 6 GiB is about $11.
- Compute egress for checkpoint uploads from AWS, GCP and Azure: about $2.
- Workers for about an hour: about $3. Lambda's GPU type is the largest share.
- Requests: under $0.50.

## Cleanup and ownership

`cleanup` deletes everything a run made, on every provider with a credential,
and fails unless the listings come back empty. It retries in rounds for up to
17 minutes because some resources (a Hyperstack environment, a Verda volume)
go only once what holds them is gone. Re-dispatch with `arguments`
`["cleanup"]` if a run was interrupted.

| Provider   | Resources                                                  | Ownership marker                                                        |
| ---------- | ---------------------------------------------------------- | ----------------------------------------------------------------------- |
| AWS        | instance, bucket                                           | tag `anycloud-spike=provider-transfer`                                  |
| Azure      | resource group holding the storage account, VM and network | the same tag                                                            |
| GCP        | instance, bucket under test, evidence bucket               | label `anycloud-spike=provider-transfer`                                |
| R2         | bucket                                                     | the name prefix `ac-spike-xfer-` (R2 buckets take no tags)              |
| Lambda     | instance                                                   | the tag; the product's existing `anycloud-api` SSH key is reused        |
| Nebius     | instance, its managed disk and public address              | label; leftover labelled disks are swept                                |
| Hyperstack | VM, keypair and the run's own environment                  | VM label `provider-transfer`, in an environment named `ac-spike-xfer-*` |
| Verda      | instance, OS volume, startup script, SSH key               | tag on instance and volume; name prefix for the script and key          |

Every guest shuts itself down after it uploads its evidence, and 65 minutes
after boot at the latest. Its transfers stop 3 minutes before that halt. That ends compute billing on AWS, where the instance
terminates, and on GCP, where it stops. Azure, Nebius (which reboots the VM),
Hyperstack and Verda keep billing a shut-down VM, and Lambda's behavior is
unconfirmed, so `cleanup` is what stops the charges there.

The Nebius, Hyperstack and Verda API calls follow their public API references
and haven't run yet. Run `["preflight"]` once those secrets exist. A run
fails if an owned resource it launched is missing from its cleanup listing,
so a listing that misreads a response can't hide a billing VM. Delete a
missing instance by the ID in `launch.json`; for other kinds, check
`cleanup.json`'s `removed` first.

## Not covered

Spot preemption, GPU execution and pool Jobs (the whole pool journey is
qualified separately), the storage-side free tiers, and each neocloud's own
object storage (those clouds stay compute-only).

## Promotion criteria

None: the result decides region choice and transfer viability.

## Deletion criteria

Delete this directory once its decision is recorded, or if pool Jobs stop
staging with rclone.

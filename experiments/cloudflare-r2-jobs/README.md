# Cloudflare R2 Jobs experiment

- Status: Complete — every check passed (run 37961890696)
- Decision record: whether CF2 works end to end on real R2. That covers the product's R2 storage, the minted credentials a Job's VM receives, and the VM's rclone config, environment and commands. It also answers two open review questions: what a mistyped account ID reports, and what happens when a bucket name is reused across jurisdictions.
- Run: `npx tsx experiments/cloudflare-r2-jobs/run.ts run` through the [Spike workflow](../../.github/workflows/spike.yml), with `arguments` `["run"]` and `cleanup_arguments` `["cleanup"]`

`run` builds storage the way the API does (`createStorageProvider` with a Cloudflare credential, using the workflow's `CLOUDFLARE_API_TOKEN` on the account that serves anycloud.sh). It then:

- creates, checks, writes, reads, lists and deletes through the product's `CloudStorage`, and checks that a missing object reports `ObjectNotFoundError`;
- creates a bucket in the EU jurisdiction, and records what the default endpoint and a reused name do;
- mints read-only and read-write credentials with the product's minter. It copies the same fields `bucketConfigForRole` copies, and runs the VM's rclone commands with the product's `RCLONE_CONF_TEMPLATE` and `rcloneEnvVars` on the runner, using rclone at the product's pinned version. That covers input hydration, output sync, checkpoint sync under a Job prefix and its restore (what a replacement VM runs after a preemption), the two refusals, and EU sync;
- records what minting and `hasBucket` report for a mistyped account ID, and reuses the EU bucket's name in the default jurisdiction only after the EU checks.

No VM is started. Not covered: the SSH, systemd and preemption machinery that runs these commands on a VM. That machinery is provider-neutral and the AWS e2e members cover it; this run covers everything R2-specific.

Every bucket is named `anycloud-r2-jobs-<run>-*`. `run` deletes them at the end through the product's `deleteBucket`. `cleanup` deletes every bucket with the `anycloud-r2-jobs-` prefix in both jurisdictions, refuses any other name, and fails if one remains. Reports hold no token or key material.

## Result

Run 37961890696 at `2b1d04b6f`: all 18 checks passed, and both the run's own cleanup and the cleanup step found no `anycloud-r2-jobs-*` bucket left in either jurisdiction.

- **Product storage:** bucket create (idempotent), exists, object write, read, list and delete, and a missing object reporting `ObjectNotFoundError`, all through `createStorageProvider`.
- **EU jurisdiction:** `upsertBucket` with an EU credential creates the bucket in the EU jurisdiction, and the default endpoint doesn't see it.
- **Minted credentials:** S3 session credentials (`AWS_*` with a session token) with the bucket's endpoint, expiring in 36 h.
- **The VM's rclone 1.68.2 commands, with the product's config and env:**
  - input hydration with read-only credentials
  - output sync with read-write credentials
  - checkpoint sync under `job-1` and its restore
  - EU sync through the EU endpoint
  - refusals: a read-only upload, and output credentials on the input bucket, are both `AccessDenied` 403
- **Name reuse:** reusing the EU bucket's name in the default jurisdiction creates a separate bucket. R2 namespaces names per jurisdiction, so the 409 recheck never fires for this case.
- **Missing bucket:** minting for a missing bucket on the right account succeeds, so a refused mint never means a missing bucket.
- **Wrong account ID:**
  - minting fails with 403, reported as "Cloudflare refused R2 temporary credentials for account …";
  - S3 calls fail in the TLS handshake (`EPROTO`, since R2 serves no certificate for an unknown account). The gateway now reports that as a failed TLS handshake with R2 for the account, which usually means a wrong account ID, and keeps the original error as `cause`.

## Promotion criteria

None: the behavior it checks is CF2's product code and its unit tests.

## Deletion criteria

Delete this directory once a run is green and recorded, or when a standing e2e member covers R2 Job storage.

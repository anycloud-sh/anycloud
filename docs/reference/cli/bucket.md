---
title: bucket
description: Exact syntax for listing and managing cloud buckets and their objects.
---

# `anycloud bucket`

Manage provider object storage through a saved cloud credential.

```bash
anycloud bucket list [<bucket> [<prefix>]] --credentials <name> [OPTIONS]
anycloud bucket create <bucket> --credentials <name> [--region REGION]
anycloud bucket delete <bucket> --credentials <name> [--region REGION]
anycloud bucket exists <bucket> --credentials <name> [--region REGION]
anycloud bucket upload <bucket> <local-file> <remote-key> --credentials <name> [--region REGION]
anycloud bucket download <bucket> <remote-key> <local-file> --credentials <name> [--region REGION]
anycloud bucket rm <bucket> <remote-key> --credentials <name> [--region REGION]
anycloud bucket upload <bucket> <local-dir> <remote-prefix> --recursive [--concurrency N] --credentials <name>
anycloud bucket download <bucket> <remote-prefix> <local-dir> --recursive [--concurrency N] --credentials <name>
anycloud bucket rm <bucket> <prefix> --recursive [--concurrency N] [--yes] --credentials <name>
```

| Option               | Description                                                                 |
| -------------------- | --------------------------------------------------------------------------- |
| `--credentials NAME` | Saved credential; optional when exactly one is saved                        |
| `--region REGION`    | Storage region; required for some providers and cross-region use            |
| `-r, --recursive`    | Upload or download a directory, or delete a prefix                          |
| `--concurrency N`    | Parallel transfers or deletes for `upload`, `download` and `rm`; needs `-r` |
| `-y, --yes`          | `rm` only: skip the recursive-deletion prompt; needs `-r`                   |

When exactly one credential is saved, `list` and the other bucket commands can
select it automatically. Pass `--credentials` when more than one exists.

A cluster-hosted API refuses its own backup bucket, which holds the API's cipher
key and database. Every bucket command that names it on the backup's cloud
fails with `BUCKET_ACCESS_DENIED` (HTTP 403). A Job or Service that names it as
`--input-bucket`, `--output-bucket` or `--checkpoint-bucket` is rejected, and
so is `api create --checkpoint-bucket`.

When the cloud provider throttles a call, the API answers `BUCKET_THROTTLED`
(HTTP 503) with the provider's `Retry-After`, from 1 to 30 seconds, or 1 second
when the provider gives none. `list`, `exists`, `create`, `delete` and `rm`
retry for up to 30 seconds, waiting at least `Retry-After` and backing off from
1 to 8 seconds, then report the throttling. The object transfers of `upload`
and `download` report it at once; run them again. A recursive `download` lists
its objects first; that listing retries like `list`.

## List buckets

With no bucket argument, `list` discovers every bucket visible to one saved
AWS, GCP, Azure, or Cloudflare credential:

```bash
anycloud bucket list --credentials production-aws
anycloud bucket list --credentials production-gcp --json
```

AWS returns account-owned S3 buckets, GCP returns buckets in the credential's
project, and Azure returns containers in Anycloud's deterministic storage
account. Cloudflare returns the account's R2 buckets in the credential's
jurisdiction. Discovery is not restricted to resources created or tagged by
Anycloud. Lambda and Local credentials do not support discovery.

| List option       | Description                                                     |
| ----------------- | --------------------------------------------------------------- |
| `--json`          | Emit one compact JSON object on stdout                          |
| `-n, --limit N`   | Return at most `N` results, spanning API pages                  |
| `--all`           | Exhaust every API page; cannot be combined with `--limit`       |
| `--cursor TOKEN`  | Resume from a previous listing's `nextCursor`                   |
| `-r, --recursive` | Return a flat object tree; valid only when a bucket is supplied |

The default limit is 1,000. Results are sorted by bucket name within each
response. If more results exist at the limit, the command writes a truncation
warning to stderr and exits with code `3`, in both table and JSON output. A
complete listing exits `0`; a failed one exits `1`.

`--json` prints `{ "entries": [...], "truncated": false, "nextCursor": null }`.
When the listing stopped at the limit, `truncated` is `true` and `nextCursor`
holds the provider token where the next page starts. Pass it to `--cursor` with
the same bucket, prefix, and `--recursive` arguments to continue; each entry
arrives exactly once across the resumed listings. `--cursor` combines with
`--limit` or `--all`.

Bucket entries have `name`, `region`, and `createdAt`. The last two values can
be `null`; timestamps are epoch milliseconds. `region` is the provider's own
location string, so Google Cloud reports values like `US` or `US-CENTRAL1`
rather than a workload region, and Cloudflare reports the R2 jurisdiction
(`default`, `eu`, or `fedramp`).

R2 has no regions: omit `--region` with a Cloudflare credential, whose
jurisdiction picks the endpoint.

## List files and folders

Supply a bucket to browse its top-level objects and slash-delimited virtual
folders. The optional prefix is passed literally, so include a trailing slash
when browsing a folder:

```bash
anycloud bucket list training-data --credentials production-aws
anycloud bucket list training-data datasets/ --credentials production-aws
anycloud bucket list training-data datasets/ --recursive \
  --credentials production-aws
```

The default hierarchical view contains object entries and prefix entries.
`--recursive` removes the delimiter and returns objects only. Results use the
same `--limit`, `--all`, `--cursor`, and `--json` behavior as bucket discovery.

Each call sorts only its own entries by key. Across `--cursor` continuations,
the order follows the provider's pages, which can differ from that sort, for
example with mixed-case keys. Sort after concatenating the continued listings
when you need one ordered list.

Object listings use the same `entries`, `truncated`, and `nextCursor` fields,
with entries in these shapes:

```json
{
  "entries": [
    { "kind": "prefix", "key": "datasets/" },
    {
      "kind": "object",
      "key": "README.txt",
      "sizeBytes": 120,
      "lastModifiedAt": 1735689600000
    }
  ],
  "truncated": false,
  "nextCursor": null
}
```

`sizeBytes` and `lastModifiedAt` can be `null` when the provider omits them.

## Manage buckets and objects

`create` is idempotent if the credential can access an existing Bucket.
`delete` is also idempotent but removes the Bucket and all objects.

`exists` uses exit codes:

- `0`: exists
- `1`: does not exist
- `2`: check failed

Without `--recursive`, `upload` accepts one local file or `-` for stdin, `download` creates local
parent directories, and `rm` removes one object. `delete` removes the entire
Bucket.

Stream a generated archive or a remote file without keeping another local copy.
The API temporarily spools the input before uploading it to the provider. Use
`pipefail` so a failed input command also fails the pipeline. Stdin cannot be
combined with `--recursive`.

```bash
set -o pipefail
tar -czf - ./data | anycloud bucket upload training-data - data.tar.gz \
  --credentials production-aws --region us-east-1
```

Downloads are written to a sibling temporary file, checked against the object
size reported by the API, and atomically moved into place only when complete.
An incomplete response is fetched again up to two times; if all three attempts
are incomplete, the command exits nonzero and preserves any existing local
file. An existing destination keeps its permissions.

```bash
anycloud bucket create training-data \
  --credentials production-aws \
  --region us-east-1

anycloud bucket upload training-data \
  ./data.bin datasets/data.bin \
  --credentials production-aws \
  --region us-east-1

anycloud bucket download training-data \
  datasets/data.bin ./downloads/data.bin \
  --credentials production-aws \
  --region us-east-1
```

## Transfer directories and remove prefixes

Add `--recursive` to upload or download a complete directory. Directory
contents map beneath the supplied literal prefix; a non-empty prefix must end
in `/`. Pass a quoted empty argument (`''`) to target the bucket root:

```bash
anycloud bucket upload training-data ./datasets datasets/ --recursive \
  --credentials production-aws
anycloud bucket upload training-data ./root-copy '' --recursive \
  --concurrency 8 --credentials production-gcp

anycloud bucket download training-data datasets/ ./datasets --recursive \
  --credentials production-aws
anycloud bucket download training-data '' ./bucket-copy --recursive \
  --concurrency 8 --credentials production-gcp
```

Recursive operations use four concurrent object requests by default. Set
`--concurrency` from 1 through 32. Upload preflight rejects symlinks and special
files. Download preflight rejects unsafe or colliding object keys and existing
destination symlinks; existing regular files are replaced after each download
finishes successfully and passes the same size validation as a single-object
download. Empty local directories are not uploaded.

`rm --recursive` deletes every object under a non-empty slash-terminated
prefix. It lists the complete prefix first, shows the object count and known
bytes, and prompts before deletion. Scripts and CI must pass `--yes`:

```bash
anycloud bucket rm training-data old-runs/ --recursive \
  --yes --credentials production-aws
```

Batch operations attempt every discovered object with bounded concurrency. A
partial failure prints the completed/failed summary and failed keys to stderr,
then exits nonzero. Successful work is not rolled back; rerunning is safe
because uploads overwrite, downloads atomically replace regular files, and
object deletion is idempotent. Recursive transfer commands do not add JSON
output, item limits, checksum comparison, or mirroring behavior.

For Job mounts and sync guarantees, see [Buckets](/platform/buckets).

# Cloudflare R2 media check

- Status: Active
- Decision record: hosting the landing-page launch video on R2 behind
  `media.anycloud.sh`
- Run: `npx tsx experiments/cloudflare-r2-media-check/run.ts preflight` through
  the [Spike workflow](../../.github/workflows/spike.yml) with `arguments`
  `["preflight"]`, or `["setup", "<version>", "<base-url>", "<file:sha256>", ...]`,
  and empty `cleanup_arguments`

`preflight` is read-only: it reports what the Cloudflare deploy token
(`CLOUDFLARE_API_TOKEN`, which deploys the website, the `get.anycloud.sh`
installer, and the DNS and Slack Workers) can see before anyone uses it to create the media
bucket, and sends only GET requests:

- whether the token verifies as an account or user token;
- whether it can list R2 buckets, and whether `anycloud-media` already exists
  (and, if so, its custom domains);
- whether it can read the `anycloud.sh` zone and any existing
  `media.anycloud.sh` DNS records.

`setup <version> <base-url> <file:sha256>...` provisions the host once and
uploads one cut per run. It
downloads the five encodes (`1080.av1.webm`, `1080.h264.mp4`, `720.av1.webm`,
`720.h264.mp4`, `poster.jpg`) from a temporary HTTPS URL and refuses any file
whose SHA-256 differs from its argument. Then it:

- creates the `anycloud-media` bucket;
- attaches `media.anycloud.sh` with a TLS 1.2 minimum;
- uploads the files under `launch/<version>/` (one immutable folder per cut, such as `2026-10-v2`) with their content types and
  `Cache-Control: public, max-age=31536000, immutable`;
- waits until `media.anycloud.sh` serves every file.

The bucket and domain steps are skipped when they already exist; uploads always
overwrite, so give each cut a new version. Unlike
other experiments, `setup` creates resources that are meant to stay: they are
the production media host. It therefore runs with empty `cleanup_arguments`.
Remove them by deleting the bucket's custom domain and then the bucket.
`setup.json` records each step and what the domain served.

`preflight.json` in the run's evidence artifact holds the results without token
material. Read access does not prove the write permissions the setup needs
(create a bucket, attach a custom domain, put objects).

## Promotion criteria

None yet: `setup` is how new launch-video cuts are published. Move it to a
reviewed workflow if publishing becomes routine.

## Deletion criteria

Delete this directory when a reviewed workflow replaces `setup` for publishing
launch-video cuts, or when the landing page stops playing a video from R2.

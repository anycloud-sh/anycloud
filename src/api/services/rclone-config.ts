/**
 * Shared rclone configuration primitives.
 *
 * Consumed by `supervisor.ts` for VM-host bucket sync (AWS / Azure / GCP):
 * it writes the rclone.conf via SSH, drops the env vars into per-bucket env
 * files sourced before each rclone command, and starts systemd services
 * that run `rcloneContinuousLoop(rcloneCopyCommand(...))`.
 *
 * Extracted into one module so the rclone semantics (remote naming, env var
 * format, copy-vs-sync, loop cadence) live in a single place and any future
 * consumer can reuse them without drift.
 */

import {
  CloudType,
  type ScopedStorageCredentials,
} from '../../shared/cloud.js';
import { LOCAL_BUCKET_STORE_GUEST_ROOT } from '../../shared/providers.js';

/** Per-bucket configuration for rclone setup. */
export interface BucketConfig {
  name: string;
  cloudType: CloudType;
  region?: string;
  storageAccountName?: string;
  // S3-compatible stores other than AWS (Cloudflare R2): the account's endpoint.
  endpoint?: string;
  credentials?: ScopedStorageCredentials;
  credentialExpiresAt?: number;
}

const DEFAULT_RCLONE_CONTINUOUS_SYNC_INTERVAL_SEC = 60;

/**
 * Static rclone.conf body — same for both paths.
 *
 * Remote names are cloud-typed (s3 / azureblob / gcs). Azure and S3
 * credentials come from env vars via `env_auth = true`; GCS reads only a
 * minted token from the bucket's own config (`rcloneTokenConfig`), never a VM
 * identity. No `account` in [azureblob] —
 * rclone reads `AZURE_STORAGE_ACCOUNT` from env, which lets per-bucket
 * env files (VM-host) or container env (native-container) target
 * different storage accounts without rewriting the conf.
 */
const GCS_REMOTE = `[gcs]
type = google cloud storage
bucket_policy_only = true
no_check_bucket = true
`;

export const RCLONE_CONF_TEMPLATE = `[azureblob]
type = azureblob
env_auth = true
no_check_container = true

[s3]
type = s3
provider = AWS
env_auth = true
no_check_bucket = true

${GCS_REMOTE}
[r2]
type = s3
provider = Cloudflare
env_auth = true
region = auto
no_check_bucket = true
`;

/**
 * Map (bucket cloud, credentials) → rclone env vars.
 *
 * A minted, short-lived, bucket-scoped token for every AWS, R2, Azure and
 * GCP bucket: S3 session credentials (`AWS_*` incl. `AWS_SESSION_TOKEN`; R2's
 * endpoint also rides here), an Azure container SAS, or a downscoped GCP
 * access token. No long-lived key is ever emitted.
 */
export function rcloneEnvVars(config: BucketConfig): Record<string, string> {
  const env: Record<string, string> = {};

  // Azure always needs the storage account name for rclone.
  if (config.cloudType === CloudType.Azure && config.storageAccountName) {
    env.AZURE_STORAGE_ACCOUNT = config.storageAccountName;
    env.RCLONE_CONFIG_AZUREBLOB_ACCOUNT = config.storageAccountName;
  }

  if (config.cloudType === CloudType.AWS && config.region) {
    env.RCLONE_CONFIG_S3_REGION = config.region;
  }

  // One shared [r2] remote serves every account: the endpoint names the
  // account and jurisdiction per bucket.
  if (config.cloudType === CloudType.Cloudflare && config.endpoint) {
    env.RCLONE_CONFIG_R2_ENDPOINT = config.endpoint;
  }

  // Minted through the branded CloudStorage scoped-token capability. rclone
  // tries env_auth before sas_url, so the SAS must switch env_auth off.
  if (config.credentials?.cloudProvider === CloudType.Azure) {
    if (!config.storageAccountName)
      throw new Error(`Azure bucket ${config.name} has no storage account`);
    env.RCLONE_CONFIG_AZUREBLOB_ENV_AUTH = 'false';
    env.RCLONE_CONFIG_AZUREBLOB_SAS_URL = `https://${config.storageAccountName}.blob.core.windows.net/${config.name}?${config.credentials.sasToken}`;
  }
  if (config.credentials?.cloudProvider === CloudType.AWS) {
    env.AWS_ACCESS_KEY_ID = config.credentials.accessKeyId;
    env.AWS_SECRET_ACCESS_KEY = config.credentials.secretAccessKey;
    if (config.credentials.sessionToken) {
      env.AWS_SESSION_TOKEN = config.credentials.sessionToken;
    }
  }

  return env;
}

/** A minted GCP token as rclone's oauth token JSON, which has no refresh token. */
function gcsTokenJson(config: BucketConfig): string | undefined {
  if (config.credentials?.cloudProvider !== CloudType.GCP) return undefined;
  return JSON.stringify({
    access_token: config.credentials.accessToken,
    token_type: 'Bearer',
    // Go's RFC3339 in whole seconds, as rclone writes it back, so its token
    // save leaves the file alone.
    expiry: new Date(config.credentialExpiresAt!)
      .toISOString()
      .replace(/\.\d{3}Z$/, 'Z'),
  });
}

/**
 * The bucket's own rclone config for a minted GCP token, or undefined.
 *
 * rclone 1.68 takes a static GCS token only as an oauth token without a
 * refresh token. At expiry it re-reads `token` through its config map
 * (lib/oauthutil reReadToken), and the config file reloads when it changes
 * (fs/config/configfile), so a running sync picks up a renewed token. The
 * environment would shadow the file, so the token never rides an env var.
 */
export function rcloneTokenConfig(config: BucketConfig): string | undefined {
  const token = gcsTokenJson(config);
  return token && `${GCS_REMOTE}token = ${token}\n`;
}

/**
 * Build the rclone copy command for bucket uploads.
 *
 * CRITICAL: `rclone copy`, not `rclone sync`. `sync` makes destination
 * identical to source, which DELETES files. When multiple jobs write
 * to the same bucket in different folders:
 *   - Job 1 syncs /mnt/output (has job-1/) → s3://bucket → DELETES job-2/
 *   - Job 2 syncs /mnt/output (has job-2/) → s3://bucket → DELETES job-1/
 * `rclone copy` only uploads new/changed files, never deletes — multiple
 * jobs can safely write to different folders in the same bucket.
 */
export function rcloneCopyCommand(
  remotePath: string,
  localPath: string,
  rcloneBin = '/usr/bin/rclone',
  excludes: string[] = [],
): string {
  // Double-quote patterns: they contain globs (*) and this command is embedded
  // inside `bash -c '...'`, where double quotes survive the outer single quotes
  // and suppress shell globbing so rclone receives the pattern verbatim.
  const excludeFlags = excludes.map((p) => ` --exclude "${p}"`).join('');
  return `${rcloneBin} copy ${localPath} ${remotePath} --verbose --fast-list --no-update-modtime --modify-window 1s${excludeFlags}`;
}

/**
 * Wrap a command in an infinite loop with sleep between iterations.
 * Both supervisor's systemd unit and the native-container wrapper's
 * background sync use this verbatim.
 *
 * The sleep is unconditional (`;`, not `&&`): a persistently failing copy
 * must back off for the interval, not respin instantly. Nothing else
 * provides that backoff — the loop process never exits, so the systemd
 * unit's RestartSec never applies.
 */
export function rcloneContinuousLoop(
  cmd: string,
  sleepSec = DEFAULT_RCLONE_CONTINUOUS_SYNC_INTERVAL_SEC,
): string {
  return `while true; do ${cmd}; sleep ${sleepSec}; done`;
}

/**
 * One-shot sync from a remote bucket into a local directory. Used for
 * the input-bucket pre-download — `sync` (not `copy`) so a stale local
 * copy is brought into line with the bucket. Retries cover storage
 * cred propagation delays (GCP metadata).
 */
export function rcloneInputSyncCommand(
  remotePath: string,
  localPath: string,
  rcloneBin = '/usr/bin/rclone',
): string {
  return `${rcloneBin} sync ${remotePath} ${localPath} --create-empty-src-dirs --modify-window 1s --verbose --stats 1m --stats-one-line --retries 30 --retries-sleep 15s`;
}

/**
 * Compute the rclone remote path from bucket name and cloud type.
 * Local cloud (testing) uses a filesystem path; cloud types use the
 * corresponding rclone remote from RCLONE_CONF_TEMPLATE.
 */
export function getRemotePath(
  bucketName: string,
  cloudType: CloudType,
): string {
  switch (cloudType) {
    case CloudType.Azure:
      return `azureblob:${bucketName}`;
    case CloudType.AWS:
      return `s3:${bucketName}`;
    case CloudType.GCP:
      return `gcs:${bucketName}`;
    case CloudType.Local:
      return `${LOCAL_BUCKET_STORE_GUEST_ROOT}/${bucketName}`;
    case CloudType.Lambda:
      // Compute-only providers use host-mounted fixture paths in unit tests;
      // real workloads resolve an explicit AWS/GCP/Azure storage provider.
      return `/${bucketName}-source`;
    case CloudType.Cloudflare:
      return `r2:${bucketName}`;
  }
}

/**
 * The seed (RFC 0049 C26 (e), owner decision 2026-11-07): `api create`
 * drives the user's own cloud CLI to stand up one management VM whose
 * startup script brings up K3s and the API; the API does every other cloud
 * call. Each cloud implements `CloudSeed` (AWS: one CloudFormation stack;
 * Azure: one ARM deployment into the installation's resource group; GCP: a
 * few gcloud calls). The CLI holds no cloud SDK and stores nothing.
 */

import { CloudType } from '../../shared/cloud.js';
import type { SystemReleaseBackupValues } from '../../shared/system-release-values.js';

/** The clouds a management VM runs on. */
export type SeedCloud = 'aws' | 'gcp' | 'azure';

export const SEED_CLOUDS: readonly SeedCloud[] = ['aws', 'gcp', 'azure'];

/** Who the user's cloud CLI acts as, and where. */
export interface SeedAccount {
  /** The AWS account, GCP project or Azure subscription. */
  readonly account: string;
  /** The caller as the cloud names it (an ARN, an email, a UPN), for messages. */
  readonly principal: string;
  /** Azure: the subscription's tenant (`directoryId`). */
  readonly directory?: string;
}

/**
 * What a cloud CLI is run with: argv after the executable, and an optional
 * stdin. A seed never builds a shell string.
 *
 * @public (lanes S2 to S4)
 */
export interface SeedCommand {
  readonly args: readonly string[];
  readonly input?: string;
}

/**
 * Runs the user's cloud CLI (`aws`, `az`, `gcloud`); `createCloudCli` in
 * cloud-cli.ts is the one implementation, and the test kit fakes the
 * executables it runs.
 */
export interface CloudCli {
  /** Stdout of a command that exited 0; throws `CloudCliError` otherwise. */
  run(
    command: SeedCommand,
    options?: { signal?: AbortSignal },
  ): Promise<string>;
}

/** The `CloudType` a seed cloud names, by its lowercase spelling. */
export function seedCloudType(cloud: SeedCloud): CloudType {
  return Object.values(CloudType).find(
    (entry) => entry.toLowerCase() === cloud,
  )!;
}

/**
 * Names every seed derives from the cluster ID, so `status` and
 * `deleteFallback` find an installation from its ID alone: the AWS stack and
 * the Azure resource group are `anycloud-<id>`, the GCP instance is
 * `anycloud-cluster-<id>`.
 *
 * @public (lanes S2 to S4)
 */
export function seedStackName(clusterId: string): string {
  return `anycloud-${clusterId}`;
}

/** @public (lanes S2 to S4) */
export function seedInstanceName(clusterId: string): string {
  return `anycloud-cluster-${clusterId}`;
}

/** What the API needs to delete its own installation last (lane S6), per cloud.
 * @public (lanes S2 to S4)
 */
export type SeedSelfDelete =
  | {
      readonly cloud: 'aws';
      readonly stackName: string;
      readonly roleArn: string;
    }
  | { readonly cloud: 'azure'; readonly resourceGroup: string }
  /** The CLI's `afterSelfDelete` deletes the firewall rules: the VM can't be scoped to them. */
  | {
      readonly cloud: 'gcp';
      readonly instanceName: string;
      readonly zone: string;
    };

/** The release values the startup script installs the API with; never secret. */
export interface SeedReleaseValues {
  readonly [key: string]: unknown;
  readonly selfDelete: SeedSelfDelete;
  readonly backup: SystemReleaseBackupValues;
  /** Test-only: mount the e2e harness's kubeconfig hand-off (`ANYCLOUD_E2E_ACCESS=1`). */
  readonly e2eAccess?: true;
}

/** Tags every resource the seed creates carries (`anycloud_cluster`, `anycloud_cluster_name`, …).
 * @public (lanes S2 to S4)
 */
export type SeedTags = Readonly<Record<string, string>>;

/** What `deploy` creates the management VM from. */
export interface SeedParams {
  readonly clusterId: string;
  readonly clusterName: string;
  readonly region: string;
  /** Provider format; null lets the cloud pick. */
  readonly zone: string | null;
  readonly vmType: string;
  /**
   * The checkpoint bucket. A supplied one is used as is and never deleted. A
   * managed one is deleted under `deleteBuckets`, and created unless
   * `exists`: an existing managed bucket, as in a restore from it or a
   * resume of a deployed installation that holds it.
   */
  readonly bucket: {
    readonly name: string;
    readonly managed: boolean;
    readonly exists?: true;
  };
  /** The release values the startup script installs the API with, `selfDelete` included. */
  readonly releaseValues: SeedReleaseValues;
  /** The management VM's startup script (lane S5), passed as user-data or startup metadata. */
  readonly startupScript: string;
  readonly tags: SeedTags;
}

/** What `deploy` reports once the VM exists.
 * @public (lanes S2 to S4)
 */
export interface SeedOutputs {
  /** Where the CLI publishes `<id>.anycloud.sh`. */
  readonly publicIp: string;
  /** The management VM's provider id. */
  readonly instanceId: string;
  /** The bucket's name exactly as `SeedParams.bucket.name` passed it. */
  readonly bucket: string;
  /** The VM's own identity (instance profile role ARN, managed identity id, service account email). */
  readonly identity: string;
}

/** What the cloud shows of an installation, for resume and the dead-API fallback.
 * @public (lanes S2 to S4)
 */
export type SeedStatus =
  | { readonly kind: 'absent' }
  /** Mid-deploy, or mid-delete. */
  | { readonly kind: 'in-progress'; readonly detail: string }
  | {
      readonly kind: 'deployed';
      readonly outputs: SeedOutputs;
      /** AWS `stopped`; GCP STOPPING, SUSPENDING, SUSPENDED or TERMINATED; Azure deallocated. */
      readonly stopped: boolean;
    }
  | { readonly kind: 'failed'; readonly detail: string };

/** One cloud resource `deleteFallback` deleted or left.
 * @public (lanes S2 to S4)
 */
export interface SeedResource {
  readonly kind:
    | 'stack'
    | 'group'
    | 'vm'
    | 'disk'
    | 'network'
    | 'firewall'
    | 'bucket'
    | 'identity'
    | 'serviceAccount';
  readonly id: string;
  /** Region or zone, where the cloud has one. */
  readonly location?: string;
}

/** What `deleteFallback` removed, and what it left (C26 (d)'s lists).
 * @public (lanes S2 to S4)
 */
export interface SeedDeleteResult {
  readonly deleted: readonly SeedResource[];
  /** Each with the tag or name selector a user searches for it by. */
  readonly remaining: ReadonlyArray<
    SeedResource & {
      readonly selector: string;
      /** Why it was left; `harmless`: on purpose, and it costs nothing. */
      readonly reason?: string;
    }
  >;
}

export interface CloudSeed {
  readonly cloud: SeedCloud;
  /** The account and caller the user's CLI is signed in as; throws `SeedUnavailableError` when it isn't. */
  discoverAccount(): Promise<SeedAccount>;
  /** The rights create needs that the caller lacks; null when the cloud can't say for this caller. */
  checkRights(account: SeedAccount): Promise<string[] | null>;
  /**
   * What the API needs to delete its installation last: pure, from the
   * cluster ID and account alone. The driver merges it into the release
   * values before the startup script is rendered.
   */
  selfDeleteValues(
    params: Pick<SeedParams, 'clusterId' | 'region' | 'zone'>,
    account: SeedAccount,
  ): SeedSelfDelete;
  /**
   * The hosted API's backup values (`release.values.backup`): pure, from the
   * cluster ID, its bucket and the account, with the VM's own identity as
   * the credential (AWS `{kind: 'instance'}`, GCP with its project, Azure
   * with its subscription and tenant; the API derives Azure's storage account
   * from the subscription, and needs no client ID: it asks IMDS for its one
   * user-assigned identity). The driver adds `account` and `target`.
   */
  backupValues(
    params: Pick<SeedParams, 'clusterId' | 'region' | 'bucket'>,
    account: SeedAccount,
  ): SystemReleaseBackupValues;
  /**
   * Create or adopt the installation's resources; idempotent, so a re-run
   * resumes. It doesn't change the values: the VM's user-data or startup
   * metadata is `params.startupScript` as given.
   */
  deploy(params: SeedParams, signal?: AbortSignal): Promise<SeedOutputs>;
  /**
   * The cluster ID of the installation tagged `anycloud_cluster_name` with
   * this name in the account, so a re-run of create resumes it; null when
   * none. Throws when two match. `tags.anycloud_cluster_name` holds the raw
   * name; each seed normalizes it for its cloud (GCP: lowercase, anything
   * outside `[a-z0-9_-]` becomes `_`, cut to 63 characters).
   */
  findByName(clusterName: string, region: string): Promise<string | null>;
  /** From the names `seedStackName` and `seedInstanceName` give the ID. */
  status(clusterId: string, region: string): Promise<SeedStatus>;
  /** One object of a bucket, as text; null when it is absent (`backup.json`). */
  readObject(
    bucket: string,
    key: string,
    region: string,
  ): Promise<string | null>;
  /**
   * Once `status` shows the installation absent after the API deleted
   * itself: what only the user's credentials may remove (AWS: the stack's
   * service role, and the versioned bucket under `deleteBuckets`; GCP: the
   * firewall rules, the bucket under `deleteBuckets`, and the VM's service
   * account with its bindings; Azure: the checkpoint container's
   * role assignment, and the managed container under `deleteBuckets`).
   */
  afterSelfDelete(
    clusterId: string,
    region: string,
    options: { deleteBuckets: boolean },
  ): Promise<SeedDeleteResult>;
  /**
   * Only when the API is dead: delete the installation's resources directly,
   * found by those names and the `anycloud_cluster=<id>` tag (pool VMs too),
   * keeping the managed bucket unless `deleteBuckets`.
   */
  deleteFallback(
    clusterId: string,
    region: string,
    options: { deleteBuckets: boolean },
  ): Promise<SeedDeleteResult>;
}

/** The cloud's CLI isn't installed or isn't signed in; the message says how to fix it. */
export class SeedUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedUnavailableError';
  }
}

/** A cloud CLI command exited non-zero. */
export class CloudCliError extends Error {
  constructor(
    readonly executable: string,
    readonly args: readonly string[],
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(
      `${executable} ${args.slice(0, 3).join(' ')} failed${exitCode === null ? '' : ` (exit ${exitCode})`}: ${stderr.trim() || 'no output'}`,
    );
    this.name = 'CloudCliError';
  }
}

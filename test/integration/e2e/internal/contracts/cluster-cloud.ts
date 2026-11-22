import type { StageProgress } from '../progress.js';

import { ROLE_CHECKS, type RoleConnectionChecks } from './role-connections.js';

/**
 * `live_checks`, each on the hosted journey: the role connections created,
 * converged and deleted through each cloud's CLI (`role-apply`), then RFC
 * 0047's role-connection scenarios.
 */
export const LIVE_CHECKS = ['role-apply', ...ROLE_CHECKS] as const;
export type LiveCheck = (typeof LIVE_CHECKS)[number];

export interface HostedVersion {
  readonly version: string;
  readonly schemaVersion: string | null;
}

export interface HostedReleaseRecord {
  readonly image: string;
  /** Upgrade N, as `api status` shows it. */
  readonly upgrade: number;
  readonly backupVersionsBefore: number;
  readonly backupVersionsAfter: number;
  readonly servedAfter: HostedVersion;
  /** `/health` through the upgrade, polled every 250 ms. */
  readonly health: HostedHealthRecord;
}

export interface HostedHealthRecord {
  readonly requests: number;
  readonly failed: number;
  /** The longest time between two good answers. */
  readonly longestGapMs: number;
  /**
   * Failed requests by kind: the error's code (`ENOTFOUND`, `ECONNREFUSED`,
   * `ECONNRESET`), `timeout`, or the HTTP status with the `Server` header.
   * `detail` is the first one's message or Cloudflare ray.
   */
  readonly failures: Readonly<
    Record<
      string,
      {
        readonly count: number;
        readonly firstAt: string;
        readonly lastAt: string;
        readonly detail: string;
      }
    >
  >;
  /**
   * At the first failure, the runner's resolver against each authoritative
   * nameserver.
   */
  readonly dns?: {
    readonly at: string;
    readonly resolver: string;
    readonly authoritative: readonly string[];
  };
}

/** The recursion property: a Job through the hosted API whose container submitted the child through the same API. */
export interface HostedRecursionRecord {
  readonly parentId: string;
  readonly childId: string;
}

export interface HostedStageRecord {
  /** The VM Service through the hosted API whose state each release keeps. */
  readonly serviceId: string;
  readonly recursion: HostedRecursionRecord;
  /** With `fromRelease`, the upgrade from it comes first. */
  readonly releases: readonly HostedReleaseRecord[];
}

/** The hosted-API capability: every verb against the API on the cluster lives in the substrate. */
export interface HostedStage {
  /**
   * With `fromRelease`, ends with the upgrade from it to this tree's release;
   * `beforeUpgrade` runs on the released CLI just before it.
   */
  operatorWalk(
    beforeUpgrade?: () => Promise<void>,
  ): Promise<HostedReleaseRecord | undefined>;
  /** `role-apply`: role connections through each cloud's CLI. */
  roleApply(): Promise<void>;
  /** A VM Service through the hosted API, waited to running. */
  runService(label?: string): Promise<string>;
  /** After a release the VM Service still runs and the saved credential still decrypts. */
  stateSurvives(serviceId: string): Promise<void>;
  /**
   * Without an image, to this CLI's release. `rollsOnce`: the API's
   * native Kubernetes Deployment rolls exactly once.
   */
  release(image?: string, rollsOnce?: boolean): Promise<HostedReleaseRecord>;
  releaseUnchanged(image: string): Promise<void>;
  releaseRefused(): Promise<void>;
  /** Parent Job from the API image submits the child through the same API; both complete; child → parent teardown. */
  recursion(apiImage: string): Promise<HostedRecursionRecord>;
  terminate(id: string, kind: 'Service' | 'Job'): Promise<void>;
  /**
   * Runs each cleanup still owed through the hosted API, before
   * `api delete` removes the API.
   */
  settleCleanups(): Promise<void>;
  captureDiagnostics(): Promise<void>;
}

export type HostedStageDependency =
  | {
      readonly stage: HostedStage;
      /** Digest-pinned `b` image of this tree, the first real image change. */
      readonly alternateImage: string;
    }
  /** The default journey: the operator walk through the hosted API. */
  | { readonly stage: HostedStage; readonly operator: true };

/** The hosted API's ServiceAccount issuer, read as a cloud reads it. */
export interface ServiceAccountIssuerRecord {
  readonly issuer: string;
  readonly jwksUri: string;
  /** The `kid` of each key the JWKS served. */
  readonly keyIds: readonly string[];
}

export interface LiveCluster {
  readonly id: string;
  readonly connected: boolean;
  readonly kubernetesIdentity: string | null;
  readonly apiVersion: string | null;
  readonly apiImage: string | null;
  readonly managementApiUrl: string | null;
  readonly state: string;
  /** Terminated, but the management VM is still being released. */
  readonly releasing?: boolean;
}

/** Each dead-API delete's outcome and what it reported deleted. */
export interface DeadApiDeleteRecord {
  readonly steps: readonly {
    readonly flags: readonly string[];
    readonly outcome: string;
    readonly deleted: readonly string[];
  }[];
}

export interface ClusterCloudNativeLeftovers {
  readonly instances: readonly string[];
  readonly securityGroups: readonly string[];
  readonly volumes: readonly string[];
  readonly buckets: readonly string[];
  /** The seed's installation and what is still tagged for it. */
  readonly installation: readonly string[];
  readonly dnsRecords: readonly string[];
  readonly dnsDeferred: boolean;
}

/** The runner's side of the cluster: this tree's CLI and native cloud reads; every CLI verb lives here. */
export interface ClusterCloudSubstrate {
  /** Where the management VM runs (`cluster_provider`). */
  readonly clusterProvider: ClusterCloudTarget;
  /** `destroyTimeoutMs` bounds the cleanup it registers. */
  bootstrap(timeoutMs: number, destroyTimeoutMs: number): Promise<LiveCluster>;
  clusters(): Promise<readonly LiveCluster[]>;
  hostedVersion(): Promise<string>;
  /**
   * The discovery document, then the JWKS at its `jwks_uri`, both through
   * Cloudflare as a plain HTTP client; a challenge page fails the read.
   */
  serviceAccountIssuer(): Promise<ServiceAccountIssuerRecord>;
  /** Null where it is not read: a GCP or Azure management VM. */
  backupObjectVersions(): Promise<number | null>;
  /**
   * `api delete`: keeps the managed checkpoint bucket after a final
   * backup, or with `deleteBuckets` deletes it too (RFC 0049 C28).
   */
  destroy(timeoutMs: number, deleteBuckets?: boolean): Promise<LiveCluster>;
  /**
   * Stop the management VM so the API is gone, then delete the cluster from
   * a machine with no state (RFC 0049 C26 (c)): `--cloud`, then
   * `--delete-vms`, `--delete-buckets` and `--skip-cloud`.
   */
  destroyWithoutApi(timeoutMs: number): Promise<DeadApiDeleteRecord>;
  /**
   * After a delete that kept it: the bucket still exists, with the final
   * backup the delete took. The harness then removes it itself, since
   * deleting a kept bucket afterwards is the unreachable path's.
   */
  keptBucket(): Promise<KeptBucketRecord>;
  /** After `--delete-buckets`: the delete reported the bucket deleted, and it is gone. */
  bucketDeleted(): Promise<KeptBucketRecord>;
  /**
   * After a delete that kept it: restore the cluster from the bucket under
   * its ID and hostname, then delete it with `--delete-buckets` (RFC 0049 C28).
   */
  restoreFromKeptBucket(
    bootstrapTimeoutMs: number,
    destroyTimeoutMs: number,
  ): Promise<KeptBucketRecord>;
  /** The hosted API's and Traefik's Pod logs, for a failure before cleanup. */
  captureHostedApiLogs(): Promise<void>;
  sweep(): Promise<ClusterCloudNativeLeftovers>;
}

/** The management VM's cloud: the contract's qualification target. */
export type ClusterCloudTarget = 'aws' | 'gcp' | 'azure';

/**
 * RFC 0049 C28: the default journey's delete keeps the managed bucket after a
 * final backup; the hosted journey deletes it with `--delete-buckets`.
 */
export type KeptBucketRecord =
  | {
      readonly name: string;
      readonly kept: true;
      /** `api delete` took a final backup before releasing the VM. */
      readonly finalBackup: 'taken';
    }
  | {
      readonly name: string;
      readonly kept: false;
      /** With `restore_stage`: the restored cluster served its old hostname. */
      readonly restored?: {
        readonly managementApiUrl: string;
        readonly servedVersion: string;
      };
    };

export interface ClusterCloudContractResult {
  readonly contract: 'e2e-cluster-cloud';
  readonly qualification: 'conclusive';
  readonly satisfied: true;
  readonly target: ClusterCloudTarget;
  readonly records: {
    readonly installation: {
      readonly id: string;
      readonly kubernetesIdentity: string;
      readonly apiImage: string | null;
      readonly servedVersion: string;
      readonly backupVersionsAfterBootstrap: number | null;
      /** After bootstrap; with `fromRelease`, after its upgrade instead. */
      readonly serviceAccountIssuer: ServiceAccountIssuerRecord;
      readonly destroyed: true;
      readonly checkpointBucket: KeptBucketRecord;
    };
    /** Present when the default journey deleted with its API gone. */
    readonly deadApiDelete?: DeadApiDeleteRecord;
    readonly sweep: ClusterCloudNativeLeftovers;
    /** Present when the run drove the hosted-API stage. */
    readonly hosted?: HostedStageRecord;
  };
}

export interface ClusterCloudContractPolicy {
  readonly bootstrapTimeoutMs: number;
  readonly destroyTimeoutMs: number;
  /** When true, leftovers are reported in the result instead of failing. */
  readonly keepOnFailure: boolean;
  /** The default journey deletes as from a second machine once the API is gone. */
  readonly deadApiDelete?: boolean;
  /** The default journey restores from the kept bucket before deleting it (`restore_stage`). */
  readonly restoreStage?: boolean;
}

type ClusterCloudDependencies = {
  readonly cliVersion: string;
  /** `from_release`: the published release bootstrap installs instead of this CLI's. */
  readonly fromRelease?: string;
  readonly policy: ClusterCloudContractPolicy;
  readonly progress: Pick<StageProgress, 'mark'>;
  readonly substrate: ClusterCloudSubstrate;
  /** The journey, each through the hosted API on the cluster. */
  readonly hosted: HostedStageDependency;
  /** `live_checks`: run on the hosted journey. */
  readonly checks?: {
    readonly selected: readonly LiveCheck[];
    /** The role-connection checks (RFC 0047 S14 to S17), when selected. */
    readonly roles?: Pick<
      RoleConnectionChecks,
      'roleConnections' | 'trustPinning' | 'keyRotation' | 'storageTokens'
    >;
  };
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Cluster contract: ${message}`);
}

/**
 * The one combined live run of the cluster path: this tree's CLI bootstraps
 * a cluster on a management VM, the operator walks the hosted API, the
 * product tears everything down, and a native sweep proves nothing tagged
 * for the run remains. The hosted stage also proves the hosted API release
 * lifecycle around a VM Service and recursive VM Jobs.
 */
export class ClusterCloudContract {
  readonly #dependencies: ClusterCloudDependencies;

  constructor(dependencies: ClusterCloudDependencies) {
    this.#dependencies = dependencies;
  }

  /** The target is the management VM's cloud (`cluster_provider`). */
  async run(): Promise<ClusterCloudContractResult> {
    const d = this.#dependencies;
    const target = d.substrate.clusterProvider;
    // The native sweep runs whatever happened in the journey. On success the
    // journey destroyed the cluster itself; on failure the cleanup stack runs
    // only after this returns, so the substrate leaves the cluster's DNS
    // record to the workflow's post-teardown sweep. A journey failure keeps
    // priority over a leak report.
    const journey = await this.#journey(target).then(
      (result) => ({ result }),
      async (error: unknown) => {
        await d.substrate.captureHostedApiLogs();
        return { error };
      },
    );
    // A sweep that itself fails must never hide what the journey found: it
    // becomes a secondary line under the stage failure, or the failure of an
    // otherwise green run.
    const sweep = await d.substrate.sweep().catch((error: unknown) => {
      if ('error' in journey) {
        throw new Error(
          `${errorMessage(journey.error)}\n(secondary) native sweep failed: ${errorMessage(error)}`,
          { cause: journey.error },
        );
      }
      throw error;
    });
    const leftovers = [
      ...sweep.instances,
      ...sweep.securityGroups,
      ...sweep.volumes,
      ...sweep.buckets,
      ...sweep.installation,
      ...sweep.dnsRecords,
    ];
    if ('error' in journey) throw journey.error;
    if (leftovers.length > 0 && !d.policy.keepOnFailure) {
      throw new Error(
        `Cluster (${target}) contract: resources remain after teardown: ${leftovers.join(', ')}`,
      );
    }
    return journey.result;
  }

  async #journey(
    target: ClusterCloudTarget,
  ): Promise<ClusterCloudContractResult> {
    const d = this.#dependencies;

    const cluster = await d.substrate.bootstrap(
      d.policy.bootstrapTimeoutMs,
      d.policy.destroyTimeoutMs,
    );
    invariant(
      cluster.state === 'running' &&
        cluster.connected &&
        cluster.kubernetesIdentity &&
        cluster.managementApiUrl,
      'bootstrap did not produce a ready cluster',
    );
    const installed = d.fromRelease ?? d.cliVersion;
    invariant(
      cluster.apiVersion === installed &&
        cluster.apiImage !== null &&
        cluster.apiImage.includes('@sha256:'),
      `installation pinned ${cluster.apiImage} (${cluster.apiVersion}) instead of release ${installed}`,
    );
    const listed = await d.substrate.clusters();
    invariant(
      listed.filter((entry) => entry.state !== 'terminated' || entry.releasing)
        .length === 1 && listed[0]?.id === cluster.id,
      'installer records more than the one installation',
    );
    const servedVersion = await d.substrate.hostedVersion();
    invariant(
      servedVersion === installed,
      `hosted API serves ${servedVersion}, expected ${installed}`,
    );
    const backupVersionsAfterBootstrap =
      await d.substrate.backupObjectVersions();
    // A published release predates the issuer; this tree's upgrade adds it.
    const issuerAfterBootstrap = d.fromRelease
      ? undefined
      : await this.#serviceAccountIssuer(cluster.id);

    const stage =
      'operator' in d.hosted
        ? await this.#operatorStage(d.hosted.stage)
        : { hosted: await this.#hostedStage(d.hosted, cluster.apiImage) };
    await d.hosted.stage.settleCleanups();
    const serviceAccountIssuer =
      issuerAfterBootstrap ?? (await this.#serviceAccountIssuer(cluster.id));
    // The default journey keeps the bucket; the others delete it with it.
    const deadApi =
      d.policy.deadApiDelete === true && 'operator' in d.hosted
        ? await d.substrate.destroyWithoutApi(d.policy.destroyTimeoutMs)
        : undefined;
    const deleteBuckets = deadApi !== undefined || !('operator' in d.hosted);
    if (!deadApi) {
      const destroyed = await d.substrate.destroy(
        d.policy.destroyTimeoutMs,
        deleteBuckets,
      );
      invariant(
        destroyed.state === 'terminated' && !destroyed.releasing,
        'api delete did not finish',
      );
    }
    invariant(
      (await d.substrate.clusters()).every(
        (entry) => entry.state === 'terminated' && !entry.releasing,
      ),
      'installer still records a live installation',
    );
    // The dead-API delete checked its own bucket deletion against the cloud.
    const checkpointBucket = deadApi
      ? ({ name: cluster.id, kept: false } as const)
      : deleteBuckets
        ? await d.substrate.bucketDeleted()
        : d.policy.restoreStage
          ? await d.substrate.restoreFromKeptBucket(
              d.policy.bootstrapTimeoutMs,
              d.policy.destroyTimeoutMs,
            )
          : await d.substrate.keptBucket();
    // The sweep reports the bucket as a leftover if either left it behind.
    const sweep = await d.substrate.sweep();

    return {
      contract: 'e2e-cluster-cloud',
      records: {
        installation: {
          id: cluster.id,
          kubernetesIdentity: cluster.kubernetesIdentity,
          apiImage: cluster.apiImage,
          servedVersion,
          backupVersionsAfterBootstrap,
          serviceAccountIssuer,
          destroyed: true,
          checkpointBucket,
        },
        ...stage,
        ...(deadApi ? { deadApiDelete: deadApi } : {}),
        sweep,
      },
      qualification: 'conclusive',
      target,
      satisfied: true,
    };
  }

  /**
   * The issuer role connections trust (RFC 0047 § Issuer prerequisite): the
   * hosted API's public URL (`clusterApiUrl`), whose JWKS, at Kubernetes's
   * own path, holds K3s's signing key.
   */
  async #serviceAccountIssuer(
    clusterId: string,
  ): Promise<ServiceAccountIssuerRecord> {
    const issuer = await this.#dependencies.substrate.serviceAccountIssuer();
    const expected = `https://${clusterId}.anycloud.sh`;
    invariant(
      issuer.issuer === expected &&
        issuer.jwksUri === `${expected}/openid/v1/jwks`,
      `hosted API's ServiceAccount issuer is ${issuer.issuer} with JWKS ${issuer.jwksUri}, expected ${expected}`,
    );
    invariant(
      issuer.keyIds.length > 0,
      `hosted API's ServiceAccount JWKS at ${issuer.jwksUri} has no keys`,
    );
    return issuer;
  }

  /** The default journey: the operator walk through the hosted API. */
  async #operatorStage(hosted: HostedStage): Promise<object> {
    try {
      await hosted.operatorWalk();
      return {};
    } catch (error) {
      await hosted.captureDiagnostics();
      throw error;
    }
  }

  /**
   * The hosted-API stage: the operator walk, a VM Service through the
   * hosted API, the self-update both ways (`b` then `a`, a real image change
   * each) with the Service's state surviving each, the unchanged and refused
   * cases, and recursive VM Jobs. With `fromRelease` the Service is created
   * on the released API, before the walk's upgrade.
   */
  async #hostedStage(
    {
      stage: hosted,
      alternateImage,
    }: Extract<HostedStageDependency, { alternateImage: string }>,
    bootstrapImage: string,
  ): Promise<HostedStageRecord> {
    const d = this.#dependencies;
    try {
      let serviceId: string | undefined;
      // From a published release the walk ends on this tree's `a`.
      const fromRelease = await hosted.operatorWalk(
        d.fromRelease
          ? async () => {
              serviceId = await hosted.runService();
            }
          : undefined,
      );
      if (serviceId) await hosted.stateSurvives(serviceId);
      await this.#checks(hosted);
      serviceId ??= await hosted.runService();
      const imageA = fromRelease?.image ?? bootstrapImage;
      // Image `b` first (a real change from the bootstrap image `a`), then
      // back to `a` explicitly — both built from this tree, so `api upgrade`
      // without `--image` would report "already matches" (design §5.3).
      // `a` and `b` name different charts (e2e.sh): one write, one roll.
      const toB = await hosted.release(alternateImage, true);
      await hosted.stateSurvives(serviceId);
      for (const { servedAfter } of [fromRelease, toB].filter(
        (r) => r !== undefined,
      )) {
        invariant(
          servedAfter.version === d.cliVersion &&
            servedAfter.schemaVersion === d.cliVersion,
          `after the release the API serves ${servedAfter.version} (schema ${servedAfter.schemaVersion ?? 'unknown'}), expected ${d.cliVersion}`,
        );
      }
      const toA = await hosted.release(imageA);
      await hosted.stateSurvives(serviceId);
      await hosted.releaseUnchanged(imageA);
      await hosted.releaseRefused();
      // After the round trip the API serves `a` again: it now hosts a Job
      // whose container drives it (the retired aws-recursion property).
      const recursion = await hosted.recursion(imageA);
      await this.#keyRotationCheck();
      await hosted.terminate(serviceId, 'Service');
      return {
        serviceId,
        recursion,
        releases: [...(fromRelease ? [fromRelease] : []), toB, toA],
      };
    } catch (error) {
      await hosted.captureDiagnostics();
      throw error;
    }
  }

  /**
   * The selected `live_checks` after the operator walk: `role-apply` and the
   * role-connection checks but key rotation, which runs after the journey.
   */
  async #checks(hosted: HostedStage): Promise<void> {
    const checks = this.#dependencies.checks;
    if (!checks) return;
    const { selected } = checks;
    // The hosted API and the runner's cloud CLIs.
    if (selected.includes('role-apply')) await hosted.roleApply();
    if (selected.includes('role-connections'))
      await this.#roles().roleConnections();
    if (selected.includes('role-trust-pinning'))
      await this.#roles().trustPinning();
    if (selected.includes('role-storage-tokens'))
      await this.#roles().storageTokens();
  }

  #roles() {
    const roles = this.#dependencies.checks?.roles;
    invariant(roles, 'role-connection checks selected without their port');
    return roles;
  }

  /**
   * S16 after the journey's own stages: retiring the old key early refuses
   * every token it signed, in the cluster too, so nothing may still depend
   * on one (lane R4 restarts the Pods that hold them).
   */
  async #keyRotationCheck(): Promise<void> {
    if (this.#dependencies.checks?.selected.includes('role-key-rotation'))
      await this.#roles().keyRotation();
  }
}

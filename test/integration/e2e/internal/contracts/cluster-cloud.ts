import type { ImagePullTelemetry } from '../../../../../src/shared/image.js';
import type { StageProgress } from '../progress.js';
import { retryTransientProbeError, type Waiter } from '../wait.js';

import {
  coldStartRecord,
  type GpuColdStartRecord,
  type PoolColdStartTimes,
} from './gpu-cold-start.js';
import type { EntryHandoff, PoolCheck, PoolChecks } from './pool-checks.js';
import type { RoleConnectionChecks } from './role-connections.js';

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

/**
 * K5's egress policy from inside the replica: the Node's resolvers
 * (`dnsPolicy: Default`; on GCP the metadata server), through which the
 * workload API host resolved, and why the metadata HTTP port refused; on
 * Azure, why each WireServer port refused.
 */
export interface EgressProbe {
  readonly nameservers: readonly string[];
  readonly metadataError: string;
  readonly wireServerErrors?: Readonly<Record<'80' | '32526', string>>;
}

/** Jobs on the pool: a Deployment's one observed Pod completed one Job and acknowledged the other's cancellation. */
export interface HostedPoolJobsRecord {
  readonly deploymentId: string;
  readonly podUid: string;
  readonly egress: EgressProbe;
  readonly completedJobId: string;
  /** The completed Job's creation to its first claim; off a
   * GPU only, where the receiver has no model to load first. */
  readonly claimMs?: number;
  /** The completed Job's replica's image pull, from its claim's event; absent
   * when kubelet's best-effort `Pulled` Event was dropped or unreadable. */
  readonly imagePull?: ImagePullTelemetry;
  readonly cancelledJobId: string;
  /** GPU pool: the canary Job's fresh CUDA energy, equal to its CPU reference. */
  readonly maceCanary?: {
    readonly jobId: string;
    readonly geometry: string;
    readonly device: string;
    readonly energyEv: number;
    /** Creation to first claim, on the warm receiver. */
    readonly claimMs: number;
  };
  /** Voice workload: the canary's checked session, within tolerance of its reference. */
  readonly voiceCanary?: {
    readonly jobId: string;
    readonly seconds: number;
    readonly rms: number;
    readonly distance: number;
    readonly device: string;
    readonly modelLoadId: string;
    /** Creation to first claim, on the warm receiver. */
    readonly claimMs: number;
    /** From the session's admission to its first audio. */
    readonly firstChunkMs: number;
    /** Wall time over audio time. */
    readonly rtf: number;
  };
  /**
   * Voice workload: two held sessions admitted while a third waited, then took
   * the released slot; a second canary checked beside a held session, from the
   * same model load as the first.
   */
  readonly voiceSessions?: {
    readonly heldJobIds: readonly string[];
    readonly queuedJobId: string;
    readonly cancelledJobId: string;
    readonly besideCanary: NonNullable<HostedPoolJobsRecord['voiceCanary']>;
  };
}

export interface HostedStageRecord {
  readonly nodePoolId: string;
  readonly serviceId: string;
  readonly poolJobs: HostedPoolJobsRecord;
  /** With `fromRelease`, the pool's instances from before the upgrade, each replaced. */
  readonly replacedOnUpgrade: readonly string[];
  /** RFC 0043's bucketed Job: S17 on an AWS or GCP pool, S20 on a Lambda pool. */
  readonly storage: HostedPoolJobStorageRecord | null;
  /** The Deployment Secret stage's Pods: created, rotated, key removed. */
  readonly deploymentSecretPods: readonly string[];
  /** Null on a GCP, Azure or Lambda pool, whose VM Jobs no native sweep covers. */
  readonly recursion: HostedRecursionRecord | null;
  /** With `fromRelease`, the upgrade from it comes first. */
  readonly releases: readonly HostedReleaseRecord[];
  readonly destroyRefusal: string;
  /** Null with `fromRelease`, whose pool is fixed-size. */
  readonly scale: HostedScaleRecord | null;
}

/**
 * RFC 0048's scale stage: a burst of whole-Node pool Jobs bought exactly the
 * Nodes it needed, under a `--max-vms` one higher, so a double buy shows. Each
 * Job ran once, the long one on a Node scale-in kept past the idle window,
 * and then the pool was back to its Nodes from before the burst.
 */
export interface HostedScaleRecord {
  readonly minVms: number;
  readonly maxVms: number;
  /** The new Nodes the burst needs: `maxVms - minVms - 1`. */
  readonly burstVms: number;
  readonly jobIds: readonly string[];
  /** Outlived the idle window on a Node that is not the ingress entry. */
  readonly longJobId: string;
  /** Each pass's `capacity.lastScaleOut`; together they bought `burstVms`. */
  readonly scaleOuts: readonly {
    readonly at: number;
    readonly pendingPods: number;
    readonly lostVms: number;
    readonly vms: number;
  }[];
  /** Native instances before the burst, every one seen since, and those left. */
  readonly before: readonly string[];
  readonly launched: readonly string[];
  readonly kept: readonly string[];
}

/**
 * RFC 0043 on an Azure pool: a Job with `--node-pool` and buckets read its
 * staged input and uploaded its output under `<bucket>/<job-id>/` (S1), and
 * found no storage credential in its env, files or mounted Secrets, nor its
 * log or the node pool namespace's Secrets (S6).
 */
export interface HostedPoolJobStorageRecord {
  readonly jobId: string;
  readonly inputBucket: string;
  readonly outputBucket: string;
  /** Null on a spot pool, whose Job checkpoints to its managed bucket. */
  readonly checkpointBucket: string | null;
  /** The output and checkpoint containers' objects after the Job completed. */
  readonly outputObjects: readonly string[];
  readonly checkpointObjects: readonly string[];
}

/** The GPU pool journey (`gpu_pool`): a GPU Service, GPU Jobs and host loss. */
export interface HostedGpuStageRecord {
  readonly nodePoolId: string;
  /** The `nvidia-smi -L` lines the Service served through its URL. */
  readonly service: {
    readonly id: string;
    readonly devices: readonly string[];
  };
  /** Receiver Jobs ran only after `nvidia-smi -L` listed a GPU in the Pod. */
  readonly poolJobs: HostedPoolJobsRecord;
  /** With `fromRelease`, the pool's instances from before the upgrade, each replaced. */
  readonly replacedOnUpgrade: readonly string[];
  /** RFC 0043's bucketed Job on the GPU pool. */
  readonly storage: HostedPoolJobStorageRecord | null;
  readonly hostLoss: {
    readonly terminatedInstance: string;
    readonly replacementInstance: string;
    readonly podUid: string;
    readonly jobId: string;
    /** With one replica, the session it was running: its retry reason. */
    readonly session?: { readonly jobId: string; readonly retryReason: string };
  };
  readonly scale: HostedScaleRecord | null;
  /** Why the scale stage did not run, when it didn't. */
  readonly scaleSkipped?: string;
  /**
   * Time to first inference with one replica: the first
   * Node's and the host-loss replacement's.
   */
  readonly coldStart?: {
    readonly first: GpuColdStartRecord;
    readonly replacement: GpuColdStartRecord;
  };
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
  /** Starts the receiver image build and push once; poolJobs awaits it. */
  prepareReceiverImage(): Promise<string>;
  /** `role-apply`: role connections through each cloud's CLI. */
  roleApply(): Promise<void>;
  createReadyNodePool(onCreated: (nodePoolId: string) => void): Promise<string>;
  runService(nodePoolId: string, label?: string): Promise<string>;
  /**
   * Beside `serviceId`, or a Service of its own; `observe` runs on every
   * pool read. Null on a fixed-size pool.
   */
  scalePool(
    nodePoolId: string,
    serviceId: string | undefined,
    observe: () => Promise<unknown>,
  ): Promise<Omit<HostedScaleRecord, 'before' | 'launched' | 'kept'> | null>;
  /** `keepDeployment` leaves the receiver running for `poolJobAfterHostLoss`. */
  poolJobs(
    nodePoolId: string,
    keepDeployment?: boolean,
  ): Promise<HostedPoolJobsRecord>;
  startReplicaLossSessions?(): Promise<void>;
  /** The receiver's newest Pod's `AC_TIMING` marks, once it claimed a Job. */
  receiverMarks(): Promise<Readonly<Record<string, number>>>;
  /** A bucketed Job on the pool, then its containers deleted; null off Azure. */
  poolJobStorage(
    nodePoolId: string,
    secretsWithCredential: () => Promise<readonly string[]>,
    deletePod: (podUid: string) => Promise<void>,
  ): Promise<HostedPoolJobStorageRecord | null>;
  gpuServiceDevices(serviceId: string): Promise<readonly string[]>;
  /** A session held on the kept Deployment's replica, for host loss. */
  startReplicaLossSession(): Promise<string>;
  poolJobAfterHostLoss(
    nodePoolId: string,
    previousPodUid: string,
    sessionId?: string,
    beforeDelete?: (podUid: string) => Promise<void>,
  ): Promise<{
    podUid: string;
    jobId: string;
    session?: { jobId: string; retryReason: string };
  }>;
  /** After a release the pool Service still runs and the saved credential still decrypts. */
  stateSurvives(serviceId: string): Promise<void>;
  /** Without an image, to this CLI's release. */
  release(image?: string): Promise<HostedReleaseRecord>;
  /** `release(image)` while the receiver `poolJobs` kept claims Jobs; deletes it after. */
  releaseUnderLoad(image: string): Promise<HostedReleaseRecord>;
  /** A Deployment with a named Secret: create, rotation, key removal, delete refusal; its Pods. */
  deploymentSecret(nodePoolId: string): Promise<readonly string[]>;
  releaseUnchanged(image: string): Promise<void>;
  releaseRefused(): Promise<void>;
  /** Parent Job from the API image submits the child through the same API; both complete; child → parent teardown. */
  recursion(apiImage: string): Promise<HostedRecursionRecord>;
  terminate(id: string, kind: 'Service' | 'Job'): Promise<void>;
  deleteNodePool(id: string): Promise<void>;
  /**
   * Runs each cleanup still owed through the hosted API, before
   * `cluster delete` removes the API.
   */
  settleCleanups(): Promise<void>;
  captureDiagnostics(): Promise<void>;
}

export type HostedStageDependency =
  | {
      readonly stage: HostedStage;
      /** Digest-pinned `b` image of this tree, the first real image change. */
      readonly alternateImage: string;
      /** The recursive VM Job pair runs (an AWS pool only). */
      readonly recursion: boolean;
    }
  | { readonly stage: HostedStage; readonly gpuPool: true }
  /** The default journey: one pool and a Service through the hosted API. */
  | { readonly stage: HostedStage; readonly pool: true };

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
  prepare(): Promise<void>;
  /** Adds a node pool the hosted API created to the run's record and sweep. */
  recordNodePool(nodePoolId: string): void;
  /** Pending or running instances tagged for the node pool. */
  poolInstances(nodePoolId: string): Promise<readonly string[]>;
  /** Whether a Node of the pool has another join revision than this tree's. */
  poolNodesOutdated(nodePoolId: string): Promise<boolean>;
  /** A spot pool's VMs are deleted on eviction; a no-op on demand. */
  proveSpotEviction(nodePoolId: string): Promise<void>;
  /** Terminate the node pool's one running instance natively; returns its id. */
  terminatePoolInstance(
    nodePoolId: string,
    expectedCount?: number,
  ): Promise<string>;
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
   * `cluster delete`: keeps the managed checkpoint bucket after a final
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
  /** `cluster delete` while the hosted API still manages a pool: the refusal text. */
  destroyRefused(): Promise<string>;
  /** Installer-side record of every node pool of the run, for a failure before cleanup. */
  captureNodePoolDiagnostics(): Promise<void>;
  /** The node pool namespace's Secrets holding a SAS signature or account key. */
  poolSecretsWithCredential(nodePoolId: string): Promise<readonly string[]>;
  /** Deletes the node pool's Pod with this UID: a lost replica. */
  deletePoolPod(nodePoolId: string, podUid: string): Promise<void>;
  /** The Pod's and its Node's start, and the Node's VM launch. */
  poolColdStart(
    nodePoolId: string,
    podUid: string,
  ): Promise<PoolColdStartTimes>;
  /** The hosted API's and Traefik's Pod logs, for a failure before cleanup. */
  captureHostedApiLogs(): Promise<void>;
  sweep(): Promise<ClusterCloudNativeLeftovers>;
}

/** The management VM's cloud: the contract's qualification target. */
export type ClusterCloudTarget = 'aws' | 'gcp' | 'azure';

/**
 * RFC 0049 C28: the default journey's delete keeps the managed bucket after a
 * final backup; the hosted and GPU journeys delete it with `--delete-buckets`.
 */
export type KeptBucketRecord =
  | {
      readonly name: string;
      readonly kept: true;
      /** `cluster delete` took a final backup before releasing the VM. */
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
    /** Present when the run drove the default journey. */
    readonly pool?: HostedPoolStageRecord;
    /** Present when the default journey deleted with its API gone. */
    readonly deadApiDelete?: DeadApiDeleteRecord;
    readonly sweep: ClusterCloudNativeLeftovers;
    /** Present when the run drove the hosted-API stage. */
    readonly hosted?: HostedStageRecord;
    /** Present when the run drove the GPU pool journey. */
    readonly gpu?: HostedGpuStageRecord;
  };
}

/** The default journey: a pool and a Service through the hosted API, then their deletion. */
export interface HostedPoolStageRecord {
  readonly nodePoolId: string;
  readonly serviceId: string;
  /** `cluster delete` while the pool exists: the refusal text. */
  readonly destroyRefusal: string;
}

export interface ClusterCloudContractPolicy {
  readonly gpuReplicas?: 1 | 2;
  readonly gpuWorkload?: 'mace' | 'voice';
  /** Why the GPU journey skips its scale stage (GCP's one-GPU quota). */
  readonly gpuScaleSkipped?: string;
  readonly bootstrapTimeoutMs: number;
  readonly destroyTimeoutMs: number;
  readonly nodePoolTimeoutMs: number;
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
  /** `live_checks`: run on a hosted journey's pool. */
  readonly checks?: {
    readonly selected: readonly PoolCheck[];
    /** `fromRelease` has RFC 0049 C11, C12 and C22, which `cpu-cold-start` checks. */
    readonly releaseFeatures?: boolean;
    readonly run: Pick<
      PoolChecks,
      | 'agentRestart'
      | 'startEntryHandoff'
      | 'startJobThroughUpgrade'
      | 'cpuDefaults'
      | 'cpuColdStart'
      | 'poolGpuProbe'
      | 'userNamespace'
    >;
    /** The role-connection checks (RFC 0047 S14 to S17), when selected. */
    readonly roles?: Pick<
      RoleConnectionChecks,
      'roleConnections' | 'trustPinning' | 'keyRotation' | 'storageTokens'
    >;
  };
  readonly wait: Pick<Waiter, 'for'>;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Cluster contract: ${message}`);
}

/**
 * The one combined live run of the cluster path: this tree's CLI bootstraps
 * a cluster on a management VM, one node pool joins it through the hosted
 * API and the production join path, a Service runs on it, the product tears
 * everything down, and a native sweep proves nothing tagged for the run
 * remains. The hosted stage also proves
 * recursive Jobs and the hosted API release lifecycle.
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
    await d.substrate.prepare();

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
      'gpuPool' in d.hosted
        ? { gpu: await this.#gpuStage(d.hosted.stage) }
        : 'pool' in d.hosted
          ? { pool: await this.#poolStage(d.hosted.stage) }
          : { hosted: await this.#hostedStage(d.hosted, cluster.apiImage) };
    await d.hosted.stage.settleCleanups();
    const serviceAccountIssuer =
      issuerAfterBootstrap ?? (await this.#serviceAccountIssuer(cluster.id));
    // The default journey keeps the bucket; the others delete it with it.
    const deadApi =
      d.policy.deadApiDelete === true && 'pool' in d.hosted
        ? await d.substrate.destroyWithoutApi(d.policy.destroyTimeoutMs)
        : undefined;
    const deleteBuckets = deadApi !== undefined || !('pool' in d.hosted);
    if (!deadApi) {
      const destroyed = await d.substrate.destroy(
        d.policy.destroyTimeoutMs,
        deleteBuckets,
      );
      invariant(
        destroyed.state === 'terminated' && !destroyed.releasing,
        'cluster delete did not finish',
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

  /**
   * The default journey: the operator walk, one node pool through the hosted
   * API, a Service on it, the destroy refusal while the pool exists, then
   * the Service and the pool deleted through the product.
   */
  async #poolStage(hosted: HostedStage): Promise<HostedPoolStageRecord> {
    const d = this.#dependencies;
    try {
      const { nodePoolId } = await this.#poolAcrossUpgrade(hosted);
      await this.#poolChecks(nodePoolId, hosted);
      const serviceId = await hosted.runService(nodePoolId);
      await hosted.terminate(serviceId, 'Service');
      const destroyRefusal = await d.substrate.destroyRefused();
      await hosted.deleteNodePool(nodePoolId);
      return { nodePoolId, serviceId, destroyRefusal };
    } catch (error) {
      await hosted.captureDiagnostics();
      await d.substrate.captureNodePoolDiagnostics();
      throw error;
    }
  }

  /**
   * The hosted-API stage: the operator walk, a pool, a Service and Jobs on
   * the pool through the hosted API's own ServiceAccount, the self-update both ways (`b` then `a`,
   * a real image change each), the unchanged and refused cases, and teardown
   * through the product with the destroy refusal asserted while the pool
   * still exists.
   */
  async #hostedStage(
    {
      stage: hosted,
      alternateImage,
      recursion: runsRecursion,
    }: Extract<HostedStageDependency, { alternateImage: string }>,
    bootstrapImage: string,
  ): Promise<HostedStageRecord> {
    const d = this.#dependencies;
    try {
      // From a published release the walk ends on this tree's `a`.
      const { fromRelease, nodePoolId, replacedOnUpgrade } =
        await this.#poolAcrossUpgrade(hosted);
      await this.#poolChecks(nodePoolId, hosted);
      const imageA = fromRelease?.image ?? bootstrapImage;
      const serviceId = await hosted.runService(nodePoolId);
      // RFC 0043 S17 on S3 or GCS, or S20 across backends on a Lambda pool:
      // the bucketed Job takes the GPU beside the Service's before the
      // receiver's Deployment does.
      const storage = await hosted.poolJobStorage(
        nodePoolId,
        () => d.substrate.poolSecretsWithCredential(nodePoolId),
        (podUid) => d.substrate.deletePoolPod(nodePoolId, podUid),
      );
      const poolJobs = await hosted.poolJobs(nodePoolId, true);
      // Image `b` first (a real change from the bootstrap image `a`), then
      // back to `a` explicitly — both built from this tree, so `api upgrade`
      // without `--image` would report "already matches" (design §5.3).
      // The receiver loops `next_job()` through `b`'s restart.
      const toB = await hosted.releaseUnderLoad(alternateImage);
      await hosted.stateSurvives(serviceId);
      const deploymentSecretPods = await hosted.deploymentSecret(nodePoolId);
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
      const recursion = runsRecursion ? await hosted.recursion(imageA) : null;
      const scale = await this.#scaleStep(hosted, nodePoolId, serviceId);
      await this.#keyRotationCheck();
      await hosted.terminate(serviceId, 'Service');
      // Destroy is refused while the hosted API still manages a pool.
      const destroyRefusal = await d.substrate.destroyRefused();
      await hosted.deleteNodePool(nodePoolId);
      return {
        nodePoolId,
        serviceId,
        poolJobs,
        replacedOnUpgrade,
        storage,
        deploymentSecretPods,
        recursion,
        releases: [...(fromRelease ? [fromRelease] : []), toB, toA],
        destroyRefusal,
        scale,
      };
    } catch (error) {
      // The stage reads its workloads and pool through the hosted API;
      // the substrate captures each recorded pool's status and the clusters.
      await hosted.captureDiagnostics();
      await d.substrate.captureNodePoolDiagnostics();
      throw error;
    }
  }

  /**
   * The GPU pool journey through the hosted API. The pool is ready only once
   * its Node advertises the catalog's nvidia.com/gpu count (the device plugin
   * registered it); a Service serves the `nvidia-smi -L` list through its URL
   * and is terminated (it holds the Node's one GPU); the receiver's Jobs run
   * after `nvidia-smi -L` lists the device; then the pool's instance is
   * terminated natively while a session runs on it; that session is retried
   * onto the replacement and completes there, and the kept Deployment runs
   * one more Job on it.
   */
  async #gpuStage(hosted: HostedStage): Promise<HostedGpuStageRecord> {
    const d = this.#dependencies;
    try {
      // The receiver (for voice, a large build) is built while the GPU pool boots.
      void hosted.prepareReceiverImage();
      const { nodePoolId, replacedOnUpgrade } =
        await this.#poolAcrossUpgrade(hosted);
      await this.#poolChecks(nodePoolId, hosted);
      const serviceId = await hosted.runService(nodePoolId);
      const devices = await hosted.gpuServiceDevices(serviceId);
      await hosted.terminate(serviceId, 'Service');
      // Before the receiver, which keeps every GPU for host loss; the
      // bucketed Job's managed Deployment scales to zero once it completes.
      const storage = await hosted.poolJobStorage(
        nodePoolId,
        () => d.substrate.poolSecretsWithCredential(nodePoolId),
        (podUid) => d.substrate.deletePoolPod(nodePoolId, podUid),
      );
      const poolJobs = await hosted.poolJobs(nodePoolId, true);
      const replicas = d.policy.gpuReplicas ?? 1;
      // The marks come from the Deployment's newest Pod: with one replica,
      // the Pod whose Node and times are read.
      const coldStart = async (podUid: string, podWaitedForNode: boolean) =>
        coldStartRecord(
          d.policy.gpuWorkload ?? 'mace',
          podUid,
          await d.substrate.poolColdStart(nodePoolId, podUid),
          await hosted.receiverMarks(),
          podWaitedForNode,
        );
      // The first Pod came after the Service and storage stages; the
      // replacement's waited for its Node.
      const first =
        replicas === 1 ? await coldStart(poolJobs.podUid, false) : undefined;
      let replacement: GpuColdStartRecord | undefined;
      const beforeInstances =
        replicas === 2 ? await d.substrate.poolInstances(nodePoolId) : [];
      let sessionId: string | undefined;
      if (replicas === 2) {
        if (!hosted.startReplicaLossSessions)
          throw new Error('two replicas require session-loss qualification');
        await hosted.startReplicaLossSessions();
      } else {
        // A session runs on the one replica when its VM goes.
        sessionId = await hosted.startReplicaLossSession();
      }
      const terminatedInstance =
        replicas === 2
          ? await d.substrate.terminatePoolInstance(nodePoolId, 2)
          : await d.substrate.terminatePoolInstance(nodePoolId);
      d.progress.mark(
        `gpu pool ${nodePoolId}: terminated ${terminatedInstance}`,
      );
      const replacementInstances = await d.wait.for(
        `node pool ${nodePoolId} replacement instance`,
        () => d.substrate.poolInstances(nodePoolId),
        {
          timeoutMs: d.policy.nodePoolTimeoutMs,
          intervalMs: 10_000,
          probeError: 'fail',
          unmet: (ids) =>
            ids.length === replicas && !ids.includes(terminatedInstance)
              ? undefined
              : `instances ${ids.join(', ') || 'none'}`,
        },
      );
      const replacementInstance = replacementInstances.find(
        (id) => !beforeInstances.includes(id),
      )!;
      const afterLoss = await hosted.poolJobAfterHostLoss(
        nodePoolId,
        poolJobs.podUid,
        sessionId,
        async (podUid) => {
          if (first) replacement = await coldStart(podUid, true);
        },
      );
      const skipped = d.policy.gpuScaleSkipped;
      if (skipped)
        d.progress.mark(`gpu pool ${nodePoolId}: no scale stage: ${skipped}`);
      // The first Service is gone (it held a GPU); the step runs its own.
      const scale = skipped ? null : await this.#scaleStep(hosted, nodePoolId);
      await hosted.deleteNodePool(nodePoolId);
      return {
        nodePoolId,
        service: { id: serviceId, devices },
        poolJobs,
        replacedOnUpgrade,
        storage,
        hostLoss: { terminatedInstance, replacementInstance, ...afterLoss },
        scale,
        ...(skipped ? { scaleSkipped: skipped } : {}),
        ...(first ? { coldStart: { first, replacement: replacement! } } : {}),
      };
    } catch (error) {
      // The journey reads its workloads and pool through the hosted API;
      // the substrate captures each recorded pool's status and the clusters.
      await hosted.captureDiagnostics();
      await d.substrate.captureNodePoolDiagnostics();
      throw error;
    }
  }

  /**
   * RFC 0048's scale stage on the journey's pool through the hosted API.
   * Natively, no more instances than the burst needs launched (S2), and
   * scale-in kept exactly the instances from before it: on Lambda the
   * receiver's busy Node, never an idle burst Node in its place.
   */
  async #scaleStep(
    hosted: HostedStage,
    nodePoolId: string,
    serviceId?: string,
  ): Promise<HostedScaleRecord | null> {
    const d = this.#dependencies;
    const before = await d.substrate.poolInstances(nodePoolId);
    const launched = new Set(before);
    const observe = async () => {
      const ids = await d.substrate.poolInstances(nodePoolId);
      for (const id of ids) launched.add(id);
      return ids;
    };
    const scale = await hosted.scalePool(nodePoolId, serviceId, observe);
    if (!scale) return null;
    const same = (ids: readonly string[]) =>
      ids.length === before.length && ids.every((id) => before.includes(id));
    const kept = await d.wait.for(
      `node pool ${nodePoolId} back to its instances from before the burst`,
      observe,
      {
        timeoutMs: d.policy.nodePoolTimeoutMs,
        intervalMs: 10_000,
        probeError: 'fail',
        unmet: (ids) =>
          same(ids) ? undefined : `instances ${ids.join(', ') || 'none'}`,
        reject: (ids) =>
          ids.length <= before.length && !same(ids)
            ? `scale-in kept ${ids.join(', ') || 'none'}, not ${before.join(', ')}`
            : undefined,
      },
    );
    invariant(
      launched.size <= before.length + scale.burstVms,
      `node pool ${nodePoolId} launched ${String(launched.size - before.length)} instances for a burst of ${String(scale.burstVms)}: ${[...launched].join(', ')}`,
    );
    return { ...scale, before, launched: [...launched], kept };
  }

  /**
   * The selected `live_checks` on the journey's pool once it runs this
   * tree's join (after any upgrade), before the journey's own workloads take
   * its Nodes: the agent restart, the GPU probe, then the CPU defaults and
   * cold starts, which use pools of their own.
   */
  async #poolChecks(nodePoolId: string, hosted: HostedStage): Promise<void> {
    const checks = this.#dependencies.checks;
    if (!checks) return;
    const { selected, run } = checks;
    // Needs no pool: the hosted API and the runner's cloud CLIs.
    if (selected.includes('role-apply')) await hosted.roleApply();
    if (selected.includes('agent-restart')) await run.agentRestart(nodePoolId);
    if (selected.includes('pool-gpu-probe')) await run.poolGpuProbe(nodePoolId);
    if (selected.includes('cpu-defaults')) await run.cpuDefaults();
    if (selected.includes('user-namespace')) await run.userNamespace();
    if (selected.includes('role-connections'))
      await this.#roles().roleConnections(nodePoolId);
    if (selected.includes('role-trust-pinning'))
      await this.#roles().trustPinning();
    if (selected.includes('role-storage-tokens'))
      await this.#roles().storageTokens();
    // With `fromRelease` it ran on the release, before the upgrade.
    if (selected.includes('cpu-cold-start') && !this.#dependencies.fromRelease)
      await run.cpuColdStart(true);
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

  /**
   * The operator walk and the journey's pool. With `fromRelease` the pool is
   * created before the walk's upgrade, so its Nodes join with the release's
   * script, and the upgraded API must replace each of its instances
   * before the journey runs on them. The sweeps read a GCP, Azure or Lambda
   * pool's own cloud by its id.
   */
  async #poolAcrossUpgrade(hosted: HostedStage) {
    const d = this.#dependencies;
    let nodePoolId = '';
    let before: readonly string[] = [];
    let outdated = false;
    // The entry-handoff check: a pool Service under requests through the replacements.
    let handoff: EntryHandoff | undefined;
    // RFC 0049 C27's check: a pool Job running through the upgrade.
    let throughUpgrade: { finish(): Promise<unknown> } | undefined;
    const createPool = async () => {
      nodePoolId = await hosted.createReadyNodePool((id) =>
        d.substrate.recordNodePool(id),
      );
      await d.substrate.proveSpotEviction(nodePoolId);
    };
    try {
      const fromRelease = await hosted.operatorWalk(
        d.fromRelease
          ? async () => {
              await createPool();
              before = await d.substrate.poolInstances(nodePoolId);
              // The upgraded API replaces only Nodes of another join
              // revision: 0.1.71's is this tree's (run 41815994695).
              outdated = await d.substrate.poolNodesOutdated(nodePoolId);
              // The cold-start record of the release itself.
              if (d.checks?.selected.includes('cpu-cold-start')) {
                await d.checks.run.cpuColdStart(
                  d.checks.releaseFeatures ?? false,
                );
              }
              if (d.checks?.selected.includes('pool-job-upgrade')) {
                throughUpgrade = await d.checks.run.startJobThroughUpgrade(
                  nodePoolId,
                  d.fromRelease!,
                );
              }
              if (d.checks?.selected.includes('entry-handoff')) {
                handoff = await d.checks.run.startEntryHandoff(
                  await hosted.runService(nodePoolId, 'handoff'),
                );
              }
            }
          : undefined,
      );
      if (!fromRelease) {
        await createPool();
        return { fromRelease, nodePoolId, replacedOnUpgrade: [] };
      }
      // The Node it runs on is replaced only once it ends.
      await throughUpgrade?.finish();
      if (!outdated) {
        d.progress.mark(
          `node pool ${nodePoolId}: ${d.fromRelease}'s Nodes have this tree's join revision; none is replaced`,
        );
        if (handoff) {
          throw new Error(
            `entry-handoff needs Node replacements, and ${d.fromRelease}'s Nodes have this tree's join revision; choose an older from_release`,
          );
        }
        return { fromRelease, nodePoolId, replacedOnUpgrade: [] };
      }
      await d.wait.for(
        `node pool ${nodePoolId}'s instances from ${d.fromRelease} replaced`,
        async () => {
          await handoff?.observe();
          return d.substrate.poolInstances(nodePoolId);
        },
        {
          // One at a time, each a fresh join beside the old Node (a spare
          // while it drains) and then its removal.
          timeoutMs: before.length * d.policy.nodePoolTimeoutMs,
          intervalMs: 10_000,
          // The hand-off's hosted status read can stall with the hosted API
          // for a few seconds (run 40934365017); the next read retries it.
          probeError: retryTransientProbeError,
          unmet: (ids) =>
            ids.length === before.length &&
            !ids.some((id) => before.includes(id))
              ? undefined
              : `instances ${ids.join(', ') || 'none'}`,
        },
      );
      if (handoff) {
        // The old entry's teardown follows its last instance's removal, so
        // requests keep running for a minute (five reads 15 s apart) after it.
        let reads = 0;
        await d.wait.for(
          `entry hand-off ${handoff.serviceId}: a minute after the replacements`,
          async () => {
            await handoff?.observe();
            return (reads += 1);
          },
          {
            timeoutMs: 120_000,
            intervalMs: 15_000,
            probeError: retryTransientProbeError,
            unmet: (n) => (n >= 5 ? undefined : `${String(n)} reads`),
          },
        );
        await handoff.stop();
        // It holds a Node's share (a GPU on a GPU pool) the journey needs.
        await hosted.terminate(handoff.serviceId, 'Service');
      }
      // This tree's API launched the replacements: prove them too.
      await d.substrate.proveSpotEviction(nodePoolId);
      return { fromRelease, nodePoolId, replacedOnUpgrade: before };
    } finally {
      // The request loop never outlives the stage, whatever failed.
      await handoff?.cancel();
    }
  }
}

import { describe, expect, test, vi } from 'vitest';

import {
  ClusterCloudContract,
  type ClusterCloudSubstrate,
  type HostedReleaseRecord,
  type HostedStage,
  type LiveCluster,
} from '../integration/e2e/internal/contracts/cluster-cloud.js';
import {
  EntryHandoff,
  type PoolChecksPort,
} from '../integration/e2e/internal/contracts/pool-checks.js';
import type { Waiter } from '../integration/e2e/internal/wait.js';

const IMAGE = `ghcr.io/anycloud-sh/api:0.0.3@sha256:${'a'.repeat(64)}`;
const EMPTY_SWEEP = {
  instances: [],
  securityGroups: [],
  volumes: [],
  buckets: [],
  installation: [],
  dnsRecords: [],
  dnsDeferred: false,
};

/**
 * Probes until met, at most five times, without sleeping; a probe error its
 * policy retries counts as a poll.
 */
const wait: Pick<Waiter, 'for'> = {
  for: async (label, probe, options) => {
    for (let poll = 0; poll < 5; poll += 1) {
      let value;
      try {
        value = await probe(Date.now() + options.timeoutMs);
      } catch (error) {
        if (options.probeError === 'fail' || !options.probeError.retry(error))
          throw error;
        continue;
      }
      const rejection = options.reject?.(value);
      if (rejection) throw new Error(`${label}: ${rejection}`);
      if (options.unmet(value) === undefined) return value;
    }
    throw new Error(`${label}: timed out`);
  },
};

/** A Node and Pod 1 s apart at each native point (Lambda's no-launch-time aside). */
const COLD_START_TIMES = {
  node: 'node-a',
  vmLaunchedAtMs: 1_000,
  nodeCreatedAtMs: 61_000,
  nodeReadyAtMs: 62_000,
  gpuPluginStartedAtMs: 63_000,
  podScheduledAtMs: 64_000,
  imagePull: null,
  runnerImagePull: null,
  containerStartedAtMs: 124_000,
};
const MACE_MARKS = {
  process_start: 125_000,
  torch_imported: 128_000,
  calculator_ready: 131_000,
  warm_inference_done: 132_000,
  work_loaded: 132_500,
  first_claim: 140_000,
};

/**
 * The GPU pool journey against fakes; `instances` answers each native read in
 * turn. With `release`, the release journey on a pool where `recursion` says
 * whether the VM Job pair runs. With `fromRelease`, the walk's upgrade is
 * from that release.
 */
function gpuContract(
  instances: string[][],
  gpuReplicas?: 1 | 2,
  /** The release journey, or `pool` for the default one; the GPU journey otherwise. */
  release?: { readonly recursion: boolean } | 'pool',
  fromRelease?: string,
  /** The scale stage's burst; without it the pool is fixed-size. */
  burstVms?: number,
  /** `live_checks` and their runner. */
  checks?: NonNullable<
    ConstructorParameters<typeof ClusterCloudContract>[0]['checks']
  >,
  /** The receiver's marks; the MACE profile's by default. */
  marks: Record<string, number> = MACE_MARKS,
  gpuScaleSkipped?: string,
) {
  const order: string[] = [];
  const poolNodes = { outdated: true };
  const issuer = {
    issuer: 'https://cluster-1.anycloud.sh',
    jwksUri: 'https://cluster-1.anycloud.sh/openid/v1/jwks',
    keyIds: ['k1'],
  };
  let cluster: LiveCluster = {
    id: 'cluster-1',
    connected: true,
    kubernetesIdentity: 'kube-1',
    apiVersion: fromRelease ?? '0.0.3',
    apiImage: fromRelease ? IMAGE.replace('0.0.3', fromRelease) : IMAGE,
    managementApiUrl: 'https://cluster-1.anycloud.sh',
    state: 'running',
  };
  const step =
    <T>(name: string, value: T) =>
    async () => {
      order.push(name);
      return value;
    };
  const substrate = {
    clusterProvider: 'aws' as const,
    prepare: step('prepare', undefined),
    bootstrap: async () => cluster,
    clusters: async () => [cluster],
    hostedVersion: step('hostedVersion', fromRelease ?? '0.0.3'),
    serviceAccountIssuer: async () => {
      order.push('serviceAccountIssuer');
      return issuer;
    },
    backupObjectVersions: step('backups', 1),
    recordNodePool: (id: string) => {
      order.push(`record ${id}`);
    },
    poolInstances: async () => {
      order.push('poolInstances');
      return instances.shift() ?? [];
    },
    // An older join revision unless a test says otherwise.
    poolNodesOutdated: async () => poolNodes.outdated,
    proveSpotEviction: step('proveSpotEviction', undefined),
    terminatePoolInstance: step('terminatePoolInstance', 'i-old'),
    destroyRefused: step('destroyRefused', 'refused'),
    destroy: async (_timeoutMs: number, deleteBuckets?: boolean) => {
      order.push(deleteBuckets ? 'destroy --delete-buckets' : 'destroy');
      cluster = { ...cluster, state: 'terminated' };
      return cluster;
    },
    keptBucket: step('keptBucket', {
      name: 'c-1',
      kept: true as const,
      finalBackup: 'taken',
    }),
    bucketDeleted: step('bucketDeleted', { name: 'c-1', kept: false as const }),
    captureNodePoolDiagnostics: step('substrateDiagnostics', undefined),
    poolColdStart: async (_id: string, podUid: string) => {
      order.push(`poolColdStart ${podUid}`);
      return COLD_START_TIMES;
    },
    captureHostedApiLogs: step('hostedApiLogs', undefined),
    sweep: step('sweep', EMPTY_SWEEP),
  } satisfies Partial<ClusterCloudSubstrate>;
  const hosted = {
    operatorWalk: async (beforeUpgrade?: () => Promise<void>) => {
      order.push('operatorWalk');
      await beforeUpgrade?.();
      if (!fromRelease) return undefined;
      order.push('upgrade');
      return released as HostedReleaseRecord;
    },
    prepareReceiverImage: step('prepareReceiverImage', 'receiver@sha256:c'),
    // The pool is recorded at create, before its ready wait ends.
    createReadyNodePool: async (onCreated: (id: string) => void) => {
      onCreated('np-1');
      order.push('createReadyNodePool');
      return 'np-1';
    },
    runService: step('runService', 'svc-1'),
    scalePool: step(
      'scalePool',
      burstVms
        ? {
            minVms: 1,
            maxVms: 3,
            burstVms,
            jobIds: [],
            longJobId: '',
            scaleOuts: [],
          }
        : null,
    ),
    gpuServiceDevices: step('gpuServiceDevices', ['GPU 0: Tesla T4']),
    terminate: step('terminate', undefined),
    poolJobs: vi.fn(async (_id: string, keep?: boolean) => {
      order.push(`poolJobs keep=${String(keep)}`);
      return {
        deploymentId: 'dep-1',
        podUid: 'pod-1',
        egress: { nameservers: ['10.0.0.2'], metadataError: 'timeout' },
        completedJobId: 'job-complete',
        claimMs: 400,
        cancelledJobId: 'job-hold',
      };
    }),
    poolJobStorage: vi.fn(step('poolJobStorage', null)),
    startReplicaLossSession: step('startReplicaLossSession', 'job-session'),
    startReplicaLossSessions: step('startReplicaLossSessions', undefined),
    receiverMarks: step('receiverMarks', marks),
    poolJobAfterHostLoss: vi.fn(
      async (
        _id: string,
        _pod: string,
        _session?: string,
        beforeDelete?: (podUid: string) => Promise<void>,
      ) => {
        order.push('poolJobAfterHostLoss');
        await beforeDelete?.('pod-2');
        return {
          podUid: 'pod-2',
          jobId: 'job-after-loss-complete',
          session: {
            jobId: 'job-session',
            retryReason:
              'replica DeletionByPodGC: PodGC: node no longer exists',
          },
        };
      },
    ),
    deleteNodePool: step('deleteNodePool', undefined),
    settleCleanups: step('settleCleanups', undefined),
    captureDiagnostics: step('hostedDiagnostics', undefined),
  } satisfies Partial<HostedStage>;
  const released = {
    servedAfter: { version: '0.0.3', schemaVersion: '0.0.3' },
  };
  // The release journey's steps; their records only pass through.
  const releaseSteps = {
    releaseUnderLoad: step('releaseUnderLoad', released),
    stateSurvives: step('stateSurvives', undefined),
    deploymentSecret: step('deploymentSecret', []),
    release: step('release', released),
    releaseUnchanged: step('releaseUnchanged', undefined),
    releaseRefused: step('releaseRefused', undefined),
    recursion: step('recursion', { parentId: 'p', childId: 'c' }),
  };
  const releaseStage = { ...hosted, ...releaseSteps };
  const contract = new ClusterCloudContract({
    cliVersion: '0.0.3',
    ...(fromRelease ? { fromRelease } : {}),
    ...(checks ? { checks } : {}),
    hosted:
      release === 'pool'
        ? { stage: hosted as unknown as HostedStage, pool: true }
        : release
          ? {
              stage: releaseStage as unknown as HostedStage,
              alternateImage: IMAGE,
              recursion: release.recursion,
            }
          : { stage: hosted as unknown as HostedStage, gpuPool: true },
    substrate: substrate as unknown as ClusterCloudSubstrate,
    progress: { mark: () => undefined },
    wait,
    policy: {
      bootstrapTimeoutMs: 1,
      destroyTimeoutMs: 1,
      nodePoolTimeoutMs: 1,
      keepOnFailure: false,
      gpuReplicas,
      ...(gpuScaleSkipped ? { gpuScaleSkipped } : {}),
    },
  });
  return { contract, hosted, order, poolNodes, issuer };
}

describe('e2e-cluster-cloud default journey', () => {
  test('creates the pool and a Service through the hosted API, is refused delete while the pool exists, then deletes both before the cluster', async () => {
    const { contract, order } = gpuContract([], undefined, 'pool');
    const { records } = await contract.run();
    expect(records.pool).toEqual({
      nodePoolId: 'np-1',
      serviceId: 'svc-1',
      destroyRefusal: 'refused',
    });
    const at = (step: string) => order.indexOf(step);
    expect(at('operatorWalk')).toBeLessThan(at('createReadyNodePool'));
    expect(at('record np-1')).toBeLessThan(at('createReadyNodePool'));
    expect(at('createReadyNodePool')).toBeLessThan(at('proveSpotEviction'));
    expect(at('proveSpotEviction')).toBeLessThan(at('runService'));
    expect(at('runService')).toBeLessThan(at('terminate'));
    expect(at('terminate')).toBeLessThan(at('destroyRefused'));
    expect(at('destroyRefused')).toBeLessThan(at('deleteNodePool'));
    expect(at('deleteNodePool')).toBeLessThan(at('destroy'));
    // The default journey keeps the bucket, after a final backup.
    expect(order.slice(at('destroy'), at('destroy') + 2)).toEqual([
      'destroy',
      'keptBucket',
    ]);
    // The journey owns no GPU, release or Job step.
    for (const step of [
      'poolJobStorage',
      'releaseUnderLoad',
      'gpuServiceDevices',
    ])
      expect(order).not.toContain(step);
  });
});

describe('e2e-cluster-cloud release journey', () => {
  test('records the hosted pool for the sweeps and runs the recursive pair on an AWS pool only', async () => {
    for (const recursion of [true, false]) {
      const { contract, order } = gpuContract([], undefined, { recursion });
      const { records } = await contract.run();
      expect(order.indexOf('record np-1')).toBeLessThan(
        order.indexOf('createReadyNodePool'),
      );
      expect(order.includes('recursion')).toBe(recursion);
      // Run 40934349682: owed hosted-API cleanups run before the API goes.
      expect(order.indexOf('destroy --delete-buckets')).toBe(
        order.indexOf('settleCleanups') + 1,
      );
      expect(records.hosted?.recursion).toEqual(
        recursion ? { parentId: 'p', childId: 'c' } : null,
      );
    }
  });

  test('0043/S14 runs the bucketed Job beside the Service, before the receiver takes the other GPU', async () => {
    const { contract, hosted, order } = gpuContract([], undefined, {
      recursion: false,
    });
    const { records } = await contract.run();
    expect(order.indexOf('poolJobStorage')).toBe(
      order.indexOf('runService') + 1,
    );
    expect(order.indexOf('poolJobs keep=true')).toBe(
      order.indexOf('poolJobStorage') + 1,
    );
    expect(hosted.poolJobStorage).toHaveBeenCalledWith(
      'np-1',
      expect.any(Function),
      expect.any(Function),
    );
    expect(records.hosted?.storage).toBeNull();
  });
});

describe('e2e-cluster-cloud GPU pool journey', () => {
  test('serves the GPU list from a Service and ends it before the Jobs, keeps the Deployment across host loss, waits for a different instance, then tears down and sweeps', async () => {
    const { contract, hosted, order } = gpuContract([['i-old'], [], ['i-new']]);
    const result = await contract.run();
    expect(result.records.gpu).toEqual({
      nodePoolId: 'np-1',
      service: { id: 'svc-1', devices: ['GPU 0: Tesla T4'] },
      poolJobs: expect.objectContaining({ podUid: 'pod-1' }),
      replacedOnUpgrade: [],
      storage: null,
      hostLoss: {
        terminatedInstance: 'i-old',
        replacementInstance: 'i-new',
        podUid: 'pod-2',
        jobId: 'job-after-loss-complete',
        session: {
          jobId: 'job-session',
          retryReason: 'replica DeletionByPodGC: PodGC: node no longer exists',
        },
      },
      scale: null,
      coldStart: {
        first: expect.objectContaining({ podUid: 'pod-1' }),
        replacement: expect.objectContaining({ podUid: 'pod-2' }),
      },
    });
    // The replacement's Pod waited for its Node: each stage between
    // consecutive known points, and the whole span.
    const durations = {
      total: 139_000,
      'vm_launched->node_created': 60_000,
      'node_created->node_ready': 1_000,
      'node_ready->gpu_plugin_started': 1_000,
      'gpu_plugin_started->pod_scheduled': 1_000,
      'pod_scheduled->container_started': 60_000,
      'container_started->process_start': 1_000,
      'process_start->torch_imported': 3_000,
      'torch_imported->calculator_ready': 3_000,
      'calculator_ready->warm_inference_done': 1_000,
      'warm_inference_done->work_loaded': 500,
      'work_loaded->first_claim': 7_500,
    };
    const { coldStart } = result.records.gpu!;
    expect(coldStart?.replacement.durationsMs).toEqual(durations);
    // The first Pod came after the journey's own stages.
    const {
      total: _total,
      'gpu_plugin_started->pod_scheduled': _scheduled,
      ...firstDurations
    } = durations;
    expect(coldStart?.first.durationsMs).toEqual(firstDurations);
    expect(result.records.hosted).toBeUndefined();
    expect(hosted.poolJobAfterHostLoss).toHaveBeenCalledWith(
      'np-1',
      'pod-1',
      'job-session',
      expect.any(Function),
    );
    expect(order.slice(order.indexOf('prepareReceiverImage'))).toEqual([
      // The receiver builds while the GPU pool boots.
      'prepareReceiverImage',
      'operatorWalk',
      'record np-1',
      'createReadyNodePool',
      // Every journey's ready pool proves its spot VMs deleted on eviction.
      'proveSpotEviction',
      'runService',
      'gpuServiceDevices',
      'terminate',
      // The bucketed Job takes a GPU before the receiver keeps them all.
      'poolJobStorage',
      'poolJobs keep=true',
      'poolColdStart pod-1',
      'receiverMarks',
      // The session runs on the replica when its VM goes.
      'startReplicaLossSession',
      'terminatePoolInstance',
      'poolInstances',
      'poolInstances',
      'poolInstances',
      'poolJobAfterHostLoss',
      // The replacement is read before the Deployment is deleted.
      'poolColdStart pod-2',
      'receiverMarks',
      'poolInstances',
      'scalePool',
      'deleteNodePool',
      // The hosted API's owed cleanups run while it still exists.
      'settleCleanups',
      // The GPU journey deletes the bucket with the cluster.
      'destroy --delete-buckets',
      'bucketDeleted',
      'sweep',
      'sweep',
    ]);
  });

  test('with two replicas it holds a session on each and starts no one-replica session', async () => {
    const { contract, hosted, order } = gpuContract(
      // Two VMs that still include the terminated one are not a replacement.
      [
        ['i-old', 'i-b'],
        ['i-old', 'i-b'],
        ['i-b', 'i-new'],
      ],
      2,
    );
    const result = await contract.run();
    expect(result.records.gpu?.hostLoss).toMatchObject({
      terminatedInstance: 'i-old',
      replacementInstance: 'i-new',
    });
    expect(order).toContain('startReplicaLossSessions');
    expect(order).not.toContain('startReplicaLossSession');
    // The newest Pod's log could be either replica's: no cold-start record.
    expect(order).not.toContain('receiverMarks');
    expect(result.records.gpu?.coldStart).toBeUndefined();
    expect(hosted.poolJobAfterHostLoss).toHaveBeenCalledWith(
      'np-1',
      'pod-1',
      undefined,
      expect.any(Function),
    );
  });

  test('fails when the receiver did not log a mark its workload makes', async () => {
    const { contract } = gpuContract(
      [['i-old'], [], ['i-new']],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      Object.fromEntries(
        Object.entries(MACE_MARKS).filter(
          ([name]) => name !== 'calculator_ready',
        ),
      ),
    );
    await expect(contract.run()).rejects.toThrow(
      'the mace receiver on Pod pod-1 logged no calculator_ready mark',
    );
  });

  test('a GCP GPU pool skips the scale stage, which would need a second GPU, and records why', async () => {
    const { contract, order } = gpuContract(
      [['i-old'], [], ['i-new']],
      undefined,
      undefined,
      undefined,
      1,
      undefined,
      MACE_MARKS,
      'the burst needs a second GPU; the GCP project allows 1',
    );
    const { records } = await contract.run();
    expect(order).not.toContain('scalePool');
    expect(records.gpu).toMatchObject({
      scale: null,
      scaleSkipped: 'the burst needs a second GPU; the GCP project allows 1',
    });
  });

  test('from a release, the pool joins before the upgrade and the journey waits until each of its instances is replaced', async () => {
    const { contract, order } = gpuContract(
      [
        ['i-0'],
        // Removed first, then relaunched: neither is the replacement yet.
        ['i-0'],
        [],
        ['i-old'],
        // Host loss
        [],
        ['i-new'],
      ],
      undefined,
      undefined,
      '0.1.70',
    );
    const { records } = await contract.run();
    expect(records.gpu).toMatchObject({
      replacedOnUpgrade: ['i-0'],
      hostLoss: { terminatedInstance: 'i-old', replacementInstance: 'i-new' },
    });
    // The pool joins on the release; its replacement is awaited after the upgrade.
    expect(
      order.slice(
        order.indexOf('prepareReceiverImage'),
        order.indexOf('runService'),
      ),
    ).toEqual([
      'prepareReceiverImage',
      'operatorWalk',
      'record np-1',
      'createReadyNodePool',
      'proveSpotEviction',
      'poolInstances',
      'upgrade',
      'poolInstances',
      'poolInstances',
      'poolInstances',
      // Again on the replacements this tree's API launched.
      'proveSpotEviction',
    ]);
  });

  test("reads the public ServiceAccount issuer after bootstrap, or from a release after the stage's upgrade", async () => {
    const fresh = gpuContract([['i-0'], [], ['i-new']]);
    const { records } = await fresh.contract.run();
    expect(records.installation.serviceAccountIssuer).toEqual(fresh.issuer);
    expect(fresh.order.indexOf('serviceAccountIssuer')).toBe(
      fresh.order.indexOf('backups') + 1,
    );
    expect(
      fresh.order.filter((step) => step === 'serviceAccountIssuer'),
    ).toHaveLength(1);

    const upgraded = gpuContract(
      [['i-0'], ['i-0'], [], ['i-old'], [], ['i-new']],
      undefined,
      undefined,
      '0.1.70',
    );
    await upgraded.contract.run();
    expect(
      upgraded.order.slice(upgraded.order.indexOf('serviceAccountIssuer')),
    ).toEqual([
      'serviceAccountIssuer',
      // The GPU journey deletes the bucket with the cluster.
      'destroy --delete-buckets',
      'bucketDeleted',
      'sweep',
      'sweep',
    ]);
    expect(
      upgraded.order.filter((step) => step === 'serviceAccountIssuer'),
    ).toHaveLength(1);
  });

  test('fails on an issuer other than the public URL, or an empty JWKS', async () => {
    const wrongIssuer = gpuContract([['i-0'], [], ['i-new']]);
    Object.assign(wrongIssuer.issuer, {
      issuer: 'https://kubernetes.default.svc.cluster.local',
    });
    await expect(wrongIssuer.contract.run()).rejects.toThrow(
      "hosted API's ServiceAccount issuer is https://kubernetes.default.svc.cluster.local with JWKS https://cluster-1.anycloud.sh/openid/v1/jwks, expected https://cluster-1.anycloud.sh",
    );
    const noKeys = gpuContract([['i-0'], [], ['i-new']]);
    Object.assign(noKeys.issuer, { keyIds: [] });
    await expect(noKeys.contract.run()).rejects.toThrow(
      "hosted API's ServiceAccount JWKS at https://cluster-1.anycloud.sh/openid/v1/jwks has no keys",
    );
  });

  test("from a release whose Nodes already have this tree's join revision, nothing waits for a replacement", async () => {
    const { contract, order, poolNodes } = gpuContract(
      [['i-0'], ['i-0'], [], ['i-new']],
      undefined,
      undefined,
      '0.1.71',
    );
    poolNodes.outdated = false;
    const { records } = await contract.run();
    expect(records.gpu).toMatchObject({ replacedOnUpgrade: [] });
    expect(
      order.slice(order.indexOf('upgrade'), order.indexOf('runService')),
    ).toEqual(['upgrade']);
  });

  test('from a release, an instance kept across the upgrade fails the journey', async () => {
    const { contract, order } = gpuContract(
      [['i-0'], ['i-0'], ['i-0'], ['i-0'], ['i-0'], ['i-0']],
      undefined,
      undefined,
      '0.1.70',
    );
    await expect(contract.run()).rejects.toThrow(
      "node pool np-1's instances from 0.1.70 replaced: timed out",
    );
    expect(order).not.toContain('runService');
  });

  test.each([
    ['keeps exactly the instances from before the burst', [['i-new']], ''],
    [
      'fails on an idle burst instance kept in place of one from before',
      [['i-burst']],
      'scale-in kept i-burst, not i-new',
    ],
    [
      'fails on more instances launched than the burst needs',
      [['i-new', 'i-burst', 'i-extra'], ['i-new']],
      'launched 2 instances for a burst of 1',
    ],
  ])('0048: scale-in %s', async (_case, after, message) => {
    const { contract } = gpuContract(
      [['i-old'], [], ['i-new'], ['i-new'], ...after],
      undefined,
      undefined,
      undefined,
      1,
    );
    const run = expect(contract.run());
    await (message ? run.rejects.toThrow(message) : run.resolves.toBeDefined());
  });

  test('a replacement that never appears fails the journey with diagnostics, and the sweep still runs', async () => {
    const { contract, order } = gpuContract([['i-old'], ['i-old'], ['i-old']]);
    await expect(contract.run()).rejects.toThrow(
      'node pool np-1 replacement instance',
    );
    expect(order).not.toContain('poolJobAfterHostLoss');
    // The hosted API's Pod logs are kept before the sweep, while it runs.
    expect(order.slice(-4)).toEqual([
      'hostedDiagnostics',
      'substrateDiagnostics',
      'hostedApiLogs',
      'sweep',
    ]);
  });
});

describe('e2e-cluster-cloud live checks', () => {
  const CLEAN_REQUESTS = {
    requests: 400,
    failed: 0,
    longestGapMs: 300,
    failures: {},
  };
  /**
   * Each check's runner, recording its calls; the entry hand-off is the real
   * one over a fake port whose request loop saw `failed` failures while the
   * entry moved from 10.0.0.1 to 10.0.0.2 on its `movesAt`th read. A read
   * `failing` names fails with its error instead.
   */
  function liveChecks(
    order: string[],
    failed = 0,
    movesAt = 2,
    failing: (read: number) => Error | undefined = () => undefined,
  ) {
    const records = new Map<string, unknown>();
    const stopRequests = vi.fn(async () => ({ ...CLEAN_REQUESTS, failed }));
    let reads = 0;
    const port: Pick<PoolChecksPort, 'entryIp' | 'watchRequests' | 'record'> = {
      entryIp: async () => {
        reads += 1;
        const error = failing(reads);
        if (error) throw error;
        return reads >= movesAt ? '10.0.0.2' : '10.0.0.1';
      },
      watchRequests: () => stopRequests,
      record: async (name, value) => {
        records.set(name, value);
      },
    };
    const empty: unknown = {};
    const step = (name: string) => async (id?: string) => {
      order.push(id ? `${name} ${id}` : name);
      return empty as never;
    };
    return {
      records,
      stopRequests,
      checks: {
        selected: ['agent-restart', 'entry-handoff', 'pool-gpu-probe'] as const,
        run: {
          agentRestart: step('agentRestart'),
          poolGpuProbe: step('poolGpuProbe'),
          cpuDefaults: step('cpuDefaults'),
          userNamespace: step('userNamespace'),
          cpuColdStart: async (features: boolean) => {
            order.push(`cpuColdStart ${String(features)}`);
            return empty as never;
          },
          startJobThroughUpgrade: step('startJobThroughUpgrade'),
          startEntryHandoff: async (serviceId: string) => {
            order.push(`startEntryHandoff ${serviceId}`);
            return new EntryHandoff(
              {
                port: port as unknown as PoolChecksPort,
                progress: { mark: () => undefined },
                clock: { now: () => 0 },
                wait,
              },
              serviceId,
              'https://svc-1.anycloud.sh/',
              '10.0.0.1',
            );
          },
        },
      },
    };
  }

  test("the entry hand-off refuses a from_release whose Nodes have this tree's join revision, since nothing hands off", async () => {
    const order: string[] = [];
    const { checks } = liveChecks(order);
    const { contract, poolNodes } = gpuContract(
      [['i-old'], ['i-old']],
      undefined,
      undefined,
      '0.1.71',
      undefined,
      checks,
    );
    poolNodes.outdated = false;
    await expect(contract.run()).rejects.toThrow(
      /entry-handoff needs Node replacements/u,
    );
  });

  test('the entry hand-off spans the upgrade and the replacements; the pool checks follow on this tree, before the journey takes the GPU', async () => {
    const order: string[] = [];
    const { checks, records, stopRequests } = liveChecks(order);
    const { contract, order: journey } = gpuContract(
      [['i-old'], ['i-new'], ['i-new']],
      undefined,
      undefined,
      '0.1.70',
      undefined,
      checks,
    );
    await contract.run();
    expect(records.get('pool-check-entry-handoff')).toEqual({
      serviceId: 'svc-1',
      url: 'https://svc-1.anycloud.sh/',
      requests: CLEAN_REQUESTS,
      entries: [
        { ip: '10.0.0.1', atMs: 0 },
        { ip: '10.0.0.2', atMs: 0 },
      ],
    });
    expect(order).toEqual([
      'startEntryHandoff svc-1',
      'agentRestart np-1',
      'poolGpuProbe np-1',
    ]);
    expect(journey.indexOf('upgrade')).toBeGreaterThan(
      journey.indexOf('createReadyNodePool'),
    );
    // The hand-off Service and the journey's GPU Service are both ended.
    expect(journey.filter((step) => step === 'terminate')).toHaveLength(2);
    expect(stopRequests).toHaveBeenCalled();
  });

  test('the cold-start check runs on the release before the upgrade, gated on its features, and not again after', async () => {
    const order: string[] = [];
    const { checks } = liveChecks(order);
    const { contract } = gpuContract(
      [['i-old'], ['i-new'], ['i-new']],
      undefined,
      undefined,
      '0.1.72',
      undefined,
      { ...checks, selected: ['cpu-cold-start'], releaseFeatures: false },
    );
    await contract.run();
    expect(order).toEqual(['cpuColdStart false']);
  });

  test('the hand-off keeps observing for a tail after the last old instance is gone', async () => {
    // Two reads during the replacement wait; the entry moves on the fifth,
    // inside the tail.
    const { checks, records } = liveChecks([], 0, 5);
    const { contract } = gpuContract(
      [['i-old'], ['i-new'], ['i-new']],
      undefined,
      undefined,
      '0.1.70',
      undefined,
      checks,
    );
    await contract.run();
    expect(records.get('pool-check-entry-handoff')).toMatchObject({
      entries: [{ ip: '10.0.0.1' }, { ip: '10.0.0.2' }],
    });
  });

  test('a failed hand-off still stops its request loop and fails the run', async () => {
    const order: string[] = [];
    const { checks, stopRequests } = liveChecks(order, 3);
    const { contract } = gpuContract(
      [['i-old'], ['i-new']],
      undefined,
      undefined,
      '0.1.70',
      undefined,
      checks,
    );
    await expect(contract.run()).rejects.toThrow(/3 of 400 requests/u);
    // Stopped by the check, then again (a no-op) by the stage's finally.
    expect(stopRequests).toHaveBeenCalledTimes(2);
  });

  // Run 40934365017: one status read stalled with the hosted API.
  const bodyTimeout = new Error('Cannot parse response body');

  test('one failed status read during the hand-off is retried, not fatal', async () => {
    const { checks, records } = liveChecks([], 0, 3, (read) =>
      read === 1 ? bodyTimeout : undefined,
    );
    const { contract } = gpuContract(
      [['i-old'], ['i-new'], ['i-new']],
      undefined,
      undefined,
      '0.1.70',
      undefined,
      checks,
    );
    await contract.run();
    expect(records.get('pool-check-entry-handoff')).toMatchObject({
      requests: { failed: 0 },
      entries: [{ ip: '10.0.0.1' }, { ip: '10.0.0.2' }],
    });
  });

  test('status reads that keep failing still fail the stage at its deadline', async () => {
    const { checks } = liveChecks([], 0, 2, () => bodyTimeout);
    const { contract } = gpuContract(
      [['i-old'], ['i-new'], ['i-new']],
      undefined,
      undefined,
      '0.1.70',
      undefined,
      checks,
    );
    await expect(contract.run()).rejects.toThrow(
      /instances from 0\.1\.70 replaced: timed out/u,
    );
  });

  test("one failed status read in the hand-off's final read is retried, not fatal", async () => {
    // Read 7 is stop()'s own: one in the replacement wait, five after it.
    const { checks, records } = liveChecks([], 0, 3, (read) =>
      read === 7 ? bodyTimeout : undefined,
    );
    const { contract } = gpuContract(
      [['i-old'], ['i-new'], ['i-new']],
      undefined,
      undefined,
      '0.1.70',
      undefined,
      checks,
    );
    await contract.run();
    expect(records.get('pool-check-entry-handoff')).toMatchObject({
      requests: { failed: 0 },
      entries: [{ ip: '10.0.0.1' }, { ip: '10.0.0.2' }],
    });
  });

  test('a stage that fails before the hand-off stops still records its request counts', async () => {
    const { checks, records } = liveChecks([]);
    // The old instance is never replaced.
    const { contract } = gpuContract(
      Array.from({ length: 6 }, () => ['i-old']),
      undefined,
      undefined,
      '0.1.70',
      undefined,
      checks,
    );
    await expect(contract.run()).rejects.toThrow(/replaced: timed out/u);
    expect(records.get('pool-check-entry-handoff')).toEqual({
      serviceId: 'svc-1',
      url: 'https://svc-1.anycloud.sh/',
      requests: CLEAN_REQUESTS,
      entries: [
        { ip: '10.0.0.1', atMs: 0 },
        { ip: '10.0.0.2', atMs: 0 },
      ],
    });
  });
});

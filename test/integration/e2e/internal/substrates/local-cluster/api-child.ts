import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import path from 'node:path';

import type { NodePoolCapacityComposition } from '../../../../../../src/api/composition.js';
import {
  ImageRuntime,
  ImageVerdict,
} from '../../../../../../src/shared/image.js';
import type {
  LocalKubernetesNodePoolFacts,
  LocalKubernetesDeploymentFacts,
  LocalKubernetesFactResponse,
  LocalKubernetesReservationFacts,
  LocalKubernetesReservationPutFacts,
  LocalKubernetesAttemptTailsFacts,
  LocalKubernetesDrainFacts,
  LocalKubernetesClaimBurstFacts,
  LocalKubernetesInFlightCapFacts,
} from './protocol.js';
import {
  LOCAL_KUBERNETES_PROTOCOL_VERSION,
  localKubernetesChildConfigSchema,
  localKubernetesFactRequestSchema,
  writeLocalKubernetesReadyRecord,
} from './protocol.js';
import { testAuthenticate } from '../../../../../helpers/test-authentication.js';
import { createApiLoadMonitor } from './api-load.js';

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const serialized = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        reject(new Error('Facts request is too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.once('error', reject);
  });
  return JSON.parse(serialized) as unknown;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(`${JSON.stringify(value)}\n`);
}

function listen(
  server: ReturnType<typeof createServer>,
  port: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

type ReservationBehavior =
  | 'hold'
  | 'hold-no-cancel'
  | 'complete'
  | 'error'
  | 'retry'
  | 'oom';

interface ReservationRecord {
  behavior: ReservationBehavior;
  lookupCount: number;
}

async function readReservations(
  file: string,
): Promise<Map<string, ReservationRecord>> {
  try {
    const value = JSON.parse(await readFile(file, 'utf8')) as Record<
      string,
      ReservationRecord
    >;
    return new Map(
      Object.entries(value).filter(
        ([jobId, record]) =>
          jobId.length > 0 &&
          [
            'hold',
            'hold-no-cancel',
            'complete',
            'error',
            'retry',
            'oom',
          ].includes(record.behavior) &&
          Number.isSafeInteger(record.lookupCount) &&
          record.lookupCount >= 0,
      ),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw error;
  }
}

async function writeReservations(
  file: string,
  reservations: ReadonlyMap<string, ReservationRecord>,
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(
    temporary,
    `${JSON.stringify(Object.fromEntries(reservations))}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  await rename(temporary, file);
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function main(): Promise<void> {
  const configPath = process.argv[2];
  invariant(configPath, 'usage: api-child.ts <config-path>');
  const config = localKubernetesChildConfigSchema.parse(
    JSON.parse(await readFile(configPath, 'utf8')) as unknown,
  );

  process.env.ANYCLOUD_DIR = path.join(config.stateRoot, 'anycloud-home');
  process.env.SQLITE_PATH = path.join(config.stateRoot, 'api.db');
  process.env.KUBECONFIG = path.join(
    config.stateRoot,
    'process-default-must-not-exist',
  );
  process.env.CIPHER_KEY = config.cipherKey;
  process.env.ANYCLOUD_WORKLOAD_API_URL = config.workloadApiUrl;
  process.env.IS_TEST = 'true';
  process.env.GITHUB_TOKEN = 'test-token';

  const [
    compositionModule,
    persistenceModule,
    cloudModule,
    sharedCloud,
    sharedCloudConfig,
    cloudConfig,
    monitorModule,
    serverModule,
    capacityModule,
    constantsModule,
    catalogModule,
    testIdentityModule,
    dbModule,
    drainModule,
  ] = await Promise.all([
    import('../../../../../../src/api/composition.js'),
    import('../../../../../../src/api/services/persistence.js'),
    import('../../../../../../src/api/services/gateways/cloud.js'),
    import('../../../../../../src/shared/cloud.js'),
    import('../../../../../../src/shared/cloud-config.js'),
    import('../../../../../../src/api/services/cloud-config.js'),
    import('../../../../../../src/api/services/monitor.js'),
    import('../../../../../../src/api/server.js'),
    import('./capacity-compute.js'),
    import('./constants.js'),
    import('../../../../../../src/shared/catalog/index.js'),
    import('../../../../../../src/api/services/test-identity.js'),
    import('../../../../../../src/api/services/repositories/db.js'),
    import('../../../../../../src/api/services/pool-job-drain.js'),
  ]);

  // The local compute port replaces target validation, including its bootstrap.
  await catalogModule.ensureCatalogBootstrapped(sharedCloud.CloudType.AWS);
  await persistenceModule.initializePersistence();
  const persistence = persistenceModule.getPersistence();
  const encryptedCredential = await cloudConfig.encryptCredential({
    cloudProvider: sharedCloud.CloudType.AWS,
    accessKeyId: 'local-managed-kubernetes',
    secretAccessKey: 'local-managed-kubernetes',
  });
  await persistence.credentialSecrets.saveNamedCredential(
    constantsModule.clusterLocalCredentialName,
    constantsModule.clusterLocalCredentialId,
    encryptedCredential,
    sharedCloud.CloudType.AWS,
  );
  // The fixture's K3s is this API's cluster: recorded before serving as the
  // hosted API records itself, with the installer-kind connection the fixture
  // minted (a real cluster binds it during creation).
  const recorded = await persistence.clusters.recordSelf({
    id: constantsModule.clusterLocalClusterId,
    ownerUserId: testIdentityModule.TEST_USER_ID,
    name: config.cluster.name,
    kubernetesIdentity: config.cluster.kubernetesIdentity,
    connection: config.cluster.connection,
  });
  invariant(
    recorded !== 'identity-mismatch',
    'local cluster database records another cluster identity',
  );

  // Local pools are unpinned, so they launch in catalog regions; the first
  // one they try is full, so each pool must move on to the next.
  const [fullRegion] = sharedCloudConfig.getRegionsForVMType(
    constantsModule.localClusterVmType,
    sharedCloud.CloudType.AWS,
  );
  const computes = new Map<
    string,
    ReturnType<typeof capacityModule.createClusterLocalCapacityCompute>
  >();
  const vmTypes = [
    constantsModule.localClusterVmType,
    constantsModule.localClusterPricedVmType,
    constantsModule.localClusterKwokVmType,
    constantsModule.localScalingVmType,
  ];
  // The only injected seam: node pool VM compute. Cluster connection, join
  // credentials, Deployment and Service runtimes are production composition.
  const nodePoolCapacity: NodePoolCapacityComposition = {
    createCompute: ({ region, vmType }) => {
      invariant(region, 'local node pool compute needs a region');
      const kwok = vmType === constantsModule.localClusterKwokVmType;
      const scaling = vmType === constantsModule.localScalingVmType;
      const key = `${region} ${String(kwok)} ${String(scaling)}`;
      let compute = computes.get(key);
      if (!compute) {
        compute = capacityModule.createClusterLocalCapacityCompute({
          createCloudCompute: cloudModule.createCloudCompute,
          CloudType: sharedCloud.CloudType,
          CloudFailureDiagnosis: sharedCloud.CloudFailureDiagnosis,
          runId: config.runId,
          region,
          full: region === fullRegion,
          kwok,
          bootImages: scaling,
        });
        computes.set(key, compute);
      }
      return compute;
    },
    validateTarget(request, credential) {
      invariant(
        credential.id === constantsModule.clusterLocalCredentialId,
        `unexpected local credential ${credential.id}`,
      );
      invariant(
        request.region === undefined &&
          request.vmTypes.length === 1 &&
          vmTypes.includes(request.vmTypes[0]),
        'local node pool request used an unsupported placement',
      );
      return Promise.resolve({
        region: null,
        zone: request.zone ?? null,
        vmTypes: request.vmTypes,
        minVmCount: request.minVmCount,
        maxVmCount: request.maxVmCount,
        osDiskSizeGb: request.osDiskSizeGb,
      });
    },
  };

  const rpcDomains = compositionModule.createApiRpcDomains({
    nodePoolCapacity,
    // The pool-Job stage records the workload image's digest and config
    // (`prepareRunnerImage`); pool admission needs both, Deployments neither.
    inspectDeploymentImage: async (image) => {
      const verified = await readFile(
        path.join(config.stateRoot, 'workload-image.json'),
        'utf8',
      ).then(
        (text) =>
          JSON.parse(text) as {
            image: string;
            amd64Digest: string;
            entrypoint: string[];
            cmd: string[];
          },
        () => null,
      );
      return verified?.image === image
        ? {
            verdict: ImageVerdict.Ok,
            amd64Digest: verified.amd64Digest,
            imageRuntime: ImageRuntime.Unknown,
            compressedLayerBytes: null,
            entrypoint: verified.entrypoint,
            cmd: verified.cmd,
          }
        : {
            verdict: ImageVerdict.Unknown,
            amd64Digest: null,
            imageRuntime: ImageRuntime.Unknown,
            compressedLayerBytes: null,
          };
    },
  });
  const app = serverModule.createApp({
    authenticate: testAuthenticate,
    resolveRpcDomains: () => rpcDomains,
  });
  const apiServer = app.listen(config.apiPort, '0.0.0.0');
  await new Promise<void>((resolve, reject) => {
    apiServer.once('listening', resolve);
    apiServer.once('error', reject);
  });
  apiServer.keepAliveTimeout = 0;
  const load = createApiLoadMonitor(dbModule.getDB());
  apiServer.on('request', (request, response) =>
    load.request(request, response),
  );
  // S12: each burst Job's command posts here once per run (exactly-once).
  const runs = new Map<string, number>();

  const reservationFile = path.join(config.stateRoot, 'reservation-store.json');
  const reservations = await readReservations(reservationFile);
  let reservationWrite = Promise.resolve();
  const persistReservations = (): Promise<void> => {
    reservationWrite = reservationWrite.then(() =>
      writeReservations(reservationFile, reservations),
    );
    return reservationWrite;
  };

  const handleReservationGet = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<boolean> => {
    const ran = /^\/runs\/([^/]+)$/u.exec(request.url ?? '')?.[1];
    if (request.method === 'POST' && ran) {
      const jobId = decodeURIComponent(ran);
      runs.set(jobId, (runs.get(jobId) ?? 0) + 1);
      json(response, 200, { jobId });
      return true;
    }
    // A burst Job waits here until its gate has a run (`openGate`).
    if (request.method === 'GET' && ran) {
      const runCount = runs.get(decodeURIComponent(ran)) ?? 0;
      json(response, runCount > 0 ? 200 : 404, { runs: runCount });
      return true;
    }
    if (request.method !== 'GET') return false;
    const url = new URL(request.url ?? '/', 'http://reservation-store');
    const match = url.pathname.match(/^\/reservations\/([^/]+)$/u);
    if (!match?.[1]) return false;
    const jobId = decodeURIComponent(match[1]);
    const reservation = reservations.get(jobId);
    if (!reservation) {
      json(response, 404, { error: 'reservation not found' });
      return true;
    }
    const { behavior } = reservation;
    reservation.lookupCount += 1;
    // One OOM per reservation: a re-claim before the contract completes the
    // Job holds instead of killing the replica again.
    if (behavior === 'oom') reservation.behavior = 'hold';
    await persistReservations();
    json(response, 200, { jobId, behavior });
    return true;
  };

  const handleFacts = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    if (
      request.method !== 'POST' ||
      request.headers.authorization !== `Bearer ${config.factsToken}`
    ) {
      json(response, 404, { error: 'not found' });
      return;
    }
    let requestId = 'invalid-request';
    try {
      const factRequest = localKubernetesFactRequestSchema.parse(
        await readBody(request),
      );
      requestId = factRequest.requestId;
      let result:
        | LocalKubernetesNodePoolFacts
        | LocalKubernetesDeploymentFacts
        | LocalKubernetesReservationFacts
        | LocalKubernetesReservationPutFacts
        | LocalKubernetesAttemptTailsFacts
        | LocalKubernetesDrainFacts
        | LocalKubernetesClaimBurstFacts
        | LocalKubernetesInFlightCapFacts;
      if (factRequest.operation === 'node-pool') {
        const [nodePool, rows, failures] = await Promise.all([
          persistence.nodePools.getForScope(factRequest.nodePoolId, {
            kind: 'api',
          }),
          persistence.nodePoolVms.listVms(factRequest.nodePoolId),
          persistence.nodePoolVms.listLaunchFailures(factRequest.nodePoolId, 0),
        ]);
        const cluster = nodePool
          ? await persistence.clusterRecords.getForScope(nodePool.clusterId, {
              kind: 'api',
            })
          : null;
        result = {
          kind: 'node-pool',
          nodePoolId: factRequest.nodePoolId,
          state: nodePool?.state ?? null,
          clusterId: nodePool?.clusterId ?? null,
          kubernetesIdentity: cluster?.kubernetesIdentity ?? null,
          connectionRevision: cluster?.connectionRevision ?? null,
          capacityRows: rows.map((row) => ({
            id: row.id,
            cloudId: row.cloudId,
            endedAt: row.endedAt,
            ip: row.ip,
          })),
          failedLaunches: failures.map(({ vmRowId, region, diagnosis }) => ({
            vmRowId,
            region,
            diagnosis: String(diagnosis),
          })),
        };
      } else if (factRequest.operation === 'workload') {
        result = {
          kind: 'workload',
          workloadId: factRequest.workloadId,
          persisted:
            (await persistence.workloadQueries.getWorkload(
              factRequest.workloadId,
            )) !== null,
        };
      } else if (factRequest.operation === 'attempt-tails') {
        result = {
          kind: 'attempt-tails',
          jobId: factRequest.jobId,
          attempts: await dbModule.getDB().query<{
            attempt: number;
            logTailState: string | null;
            logTail: string | null;
          }>(
            `SELECT attempt, log_tail_state AS logTailState, log_tail AS logTail
             FROM workload_attempts WHERE workload_id = ? ORDER BY attempt`,
            [factRequest.jobId],
          ),
        };
      } else if (factRequest.operation === 'drain') {
        result = {
          kind: 'drain',
          jobs: (await drainModule.drainPoolJobs(factRequest.force)).map(
            ({ id, state }) => ({ id, state }),
          ),
        };
      } else if (factRequest.operation === 'claim-burst') {
        result = {
          kind: 'claim-burst',
          jobs: await claimBurstJobs(
            factRequest.deploymentId,
            factRequest.closeWindow,
          ),
          load: load.read(factRequest.closeWindow),
        };
      } else if (factRequest.operation === 'in-flight-cap') {
        process.env.ANYCLOUD_E2E_IN_FLIGHT_CAP = String(factRequest.cap);
        result = { kind: 'in-flight-cap', cap: factRequest.cap };
      } else if (factRequest.operation === 'reservation-put') {
        const current = reservations.get(factRequest.jobId);
        reservations.set(factRequest.jobId, {
          behavior: factRequest.behavior,
          lookupCount: current?.lookupCount ?? 0,
        });
        await persistReservations();
        result = {
          kind: 'reservation-put',
          jobId: factRequest.jobId,
        };
      } else {
        const reservation = reservations.get(factRequest.jobId);
        result = {
          kind: 'reservation',
          jobId: factRequest.jobId,
          present: reservation !== undefined,
          lookupCount: reservation?.lookupCount ?? 0,
        };
      }
      const factResponse: LocalKubernetesFactResponse = {
        version: LOCAL_KUBERNETES_PROTOCOL_VERSION,
        requestId,
        ok: true,
        result,
      };
      json(response, 200, factResponse);
    } catch (error) {
      const factResponse: LocalKubernetesFactResponse = {
        version: LOCAL_KUBERNETES_PROTOCOL_VERSION,
        requestId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
      json(response, 400, factResponse);
    }
  };
  /**
   * Every Job of a managed Deployment; with `full`, each attempt with its
   * slot price and the Job's block reason. A poll reads states alone, so
   * the measurement adds little to the SQLite queue it measures.
   */
  const claimBurstJobs = async (
    deploymentId: string | null,
    full: boolean,
  ): Promise<LocalKubernetesClaimBurstFacts['jobs']> => {
    if (!deploymentId) return [];
    const db = dbModule.getDB();
    if (!full) {
      return (
        await db.query<{ id: string; state: string }>(
          'SELECT id, state FROM workloads WHERE deployment_id = ?',
          [deploymentId],
        )
      ).map((job) => ({
        ...job,
        session: null,
        submittedAt: 0,
        blocked: null,
        runs: runs.get(job.id) ?? 0,
        attempts: [],
      }));
    }
    const [jobs, attempts] = await Promise.all([
      db.query<{
        id: string;
        state: string;
        session: string | null;
        submittedAt: number;
        blocked: string | null;
      }>(
        `SELECT id, state, session, submitted_at AS submittedAt,
           (SELECT json_extract(e.metadata, '$.message') FROM workload_events e
            WHERE e.workload_id = w.id AND e.state = 'queued'
              AND json_valid(e.metadata)
              AND json_extract(e.metadata, '$.message') LIKE 'blocked by %'
            ORDER BY e.id DESC LIMIT 1) AS blocked
         FROM workloads w WHERE deployment_id = ?`,
        [deploymentId],
      ),
      db.query<{
        jobId: string;
        executionId: string;
        podUid: string | null;
        openedAt: number;
        endedAt: number | null;
        slotUsd: number | null;
        outcome: string | null;
        reason: string | null;
      }>(
        `SELECT a.workload_id AS jobId, a.execution_id AS executionId,
           p.pod_uid AS podUid, a.opened_at AS openedAt, a.ended_at AS endedAt,
           o.hourly_usd / t.max_concurrent_jobs_per_replica AS slotUsd,
           a.outcome, COALESCE(a.reason, a.cause) AS reason
         FROM workload_attempts a
         JOIN workloads w ON w.id = a.workload_id
         JOIN deployments t ON t.id = w.deployment_id
         LEFT JOIN pod_attempts p ON p.attempt_id = a.id
         LEFT JOIN pool_occupancy o
           ON o.deployment_id = w.deployment_id AND o.pod_uid = p.pod_uid
         WHERE w.deployment_id = ? ORDER BY a.opened_at`,
        [deploymentId],
      ),
    ]);
    return jobs.map((job) => ({
      ...job,
      runs: runs.get(job.id) ?? 0,
      attempts: attempts
        .filter((attempt) => attempt.jobId === job.id)
        .map(({ jobId: _, ...attempt }) => attempt),
    }));
  };
  const factsServer = createServer((request, response) => {
    void handleReservationGet(request, response).then((handled) => {
      if (!handled) return handleFacts(request, response);
    });
  });
  await listen(factsServer, config.factsPort);
  await monitorModule.startBackgroundServices();

  await writeLocalKubernetesReadyRecord(config.readyPath, {
    version: LOCAL_KUBERNETES_PROTOCOL_VERSION,
    launchNonce: config.launchNonce,
    pid: process.pid,
    port: config.apiPort,
  });

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await close(factsServer);
    await new Promise<void>((resolve, reject) => {
      apiServer.close((error) => (error ? reject(error) : resolve()));
    });
    await monitorModule.stopBackgroundServices();
    load.stop();
  };
  process.once('SIGTERM', () => {
    void stop().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error(error);
        process.exit(1);
      },
    );
  });
  process.once('SIGINT', () => {
    void stop().then(() => process.exit(0));
  });
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

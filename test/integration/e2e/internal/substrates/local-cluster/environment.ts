import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

import { WorkloadState } from '../../../../../../src/shared/workload.js';
import type { ClusterSummary } from '../../../../../../src/shared/api-contract/clusters-schemas.js';
import type { ApiClient } from '../../api.js';
import type { ArtifactStore, Redactor } from '../../artifacts.js';
import type { CleanupStack } from '../../cleanup.js';
import { ControllerEndpoint } from '../../controller-session.js';
import { ManagedProcess } from '../../managed-process.js';
import type { Waiter } from '../../wait.js';
import {
  dumpLocalKubernetesDiagnostics,
  executeLocalKubernetesCommand,
} from './command.js';
import { clusterLocalClusterId, clusterLocalClusterName } from './constants.js';
import {
  requireLocalKubernetesTools,
  warmLocalKubernetesImage,
} from './observations.js';
import {
  LOCAL_KUBERNETES_PROTOCOL_VERSION,
  type LocalKubernetesChildConfig,
  type LocalKubernetesReadyRecord,
  localKubernetesChildConfigSchema,
  parseLocalKubernetesReadyRecord,
} from './protocol.js';
import { LocalClusterHost } from './cluster-host.js';
import { proveHostedChartRepair } from './hosted-chart.js';

interface ClusterLocalEnvironmentOptions {
  readonly api: Pick<ApiClient, 'listClusters'>;
  readonly artifacts: ArtifactStore;
  readonly cleanup: CleanupStack;
  readonly endpoint: ControllerEndpoint;
  readonly projectRoot: string;
  readonly redactor: Redactor;
  readonly runId: string;
  readonly stateRoot: string;
  readonly wait: Pick<Waiter, 'for'>;
}

function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address();
      listener.close((error) => {
        if (error) reject(error);
        else if (!address || typeof address === 'string')
          reject(new Error('Could not allocate a loopback port'));
        else resolve(address.port);
      });
    });
  });
}

function portIsClosed(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const finish = (closed: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(closed);
    };
    socket.once('connect', () => finish(false));
    socket.once('error', () => finish(true));
    socket.setTimeout(1_000, () => finish(true));
  });
}

/**
 * One fixture-owned K3s cluster on the runner's Docker, recorded through the
 * real API by an API child that serves this tree's routes. Everything the
 * contract asserts comes from the API's cluster list or from the cluster's
 * Kubernetes API.
 */
export class ClusterLocalEnvironment {
  readonly #api: ClusterLocalEnvironmentOptions['api'];
  readonly #cleanup: CleanupStack;
  readonly #endpoint: ControllerEndpoint;
  readonly #process: ManagedProcess<LocalKubernetesReadyRecord>;
  readonly #projectRoot: string;
  readonly #redactor: Redactor;
  readonly #host: LocalClusterHost;
  readonly #runId: string;
  readonly #stateRoot: string;
  readonly #wait: Pick<Waiter, 'for'>;
  #apiPort: number | undefined;
  #cipherKey: string | undefined;
  #owned = false;
  #diagnosedAt: string | undefined;
  #recordedCluster: ClusterSummary | undefined;
  #started = false;

  constructor(options: ClusterLocalEnvironmentOptions) {
    this.#api = options.api;
    this.#cleanup = options.cleanup;
    this.#endpoint = options.endpoint;
    this.#process = new ManagedProcess(options.artifacts);
    this.#projectRoot = options.projectRoot;
    this.#runId = options.runId;
    this.#stateRoot = options.stateRoot;
    this.#wait = options.wait;
    this.#redactor = options.redactor;
    this.#host = new LocalClusterHost({
      redactor: options.redactor,
      runId: options.runId,
      wait: options.wait,
    });
  }

  prepare(): Promise<void> {
    return this.start();
  }

  /** The cluster record the child API wrote for this fixture's K3s. */
  recordedCluster(): ClusterSummary & { kubernetesIdentity: string } {
    if (!this.#recordedCluster?.kubernetesIdentity) {
      throw new Error('Local cluster has not been recorded by the API');
    }
    return {
      ...this.#recordedCluster,
      kubernetesIdentity: this.#recordedCluster.kubernetesIdentity,
    };
  }

  /**
   * The API still lists the cluster Running under the same Kubernetes
   * identity, and the K3s server container is still running.
   */
  async clusterIntact(): Promise<
    ClusterSummary & { kubernetesIdentity: string }
  > {
    const registered = this.recordedCluster();
    const clusterRecords = await this.#api.listClusters();
    const current = clusterRecords.find(
      (cluster) => cluster.id === registered.id,
    );
    if (
      !current ||
      current.state !== WorkloadState.Running ||
      current.kubernetesIdentity !== registered.kubernetesIdentity
    ) {
      throw new Error(
        `Local cluster ${registered.id} changed: ${JSON.stringify(current ?? null)}`,
      );
    }
    if (!(await this.#host.exists())) {
      throw new Error('Local cluster K3s server container disappeared');
    }
    return { ...current, kubernetesIdentity: registered.kubernetesIdentity };
  }

  /** A Helm-managed API built from this tree on the fixture's K3s, installed with an older chart. */
  hostedChartRepair(): ReturnType<typeof proveHostedChartRepair> {
    return proveHostedChartRepair({
      clients: this.#host.clients(),
      container: this.#host.containerName,
      connection: this.#host.connection,
      kubernetesIdentity: this.#host.kubernetesIdentity,
      projectRoot: this.#projectRoot,
      stateRoot: this.#stateRoot,
      wait: this.#wait,
    });
  }

  /** Crashes the API child and relaunches it on the same state root. */
  async replaceController(): Promise<{
    readonly beforeControllerInstance: string;
    readonly afterControllerInstance: string;
  }> {
    const before = this.#process.ready;
    if (!this.#endpoint.snapshot()?.url) {
      throw new Error('Controller endpoint is not attached');
    }
    this.#endpoint.detach();
    await this.#process.crash();
    await this.#startIncarnation();
    const after = this.#process.ready;
    return {
      beforeControllerInstance: `${String(before.pid)}:${before.launchNonce}`,
      afterControllerInstance: `${String(after.pid)}:${after.launchNonce}`,
    };
  }

  async start(): Promise<void> {
    if (this.#started)
      throw new Error('Local cluster environment already started');
    await requireLocalKubernetesTools();
    await warmLocalKubernetesImage();
    await mkdir(this.#stateRoot, { recursive: true, mode: 0o700 });
    this.#apiPort = await availablePort();
    this.#cipherKey = randomBytes(32).toString('hex');
    this.#cleanup.defer('local cluster environment', () => this.stop());
    this.#owned = true;
    await this.#host.start();
    await this.#startIncarnation();
    await this.#awaitClusterRecord();
    this.#started = true;
  }

  /**
   * The runner's K3s is the installation's cluster: the child API recorded it
   * before serving (api-child.ts), and the listed record must carry the
   * kube-system identity the fixture observed itself.
   */
  async #awaitClusterRecord(): Promise<void> {
    const expectedKubernetesIdentity = this.#host.kubernetesIdentity;
    this.#recordedCluster = await this.#wait.for(
      `local cluster ${clusterLocalClusterId} readiness`,
      async () =>
        (await this.#api.listClusters()).find(
          (candidate) => candidate.id === clusterLocalClusterId,
        ),
      {
        timeoutMs: 120_000,
        intervalMs: 2_000,
        probeError: 'fail',
        unmet: (candidate) =>
          candidate?.state === WorkloadState.Running
            ? undefined
            : (candidate?.state ?? 'not listed'),
      },
    );
    if (
      this.#recordedCluster?.kubernetesIdentity !== expectedKubernetesIdentity
    ) {
      throw new Error('Recorded cluster identity differs from the K3s server');
    }
  }

  async captureDiagnostics(failures: readonly string[] = []): Promise<void> {
    if (!this.#owned) return;
    this.#diagnosedAt = new Date().toISOString();
    // Vitest prints the failure only after the test ends; a job cancelled
    // during cleanup never shows it, so it leads the dump.
    process.stderr.write(
      `[e2e ${this.#diagnosedAt}] failed:\n${failures.map((failure) => `  - ${this.#redactor.text(failure)}`).join('\n')}\n`,
    );
    await this.#process.captureDiagnostics();
    await dumpLocalKubernetesDiagnostics(this.#runId, (text) =>
      this.#redactor.text(text),
    );
  }

  async stop(): Promise<void> {
    this.#endpoint.detach();
    const failures: unknown[] = [];
    if (this.#diagnosedAt) {
      // The failure dump precedes cleanup; what the cluster did while the
      // fallback cleanup ran is the other half of the story.
      await dumpLocalKubernetesDiagnostics(
        this.#runId,
        (text) => this.#redactor.text(text),
        { since: this.#diagnosedAt },
      );
      this.#diagnosedAt = undefined;
    }
    await this.#process.stop().catch((error: unknown) => failures.push(error));
    await this.#host.stop().catch((error: unknown) => failures.push(error));
    await this.#assertAbsent().catch((error: unknown) => failures.push(error));
    this.#recordedCluster = undefined;
    this.#started = false;
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        'Local cluster environment cleanup failed',
      );
    }
  }

  async #startIncarnation(): Promise<void> {
    const apiPort = this.#apiPort;
    const cipherKey = this.#cipherKey;
    if (!apiPort || !cipherKey) {
      throw new Error('Local Kubernetes child configuration is incomplete');
    }
    const launchNonce = randomUUID();
    const launchDirectory = path.join(this.#stateRoot, 'launches');
    await mkdir(launchDirectory, { recursive: true, mode: 0o700 });
    const readyPath = path.join(launchDirectory, `${launchNonce}.ready.json`);
    const configPath = path.join(launchDirectory, `${launchNonce}.config.json`);
    const config: LocalKubernetesChildConfig =
      localKubernetesChildConfigSchema.parse({
        version: LOCAL_KUBERNETES_PROTOCOL_VERSION,
        apiPort,
        cipherKey,
        launchNonce,
        projectRoot: this.#projectRoot,
        readyPath,
        runId: this.#runId,
        stateRoot: this.#stateRoot,
        workloadApiUrl: `http://${this.#host.publicIp}:${String(apiPort)}`,
        cluster: {
          name: clusterLocalClusterName,
          kubernetesIdentity: this.#host.kubernetesIdentity,
          connection: JSON.stringify(this.#host.connection),
        },
      });
    await writeFile(configPath, `${JSON.stringify(config)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    const ready = await this.#process.start({
      executable: process.execPath,
      args: [
        '--import',
        'tsx',
        path.join(
          this.#projectRoot,
          'test/integration/e2e/internal/substrates/local-cluster/api-child.ts',
        ),
        configPath,
      ],
      cwd: this.#projectRoot,
      env: {},
      label: `e2e-cluster-local-api-${launchNonce.slice(0, 8)}`,
      readyPath,
      readyTimeoutMs: 60_000,
      parseReady: (value, childPid) =>
        parseLocalKubernetesReadyRecord(value, {
          launchNonce,
          pid: childPid,
          port: apiPort,
        }),
    });
    this.#endpoint.attach(`http://127.0.0.1:${ready.port}`);
  }

  async #assertAbsent(): Promise<void> {
    if (await this.#host.exists()) {
      throw new Error('Local cluster K3s server container is still present');
    }
    for (const [kind, args] of [
      [
        'containers',
        ['ps', '-aq', '--filter', `label=com.anycloud.e2e-run=${this.#runId}`],
      ],
      [
        'networks',
        [
          'network',
          'ls',
          '-q',
          '--filter',
          `label=com.anycloud.e2e-run=${this.#runId}`,
        ],
      ],
    ] as const) {
      const { stdout } = await executeLocalKubernetesCommand('docker', args);
      if (stdout.trim()) {
        throw new Error(
          `Run-owned local cluster ${kind} remain: ${stdout.trim()}`,
        );
      }
    }
    if (this.#apiPort && !(await portIsClosed(this.#apiPort))) {
      throw new Error(`Local Anycloud API port ${this.#apiPort} is still open`);
    }
  }
}

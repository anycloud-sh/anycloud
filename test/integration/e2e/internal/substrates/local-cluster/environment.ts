import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type { KubernetesClients } from '../../../../../../src/api/services/kubernetes/client.js';
import {
  ATTEMPT_NODE_LABEL,
  nodePoolNamespace,
} from '../../../../../../src/api/services/kubernetes/node-pool-scheduling.js';
import { ANYCLOUD_POD_FINALIZER } from '../../../../../../src/api/services/kubernetes/pool-objects.js';
import { KUBERNETES_MANAGED_BY_LABEL } from '../../../../../../src/api/services/kubernetes/identity.js';
import { WorkloadState } from '../../../../../../src/shared/workload.js';
import { apiImageTagReference } from '../../../../../../src/shared/system-release.js';
import packageJson from '../../../../../../package.json' with { type: 'json' };
import type { ClusterSummary } from '../../../../../../src/shared/api-contract/clusters-schemas.js';
import type { ApiClient } from '../../api.js';
import type { ArtifactStore, Redactor } from '../../artifacts.js';
import type { CleanupStack } from '../../cleanup.js';
import { ControllerEndpoint } from '../../controller-session.js';
import { ManagedProcess } from '../../managed-process.js';
import type { WorkspacePythonSdk } from '../../python-sdk.js';
import type {
  KubernetesCapacityObservation,
  KubernetesConnectionObservation,
  KubernetesControllerReplacementObservation,
  NodePoolRequest,
  AttemptLogTail,
} from '../../targets/cluster-node-pool.js';
import type { Waiter } from '../../wait.js';
import {
  deleteLocalClusterVm,
  clusterLocalCapacityNetwork,
  localClusterNodeContainer,
} from './capacity-compute.js';
import {
  dumpLocalKubernetesDiagnostics,
  executeLocalKubernetesCommand,
  localKubernetesCommandSucceeds,
} from './command.js';
import {
  clusterLocalBootImagesTaint,
  clusterLocalCredentialName,
  clusterLocalClusterId,
  clusterLocalClusterName,
  localClusterVmType,
  localScalingVmType,
} from './constants.js';
import {
  requireLocalKubernetesTools,
  warmLocalKubernetesImage,
} from './observations.js';
import {
  LOCAL_KUBERNETES_PROTOCOL_VERSION,
  type LocalKubernetesChildConfig,
  LocalKubernetesFactsClient,
  type LocalKubernetesClaimBurstFacts,
  type LocalKubernetesReadyRecord,
  localKubernetesChildConfigSchema,
  parseLocalKubernetesReadyRecord,
} from './protocol.js';
import { LocalClusterHost, type LocalManagementNode } from './cluster-host.js';
import { startKwokController } from './kwok.js';
import { proveHostedChartRepair } from './hosted-chart.js';
import { assertUserNamespacePolicy } from './user-namespace-policy.js';
import { assertKubeletRestrictions } from './kubelet-restrictions.js';

interface ClusterLocalEnvironmentOptions {
  readonly api: Pick<ApiClient, 'listClusters'>;
  readonly artifacts: ArtifactStore;
  readonly cleanup: CleanupStack;
  readonly endpoint: ControllerEndpoint;
  readonly projectRoot: string;
  readonly redactor: Redactor;
  readonly runId: string;
  readonly sdk: WorkspacePythonSdk;
  readonly stateRoot: string;
  readonly wait: Pick<Waiter, 'for'>;
}

function availablePorts(count: number): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const listeners: net.Server[] = [];
    const ports: number[] = [];
    const fail = (error: Error): void => {
      for (const listener of listeners) listener.close();
      reject(error);
    };
    for (let index = 0; index < count; index += 1) {
      const listener = net.createServer();
      listeners.push(listener);
      listener.once('error', fail);
      listener.listen(0, '127.0.0.1', () => {
        const address = listener.address();
        if (!address || typeof address === 'string') {
          fail(new Error('Could not allocate a loopback port'));
          return;
        }
        ports.push(address.port);
        if (ports.length !== count) return;
        Promise.all(
          listeners.map(
            (candidate) =>
              new Promise<void>((closeResolve, closeReject) =>
                candidate.close((error) =>
                  error ? closeReject(error) : closeResolve(),
                ),
              ),
          ),
        ).then(() => resolve(ports), reject);
      });
    }
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
 * real API, plus an API child whose node pool compute starts K3s agent
 * containers. Everything the contract asserts comes from the API child's
 * durable facts or from the cluster's Kubernetes API.
 */
export class ClusterLocalEnvironment {
  readonly #api: ClusterLocalEnvironmentOptions['api'];
  readonly #cleanup: CleanupStack;
  readonly #endpoint: ControllerEndpoint;
  readonly #nodePoolIds = new Set<string>();
  readonly #process: ManagedProcess<LocalKubernetesReadyRecord>;
  readonly #projectRoot: string;
  readonly #redactor: Redactor;
  readonly #host: LocalClusterHost;
  readonly #runId: string;
  readonly #sdk: WorkspacePythonSdk;
  readonly #stateRoot: string;
  readonly #wait: Pick<Waiter, 'for'>;
  readonly #workloadImage: string;
  /** `<node container> <image>` pairs already imported. */
  readonly #importedImages = new Set<string>();
  /** Node pools of another VM type than `localClusterVmType`, by name. */
  readonly #vmTypes = new Map<string, string>();
  #management: LocalManagementNode | undefined;
  /** Image → archive name, for Nodes that join later. */
  readonly #bootImages = new Map<string, string>();
  readonly #poolJobImages = new Map<string, Promise<void>>();
  /** Imports into one agent run one at a time: they share its archive paths. */
  #imports: Promise<unknown> = Promise.resolve();
  #booting: { active: boolean; loop: Promise<void> } | undefined;
  #runnerImageBuilt: Promise<unknown> | undefined;
  #apiPort: number | undefined;
  #cipherKey: string | undefined;
  #facts: LocalKubernetesFactsClient | undefined;
  #factsPort: number | undefined;
  #factsToken: string | undefined;
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
    this.#sdk = options.sdk;
    this.#stateRoot = options.stateRoot;
    this.#wait = options.wait;
    this.#workloadImage = `anycloud-e2e-cluster-local-deployment:${options.runId}`;
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

  nodePoolRequest(
    name: string,
    vmCount: number,
    maxVmCount = vmCount,
  ): NodePoolRequest {
    return {
      name,
      credentialName: clusterLocalCredentialName,
      vmTypes: [this.#vmTypes.get(name) ?? this.#vmType(vmCount, maxVmCount)],
      minVmCount: vmCount,
      maxVmCount,
      // A known disk gives managed replicas `ephemeral-storage` (ST2b).
      osDiskSizeGb: 40,
    };
  }

  /** Before `prepare`: the API child shares the management node's CPUs (S12). */
  constrainManagement(management: LocalManagementNode): void {
    this.#management = management;
    this.#host.constrain(management);
  }

  /** The next node pool named `name` uses `vmType` (S12's priced and KWOK pools). */
  useVmType(name: string, vmType: string): void {
    this.#vmTypes.set(name, vmType);
  }

  /** The KWOK controller, until cleanup; its Nodes are a KWOK pool's VMs. */
  async startKwok(): Promise<void> {
    const stop = await startKwokController(this.#runId, this.#host.kubeconfig);
    this.#cleanup.defer('KWOK controller', stop);
  }

  /** Where a burst Job's command records that it ran (S12). */
  runsUrl(): string {
    const port = this.#factsPort;
    if (!port) throw new Error('Local facts server is not ready');
    return `http://${this.#host.publicIp}:${String(port)}/runs`;
  }

  /** Record a run of `gate`, releasing the burst Jobs that wait on it. */
  async openGate(gate: string): Promise<number> {
    const response = await fetch(`${this.runsUrl()}/${gate}`, {
      method: 'POST',
    });
    if (!response.ok) {
      throw new Error(
        `Opening gate ${gate} failed: ${String(response.status)}`,
      );
    }
    return Date.now();
  }

  /** The Jobs of a managed Deployment, and the API's load since the last read. */
  claimBurst(
    deploymentId: string | null,
    closeWindow: boolean,
  ): Promise<LocalKubernetesClaimBurstFacts> {
    return this.#requiredFacts().claimBurst(deploymentId, closeWindow);
  }

  async setInFlightCap(cap: number): Promise<void> {
    await this.#requiredFacts().inFlightCap(cap);
  }

  /** The cluster's admin clients: the harness's own reads and token requests. */
  adminClients(): KubernetesClients {
    return this.#host.clients();
  }

  /** A scaling pool's agents join tainted, so the boot-image loop starts. */
  #vmType(vmCount: number, maxVmCount: number): string {
    if (maxVmCount === vmCount) return localClusterVmType;
    if (!this.#booting) {
      const booting = { active: true, loop: Promise.resolve() };
      booting.loop = this.#bootLoop(booting);
      this.#booting = booting;
    }
    return localScalingVmType;
  }

  recordNodePool(nodePoolId: string): void {
    if (!nodePoolId.trim()) throw new Error('Node pool ID cannot be empty');
    this.#nodePoolIds.add(nodePoolId);
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
   * Node pool deletion must leave the cluster itself untouched: the API still
   * lists it Ready under the same Kubernetes identity and the K3s server
   * container is still running.
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
        `Local cluster ${registered.id} changed after node pool deletion: ${JSON.stringify(current ?? null)}`,
      );
    }
    if (!(await this.#host.exists())) {
      throw new Error('Local cluster K3s server container disappeared');
    }
    return { ...current, kubernetesIdentity: registered.kubernetesIdentity };
  }

  /**
   * A Helm-managed API built from this tree on the fixture's K3s, installed
   * with an older chart; run after the node pools are gone.
   */
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

  /** The NodeRestriction and supervisor checks from a pool agent. */
  kubeletRestrictions(nodePoolId: string): Promise<void> {
    return assertKubeletRestrictions({
      clients: this.#host.clients(),
      server: this.#host.connection.server,
      nodePoolId,
    });
  }

  /** RFC 0049 C32's admission policy. */
  userNamespacePolicy() {
    return assertUserNamespacePolicy(this.#host.clients());
  }

  async capacity(nodePoolId: string): Promise<KubernetesCapacityObservation> {
    const facts = await this.#requiredFacts().nodePool(nodePoolId);
    return {
      nodePoolId,
      totalVmCount: facts.capacityRows.length,
      liveVmCount: facts.capacityRows.filter((row) => row.endedAt === null)
        .length,
      failedLaunches: facts.failedLaunches,
    };
  }

  async capacityIdentities(nodePoolId: string) {
    const facts = await this.#requiredFacts().nodePool(nodePoolId);
    return facts.capacityRows.map((row) => ({
      vmRowId: row.id,
      cloudId: row.cloudId,
    }));
  }

  async connection(
    nodePoolId: string,
  ): Promise<KubernetesConnectionObservation> {
    const facts = await this.#requiredFacts().nodePool(nodePoolId);
    if (!facts.kubernetesIdentity || !facts.connectionRevision) {
      throw new Error(
        `Node pool ${nodePoolId} has no durable cluster connection`,
      );
    }
    return {
      nodePoolId,
      kubernetesIdentity: facts.kubernetesIdentity,
      connectionRevision: facts.connectionRevision,
    };
  }

  deleteOneCapacityHost(nodePoolId: string): Promise<string> {
    return this.deleteCapacityHost(nodePoolId);
  }

  /** One live capacity VM, or the one of this row. */
  async deleteCapacityHost(
    nodePoolId: string,
    vmRowId?: number,
  ): Promise<string> {
    const facts = await this.#requiredFacts().nodePool(nodePoolId);
    const victim = facts.capacityRows.find(
      (row) => row.endedAt === null && (vmRowId ?? row.id) === row.id,
    );
    if (!victim)
      throw new Error(`Node pool ${nodePoolId} has no live capacity VM`);
    await deleteLocalClusterVm(victim.cloudId);
    return victim.cloudId;
  }

  /** Every VM row of the pool: a failed launch never gets an IP. */
  async poolVms(nodePoolId: string) {
    return (await this.#requiredFacts().nodePool(nodePoolId)).capacityRows;
  }

  /**
   * An anycloud Pod already deleted but held by its finalizer, as a replica
   * whose outcome is still being read is (RFC 0048 S4); `release` lets it go.
   * No component label, so no product owner releases it.
   */
  async holdNodeWithFinalizer(
    nodeName: string,
  ): Promise<{ release(): Promise<void> }> {
    const name = `finalizer-${nodeName}`.slice(0, 63);
    await this.#host.clients().core.createNamespacedPod({
      namespace: 'default',
      body: {
        metadata: {
          name,
          labels: { [KUBERNETES_MANAGED_BY_LABEL]: 'anycloud' },
          finalizers: [ANYCLOUD_POD_FINALIZER],
        },
        spec: {
          nodeName,
          tolerations: [{ operator: 'Exists' }],
          containers: [
            {
              name: 'hold',
              image: this.#workloadImage,
              imagePullPolicy: 'Never',
              command: ['sleep', 'infinity'],
            },
          ],
        },
      },
    });
    await this.#kubectl(
      'delete',
      'pod',
      name,
      '--namespace=default',
      '--wait=false',
    );
    const release = async () => {
      await this.#kubectl(
        'patch',
        'pod',
        name,
        '--namespace=default',
        '--type=merge',
        '--patch={"metadata":{"finalizers":null}}',
      );
    };
    this.#cleanup.defer(`finalizer Pod ${name}`, () =>
      release().catch(() => undefined),
    );
    return { release };
  }

  async workloadPersisted(workloadId: string): Promise<boolean> {
    return (await this.#requiredFacts().workload(workloadId)).persisted;
  }

  nativeWrites(nodePoolId: string): Promise<Record<string, number>> {
    return this.#host.writesIn(nodePoolNamespace(nodePoolId));
  }

  reservationBaseUrl(): string {
    const port = this.#factsPort;
    if (!port) throw new Error('Local reservation store is not ready');
    return `http://${this.#host.publicIp}:${String(port)}/reservations`;
  }

  workloadImage(): string {
    return this.#workloadImage;
  }

  async prepareWorkloadImage(nodePoolId: string): Promise<void> {
    await this.#importImage(nodePoolId, this.#workloadImage, 'deployment');
  }

  /**
   * Pool Jobs (RFC 0044 decision 26): a managed Deployment's `runner-install`
   * copies the runner from the API's release image, built from this checkout
   * once, and its replicas run the workload image by digest. Admission reads
   * that digest and the image's Entrypoint and Cmd from `workload-image.json`,
   * which the API child's image inspection serves.
   */
  preparePoolJobImages(nodePoolId: string): Promise<void> {
    // Nodes that join later get the images through `#bootTaintedNodes`.
    let prepared = this.#poolJobImages.get(nodePoolId);
    if (!prepared) {
      prepared = this.#preparePoolJobImages(nodePoolId);
      this.#poolJobImages.set(nodePoolId, prepared);
      prepared.catch(() => this.#poolJobImages.delete(nodePoolId));
    }
    return prepared;
  }

  async #preparePoolJobImages(nodePoolId: string): Promise<void> {
    const runner = apiImageTagReference(packageJson.version);
    this.#runnerImageBuilt ??= executeLocalKubernetesCommand(
      'docker',
      [
        'build',
        '--tag',
        runner,
        '--file',
        path.join(this.#projectRoot, 'Dockerfile'),
        this.#projectRoot,
      ],
      { timeoutMs: 1_200_000 },
    );
    await this.#runnerImageBuilt;
    await this.#importImage(nodePoolId, runner, 'runner');
    const image = this.#workloadImage;
    await this.#importImage(nodePoolId, image, 'deployment');
    const facts = await this.#requiredFacts().nodePool(nodePoolId);
    const digests = await Promise.all(
      facts.capacityRows
        .filter((row) => row.endedAt === null)
        .map((node) =>
          this.#tagWorkloadDigest(localClusterNodeContainer(node.cloudId)),
        ),
    );
    const [digest] = digests;
    if (!digest || digests.some((each) => each !== digest)) {
      throw new Error(`Nodes disagree on ${image}'s digest: ${digests.join()}`);
    }
    const config = JSON.parse(
      (
        await executeLocalKubernetesCommand('docker', [
          'image',
          'inspect',
          '--format',
          '{{json .Config}}',
          image,
        ])
      ).stdout,
    ) as { Entrypoint: string[] | null; Cmd: string[] | null };
    await writeFile(
      path.join(this.#stateRoot, 'workload-image.json'),
      JSON.stringify({
        image,
        amd64Digest: digest,
        entrypoint: config.Entrypoint ?? [],
        cmd: config.Cmd ?? [],
      }),
    );
  }

  /**
   * Containerd keeps a local image under its normalized name, and the
   * kubelet resolves a digest-pinned image as `<repository>@<digest>`.
   */
  async #tagWorkloadDigest(container: string): Promise<string> {
    const named = `docker.io/library/${this.#workloadImage}`;
    const ctr = ['exec', container, 'ctr', '-n', 'k8s.io', 'images'];
    const { stdout } = await executeLocalKubernetesCommand('docker', [
      ...ctr,
      'ls',
      `name==${named}`,
    ]);
    const digest = /sha256:[0-9a-f]{64}/u.exec(stdout)?.[0];
    if (!digest) throw new Error(`No ${named} on ${container}: ${stdout}`);
    await executeLocalKubernetesCommand('docker', [
      ...ctr,
      'tag',
      '--force',
      named,
      `${named.replace(/:[^:/]+$/u, '')}@${digest}`,
    ]);
    return digest;
  }

  /**
   * Gives each Node that joined with the boot taint the images earlier Nodes
   * received, then lifts the taint, as a registry pull would let it start.
   */
  async #bootTaintedNodes(): Promise<void> {
    const { items } = await this.#host
      .clients()
      .core.listNode({ labelSelector: ATTEMPT_NODE_LABEL });
    for (const node of items) {
      if (
        !node.spec?.taints?.some(
          (taint) => taint.key === clusterLocalBootImagesTaint,
        )
      ) {
        continue;
      }
      const { stdout } = await executeLocalKubernetesCommand('docker', [
        'ps',
        '--quiet',
        '--filter',
        `label=com.anycloud.e2e-run=${this.#runId}`,
        '--filter',
        `label=com.anycloud.attempt=${node.metadata!.labels![ATTEMPT_NODE_LABEL]}`,
        '--format',
        '{{.Names}}',
      ]);
      const container = stdout.trim();
      if (!container) continue;
      for (const [image, name] of this.#bootImages) {
        await this.#importInto(container, image, name);
      }
      if (this.#bootImages.has(this.#workloadImage)) {
        await this.#tagWorkloadDigest(container);
      }
      await this.#kubectl(
        'taint',
        'node',
        node.metadata!.name!,
        `${clusterLocalBootImagesTaint}-`,
      );
    }
  }

  #kubectl(...args: string[]) {
    return executeLocalKubernetesCommand('docker', [
      'exec',
      this.#host.containerName,
      'kubectl',
      ...args,
    ]);
  }

  async #importImage(
    nodePoolId: string,
    image: string,
    name: string,
  ): Promise<void> {
    const facts = await this.#requiredFacts().nodePool(nodePoolId);
    const nodes = facts.capacityRows.filter((row) => row.endedAt === null);
    if (nodes.length === 0) {
      throw new Error(`Node pool ${nodePoolId} has no live capacity Nodes`);
    }
    await executeLocalKubernetesCommand(
      'docker',
      [
        'image',
        'save',
        '--output',
        path.join(this.#stateRoot, `${name}.tar`),
        image,
      ],
      { timeoutMs: 300_000 },
    );
    this.#bootImages.set(image, name);
    for (const node of nodes) {
      await this.#importInto(
        localClusterNodeContainer(node.cloudId),
        image,
        name,
      );
    }
  }

  #importInto(container: string, image: string, name: string): Promise<void> {
    const run = this.#imports.then(async () => {
      if (this.#importedImages.has(`${container} ${image}`)) return;
      const archive = path.join(this.#stateRoot, `${name}.tar`);
      const containerArchive = `/tmp/anycloud-${name}.tar`;
      await executeLocalKubernetesCommand('docker', [
        'cp',
        archive,
        `${container}:${containerArchive}`,
      ]);
      try {
        await executeLocalKubernetesCommand(
          'docker',
          [
            'exec',
            container,
            'ctr',
            '-n',
            'k8s.io',
            'images',
            'import',
            containerArchive,
          ],
          { timeoutMs: 300_000 },
        );
      } finally {
        await executeLocalKubernetesCommand('docker', [
          'exec',
          container,
          'rm',
          '-f',
          containerArchive,
        ]).catch(() => undefined);
      }
      this.#importedImages.add(`${container} ${image}`);
    });
    this.#imports = run.catch(() => undefined);
    return run;
  }

  async putReservation(
    jobId: string,
    behavior:
      | 'hold'
      | 'hold-no-cancel'
      | 'complete'
      | 'error'
      | 'retry'
      | 'oom',
  ): Promise<void> {
    await this.#requiredFacts().putReservation(jobId, behavior);
  }

  async reservationLookups(jobId: string): Promise<number> {
    return (await this.#requiredFacts().reservation(jobId)).lookupCount;
  }

  /** `api upgrade`'s drain on this API (decision 30): the Jobs it waits for. */
  async drainPoolJobs(force: boolean): Promise<readonly string[]> {
    return (await this.#requiredFacts().drain(force)).jobs.map(({ id }) => id);
  }

  async attemptLogTails(jobId: string): Promise<readonly AttemptLogTail[]> {
    return (await this.#requiredFacts().attemptTails(jobId)).attempts;
  }

  /** Every node pool lives on the one cluster; observations use its clients. */
  async clients(nodePoolId: string): Promise<KubernetesClients> {
    const facts = await this.#requiredFacts().nodePool(nodePoolId);
    const registered = this.recordedCluster();
    if (facts.kubernetesIdentity !== registered.kubernetesIdentity) {
      throw new Error(
        `Node pool ${nodePoolId} is not bound to the fixture cluster ${registered.id}`,
      );
    }
    return this.#host.clients();
  }

  async replaceController(): Promise<KubernetesControllerReplacementObservation> {
    const before = this.#process.ready;
    const endpoint = this.#endpoint.snapshot()?.url;
    if (!endpoint) throw new Error('Controller endpoint is not attached');
    this.#endpoint.detach();
    await this.#process.crash();
    await this.#startIncarnation();
    const after = this.#process.ready;
    return {
      beforeControllerInstance: `${String(before.pid)}:${before.launchNonce}`,
      afterControllerInstance: `${String(after.pid)}:${after.launchNonce}`,
      endpoint,
      scope: 'api-process',
    };
  }

  /**
   * A deleted node pool leaves no Node on the cluster and no agent container
   * on Docker; the management server itself must still be there.
   */
  async nodePoolAbsent(nodePoolId: string): Promise<boolean> {
    const nodes = await this.#host
      .clients()
      .core.listNode({ labelSelector: `anycloud.sh/node-pool=${nodePoolId}` });
    if (nodes.items.length > 0) return false;
    const { stdout } = await executeLocalKubernetesCommand('docker', [
      'ps',
      '-aq',
      '--filter',
      `label=com.anycloud.node-pool-id=${nodePoolId}`,
    ]);
    return stdout.trim() === '' && (await this.#host.exists());
  }

  async start(): Promise<void> {
    if (this.#started)
      throw new Error('Local cluster environment already started');
    await requireLocalKubernetesTools();
    await warmLocalKubernetesImage();
    const wheelDirectory = await this.#sdk.wheelDirectoryRelative();
    await executeLocalKubernetesCommand(
      'docker',
      [
        'build',
        '--tag',
        this.#workloadImage,
        '--build-arg',
        `ANYCLOUD_SDK_WHEEL_DIR=${wheelDirectory}`,
        '--file',
        path.join(
          this.#projectRoot,
          'test/docker/Dockerfile.e2e-cluster-local-deployment',
        ),
        this.#projectRoot,
      ],
      { timeoutMs: 300_000 },
    );
    await mkdir(this.#stateRoot, { recursive: true, mode: 0o700 });
    const [apiPort, factsPort] = await availablePorts(2);
    if (!apiPort || !factsPort)
      throw new Error('Could not allocate child ports');
    this.#apiPort = apiPort;
    this.#factsPort = factsPort;
    this.#cipherKey = randomBytes(32).toString('hex');
    this.#factsToken = randomBytes(32).toString('hex');
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
    // One sequential dump covers the cluster and every agent; a concurrent
    // second reader of the cluster log interleaved with it.
    await dumpLocalKubernetesDiagnostics(this.#runId, (text) =>
      this.#redactor.text(text),
    );
  }

  async #bootLoop(booting: { active: boolean }): Promise<void> {
    while (booting.active) {
      await this.#bootTaintedNodes().catch((error: unknown) => {
        process.stderr.write(`boot image import failed: ${String(error)}\n`);
      });
      await delay(2_000);
    }
  }

  async stop(): Promise<void> {
    this.#endpoint.detach();
    if (this.#booting) {
      this.#booting.active = false;
      await this.#booting.loop;
      this.#booting = undefined;
    }
    const failures: unknown[] = [];
    if (this.#diagnosedAt) {
      // The failure dump precedes cleanup; what the cluster and agents did while
      // the fallback cleanup ran is the other half of the story.
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
    this.#importedImages.clear();
    await executeLocalKubernetesCommand('docker', [
      'image',
      'rm',
      this.#workloadImage,
    ]).catch((error: unknown) => failures.push(error));
    this.#facts = undefined;
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
    const factsPort = this.#factsPort;
    const factsToken = this.#factsToken;
    const cipherKey = this.#cipherKey;
    if (!apiPort || !factsPort || !factsToken || !cipherKey) {
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
        factsPort,
        factsToken,
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
    // The hosted API runs on the management node, so it shares its CPUs.
    const pin = this.#management ? ['-c', this.#management.cpus] : [];
    const ready = await this.#process.start({
      executable: this.#management ? 'taskset' : process.execPath,
      args: [
        ...(this.#management ? [...pin, process.execPath] : []),
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
    this.#facts = new LocalKubernetesFactsClient(factsPort, factsToken);
    await this.#facts.workload(`readiness-${launchNonce}`);
  }

  #requiredFacts(): LocalKubernetesFactsClient {
    if (!this.#facts) throw new Error('Local cluster environment is not ready');
    return this.#facts;
  }

  async #assertAbsent(): Promise<void> {
    if (await this.#host.exists()) {
      throw new Error('Local cluster K3s server container is still present');
    }
    for (const nodePoolId of this.#nodePoolIds) {
      if (
        await localKubernetesCommandSucceeds('docker', [
          'network',
          'inspect',
          clusterLocalCapacityNetwork(nodePoolId),
        ])
      ) {
        throw new Error(
          `Local capacity network for ${nodePoolId} is still present`,
        );
      }
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
    if (this.#factsPort && !(await portIsClosed(this.#factsPort))) {
      throw new Error(`Local facts port ${this.#factsPort} is still open`);
    }
  }
}

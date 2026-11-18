import {
  CoordinationV1Api,
  CoreV1Api,
  type KubeConfig,
  type V1Pod,
} from '@kubernetes/client-node';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import {
  ATTEMPT_NODE_LABEL,
  NODE_POOL_NODE_LABEL,
  nodePoolNamespace,
} from '../../../../../../src/api/services/kubernetes/node-pool-scheduling.js';
import { quantity } from '../../../../../../src/api/services/pool-fit.js';
import type { ArtifactStore } from '../../artifacts.js';
import type { CleanupStack } from '../../cleanup.js';
import {
  CHECK_IMAGE,
  type PoolChecksPort,
  type PoolJob,
  type PoolNode,
  type PoolPod,
} from '../../contracts/pool-checks.js';
import type { HostedApiStage } from './hosted-stage.js';

const SYSTEM_NAMESPACE = 'kube-system';
/** The GPU-probe check's label on a Node whose GPUs failed their check. */
const UNUSABLE_GPU_LABEL = 'anycloud.sh/unusable-gpu';
/** How long a host shell Pod may take to pull, run and end. */
const HOST_SHELL_MS = 5 * 60_000;

const bytes = (raw: string | undefined): number | null =>
  raw === undefined ? null : quantity(raw);

/**
 * The pool live checks' port: reads and host access through the
 * installer's own cluster connection, every workload and pool through the
 * hosted API with this tree's CLI.
 */
export interface CloudPoolChecksOptions {
  readonly hosted: Pick<
    HostedApiStage,
    | 'checkPool'
    | 'checkJob'
    | 'stageInput'
    | 'readBucketObject'
    | 'status'
    | 'logs'
    | 'terminate'
    | 'deleteNodePool'
    | 'publishedUrl'
    | 'watchRequests'
  >;
  readonly kubeConfig: () => Promise<KubeConfig>;
  readonly poolInstances: (nodePoolId: string) => Promise<readonly string[]>;
  readonly coldStart: PoolChecksPort['coldStart'];
  readonly recordNodePool: (nodePoolId: string) => void;
  readonly artifacts: Pick<ArtifactStore, 'json'>;
  readonly cleanup: Pick<CleanupStack, 'defer'>;
}

export class CloudPoolChecks implements PoolChecksPort {
  readonly #o: CloudPoolChecksOptions;

  constructor(options: CloudPoolChecksOptions) {
    this.#o = options;
  }

  async #clients() {
    const config = await this.#o.kubeConfig();
    return {
      core: config.makeApiClient(CoreV1Api),
      leases: config.makeApiClient(CoordinationV1Api),
    };
  }

  async nodes(nodePoolId: string): Promise<readonly PoolNode[]> {
    const { core, leases } = await this.#clients();
    const { items } = await core.listNode({
      labelSelector: `${NODE_POOL_NODE_LABEL}=${nodePoolId}`,
    });
    return Promise.all(
      items.map(async (node) => {
        const name = node.metadata!.name!;
        const lease = await leases
          .readNamespacedLease({ name, namespace: 'kube-node-lease' })
          .catch(() => undefined);
        const renewed = lease?.spec?.renewTime;
        return {
          name,
          ready:
            node.status?.conditions?.some(
              (c) => c.type === 'Ready' && c.status === 'True',
            ) ?? false,
          unschedulable: node.spec?.unschedulable === true,
          unusableGpu: UNUSABLE_GPU_LABEL in (node.metadata?.labels ?? {}),
          attempt: node.metadata?.labels?.[ATTEMPT_NODE_LABEL] ?? null,
          bootId: node.status?.nodeInfo?.bootID ?? '',
          leaseRenewedAt: renewed ? new Date(renewed).getTime() : null,
          allocatableMemoryBytes: bytes(node.status?.allocatable?.memory) ?? 0,
        };
      }),
    );
  }

  async bootstrapTokenAttempts(nodePoolId: string): Promise<readonly string[]> {
    const { core } = await this.#clients();
    const { items } = await core.listNamespacedSecret({
      namespace: SYSTEM_NAMESPACE,
      labelSelector: `${NODE_POOL_NODE_LABEL}=${nodePoolId}`,
    });
    return items
      .filter((secret) => secret.type === 'bootstrap.kubernetes.io/token')
      .map((secret) => secret.metadata?.labels?.[ATTEMPT_NODE_LABEL] ?? '');
  }

  /**
   * A privileged `hostPID` Pod pinned to the Node and tolerating every taint
   * runs `script`, which reaches the host through `nsenter`. Returns its
   * name and deletion, also registered for cleanup in case the run is cut.
   */
  async #startShell(nodeName: string, script: string) {
    const { core } = await this.#clients();
    const name = `e2e-host-shell-${randomUUID().slice(0, 8)}`;
    const deletePod = () =>
      core.deleteNamespacedPod({ name, namespace: SYSTEM_NAMESPACE }).then(
        () => undefined,
        () => undefined,
      );
    const registration = this.#o.cleanup.defer(
      `host shell Pod ${name}`,
      deletePod,
    );
    const remove = async () => {
      await deletePod();
      registration.complete();
    };
    await core
      .createNamespacedPod({
        namespace: SYSTEM_NAMESPACE,
        body: {
          metadata: { name, labels: { 'app.kubernetes.io/managed-by': 'e2e' } },
          spec: {
            nodeName,
            hostPID: true,
            restartPolicy: 'Never',
            tolerations: [{ operator: 'Exists' }],
            automountServiceAccountToken: false,
            containers: [
              {
                name: 'shell',
                image: CHECK_IMAGE,
                command: ['sh', '-c', script],
                securityContext: { privileged: true },
              },
            ],
          },
        },
      })
      .catch(async (error: unknown) => {
        await remove();
        throw error;
      });
    return { name, remove };
  }

  async startHostShell(nodeName: string, script: string) {
    return (await this.#startShell(nodeName, script)).remove;
  }

  /** The shell's log once its Pod ends; the Pod is deleted either way. */
  async hostShell(nodeName: string, script: string): Promise<string> {
    const { name, remove } = await this.#startShell(nodeName, script);
    try {
      const { core } = await this.#clients();
      const deadline = Date.now() + HOST_SHELL_MS;
      let pod: V1Pod;
      do {
        await delay(3_000);
        pod = await core.readNamespacedPod({
          name,
          namespace: SYSTEM_NAMESPACE,
        });
      } while (
        pod.status?.phase !== 'Succeeded' &&
        pod.status?.phase !== 'Failed' &&
        Date.now() < deadline
      );
      const log = await core.readNamespacedPodLog({
        name,
        namespace: SYSTEM_NAMESPACE,
      });
      if (pod.status?.phase !== 'Succeeded') {
        throw new Error(
          `host shell on ${nodeName} ended ${String(pod.status?.phase)}: ${log}`,
        );
      }
      return log;
    } finally {
      await remove();
    }
  }

  instances(nodePoolId: string): Promise<readonly string[]> {
    return this.#o.poolInstances(nodePoolId);
  }

  async pods(nodePoolId: string): Promise<readonly PoolPod[]> {
    const { core } = await this.#clients();
    const { items } = await core.listNamespacedPod({
      namespace: nodePoolNamespace(nodePoolId),
    });
    return items.map((pod) => {
      const resources = pod.spec?.containers[0]?.resources;
      const cpu = resources?.requests?.cpu;
      return {
        uid: pod.metadata!.uid!,
        name: pod.metadata!.name!,
        nodeName: pod.spec?.nodeName ?? null,
        phase: pod.status?.phase ?? 'Unknown',
        unschedulable:
          pod.status?.conditions?.some(
            (c) =>
              c.type === 'PodScheduled' &&
              c.status === 'False' &&
              c.reason === 'Unschedulable',
          ) ?? false,
        createdAt: pod.metadata?.creationTimestamp
          ? new Date(pod.metadata.creationTimestamp).getTime()
          : 0,
        cpuRequestMilli: cpu === undefined ? null : quantity(cpu, 1000),
        memoryRequestBytes: bytes(resources?.requests?.memory),
        memoryLimitBytes: bytes(resources?.limits?.memory),
        ephemeralStorageRequestBytes: bytes(
          resources?.requests?.['ephemeral-storage'],
        ),
        gpus: bytes(resources?.requests?.['nvidia.com/gpu']) ?? 0,
        runnerImage:
          pod.spec?.initContainers?.find((c) => c.name === 'runner-install')
            ?.image ?? null,
      };
    });
  }

  coldStart(nodePoolId: string, podUid: string) {
    return this.#o.coldStart(nodePoolId, podUid);
  }

  createPool(
    label: string,
    spec: Parameters<PoolChecksPort['createPool']>[1],
  ): Promise<string> {
    return this.#o.hosted.checkPool(label, spec, this.#o.recordNodePool);
  }

  deletePool(nodePoolId: string): Promise<void> {
    return this.#o.hosted.deleteNodePool(nodePoolId);
  }

  stageInput(size: number): Promise<string> {
    return this.#o.hosted.stageInput(size);
  }

  submitJob(
    label: string,
    nodePoolId: string,
    spec: Parameters<PoolChecksPort['submitJob']>[2],
  ): Promise<string> {
    return this.#o.hosted.checkJob(label, nodePoolId, spec);
  }

  /** In `kube-system`, pinned to the Node and tolerating every taint. */
  async victim(nodeName: string, marker: string) {
    const { core } = await this.#clients();
    const name = `e2e-victim-${randomUUID().slice(0, 8)}`;
    const namespace = SYSTEM_NAMESPACE;
    const remove = async () => {
      await core.deleteNamespacedPod({ name, namespace }).catch(() => null);
      await core.deleteNamespacedSecret({ name, namespace }).catch(() => null);
    };
    const registration = this.#o.cleanup.defer(`victim ${name}`, remove);
    await core.createNamespacedSecret({
      namespace,
      body: { metadata: { name }, stringData: { token: marker } },
    });
    await core.createNamespacedPod({
      namespace,
      body: {
        metadata: { name },
        spec: {
          nodeName,
          tolerations: [{ operator: 'Exists' }],
          automountServiceAccountToken: false,
          containers: [
            {
              name: 'victim',
              image: CHECK_IMAGE,
              command: ['sleep', '3600'],
              envFrom: [{ secretRef: { name } }],
              volumeMounts: [{ name: 'secret', mountPath: '/secret' }],
            },
          ],
          volumes: [{ name: 'secret', secret: { secretName: name } }],
        },
      },
    });
    return async () => {
      await remove();
      registration.complete();
    };
  }

  async job(id: string): Promise<PoolJob> {
    const status = await this.#o.hosted.status(id);
    if (status === 'absent') throw new Error(`Job ${id} is gone`);
    return {
      state: status.workload.state,
      events: status.events.map((event) => ({
        state: event.state,
        text: JSON.stringify(event.metadata ?? {}),
        podUid:
          typeof event.metadata?.podUid === 'string'
            ? event.metadata.podUid
            : null,
        at: event.createdAt,
      })),
    };
  }

  jobLog(id: string): Promise<string> {
    return this.#o.hosted.logs(id);
  }

  readOutput(bucket: string, key: string): Promise<string> {
    return this.#o.hosted.readBucketObject(bucket, key);
  }

  terminateJob(id: string): Promise<void> {
    return this.#o.hosted.terminate(id, 'Job');
  }

  async publishedService(serviceId: string) {
    const { url, ip } = await this.#o.hosted.publishedUrl(
      serviceId,
      () => true,
    );
    return { url: url.href, ip };
  }

  async entryIp(serviceId: string): Promise<string | null> {
    const status = await this.#o.hosted.status(serviceId);
    return status === 'absent'
      ? null
      : (status.workload.publicEndpoint?.ip ?? null);
  }

  watchRequests(url: string) {
    return this.#o.hosted.watchRequests(new URL(url));
  }

  async record(name: string, value: unknown): Promise<void> {
    await this.#o.artifacts.json(name, value);
  }
}

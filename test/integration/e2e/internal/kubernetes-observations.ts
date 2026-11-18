import type { KubernetesClients } from '../../../../src/api/services/kubernetes/client.js';
import { KUBERNETES_DEPLOYMENT_CONTAINER } from '../../../../src/api/services/kubernetes/pool-objects.js';
import {
  KUBERNETES_GENERATION_ANNOTATION,
  kubernetesWorkloadPodSelector,
  kubernetesWorkloadResourceName,
  kubernetesWorkloadSecretName,
} from '../../../../src/api/services/kubernetes/identity.js';

import type {
  DeploymentWorkObservation,
  DeploymentReceiveObservation,
} from './targets/cluster-node-pool.js';
import { nodePoolNamespace } from '../../../../src/api/services/kubernetes/node-pool-scheduling.js';
import { kubernetesStatusCode } from './kubernetes-client.js';
import type {
  KubernetesOwnedObjectUids,
  ReplicaPodFacts,
} from './targets/cluster-node-pool.js';
import { KubernetesApiReads } from './kubernetes-reads.js';

export interface KubernetesDeploymentReadyFacts {
  readonly availableReplicas: number;
  readonly containerId: string;
  readonly workloadName: string;
  readonly generation: number;
  readonly podName: string;
  readonly podUid: string;
  readonly nodeName: string;
  readonly imageId: string;
  readonly runtimeClassName: string | null;
  readonly requestedGpus: number;
}

export interface KubernetesDeploymentAbsenceFacts {
  readonly workloads: number;
  readonly pods: number;
  readonly replicaSets: number;
  readonly secrets: number;
  readonly serviceAccounts: number;
}

export function deploymentWorkStarts(logs: string, jobId: string): string[] {
  const executionIds: string[] = [];
  for (const line of logs.split(/\r?\n/u)) {
    if (!line.startsWith('WORK_STARTED ')) continue;
    const marker: unknown = JSON.parse(line.slice('WORK_STARTED '.length));
    if (
      !marker ||
      typeof marker !== 'object' ||
      !('jobId' in marker) ||
      !('executionId' in marker) ||
      typeof marker.executionId !== 'string'
    ) {
      throw new Error('Invalid Deployment work-start marker');
    }
    if (marker.jobId === jobId) executionIds.push(marker.executionId);
  }
  return executionIds;
}

export function deploymentReceiveObservation(
  logs: string,
  observedAt: number,
  jobId?: string,
): DeploymentReceiveObservation | null {
  const receives = new Map<number, DeploymentReceiveObservation>();
  for (const line of logs.split(/\r?\n/u)) {
    const start = line.startsWith('RECEIVE_STARTED ');
    if (!start && !line.startsWith('RECEIVE_FINISHED ')) continue;
    const value: unknown = JSON.parse(
      line.slice(
        start ? 'RECEIVE_STARTED '.length : 'RECEIVE_FINISHED '.length,
      ),
    );
    if (
      !value ||
      typeof value !== 'object' ||
      !('sequence' in value) ||
      typeof value.sequence !== 'number' ||
      !Number.isSafeInteger(value.sequence)
    )
      throw new Error('Invalid Deployment receive marker');
    if (start) {
      if (
        !('startedAt' in value) ||
        typeof value.startedAt !== 'number' ||
        !Number.isSafeInteger(value.startedAt)
      )
        throw new Error('Invalid Deployment receive start');
      receives.set(value.sequence, {
        sequence: value.sequence,
        startedAt: value.startedAt,
        returnedAt: null,
        jobId: null,
        probeSucceededAt: null,
        observedAt,
      });
    } else {
      if (
        !('returnedAt' in value) ||
        typeof value.returnedAt !== 'number' ||
        !Number.isSafeInteger(value.returnedAt) ||
        !('jobId' in value) ||
        (value.jobId !== null && typeof value.jobId !== 'string') ||
        !('probeSucceededAt' in value) ||
        (value.probeSucceededAt !== null &&
          (typeof value.probeSucceededAt !== 'number' ||
            !Number.isSafeInteger(value.probeSucceededAt)))
      )
        throw new Error('Invalid Deployment receive result');
      const previous = receives.get(value.sequence);
      // A bounded log tail can start after a receive's opening marker.
      if (previous)
        receives.set(value.sequence, {
          ...previous,
          returnedAt: value.returnedAt,
          jobId: value.jobId,
          probeSucceededAt: value.probeSucceededAt,
        });
    }
  }
  return (
    [...receives.values()]
      .reverse()
      .find((receive) => jobId === undefined || receive.jobId === jobId) ?? null
  );
}

export type KubernetesClientLoader = (
  nodePoolId: string,
) => Promise<KubernetesClients>;

async function resourceCount(read: () => Promise<unknown>): Promise<number> {
  try {
    await read();
    return 1;
  } catch (error) {
    if (kubernetesStatusCode(error) === 404) return 0;
    throw error;
  }
}

/** Concrete Deployment observations shared by local and hosted substrates. */
export class KubernetesWorkloadObservations {
  readonly #loadClients: KubernetesClientLoader;
  readonly #reads: KubernetesApiReads;

  constructor(
    loadClients: KubernetesClientLoader,
    reads = new KubernetesApiReads(),
  ) {
    this.#loadClients = loadClients;
    this.#reads = reads;
  }

  async deploymentReady(
    nodePoolId: string,
    deploymentId: string,
  ): Promise<KubernetesDeploymentReadyFacts | null> {
    const clients = await this.#loadClients(nodePoolId);
    const workloadName = kubernetesWorkloadResourceName(
      'deployment',
      deploymentId,
    );
    const workload = await this.#reads
      .read(`Deployment ${nodePoolId}/${deploymentId} readiness`, (options) =>
        clients.apps.readNamespacedDeployment(
          {
            namespace: nodePoolNamespace(nodePoolId),
            name: workloadName,
          },
          options,
        ),
      )
      .catch((error: unknown) => {
        if (kubernetesStatusCode(error) === 404) return null;
        throw error;
      });
    if (!workload || workload.status?.availableReplicas !== 1) return null;
    const pods = await this.#reads.read(
      `Deployment ${nodePoolId}/${deploymentId} Pods`,
      (options) =>
        clients.core.listNamespacedPod(
          {
            namespace: nodePoolNamespace(nodePoolId),
            labelSelector: kubernetesWorkloadPodSelector(deploymentId),
          },
          options,
        ),
    );
    const pod = pods.items.find((candidate) =>
      candidate.status?.conditions?.some(
        (condition) =>
          condition.type === 'Ready' && condition.status === 'True',
      ),
    );
    const container = pod?.status?.containerStatuses?.find(
      (candidate) => candidate.name === KUBERNETES_DEPLOYMENT_CONTAINER,
    );
    const generation = Number(
      pod?.metadata?.annotations?.[KUBERNETES_GENERATION_ANNOTATION],
    );
    if (
      !pod?.metadata?.name ||
      !pod.metadata.uid ||
      !pod.spec?.nodeName ||
      !container?.imageID ||
      container?.ready !== true ||
      !container.containerID ||
      !Number.isSafeInteger(generation) ||
      generation <= 0
    ) {
      return null;
    }
    return {
      availableReplicas: workload.status.availableReplicas,
      containerId: container.containerID,
      workloadName,
      generation,
      podName: pod.metadata.name,
      podUid: pod.metadata.uid,
      nodeName: pod.spec.nodeName,
      imageId: container.imageID,
      runtimeClassName: pod.spec.runtimeClassName ?? null,
      requestedGpus: Number(
        pod.spec.containers.find(
          (entry) => entry.name === KUBERNETES_DEPLOYMENT_CONTAINER,
        )?.resources?.requests?.['nvidia.com/gpu'] ?? 0,
      ),
    };
  }

  /** The UIDs of a Deployment's env Secret and ServiceAccount, if present. */
  async deploymentOwnedObjects(
    nodePoolId: string,
    deploymentId: string,
  ): Promise<KubernetesOwnedObjectUids> {
    const clients = await this.#loadClients(nodePoolId);
    const namespace = nodePoolNamespace(nodePoolId);
    const uid = (read: () => Promise<{ metadata?: { uid?: string } }>) =>
      read().then(
        (object) => object.metadata?.uid ?? null,
        (error: unknown) => {
          if (kubernetesStatusCode(error) === 404) return null;
          throw error;
        },
      );
    return {
      secretUid: await uid(() =>
        clients.core.readNamespacedSecret({
          namespace,
          name: kubernetesWorkloadSecretName(
            'deployment',
            deploymentId,
            'application-env',
          ),
        }),
      ),
      serviceAccountUid: await uid(() =>
        clients.core.readNamespacedServiceAccount({
          namespace,
          name: kubernetesWorkloadResourceName('deployment', deploymentId),
        }),
      ),
    };
  }

  /**
   * One replica Pod's finalizers and hardening. The read keeps the whole Pod
   * list, as `kubectl get pod -o json` shows it, as an artifact.
   */
  /** Every Pod the Deployment's selector matches, terminating ones too. */
  async deploymentPodCount(
    nodePoolId: string,
    deploymentId: string,
  ): Promise<number> {
    const clients = await this.#loadClients(nodePoolId);
    const pods = await this.#reads.read(
      `Deployment ${nodePoolId}/${deploymentId} Pods`,
      (options) =>
        clients.core.listNamespacedPod(
          {
            namespace: nodePoolNamespace(nodePoolId),
            labelSelector: kubernetesWorkloadPodSelector(deploymentId),
          },
          options,
        ),
    );
    return pods.items.length;
  }

  async deploymentPod(
    nodePoolId: string,
    deploymentId: string,
    podUid: string,
  ): Promise<ReplicaPodFacts | null> {
    const clients = await this.#loadClients(nodePoolId);
    const pods = await this.#reads.read(
      `Deployment ${nodePoolId}/${deploymentId} Pod ${podUid}`,
      (options) =>
        clients.core.listNamespacedPod(
          {
            namespace: nodePoolNamespace(nodePoolId),
            labelSelector: kubernetesWorkloadPodSelector(deploymentId),
          },
          options,
        ),
    );
    const pod = pods.items.find((item) => item.metadata?.uid === podUid);
    if (!pod) return null;
    const security = pod.spec?.containers.find(
      (container) => container.name === KUBERNETES_DEPLOYMENT_CONTAINER,
    )?.securityContext;
    const state = pod.status?.containerStatuses?.find(
      (container) => container.name === KUBERNETES_DEPLOYMENT_CONTAINER,
    )?.state;
    return {
      finalizers: pod.metadata?.finalizers ?? [],
      deleting: !!pod.metadata?.deletionTimestamp,
      containerStopped: !state?.running,
      seccompProfile: security?.seccompProfile?.type ?? null,
      privilegeEscalation: security?.allowPrivilegeEscalation ?? null,
      qosClass: pod.status?.qosClass ?? null,
      nodeName: pod.spec?.nodeName ?? null,
    };
  }

  /** Delete one natively, as an operator's `kubectl delete` would. */
  async deleteDeploymentOwnedObject(
    nodePoolId: string,
    deploymentId: string,
    kind: 'Secret' | 'ServiceAccount',
  ): Promise<void> {
    const clients = await this.#loadClients(nodePoolId);
    const namespace = nodePoolNamespace(nodePoolId);
    if (kind === 'Secret') {
      await clients.core.deleteNamespacedSecret({
        namespace,
        name: kubernetesWorkloadSecretName(
          'deployment',
          deploymentId,
          'application-env',
        ),
      });
    } else {
      await clients.core.deleteNamespacedServiceAccount({
        namespace,
        name: kubernetesWorkloadResourceName('deployment', deploymentId),
      });
    }
  }

  async deleteReadyPod(
    nodePoolId: string,
    deploymentId: string,
    observedPodUid: string,
  ): Promise<string> {
    if (!observedPodUid)
      throw new Error(
        `Deployment ${deploymentId} omitted its observed Pod UID`,
      );
    const clients = await this.#loadClients(nodePoolId);
    const pods = await this.#reads.read(
      `Deployment ${nodePoolId}/${deploymentId} Pod identity`,
      (options) =>
        clients.core.listNamespacedPod(
          {
            namespace: nodePoolNamespace(nodePoolId),
            labelSelector: kubernetesWorkloadPodSelector(deploymentId),
          },
          options,
        ),
    );
    const pod = pods.items.find(
      (candidate) => candidate.metadata?.uid === observedPodUid,
    );
    if (!pod?.metadata?.name)
      throw new Error(
        `Deployment ${deploymentId} has no Pod at observed UID ${observedPodUid}`,
      );
    // Readiness can change after the caller observes it. Inject the fault into
    // that exact Pod, with the native UID precondition fencing a later replacement.
    await clients.core.deleteNamespacedPod({
      namespace: nodePoolNamespace(nodePoolId),
      name: pod.metadata.name,
      body: { preconditions: { uid: observedPodUid } },
    });
    return observedPodUid;
  }

  async deploymentLogContains(
    nodePoolId: string,
    deploymentId: string,
    podUid: string,
    line: string,
  ): Promise<boolean> {
    const clients = await this.#loadClients(nodePoolId);
    const pods = await this.#reads.read(
      `Deployment ${nodePoolId}/${deploymentId} Pods`,
      (options) =>
        clients.core.listNamespacedPod(
          {
            namespace: nodePoolNamespace(nodePoolId),
            labelSelector: kubernetesWorkloadPodSelector(deploymentId),
          },
          options,
        ),
    );
    // Warmup evidence must remain readable before the native probe succeeds.
    const pod = pods.items.find(
      (candidate) => candidate.metadata?.uid === podUid,
    );
    const podName = pod?.metadata?.name;
    if (!podName) return false;
    const logs = await this.#reads.read(
      `Deployment ${nodePoolId}/${deploymentId} Pod ${podUid} logs`,
      (options) =>
        clients.core.readNamespacedPodLog(
          {
            namespace: nodePoolNamespace(nodePoolId),
            name: podName,
            container: KUBERNETES_DEPLOYMENT_CONTAINER,
          },
          options,
        ),
    );
    return logs.split(/\r?\n/u).includes(line);
  }

  async deploymentReceive(
    nodePoolId: string,
    deploymentId: string,
    podUid: string,
    jobId?: string,
  ): Promise<DeploymentReceiveObservation | null> {
    const clients = await this.#loadClients(nodePoolId);
    const pods = await this.#reads.read(
      `Deployment ${nodePoolId}/${deploymentId} Pods for receive evidence`,
      (options) =>
        clients.core.listNamespacedPod(
          {
            namespace: nodePoolNamespace(nodePoolId),
            labelSelector: kubernetesWorkloadPodSelector(deploymentId),
          },
          options,
        ),
    );
    const pod = pods.items.find(
      (candidate) => candidate.metadata?.uid === podUid,
    );
    const podName = pod?.metadata?.name;
    if (!podName) return null;
    const logs = await this.#reads.read(
      `Deployment ${nodePoolId}/${deploymentId} Pod ${podUid} receive logs`,
      (options) =>
        clients.core.readNamespacedPodLog(
          {
            namespace: nodePoolNamespace(nodePoolId),
            name: podName,
            container: KUBERNETES_DEPLOYMENT_CONTAINER,
            tailLines: 200,
          },
          options,
        ),
    );
    return deploymentReceiveObservation(logs, Date.now(), jobId);
  }

  async deploymentWorkStarted(
    nodePoolId: string,
    deploymentId: string,
    jobId: string,
  ): Promise<DeploymentWorkObservation | null> {
    const ready = await this.deploymentReady(nodePoolId, deploymentId);
    if (!ready) return null;
    const clients = await this.#loadClients(nodePoolId);
    const logs = await this.#reads.read(
      `Deployment ${nodePoolId}/${deploymentId} Pod ${ready.podUid} logs`,
      (options) =>
        clients.core.readNamespacedPodLog(
          {
            namespace: nodePoolNamespace(nodePoolId),
            name: ready.podName,
            container: KUBERNETES_DEPLOYMENT_CONTAINER,
          },
          options,
        ),
    );
    return {
      generation: ready.generation,
      podUid: ready.podUid,
      containerId: ready.containerId,
      imageId: ready.imageId,
      executionIds: deploymentWorkStarts(logs, jobId),
    };
  }

  /**
   * A node pool Service owns one namespace on the cluster; once the Service is
   * cleaned up that namespace must be gone, not merely emptied.
   */
  async serviceNamespaceAbsent(
    nodePoolId: string,
    workloadId: string,
  ): Promise<boolean> {
    const clients = await this.#loadClients(nodePoolId);
    const name = kubernetesWorkloadResourceName('serve', workloadId);
    return resourceCount(() =>
      this.#reads.read(
        `Service ${nodePoolId}/${workloadId} namespace absence`,
        (options) => clients.core.readNamespace({ name }, options),
      ),
    ).then((count) => count === 0);
  }

  /** When the Service's Pod first became Ready (ms), or null without a Ready Pod. */
  async servicePodReadyAt(
    nodePoolId: string,
    workloadId: string,
  ): Promise<number | null> {
    const clients = await this.#loadClients(nodePoolId);
    const pods = await this.#reads.read(
      `Service ${nodePoolId}/${workloadId} Pod readiness`,
      (options) =>
        clients.core.listNamespacedPod(
          {
            namespace: kubernetesWorkloadResourceName('serve', workloadId),
            labelSelector: kubernetesWorkloadPodSelector(workloadId),
          },
          options,
        ),
    );
    const readyAt = pods.items
      .flatMap((pod) => pod.status?.conditions ?? [])
      .filter((c) => c.type === 'Ready' && c.status === 'True')
      .flatMap((c) => c.lastTransitionTime?.getTime() ?? []);
    return readyAt.length > 0 ? Math.min(...readyAt) : null;
  }

  async deploymentAbsent(
    nodePoolId: string,
    deploymentId: string,
  ): Promise<KubernetesDeploymentAbsenceFacts> {
    const clients = await this.#loadClients(nodePoolId);
    const name = kubernetesWorkloadResourceName('deployment', deploymentId);
    const selector = kubernetesWorkloadPodSelector(deploymentId);
    const [workloads, pods, replicaSets, secrets, serviceAccounts] =
      await Promise.all([
        resourceCount(() =>
          this.#reads.read(
            `Deployment ${nodePoolId}/${deploymentId} native object absence`,
            (options) =>
              clients.apps.readNamespacedDeployment(
                {
                  namespace: nodePoolNamespace(nodePoolId),
                  name,
                },
                options,
              ),
          ),
        ),
        this.#reads
          .read(
            `Deployment ${nodePoolId}/${deploymentId} Pods absence`,
            (options) =>
              clients.core.listNamespacedPod(
                {
                  namespace: nodePoolNamespace(nodePoolId),
                  labelSelector: selector,
                },
                options,
              ),
          )
          .then((result) => result.items.length),
        this.#reads
          .read(
            `Deployment ${nodePoolId}/${deploymentId} ReplicaSets absence`,
            (options) =>
              clients.apps.listNamespacedReplicaSet(
                {
                  namespace: nodePoolNamespace(nodePoolId),
                  labelSelector: selector,
                },
                options,
              ),
          )
          .then((result) => result.items.length),
        this.#reads
          .read(
            `Deployment ${nodePoolId}/${deploymentId} Secrets absence`,
            (options) =>
              clients.core.listNamespacedSecret(
                {
                  namespace: nodePoolNamespace(nodePoolId),
                  labelSelector: selector,
                },
                options,
              ),
          )
          .then((result) => result.items.length),
        resourceCount(() =>
          this.#reads.read(
            `Deployment ${nodePoolId}/${deploymentId} ServiceAccount absence`,
            (options) =>
              clients.core.readNamespacedServiceAccount(
                {
                  namespace: nodePoolNamespace(nodePoolId),
                  name,
                },
                options,
              ),
          ),
        ),
      ]);
    return { workloads, pods, replicaSets, secrets, serviceAccounts };
  }
}

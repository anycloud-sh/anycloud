import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { V1Pod } from '@kubernetes/client-node';

import packageJson from '../../../../../../package.json' with { type: 'json' };
import type { KubernetesClients } from '../../../../../../src/api/services/kubernetes/client.js';
import { kubernetesWorkloadPodSelector } from '../../../../../../src/api/services/kubernetes/identity.js';
import { nodePoolNamespace } from '../../../../../../src/api/services/kubernetes/node-pool-scheduling.js';
import {
  ANYCLOUD_WORKLOAD_TOKEN_AUDIENCE,
  KUBERNETES_DEPLOYMENT_CONTAINER,
} from '../../../../../../src/api/services/kubernetes/pool-objects.js';
import {
  createRunnerApi,
  FenceError,
} from '../../../../../../src/runner/api.js';
import { runRunner } from '../../../../../../src/runner/runner.js';
import { sleep } from '../../../../../../src/shared/utils.js';
import { executeLocalKubernetesCommand } from './command.js';
import { clusterLocalDockerLabel } from './constants.js';
import { DockerEngine } from './docker-engine.js';

const kwokImage =
  'registry.k8s.io/kwok/kwok:v0.8.0@sha256:6d25aa8fbdfe78845423160bf125b5513f9522e2770981f0945c2a250c2b26f0';

/**
 * KWOK's stages for S12's Nodes and Pods. A Node is Ready with room for 250
 * Pods; a Pod runs at once with a container ID, which the API's runner
 * identity requires; a deleted Pod's container stops, so the Deployment
 * owner releases its finalizer, and then the Pod goes.
 */
const stages = [
  {
    name: 'node-initialize',
    kind: 'Node',
    selector: [
      {
        key: '.status.conditions.[] | select( .type == "Ready" ) | .status',
        operator: 'NotIn',
        values: ['True'],
      },
    ],
    status: `{{ $now := Now }}
conditions:
{{ range NodeConditions }}
- lastHeartbeatTime: {{ $now | Quote }}
  lastTransitionTime: {{ $now | Quote }}
  message: {{ .message | Quote }}
  reason: {{ .reason | Quote }}
  status: {{ .status | Quote }}
  type: {{ .type | Quote }}
{{ end }}
addresses:
- address: {{ NodeIP | Quote }}
  type: InternalIP
allocatable: &room
  cpu: "64"
  memory: 256Gi
  ephemeral-storage: 1Ti
  pods: "250"
capacity: *room
nodeInfo:
  architecture: amd64
  kubeletVersion: kwok
  operatingSystem: linux
phase: Running`,
  },
  {
    name: 'pod-ready',
    kind: 'Pod',
    selector: [
      { key: '.metadata.deletionTimestamp', operator: 'DoesNotExist' },
      { key: '.spec.nodeName', operator: 'Exists' },
      { key: '.status.phase', operator: 'In', values: ['Pending'] },
    ],
    status: `{{ $now := Now }}
{{ $root := . }}
conditions:
- lastTransitionTime: {{ $now | Quote }}
  status: "True"
  type: Initialized
- lastTransitionTime: {{ $now | Quote }}
  status: "True"
  type: Ready
- lastTransitionTime: {{ $now | Quote }}
  status: "True"
  type: ContainersReady
containerStatuses:
{{ range .spec.containers }}
- containerID: {{ printf "containerd://kwok-%s-%s" $root.metadata.uid .name | Quote }}
  image: {{ .image | Quote }}
  imageID: {{ .image | Quote }}
  name: {{ .name | Quote }}
  ready: true
  restartCount: 0
  started: true
  state:
    running:
      startedAt: {{ $now | Quote }}
{{ end }}
hostIP: {{ NodeIPWith .spec.nodeName | Quote }}
podIP: {{ PodIPWith .spec.nodeName false .metadata.uid .metadata.name .metadata.namespace | Quote }}
phase: Running
startTime: {{ $now | Quote }}`,
  },
  {
    name: 'pod-stop',
    kind: 'Pod',
    selector: [
      { key: '.metadata.deletionTimestamp', operator: 'Exists' },
      {
        key: '.status.containerStatuses.[].state.running.startedAt',
        operator: 'Exists',
      },
    ],
    status: `{{ $now := Now }}
{{ $root := . }}
containerStatuses:
{{ range .status.containerStatuses }}
- containerID: {{ .containerID | Quote }}
  image: {{ .image | Quote }}
  imageID: {{ .imageID | Quote }}
  name: {{ .name | Quote }}
  ready: false
  restartCount: 0
  started: false
  state:
    terminated:
      containerID: {{ .containerID | Quote }}
      exitCode: 143
      reason: Error
      startedAt: {{ .state.running.startedAt | Quote }}
      finishedAt: {{ $now | Quote }}
{{ end }}`,
  },
  {
    name: 'pod-delete',
    kind: 'Pod',
    selector: [
      { key: '.metadata.deletionTimestamp', operator: 'Exists' },
      { key: '.metadata.finalizers', operator: 'DoesNotExist' },
    ],
    delete: true,
  },
];

function stagesYaml(): string {
  return stages
    .map((stage) =>
      JSON.stringify({
        apiVersion: 'kwok.x-k8s.io/v1alpha1',
        kind: 'Stage',
        metadata: { name: stage.name },
        spec: {
          resourceRef: { apiGroup: 'v1', kind: stage.kind },
          selector: { matchExpressions: stage.selector },
          next: stage.status
            ? { statusTemplate: stage.status }
            : { delete: true },
        },
      }),
    )
    .join('\n---\n');
}

/**
 * The KWOK controller as one container beside the cluster: it manages only
 * Nodes annotated `kwok.x-k8s.io/node=fake` (`capacity-compute.ts`) and
 * their Pods, through the cluster's admin kubeconfig. Returns its removal.
 */
export async function startKwokController(
  runId: string,
  kubeconfig: string,
): Promise<() => Promise<void>> {
  const docker = new DockerEngine();
  const name = `anycloud-kwok-${runId}`;
  if (!(await docker.hasImage(kwokImage))) await docker.pullImage(kwokImage);
  await docker.createContainer(name, {
    Image: kwokImage,
    Cmd: [
      '--kubeconfig=/etc/kwok/kubeconfig',
      '--config=/etc/kwok/stages.yaml',
      '--manage-all-nodes=false',
      '--manage-nodes-with-annotation-selector=kwok.x-k8s.io/node=fake',
      // Lease renewals keep each Node Ready, as a kubelet's do.
      '--node-lease-duration-seconds=40',
      // Every Node's stand-in address (`capacity-compute.ts` has its own).
      // The server dials it to read a replica's log tail before the owner
      // retries its Job: on loopback the server's own kubelet answers at
      // once, where an unrouted address held each tail for its 30 s
      // timeout, one at a time (run 39884318807).
      '--node-ip=127.0.0.1',
    ],
    Labels: {
      [clusterLocalDockerLabel]: 'true',
      'com.anycloud.e2e-run': runId,
      'com.anycloud.role': 'kwok',
    },
  });
  const remove = () =>
    executeLocalKubernetesCommand('docker', ['rm', '--force', name]).then(
      () => undefined,
    );
  const directory = await mkdtemp(path.join(tmpdir(), 'anycloud-kwok-'));
  try {
    for (const [file, content] of [
      ['kubeconfig', kubeconfig],
      ['stages.yaml', stagesYaml()],
    ] as const) {
      await writeFile(path.join(directory, file), content);
    }
    await executeLocalKubernetesCommand('docker', [
      'cp',
      `${directory}/.`,
      `${name}:/etc/kwok`,
    ]);
    await docker.startContainer(name);
  } catch (error) {
    await remove();
    throw error;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  return remove;
}

const running = (pod: V1Pod) =>
  !pod.metadata?.deletionTimestamp &&
  pod.status?.containerStatuses?.some(
    (status) =>
      status.name === KUBERNETES_DEPLOYMENT_CONTAINER && status.ready === true,
  ) === true;

/**
 * One production runner loop (`runRunner`) per running KWOK replica of a
 * managed Deployment, through the production claim-queue client, with a
 * token the cluster binds to that Pod. Each "command" sleeps `jobMs` and
 * exits 0; there is nothing to stage, upload or reset. A replica's loop
 * stops when its Pod is deleted, as SIGTERM stops a runner.
 */
export class KwokClaimers {
  readonly #loops = new Map<string, AbortController>();
  readonly #done: Promise<unknown>[] = [];
  readonly #directory: Promise<string> = mkdtemp(
    path.join(tmpdir(), 'anycloud-kwok-tokens-'),
  );
  #watching: Promise<void> | undefined;
  readonly #closed = new AbortController();
  #errors: unknown[] = [];

  constructor(
    private readonly clients: KubernetesClients,
    private readonly input: {
      readonly apiUrl: string;
      readonly nodePoolId: string;
      readonly deploymentId: string;
      readonly jobMs: number;
    },
  ) {}

  start(): void {
    this.#watching ??= this.#watch();
  }

  /** How many replicas have a runner loop now. */
  get size(): number {
    return this.#loops.size;
  }

  async stop(): Promise<void> {
    this.#closed.abort();
    await this.#watching;
    for (const stop of this.#loops.values()) stop.abort();
    await Promise.all(this.#done);
    await rm(await this.#directory, { recursive: true, force: true });
    if (this.#errors.length > 0) {
      throw new AggregateError(this.#errors, 'KWOK runner loops failed');
    }
  }

  async #watch(): Promise<void> {
    const namespace = nodePoolNamespace(this.input.nodePoolId);
    while (!this.#closed.signal.aborted) {
      // A loaded apiserver may fail a read; the next pass retries it. Every
      // 2 s, so the harness's own LIST stays a small share of its load.
      await this.#pass(namespace).catch(() => undefined);
      await sleep(2_000, this.#closed.signal).catch(() => undefined);
    }
  }

  async #pass(namespace: string): Promise<void> {
    const pods = await this.clients.core.listNamespacedPod({
      namespace,
      labelSelector: kubernetesWorkloadPodSelector(this.input.deploymentId),
    });
    const live = new Set<string>();
    for (const pod of pods.items) {
      const uid = pod.metadata!.uid!;
      if (!running(pod)) continue;
      live.add(uid);
      if (!this.#loops.has(uid)) await this.#run(pod);
    }
    for (const [uid, stop] of this.#loops) {
      if (live.has(uid)) continue;
      stop.abort();
      this.#loops.delete(uid);
    }
  }

  async #exists(pod: V1Pod): Promise<boolean> {
    const { name, namespace, uid } = pod.metadata!;
    return this.clients.core
      .readNamespacedPod({ name: name!, namespace: namespace! })
      .then((current) => current.metadata?.uid === uid)
      .catch((error: unknown) => {
        if ((error as { code?: number }).code === 404) return false;
        throw error;
      });
  }

  async #run(pod: V1Pod): Promise<void> {
    const { name, namespace, uid } = pod.metadata!;
    const request = await this.clients.core.createNamespacedServiceAccountToken(
      {
        name: pod.spec!.serviceAccountName!,
        namespace: namespace!,
        body: {
          spec: {
            audiences: [ANYCLOUD_WORKLOAD_TOKEN_AUDIENCE],
            expirationSeconds: 3_600,
            boundObjectRef: { apiVersion: 'v1', kind: 'Pod', name, uid },
          },
        },
      },
    );
    const tokenFile = path.join(await this.#directory, uid!);
    await writeFile(tokenFile, request.status!.token, { mode: 0o600 });
    const stop = new AbortController();
    const done = runRunner(
      {
        api: createRunnerApi({
          apiUrl: this.input.apiUrl,
          deploymentId: this.input.deploymentId,
          tokenFile,
          release: packageJson.version,
          log: () => undefined,
          // A deleted Pod's token no longer authenticates, and the runner
          // retries a 401 without end; in a cluster SIGTERM ends it. Here a
          // 401 for a Pod that is gone is the fence it stops on.
          fetch: async (url, init) => {
            const response = await fetch(url, init);
            if (response.status !== 401 || (await this.#exists(pod))) {
              return response;
            }
            return new Response('its Pod is gone', { status: 409 });
          },
        }),
        copy: () =>
          Promise.resolve({ result: 'done', detail: '', moved: false }),
        entrypoint: [],
        cmd: [],
        stopGraceMs: 1_000,
        start: () => sleep(this.input.jobMs).then(() => 0),
        killAll: () => undefined,
        oomKills: () => Promise.resolve(0),
        reset: () => Promise.resolve(),
        empty: () => Promise.resolve(),
        log: () => undefined,
      },
      stop.signal,
    ).catch(async (error: unknown) => {
      // KWOK removes a deleted Pod at once, before the next pass stops its
      // loop; in a cluster its runner would have had SIGTERM. A fence on a
      // Pod that is gone is that stop, not a failure.
      if (error instanceof FenceError && !(await this.#exists(pod))) return;
      this.#errors.push(error);
    });
    this.#loops.set(uid!, stop);
    this.#done.push(done);
  }
}

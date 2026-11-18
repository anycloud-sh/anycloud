import {
  ApiextensionsV1Api,
  BatchV1Api,
  KubernetesObjectApi,
  PatchStrategy,
  type CoreV1Api,
  type CoreV1Event,
  type V1Pod,
} from '@kubernetes/client-node';
import { errorMessage } from '../../shared/log-diagnostics.js';
import { redactSecrets } from './redact.js';
import { HELM_INSTALL_JOB } from './system-release/ready-job.js';
import type { CloudConfig } from '../../shared/cloud.js';
import { extractCredentials } from '../../shared/cloud-config.js';
import { SYSTEM_RELEASE_KUBERNETES_PORT } from '../../shared/system-release.js';
import {
  createComputeProvider,
  createStorageProvider,
  decryptCredential,
} from './cloud-config.js';
import type { IngressSpec } from './entities.js';
import {
  canManageCloudResources,
  VMReleaseState,
  type CloudCompute,
  type CloudStorage,
  type CloudResourceCompute,
} from './gateways/cloud.js';
import {
  createHostCommandTransport,
  type HostCommandTransport,
} from './gateways/host-command-transport.js';
import { CLOUDFLARE_IP_RANGES } from '../../shared/cloudflare-ips.js';
import { PUBLIC_SOURCE_RANGES, SSH_PORT } from './network.js';
import { createKubernetesClients } from './kubernetes/client.js';
import {
  kubeConfigFromClusterConnection,
  type ClusterConnectionDocument,
} from './kubernetes/cluster-connection.js';
import {
  type NamedCredential,
  type ManagementHostAccess,
  type ManagementHostExecOutcome,
  type ClusterInfrastructure,
  type ClusterTarget,
  type ClusterReleaseClient,
} from './clusters-domain.js';
import { ClusterReleaseConflictError } from './cluster-errors.js';
import type { HelmChartObject } from '../../shared/system-release-values.js';
import {
  assessReleaseReadiness,
  type ObservedApiPod,
} from './system-release/release-readiness.js';
import { bindVmCompute, terminateVmComputes } from './vm-compute.js';

/**
 * Production adapters for cluster creation: the existing provider gateways and
 * exact VM handle for the management VM, the platform SSH transport for host
 * configuration, and a cluster-connected Kubernetes client for release intent.
 */

/**
 * Management ingress at bootstrap time: SSH for host configuration, the Kubernetes
 * API for the installer and node pool workers, and the cluster-node API route.
 * Source narrowing and TLS on the API route follow the open ingress decision.
 */
const managementIngress = (port: number, description: string) =>
  ({
    protocol: 'tcp',
    port,
    sourceRanges: PUBLIC_SOURCE_RANGES,
    description,
  }) satisfies IngressSpec['ingress'][number];

const CLUSTER_NETWORK: IngressSpec = Object.freeze({
  ingress: [
    managementIngress(SSH_PORT, 'Cluster creation SSH'),
    managementIngress(SYSTEM_RELEASE_KUBERNETES_PORT, 'Kubernetes API'),
    // The API answers on its hostname through Cloudflare only: plain HTTP on
    // 80 until the zone flip, and TLS on 443.
    ...[80, 443].map((port) => ({
      protocol: 'tcp' as const,
      port,
      sourceRanges: [...CLOUDFLARE_IP_RANGES],
      description: 'AnyCloud API through Cloudflare',
    })),
  ],
});

const HTTP_TIMEOUT_MS = 5_000;

export interface ClusterInfrastructureDependencies {
  createCompute?: typeof createComputeProvider;
  createStorage?: typeof createStorageProvider;
  decryptCredential?: typeof decryptCredential;
}

async function clusterCompute(
  deps: ClusterInfrastructureDependencies,
  credential: NamedCredential,
  target: ClusterTarget,
  purpose: 'provisioning' | 'observed-vm',
): Promise<CloudCompute & CloudResourceCompute> {
  const decrypted = await (deps.decryptCredential ?? decryptCredential)(
    credential.encryptedData,
  );
  const config: CloudConfig = {
    cloudProvider: credential.cloudProvider,
    credentials: extractCredentials(decrypted),
    region: target.region,
    availabilityZone: target.zone ?? undefined,
    vmType: target.vmType,
    spot: false,
  };
  const compute = (deps.createCompute ?? createComputeProvider)(
    config,
    purpose,
  );
  if (!canManageCloudResources(compute)) {
    throw new Error(
      `${credential.cloudProvider} does not support isolated cloud resource scopes`,
    );
  }
  return compute;
}

export function createClusterInfrastructure(
  version: string,
  deps: ClusterInfrastructureDependencies = {},
): ClusterInfrastructure {
  return {
    async provisionManagementVm(input) {
      const compute = await clusterCompute(
        deps,
        input.credential,
        input.target,
        'provisioning',
      );
      const network = await compute.prepareResourceNetwork(
        CLUSTER_NETWORK,
        input.scope,
        version,
      );
      const adopted = compute.adoptResourceProvisioningAttempt
        ? await compute.adoptResourceProvisioningAttempt({
            scope: input.scope,
            vmId: input.cloudId,
          })
        : null;
      if (adopted) return adopted;
      return compute.newResourceVM({
        scope: input.scope,
        vmId: input.cloudId,
        ipWhitelist: [],
        startupScript: input.startupScript,
        gpuRuntime: null,
        version: input.version,
        adoptExistingAttempt: true,
        network,
        ingressSpec: CLUSTER_NETWORK,
      });
    },

    async ensureManagementIngress(input) {
      const compute = await clusterCompute(
        deps,
        input.credential,
        input.target,
        'provisioning',
      );
      await compute.prepareResourceNetwork(
        CLUSTER_NETWORK,
        input.scope,
        version,
      );
    },

    async releaseManagementVm(input) {
      // The recorded instance type travels with the identity: an empty type
      // would be parsed as a GPU alias and refused before any provider call.
      const compute = await clusterCompute(
        deps,
        input.credential,
        {
          region: input.identity.region,
          zone: input.identity.availabilityZone,
          vmType: input.identity.vmType,
        },
        'observed-vm',
      );
      const vm = bindVmCompute(compute, {
        cloudId: input.identity.cloudId,
        provider: input.identity.provider,
        credential: {
          source: 'attempt',
          credentialId: input.identity.credentialId,
        },
        region: input.identity.region,
        availabilityZone: input.identity.availabilityZone,
      });
      // Request termination on every pass (idempotent at the provider), then
      // confirm; the scoped network goes only after the VM is confirmed gone.
      await terminateVmComputes([vm]);
      const status = await vm.confirmRelease();
      if (status.state !== VMReleaseState.Released) return false;
      await compute.terminateResourceNetwork(input.scope);
      return true;
    },
    async findManagementVms(input) {
      const compute = await clusterCompute(
        deps,
        input.credential,
        input.target,
        'observed-vm',
      );
      if (!compute.listResourceVMs) {
        throw new Error(
          `${input.credential.cloudProvider} cannot list VMs by resource scope`,
        );
      }
      return (await compute.listResourceVMs(input.scope)).map((vm) => vm.id);
    },
    async observeManagementVm(input) {
      const compute = await clusterCompute(
        deps,
        input.credential,
        {
          region: input.identity.region,
          zone: input.identity.availabilityZone,
          vmType: input.identity.vmType,
        },
        'observed-vm',
      );
      return bindVmCompute(compute, {
        cloudId: input.identity.cloudId,
        provider: input.identity.provider,
        credential: {
          source: 'attempt',
          credentialId: input.identity.credentialId,
        },
        region: input.identity.region,
        availabilityZone: input.identity.availabilityZone,
      }).observeReleaseOnce();
    },
    async ensureCheckpointBucket(input) {
      const storage = await checkpointStorage(
        deps,
        input.credential,
        input.region,
      );
      await storage.upsertBucket(
        input.bucket,
        version,
        input.installationId,
        input.ownerUserId,
      );
      // History for the fixed backup key. Unsupported by a provider means the
      // hosted API refuses its hourly timer and says so.
      await storage.enableBucketVersioning?.(input.bucket);
    },
    async deleteCheckpointBucket(input) {
      const storage = await checkpointStorage(
        deps,
        input.credential,
        input.region,
      );
      if (await storage.hasBucket(input.bucket)) {
        await storage.deleteBucket(input.bucket);
      }
    },
  };
}

async function checkpointStorage(
  deps: ClusterInfrastructureDependencies,
  credential: NamedCredential,
  region: string,
): Promise<CloudStorage> {
  const decrypted = await (deps.decryptCredential ?? decryptCredential)(
    credential.encryptedData,
  );
  return (deps.createStorage ?? createStorageProvider)({
    cloudProvider: credential.cloudProvider,
    credentials: extractCredentials(decrypted),
    region,
  });
}

const HOST_COMMAND_TIMEOUT_MS = 10 * 60_000;
const HOST_PORT_PROBE_TIMEOUT_MS = 5_000;
// `SSHManager` wraps a handful of exit codes it treats as transient in an
// error whose message still carries the code; the bootstrap protocol wants
// the code back as data.
const REMOTE_EXIT_MESSAGE = /Command exited with code (\d+)/;

export type HostCommandTransportFactory = (
  host: string,
  privateKey: string,
  port?: number,
  username?: string,
) => HostCommandTransport;

function outcomeFromFailure(error: unknown): ManagementHostExecOutcome {
  const message = errorMessage(error);
  const match = REMOTE_EXIT_MESSAGE.exec(message);
  if (match) {
    const detail = error as { stdout?: unknown; stderr?: unknown };
    return {
      kind: 'exited',
      code: Number(match[1]),
      stdout: typeof detail.stdout === 'string' ? detail.stdout : '',
      stderr: typeof detail.stderr === 'string' ? detail.stderr : '',
    };
  }
  return { kind: 'unreachable', error: message };
}

export function createManagementHostAccess(
  transport: HostCommandTransportFactory = createHostCommandTransport,
): ManagementHostAccess {
  const connect = (target: {
    host: string;
    port: number;
    username: string;
    privateKey: string;
  }) => transport(target.host, target.privateKey, target.port, target.username);
  return {
    async exec(target, command, options) {
      try {
        const result = await connect(target).runCommand(
          command,
          options?.timeoutMs ?? HOST_COMMAND_TIMEOUT_MS,
        );
        return { kind: 'exited', ...result };
      } catch (error) {
        return outcomeFromFailure(error);
      }
    },
    async reachable(target) {
      try {
        return await connect(target).portReachable(HOST_PORT_PROBE_TIMEOUT_MS);
      } catch {
        return false;
      }
    },
    async writeFile(target, path, content, mode) {
      await connect(target).writeFile(path, content, mode);
    },
  };
}

async function observeEndpoint(
  apiUrl: string,
): Promise<{ healthy: boolean; servedVersion: string | null }> {
  try {
    const health = await fetch(`${apiUrl}/health`, {
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!health.ok) return { healthy: false, servedVersion: null };
    const version = await fetch(`${apiUrl}/v1/version`, {
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!version.ok) return { healthy: true, servedVersion: null };
    const body = (await version.json()) as { version?: unknown };
    return {
      healthy: true,
      servedVersion: typeof body.version === 'string' ? body.version : null,
    };
  } catch {
    return { healthy: false, servedVersion: null };
  }
}

/** The reads `describeRelease` performs; narrow so a fake API server can stand in. */
export interface ReleaseDiagnosticApis {
  core: Pick<
    CoreV1Api,
    | 'listNamespacedPod'
    | 'listNamespacedEvent'
    | 'readNamespacedPodLog'
    | 'readNamespacedPersistentVolumeClaim'
  >;
  batch: Pick<BatchV1Api, 'readNamespacedJob'>;
}

const STATE_CLAIM = 'anycloud-api-state';
const clip = (value?: string) =>
  (value ?? '').replace(/\s+/g, ' ').slice(0, 240);
const HELM_LOG_TAIL_LINES = 20;
const HELM_LOG_MAX_CHARS = 1_500;
// Helm's own error text lives in the Job Pod's log, not in the termination
// message. Anything token-shaped is masked before it reaches lastError.
const TOKEN_LIKE =
  /((?:token|passw(?:or)?d|secret|authorization|credential|api[_-]?key)[\w-]*["']?\s*[=:]\s*|bearer\s+)[^\n]+|\b[A-Za-z0-9+/_-]{32,}={0,2}\b/gi;
// The shared redactor first (AWS keys, JWTs, PEM blocks, URL passwords), on
// the log's own lines, then the keyword and long-token rules.
const redact = (text: string) =>
  redactSecrets(text).replace(TOKEN_LIKE, (_match, prefix?: string) =>
    prefix ? `${prefix}<redacted>` : '<redacted>',
  );

/** Last lines of the newest helm Job Pod, redacted and bounded. */
async function describeHelmLog(
  { core }: ReleaseDiagnosticApis,
  namespace: string,
): Promise<string> {
  const { items } = await core.listNamespacedPod({
    namespace,
    labelSelector: `job-name=${HELM_INSTALL_JOB}`,
  });
  const [newest] = [...items].sort(
    (a: V1Pod, b: V1Pod) =>
      (b.metadata?.creationTimestamp?.getTime() ?? 0) -
      (a.metadata?.creationTimestamp?.getTime() ?? 0),
  );
  const name = newest?.metadata?.name;
  if (!name) return 'no Pod';
  const log = await core.readNamespacedPodLog({
    name,
    namespace,
    tailLines: HELM_LOG_TAIL_LINES,
    limitBytes: 64 * 1024,
  });
  const text = redact(log.trim()).replace(/\s*\n\s*/g, ' / ');
  return text
    ? `${name}: ${text.slice(-HELM_LOG_MAX_CHARS)}`
    : `${name}: empty`;
}

/** A section never masks the others: a read that fails reports itself. */
async function section(read: () => Promise<string>): Promise<string> {
  try {
    return await read();
  } catch (error) {
    if ((error as { code?: number }).code === 404) return 'not found';
    return `unavailable: ${errorMessage(error)}`;
  }
}

const CRASH_LOG_MAX_CHARS = 600;

/**
 * Phase, container waiting/termination reasons, restarts and the newest event
 * per Pod; with `crashLogs`, the redacted tail of a failed container's last
 * run, which is where a crash-looping API says why it exits.
 */
async function describePods(
  { core }: ReleaseDiagnosticApis,
  namespace: string,
  labelSelector: string,
  crashLogs = false,
): Promise<string> {
  const { items } = await core.listNamespacedPod({ namespace, labelSelector });
  if (items.length === 0) return 'none';
  const described = items.map(async (pod: V1Pod) => {
    const name = pod.metadata?.name ?? '';
    // Init containers first: a refused restore stops the Pod there.
    const statuses = [
      ...(pod.status?.initContainerStatuses ?? []),
      ...(pod.status?.containerStatuses ?? []),
    ];
    const containers = await Promise.all(
      statuses.map(async (c) => {
        const exit = c.state?.terminated ?? c.lastState?.terminated;
        const log =
          crashLogs && exit && exit.exitCode !== 0
            ? await (async () => {
                // A failed read reports itself, clipped: the client's error
                // runs to a KiB of headers.
                try {
                  const text = await core.readNamespacedPodLog({
                    name,
                    namespace,
                    container: c.name,
                    // A restarted container's own output is its previous run's.
                    previous: !c.state?.terminated,
                    tailLines: HELM_LOG_TAIL_LINES,
                    limitBytes: 64 * 1024,
                  });
                  const tail = redact(text.trim()).replace(/\s*\n\s*/g, ' / ');
                  return tail ? tail.slice(-CRASH_LOG_MAX_CHARS) : 'empty';
                } catch (error) {
                  return `unavailable: ${clip(errorMessage(error))}`;
                }
              })()
            : undefined;
        return [
          c.name,
          c.state?.waiting &&
            `waiting ${c.state.waiting.reason} (${clip(c.state.waiting.message)})`,
          exit &&
            `exited ${exit.exitCode} (${clip(exit.message ?? exit.reason)})`,
          c.restartCount > 0 && `${c.restartCount} restarts`,
          log !== undefined && `log: ${log}`,
        ]
          .filter(Boolean)
          .join(' ');
      }),
    );
    const events = await section(async () => {
      // The client can hand back RFC 3339 strings rather than Dates.
      const at = (e: CoreV1Event) =>
        new Date(e.lastTimestamp ?? e.eventTime ?? 0).getTime() || 0;
      const fieldSelector = `involvedObject.name=${name}`;
      const [last] = (
        await core.listNamespacedEvent({ namespace, fieldSelector })
      ).items.sort((a, b) => at(b) - at(a));
      return last ? `; last event: ${last.reason}: ${clip(last.message)}` : '';
    });
    return `${name} ${pod.status?.phase ?? 'Unknown'}${containers.length ? ` [${containers.join('; ')}]` : ''}${events}`;
  });
  return (await Promise.all(described)).join(' | ');
}

const defaultDiagnosticApis = (connection: ClusterConnectionDocument) => {
  const kubeConfig = kubeConfigFromClusterConnection(connection);
  return {
    core: createKubernetesClients(kubeConfig).core,
    batch: kubeConfig.makeApiClient(BatchV1Api),
  };
};

export function createClusterReleaseClient(
  diagnosticApis: (
    connection: ClusterConnectionDocument,
  ) => ReleaseDiagnosticApis = defaultDiagnosticApis,
): ClusterReleaseClient {
  const objects = (connection: ClusterConnectionDocument) =>
    KubernetesObjectApi.makeApiClient(
      kubeConfigFromClusterConnection(connection),
    );
  return {
    async ensureNamespace(connection, namespace) {
      const clients = createKubernetesClients(
        kubeConfigFromClusterConnection(connection),
      );
      try {
        await clients.core.createNamespace({
          body: { metadata: { name: namespace } },
        });
      } catch (error) {
        if ((error as { code?: number }).code !== 409) throw error;
      }
    },
    async readCustomResourceDefinition(connection, name) {
      const api =
        kubeConfigFromClusterConnection(connection).makeApiClient(
          ApiextensionsV1Api,
        );
      try {
        const crd = await api.readCustomResourceDefinition({ name });
        return {
          established: (crd.status?.conditions ?? []).some(
            (c) => c.type === 'Established' && c.status === 'True',
          ),
        };
      } catch (error) {
        if ((error as { code?: number }).code === 404) return null;
        throw error;
      }
    },
    async deleteObject(connection, object) {
      try {
        await objects(connection).delete(object);
      } catch (error) {
        if ((error as { code?: number }).code !== 404) throw error;
      }
    },
    async applyObject(connection, object) {
      const client = objects(connection);
      try {
        await client.create(object);
      } catch (error) {
        if ((error as { code?: number }).code !== 409) throw error;
        await client.patch(
          object,
          undefined,
          undefined,
          undefined,
          undefined,
          PatchStrategy.MergePatch,
        );
      }
    },
    // Bounded reads of what the cluster says about a release that missed its
    // target, in the order a release proceeds: helm-controller Job, API Pods,
    // state claim.
    async describeRelease(connection, namespace) {
      const apis = diagnosticApis(connection);
      const [job, helmLog, apiPods, claim] = await Promise.all([
        section(async () => {
          const status =
            (
              await apis.batch.readNamespacedJob({
                name: HELM_INSTALL_JOB,
                namespace,
              })
            ).status ?? {};
          const conditions = (status.conditions ?? [])
            .filter((c) => c.status === 'True')
            .map((c) => `${c.type} ${c.reason ?? ''}: ${clip(c.message)}`);
          const pods = await describePods(
            apis,
            namespace,
            `job-name=${HELM_INSTALL_JOB}`,
          );
          return `${status.active ?? 0} active, ${status.succeeded ?? 0} succeeded, ${status.failed ?? 0} failed${conditions.length ? ` (${conditions.join('; ')})` : ''}: ${pods}`;
        }),
        section(() => describeHelmLog(apis, namespace)),
        section(() =>
          describePods(
            apis,
            namespace,
            'app.kubernetes.io/name=anycloud-api',
            true,
          ),
        ),
        section(
          async () =>
            (
              await apis.core.readNamespacedPersistentVolumeClaim({
                name: STATE_CLAIM,
                namespace,
              })
            ).status?.phase ?? 'Unknown',
        ),
      ]);
      return `helm Job ${HELM_INSTALL_JOB} ${job}. helm Job log: ${helmLog}. API Pods: ${apiPods}. PVC ${STATE_CLAIM} ${claim}`;
    },
    async getHelmChart(connection, name, namespace) {
      try {
        const object = await objects(connection).read({
          apiVersion: 'helm.cattle.io/v1',
          kind: 'HelmChart',
          metadata: { name, namespace },
        });
        return object as unknown as HelmChartObject;
      } catch (error) {
        if ((error as { code?: number }).code === 404) return null;
        throw error;
      }
    },
    async applyHelmChart(connection, chart, expectedResourceVersion) {
      const client = objects(connection);
      try {
        if (expectedResourceVersion === null) {
          await client.create(chart);
          return;
        }
        // The observed resourceVersion is the precondition: the API server
        // answers 409 when the object moved since the comparison.
        await client.patch(
          {
            ...chart,
            metadata: {
              ...chart.metadata,
              resourceVersion: expectedResourceVersion,
            },
          },
          undefined,
          undefined,
          undefined,
          undefined,
          PatchStrategy.MergePatch,
        );
      } catch (error) {
        if ((error as { code?: number }).code === 409) {
          throw new ClusterReleaseConflictError();
        }
        throw error;
      }
    },
    async observeRelease(connection, expected) {
      const clients = createKubernetesClients(
        kubeConfigFromClusterConnection(connection),
      );
      const list = await clients.core.listNamespacedPod({
        namespace: expected.namespace,
        labelSelector: 'app.kubernetes.io/name=anycloud-api',
      });
      const pods: ObservedApiPod[] = list.items.map((pod) => ({
        name: pod.metadata?.name ?? '',
        podIp: pod.status?.podIP ?? null,
        ready:
          pod.status?.phase === 'Running' &&
          (pod.status.conditions ?? []).some(
            (condition) =>
              condition.type === 'Ready' && condition.status === 'True',
          ),
        annotations: pod.metadata?.annotations ?? {},
        imageIds: (pod.status?.containerStatuses ?? []).map(
          (status) => status.imageID,
        ),
      }));
      const endpoint = await observeEndpoint(expected.apiUrl);
      return assessReleaseReadiness(pods, expected, endpoint);
    },
  };
}

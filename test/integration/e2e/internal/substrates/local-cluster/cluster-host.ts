import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, isIP } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadAllYaml, loadYaml } from '@kubernetes/client-node';
import { z } from 'zod';

import type { KubernetesClients } from '../../../../../../src/api/services/kubernetes/client.js';
import type { ClusterConnectionDocument } from '../../../../../../src/api/services/kubernetes/cluster-connection.js';
import { DockerEngine } from './docker-engine.js';
import {
  CONTROL_PLANE_TAINT_KEY,
  KUBELET_PREFERRED_ADDRESS_TYPES,
} from '../../../../../../src/shared/system-release.js';
import { kubernetesClientsFromKubeconfig } from '../../kubernetes-client.js';
import type { Redactor } from '../../artifacts.js';
import type { Waiter } from '../../wait.js';
import {
  executeLocalKubernetesCommand,
  localKubernetesCommandSucceeds,
} from './command.js';
import {
  clusterLocalDockerLabel,
  clusterLocalK3sImage,
  localClusterServerContainer,
} from './constants.js';

const busyboxImage =
  'mirror.gcr.io/library/busybox:1.36@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662';
const k3sApiPort = 6443;
const k3sKubeconfigPath = '/etc/rancher/k3s/k3s.yaml';
const auditPolicyPath = '/anycloud-audit-policy.yaml';
const auditLogPath = '/var/lib/rancher/k3s/server/logs/audit.log';
/**
 * Writes to the namespaced objects a Deployment record owns, plus the node
 * pool namespace's egress NetworkPolicy (K5); subresources such as Pod
 * status and ServiceAccount tokens are not matched.
 */
const auditPolicy = JSON.stringify({
  apiVersion: 'audit.k8s.io/v1',
  kind: 'Policy',
  omitStages: ['RequestReceived'],
  rules: [
    {
      level: 'Metadata',
      verbs: ['create', 'update', 'patch', 'delete', 'deletecollection'],
      resources: [
        { group: '', resources: ['pods', 'secrets', 'serviceaccounts'] },
        { group: 'apps', resources: ['deployments'] },
        { group: 'networking.k8s.io', resources: ['networkpolicies'] },
      ],
    },
    { level: 'None' },
  ],
});

const kubeconfigSchema = z
  .object({
    clusters: z
      .array(
        z.object({
          name: z.string().min(1),
          cluster: z.object({
            server: z.string().url(),
            'certificate-authority-data': z.string().min(1),
          }),
        }),
      )
      .length(1),
    users: z
      .array(
        z.object({
          name: z.string().min(1),
          user: z.object({
            'client-certificate-data': z.string().min(1),
            'client-key-data': z.string().min(1),
          }),
        }),
      )
      .length(1),
    contexts: z
      .array(
        z.object({
          name: z.string().min(1),
          context: z.object({ cluster: z.string(), user: z.string() }),
        }),
      )
      .length(1),
    'current-context': z.string().min(1),
  })
  .loose();

/** A free host port, reserved by the kernel and released for Docker to bind. */
async function freeHostPort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '0.0.0.0', resolve);
  });
  const address = listener.address();
  await new Promise<void>((resolve, reject) => {
    listener.close((error) => (error ? reject(error) : resolve()));
  });
  if (!address || typeof address === 'string') {
    throw new Error('Could not reserve a host port for the local cluster');
  }
  return address.port;
}

async function dockerHostGateway(docker: DockerEngine): Promise<string> {
  if (!(await docker.hasImage(busyboxImage))) {
    await docker.pullImage(busyboxImage);
  }
  const result = await executeLocalKubernetesCommand(
    'docker',
    [
      'run',
      '--rm',
      '--add-host',
      'host.docker.internal:host-gateway',
      busyboxImage,
      'sh',
      '-ec',
      `awk '$2 == "host.docker.internal" { print $1; exit }' /etc/hosts`,
    ],
    { timeoutMs: 120_000 },
  );
  const address = result.stdout.trim();
  if (isIP(address) !== 4) {
    throw new Error('Docker did not return a valid IPv4 host gateway');
  }
  return address;
}

/**
 * Rewrite the K3s-generated kubeconfig so one server URL serves both the API
 * process on the host and the agent containers: the Docker host gateway
 * address with the published API port. The K3s server lists that address as
 * a TLS SAN, so the CA and client certificate stay exactly as generated.
 */
export function publishedKubeconfig(
  source: string,
  server: string,
): { readonly kubeconfig: string; readonly certificateAuthorityData: string } {
  const parsed = kubeconfigSchema.parse(loadYaml(source));
  const [cluster] = parsed.clusters;
  const rewritten = {
    ...parsed,
    clusters: [{ ...cluster, cluster: { ...cluster.cluster, server } }],
  };
  return {
    kubeconfig: JSON.stringify(rewritten),
    certificateAuthorityData: cluster.cluster['certificate-authority-data'],
  };
}

/**
 * The apiserver answers list requests before its bootstrap namespaces exist
 * (CI: `namespaces "kube-system" not found` right after readiness), so the
 * identity read is a bounded wait, as the product's bootstrap has SSH round
 * trips and its own readiness poll before it observes the UID.
 */
export async function waitForKubeSystemIdentity(
  core: Pick<KubernetesClients['core'], 'readNamespace'>,
  wait: Pick<Waiter, 'for'>,
  label: string,
  timing: { timeoutMs: number; intervalMs: number } = {
    timeoutMs: 60_000,
    intervalMs: 2_000,
  },
): Promise<string> {
  const uid = await wait.for(
    `${label} kube-system identity`,
    () =>
      core.readNamespace({ name: 'kube-system' }).then(
        (namespace) => namespace.metadata?.uid,
        (error: unknown) => {
          if ((error as { code?: number }).code === 404) return undefined;
          throw error;
        },
      ),
    {
      ...timing,
      probeError: 'fail',
      unmet: (value) =>
        value ? undefined : 'kube-system namespace not created yet',
    },
  );
  if (!uid) throw new Error(`${label} did not expose a kube-system identity`);
  return uid;
}

/**
 * A management node of a production default's size (`t3.medium`, 2 vCPU
 * and 4 GiB), whose CPUs the API child shares (S12).
 */
export interface LocalManagementNode {
  /** Docker's `--cpuset-cpus`, e.g. `0,1`. */
  readonly cpus: string;
  readonly memoryBytes: number;
}

// Not the chart's own names: the hosted chart stage installs that chart into
// this cluster, and Helm won't adopt a ClusterRole it didn't create.
const apiServiceAccount = 'anycloud-e2e-api';
const apiTokenSecret = 'anycloud-e2e-api-token';

/**
 * The hosted API's ClusterRole as the chart renders it: its one template
 * directive only adds labels.
 */
export function chartApiClusterRole(): {
  rules: unknown[];
} {
  const rendered = readFileSync(
    new URL(
      '../../../../../../charts/anycloud-api/templates/rbac.yaml',
      import.meta.url,
    ),
    'utf8',
  ).replace(/^.*\{\{.*\}\}.*$/gmu, '');
  const role = (
    loadAllYaml(rendered) as { kind?: string; rules?: unknown[] }[]
  ).find((document) => document?.kind === 'ClusterRole');
  if (!role?.rules) throw new Error('The chart renders no API ClusterRole');
  return { rules: role.rules };
}

/**
 * The API's connection, held by a ServiceAccount bound to the chart's
 * rendered ClusterRole rather than cluster-admin, so every RBAC verb the API
 * needs is exercised here as on a hosted cluster. Its token Secret is
 * created through the admin client because the fixture has no SSH path into
 * the container; the connection keeps the installer kind's token shape.
 */
async function mintChartRbacConnection(
  clients: KubernetesClients,
  server: string,
  certificateAuthorityData: string,
  wait: Pick<Waiter, 'for'>,
): Promise<ClusterConnectionDocument & { kind: 'installer' }> {
  const metadata = { namespace: 'kube-system' };
  const rbac = 'rbac.authorization.k8s.io';
  for (const object of [
    {
      apiVersion: 'v1',
      kind: 'ServiceAccount',
      metadata: { ...metadata, name: apiServiceAccount },
    },
    {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        ...metadata,
        name: apiTokenSecret,
        annotations: {
          'kubernetes.io/service-account.name': apiServiceAccount,
        },
      },
      type: 'kubernetes.io/service-account-token',
    },
    {
      apiVersion: `${rbac}/v1`,
      kind: 'ClusterRole',
      metadata: { name: apiServiceAccount },
      ...chartApiClusterRole(),
    },
    {
      apiVersion: `${rbac}/v1`,
      kind: 'ClusterRoleBinding',
      metadata: { name: apiServiceAccount },
      roleRef: { apiGroup: rbac, kind: 'ClusterRole', name: apiServiceAccount },
      subjects: [
        { kind: 'ServiceAccount', name: apiServiceAccount, ...metadata },
      ],
    },
  ]) {
    await clients.objects.create(object).catch((error: unknown) => {
      if ((error as { code?: number }).code !== 409) throw error;
    });
  }
  const token = await wait.for(
    'local API access token',
    async () => {
      const secret = await clients.core.readNamespacedSecret({
        name: apiTokenSecret,
        namespace: 'kube-system',
      });
      const encoded = secret.data?.token;
      return encoded
        ? Buffer.from(encoded, 'base64').toString('utf8')
        : undefined;
    },
    {
      timeoutMs: 60_000,
      intervalMs: 1_000,
      probeError: 'fail',
      unmet: (value) => (value ? undefined : 'token not issued yet'),
    },
  );
  if (!token) throw new Error('Local cluster issued no access token');
  return {
    kind: 'installer',
    server,
    certificateAuthorityData,
    credential: { kind: 'token', token },
  };
}

/**
 * Fixture-owned cluster: one K3s server container on the runner's
 * Docker, exactly like a developer's k3d cluster. The API only ever sees the
 * chart-RBAC connection minted here; node pool agents reach it through the
 * production join credential.
 */
export class LocalClusterHost {
  readonly #docker = new DockerEngine();
  readonly #redactor: Redactor;
  readonly #runId: string;
  readonly #wait: Pick<Waiter, 'for'>;
  #management: LocalManagementNode | undefined;
  #clients: KubernetesClients | undefined;
  #kubeconfig: string | undefined;
  #connection: ClusterConnectionDocument | undefined;
  #kubernetesIdentity: string | undefined;
  #publicIp: string | undefined;
  #server: string | undefined;

  constructor(input: {
    readonly redactor: Redactor;
    readonly runId: string;
    readonly wait: Pick<Waiter, 'for'>;
  }) {
    this.#redactor = input.redactor;
    this.#runId = input.runId;
    this.#wait = input.wait;
  }

  /** Before `start`: the management node's CPUs and memory (S12). */
  constrain(management: LocalManagementNode): void {
    this.#management = management;
  }

  get containerName(): string {
    return localClusterServerContainer(this.#runId);
  }

  get publicIp(): string {
    if (!this.#publicIp) throw new Error('Local management host is not ready');
    return this.#publicIp;
  }

  /** Single-context kubeconfig with inline CA and client certificate. */
  get kubeconfig(): string {
    if (!this.#kubeconfig)
      throw new Error('Local management host is not ready');
    return this.#kubeconfig;
  }

  get server(): string {
    if (!this.#server) throw new Error('Local management host is not ready');
    return this.#server;
  }

  /** The chart-RBAC connection the child API records for this cluster. */
  get connection(): ClusterConnectionDocument {
    if (!this.#connection)
      throw new Error('Local management host is not ready');
    return this.#connection;
  }

  /** The `kube-system` namespace UID, as bootstrap would observe it. */
  get kubernetesIdentity(): string {
    if (!this.#kubernetesIdentity) {
      throw new Error('Local management host is not ready');
    }
    return this.#kubernetesIdentity;
  }

  async start(): Promise<void> {
    if (this.#kubeconfig)
      throw new Error('Local management host already started');
    const publicIp = await dockerHostGateway(this.#docker);
    const hostPort = await freeHostPort();
    await this.#docker.createContainer(this.containerName, {
      Image: clusterLocalK3sImage,
      Cmd: [
        // service-terminology-ok: K3s subcommand that runs the control plane
        'server',
        '--tls-san',
        publicIp,
        '--tls-san',
        'host.docker.internal',
        // Agents learn the supervisor endpoint from the apiserver's advertised
        // address and re-point their tunnel to it. The server's own address
        // is on Docker's default bridge, unreachable from the pool networks,
        // so advertise the host-gateway address and published port the join
        // already reached — the same requirement a cross-cloud cluster has.
        `--advertise-address=${publicIp}`,
        `--advertise-port=${String(hostPort)}`,
        `--node-external-ip=${publicIp}`,
        '--node-name',
        this.containerName,
        '--node-taint',
        // Match the product management host: bootstrap Helm Jobs tolerate
        // the standard control-plane taint, but not a custom management key.
        `${CONTROL_PLANE_TAINT_KEY}=true:NoSchedule`,
        // Still required with the advertised address: the API server has no
        // route to a kubelet on 10250 across Docker networks, so Pod log and
        // exec reads must ride the agent tunnel (K3s's default `agent` mode
        // dials kubelets directly), as the retired supervisor did.
        '--egress-selector-mode=cluster',
        // Logs, exec and port-forward dial kubelets by Node name, as on the
        // product management host. Without the cloud controller (also off in
        // `managementKubernetesConfig`) a kubelet's Hostname address is its
        // Node name; the embedded one publishes the container's OS hostname.
        `--kube-apiserver-arg=${KUBELET_PREFERRED_ADDRESS_TYPES}`,
        '--disable-cloud-controller',
        // The product's management configuration (`system-release/management-host.ts`).
        // metrics-server matters most here: nothing can schedule it (the
        // management Node is tainted, pool Nodes for their pools), so
        // its APIService stays unavailable, every discovery-dependent
        // controller loops on it, and namespace deletion never finishes
        // (`NamespaceDeletionDiscoveryFailure`) — which is what held the
        // node pool Service's cleanup open in run 9.
        '--disable',
        'traefik,servicelb,metrics-server',
        // Counts writes for the converged-Deployment check (`writesIn`).
        `--kube-apiserver-arg=audit-policy-file=${auditPolicyPath}`,
        `--kube-apiserver-arg=audit-log-path=${auditLogPath}`,
      ],
      Env: ['K3S_KUBECONFIG_MODE=644'],
      ExposedPorts: { [`${String(k3sApiPort)}/tcp`]: {} },
      HostConfig: {
        Privileged: true,
        RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
        PortBindings: {
          [`${String(k3sApiPort)}/tcp`]: [
            { HostIp: '0.0.0.0', HostPort: String(hostPort) },
          ],
        },
        Tmpfs: { '/run': '', '/var/run': '' },
        ...(this.#management && {
          CpusetCpus: this.#management.cpus,
          Memory: this.#management.memoryBytes,
        }),
      },
      Labels: {
        [clusterLocalDockerLabel]: 'true',
        'com.anycloud.e2e-run': this.#runId,
        'com.anycloud.role': 'management',
      },
    });
    const policyDirectory = await mkdtemp(path.join(tmpdir(), 'anycloud-'));
    try {
      const policy = path.join(policyDirectory, 'audit-policy.yaml');
      await writeFile(policy, auditPolicy);
      await executeLocalKubernetesCommand('docker', [
        'cp',
        policy,
        `${this.containerName}:${auditPolicyPath}`,
      ]);
    } finally {
      await rm(policyDirectory, { recursive: true, force: true });
    }
    await this.#docker.startContainer(this.containerName);
    if ((await this.#publishedPort()) !== hostPort) {
      throw new Error('Docker did not publish the reserved local cluster port');
    }
    const server = `https://${publicIp}:${String(hostPort)}`;
    const source = await this.#wait.for(
      `local cluster ${this.containerName} kubeconfig`,
      async () => {
        const result = await executeLocalKubernetesCommand(
          'docker',
          ['exec', this.containerName, 'cat', k3sKubeconfigPath],
          { timeoutMs: 15_000 },
        ).catch(() => null);
        return result?.stdout.includes('certificate-authority-data')
          ? result.stdout
          : undefined;
      },
      {
        timeoutMs: 180_000,
        intervalMs: 2_000,
        probeError: 'fail',
        unmet: (value) => (value ? undefined : 'kubeconfig not written yet'),
      },
    );
    if (!source) throw new Error('Local cluster produced no kubeconfig');
    const published = publishedKubeconfig(source, server);
    this.#redactor.add(published.kubeconfig);
    this.#kubeconfig = published.kubeconfig;
    this.#publicIp = publicIp;
    this.#server = server;
    const clients = kubernetesClientsFromKubeconfig(published.kubeconfig);
    await this.#wait.for(
      `local cluster ${this.containerName} API readiness`,
      () =>
        clients.core
          .listNamespace()
          .then(() => true)
          .catch(() => false),
      {
        timeoutMs: 180_000,
        intervalMs: 2_000,
        probeError: 'fail',
        unmet: (ready) => (ready ? undefined : 'API server not ready'),
      },
    );
    this.#clients = clients;
    this.#kubernetesIdentity = await waitForKubeSystemIdentity(
      clients.core,
      this.#wait,
      `local cluster ${this.containerName}`,
    );
    const connection = await mintChartRbacConnection(
      clients,
      server,
      published.certificateAuthorityData,
      this.#wait,
    );
    this.#redactor.add(connection.credential.token);
    this.#connection = connection;
  }

  clients(): KubernetesClients {
    if (!this.#clients) throw new Error('Local management host is not ready');
    return this.#clients;
  }

  /**
   * Every audited write so far to an object in `namespace`, from any client,
   * counted per resource (`secrets`, `deployments`, ...).
   */
  async writesIn(namespace: string): Promise<Record<string, number>> {
    const log = await this.#docker.exec(this.containerName, [
      'cat',
      auditLogPath,
    ]);
    const writes: Record<string, number> = {};
    // The API server may be mid-line; only a terminated line is complete.
    for (const line of log.split('\n').slice(0, -1)) {
      const { objectRef } = JSON.parse(line) as {
        objectRef?: { namespace?: string; resource?: string };
      };
      if (objectRef?.namespace !== namespace || !objectRef.resource) continue;
      writes[objectRef.resource] = (writes[objectRef.resource] ?? 0) + 1;
    }
    return writes;
  }

  async exists(): Promise<boolean> {
    return (await this.#docker.inspectContainer(this.containerName)) !== null;
  }

  async stop(): Promise<void> {
    this.#clients = undefined;
    this.#kubeconfig = undefined;
    this.#server = undefined;
    if (
      await localKubernetesCommandSucceeds('docker', [
        'inspect',
        this.containerName,
      ])
    ) {
      await executeLocalKubernetesCommand('docker', [
        'rm',
        '--force',
        '--volumes',
        this.containerName,
      ]);
    }
  }

  async #publishedPort(): Promise<number> {
    const { stdout } = await executeLocalKubernetesCommand('docker', [
      'port',
      this.containerName,
      `${String(k3sApiPort)}/tcp`,
    ]);
    const port = Number(
      stdout
        .split(/\r?\n/u)
        .map((line) => line.trim().split(':').at(-1))
        .find(Boolean),
    );
    if (!Number.isSafeInteger(port) || port <= 0) {
      throw new Error('Local cluster did not publish its API port');
    }
    return port;
  }
}

import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { User } from '../../../src/api/services/entities.js';
import {
  createClustersDomain,
  managementVmCloudId,
  type ClusterDomainDependencies,
  type HostedNodePoolInventory,
  type ManagementHostAccess,
  type ManagementHostExecOutcome,
  type ClusterInfrastructure,
  type ClusterReleaseClient,
} from '../../../src/api/services/clusters-domain.js';
import {
  ClusterDestroyFailedError,
  ClusterExistsError,
  ClusterBusyError,
  HostedApiAccessError,
  ClusterUnavailableError,
  ClusterReleaseConflictError,
  ClusterVmPresentError,
} from '../../../src/api/services/cluster-errors.js';
import { resolveComputeConfig } from '../../../src/api/services/cloud-config.js';
import {
  createCloudCompute,
  VM_PRESENT,
  VM_RELEASE_CANDIDATE,
} from '../../../src/api/services/gateways/cloud.js';
import { createClusterInfrastructure } from '../../../src/api/services/cluster-installer-runtime.js';
import {
  parseClusterConnection,
  serializeClusterConnection,
} from '../../../src/api/services/kubernetes/cluster-connection.js';
import {
  getPersistence,
  resetPersistence,
} from '../../../src/api/services/persistence.js';
import { getDB } from '../../../src/api/services/repositories/db.js';
import { CLOUDFLARE_IP_RANGES } from '../../../src/shared/cloudflare-ips.js';
import { apiTlsProbeCommand } from '../../../src/api/services/system-release/api-tls.js';
import {
  API_TLS_CA_SECRET,
  API_TLS_SECRET,
} from '../../../src/shared/system-release.js';
import { csrSubjectAltNames } from '../../../worker/src/api-tls.js';
import { type HelmChartObject } from '../../../src/shared/system-release-values.js';
import {
  RELEASE_INSTALLATION_ANNOTATION,
  RELEASE_OPERATION_ANNOTATION,
  RELEASE_REVISION_ANNOTATION,
} from '../../../src/shared/system-release.js';
import {
  INSTALLER_ACCESS_READ_COMMAND,
  MANAGEMENT_KUBERNETES_READY_COMMAND,
  MANAGEMENT_LABEL_COMMAND,
} from '../../../src/api/services/system-release/management-host.js';
import {
  ClusterState,
  ClusterStep,
  ClusterReleaseState,
} from '../../../src/shared/clusters.js';
import { CloudType, type CloudConfig } from '../../../src/shared/cloud.js';
import { WorkloadState } from '../../../src/shared/workload.js';
import { makeMockCloudStorage } from '../helpers/fixtures.js';
import {
  SYSTEM_RELEASE_HELM_JOB_IMAGE,
  SYSTEM_RELEASE_K3S_SHA256,
  SYSTEM_RELEASE_K3S_VERSION,
} from '../../../src/shared/system-release.js';
import Github from '../../../src/api/services/gateways/github.js';
import { GithubSignInRequiredError } from '../../../src/shared/errors.js';
import { storageOnlyComputeMessage } from '../../../src/shared/providers.js';

const actor: User = {
  id: '4242',
  username: 'owner',
  token: 'github-token',
};
const DIGEST = `sha256:${'a'.repeat(64)}`;
const CHART_SHA = 'c'.repeat(64);
const CHART = `oci://ghcr.io/anycloud-sh/api-k8-chart@sha256:${CHART_SHA}`;
const CA = Buffer.from('root-ca').toString('base64');
const INSTALLER_TOKEN = 'cluster-service-account-token';
const IDENTITY = 'kube-system-uid-1';

const KEEP = { deleteBuckets: false };
const DELETE_BUCKETS = { deleteBuckets: true };

const request = {
  name: 'production',
  credentialName: 'aws-compute',
  region: 'us-east-1',
  vmType: 't3.medium',
};

interface Fakes {
  provisionCalls: number;
  releaseCalls: number;
  /** Managed checkpoint buckets the infrastructure created / versioned / deleted. */
  buckets: string[];
  bucketDeletes: string[];
  provisioned: Map<string, { ip: string }>;
  /** findManagementVms lookups: the cluster scope and the region asked. */
  found: Array<{ scope: string; region: string }>;
  execLog: string[];
  written: Array<{ path: string; content: string; mode: number }>;
  /** writeFile calls that fail with a transport error before one succeeds. */
  writeFailures: number;
  /** Configure attempts answering exit 66 (staged file missing). */
  staleStagedPolls: number;
  /** Probes and commands answered "unreachable" before sshd is up. */
  sshBootsAfterProbes: number;
  /** Configure attempts answering exit 64 (host still preparing). */
  preparingPolls: number;
  hostReady: boolean;
  /** The K3s configuration the host runs. */
  hostConfig: string | null;
  /** Namespaces on the cluster; a fresh K3s has none of ours. */
  namespaces: Set<string>;
  /** Objects applied through the cluster connection besides the HelmChart (Traefik config). */
  appliedObjects: Array<{ kind: string; name: string; namespace: string }>;
  /** CRD reads answered "absent" before Traefik's IngressRoute CRD is Established. */
  crdAbsentPolls: number;
  crdReads: string[];
  /** Objects deleted through the cluster connection. */
  deletedObjects: Array<{ kind: string; name: string }>;
  dns: string[];
  /** How long after publish 1.1.1.1 starts answering the record. */
  propagationMs: number;
  /** When it answers; set by publish. */
  publicRecordAt: number;
  /** 1.1.1.1 answers and public-URL fetches, in order. */
  lookups: string[];
  /** Origin certificates the Worker issued, in order. */
  issued: string[];
  /** What the Worker hands out as the origin pull CA. */
  originPullCa: string | null;
  /** On-node 443 probes that see no certificate before Traefik serves it. */
  tlsUnservedProbes: number;
  /** What the hosted-API inventory seam answers. */
  hostedPools: HostedNodePoolInventory;
  inventoryCalls: number;
  /** Final backups the hosted API took; a reason makes the next one fail. */
  backups: number;
  backupFailure: string | null;
  helmChart: HelmChartObject | null;
  applied: HelmChartObject[];
  /** Apply attempts rejected with a conflict before one succeeds. */
  conflicts: number;
  releaseReady: boolean;
  failAt: string | null;
}

function fail(fakes: Fakes, point: string): void {
  if (fakes.failAt === point) {
    fakes.failAt = null;
    throw new Error(`injected failure at ${point}`);
  }
}

function infrastructure(fakes: Fakes): ClusterInfrastructure {
  return {
    async provisionManagementVm(input) {
      fail(fakes, 'before-provision');
      fakes.provisionCalls += 1;
      const existing = fakes.provisioned.get(input.cloudId);
      const vm = existing ?? { ip: `203.0.113.${fakes.provisioned.size + 1}` };
      fakes.provisioned.set(input.cloudId, vm);
      fail(fakes, 'after-provision');
      return { cloudId: input.cloudId, ip: vm.ip, createdAt: 1_000 };
    },
    async findManagementVms(input) {
      fakes.found.push({ scope: input.scope.id, region: input.target.region });
      fail(fakes, 'find-vms');
      return [...fakes.provisioned.keys()].filter((id) =>
        id.startsWith(input.scope.id),
      );
    },
    async observeManagementVm(input) {
      return fakes.provisioned.has(input.identity.cloudId)
        ? { state: 'present' }
        : { state: 'release-candidate' };
    },
    async ensureManagementIngress(input) {
      fakes.execLog.push(`<ingress ${input.scope.id}>`);
      fail(fakes, 'ingress');
    },
    async releaseManagementVm(input) {
      fakes.releaseCalls += 1;
      fakes.provisioned.delete(input.identity.cloudId);
      return true;
    },
    async ensureCheckpointBucket(input) {
      if (!fakes.buckets.includes(input.bucket))
        fakes.buckets.push(input.bucket);
    },
    async deleteCheckpointBucket(input) {
      fail(fakes, 'delete-bucket');
      // In the DNS log too, so a test can read the teardown order.
      fakes.dns.push(`delete-bucket ${input.bucket}`);
      fakes.bucketDeletes.push(input.bucket);
      fakes.buckets = fakes.buckets.filter((name) => name !== input.bucket);
    },
  };
}

function exited(code: number, stdout = ''): ManagementHostExecOutcome {
  return { kind: 'exited', code, stdout, stderr: '' };
}

function host(fakes: Fakes): ManagementHostAccess {
  return {
    async writeFile(_target, path, content, mode) {
      if (fakes.writeFailures > 0) {
        fakes.writeFailures -= 1;
        throw new Error(
          'SSH control master closed before the command produced any output',
        );
      }
      fakes.written.push({ path, content, mode });
    },
    async reachable() {
      fakes.execLog.push('<probe>');
      if (fakes.sshBootsAfterProbes > 0) {
        fakes.sshBootsAfterProbes -= 1;
        return false;
      }
      return true;
    },
    async exec(_target, command) {
      fakes.execLog.push(command);
      if (fakes.sshBootsAfterProbes > 0) {
        fakes.sshBootsAfterProbes -= 1;
        return { kind: 'unreachable', error: 'connection refused' };
      }
      if (command === 'echo ready') return exited(0, 'ready\n');
      if (command.includes('openssl s_client')) {
        if (fakes.tlsUnservedProbes > 0) {
          fakes.tlsUnservedProbes -= 1;
          return exited(1);
        }
        return exited(0, `${fakes.issued.at(-1)}\n`);
      }
      if (command === MANAGEMENT_LABEL_COMMAND) {
        fail(fakes, 'label');
        return exited(0);
      }
      if (command === MANAGEMENT_KUBERNETES_READY_COMMAND) {
        return exited(0, fakes.hostReady ? 'True\n' : 'NotReady\n');
      }
      if (command === INSTALLER_ACCESS_READ_COMMAND) {
        fail(fakes, 'read-access');
        return exited(
          0,
          `${JSON.stringify({ certificateAuthorityData: CA, token: INSTALLER_TOKEN })}\n`,
        );
      }
      if (fakes.preparingPolls > 0) {
        fakes.preparingPolls -= 1;
        return exited(64);
      }
      if (fakes.staleStagedPolls > 0) {
        fakes.staleStagedPolls -= 1;
        return exited(66);
      }
      fail(fakes, 'configure');
      fakes.hostReady = true;
      fakes.hostConfig = fakes.written.at(-1)!.content;
      return exited(0);
    },
  };
}

function releases(fakes: Fakes): ClusterReleaseClient {
  return {
    async ensureNamespace(_connection, namespace) {
      fakes.namespaces.add(namespace);
    },
    async deleteObject(_connection, object) {
      fakes.deletedObjects.push({
        kind: object.kind,
        name: object.metadata.name,
      });
    },
    async applyObject(_connection, object) {
      fakes.appliedObjects.push({
        kind: object.kind,
        name: object.metadata.name,
        namespace: object.metadata.namespace,
      });
    },
    async readCustomResourceDefinition(_connection, name) {
      fakes.crdReads.push(name);
      if (fakes.crdAbsentPolls > 0) {
        fakes.crdAbsentPolls -= 1;
        return null;
      }
      return { established: true };
    },
    async getHelmChart() {
      return fakes.helmChart;
    },
    async applyHelmChart(_connection, chart, expectedResourceVersion) {
      fail(fakes, 'apply');
      // A real API server refuses an object in a namespace it does not have.
      if (!fakes.namespaces.has(chart.metadata.namespace)) {
        throw Object.assign(
          new Error(`namespaces "${chart.metadata.namespace}" not found`),
          { code: 404 },
        );
      }
      if (fakes.conflicts > 0) {
        fakes.conflicts -= 1;
        throw new ClusterReleaseConflictError();
      }
      // A real API server rejects a stale precondition; the fake mirrors it.
      if (
        (fakes.helmChart?.metadata.resourceVersion ?? null) !==
        expectedResourceVersion
      ) {
        throw new ClusterReleaseConflictError();
      }
      fakes.applied.push(chart);
      fakes.helmChart = {
        ...chart,
        metadata: {
          ...chart.metadata,
          resourceVersion: String(fakes.applied.length),
        },
      };
      fail(fakes, 'after-apply');
    },
    async observeRelease(_connection, { apiUrl }) {
      fakes.lookups.push(`fetch ${apiUrl}`);
      return fakes.releaseReady
        ? { ready: true, pod: 'anycloud-api-1' }
        : { ready: false, reason: 'not ready' };
    },
    async describeRelease() {
      return 'helm Job helm-install-anycloud-api 1 active: helm-install-anycloud-api-x1 Pending; last event: FailedScheduling: 1 node(s) had untolerated taint {dedicated: management}. API Pods: none';
    },
  };
}

describe('kubernetes clusters domain', () => {
  let fakes: Fakes;
  let observe: ReturnType<
    typeof vi.fn<(connection: unknown) => Promise<string>>
  >;
  let scheduled: Array<() => Promise<void>>;
  let dependencies: ClusterDomainDependencies;
  let clock: number;
  let generated: number;
  /** What the API image names as its chart, and the references read. */
  let chart: string;
  let resolved: string[];

  async function drain(): Promise<void> {
    while (scheduled.length > 0) {
      const task = scheduled.shift()!;
      await task();
    }
  }

  function domain(overrides: Partial<ClusterDomainDependencies> = {}) {
    return createClustersDomain({
      ...dependencies,
      ...overrides,
    });
  }

  async function storedStep(id: string) {
    const [row] = await getDB().query<{ step: string }>(
      'SELECT step FROM clusters WHERE id = ?',
      [id],
    );
    return row?.step;
  }

  async function installationRow() {
    const rows = await getDB().query<Record<string, unknown>>(
      'SELECT * FROM clusters',
    );
    return rows;
  }

  async function vmRows() {
    return getDB().query<{
      id: number;
      cloud_id: string;
      ip: string | null;
      ended_at: number | null;
      cluster_id: string;
    }>('SELECT id, cloud_id, ip, ended_at, cluster_id FROM vms ORDER BY id');
  }

  beforeEach(async () => {
    resetPersistence();
    await getDB().query(
      `INSERT INTO credentials (id, encrypted_data, cloud_provider, name, created_at, last_used_at)
       VALUES ('cred-aws', 'opaque', 'AWS', 'aws-compute', 1, 1)`,
    );
    fakes = {
      provisionCalls: 0,
      releaseCalls: 0,
      buckets: [],
      bucketDeletes: [],
      provisioned: new Map(),
      found: [],
      execLog: [],
      written: [],
      writeFailures: 0,
      staleStagedPolls: 0,
      sshBootsAfterProbes: 0,
      preparingPolls: 0,
      hostReady: false,
      hostConfig: null,
      namespaces: new Set(),
      appliedObjects: [],
      crdAbsentPolls: 0,
      crdReads: [],
      deletedObjects: [],
      dns: [],
      propagationMs: 0,
      publicRecordAt: Number.POSITIVE_INFINITY,
      lookups: [],
      issued: [],
      originPullCa: null,
      tlsUnservedProbes: 0,
      hostedPools: { kind: 'pools', pools: [] },
      inventoryCalls: 0,
      backups: 0,
      backupFailure: null,
      helmChart: null,
      applied: [],
      conflicts: 0,
      releaseReady: true,
      failAt: null,
    };
    scheduled = [];
    clock = 1_700_000_000_000;
    generated = 0;
    chart = CHART;
    resolved = [];
    observe = vi.fn(async () => IDENTITY);
    const persistence = getPersistence();
    dependencies = {
      installations: persistence.clusters,
      clusterRecords: {
        getConnection: (clusterId) =>
          persistence.clusterRecords.getConnection(clusterId),
        listForScope: (scope) => persistence.clusterRecords.listForScope(scope),
        getForScope: (id, scope) =>
          persistence.clusterRecords.getForScope(id, scope),
        getByNameForScope: (name, scope) =>
          persistence.clusterRecords.getByNameForScope(name, scope),
        storeConnection: async (input) => {
          const result =
            await persistence.clusterRecords.storeConnection(input);
          fail(fakes, 'after-register');
          return result;
        },
      },
      dns: {
        publish: async (subdomain, ip, token) => {
          fakes.dns.push(`publish ${subdomain} ${ip} ${token}`);
          fakes.publicRecordAt = clock + fakes.propagationMs;
        },
        publicARecordExists: async (hostname) => {
          const resolves = clock >= fakes.publicRecordAt;
          fakes.lookups.push(
            `1.1.1.1 ${hostname} ${resolves ? 'A' : 'NXDOMAIN'}`,
          );
          return resolves;
        },
        remove: async (subdomain, token) => {
          fakes.dns.push(`remove ${subdomain} ${token}`);
        },
        issueCertificate: async (subdomain, csr, token) => {
          expect(csrSubjectAltNames(csr)).toEqual([`${subdomain}.anycloud.sh`]);
          fail(fakes, 'issue');
          fakes.issued.push(`CERT ${fakes.issued.length + 1}`);
          fakes.dns.push(`issue ${subdomain} ${token}`);
          return {
            certificate: fakes.issued.at(-1)!,
            originPullCa: fakes.originPullCa,
          };
        },
        activateTls: async (subdomain, token) => {
          fakes.dns.push(`activate ${subdomain} ${token}`);
        },
        removeTls: async (subdomain, token) => {
          fakes.dns.push(`remove-tls ${subdomain} ${token}`);
        },
      },
      hostedPools: {
        inventory: async () => {
          fakes.inventoryCalls += 1;
          return fakes.hostedPools;
        },
        backup: async () => {
          if (fakes.backupFailure) throw new Error(fakes.backupFailure);
          fakes.backups += 1;
          return { backedUpAt: '2026-11-04T18:12:03.000Z' };
        },
      },
      credentials: persistence.credentialSecrets,
      storageCredential: async () => ({
        cloudProvider: CloudType.AWS,
        credentials: {
          cloudProvider: CloudType.AWS,
          accessKeyId: 'AKIA',
          secretAccessKey: 'secret',
        },
      }),
      cloudAccount: async () => '123456789012',
      checkpointBucket: async (_credential, bucket, region) => ({
        exists: bucket !== 'missing-bucket',
        region,
      }),
      backupManifest: async () => null,
      validateTarget: async (input) => ({
        region: input.region,
        zone: input.zone ?? null,
        vmType: input.vmType,
      }),
      infrastructure: infrastructure(fakes),
      host: host(fakes),
      releases: releases(fakes),
      resolveApiImage: async (reference) => {
        resolved.push(reference);
        return { digest: DIGEST, chart };
      },
      observeKubernetesIdentity: observe,
      generateId: (name) => `install-${name}-${++generated}`,
      generateOperationId: () => `op-${Math.random().toString(36).slice(2, 8)}`,
      generateServerToken: () => 'server-token',
      generateSshKeypair: async () => ({
        publicKey: 'ssh-ed25519 AAAA anycloud',
        privateKey:
          '-----BEGIN OPENSSH PRIVATE KEY-----\nkey\n-----END OPENSSH PRIVATE KEY-----\n',
      }),
      resolveScope: async () => ({ kind: 'api' }),
      apiVersion: '0.1.64',
      ownApiImage: null,
      schedule: (task) => {
        scheduled.push(task);
      },
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
      log: { info: () => {}, warn: () => {} },
    };
  });

  it('records durable intent with the pinned toolchain before any cloud mutation', async () => {
    const { cluster } = await domain().create(actor, request);

    expect(fakes.provisionCalls).toBe(0);
    expect(cluster).toMatchObject({
      id: 'install-production-1',
      state: WorkloadState.Provisioning,
      releasing: false,
      cloudProvider: 'AWS',
      region: 'us-east-1',
      vmType: 't3.medium',
      k3sVersion: SYSTEM_RELEASE_K3S_VERSION,
      apiImage: `ghcr.io/anycloud-sh/api:0.1.64@${DIGEST}`,
      chartVersion: '0.1.64',
      address: null,
      managementApiUrl: null,
      release: null,
    });
    const [row] = await installationRow();
    expect(row).toMatchObject({
      k3s_sha256: SYSTEM_RELEASE_K3S_SHA256,
      helm_job_image: SYSTEM_RELEASE_HELM_JOB_IMAGE,
      chart_sha256: CHART_SHA,
      compute_credential_id: 'cred-aws',
    });
    expect(String(row.encrypted_server_token)).not.toContain('server-token');
    expect(String(row.encrypted_ssh_private_key)).not.toContain(
      'BEGIN OPENSSH',
    );
  });

  it('completes every step in order and lands the management VM in the ledger with its owner', async () => {
    const { cluster } = await domain().create(actor, request);
    await drain();

    const ready = await domain().get(actor, cluster.id);
    expect(ready.cluster).toMatchObject({
      state: WorkloadState.Running,
      connected: true,
      kubernetesIdentity: IDENTITY,
      address: '203.0.113.1',
      managementApiUrl: `https://${cluster.id}.anycloud.sh`,
      release: { apiImage: `ghcr.io/anycloud-sh/api:0.1.64@${DIGEST}` },
    });
    await expect(
      getPersistence().clusters.currentReleaseIntent(cluster.id),
    ).resolves.toMatchObject({
      revision: 1,
      state: ClusterReleaseState.Completed,
    });
    // The release namespace is created before the HelmChart that lives in it.
    expect([...fakes.namespaces]).toEqual(['anycloud-system']);
    expect(await vmRows()).toEqual([
      {
        id: 1,
        cloud_id: `anycloud-cluster-${cluster.id}`,
        ip: '203.0.113.1',
        ended_at: null,
        cluster_id: cluster.id,
      },
    ]);
    const { clusterRecords } = await getPersistence()
      .clusterRecords.listForScope({ kind: 'api' })
      .then((list) => ({ clusterRecords: list }));
    expect(clusterRecords).toHaveLength(1);
    expect(clusterRecords[0]).toMatchObject({
      name: 'production',
      kubernetesIdentity: IDENTITY,
      state: ClusterState.Ready,
    });
    expect(fakes.applied).toHaveLength(1);
    const applied = fakes.applied[0];
    expect(applied.metadata.annotations[RELEASE_REVISION_ANNOTATION]).toBe('1');
    expect(applied.metadata.annotations[RELEASE_INSTALLATION_ANNOTATION]).toBe(
      cluster.id,
    );
    // The chart the pinned image names, read again from that image.
    expect(applied.spec.chart).toBe(CHART);
    expect(resolved).toEqual([
      'ghcr.io/anycloud-sh/api:0.1.64',
      `ghcr.io/anycloud-sh/api:0.1.64@${DIGEST}`,
      `ghcr.io/anycloud-sh/api:0.1.64@${DIGEST}`,
    ]);
    expect(applied.spec.failurePolicy).toBe('abort');
    expect(applied.spec.jobImage).toBe(SYSTEM_RELEASE_HELM_JOB_IMAGE);
    const values = JSON.parse(applied.spec.valuesContent) as {
      release: { image: string; revision: number };
      installation: {
        ownerUsername: string;
        ownerUserId: string;
        apiUrl: string;
      };
      backup: { bucket: string; region: string; cloudProvider: string };
      ingress: { mode: string; host: string };
    };
    // No --checkpoint-bucket: an Anycloud-managed bucket named after the
    // installation, created and versioned before the release names it, with
    // the compute credential.
    expect(fakes.buckets).toEqual([cluster.id]);
    expect(values.backup).toMatchObject({
      bucket: cluster.id,
      region: 'us-east-1',
      cloudProvider: CloudType.AWS,
    });
    expect(values.release.image).toBe(
      `ghcr.io/anycloud-sh/api:0.1.64@${DIGEST}`,
    );
    expect(values.installation).toEqual({
      id: cluster.id,
      ownerUsername: 'owner',
      ownerUserId: '4242',
      githubAppIds: [],
      apiUrl: `https://${cluster.id}.anycloud.sh`,
    });
    expect(values.ingress).toEqual({
      mode: 'traefik',
      host: `${cluster.id}.anycloud.sh`,
    });
    // Ingress before the release: Traefik pinned to the management Node, the
    // hostname record on the VM's public address and its Origin CA
    // certificate, through the Worker with the actor's token and never
    // stored. Full (strict) only once the VM serves that certificate on 443.
    expect(fakes.appliedObjects).toEqual([
      {
        kind: 'HelmChart',
        name: 'anycloud-api-ingress',
        namespace: 'kube-system',
      },
      { kind: 'Secret', name: API_TLS_SECRET, namespace: 'anycloud-system' },
    ]);
    expect(fakes.dns).toEqual([
      `publish ${cluster.id} 203.0.113.1 ${actor.token}`,
      `issue ${cluster.id} ${actor.token}`,
      `activate ${cluster.id} ${actor.token}`,
    ]);
    // No origin pull CA: none is left behind to demand a client certificate.
    expect(fakes.deletedObjects).toEqual([
      { kind: 'TLSOption', name: 'default' },
      { kind: 'Secret', name: API_TLS_CA_SECRET },
    ]);
    // The VM's firewall is reconciled to admit 443 before the probe.
    expect(fakes.execLog.slice(-2)).toEqual([
      `<ingress anycloud-cluster-${cluster.id}>`,
      apiTlsProbeCommand(`${cluster.id}.anycloud.sh`),
    ]);
  });

  it('asks 1.1.1.1 until the new record answers before the first fetch of the public URL', async () => {
    fakes.propagationMs = 40_000;
    const { cluster } = await domain().create(actor, request);
    await drain();

    // A lookup inside the propagation gap would cache NXDOMAIN on this
    // machine for 30 minutes: 1.1.1.1 is first asked 10 s after
    // publish, then every 5 s, and the readiness loop fetches only after an A
    // answer.
    const hostname = `${cluster.id}.anycloud.sh`;
    const firstFetch = fakes.lookups.indexOf(`fetch https://${hostname}`);
    expect(fakes.lookups.slice(0, firstFetch)).toEqual([
      ...Array<string>(6).fill(`1.1.1.1 ${hostname} NXDOMAIN`),
      `1.1.1.1 ${hostname} A`,
    ]);
    expect((await domain().get(actor, cluster.id)).cluster.state).toBe(
      WorkloadState.Running,
    );
  });

  it('fails the release naming the hostname within three requests when 1.1.1.1 cannot be reached', async () => {
    let published = 0;
    const unreachable = domain({
      dns: {
        ...dependencies.dns,
        publish: async (...args) => {
          await dependencies.dns.publish(...args);
          published = clock;
        },
        publicARecordExists: async () => {
          fakes.lookups.push('1.1.1.1 fetch failed');
          throw new Error('fetch failed');
        },
      },
    });
    const { cluster } = await unreachable.create(actor, request);
    await drain();

    const failed = await getPersistence().clusters.getForScope(cluster.id, {
      kind: 'api',
    });
    expect(failed?.state).toBe(ClusterState.Failed);
    expect(failed?.lastError).toContain(
      `1.1.1.1 didn't answer the DNS over HTTPS query for ${cluster.id}.anycloud.sh (fetch failed); this network may block it`,
    );
    // A blocked network fails at the third request, 20 s after the first,
    // not at the 35-minute deadline, and the public URL is never fetched.
    expect(fakes.lookups).toEqual(Array(3).fill('1.1.1.1 fetch failed'));
    expect(clock - published).toBe(20_000);
  });

  it('keeps asking 1.1.1.1 while no three requests in a row fail', async () => {
    // Four failures in all, but an NXDOMAIN answer between the pairs.
    const answers = ['fail', 'fail', 'NXDOMAIN', 'fail', 'fail'];
    const flaky = domain({
      dns: {
        ...dependencies.dns,
        publicARecordExists: async (hostname, signal) => {
          const answer = answers.shift();
          if (answer === 'fail') throw new Error('fetch failed');
          if (answer === 'NXDOMAIN') return false;
          return dependencies.dns.publicARecordExists(hostname, signal);
        },
      },
    });
    const { cluster } = await flaky.create(actor, request);
    await drain();

    expect(answers).toEqual([]);
    expect((await flaky.get(actor, cluster.id)).cluster.state).toBe(
      WorkloadState.Running,
    );
  });

  it('activates Full (strict) only once 443 serves the certificate just issued', async () => {
    fakes.tlsUnservedProbes = 2;
    const { cluster } = await domain().create(actor, request);
    await drain();

    const probes = fakes.execLog.filter((c) => c.includes('openssl s_client'));
    expect(probes).toHaveLength(3);
    expect(fakes.dns.at(-1)).toBe(`activate ${cluster.id} ${actor.token}`);
    expect((await domain().get(actor, cluster.id)).cluster.state).toBe(
      WorkloadState.Running,
    );
  });

  it('fails the release without activation when 443 never serves the certificate, and a resume issues a fresh one', async () => {
    fakes.tlsUnservedProbes = 1_000;
    const { cluster } = await domain().create(actor, request);
    await drain();

    const failed = await getPersistence().clusters.getForScope(cluster.id, {
      kind: 'api',
    });
    expect(failed?.state).toBe(ClusterState.Failed);
    expect(failed?.lastError).toMatch(
      /did not serve the API's origin certificate on port 443 within 3 minutes \(it served no certificate\)/,
    );
    expect(fakes.dns.some((entry) => entry.startsWith('activate'))).toBe(false);

    fakes.tlsUnservedProbes = 0;
    await domain().create(actor, request);
    await drain();
    expect(fakes.issued).toEqual(['CERT 1', 'CERT 2']);
    expect(fakes.dns.at(-1)).toBe(`activate ${cluster.id} ${actor.token}`);
  });

  it('labels the management Node before Traefik, also on a create resumed past the ready step', async () => {
    expect(MANAGEMENT_KUBERNETES_READY_COMMAND).toContain(
      MANAGEMENT_LABEL_COMMAND,
    );
    expect(MANAGEMENT_LABEL_COMMAND).toBe(
      '/usr/local/bin/k3s kubectl label node anycloud-management node-restriction.kubernetes.io/anycloud-management=true --overwrite',
    );
    fakes.failAt = 'label';
    const { cluster } = await domain().create(actor, request);
    await drain();
    expect(await storedStep(cluster.id)).toBe(ClusterStep.ReleaseIntent);
    expect(fakes.appliedObjects).toEqual([]);

    fakes.execLog = [];
    await domain().create(actor, request);
    await drain();
    expect(fakes.execLog).not.toContain(MANAGEMENT_KUBERNETES_READY_COMMAND);
    expect(fakes.execLog[0]).toBe(MANAGEMENT_LABEL_COMMAND);
    expect(fakes.appliedObjects[0]?.name).toBe('anycloud-api-ingress');
  });

  it("requires Cloudflare's client certificate when the Worker hands out the origin pull CA", async () => {
    fakes.originPullCa = 'CA PEM';
    await domain().create(actor, request);
    await drain();
    expect(fakes.appliedObjects.slice(1)).toEqual([
      { kind: 'Secret', name: API_TLS_SECRET, namespace: 'anycloud-system' },
      { kind: 'Secret', name: API_TLS_CA_SECRET, namespace: 'anycloud-system' },
      { kind: 'TLSOption', name: 'default', namespace: 'anycloud-system' },
    ]);
    expect(fakes.deletedObjects).toEqual([]);
  });

  it('surfaces a superseded issuance and issues afresh on resume, never serving the revoked certificate', async () => {
    fakes.failAt = 'issue';
    const { cluster } = await domain().create(actor, request);
    await drain();
    const failed = await getPersistence().clusters.getForScope(cluster.id, {
      kind: 'api',
    });
    expect(failed?.state).toBe(ClusterState.Failed);
    expect(failed?.lastError).toMatch(/injected failure at issue/);
    expect(
      fakes.appliedObjects.some((object) => object.name === API_TLS_SECRET),
    ).toBe(false);

    await domain().create(actor, request);
    await drain();
    expect(fakes.issued).toEqual(['CERT 1']);
    expect(fakes.dns.at(-1)).toBe(`activate ${cluster.id} ${actor.token}`);
  });

  it('drops a stale origin pull CA when the Worker stops handing one out', async () => {
    fakes.originPullCa = 'CA PEM';
    fakes.tlsUnservedProbes = 1_000;
    const { cluster } = await domain().create(actor, request);
    await drain();
    expect(fakes.deletedObjects).toEqual([]);

    fakes.originPullCa = null;
    fakes.tlsUnservedProbes = 0;
    await domain().create(actor, request);
    await drain();
    expect(fakes.deletedObjects).toEqual([
      { kind: 'TLSOption', name: 'default' },
      { kind: 'Secret', name: API_TLS_CA_SECRET },
    ]);
    expect(fakes.dns.at(-1)).toBe(`activate ${cluster.id} ${actor.token}`);
  });

  it('never activates Full (strict) while the VM firewall cannot be reconciled to admit 443', async () => {
    fakes.failAt = 'ingress';
    const { cluster } = await domain().create(actor, request);
    await drain();
    const failed = await getPersistence().clusters.getForScope(cluster.id, {
      kind: 'api',
    });
    expect(failed?.state).toBe(ClusterState.Failed);
    expect(failed?.lastError).toMatch(/injected failure at ingress/);
    expect(fakes.execLog.some((c) => c.includes('openssl s_client'))).toBe(
      false,
    );
    expect(fakes.dns.some((entry) => entry.startsWith('activate'))).toBe(false);

    // A resume opens 443, then activates.
    await domain().create(actor, request);
    await drain();
    expect(fakes.dns.at(-1)).toBe(`activate ${cluster.id} ${actor.token}`);
  });

  it('binds a local caller cluster to the GitHub account behind its sign-in', async () => {
    const local: User = {
      id: `local:${'1'.repeat(32)}`,
      username: 'local',
      token: 'gho_local_sign_in',
    };
    const lookup = vi.spyOn(Github, 'authenticate').mockResolvedValue({
      id: '42',
      username: 'octocat',
      scopes: [],
    });
    try {
      const { cluster } = await domain().create(local, request);
      await drain();
      expect(lookup).toHaveBeenCalledWith('gho_local_sign_in', undefined);
      const values = JSON.parse(fakes.applied[0].spec.valuesContent) as {
        installation: { ownerUsername: string; ownerUserId: string };
      };
      expect(values.installation).toMatchObject({
        ownerUsername: 'octocat',
        ownerUserId: '42',
      });
      expect(fakes.dns).toEqual([
        `publish ${cluster.id} 203.0.113.1 gho_local_sign_in`,
        `issue ${cluster.id} gho_local_sign_in`,
        `activate ${cluster.id} gho_local_sign_in`,
      ]);
    } finally {
      lookup.mockRestore();
    }
  });

  it('stops a local caller without a GitHub sign-in before recording anything', async () => {
    const local: User = {
      id: `local:${'1'.repeat(32)}`,
      username: 'local',
      token: null,
    };
    await expect(domain().create(local, request)).rejects.toBeInstanceOf(
      GithubSignInRequiredError,
    );
    await expect(
      getPersistence().clusterRecords.listForScope({ kind: 'api' }),
    ).resolves.toEqual([]);
  });

  it('refuses destroy while the hosted API manages node pools and names the steps', async () => {
    const { cluster } = await domain().create(actor, request);
    await drain();
    fakes.hostedPools = {
      kind: 'pools',
      pools: [
        { id: 'np-1', name: 'gpu-a', liveReferences: 2 },
        { id: 'np-2', name: 'cpu-b', liveReferences: 0 },
      ],
    };
    await expect(domain().destroy(actor, cluster.id, KEEP)).rejects.toThrow(
      /Node pool gpu-a still has Deployments or Services.*anycloud deployment delete <id> \/ anycloud terminate <id>, then anycloud node-pool delete <name>, then anycloud api delete production again\.$/,
    );
    fakes.hostedPools = {
      kind: 'pools',
      pools: [{ id: 'np-2', name: 'cpu-b', liveReferences: 0 }],
    };
    await expect(domain().destroy(actor, cluster.id, KEEP)).rejects.toThrow(
      /Node pool cpu-b still exists.*anycloud node-pool delete <name>, then anycloud api delete production again\.$/,
    );
  });

  it('forgets a destroyed cluster naming only the Workload resources that can remain', async () => {
    const { cluster } = await domain().create(actor, request);
    await drain();
    await domain().destroy(actor, cluster.id, DELETE_BUCKETS);
    await drain();
    fakes.hostedPools = { kind: 'unreachable', reason: 'no such host' };
    await expect(domain().forget(actor, cluster.id)).resolves.toMatchObject({
      leftovers: [
        expect.stringMatching(/^Workload VMs, networks and disks tagged /),
      ],
    });
  });

  it('with an unreachable hosted API and a backup, delete, restore and delete again on one installer', async () => {
    const zoned = {
      ...request,
      zone: 'us-east-1a',
      checkpointBucket: 'my-api-state',
    };
    const { cluster } = await domain().create(actor, zoned);
    await drain();
    const manifest = {
      version: 1 as const,
      clusterId: cluster.id,
      backedUpAt: '2026-09-27T12:00:00.000Z',
      schemaAppVersion: '0.1.64',
      databaseSha256: 'a'.repeat(64),
    };
    const withBackup = domain({ backupManifest: async () => manifest });
    fakes.hostedPools = { kind: 'unreachable', reason: 'connect timeout' };
    await expect(withBackup.destroy(actor, cluster.id, KEEP)).rejects.toThrow(
      `The hosted API at https://${cluster.id}.anycloud.sh is unreachable (connect timeout). Restore it with anycloud api create production --cloud aws --region us-east-1 --zone us-east-1a --vm-type t3.medium --checkpoint-bucket my-api-state (if its management VM anycloud-cluster-${cluster.id} still runs but the cluster is broken, terminate that VM first), then run anycloud api delete production.`,
    );
    // The management VM is gone; the restore replaces the record.
    fakes.provisioned.clear();
    fakes.helmChart = null;
    fakes.applied = [];
    await withBackup.create(actor, zoned);
    await drain();
    fakes.hostedPools = { kind: 'pools', pools: [] };
    await withBackup.destroy(actor, cluster.id, KEEP);
    await drain();
    expect(await installationRow()).toMatchObject([
      { id: cluster.id, state: ClusterState.Destroyed },
    ]);
  });

  it('with an unreachable hosted API and no backup, delete names the VMs, and forget needs the management VM gone', async () => {
    const { cluster } = await domain().create(actor, request);
    await drain();
    await expect(domain().forget(actor, cluster.id)).rejects.toThrow(
      'is reachable; run anycloud api delete production instead',
    );
    const refusing = domain({
      hostedPools: {
        ...dependencies.hostedPools,
        inventory: async () => {
          throw new HostedApiAccessError('https://x', 403);
        },
      },
    });
    await expect(refusing.forget(actor, cluster.id)).rejects.toThrow(
      `answered but refused this account (HTTP 403), so it is reachable. Sign in as the account that bootstrapped it, then run anycloud api delete production.`,
    );
    const rejecting = domain({
      hostedPools: {
        ...dependencies.hostedPools,
        inventory: async () => {
          throw new HostedApiAccessError('https://x', 400, 'x');
        },
      },
    });
    await expect(rejecting.forget(actor, cluster.id)).rejects.toThrow(
      'The hosted API at https://x rejected the node pool check (HTTP 400: x), so it is reachable; run anycloud api delete production instead.',
    );
    expect(new HostedApiAccessError('https://x', 400).message).toBe(
      'The hosted API at https://x rejected the node pool check (HTTP 400)',
    );
    fakes.hostedPools = { kind: 'unreachable', reason: 'connect timeout' };
    const hand = new RegExp(
      `Terminate management VM anycloud-cluster-${cluster.id} and Workload VMs tagged anycloud_owner_api=[0-9a-f]{32}, then run anycloud api delete production --skip-cloud; it names what else is left\\.$`,
    );
    await expect(domain().destroy(actor, cluster.id, KEEP)).rejects.toThrow(
      new RegExp(
        `unreachable \\(connect timeout\\) and its bucket holds no restorable backup\\. ${hand.source}`,
      ),
    );
    const unreadable = domain({
      backupManifest: async () => {
        throw new Error('AccessDenied');
      },
    });
    await expect(unreadable.destroy(actor, cluster.id, KEEP)).rejects.toThrow(
      new RegExp(
        `its backup could not be read \\(AccessDenied\\)\\. ${hand.source}`,
      ),
    );
    await expect(domain().forget(actor, cluster.id)).rejects.toThrow(
      `Management VM anycloud-cluster-${cluster.id} of cluster "production" still exists. Terminate it, then run anycloud api delete production --skip-cloud again.`,
    );
    const releases = fakes.releaseCalls;
    fakes.provisioned.clear();
    fakes.dns = [];
    await expect(domain().forget(actor, cluster.id)).resolves.toEqual({
      id: cluster.id,
      name: 'production',
      leftovers: [
        `the management VM's network resources named anycloud-cluster-${cluster.id} (its security group, firewall or network)`,
        expect.stringMatching(
          /^Workload VMs, networks and disks tagged anycloud_owner_api=[0-9a-f]{32}$/,
        ),
        `checkpoint bucket ${cluster.id}, kept on purpose with its backups; delete it only if you no longer need them`,
      ],
    });
    expect(fakes.dns).toEqual([
      `remove-tls ${cluster.id} ${actor.token}`,
      `remove ${cluster.id} ${actor.token}`,
    ]);
    expect(await installationRow()).toEqual([]);
    expect(await vmRows()).toEqual([]);
    expect(fakes.releaseCalls).toBe(releases);
    expect(fakes.bucketDeletes).toEqual([]);
    // A later restore records the cluster again under the same id.
    fakes.helmChart = null;
    fakes.applied = [];
    const restoring = domain({
      backupManifest: async () => ({
        version: 1,
        clusterId: cluster.id,
        backedUpAt: '2026-09-27T12:00:00.000Z',
        schemaAppVersion: '0.1.64',
        databaseSha256: 'a'.repeat(64),
      }),
    });
    await restoring.create(actor, {
      ...request,
      checkpointBucket: cluster.id,
    });
    expect(await installationRow()).toMatchObject([
      { id: cluster.id, restore_from_backup: 1 },
    ]);
  });

  it('keeps polling when the configuration write hits a transport failure and re-stages only on exit 66', async () => {
    fakes.writeFailures = 2;
    fakes.staleStagedPolls = 1;
    const { cluster } = await domain().create(actor, request);
    await drain();
    expect((await domain().get(actor, cluster.id)).cluster.state).toBe(
      WorkloadState.Running,
    );
    // Two failed writes, then one write; exit 66 re-staged once more.
    expect(fakes.written).toHaveLength(2);
    expect(fakes.provisionCalls).toBe(1);
  });

  it('writes the K3s configuration over the stdin channel and never puts the token on a command line', async () => {
    await domain().create(actor, request);
    await drain();
    expect(fakes.written).toHaveLength(1);
    expect(fakes.written[0]).toMatchObject({
      path: '/etc/rancher/k3s/config.yaml.new',
      mode: 0o600,
    });
    expect(fakes.written[0].content).toContain('token: server-token');
    expect(fakes.written[0].content).toContain('tls-san:\n  - 203.0.113.1');
    for (const command of fakes.execLog) {
      expect(command).not.toContain('server-token');
    }
  });

  it('binds the installer connection to the record and renders the cluster values for the hosted API', async () => {
    const { cluster } = await domain().create(actor, request);
    await drain();

    const connection = {
      kind: 'installer',
      server: 'https://203.0.113.1:6443',
      certificateAuthorityData: CA,
      credential: { kind: 'token', token: INSTALLER_TOKEN },
    };
    expect(observe).toHaveBeenCalled();
    expect(observe.mock.calls[0][0]).toEqual(connection);
    const stored = await getPersistence().clusterRecords.getConnection(
      cluster.id,
    );
    expect(stored).toMatchObject({
      kind: 'installer',
      kubernetesIdentity: IDENTITY,
      connectionRevision: 2,
    });
    expect(parseClusterConnection(stored!.connection)).toEqual(connection);
    const values = JSON.parse(fakes.applied[0].spec.valuesContent) as {
      cluster: Record<string, unknown>;
    };
    const vm = await getPersistence().clusters.getManagementVm(cluster.id);
    // What delete and upgrade need, and no secret (RFC 0049 C26 (a)).
    const record = {
      cloudProvider: CloudType.AWS,
      cloudAccount: '123456789012',
      region: 'us-east-1',
      zone: null,
      vmType: 't3.medium',
      managementVmId: vm!.cloudId,
      networkScope: `anycloud-cluster-${cluster.id}`,
      k3s: {
        version: SYSTEM_RELEASE_K3S_VERSION,
        sha256: SYSTEM_RELEASE_K3S_SHA256,
      },
      checkpointBucket: { name: cluster.id, managed: true },
    };
    expect(values.cluster).toEqual({
      name: 'production',
      kubernetesIdentity: IDENTITY,
      joinEndpoint: 'https://203.0.113.1:6443',
      certificateAuthorityData: CA,
      record,
    });
    const { serverToken, sshPrivateKey } =
      await getPersistence().clusters.getBootstrapSecrets(cluster.id);
    for (const secret of [serverToken, sshPrivateKey.trim()]) {
      expect(fakes.applied[0].spec.valuesContent).not.toContain(secret);
    }
  });

  it.each([
    ['before-provision', ClusterStep.Intent],
    ['after-provision', ClusterStep.Intent],
    ['configure', ClusterStep.ManagementVm],
    ['read-access', ClusterStep.Kubernetes],
    ['after-register', ClusterStep.Kubeconfig],
    ['apply', ClusterStep.ReleaseIntent],
    ['after-apply', ClusterStep.ReleaseIntent],
  ])(
    'resumes after an interruption at %s without duplicating resources',
    async (point, expectedStep) => {
      fakes.failAt = point;
      const first = await domain().create(actor, request);
      await drain();

      const failed = await domain().get(actor, first.cluster.id);
      expect(failed.cluster.state).toBe(WorkloadState.Failed);
      expect(await storedStep(failed.cluster.id)).toBe(expectedStep);
      expect(failed.cluster.lastError).toContain(
        `injected failure at ${point}`,
      );

      const resumed = await domain().create(actor, request);
      expect(resumed.cluster.id).toBe(first.cluster.id);
      await drain();

      const ready = await domain().get(actor, first.cluster.id);
      expect(ready.cluster.state).toBe(WorkloadState.Running);
      expect(fakes.provisioned.size).toBe(1);
      expect(
        (await vmRows()).filter((vm) => vm.ended_at === null),
      ).toHaveLength(1);
      expect(await installationRow()).toHaveLength(1);
      const clusterRecords = await getPersistence().clusterRecords.listForScope(
        { kind: 'api' },
      );
      expect(clusterRecords).toHaveLength(1);
      const intents = await getDB().query(
        'SELECT revision FROM cluster_releases',
      );
      expect(intents).toHaveLength(1);
      expect(fakes.applied).toHaveLength(1);
    },
  );

  it('seeds release intent once and re-applies the same operation on resume', async () => {
    fakes.releaseReady = false;
    const first = await domain().create(actor, request);
    await drain();
    // Release timed out (deadline is enforced by the domain; sleep is a no-op
    // so it exhausts quickly) and left revision 1 applied but not completed.
    const stalled = await domain().get(actor, first.cluster.id);
    expect(stalled.cluster.state).toBe(WorkloadState.Failed);
    const release = () =>
      getPersistence().clusters.currentReleaseIntent(first.cluster.id);
    expect(await release()).toMatchObject({
      revision: 1,
      state: ClusterReleaseState.Failed,
    });
    // The recorded error carries what the cluster reported, not only the verdict.
    expect(stalled.cluster.lastError).toBe(
      'API system release did not reach its requested target: not ready. Cluster reports: helm Job helm-install-anycloud-api 1 active: helm-install-anycloud-api-x1 Pending; last event: FailedScheduling: 1 node(s) had untolerated taint {dedicated: management}. API Pods: none',
    );
    const operation = (await release())!.operationId;

    fakes.releaseReady = true;
    await domain().create(actor, request);
    await drain();
    const ready = await domain().get(actor, first.cluster.id);
    expect(ready.cluster.state).toBe(WorkloadState.Running);
    expect(await release()).toMatchObject({
      revision: 1,
      operationId: operation,
      state: ClusterReleaseState.Completed,
    });
    // The cluster already carried this exact revision/operation: nothing was re-applied.
    expect(fakes.applied).toHaveLength(1);
  });

  it('fails the release when the pinned image names another chart than the recorded one', async () => {
    const { cluster } = await domain().create(actor, request);
    chart = `oci://ghcr.io/anycloud-sh/api-k8-chart@sha256:${'d'.repeat(64)}`;
    await drain();

    const outcome = await domain().get(actor, cluster.id);
    expect(outcome.cluster.state).toBe(WorkloadState.Failed);
    expect(outcome.cluster.lastError).toContain(
      `names chart ${chart}, not the recorded sha256:${CHART_SHA}`,
    );
    expect(fakes.applied).toHaveLength(0);
  });

  it('refuses to apply a stale intent over a newer release on the cluster', async () => {
    fakes.helmChart = {
      apiVersion: 'helm.cattle.io/v1',
      kind: 'HelmChart',
      metadata: {
        name: 'anycloud-api',
        namespace: 'anycloud-system',
        annotations: {
          [RELEASE_REVISION_ANNOTATION]: '7',
          [RELEASE_OPERATION_ANNOTATION]: 'op-later',
          [RELEASE_INSTALLATION_ANNOTATION]: 'install-production-1',
        },
      },
      spec: {
        chart: CHART,
        targetNamespace: 'anycloud-system',
        createNamespace: true,
        jobImage: SYSTEM_RELEASE_HELM_JOB_IMAGE,
        bootstrap: true,
        failurePolicy: 'abort',
        backOffLimit: 0,
        timeout: '600s',
        valuesContent: '{}',
      },
    };
    const { cluster } = await domain().create(actor, request);
    await drain();

    const outcome = await domain().get(actor, cluster.id);
    expect(outcome.cluster.state).toBe(WorkloadState.Failed);
    expect(outcome.cluster.lastError).toContain(
      'revision 7 is newer than intent 1',
    );
    expect(fakes.applied).toHaveLength(0);
    expect(
      fakes.helmChart.metadata.annotations[RELEASE_REVISION_ANNOTATION],
    ).toBe('7');
  });

  it('re-returns an in-progress installation instead of scheduling a second bootstrap', async () => {
    const running = domain();
    const first = await running.create(actor, request);
    const replay = await running.create(actor, request);
    expect(replay.cluster.id).toBe(first.cluster.id);
    expect(scheduled).toHaveLength(1);
    await drain();
    expect(fakes.provisionCalls).toBe(1);
  });

  it('resumes an installation left bootstrapping by an API restart', async () => {
    const first = await domain().create(actor, request);
    // The process died before its scheduled task ran; a fresh domain has no
    // in-process record of the task, so the replay resumes the same row.
    scheduled.length = 0;
    const restarted = domain();
    const replay = await restarted.create(actor, request);
    expect(replay.cluster.id).toBe(first.cluster.id);
    expect(scheduled).toHaveLength(1);
    await drain();
    const ready = await restarted.get(actor, first.cluster.id);
    expect(ready.cluster.state).toBe(WorkloadState.Running);
    expect(fakes.provisionCalls).toBe(1);
  });

  it('refuses to delete a cluster whose creation is running', async () => {
    const creating = domain();
    const { cluster } = await creating.create(actor, request);
    await expect(creating.destroy(actor, cluster.id, KEEP)).rejects.toThrow(
      'cluster creation is in progress',
    );
    await drain();
    expect((await creating.get(actor, cluster.id)).cluster.state).toBe(
      WorkloadState.Running,
    );
  });

  it('deletes a cluster whose creation an API restart orphaned, releasing what it made', async () => {
    // The creation provisioned the VM and bucket, then the process died
    // mid-task: the row stays bootstrapping with no task to finish it.
    fakes.failAt = 'configure';
    const { cluster } = await domain().create(actor, request);
    await drain();
    await getDB().query(
      `UPDATE clusters SET state = 'bootstrapping' WHERE id = ?`,
      [cluster.id],
    );
    expect(fakes.provisioned.size).toBe(1);

    const restarted = domain();
    await restarted.destroy(actor, cluster.id, DELETE_BUCKETS);
    await drain();
    const gone = await restarted.get(actor, cluster.id);
    expect(gone.cluster.state).toBe(WorkloadState.Terminated);
    expect(fakes.provisioned.size).toBe(0);
    expect(fakes.bucketDeletes).toEqual([cluster.id]);
    expect((await vmRows()).filter((vm) => vm.ended_at === null)).toHaveLength(
      0,
    );
  });

  it('claims the installation before its first await, so an interleaved create and delete refuse each other', async () => {
    fakes.failAt = 'configure';
    const { cluster } = await domain().create(actor, request);
    await drain();
    // Each phase holds the first state write until the other request ran.
    let entered = () => {};
    let open = () => {};
    let gate = Promise.resolve();
    const hold = () => {
      const reached = new Promise<void>((resolve) => (entered = resolve));
      gate = new Promise<void>((resolve) => (open = resolve));
      return reached;
    };
    const store = dependencies.installations;
    const setState: typeof store.setState = async (id, state, lastError) => {
      entered();
      await gate;
      return store.setState(id, state, lastError);
    };
    const racing = domain({
      installations: new Proxy(store, {
        get(target, property) {
          if (property === 'setState') return setState;
          const value = Reflect.get(target, property) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
    });

    let reached = hold();
    const resuming = racing.create(actor, request);
    await reached;
    await expect(racing.destroy(actor, cluster.id, KEEP)).rejects.toThrow(
      'cluster creation is in progress',
    );
    open();
    await resuming;
    await drain();
    expect((await racing.get(actor, cluster.id)).cluster.state).toBe(
      WorkloadState.Running,
    );

    reached = hold();
    const deleting = racing.destroy(actor, cluster.id, KEEP);
    await reached;
    await expect(racing.create(actor, request)).rejects.toThrow(
      'cluster deletion is in progress',
    );
    open();
    await deleting;
    await drain();
    expect((await racing.get(actor, cluster.id)).cluster.state).toBe(
      WorkloadState.Terminated,
    );
    expect(fakes.provisioned.size).toBe(0);
  });

  it("fills the hosted API's own record with its address, version and URL", async () => {
    await getPersistence().clusters.recordSelf({
      id: 'cluster-hosted',
      ownerUserId: actor.id,
      name: 'hosted',
      kubernetesIdentity: 'uid-hosted',
      connection: serializeClusterConnection({
        kind: 'in-cluster',
        server: 'https://198.51.100.9:6443',
        certificateAuthorityData: 'Y2E=',
      }),
    });

    const { clusters } = await domain({ infrastructure: null }).list(actor);
    const { cluster } = await domain({ infrastructure: null }).get(
      actor,
      'hosted',
    );
    for (const summary of [clusters[0], cluster]) {
      expect(summary).toMatchObject({
        id: 'cluster-hosted',
        address: '198.51.100.9',
        apiVersion: '0.1.64',
        managementApiUrl: 'https://cluster-hosted.anycloud.sh',
        // A record from before 0.1.74 carries no creation facts.
        cloudProvider: null,
        region: null,
        vmType: null,
      });
    }
  });

  it('reports the cluster record the hosted API keeps on its own row', async () => {
    const record = {
      cloudProvider: CloudType.GCP,
      cloudAccount: 'my-project',
      region: 'us-central1',
      zone: 'us-central1-a',
      vmType: 'e2-standard-2',
      managementVmId: 'anycloud-cluster-cluster-hosted',
      networkScope: 'anycloud-cluster-cluster-hosted',
      k3s: { version: SYSTEM_RELEASE_K3S_VERSION, sha256: 'b'.repeat(64) },
      checkpointBucket: { name: 'my-api-state', managed: false },
    };
    await getPersistence().clusters.recordSelf({
      id: 'cluster-hosted',
      ownerUserId: actor.id,
      name: 'hosted',
      kubernetesIdentity: 'uid-hosted',
      connection: serializeClusterConnection({
        kind: 'in-cluster',
        server: 'https://198.51.100.9:6443',
        certificateAuthorityData: 'Y2E=',
      }),
      record,
    });

    const image = `ghcr.io/anycloud-sh/api:0.1.64@sha256:${'d'.repeat(64)}`;
    const { cluster } = await domain({
      infrastructure: null,
      ownApiImage: image,
    }).get(actor, 'hosted');
    // The release it runs, digest-pinned, as an installer's record reports it.
    expect(cluster).toMatchObject({
      apiVersion: '0.1.64',
      apiImage: image,
      chartVersion: '0.1.64',
      release: {
        apiVersion: '0.1.64',
        apiImage: image,
        chartVersion: '0.1.64',
      },
    });
    expect(cluster).toMatchObject({
      cloudProvider: CloudType.GCP,
      cloudAccount: 'my-project',
      region: 'us-central1',
      zone: 'us-central1-a',
      vmType: 'e2-standard-2',
      k3sVersion: SYSTEM_RELEASE_K3S_VERSION,
      managementVmId: 'anycloud-cluster-cluster-hosted',
      networkScope: 'anycloud-cluster-cluster-hosted',
      checkpointBucket: { name: 'my-api-state', managed: false },
    });
  });

  it('refuses to bootstrap when a cluster record already exists', async () => {
    await getPersistence().clusters.recordSelf({
      id: 'cluster-foreign',
      ownerUserId: actor.id,
      name: 'foreign',
      kubernetesIdentity: 'uid-foreign',
      connection: '{}',
    });

    await expect(domain().create(actor, request)).rejects.toBeInstanceOf(
      ClusterExistsError,
    );
    expect((await installationRow()).map((row) => row.id)).toEqual([
      'cluster-foreign',
    ]);
    expect(fakes.provisionCalls).toBe(0);
  });

  it('refuses to continue when the control plane reports another identity than the one recorded', async () => {
    fakes.failAt = 'after-register';
    const first = await domain().create(actor, request);
    await drain();
    observe.mockResolvedValue('uid-other');

    await domain().create(actor, request);
    await drain();
    const outcome = await domain().get(actor, first.cluster.id);
    expect(outcome.cluster.state).toBe(WorkloadState.Failed);
    expect(outcome.cluster.lastError).toContain(
      `Cluster reports Kubernetes identity uid-other, but this installation recorded ${IDENTITY}`,
    );
  });

  it('is refused on a hosted API that has no installer role', async () => {
    await expect(
      domain({ infrastructure: null }).create(actor, request),
    ).rejects.toBeInstanceOf(ClusterUnavailableError);
    expect(await installationRow()).toHaveLength(0);
  });

  it('waits for sshd with bounded backoff and keeps polling while the host prepares', async () => {
    fakes.sshBootsAfterProbes = 3;
    fakes.preparingPolls = 2;
    const start = clock;
    const { cluster } = await domain().create(actor, request);
    await drain();
    const ready = await domain().get(actor, cluster.id);
    expect(ready.cluster.state).toBe(WorkloadState.Running);
    // Three failed probes with 5s, 10s, 20s backoff, then two exit-64 polls.
    expect(fakes.execLog.filter((entry) => entry === '<probe>')).toHaveLength(
      4,
    );
    expect(clock - start).toBeGreaterThanOrEqual(5_000 + 10_000 + 20_000);
    expect(fakes.provisionCalls).toBe(1);
  });

  it('keeps the connection a previous pass bound and does not store it twice on resume', async () => {
    fakes.failAt = 'after-register';
    const first = await domain().create(actor, request);
    await drain();
    const failed = await domain().get(actor, first.cluster.id);
    expect(await storedStep(failed.cluster.id)).toBe(ClusterStep.Kubeconfig);
    expect(failed.cluster.connected).toBe(true);

    await domain().create(actor, request);
    await drain();
    const ready = await domain().get(actor, first.cluster.id);
    expect(ready.cluster.state).toBe(WorkloadState.Running);
    const stored = await getPersistence().clusterRecords.getConnection(
      first.cluster.id,
    );
    expect(stored?.connectionRevision).toBe(2);
    expect(
      await getPersistence().clusterRecords.listForScope({ kind: 'api' }),
    ).toHaveLength(1);
  });

  it("waits for Traefik's IngressRoute CRD after the API's own Traefik HelmChart and before the API HelmChart, and fails the step naming the release on timeout", async () => {
    fakes.crdAbsentPolls = 3;
    const start = clock;
    const { cluster } = await domain().create(actor, request);
    await drain();
    const ready = await domain().get(actor, cluster.id);
    expect(ready.cluster.state).toBe(WorkloadState.Running);
    expect(fakes.crdReads).toEqual(
      Array<string>(4).fill('ingressroutes.traefik.io'),
    );
    expect(clock - start).toBeGreaterThanOrEqual(3 * 5_000);
    expect(fakes.applied).toHaveLength(1);

    // Never Established: the release step fails before the HelmChart exists.
    await domain().destroy(actor, cluster.id, KEEP);
    await drain();
    fakes.crdAbsentPolls = Number.POSITIVE_INFINITY;
    fakes.applied = [];
    fakes.helmChart = null;
    const second = await domain().create(actor, {
      ...request,
      name: 'production-2',
    });
    await drain();
    const failed = await domain().get(actor, second.cluster.id);
    expect(failed.cluster.state).toBe(WorkloadState.Failed);
    expect(await storedStep(failed.cluster.id)).toBe(ClusterStep.ReleaseIntent);
    expect(failed.cluster.lastError).toContain(
      'Traefik did not publish the ingressroutes.traefik.io CustomResourceDefinition within 3 minutes (absent); the anycloud-api-ingress HelmChart in kube-system has not installed',
    );
    expect(fakes.applied).toHaveLength(0);

    // An installation that never completed its release has no hosted API to
    // ask and no pool could exist through it: forget and destroy proceed
    // without the inventory, even when the hosted API would answer
    // "unreachable". Asking would resolve the unpublished hostname.
    fakes.hostedPools = { kind: 'unreachable', reason: 'no such host' };
    fakes.inventoryCalls = 0;
    await expect(domain().forget(actor, second.cluster.id)).rejects.toThrow(
      ClusterVmPresentError,
    );
    await domain().destroy(actor, second.cluster.id, KEEP);
    await drain();
    expect((await domain().get(actor, second.cluster.id)).cluster.state).toBe(
      WorkloadState.Terminated,
    );
    expect(fakes.inventoryCalls).toBe(0);
  });

  it('re-observes and re-compares when the HelmChart moved between comparison and apply', async () => {
    fakes.conflicts = 1;
    const { cluster } = await domain().create(actor, request);
    await drain();
    const ready = await domain().get(actor, cluster.id);
    expect(ready.cluster.state).toBe(WorkloadState.Running);
    expect(fakes.applied).toHaveLength(1);
  });

  it('gives up after repeated conflicts instead of overwriting the cluster release', async () => {
    fakes.conflicts = 10;
    const { cluster } = await domain().create(actor, request);
    await drain();
    const outcome = await domain().get(actor, cluster.id);
    expect(outcome.cluster.state).toBe(WorkloadState.Failed);
    expect(outcome.cluster.lastError).toContain('changed while');
    expect(fakes.applied).toHaveLength(0);
  });

  it('refuses to resume with a different target than the recorded intent', async () => {
    fakes.failAt = 'configure';
    await domain().create(actor, request);
    await drain();
    await expect(
      domain().create(actor, { ...request, vmType: 't3.large' }),
    ).rejects.toBeInstanceOf(ClusterExistsError);
    await expect(
      domain().create(actor, { ...request, zone: 'us-east-1a' }),
    ).rejects.toBeInstanceOf(ClusterExistsError);
    expect(scheduled).toHaveLength(0);
    // The same target resumes.
    await domain().create(actor, request);
    expect(scheduled).toHaveLength(1);
  });

  it('keeps a destroy whose VM release never confirmed in the destroy lane', async () => {
    const { cluster } = await domain().create(actor, request);
    await drain();
    const stuck = domain({
      infrastructure: {
        ...dependencies.infrastructure!,
        releaseManagementVm: async () => false,
      },
    });
    await stuck.destroy(actor, cluster.id, KEEP);
    await drain();
    const after = await stuck.get(actor, cluster.id);
    expect(after.cluster.state).toBe(WorkloadState.Failed);
    // A failed delete says so; a failed create shares the state.
    expect(after.cluster.lastError).toMatch(/^Delete failed: /);
    expect(after.cluster.lastError).toContain('not confirmed');

    // The documented recovery for a failed bootstrap does not apply here.
    await expect(domain().create(actor, request)).rejects.toBeInstanceOf(
      ClusterDestroyFailedError,
    );
    expect(scheduled).toHaveLength(0);
    expect(fakes.provisionCalls).toBe(1);
    expect((await vmRows()).filter((vm) => vm.ended_at === null)).toHaveLength(
      1,
    );

    // Only destroy resumes it, and it finishes from the ledger.
    await domain().destroy(actor, cluster.id, KEEP);
    await drain();
    const gone = await domain().get(actor, cluster.id);
    expect(gone.cluster.state).toBe(WorkloadState.Terminated);
    expect(fakes.provisioned.size).toBe(0);
  });

  it('keeps a destroy that failed after the VM was released in the destroy lane and never provisions again', async () => {
    const { cluster } = await domain().create(actor, request);
    await drain();
    let injected = false;
    const store = dependencies.installations;
    const setState: typeof store.setState = async (id, state, lastError) => {
      if (state === ClusterState.Destroyed && !injected) {
        injected = true;
        throw new Error('injected record failure');
      }
      return store.setState(id, state, lastError);
    };
    const broken = domain({
      installations: new Proxy(store, {
        get(target, property) {
          if (property === 'setState') return setState;
          const value = Reflect.get(target, property) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
    });
    await broken.destroy(actor, cluster.id, KEEP);
    await drain();
    const after = await broken.get(actor, cluster.id);
    expect(after.cluster.state).toBe(WorkloadState.Failed);
    expect((await vmRows()).every((vm) => vm.ended_at !== null)).toBe(true);

    await expect(domain().create(actor, request)).rejects.toBeInstanceOf(
      ClusterDestroyFailedError,
    );
    expect(fakes.provisionCalls).toBe(1);
    expect(await vmRows()).toHaveLength(1);

    await domain().destroy(actor, cluster.id, KEEP);
    await drain();
    const gone = await domain().get(actor, cluster.id);
    expect(gone.cluster.state).toBe(WorkloadState.Terminated);
    expect(fakes.releaseCalls).toBe(1);
    const clusterRecords = await getPersistence().clusterRecords.listForScope(
      { kind: 'api' },
      { includeDeleted: true },
    );
    expect(clusterRecords[0].state).toBe(ClusterState.Destroyed);
  });

  it('never provisions for an installation whose ledger already shows a released management VM', async () => {
    const { cluster } = await domain().create(actor, request);
    await drain();
    // Simulate ledger state a destroy left behind without the state change.
    const vm = await getPersistence().clusters.getManagementVm(cluster.id);
    await getPersistence().clusters.endManagementVm(cluster.id, vm!.id);
    await getPersistence().clusters.setState(
      cluster.id,
      ClusterState.Failed,
      'simulated',
    );
    await domain().create(actor, request);
    await drain();
    const outcome = await domain().get(actor, cluster.id);
    expect(outcome.cluster.state).toBe(WorkloadState.Failed);
    expect(outcome.cluster.lastError).toContain(
      'run anycloud api delete production again',
    );
    expect(fakes.provisionCalls).toBe(1);
    expect(await vmRows()).toHaveLength(1);
  });

  it('refuses a storage-only Cloudflare credential before provisioning or restoring', async () => {
    await getDB().query(
      `INSERT INTO credentials (id, encrypted_data, cloud_provider, name, created_at, last_used_at)
       VALUES ('cred-r2', 'opaque', 'Cloudflare', 'r2', 1, 1)`,
    );

    await expect(
      domain().create(actor, {
        ...request,
        credentialName: 'r2',
        checkpointBucket: 'my-api-state',
      }),
    ).rejects.toMatchObject({
      name: 'ClusterInvalidError',
      message: storageOnlyComputeMessage(CloudType.Cloudflare),
    });
    expect(fakes.provisionCalls).toBe(0);
    expect(await vmRows()).toHaveLength(0);
  });

  it("refuses this API's own backup bucket as a new cluster's checkpoint bucket", async () => {
    vi.stubEnv(
      'ANYCLOUD_BACKUP_CONFIG',
      JSON.stringify({
        bucket: 'my-api-state',
        region: 'us-east-1',
        cloudProvider: CloudType.AWS,
        credentials: { cloudProvider: CloudType.AWS },
      }),
    );
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    const backupManifest = vi.fn(async () => null);

    await expect(
      domain({ backupManifest }).create(actor, {
        ...request,
        checkpointBucket: 'my-api-state',
      }),
    ).rejects.toThrow("API's own backup bucket");
    expect(backupManifest).not.toHaveBeenCalled();
    expect(fakes.applied).toEqual([]);
  });

  it('retains a user-supplied checkpoint bucket: neither created nor deleted, but it must exist', async () => {
    await expect(
      domain().create(actor, {
        ...request,
        checkpointBucket: 'missing-bucket',
      }),
    ).rejects.toThrow('Checkpoint bucket "missing-bucket" was not found');
    const { cluster } = await domain().create(actor, {
      ...request,
      checkpointBucket: 'my-api-state',
    });
    await drain();
    expect(fakes.buckets).toEqual([]);
    const values = JSON.parse(fakes.applied[0].spec.valuesContent) as {
      backup: { bucket: string };
    };
    expect(values.backup.bucket).toBe('my-api-state');
    // --delete-buckets never deletes a supplied bucket: it is reported kept.
    await expect(
      domain().destroy(actor, cluster.id, DELETE_BUCKETS),
    ).resolves.toMatchObject({
      remaining: [
        {
          name: 'my-api-state',
          managed: false,
          reason: 'supplied',
          finalBackup: 'taken',
        },
      ],
    });
    await drain();
    expect((await domain().get(actor, cluster.id)).cluster.state).toBe(
      WorkloadState.Terminated,
    );
    expect(fakes.bucketDeletes).toEqual([]);
  });

  it('restores from a bucket that holds a backup under the backup installation id', async () => {
    const manifest = {
      version: 1 as const,
      clusterId: 'prod-1789960000000-abcd',
      backedUpAt: '2026-09-27T12:00:00.000Z',
      schemaAppVersion: '0.1.64',
      databaseSha256: 'a'.repeat(64),
    };
    const restoring = domain({ backupManifest: async () => manifest });
    const { cluster } = await restoring.create(actor, {
      ...request,
      checkpointBucket: 'my-api-state',
    });
    await drain();
    expect(cluster.id).toBe(manifest.clusterId);
    expect((await installationRow())[0].restore_from_backup).toBe(1);
    const values = JSON.parse(fakes.applied[0].spec.valuesContent) as {
      installation: { id: string };
      state: { restoreFromBackup: boolean };
    };
    expect(values.installation.id).toBe(manifest.clusterId);
    expect(values.state).toEqual({ restoreFromBackup: true });
    const lost = `anycloud-cluster-${manifest.clusterId}`;
    expect(fakes.found).toEqual([{ scope: lost, region: 'us-east-1' }]);
    // The restore's VM never reuses the lost VM's name (the AWS client token).
    const [vm] = await vmRows();
    expect(vm.cloud_id).toMatch(new RegExp(`^${lost}-r[0-9a-z]+$`));
  });

  it('refuses a restore with no local record while the lost cluster still has a management VM, or when the cloud cannot be asked', async () => {
    const manifest = {
      version: 1 as const,
      clusterId: 'prod-1789960000000-abcd',
      backedUpAt: '2026-09-27T12:00:00.000Z',
      schemaAppVersion: '0.1.64',
      databaseSha256: 'a'.repeat(64),
    };
    const restoring = domain({ backupManifest: async () => manifest });
    const restore = { ...request, checkpointBucket: 'my-api-state' };
    // Found by tag even when stopped; its name carries an earlier restore's suffix.
    fakes.provisioned.set(`anycloud-cluster-${manifest.clusterId}-rabc`, {
      ip: '203.0.113.9',
    });
    await expect(restoring.create(actor, restore)).rejects.toThrow(
      `Management VM anycloud-cluster-${manifest.clusterId}-rabc of cluster ${manifest.clusterId} still exists. If the cluster is healthy, nothing needs restoring: use it as is. Terminate that VM only if it is truly broken, then retry the restore`,
    );
    fakes.provisioned.clear();
    fakes.failAt = 'find-vms';
    await expect(restoring.create(actor, restore)).rejects.toThrow(
      `Could not check for the management VM of cluster ${manifest.clusterId} (injected failure at find-vms); retry the restore once it can be read`,
    );
    expect(await installationRow()).toEqual([]);
    expect(fakes.provisionCalls).toBe(0);
  });

  it('gives a restore its own management VM name from its recorded creation time, within 63 characters', () => {
    const lost = { id: 'prod-1', restoreFromBackup: false, createdAt: 1 };
    const restore = {
      id: 'prod-1',
      restoreFromBackup: true,
      createdAt: 1_790_000_000_000,
    };
    expect(managementVmCloudId(lost)).toBe('anycloud-cluster-prod-1');
    expect(managementVmCloudId(restore)).toBe(
      `anycloud-cluster-prod-1-r${(1_790_000_000_000).toString(36)}`,
    );
    const long = managementVmCloudId({ ...restore, id: 'x'.repeat(80) });
    expect(long).toHaveLength(63);
    expect(long.endsWith(`-r${(1_790_000_000_000).toString(36)}`)).toBe(true);
  });

  it('refuses a backup written by a newer API before recording or mutating anything', async () => {
    const restoring = domain({
      backupManifest: async () => ({
        version: 1,
        clusterId: 'prod-1789960000000-abcd',
        backedUpAt: '2026-09-27T12:00:00.000Z',
        schemaAppVersion: '0.1.70',
        databaseSha256: 'a'.repeat(64),
      }),
    });
    await expect(
      restoring.create(actor, { ...request, checkpointBucket: 'my-api-state' }),
    ).rejects.toThrow(
      'was written by anycloud API 0.1.70; this CLI deploys 0.1.64. Run anycloud update and retry',
    );
    expect(await installationRow()).toEqual([]);
    expect(scheduled).toEqual([]);
  });

  describe('restoring over a record this installer still holds', () => {
    async function heldCluster() {
      const { cluster } = await domain().create(actor, {
        ...request,
        checkpointBucket: 'my-api-state',
      });
      await drain();
      const manifest = {
        version: 1 as const,
        clusterId: cluster.id,
        backedUpAt: '2026-09-27T12:00:00.000Z',
        schemaAppVersion: '0.1.64',
        databaseSha256: 'a'.repeat(64),
      };
      // The management host was lost, and the restore bootstraps a new
      // cluster with no release on it yet.
      fakes.provisioned.clear();
      fakes.helmChart = null;
      fakes.applied = [];
      return {
        id: cluster.id,
        manifest,
        restoring: domain({ backupManifest: async () => manifest }),
      };
    }

    async function expectFreshRestore(id: string, releases: number) {
      await drain();
      expect(fakes.releaseCalls).toBe(releases);
      const rows = await installationRow();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id, restore_from_backup: 1 });
      expect(
        (await vmRows()).filter((vm) => vm.ended_at === null),
      ).toHaveLength(1);
      const values = JSON.parse(fakes.applied.at(-1)!.spec.valuesContent) as {
        state: { restoreFromBackup: boolean };
      };
      expect(values.state.restoreFromBackup).toBe(true);
    }

    it('replaces a Ready record whose management VM is gone, then releases any remnant and restores under its id', async () => {
      const { id, restoring } = await heldCluster();
      await restoring.create(actor, {
        ...request,
        checkpointBucket: 'my-api-state',
      });
      await expectFreshRestore(id, 1);
    });

    it('replaces a Failed or Destroyed record and restores under its id', async () => {
      const { id, restoring } = await heldCluster();
      await getDB().query(`UPDATE clusters SET state = 'failed' WHERE id = ?`, [
        id,
      ]);
      await restoring.create(actor, {
        ...request,
        checkpointBucket: 'my-api-state',
      });
      await expectFreshRestore(id, 1);
      await domain().destroy(actor, id, KEEP);
      await drain();
      fakes.helmChart = null;
      await restoring.create(actor, {
        ...request,
        checkpointBucket: 'my-api-state',
      });
      await expectFreshRestore(id, 2);
    });

    it('resumes its own interrupted restore instead of probing the new VM', async () => {
      const { id, restoring } = await heldCluster();
      await getDB().query(`UPDATE clusters SET state = 'failed' WHERE id = ?`, [
        id,
      ]);
      const restore = { ...request, checkpointBucket: 'my-api-state' };
      await restoring.create(actor, restore);
      await drain();
      await getDB().query(`UPDATE clusters SET state = 'failed' WHERE id = ?`, [
        id,
      ]);
      const [vm] = (await vmRows()).filter((row) => row.ended_at === null);
      fakes.provisioned.set(vm.cloud_id, { ip: '203.0.113.9' });
      // The interrupted restore had reached the API release: it resumes there.
      await expect(restoring.create(actor, restore)).resolves.toMatchObject({
        cluster: { id, state: WorkloadState.Starting },
      });
      await expectFreshRestore(id, 1);
    });

    it('refuses to replace the record while another installer has already restored the cluster', async () => {
      // Laptop A holds the lost record (its VM is gone); laptop B restored first.
      const { id, restoring } = await heldCluster();
      fakes.provisioned.set(`anycloud-cluster-${id}-rb`, { ip: '203.0.113.9' });
      await expect(
        restoring.create(actor, {
          ...request,
          checkpointBucket: 'my-api-state',
        }),
      ).rejects.toThrow(
        `Management VM anycloud-cluster-${id}-rb of cluster ${id} still exists.`,
      );
      expect(await installationRow()).toMatchObject([
        { id, restore_from_backup: 0 },
      ]);
      expect(fakes.releaseCalls).toBe(0);
    });

    it('refuses a record still being created or destroyed', async () => {
      const { id, restoring } = await heldCluster();
      for (const state of ['destroying', 'bootstrapping']) {
        await getDB().query('UPDATE clusters SET state = ? WHERE id = ?', [
          state,
          id,
        ]);
        await expect(
          restoring.create(actor, {
            ...request,
            checkpointBucket: 'my-api-state',
          }),
        ).rejects.toThrow(ClusterBusyError);
      }
      expect(fakes.releaseCalls).toBe(0);
    });

    it('keeps the lost VM row when its release fails, so the next create releases it', async () => {
      const { id, restoring, manifest } = await heldCluster();
      await getDB().query(`UPDATE clusters SET state = 'failed' WHERE id = ?`, [
        id,
      ]);
      const unreleased = domain({
        backupManifest: async () => manifest,
        infrastructure: {
          ...infrastructure(fakes),
          releaseManagementVm: async () => false,
        },
      });
      await unreleased.create(actor, {
        ...request,
        checkpointBucket: 'my-api-state',
      });
      await drain();
      expect((await installationRow())[0]).toMatchObject({
        id,
        state: ClusterState.Failed,
        last_error: 'Management VM release was not confirmed in time',
      });
      const [lost] = await getDB().query<{
        removal_requested_at: number | null;
      }>(
        'SELECT removal_requested_at FROM vms WHERE cluster_id = ? AND ended_at IS NULL',
        [id],
      );
      expect(lost.removal_requested_at).not.toBeNull();
      await restoring.create(actor, {
        ...request,
        checkpointBucket: 'my-api-state',
      });
      await expectFreshRestore(id, 1);
    });

    it('treats a replay of the same create with a live management VM as a resume, restoring and releasing nothing', async () => {
      const { id, restoring } = await heldCluster();
      const [vm] = await vmRows();
      fakes.provisioned.set(vm.cloud_id, { ip: '203.0.113.9' });
      const replay = { ...request, checkpointBucket: 'my-api-state' };
      await expect(restoring.create(actor, replay)).resolves.toMatchObject({
        cluster: { id, state: WorkloadState.Running },
      });
      await getDB().query(`UPDATE clusters SET state = 'failed' WHERE id = ?`, [
        id,
      ]);
      // Resumed at the API release, the last step it reached.
      await expect(restoring.create(actor, replay)).resolves.toMatchObject({
        cluster: { id, state: WorkloadState.Starting },
      });
      await drain();
      expect(await installationRow()).toMatchObject([
        { id, restore_from_backup: 0 },
      ]);
      expect(fakes.releaseCalls).toBe(0);
    });

    it('refuses while the recorded management VM still exists under another name, or when it cannot be read', async () => {
      const { id, manifest, restoring } = await heldCluster();
      const [vm] = await vmRows();
      fakes.provisioned.set(vm.cloud_id, { ip: '203.0.113.9' });
      await expect(
        restoring.create(actor, {
          ...request,
          name: 'staging',
          checkpointBucket: 'my-api-state',
        }),
      ).rejects.toThrow(
        `Management VM ${vm.cloud_id} of cluster "production" still exists. If the cluster is healthy, nothing needs restoring: use it as is. Terminate that VM only if it is truly broken, then retry the restore`,
      );
      const unreadable = domain({
        backupManifest: async () => manifest,
        infrastructure: {
          ...infrastructure(fakes),
          observeManagementVm: async () => {
            throw new Error('AccessDenied');
          },
        },
      });
      await expect(
        unreadable.create(actor, {
          ...request,
          checkpointBucket: 'my-api-state',
        }),
      ).rejects.toThrow(
        `Could not check management VM ${vm.cloud_id} of cluster "production" (AccessDenied)`,
      );
      expect(await installationRow()).toMatchObject([
        { id, restore_from_backup: 0 },
      ]);
      expect(fakes.releaseCalls).toBe(0);
    });
  });

  it('refuses a manifest whose schema version is not valid semver', async () => {
    const restoring = domain({
      backupManifest: async () => ({
        version: 1,
        clusterId: 'prod-1789960000000-abcd',
        backedUpAt: '2026-09-27T12:00:00.000Z',
        schemaAppVersion: 'latest',
        databaseSha256: 'a'.repeat(64),
      }),
    });
    await expect(
      restoring.create(actor, { ...request, checkpointBucket: 'my-api-state' }),
    ).rejects.toThrow('records an invalid schema version "latest"');
    expect(await installationRow()).toEqual([]);
  });

  it('refuses a bucket holding a database with no restorable backup before recording anything', async () => {
    const restoring = domain({ backupManifest: async () => 'unrestorable' });
    await expect(
      restoring.create(actor, { ...request, checkpointBucket: 'old-state' }),
    ).rejects.toThrow(
      'Checkpoint bucket "old-state" holds a database with no restorable backup; use another bucket',
    );
    expect(await installationRow()).toEqual([]);
    expect(scheduled).toEqual([]);
  });

  it("re-applies the management firewall with 443 from Cloudflare's ranges to an existing scope", async () => {
    const prepareResourceNetwork = vi.fn();
    const gateway = createCloudCompute({
      type: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.medium',
      rawValidateCredentials: vi.fn(),
      rawClassifyError: vi.fn(),
      rawNewVM: vi.fn(),
      rawRequestVMTermination: vi.fn(),
      rawTerminateNetworking: vi.fn(),
      rawGetAllVMs: vi.fn().mockResolvedValue([]),
      rawUpsertFirewall: vi.fn(),
      observeVMReleaseOnce: vi.fn(),
      resourceScoped: {
        prepareResourceNetwork,
        newResourceVM: vi.fn(),
        terminateResourceNetwork: vi.fn(),
      },
    });
    const scope = { id: 'anycloud-cluster-c1', tags: {} };
    await createClusterInfrastructure('0.1.68', {
      createCompute: () => gateway,
      decryptCredential: async () => ({
        cloudProvider: CloudType.AWS,
        accessKeyId: 'AKIA',
        secretAccessKey: 'secret',
      }),
    }).ensureManagementIngress({
      credential: {
        id: 'cred-1',
        encryptedData: 'x',
        cloudProvider: CloudType.AWS,
        authFailedAt: null,
      },
      target: { region: 'us-east-1', zone: null, vmType: 't3.medium' },
      scope,
    });
    const [spec, passedScope] = prepareResourceNetwork.mock.calls[0];
    expect(passedScope).toEqual(scope);
    for (const port of [443, 80]) {
      expect(spec.ingress).toContainEqual(
        expect.objectContaining({
          port,
          sourceRanges: [...CLOUDFLARE_IP_RANGES],
        }),
      );
    }
  });

  it('destroys a CPU-only cluster through the real infrastructure adapter and a fake gateway', async () => {
    const terminated: string[] = [];
    const released = new Set<string>();
    const configs: CloudConfig[] = [];
    const gateway = createCloudCompute({
      type: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.medium',
      rawValidateCredentials: vi.fn(),
      rawClassifyError: vi.fn(),
      rawNewVM: vi.fn(),
      rawRequestVMTermination: vi.fn(async (cloudId: string) => {
        terminated.push(cloudId);
        released.add(cloudId);
      }),
      rawTerminateNetworking: vi.fn(),
      rawGetAllVMs: vi.fn().mockResolvedValue([]),
      rawUpsertFirewall: vi.fn(),
      observeVMReleaseOnce: vi.fn(async (cloudId: string) =>
        released.has(cloudId) ? VM_RELEASE_CANDIDATE : VM_PRESENT,
      ),
      releaseConfirmWaitMs: 0,
      resourceScoped: {
        prepareResourceNetwork: vi.fn(),
        newResourceVM: vi.fn(),
        terminateResourceNetwork: vi.fn(),
      },
    });
    const { cluster } = await domain().create(actor, request);
    await drain();
    const live = domain({
      infrastructure: createClusterInfrastructure('0.1.64', {
        // The real resolver runs on the recorded target (the step that parsed
        // an empty VM type as a GPU alias); only the SDK client is faked.
        createCompute: (config, purpose) => {
          configs.push(resolveComputeConfig(config, purpose ?? 'provisioning'));
          return gateway;
        },
        decryptCredential: async () => ({
          cloudProvider: CloudType.AWS,
          accessKeyId: 'AKIA',
          secretAccessKey: 'secret',
        }),
        // The managed checkpoint bucket is already gone; destroy must still
        // reach the VM release and finish.
        createStorage: () =>
          makeMockCloudStorage({
            rawHasBucket: vi.fn().mockResolvedValue(false),
          }),
      }),
    });
    await live.destroy(actor, cluster.id, KEEP);
    await drain();
    const after = await live.get(actor, cluster.id);
    expect(after.cluster).toMatchObject({
      state: WorkloadState.Terminated,
      lastError: null,
    });
    expect(terminated).toEqual([`anycloud-cluster-${cluster.id}`]);
    expect(configs).toMatchObject([{ vmType: 't3.medium', spot: false }]);
    expect((await vmRows())[0].ended_at).not.toBeNull();
  });

  it('destroys independently of the hosted API: releases the VM and DNS record, keeps the managed bucket after a final backup, and forgets the cluster', async () => {
    const { cluster } = await domain().create(actor, request);
    await drain();

    const destroying = await domain().destroy(actor, 'production', KEEP);
    expect(destroying.cluster.state).toBe(WorkloadState.Terminated);
    const restoreCommand = `anycloud api create production --cloud aws --region us-east-1 --vm-type t3.medium --checkpoint-bucket ${cluster.id}`;
    expect(destroying).toMatchObject({
      deleted: [
        { kind: 'managementVm', id: `anycloud-cluster-${cluster.id}` },
        { kind: 'dnsRecord', name: `${cluster.id}.anycloud.sh` },
      ],
      remaining: [
        {
          kind: 'checkpointBucket',
          name: cluster.id,
          managed: true,
          reason: 'kept',
          finalBackup: 'taken',
          backedUpAt: '2026-11-04T18:12:03.000Z',
          restoreCommand,
          deleteCommand: `anycloud api delete ${cluster.id} --delete-buckets`,
        },
      ],
    });
    expect(fakes.backups).toBe(1);
    await drain();

    const gone = await domain().get(actor, cluster.id);
    expect(gone.cluster).toMatchObject({
      state: WorkloadState.Terminated,
      checkpointBucket: { name: cluster.id, managed: true },
    });
    expect(fakes.releaseCalls).toBe(1);
    expect(fakes.provisioned.size).toBe(0);
    expect(fakes.bucketDeletes).toEqual([]);
    expect(fakes.buckets).toEqual([cluster.id]);
    expect(fakes.dns.slice(-2)).toEqual([
      `remove-tls ${cluster.id} ${actor.token}`,
      `remove ${cluster.id} ${actor.token}`,
    ]);
    const vms = await vmRows();
    expect(vms).toHaveLength(1);
    expect(vms[0].ended_at).not.toBeNull();
    const clusterRecords = await getPersistence().clusterRecords.listForScope(
      { kind: 'api' },
      { includeDeleted: true },
    );
    expect(clusterRecords[0].state).toBe(ClusterState.Destroyed);
    // Re-running delete reports the kept bucket again and changes nothing.
    await expect(
      domain().destroy(actor, cluster.id, KEEP),
    ).resolves.toMatchObject({
      deleted: [],
      remaining: [{ name: cluster.id, finalBackup: 'skipped' }],
    });
    expect(scheduled).toEqual([]);
    // A later bootstrap starts a fresh installation instead of reviving this one.
    const again = await domain().create(actor, request);
    expect(again.cluster.id).not.toBe(cluster.id);
  });

  it('deletes the kept bucket of a destroyed record with --delete-buckets, and a failure keeps the record naming it', async () => {
    const { cluster } = await domain().create(actor, request);
    await drain();
    await domain().destroy(actor, cluster.id, KEEP);
    await drain();

    fakes.failAt = 'delete-bucket';
    await expect(
      domain().destroy(actor, cluster.id, DELETE_BUCKETS),
    ).rejects.toThrow('injected failure at delete-bucket');
    expect(
      (await domain().get(actor, cluster.id)).cluster.checkpointBucket,
    ).toEqual({ name: cluster.id, managed: true });
    fakes.failAt = null;
    await expect(
      domain().destroy(actor, cluster.id, DELETE_BUCKETS),
    ).resolves.toMatchObject({
      cluster: { state: WorkloadState.Terminated, checkpointBucket: null },
      deleted: [{ kind: 'checkpointBucket', name: cluster.id }],
      remaining: [],
    });
    expect(scheduled).toEqual([]);
    expect(fakes.bucketDeletes).toEqual([cluster.id]);
    expect(fakes.buckets).toEqual([]);
    expect(fakes.backups).toBe(1);
  });

  it('resumes a delete whose bucket step failed without asking the released hosted API', async () => {
    const { cluster } = await domain().create(actor, request);
    await drain();
    fakes.failAt = 'delete-bucket';
    await domain().destroy(actor, cluster.id, DELETE_BUCKETS);
    await drain();
    expect((await domain().get(actor, cluster.id)).cluster.state).toBe(
      WorkloadState.Failed,
    );
    fakes.failAt = null;
    const inventoryCalls = fakes.inventoryCalls;
    fakes.hostedPools = { kind: 'unreachable', reason: 'no such host' };
    await domain().destroy(actor, cluster.id, DELETE_BUCKETS);
    await drain();
    expect((await domain().get(actor, cluster.id)).cluster).toMatchObject({
      state: WorkloadState.Terminated,
      checkpointBucket: null,
    });
    expect(fakes.inventoryCalls).toBe(inventoryCalls);
    expect(fakes.bucketDeletes).toEqual([cluster.id]);
    expect(fakes.releaseCalls).toBe(1);
  });

  it('with --delete-buckets takes no backup and deletes the bucket after the DNS record', async () => {
    const { cluster } = await domain().create(actor, request);
    await drain();
    const deleting = await domain().destroy(actor, cluster.id, DELETE_BUCKETS);
    expect(deleting).toMatchObject({
      deleted: [
        { kind: 'managementVm' },
        { kind: 'dnsRecord' },
        { kind: 'checkpointBucket', name: cluster.id },
      ],
      remaining: [],
    });
    await drain();
    expect(fakes.backups).toBe(0);
    expect(fakes.dns.slice(-3)).toEqual([
      `remove-tls ${cluster.id} ${actor.token}`,
      `remove ${cluster.id} ${actor.token}`,
      `delete-bucket ${cluster.id}`,
    ]);
    expect(
      (await domain().get(actor, cluster.id)).cluster.checkpointBucket,
    ).toBe(null);
  });

  it('proceeds when the final backup fails, reporting the newest backup and the error', async () => {
    const { cluster } = await domain().create(actor, request);
    await drain();
    fakes.backupFailure = 'the hosted API answered HTTP 503';
    const newest = domain({
      backupManifest: async () => ({
        version: 1,
        clusterId: cluster.id,
        backedUpAt: '2026-11-04T17:00:00.000Z',
        schemaAppVersion: '0.1.64',
        databaseSha256: 'a'.repeat(64),
      }),
    });
    await expect(
      newest.destroy(actor, cluster.id, KEEP),
    ).resolves.toMatchObject({
      remaining: [
        {
          name: cluster.id,
          finalBackup: 'failed',
          error: 'the hosted API answered HTTP 503',
          backedUpAt: '2026-11-04T17:00:00.000Z',
        },
      ],
    });
    await drain();
    expect((await domain().get(actor, cluster.id)).cluster.state).toBe(
      WorkloadState.Terminated,
    );
    expect(fakes.bucketDeletes).toEqual([]);
  });

  it('keeps a restored bucket managed when it is named for the backup cluster, so --delete-buckets deletes it', async () => {
    const { cluster } = await domain().create(actor, request);
    await drain();
    await domain().destroy(actor, cluster.id, KEEP);
    await drain();
    const restoring = domain({
      backupManifest: async () => ({
        version: 1,
        clusterId: cluster.id,
        backedUpAt: '2026-11-04T18:12:03.000Z',
        schemaAppVersion: '0.1.64',
        databaseSha256: 'a'.repeat(64),
      }),
    });
    fakes.helmChart = null;
    fakes.applied = [];
    const restored = await restoring.create(actor, {
      ...request,
      checkpointBucket: cluster.id,
    });
    expect(restored.cluster).toMatchObject({
      id: cluster.id,
      checkpointBucket: { name: cluster.id, managed: true },
    });
    await drain();
    await restoring.destroy(actor, cluster.id, DELETE_BUCKETS);
    await drain();
    expect(fakes.bucketDeletes).toEqual([cluster.id]);
  });
});

import { readFileSync } from 'node:fs';

import { describe, expect, test, vi } from 'vitest';

import {
  buildNodePoolAgentStartupScript,
  k3sSecureToken,
  NODE_EXTERNAL_IP_PLACEHOLDER,
} from '../../src/api/services/kubernetes/node-pool-join.js';
import {
  nodePoolNodeName,
  nodePoolNodeTaints,
} from '../../src/api/services/kubernetes/node-pool-scheduling.js';
import { METADATA_NODE_POOL_BOOT } from '../../src/api/services/gateways/cloud.js';
import { CloudType } from '../../src/shared/cloud.js';
import { WorkloadState } from '../../src/shared/workload.js';
import {
  defaultGpuAccess,
  isCPUVMType,
} from '../../src/shared/cloud-config.js';

import {
  clusterLocalAgentConfigFromStartupScript,
  clusterLocalDropInFromStartupScript,
  clusterLocalCapacityNetwork,
  localClusterNodeContainer,
  localClusterVmRowIdFromAgentConfig,
} from '../integration/e2e/internal/substrates/local-cluster/capacity-compute.js';
import {
  kubernetesE2EServeImage,
  kubernetesE2EServePort,
} from '../integration/e2e/internal/kubernetes-constants.js';
import { localClusterVmType } from '../integration/e2e/internal/substrates/local-cluster/constants.js';
import { CleanupStack } from '../integration/e2e/internal/cleanup.js';
import { StageProgress } from '../integration/e2e/internal/progress.js';
import { CliNodePoolServiceTransport } from '../integration/e2e/internal/transports/node-pool-service.js';
import {
  commandResultForTest,
  trackedWorkloadRefForTest,
} from './helpers/e2e.js';
import {
  publishedKubeconfig,
  waitForKubeSystemIdentity,
} from '../integration/e2e/internal/substrates/local-cluster/cluster-host.js';
import { Waiter } from '../integration/e2e/internal/wait.js';

const certificateAuthorityData = Buffer.from(
  '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n',
).toString('base64');

function joinScript(vmRowId: number): string {
  return buildNodePoolAgentStartupScript(
    {
      clusterId: 'cluster-one',
      nodePoolId: 'pool-one-id',
      cloudProvider: CloudType.AWS,
      vmRowId,
      joinEndpoint: 'https://172.17.0.1:41234',
      certificateAuthorityData,
      disk: { nvme: false, systemReservedGi: 10, kubeReservedGi: 10 },
      boot: METADATA_NODE_POOL_BOOT,
      prepullImages: [],
    },
    {
      token: k3sSecureToken(
        certificateAuthorityData,
        'abcdef.0123456789abcdef',
      ),
    },
  );
}

describe('local cluster qualification substrate', () => {
  test('uses classified CPU capacity without injecting Deployment GPU options', () => {
    expect(isCPUVMType(CloudType.AWS, localClusterVmType)).toBe(true);
    expect(
      defaultGpuAccess(
        { cloudProvider: CloudType.AWS, vmType: localClusterVmType },
        null,
      ),
    ).toBeNull();
  });

  test('runs the agent from the exact production join configuration', () => {
    const config = clusterLocalAgentConfigFromStartupScript(joinScript(407));
    expect(config.server).toBe('https://172.17.0.1:41234');
    expect(config.token).toBe(
      k3sSecureToken(certificateAuthorityData, 'abcdef.0123456789abcdef'),
    );
    expect(config['node-name']).toBe(nodePoolNodeName('pool-one-id', 407));
    expect(config['node-label']).toEqual(
      expect.arrayContaining([
        'anycloud.sh/cluster=cluster-one',
        'anycloud.sh/node-pool=pool-one-id',
        'anycloud.sh/attempt=407',
      ]),
    );
    expect(config['node-taint']).toEqual(
      nodePoolNodeTaints('pool-one-id').map(
        (taint) => `${taint.key}=${taint.value}:${taint.effect}`,
      ),
    );
    expect(localClusterVmRowIdFromAgentConfig(config)).toBe(407);
    // The external IP is a boot-time substitution; the config must carry the
    // placeholder, and a container (no metadata service) takes the drop branch.
    expect(config['node-external-ip']).toBe(NODE_EXTERNAL_IP_PLACEHOLDER);
    expect(
      readFileSync(
        'test/integration/e2e/internal/substrates/local-cluster/capacity-compute.ts',
        'utf8',
      ),
    ).not.toContain("'--node-external-ip'");
    expect(() =>
      clusterLocalAgentConfigFromStartupScript(
        joinScript(407).replace(/,\n\s*"node-external-ip": "[^"]*"/u, ''),
      ),
    ).toThrow();
  });

  test("writes the join script's kubelet and containerd drop-ins for the agent", () => {
    expect(
      clusterLocalDropInFromStartupScript(joinScript(407), 'KUBELET'),
    ).toEqual({
      path: '/var/lib/rancher/k3s/agent/etc/kubelet.conf.d/50-anycloud.conf',
      content:
        'apiVersion: kubelet.config.k8s.io/v1beta1\nkind: KubeletConfiguration\nsingleProcessOOMKill: true\nshutdownGracePeriod: 90s\nshutdownGracePeriodCriticalPods: 10s\nsystemReserved:\n  ephemeral-storage: 10Gi\nkubeReserved:\n  ephemeral-storage: 10Gi\nevictionHard:\n  memory.available: 100Mi\n  nodefs.available: 5%\n  nodefs.inodesFree: 5%\n  imagefs.available: 5%\n  imagefs.inodesFree: 5%',
    });
    expect(
      clusterLocalDropInFromStartupScript(joinScript(407), 'CONTAINERD'),
    ).toEqual({
      path: '/var/lib/rancher/k3s/agent/etc/containerd/config-v3.toml.d/50-anycloud.toml',
      content:
        "version = 3\n[plugins.'io.containerd.cri.v1.images']\n  use_local_image_pull = false\n[plugins.'io.containerd.transfer.v1.local']\n  max_concurrent_downloads = 3\n  concurrent_layer_fetch_buffer = 134217728",
    });
    expect(() =>
      clusterLocalDropInFromStartupScript('#!/bin/bash\nk3s agent', 'KUBELET'),
    ).toThrow('could not find the KUBELET drop-in');
    expect(() =>
      clusterLocalDropInFromStartupScript(
        '#!/bin/bash\nk3s agent',
        'CONTAINERD',
      ),
    ).toThrow('could not find the CONTAINERD drop-in');
  });

  test('refuses a startup script without the K3s configuration or a pinned token', () => {
    expect(() =>
      clusterLocalAgentConfigFromStartupScript('#!/bin/bash\nk3s agent'),
    ).toThrow('could not find the K3s agent configuration');
    expect(() =>
      clusterLocalAgentConfigFromStartupScript(
        joinScript(1).replace(/K10[0-9a-f]{64}::/u, ''),
      ),
    ).toThrow();
    expect(() =>
      localClusterVmRowIdFromAgentConfig({
        ...clusterLocalAgentConfigFromStartupScript(joinScript(1)),
        'node-label': ['anycloud.sh/node-pool=pool-one-id'],
      }),
    ).toThrow('could not recover the attempt id');
  });

  test('routes API server → kubelet reads over the agent tunnel', () => {
    // Node pool agents sit on their own Docker networks; K3s's default
    // `agent` egress mode dials kubelets directly and fails Pod log reads.
    const managementHost = readFileSync(
      'test/integration/e2e/internal/substrates/local-cluster/cluster-host.ts',
      'utf8',
    );
    expect(managementHost).toContain("'--egress-selector-mode=cluster'");
    // The product's disable list. An unschedulable metrics-server leaves its
    // APIService unavailable, and namespace deletion then never finishes.
    expect(managementHost).toContain(
      "'--disable',\n        'traefik,servicelb,metrics-server',",
    );
    // Agents re-point their supervisor tunnel to the advertised address, which
    // must therefore be the host-gateway address and port they can reach.
    expect(managementHost).toContain('`--advertise-address=${publicIp}`');
    expect(managementHost).toContain('`--advertise-port=${String(hostPort)}`');
  });

  test('lets a dead agent end its VM instead of restarting it in place', () => {
    // A K3s agent whose kubelet died before its Node registered restarts with a
    // client certificate for a Node that does not exist; the server answers
    // 401 and the agent never rejoins. The container is the VM: it stays
    // exited, reads as a released host and the controller replaces it.
    const compute = readFileSync(
      'test/integration/e2e/internal/substrates/local-cluster/capacity-compute.ts',
      'utf8',
    );
    expect(compute).toContain(
      "RestartPolicy: { Name: 'no', MaximumRetryCount: 0 }",
    );
    expect(compute).not.toContain("Name: 'unless-stopped'");
    expect(compute).toContain(
      'if (!container.running) {\n    await removeLocalClusterNodeContainer(cloudId, container);\n    return null;',
    );
    expect(compute).toContain("Tmpfs: { '/run': '', '/var/run': '' }");
  });

  test('dumps container diagnostics through one channel with each state', () => {
    // Vitest buffers console.error and flushes it after direct stderr writes,
    // which put each container header under another container's log.
    const command = readFileSync(
      'test/integration/e2e/internal/substrates/local-cluster/command.ts',
      'utf8',
    );
    const body = command.slice(
      command.indexOf('export async function dumpLocalKubernetesDiagnostics'),
    );
    expect(body).not.toContain('console.error(');
    expect(body).toContain(
      'restarts={{.RestartCount}} exit={{.State.ExitCode}}',
    );
    const environment = readFileSync(
      'test/integration/e2e/internal/substrates/local-cluster/environment.ts',
      'utf8',
    );
    expect(environment).not.toContain('this.#host.captureDiagnostics()');
  });

  test('tells the Service image where it listens and requires the CLI acknowledgement', async () => {
    // The product probes `$PORT` (default 8088) for readiness; nginx listens
    // on 80 and ignores `$PORT`, so without `--env PORT=80` the Service never
    // leaves `provisioning`.
    const ref = trackedWorkloadRefForTest('d-service-1');
    const runCliCreate = vi.fn(async (_ref: unknown, args: readonly string[]) =>
      commandResultForTest({
        stdout: `   ✓ Service workload created!\n   ID: ${String(args[args.indexOf('--id') + 1])}\n`,
        combined: `   ID: ${String(args[args.indexOf('--id') + 1])}\n`,
      }),
    );
    const wait = vi.fn(async (args: readonly string[]) =>
      commandResultForTest({
        args: [...args],
        exitCode: 0,
        stdout: `${JSON.stringify({ type: 'state', state: 'running', ready: true })}\n`,
      }),
    );
    const transport = new CliNodePoolServiceTransport({
      cli: { run: wait },
      kernel: {
        reserve: vi.fn(),
        waitForState: vi.fn(async () => ({
          workload: { nodePoolId: 'p-pool-1' },
          events: [{ state: WorkloadState.Running, createdAt: 123_456 }],
        })) as never,
        status: vi.fn(),
        requestTermination: vi.fn(),
        waitForCleanupRecorded: vi.fn(),
        recordLedgerCleared: vi.fn(),
        recordSubstrateAbsence: vi.fn(),
        release: vi.fn(),
      },
      mutations: { runCliCreate },
      vmLedger: { liveVmCount: vi.fn(async () => 0) },
    });
    const running = await transport.createAndAwaitRunning(
      ref,
      {
        image: kubernetesE2EServeImage,
        port: kubernetesE2EServePort,
        nodePoolId: 'p-pool-1',
      },
      1_000,
    );
    expect(running).toEqual({
      nodePoolId: 'p-pool-1',
      liveVmCount: 0,
      runningEventAt: 123_456,
    });
    expect(runCliCreate.mock.calls[0]?.[1]).toEqual([
      'service',
      '--node-pool',
      'p-pool-1',
      '--id',
      'd-service-1',
      '--env',
      'PORT=80',
      kubernetesE2EServeImage,
    ]);
    expect(runCliCreate.mock.calls[0]?.[1]).not.toContain('--json');
    expect(wait.mock.calls[0]?.[0]).toEqual([
      'wait',
      'd-service-1',
      '--json',
      '--timeout',
      '60s',
    ]);
    wait.mockResolvedValueOnce(commandResultForTest({ exitCode: 2 }));
    await expect(
      transport.createAndAwaitRunning(
        ref,
        { image: 'x', port: 80, nodePoolId: 'p' },
        1_000,
      ),
    ).rejects.toThrow(
      'anycloud wait did not report the node pool Service ready',
    );
    runCliCreate.mockResolvedValueOnce(
      commandResultForTest({ combined: '   ID: d-service-other\n' }),
    );
    await expect(
      transport.createAndAwaitRunning(
        trackedWorkloadRefForTest('d-service-2'),
        { image: 'x', port: 80, nodePoolId: 'p' },
        1_000,
      ),
    ).rejects.toThrow('did not acknowledge d-service-2');
  });

  test('reports each cleanup step as it runs, with its duration', async () => {
    const lines: string[] = [];
    const stack = new CleanupStack((message) => lines.push(message));
    stack.defer('first', async () => undefined);
    stack.defer('second', async () => {
      throw new Error('boom');
    });
    await expect(stack.run()).rejects.toThrow('second: boom');
    expect(lines).toEqual([
      'cleanup: second',
      expect.stringMatching(/^cleanup: second failed in \d+s: boom$/u),
      'cleanup: first',
      expect.stringMatching(/^cleanup: first done in \d+s$/u),
    ]);
    const marks: string[] = [];
    new StageProgress((line) => marks.push(line)).mark('node pools ready');
    expect(marks[0]).toMatch(
      /^\[e2e \d{4}-\d{2}-\d{2}T[\d:.]+Z\] node pools ready\n$/u,
    );
  });

  test('dumps the cleanup phase of a failed run as well as the failure', () => {
    const environment = readFileSync(
      'test/integration/e2e/internal/substrates/local-cluster/environment.ts',
      'utf8',
    );
    expect(environment).toContain('{ since: this.#diagnosedAt }');
    const command = readFileSync(
      'test/integration/e2e/internal/substrates/local-cluster/command.ts',
      'utf8',
    );
    expect(command).toContain("['--since', options.since]");
  });

  test('derives stable, scope-isolated Docker resource identities', () => {
    expect(clusterLocalCapacityNetwork('pool-a')).toBe(
      'anycloud-node-pool-pool-a',
    );
    expect(clusterLocalCapacityNetwork('pool-a')).not.toBe(
      clusterLocalCapacityNetwork('pool-b'),
    );
    expect(localClusterNodeContainer('vm-a')).toBe('anycloud-node-vm-a');
  });

  test('publishes the K3s kubeconfig on one host-gateway URL and keeps its certificates', () => {
    const source = [
      'apiVersion: v1',
      'kind: Config',
      'clusters:',
      '- name: default',
      '  cluster:',
      '    server: https://127.0.0.1:6443',
      `    certificate-authority-data: ${certificateAuthorityData}`,
      'users:',
      '- name: default',
      '  user:',
      '    client-certificate-data: Y2VydA==',
      '    client-key-data: a2V5',
      'contexts:',
      '- name: default',
      '  context:',
      '    cluster: default',
      '    user: default',
      'current-context: default',
      '',
    ].join('\n');
    const published = publishedKubeconfig(source, 'https://172.17.0.1:41234');
    expect(published.certificateAuthorityData).toBe(certificateAuthorityData);
    const parsed = JSON.parse(published.kubeconfig) as {
      clusters: { cluster: { server: string } }[];
      users: { user: { 'client-certificate-data': string } }[];
    };
    expect(parsed.clusters[0].cluster.server).toBe('https://172.17.0.1:41234');
    expect(parsed.users[0].user['client-certificate-data']).toBe('Y2VydA==');
    expect(() =>
      publishedKubeconfig(
        source.replace('    client-certificate-data: Y2VydA==\n', ''),
        'https://172.17.0.1:41234',
      ),
    ).toThrow();
  });

  test('waits through the apiserver window in which kube-system does not exist yet before reading the identity', async () => {
    let reads = 0;
    const core = {
      readNamespace: async () => {
        reads += 1;
        if (reads <= 2) {
          throw Object.assign(new Error('namespaces "kube-system" not found'), {
            code: 404,
          });
        }
        return { metadata: { uid: 'uid-kube-system' } };
      },
    };
    const wait = new Waiter(new AbortController().signal);
    await expect(
      waitForKubeSystemIdentity(core, wait, 'local cluster x', {
        timeoutMs: 2_000,
        intervalMs: 5,
      }),
    ).resolves.toBe('uid-kube-system');
    expect(reads).toBe(3);

    // Anything but a 404 is a real failure, not a namespace still booting.
    await expect(
      waitForKubeSystemIdentity(
        {
          readNamespace: async () => {
            throw Object.assign(new Error('forbidden'), { code: 403 });
          },
        },
        wait,
        'local cluster y',
        { timeoutMs: 2_000, intervalMs: 5 },
      ),
    ).rejects.toThrow('forbidden');
    await expect(
      waitForKubeSystemIdentity(
        { readNamespace: async () => ({ metadata: {} }) },
        wait,
        'local cluster z',
        { timeoutMs: 20, intervalMs: 5 },
      ),
    ).rejects.toThrow('kube-system namespace not created yet');
  });
});

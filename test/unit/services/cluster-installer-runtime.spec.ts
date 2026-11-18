import { describe, expect, it, vi } from 'vitest';
import {
  SSHExecError,
  SSHMasterUnreachableError,
} from '../../../src/api/services/gateways/ssh.js';
import type { HostCommandTransport } from '../../../src/api/services/gateways/host-command-transport.js';
import type { V1ContainerState, V1Pod } from '@kubernetes/client-node';
import {
  createCloudCompute,
  VM_PRESENT,
} from '../../../src/api/services/gateways/cloud.js';
import {
  CloudType,
  type CloudConfig,
  type CloudCredentials,
} from '../../../src/shared/cloud.js';
import {
  createClusterInfrastructure,
  createManagementHostAccess,
  createClusterReleaseClient,
  type ReleaseDiagnosticApis,
} from '../../../src/api/services/cluster-installer-runtime.js';
import type { ClusterConnectionDocument } from '../../../src/api/services/kubernetes/cluster-connection.js';

const target = {
  host: '203.0.113.7',
  port: 22,
  username: 'root',
  privateKey: 'key',
};

/**
 * Mimics `SSHManager` precisely enough to matter: `_execInternal` resolves
 * with the remote exit code for ordinary commands, wraps the codes it treats
 * as transient in an SSHExecError whose message carries the code, and throws
 * transport errors when sshd is not reachable. `exec`-style callers would
 * additionally throw `Command exited with code N: …` for any non-zero exit.
 */
function fakeTransport(
  behaviour: (command: string) => Promise<{
    stdout: string;
    stderr: string;
    code: number;
  }>,
  reachable = true,
): { factory: () => HostCommandTransport; connections: string[] } {
  const connections: string[] = [];
  return {
    connections,
    factory: () => ({
      runCommand: (command) => behaviour(command),
      portReachable: async () => reachable,
      writeFile: async () => {},
    }),
  };
}

describe('management host access adapter', () => {
  it('returns non-zero exit codes as data instead of throwing', async () => {
    const transport = fakeTransport(async () => ({
      stdout: '',
      stderr: 'k3s binary is not prepared\n',
      code: 64,
    }));
    const access = createManagementHostAccess(transport.factory);
    await expect(access.exec(target, 'configure')).resolves.toEqual({
      kind: 'exited',
      code: 64,
      stdout: '',
      stderr: 'k3s binary is not prepared\n',
    });
  });

  it('recovers the exit code SSHManager wraps for its transient codes', async () => {
    const transport = fakeTransport(async () => {
      throw new SSHExecError('Command exited with code 2', 'out', 'err');
    });
    const access = createManagementHostAccess(transport.factory);
    await expect(access.exec(target, 'kubectl get node')).resolves.toEqual({
      kind: 'exited',
      code: 2,
      stdout: 'out',
      stderr: 'err',
    });
  });

  it('recovers the exit code from the retrying exec wrapper message shape too', async () => {
    const transport = fakeTransport(async () => {
      throw new Error('Command exited with code 1: NotReady');
    });
    const access = createManagementHostAccess(transport.factory);
    await expect(access.exec(target, 'poll')).resolves.toMatchObject({
      kind: 'exited',
      code: 1,
    });
  });

  it('reports transport failures as unreachable rather than as a remote exit', async () => {
    for (const error of [
      new SSHMasterUnreachableError(),
      new SSHExecError(
        'SSH stream closed abnormally before command completed',
        '',
        '',
      ),
      new Error('spawn ssh ECONNREFUSED'),
    ]) {
      const transport = fakeTransport(async () => {
        throw error;
      });
      const access = createManagementHostAccess(transport.factory);
      const outcome = await access.exec(target, 'echo ready');
      expect(outcome.kind).toBe('unreachable');
      if (outcome.kind === 'unreachable') {
        expect(outcome.error).toBe(error.message);
      }
    }
  });

  it('probes the SSH port without a session and treats probe errors as unreachable', async () => {
    const up = fakeTransport(async () => ({ stdout: '', stderr: '', code: 0 }));
    await expect(
      createManagementHostAccess(up.factory).reachable(target),
    ).resolves.toBe(true);
    const down = fakeTransport(
      async () => ({ stdout: '', stderr: '', code: 0 }),
      false,
    );
    await expect(
      createManagementHostAccess(down.factory).reachable(target),
    ).resolves.toBe(false);
    const broken = createManagementHostAccess(() => ({
      runCommand: async () => ({ stdout: '', stderr: '', code: 0 }),
      portReachable: async () => {
        throw new Error('getaddrinfo ENOTFOUND');
      },
      writeFile: async () => {},
    }));
    await expect(broken.reachable(target)).resolves.toBe(false);
  });

  it('connects with the target host, key, port and username', async () => {
    const seen: unknown[] = [];
    const access = createManagementHostAccess((host, key, port, username) => {
      seen.push([host, key, port, username]);
      return {
        runCommand: async () => ({ stdout: 'ready\n', stderr: '', code: 0 }),
        portReachable: async () => true,
        writeFile: async () => {},
      };
    });
    await access.exec({ ...target, port: 2222, username: 'ubuntu' }, 'echo');
    expect(seen).toEqual([['203.0.113.7', 'key', 2222, 'ubuntu']]);
  });

  it('writes files through the transport stdin channel with the requested mode', async () => {
    const writes: unknown[] = [];
    const access = createManagementHostAccess(() => ({
      runCommand: async () => ({ stdout: '', stderr: '', code: 0 }),
      portReachable: async () => true,
      writeFile: async (path, content, mode) => {
        writes.push([path, content, mode]);
      },
    }));
    await access.writeFile(
      target,
      '/etc/rancher/k3s/config.yaml.new',
      'token: t\n',
      0o600,
    );
    expect(writes).toEqual([
      ['/etc/rancher/k3s/config.yaml.new', 'token: t\n', 0o600],
    ]);
  });

  it('bounds each command by the requested timeout, defaulting to the long host-preparation budget', async () => {
    const timeouts: number[] = [];
    const access = createManagementHostAccess(() => ({
      runCommand: async (_command, timeoutMs) => {
        timeouts.push(timeoutMs);
        return { stdout: '', stderr: '', code: 0 };
      },
      portReachable: async () => true,
      writeFile: async () => {},
    }));
    await access.exec(target, 'echo ready', { timeoutMs: 30_000 });
    await access.exec(target, 'configure');
    expect(timeouts).toEqual([30_000, 10 * 60_000]);
  });
});

describe('cluster infrastructure adapter', () => {
  function adapter(
    observeOnce: () => Promise<typeof VM_PRESENT>,
    listResourceVMs?: () => Promise<Array<{ id: string; stopped: boolean }>>,
  ) {
    const configs: Array<{ config: CloudConfig; purpose?: string }> = [];
    const decrypted: string[] = [];
    const gateway = createCloudCompute({
      type: CloudType.AWS,
      region: 'eu-west-1',
      vmType: 't3.medium',
      rawValidateCredentials: vi.fn(),
      rawClassifyError: vi.fn(),
      rawNewVM: vi.fn(),
      rawRequestVMTermination: vi.fn(),
      rawTerminateNetworking: vi.fn(),
      rawGetAllVMs: vi.fn().mockResolvedValue([]),
      rawUpsertFirewall: vi.fn(),
      observeVMReleaseOnce: observeOnce,
      releaseConfirmWaitMs: 0,
      resourceScoped: {
        prepareResourceNetwork: vi.fn(),
        newResourceVM: vi.fn(),
        terminateResourceNetwork: vi.fn(),
        listResourceVMs,
      },
    });
    const infrastructure = createClusterInfrastructure('0.1.64', {
      createCompute: (config, purpose) => {
        configs.push({ config, purpose });
        return gateway;
      },
      decryptCredential: async (encrypted) => {
        decrypted.push(encrypted);
        return {
          cloudProvider: CloudType.AWS,
          accessKeyId: 'AKIA',
          secretAccessKey: 'secret',
        };
      },
    });
    return { configs, decrypted, infrastructure };
  }
  const credential = {
    id: 'cred-1',
    encryptedData: 'sealed-cred-1',
    cloudProvider: CloudType.AWS,
    authFailedAt: null,
  };

  it('asks the gateway for the scope-tagged VMs in the create target', async () => {
    const listResourceVMs = vi.fn(async () => [
      { id: 'i-lost', stopped: true },
    ]);
    const { configs, infrastructure } = adapter(
      async () => VM_PRESENT,
      listResourceVMs,
    );
    const scope = {
      id: 'anycloud-cluster-c1',
      tags: { anycloud_cluster: 'c1' },
    };
    await expect(
      infrastructure.findManagementVms({
        credential,
        target: {
          region: 'eu-west-1',
          zone: 'eu-west-1b',
          vmType: 't3.medium',
        },
        scope,
      }),
    ).resolves.toEqual(['i-lost']);
    expect(listResourceVMs).toHaveBeenCalledWith(scope);
    expect(configs).toMatchObject([
      {
        purpose: 'observed-vm',
        config: { region: 'eu-west-1', availabilityZone: 'eu-west-1b' },
      },
    ]);
  });

  it('observes the recorded management VM with its credential, region and zone, and passes Present through', async () => {
    const observeOnce = vi.fn(async () => VM_PRESENT);
    const { configs, decrypted, infrastructure } = adapter(observeOnce);
    await expect(
      infrastructure.observeManagementVm({
        credential,
        identity: {
          cloudId: 'i-recorded',
          provider: CloudType.AWS,
          credentialId: 'cred-1',
          region: 'eu-west-1',
          availabilityZone: 'eu-west-1b',
          vmType: 't3.medium',
        },
      }),
    ).resolves.toEqual(VM_PRESENT);
    expect(decrypted).toEqual(['sealed-cred-1']);
    expect(configs).toMatchObject([
      {
        purpose: 'observed-vm',
        config: {
          cloudProvider: CloudType.AWS,
          region: 'eu-west-1',
          availabilityZone: 'eu-west-1b',
          credentials: { accessKeyId: 'AKIA' },
        },
      },
    ]);
    expect(observeOnce).toHaveBeenCalledWith('i-recorded', undefined);
  });
});

describe('managed checkpoint bucket deletion', () => {
  const material: ReadonlyArray<readonly [string, CloudCredentials]> = [
    [
      'us-east-1',
      {
        cloudProvider: CloudType.AWS,
        accessKeyId: 'AKIA',
        secretAccessKey: 'secret',
      },
    ],
    [
      'us-central1',
      {
        cloudProvider: CloudType.GCP,
        projectId: 'p',
        privateKey: 'k',
        clientEmail: 'e@p.iam',
      },
    ],
    [
      'eastus',
      {
        cloudProvider: CloudType.Azure,
        applicationId: 'a',
        secret: 'x',
        directoryId: 'd',
        subscriptionId: 's',
      },
    ],
  ];
  it.each(
    material.map(
      ([region, credential]) =>
        [credential.cloudProvider, region, credential] as const,
    ),
  )(
    'deletes the %s bucket through that cloud storage in its region, and skips one already gone',
    async (cloudProvider, region, credential) => {
      const { cloudProvider: _, ...credentials } = credential;
      const deleted: string[] = [];
      const created: unknown[] = [];
      let exists = true;
      const infrastructure = createClusterInfrastructure('0.1.64', {
        decryptCredential: async () => credential,
        createStorage: ((config: unknown) => {
          created.push(config);
          return {
            hasBucket: async () => exists,
            deleteBucket: async (bucket: string) => {
              deleted.push(bucket);
              exists = false;
            },
          };
        }) as never,
      });
      const input = {
        credential: {
          id: 'cred-1',
          encryptedData: 'sealed',
          cloudProvider,
          authFailedAt: null,
        },
        region,
        bucket: 'prod-1789960000000-abcd',
      };
      await infrastructure.deleteCheckpointBucket(input);
      await infrastructure.deleteCheckpointBucket(input);
      expect(deleted).toEqual(['prod-1789960000000-abcd']);
      expect(created).toMatchObject([
        { cloudProvider, region, credentials },
        { cloudProvider, region },
      ]);
    },
  );
});

describe('cluster release diagnostics', () => {
  const connection: ClusterConnectionDocument = {
    kind: 'installer',
    server: 'https://cluster:6443',
    certificateAuthorityData: 'Y2E=',
    credential: { kind: 'token', token: 't' },
  };
  const notFound = Object.assign(new Error('not found'), { code: 404 });
  const status = (name: string, state: V1ContainerState, restartCount = 0) => ({
    name,
    image: '',
    imageID: '',
    ready: false,
    restartCount,
    state,
  });
  const pods: Record<string, V1Pod[]> = {
    'job-name=helm-install-anycloud-api': [
      {
        metadata: {
          name: 'helm-install-anycloud-api-k1',
          creationTimestamp: new Date(1),
        },
        status: { phase: 'Failed' },
      },
      {
        metadata: {
          name: 'helm-install-anycloud-api-k2',
          creationTimestamp: new Date(2),
        },
        status: {
          phase: 'Failed',
          containerStatuses: [
            status('helm', {
              terminated: {
                exitCode: 1,
                message: 'Error: INSTALLATION FAILED',
              },
            }),
          ],
        },
      },
    ],
    'app.kubernetes.io/name=anycloud-api': [
      {
        metadata: { name: 'anycloud-api-7f9-abc' },
        status: {
          phase: 'Pending',
          containerStatuses: [
            status(
              'api',
              {
                waiting: {
                  reason: 'ImagePullBackOff',
                  message: 'Back-off pulling image "ghcr.io/anycloud-sh/api"',
                },
              },
              3,
            ),
          ],
        },
      },
    ],
  };
  const event = (reason: string, message: string, at: number) => ({
    metadata: {},
    involvedObject: {},
    reason,
    message,
    lastTimestamp: new Date(at),
  });
  const apis: ReleaseDiagnosticApis = {
    core: {
      listNamespacedPod: async ({ labelSelector }) => ({
        items: pods[labelSelector ?? ''] ?? [],
      }),
      // Newest event wins regardless of list order.
      listNamespacedEvent: async ({ fieldSelector }) => ({
        items:
          fieldSelector === 'involvedObject.name=anycloud-api-7f9-abc'
            ? [
                event('Failed', 'Failed to pull image', 1),
                event('BackOff', 'Back-off pulling image', 2),
              ]
            : [],
      }),
      // Helm's error text is in the newest Job Pod's log; tokens are masked.
      readNamespacedPodLog: async ({ name, tailLines, limitBytes }) => {
        expect(limitBytes).toBe(64 * 1024);
        expect(tailLines).toBe(20);
        if (name !== 'helm-install-anycloud-api-k2') throw notFound;
        return [
          'Authorization: Bearer K10abcdefabcdefabcdefabcdefabcdefabcdef::server:0123456789abcdef',
          'token=eyJhbGciOiJSUzI1NiIsImtpZCI6IjEyMyJ9.payload',
          'Error: INSTALLATION FAILED: unable to build kubernetes objects from release manifest:',
          'resource mapping not found for name: "anycloud-api" namespace: "anycloud-system" from "": no matches for kind "IngressRoute" in version "traefik.io/v1alpha1"',
          '',
        ].join('\n');
      },
      // A 404 is reported as absence, never as a failed diagnosis.
      readNamespacedPersistentVolumeClaim: async () => {
        throw notFound;
      },
    },
    batch: {
      readNamespacedJob: async () => ({
        status: {
          failed: 1,
          conditions: [
            {
              type: 'Failed',
              status: 'True',
              reason: 'BackoffLimitExceeded',
              message: 'Job has reached the specified backoff limit',
            },
          ],
        },
      }),
    },
  };

  it('keeps Secret resource errors while masking bare token-shaped values', async () => {
    const diagnostic =
      'failed to create: secrets "sh.helm.release.v1.anycloud-api.v1" is forbidden: exceeded quota';
    const token = 'abcdef0123456789'.repeat(4);
    const client = createClusterReleaseClient(() => ({
      ...apis,
      core: {
        ...apis.core,
        readNamespacedPodLog: async () => `${diagnostic}\n${token}`,
      },
    }));
    const result = await client.describeRelease(connection, 'anycloud-system');
    expect(result).toContain(diagnostic);
    expect(result).not.toContain(token);
    expect(result).toContain('<redacted>');
  });

  it('preserves other diagnostics when the Helm log read fails', async () => {
    const client = createClusterReleaseClient(() => ({
      ...apis,
      core: {
        ...apis.core,
        readNamespacedPodLog: async () => {
          throw new Error('container is waiting to start');
        },
      },
    }));
    const result = await client.describeRelease(connection, 'anycloud-system');
    expect(result).toContain(
      'helm Job log: unavailable: container is waiting to start',
    );
    expect(result).toContain('API Pods: anycloud-api-7f9-abc Pending');
    expect(result).toContain('PVC anycloud-api-state not found');
  });

  it('selects the newest Helm Pod independently of list order', async () => {
    const client = createClusterReleaseClient(() => ({
      ...apis,
      core: {
        ...apis.core,
        listNamespacedPod: async ({ labelSelector }) => ({
          items: [...(pods[labelSelector ?? ''] ?? [])].reverse(),
        }),
      },
    }));
    await expect(
      client.describeRelease(connection, 'anycloud-system'),
    ).resolves.toContain('helm Job log: helm-install-anycloud-api-k2:');
  });

  it("shows why a crash-looping API exits: its previous run's log tail, redacted, and events whose times are strings", async () => {
    const token = 'abcdef0123456789'.repeat(4);
    const reads: unknown[] = [];
    const crashing = {
      metadata: { name: 'anycloud-api-6d5-j97' },
      status: {
        phase: 'Running',
        containerStatuses: [
          {
            name: 'api',
            restartCount: 7,
            state: {
              waiting: { reason: 'CrashLoopBackOff', message: 'back-off 5m0s' },
            },
            lastState: { terminated: { exitCode: 1, reason: 'Error' } },
          },
        ],
      },
    };
    const client = createClusterReleaseClient(() => ({
      ...apis,
      core: {
        ...apis.core,
        listNamespacedPod: async ({ labelSelector }) => ({
          items:
            labelSelector === 'app.kubernetes.io/name=anycloud-api'
              ? [crashing as never]
              : [],
        }),
        listNamespacedEvent: async () => ({
          items: [
            {
              ...event('BackOff', 'Back-off restarting failed container', 0),
              lastTimestamp: '2026-09-30T20:20:00Z' as never,
            },
          ],
        }),
        readNamespacedPodLog: async (request) => {
          reads.push(request);
          return `starting\ntoken=${token}\nAKIAABCDEFGHIJKLMNOP db=postgres://api:hunter2@db:5432\nError: startup refused (fixture)\n`;
        },
      },
    }));
    const result = await client.describeRelease(connection, 'anycloud-system');
    expect(result).toContain(
      'API Pods: anycloud-api-6d5-j97 Running [api waiting CrashLoopBackOff (back-off 5m0s) exited 1 (Error) 7 restarts log: starting / token=<redacted> / <REDACTED_AWS_KEY> db=postgres://api:<REDACTED>@db:5432 / Error: startup refused (fixture)]; last event: BackOff: Back-off restarting failed container',
    );
    expect(result).not.toContain(token);
    // The shared redactor's formats too: AWS key ids and URL passwords.
    expect(result).not.toContain('AKIAABCDEFGHIJKLMNOP');
    expect(result).not.toContain('hunter2');
    expect(reads).toContainEqual(
      expect.objectContaining({
        name: 'anycloud-api-6d5-j97',
        container: 'api',
        previous: true,
      }),
    );
  });

  it('reports a crashed container log it cannot read, clipped, without hiding the rest', async () => {
    const failing = {
      metadata: { name: 'anycloud-api-x' },
      status: {
        phase: 'Running',
        containerStatuses: [
          {
            name: 'api',
            restartCount: 1,
            lastState: { terminated: { exitCode: 2 } },
          },
        ],
      },
    };
    const client = createClusterReleaseClient(() => ({
      ...apis,
      core: {
        ...apis.core,
        listNamespacedPod: async ({ labelSelector }) => ({
          items:
            labelSelector === 'app.kubernetes.io/name=anycloud-api'
              ? [failing as never]
              : [],
        }),
        readNamespacedPodLog: async () => {
          throw new Error(
            `HTTP-Code: 400 previous terminated container "api" not found ${'x'.repeat(2_000)}`,
          );
        },
      },
    }));
    const result = await client.describeRelease(connection, 'anycloud-system');
    expect(result).toContain(
      'api exited 2 () 1 restarts log: unavailable: HTTP-Code: 400 previous terminated container "api" not found',
    );
    expect(result).toContain('PVC anycloud-api-state not found');
    expect(result.length).toBeLessThan(1_000);
  });

  it('reports an absent Job Pod as no log rather than a failed diagnosis', async () => {
    const client = createClusterReleaseClient(() => ({
      ...apis,
      core: { ...apis.core, listNamespacedPod: async () => ({ items: [] }) },
    }));
    await expect(
      client.describeRelease(connection, 'anycloud-system'),
    ).resolves.toContain('helm Job log: no Pod. API Pods: none');
  });

  it('names the helm Job outcome, its newest Pod log, each API Pod with its waiting reason, restarts and newest event, and the absent claim', async () => {
    const client = createClusterReleaseClient(() => apis);
    await expect(
      client.describeRelease(connection, 'anycloud-system'),
    ).resolves.toBe(
      'helm Job helm-install-anycloud-api 0 active, 0 succeeded, 1 failed (Failed BackoffLimitExceeded: Job has reached the specified backoff limit): helm-install-anycloud-api-k1 Failed | helm-install-anycloud-api-k2 Failed [helm exited 1 (Error: INSTALLATION FAILED)]. helm Job log: helm-install-anycloud-api-k2: Authorization: <redacted> / token=<redacted> / Error: INSTALLATION FAILED: unable to build kubernetes objects from release manifest: / resource mapping not found for name: "anycloud-api" namespace: "anycloud-system" from "": no matches for kind "IngressRoute" in version "traefik.io/v1alpha1". API Pods: anycloud-api-7f9-abc Pending [api waiting ImagePullBackOff (Back-off pulling image "ghcr.io/anycloud-sh/api") 3 restarts]; last event: BackOff: Back-off pulling image. PVC anycloud-api-state not found',
    );
  });
});

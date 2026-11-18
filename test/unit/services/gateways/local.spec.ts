import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import {
  Local,
  LOCAL_RUNTIME_PREFLIGHT_CACHE_TTL_MS,
  localMachineName,
  runLocalSmolvmPreflight,
  type LocalTransportFactory,
} from '../../../../src/api/services/gateways/local';
import type {
  LocalSmolvmRuntime,
  LocalSmolvmRuntimeClient,
} from '../../../../src/api/services/gateways/local-smolvm-runtime';
import { SmolvmServeError } from '../../../../src/api/services/gateways/smolvm-serve-client';
import { completeCloudConfig } from '../../../../src/shared/cloud-config.js';
import {
  VMReleaseState,
  canSupportIngress,
} from '../../../../src/api/services/gateways/cloud';
import {
  CloudFailureDiagnosis,
  CloudType,
  type CloudConfig,
} from '../../../../src/shared/cloud.js';
import type {
  IngressSpec,
  NewVMProps,
} from '../../../../src/api/services/entities';
import { LOCAL_SMOLVM_CONTRACT } from '../../../../src/api/services/gateways/local-smolvm-contract';
import {
  buildJobIngressSpec,
  buildServeIngressSpec,
} from '../../../../src/api/services/network';
import { TEST_RESOURCE_SWEEP_OPTIONS } from '../../../helpers/resource-sweep-policy';

vi.mock('../../../../src/api/services/logger', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

type FakeClient = {
  [K in keyof LocalSmolvmRuntimeClient]: Mock;
} & LocalSmolvmRuntimeClient;

const preflightMachineName = localMachineName(
  'ac-local-',
  'preflight',
  'preflight-test',
);
const preflightKeypair = {
  publicKey: 'ssh-ed25519 preflight-public-key anycloud',
  privateKey:
    '-----BEGIN OPENSSH PRIVATE KEY-----\npreflight\n-----END OPENSSH PRIVATE KEY-----',
};
const notFound = new SmolvmServeError('not found', 404, {
  error: 'machine not found',
});
const transportExec = vi
  .fn()
  .mockResolvedValue({ code: 0, stdout: 'ok', stderr: '' });
const localTransport: ReturnType<LocalTransportFactory> = {
  exec: transportExec,
  execStream: vi.fn(),
  writeFile: vi.fn(),
  ping: vi.fn().mockResolvedValue(true),
};
const transportFactory: LocalTransportFactory = vi.fn(() => localTransport);

const cloudConfig: CloudConfig = {
  cloudProvider: CloudType.Local,
  region: 'local',
  vmType: 'local',
};

const newVMProps: NewVMProps = {
  workloadId: 'dep-1',
  vmId: 'dep-1-0',
  ipWhitelist: [],
  startupScript: '#!/bin/bash\necho production-startup',
  version: '0.1.57-test',
  userId: 'user-1',
};
const healthySmolvmResponse = JSON.stringify({
  status: 'ok',
  version: LOCAL_SMOLVM_CONTRACT.supportedVersion,
});

function makeClient(overrides: Partial<FakeClient> = {}): FakeClient {
  const machines = new Map<
    string,
    { name: string; state: string; ports: { host: number; guest: number }[] }
  >();
  const machine = (name: string, host = 2222) => ({
    name,
    state: 'running',
    ports: [{ host, guest: 22 }],
  });
  return {
    health: vi.fn().mockResolvedValue(healthySmolvmResponse),
    listMachines: vi.fn().mockResolvedValue([]),
    createMachine: vi.fn(async (request) => {
      const created = {
        name: request.name,
        state: 'created',
        ports: request.ports ?? [],
      };
      machines.set(request.name, created);
      return created;
    }),
    startMachine: vi.fn(async (name) => machines.get(name) ?? machine(name)),
    execMachine: vi
      .fn()
      .mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    stopMachine: vi.fn(async (name) => machine(name)),
    deleteMachine: vi.fn(async (name) => {
      machines.delete(name);
    }),
    getMachine: vi.fn(async (name) => {
      if (name === preflightMachineName) throw notFound;
      return machines.get(name) ?? machine(name);
    }),
    ...overrides,
  };
}

function makeRuntime(client = makeClient()): LocalSmolvmRuntime {
  return {
    client,
    config: {
      baseUrl: 'http://127.0.0.1:4545',
      sidecarPath: '/var/lib/anycloud-test/local/runner-cow-v1.smolmachine',
      sshHost: 'localhost',
      sshUsername: 'root',
      machinePrefix: 'ac-local-',
      networkBackend: 'virtio-net',
      requestTimeoutMs: 30_000,
      provisionTimeoutMs: 180_000,
      setupTimeoutSecs: 120,
      bucketHostPath: '/var/lib/anycloud-test/local/buckets',
      cpus: 2,
      memoryMb: 2048,
      overlayGb: 8,
      storageGb: 16,
    },
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeDefaultRuntimeFetch() {
  let currentMachine:
    | {
        name: string;
        state: string;
        ports: Array<{ host: number; guest: number }>;
      }
    | undefined;
  let deleted = false;

  return vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(String(input));
    const method = init?.method ?? 'GET';

    if (method === 'GET' && url.pathname === '/health') {
      return jsonResponse({
        status: 'ok',
        version: LOCAL_SMOLVM_CONTRACT.supportedVersion,
      });
    }
    if (method === 'POST' && url.pathname === '/api/v1/machines') {
      const request = JSON.parse(String(init?.body)) as {
        name: string;
        ports: Array<{ host: number; guest: number }>;
      };
      currentMachine = {
        name: request.name,
        state: 'stopped',
        ports: request.ports,
      };
      deleted = false;
      return jsonResponse(currentMachine);
    }
    if (method === 'POST' && url.pathname.endsWith('/start')) {
      currentMachine = {
        name: currentMachine?.name ?? 'missing',
        state: 'running',
        ports: currentMachine?.ports ?? [],
      };
      return jsonResponse(currentMachine);
    }
    if (method === 'POST' && url.pathname.endsWith('/exec')) {
      return jsonResponse({ exitCode: 0, stdout: '', stderr: '' });
    }
    if (method === 'POST' && url.pathname.endsWith('/stop')) {
      return jsonResponse(currentMachine);
    }
    if (method === 'DELETE' && url.pathname.startsWith('/api/v1/machines/')) {
      deleted = true;
      return new Response(null, { status: 204 });
    }
    if (method === 'GET' && url.pathname.startsWith('/api/v1/machines/')) {
      return deleted
        ? jsonResponse({ error: 'machine not found' }, 404)
        : jsonResponse(currentMachine);
    }

    return jsonResponse({ error: `unexpected ${method} ${url.pathname}` }, 500);
  });
}

function makeLocal(
  client = makeClient(),
  workloadPortAllocator?: () => number,
): Local {
  return new Local(completeCloudConfig(cloudConfig), {
    runtime: makeRuntime(client),
    keypairFactory: () => preflightKeypair,
    preflightIdFactory: () => 'preflight-test',
    transportFactory,
    ...(workloadPortAllocator ? { workloadPortAllocator } : {}),
  });
}

beforeEach(() => {
  vi.useRealTimers();
  transportExec.mockClear();
  vi.mocked(transportFactory).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Local smolvm gateway', () => {
  it('uses the fixed runtime without test mode or runtime injection', async () => {
    const fetch = makeDefaultRuntimeFetch();
    vi.stubGlobal('fetch', fetch);
    const local = new Local(completeCloudConfig(cloudConfig), {
      keypairFactory: () => preflightKeypair,
      preflightIdFactory: () => 'default-runtime',
      transportFactory,
    });

    await expect(
      local.compute().validateCredentials(),
    ).resolves.toBeUndefined();

    const createCall = fetch.mock.calls.find(([input, init]) => {
      const url = input instanceof URL ? input : new URL(String(input));
      return init?.method === 'POST' && url.pathname === '/api/v1/machines';
    });
    expect(createCall).toBeDefined();
    expect(new URL(String(fetch.mock.calls[0][0])).origin).toBe(
      'http://127.0.0.1:18089',
    );
    expect(JSON.parse(String(createCall?.[1]?.body))).toMatchObject({
      from: '/var/lib/anycloud-test/local/runner-cow-v1.smolmachine',
      cpus: 1,
      memoryMb: 512,
    });
  });

  it('reports the fixed Local capability as unavailable when smolvm is absent', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED'));
    vi.stubGlobal('fetch', fetch);
    const local = new Local(completeCloudConfig(cloudConfig));

    await expect(local.compute().validateCredentials()).rejects.toThrow(
      /Local compute is unavailable on this API server.*ECONNREFUSED/,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('preflights the prepared image, production startup script, SSH, and deletion', async () => {
    const client = makeClient();
    await runLocalSmolvmPreflight(makeRuntime(client), {
      keypairFactory: () => preflightKeypair,
      machineName: preflightMachineName,
      transportFactory,
    });

    expect(client.health).toHaveBeenCalled();
    expect(client.createMachine).toHaveBeenCalledWith(
      expect.objectContaining({
        name: preflightMachineName,
        from: '/var/lib/anycloud-test/local/runner-cow-v1.smolmachine',
        ports: [{ host: expect.any(Number), guest: 22 }],
        mounts: [
          {
            source: '/var/lib/anycloud-test/local/buckets',
            target: '/var/lib/anycloud/buckets',
            readonly: false,
          },
        ],
      }),
    );
    expect(client.execMachine).toHaveBeenCalledWith(
      preflightMachineName,
      expect.objectContaining({
        command: ['/bin/bash', '-s'],
        stdin: expect.stringContaining(preflightKeypair.publicKey),
      }),
    );
    expect(transportExec).toHaveBeenCalledWith(
      expect.stringContaining(LOCAL_SMOLVM_CONTRACT.runnerVersion),
      6,
      false,
      10_000,
    );
    expect(client.deleteMachine).toHaveBeenCalledWith(
      preflightMachineName,
      true,
    );
  });

  it('pins the supported smolvm version', async () => {
    const client = makeClient({
      health: vi
        .fn()
        .mockResolvedValue(JSON.stringify({ status: 'ok', version: '1.2.1' })),
    });
    await expect(
      runLocalSmolvmPreflight(makeRuntime(client), {
        keypairFactory: () => preflightKeypair,
        machineName: preflightMachineName,
        transportFactory,
      }),
    ).rejects.toThrow(
      `Expected smolvm ${LOCAL_SMOLVM_CONTRACT.supportedVersion}`,
    );
    expect(client.createMachine).not.toHaveBeenCalled();
  });

  it('rechecks health while caching a successful smoke preflight', async () => {
    const client = makeClient();
    const local = makeLocal(client);
    await local.compute().validateCredentials();
    await local.compute().validateCredentials();
    expect(client.health).toHaveBeenCalledTimes(3);
    expect(client.createMachine).toHaveBeenCalledTimes(1);
  });

  it('expires the smoke-preflight cache', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const client = makeClient();
    const local = makeLocal(client);
    await local.compute().validateCredentials();
    vi.advanceTimersByTime(LOCAL_RUNTIME_PREFLIGHT_CACHE_TTL_MS + 1);
    await local.compute().validateCredentials();
    expect(client.createMachine).toHaveBeenCalledTimes(2);
  });

  it('cold-creates a sidecar-backed VM and returns mapped SSH facts', async () => {
    const client = makeClient();
    const allocatePort = vi.fn(() => 21_001);
    const vm = await makeLocal(client, allocatePort)
      .compute()
      .newVM(newVMProps);
    const machineName = localMachineName('ac-local-', 'dep-1', 'dep-1-0');
    const request = client.createMachine.mock.calls.find(
      ([candidate]) => candidate.name === machineName,
    )?.[0];
    expect(request).toEqual({
      name: machineName,
      from: '/var/lib/anycloud-test/local/runner-cow-v1.smolmachine',
      network: true,
      networkBackend: 'virtio-net',
      ports: [{ host: 21_001, guest: 22 }],
      mounts: [
        {
          source: '/var/lib/anycloud-test/local/buckets',
          target: '/var/lib/anycloud/buckets',
          readonly: false,
        },
      ],
      cpus: 2,
      memoryMb: 2048,
      overlayGb: 8,
      storageGb: 16,
    });
    expect(vm).toEqual({
      cloudId: machineName,
      ip: 'localhost',
      sshHost: 'localhost',
      sshPort: request.ports[0].host,
      sshUsername: 'root',
      region: 'local',
    });
    expect(allocatePort).toHaveBeenCalledOnce();
  });

  it('delivers the shared startup script verbatim through smolvm stdin', async () => {
    const client = makeClient();
    const script = '#!/bin/bash\nprintf \'%s\\n\' "shared startup"';
    const machineName = localMachineName('ac-local-', 'dep-1', 'dep-1-0');

    await makeLocal(client)
      .compute()
      .newVM({ ...newVMProps, startupScript: script });

    const workloadExecs = client.execMachine.mock.calls.filter(
      ([name]) => name === machineName,
    );
    expect(workloadExecs).toEqual([
      [
        machineName,
        {
          command: ['/bin/bash', '-s'],
          stdin: script,
          timeoutSecs: 120,
        },
      ],
    ]);
  });

  it('rejects an empty startup script before touching smolvm', async () => {
    const client = makeClient();

    await expect(
      makeLocal(client)
        .compute()
        .newVM({ ...newVMProps, startupScript: '   ' }),
    ).rejects.toThrow('Local compute requires a VM startup script');

    expect(client.health).not.toHaveBeenCalled();
  });

  it('maps distinct SSH and HTTP ports for Serve ingress', async () => {
    const client = makeClient();
    const allocatePort = vi
      .fn<() => number>()
      .mockReturnValueOnce(21_011)
      .mockReturnValueOnce(21_012);
    const machineName = localMachineName('ac-local-', 'dep-1', 'dep-1-0');

    await makeLocal(client, allocatePort)
      .compute()
      .newVM({ ...newVMProps, ingressSpec: buildServeIngressSpec() });

    const request = client.createMachine.mock.calls.find(
      ([candidate]) => candidate.name === machineName,
    )?.[0];
    expect(request?.ports).toEqual([
      { host: 21_011, guest: 22 },
      { host: 21_012, guest: 80 },
    ]);
    expect(allocatePort).toHaveBeenCalledTimes(2);
  });

  it('redraws the whole Serve mapping after a structured host-port conflict', async () => {
    let workloadStarts = 0;
    const client = makeClient({
      startMachine: vi.fn(async (name) => {
        if (name === preflightMachineName) {
          return {
            name,
            state: 'running',
            ports: [{ host: 2222, guest: 22 }],
          };
        }
        workloadStarts += 1;
        if (workloadStarts === 1) {
          throw new SmolvmServeError('start rejected', 409, {
            error: 'published host port is already in use',
            code: 'PORT_IN_USE',
          });
        }
        return {
          name,
          state: 'running',
          ports: [
            { host: 21_103, guest: 22 },
            { host: 21_104, guest: 80 },
          ],
        };
      }),
    });
    const allocatePort = vi
      .fn<() => number>()
      .mockReturnValueOnce(21_101)
      .mockReturnValueOnce(21_102)
      .mockReturnValueOnce(21_103)
      .mockReturnValueOnce(21_104);

    await expect(
      makeLocal(client, allocatePort)
        .compute()
        .newVM({ ...newVMProps, ingressSpec: buildServeIngressSpec() }),
    ).resolves.toEqual(expect.objectContaining({ sshPort: 21_103 }));
    const machineName = localMachineName('ac-local-', 'dep-1', 'dep-1-0');
    const workloadCreates = client.createMachine.mock.calls.filter(
      ([request]) => request.name === machineName,
    );
    expect(workloadCreates).toHaveLength(2);
    expect(workloadCreates.map(([request]) => request.ports)).toEqual([
      [
        { host: 21_101, guest: 22 },
        { host: 21_102, guest: 80 },
      ],
      [
        { host: 21_103, guest: 22 },
        { host: 21_104, guest: 80 },
      ],
    ]);
    // The smoke preflight allocates independently; these four calls are the
    // two complete workload pairs and nothing else.
    expect(allocatePort).toHaveBeenCalledTimes(4);
    expect(client.deleteMachine).toHaveBeenCalledWith(machineName, true);
  });

  it('allocates one new Job port per smolvm retry', async () => {
    let workloadStarts = 0;
    const client = makeClient({
      startMachine: vi.fn(async (name) => {
        if (name === preflightMachineName) {
          return {
            name,
            state: 'running',
            ports: [{ host: 2222, guest: 22 }],
          };
        }
        workloadStarts += 1;
        if (workloadStarts === 1) {
          throw new SmolvmServeError('start rejected', 409, {
            code: 'PORT_IN_USE',
          });
        }
        return {
          name,
          state: 'running',
          ports: [{ host: 21_202, guest: 22 }],
        };
      }),
    });
    const allocatePort = vi
      .fn<() => number>()
      .mockReturnValueOnce(21_201)
      .mockReturnValueOnce(21_202);

    await makeLocal(client, allocatePort).compute().newVM(newVMProps);

    const machineName = localMachineName('ac-local-', 'dep-1', 'dep-1-0');
    const workloadCreates = client.createMachine.mock.calls.filter(
      ([request]) => request.name === machineName,
    );
    expect(workloadCreates.map(([request]) => request.ports)).toEqual([
      [{ host: 21_201, guest: 22 }],
      [{ host: 21_202, guest: 22 }],
    ]);
    expect(allocatePort).toHaveBeenCalledTimes(2);
  });

  it('bounds duplicate Serve port draws from a deterministic allocator', async () => {
    const client = makeClient();
    const allocatePort = vi.fn(() => 21_301);

    await expect(
      makeLocal(client, allocatePort)
        .compute()
        .newVM({ ...newVMProps, ingressSpec: buildServeIngressSpec() }),
    ).rejects.toThrow(
      'could not allocate distinct SSH and HTTP host ports after 8 draws',
    );

    const machineName = localMachineName('ac-local-', 'dep-1', 'dep-1-0');
    expect(allocatePort).toHaveBeenCalledTimes(16);
    expect(
      client.createMachine.mock.calls.filter(
        ([request]) => request.name === machineName,
      ),
    ).toHaveLength(0);
  });

  it('rejects an invalid allocated host port without a smolvm retry', async () => {
    const client = makeClient();
    const allocatePort = vi.fn(() => 0);

    await expect(
      makeLocal(client, allocatePort).compute().newVM(newVMProps),
    ).rejects.toThrow('host port allocator returned invalid port 0');

    const machineName = localMachineName('ac-local-', 'dep-1', 'dep-1-0');
    expect(allocatePort).toHaveBeenCalledOnce();
    expect(
      client.createMachine.mock.calls.filter(
        ([request]) => request.name === machineName,
      ),
    ).toHaveLength(0);
  });

  it('deletes the VM when the startup script fails', async () => {
    const client = makeClient({
      execMachine: vi.fn(async (name, request) => {
        if (name === preflightMachineName || request.command[0] === '/bin/sh') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        throw new Error('sshd failed');
      }),
    });
    await expect(makeLocal(client).compute().newVM(newVMProps)).rejects.toThrow(
      'sshd failed',
    );
    const machineName = localMachineName('ac-local-', 'dep-1', 'dep-1-0');
    expect(client.stopMachine).toHaveBeenCalledWith(machineName);
    expect(client.deleteMachine).toHaveBeenCalledWith(machineName, true);
  });

  it('carries the provider machine name as the rollback cleanup target', async () => {
    const client = makeClient({
      execMachine: vi.fn(async (name, request) => {
        if (name === preflightMachineName || request.command[0] === '/bin/sh') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        throw new Error('sshd failed');
      }),
    });
    const machineName = localMachineName('ac-local-', 'dep-1', 'dep-1-0');
    await expect(
      makeLocal(client).compute().newVM(newVMProps),
    ).rejects.toMatchObject({
      name: 'VMCreationError',
      attemptedVmIds: [machineName],
    });
  });

  it('keeps the smoke preflight cached across per-VM startup failures', async () => {
    const client = makeClient({
      execMachine: vi.fn(async (name, request) => {
        if (name === preflightMachineName || request.command[0] === '/bin/sh') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        throw new SmolvmServeError('startup script rejected', 400, {
          error: 'bad request',
        });
      }),
    });
    const local = makeLocal(client);
    await expect(local.compute().newVM(newVMProps)).rejects.toThrow();
    await expect(local.compute().newVM(newVMProps)).rejects.toThrow();

    expect(
      client.createMachine.mock.calls.filter(
        ([request]) => request.name === preflightMachineName,
      ),
    ).toHaveLength(1);
  });

  it('re-runs the smoke preflight when smolvm itself is unreachable', async () => {
    const client = makeClient({
      execMachine: vi.fn(async (name, request) => {
        if (name === preflightMachineName || request.command[0] === '/bin/sh') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        throw new SmolvmServeError('smolvm serve request failed', null, null);
      }),
    });
    const local = makeLocal(client);
    await expect(local.compute().newVM(newVMProps)).rejects.toThrow();
    await expect(local.compute().newVM(newVMProps)).rejects.toThrow();

    expect(
      client.createMachine.mock.calls.filter(
        ([request]) => request.name === preflightMachineName,
      ),
    ).toHaveLength(2);
  });

  // A busy host is not a sick service. Dropping the shared preflight over our
  // own expired deadline makes the next workload boot an extra smoke VM at
  // exactly the moment the host is already saturated.
  it('keeps the smoke preflight cached when a call hits its own deadline', async () => {
    const client = makeClient({
      execMachine: vi.fn(async (name, request) => {
        if (name === preflightMachineName || request.command[0] === '/bin/sh') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        throw new SmolvmServeError(
          'smolvm serve request failed: This operation was aborted',
          null,
          null,
          true,
        );
      }),
    });
    const local = makeLocal(client);
    await expect(local.compute().newVM(newVMProps)).rejects.toThrow();
    await expect(local.compute().newVM(newVMProps)).rejects.toThrow();

    expect(
      client.createMachine.mock.calls.filter(
        ([request]) => request.name === preflightMachineName,
      ),
    ).toHaveLength(1);
  });

  // A loaded host can fail the shared smoke preflight for every waiting
  // workload at once; that must be retried, and must not stick in the cache.
  it.each([
    new SmolvmServeError(
      'smolvm serve POST start failed with HTTP 500: agent did not become ready within 30 seconds',
      500,
      null,
    ),
    new SmolvmServeError('smolvm serve request failed', null, null, true),
    // Concurrent VM starts on a busy host race for the same host resources.
    new SmolvmServeError(
      'smolvm serve POST /api/v1/machines/ac-local-preflight-1/start failed with HTTP 409: failed to start machine: agent operation failed: monitor agent: agent operation failed: configure virtio-net: failed to start virtio network runtime: Address already in use (os error 98)',
      409,
      null,
    ),
    new SmolvmServeError('start rejected', 409, {
      error: 'published host port is already in use',
      code: 'PORT_IN_USE',
    }),
  ])('retries a transient smoke-preflight failure: $message', async (error) => {
    const startMachine = vi.fn().mockRejectedValueOnce(error);
    const client = makeClient();
    startMachine.mockImplementation(client.startMachine);
    client.startMachine = startMachine;
    const local = makeLocal(client);

    const failure = await local
      .compute()
      .newVM(newVMProps)
      .catch((e: unknown) => e);
    expect(String(failure)).toContain('temporarily unavailable');
    expect(local.compute().classifyError(failure)).toBe(
      CloudFailureDiagnosis.TemporaryProviderFailure,
    );

    await expect(local.compute().newVM(newVMProps)).resolves.toBeDefined();
    expect(
      client.createMachine.mock.calls.filter(
        ([request]) => request.name === preflightMachineName,
      ),
    ).toHaveLength(2);
  });

  it.each([
    [
      'startMachine',
      vi
        .fn()
        .mockRejectedValue(
          new SmolvmServeError(
            'HTTP 500: /dev/kvm is not available',
            500,
            null,
          ),
        ),
    ],
    [
      'execMachine',
      vi.fn().mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'broken' }),
    ],
  ])(
    'keeps a deterministic preflight failure invalid: %s',
    async (method, mock) => {
      const local = makeLocal(makeClient({ [method]: mock }));

      const failure = await local
        .compute()
        .newVM(newVMProps)
        .catch((e: unknown) => e);
      expect(String(failure)).toContain('Local compute is unavailable');
      expect(local.compute().classifyError(failure)).toBe(
        CloudFailureDiagnosis.InvalidRequest,
      );
    },
  );

  it('reports authoritative missing-machine termination', async () => {
    const client = makeClient({
      getMachine: vi.fn().mockRejectedValue(notFound),
      stopMachine: vi.fn().mockRejectedValue(notFound),
      deleteMachine: vi.fn().mockRejectedValue(notFound),
    });
    const local = new Local(completeCloudConfig(cloudConfig), {
      runtime: makeRuntime(client),
    });
    const compute = local.compute();
    await expect(compute.observeVMReleaseOnce('missing')).resolves.toEqual({
      state: VMReleaseState.Candidate,
    });
    await expect(compute.terminateVMs(['missing'])).resolves.toEqual([
      'missing',
    ]);
  });

  it.each([
    ['stopped', VMReleaseState.Candidate],
    ['failed', VMReleaseState.Candidate],
    ['running', VMReleaseState.Present],
    ['unreachable', VMReleaseState.Present],
  ])('observes a %s machine as %s', async (state, expected) => {
    const client = makeClient({
      getMachine: vi.fn().mockResolvedValue({ name: 'ac-local-vm', state }),
    });
    const compute = makeLocal(client).compute();

    await expect(compute.observeVMReleaseOnce('ac-local-vm')).resolves.toEqual({
      state: expected,
    });
  });

  it('lists only owned machines and age-guards orphan cleanup', async () => {
    // smolvm reports creation time as a number or a string, in seconds or
    // milliseconds; every form has to resolve to the same epoch milliseconds.
    const freshSeconds = Math.floor(Date.now() / 1000);
    const client = makeClient({
      listMachines: vi.fn().mockResolvedValue([
        {
          name: 'ac-local-old',
          state: 'running',
          createdAt: '1',
          ports: [{ host: 2222, guest: 22 }],
        },
        {
          name: 'ac-local-new',
          state: 'running',
          createdAt: freshSeconds,
          ports: [{ host: 2223, guest: 22 }],
        },
        { name: 'other-old', state: 'running', createdAt: 1 },
      ]),
    });
    const local = new Local(completeCloudConfig(cloudConfig), {
      runtime: makeRuntime(client),
    });
    const compute = local.compute();

    await expect(compute.getAllVMs()).resolves.toEqual([
      {
        cloudId: 'ac-local-old',
        createdAt: 1_000,
        ip: 'localhost',
        region: 'local',
        sshPort: 2222,
      },
      {
        cloudId: 'ac-local-new',
        createdAt: freshSeconds * 1000,
        ip: 'localhost',
        region: 'local',
        sshPort: 2223,
      },
    ]);
    await expect(
      local.sweeper().sweepResources({
        ...TEST_RESOURCE_SWEEP_OPTIONS,
        dryRun: true,
      }),
    ).resolves.toEqual({
      vmIds: ['ac-local-old'],
      otherResources: [],
      errors: [],
    });
    expect(client.deleteMachine).not.toHaveBeenCalled();
  });

  it('accepts exactly SSH with optional HTTP and publishes no endpoint', async () => {
    const compute = new Local(completeCloudConfig(cloudConfig), {
      runtime: makeRuntime(),
    }).compute();
    expect(canSupportIngress(compute)).toBe(true);
    if (!canSupportIngress(compute)) throw new Error('missing ingress support');

    const supported = [buildJobIngressSpec(), buildServeIngressSpec()];
    for (const spec of supported) {
      expect(compute.supportsIngress(spec)).toBe(true);
      await expect(
        compute.prepareNetwork?.(spec, 'dep-1', '0.1.57-test', 'user-1'),
      ).resolves.toBeUndefined();
    }

    const unsupported = [
      { ingress: [] },
      {
        ingress: [{ protocol: 'tcp', port: 80, sourceRanges: ['0.0.0.0/0'] }],
      },
      {
        ingress: [
          { protocol: 'tcp', port: 22, sourceRanges: ['0.0.0.0/0'] },
          { protocol: 'tcp', port: 22, sourceRanges: ['10.0.0.0/8'] },
        ],
      },
      {
        ingress: [
          { protocol: 'tcp', port: 22, sourceRanges: ['0.0.0.0/0'] },
          { protocol: 'tcp', port: 443, sourceRanges: ['0.0.0.0/0'] },
        ],
      },
      {
        ingress: [{ protocol: 'udp', port: 22, sourceRanges: [] }],
      },
      {
        ingress: [{ protocol: 'tcp', port: 22 }],
      },
    ] as unknown as IngressSpec[];
    for (const spec of unsupported) {
      expect(compute.supportsIngress(spec)).toBe(false);
      await expect(
        compute.prepareNetwork?.(spec, 'dep-1', '0.1.57-test', 'user-1'),
      ).rejects.toThrow(
        'Local does not support service workloads with public HTTP ingress',
      );
    }

    expect(compute.publishesPublicEndpoint?.()).toBe(false);
  });

  it('guards direct VM creation with the same ingress predicate', async () => {
    const client = makeClient();
    const httpOnly: IngressSpec = {
      ingress: [{ protocol: 'tcp', port: 80, sourceRanges: ['0.0.0.0/0'] }],
    };

    await expect(
      makeLocal(client)
        .compute()
        .newVM({ ...newVMProps, ingressSpec: httpOnly }),
    ).rejects.toThrow(
      'Local does not support service workloads with public HTTP ingress',
    );
    expect(client.health).not.toHaveBeenCalled();
  });

  it('sanitizes and bounds machine names without losing VM indexes', () => {
    expect(localMachineName('ac-local-', 'Dep_One', 'VM.0')).toBe(
      'ac-local-dep-one-vm-0',
    );
    const workloadId = 'workload-with-a-very-long-name-that-will-be-truncated';
    const first = localMachineName('ac-local-', workloadId, `${workloadId}-0`);
    const second = localMachineName('ac-local-', workloadId, `${workloadId}-1`);
    expect(first).not.toBe(second);
    expect(first.length).toBeLessThanOrEqual(63);
  });

  it('is idempotent when a retargeted attempt replays the machine name', () => {
    const machineName = localMachineName('ac-local-', 'dep-1', 'dep-1-0');
    expect(localMachineName('ac-local-', 'dep-1', machineName)).toBe(
      machineName,
    );
  });
});

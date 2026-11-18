import { describe, expect, test, vi } from 'vitest';

import { CloudType } from '../../src/shared/cloud.js';
import { WorkloadState, WorkloadType } from '../../src/shared/workload.js';
import { WorkloadHealthStatus } from '../../src/shared/runtime.js';
import type { ApiClient } from '../integration/e2e/internal/api.js';
import { CleanupStack } from '../integration/e2e/internal/cleanup.js';
import type { VmProfile } from '../integration/e2e/internal/profiles.js';
import type { PersistentVmCleanup } from '../integration/e2e/internal/persistent-vm-cleanup.js';
import { ServiceCleanup } from '../integration/e2e/internal/service-cleanup.js';
import { SecretManager } from '../integration/e2e/internal/secrets.js';
import type { ServeDnsAbsenceObservation } from '../integration/e2e/internal/targets/serve-types.js';
import type { WaitOptions } from '../integration/e2e/internal/wait.js';
import type { TrackedWorkloadRef } from '../integration/e2e/internal/workloads.js';
import { trackedWorkloadRefForTest } from './helpers/e2e.js';
import { persistentVmWorkload } from './helpers/persistent-vm-fixture.js';
import {
  ServiceDnsProbe,
  ServiceDnsTransport,
} from '../integration/e2e/internal/transports/service-dns.js';

const HOSTNAME = 'service-one.anycloud.sh';
const AUTHORITIES = [
  { authority: 'one.ns.example', address: '192.0.2.1' },
  { authority: 'two.ns.example', address: '192.0.2.2' },
];

function dnsError(
  code: string,
  hostname = HOSTNAME,
  syscall = 'queryA',
): Error {
  return Object.assign(new Error(`${syscall} ${code} ${hostname}`), {
    code,
    hostname,
    syscall,
  });
}

describe('Service authoritative DNS absence', () => {
  test('queries every authority for the exact hostname without fallback', async () => {
    const queries: unknown[] = [];
    const probe = new ServiceDnsProbe({
      authorities: async () => AUTHORITIES,
      addressesAt: async (hostname, authority) => {
        queries.push({ hostname, authority });
        throw dnsError('ENOTFOUND', hostname);
      },
    });
    await expect(probe.observe(HOSTNAME)).resolves.toMatchObject({
      hostname: HOSTNAME,
      authorities: ['one.ns.example', 'two.ns.example'],
      answers: [{ presence: 'absent' }, { presence: 'absent' }],
    });
    expect(queries).toEqual(
      AUTHORITIES.map((authority) => ({ hostname: HOSTNAME, authority })),
    );
  });

  test.each(['ENODATA', 'ETIMEOUT', 'ESERVFAIL', 'EREFUSED', 'ECANCELLED'])(
    'retains unknown presence for %s',
    async (code) => {
      const probe = new ServiceDnsProbe({
        authorities: async () => AUTHORITIES,
        addressesAt: async () => {
          throw dnsError(code);
        },
      });
      expect(
        (await probe.observe(HOSTNAME)).answers.map(
          (answer) => answer.presence,
        ),
      ).toEqual(['unknown', 'unknown']);
    },
  );

  test.each([
    dnsError('ENOTFOUND', 'another.anycloud.sh'),
    dnsError('ENOTFOUND', HOSTNAME, 'getaddrinfo'),
    new Error('HTTP endpoint unavailable'),
  ])('rejects unrelated lookup failure as DNS absence: %s', async (failure) => {
    const probe = new ServiceDnsProbe({
      authorities: async () => AUTHORITIES,
      addressesAt: async () => {
        throw failure;
      },
    });
    expect(
      (await probe.observe(HOSTNAME)).answers.every(
        (answer) => answer.presence === 'unknown',
      ),
    ).toBe(true);
  });

  test('keeps a positive answer from one authority visible', async () => {
    const probe = new ServiceDnsProbe({
      authorities: async () => AUTHORITIES,
      addressesAt: async (_hostname, authority) => {
        if (authority.address === '192.0.2.1') return ['203.0.113.1'];
        throw dnsError('ENOTFOUND');
      },
    });
    expect(
      (await probe.observe(HOSTNAME)).answers.map((answer) => answer.presence),
    ).toEqual(['present', 'absent']);
  });

  test('cannot turn an empty A answer into a negative answer', async () => {
    const probe = new ServiceDnsProbe({
      authorities: async () => AUTHORITIES,
      addressesAt: async () => [],
    });
    expect(
      (await probe.observe(HOSTNAME)).answers.map((answer) => answer.presence),
    ).toEqual(['unknown', 'unknown']);
  });

  test.each([
    { authorities: [] },
    { authorities: [AUTHORITIES[0]!, AUTHORITIES[0]!] },
  ])(
    'rejects an incomplete authority inventory %j',
    async ({ authorities }) => {
      const probe = new ServiceDnsProbe({
        authorities: async () => authorities,
        addressesAt: async () => {
          throw dnsError('ENOTFOUND');
        },
      });
      await expect(probe.observe(HOSTNAME)).rejects.toThrow(
        'distinct delegated authorities',
      );
    },
  );

  test('rejects foreign hostnames and failed delegation discovery', async () => {
    const probe = new ServiceDnsProbe({
      authorities: async () => {
        throw new Error('delegation failed');
      },
      addressesAt: async () => [],
    });
    await expect(probe.observe('service-one.other.example')).rejects.toThrow(
      'exact anycloud.sh hostname',
    );
    await expect(probe.observe(HOSTNAME)).rejects.toThrow('delegation failed');
  });

  test('foreground cancellation cannot start a DNS query', async () => {
    const controller = new AbortController();
    const failure = new Error('foreground cancelled');
    controller.abort(failure);
    const transport = new ServiceDnsTransport(controller.signal);
    await expect(transport.authorities(Date.now() + 1_000)).rejects.toBe(
      failure,
    );
    await expect(
      transport.addressesAt(HOSTNAME, AUTHORITIES[0]!, Date.now() + 1_000),
    ).rejects.toBe(failure);
  });

  test('one absolute deadline covers delegation and every authoritative query', async () => {
    const deadlines: number[] = [];
    const deadlineAt = Date.now() + 100;
    const probe = new ServiceDnsProbe({
      authorities: async (deadline) => {
        deadlines.push(deadline);
        return AUTHORITIES;
      },
      addressesAt: async (hostname, _authority, deadline) => {
        deadlines.push(deadline);
        throw dnsError('ENOTFOUND', hostname);
      },
    });
    await probe.observe(HOSTNAME, deadlineAt);
    expect(deadlines).toEqual([deadlineAt, deadlineAt, deadlineAt]);
    const transport = new ServiceDnsTransport(new AbortController().signal);
    await expect(transport.authorities(Date.now() - 1)).rejects.toThrow(
      'deadline expired',
    );
  });
});

describe('Service native cleanup composition', () => {
  const selected: VmProfile = {
    slug: 'aws',
    provider: CloudType.AWS,
    credentialName: 'aws-test',
    credential: {
      cloudProvider: CloudType.AWS,
      accessKeyId: 'access',
      secretAccessKey: 'private-value',
    },
    vmTypes: ['g6e.xlarge'],
    diskSizeGb: 100,
  };
  const adapter = {
    provider: 'aws',
    credentialName: selected.credentialName,
    vmTypes: selected.vmTypes,
    diskSizeGb: 100,
    gpus: 'all',
  } as const;
  const target = { kind: 'public-cloud', provider: 'aws' } as const;
  function harness(
    dnsOverride?: Partial<ServeDnsAbsenceObservation>,
    artifactFailure?: Error,
    bundleFailure?: Error,
  ) {
    const ref = trackedWorkloadRefForTest('service-one');
    const receipts: unknown[] = [];
    const lookupStatus = vi.fn<ApiClient['lookupStatus']>(
      async (id, verbose, deadlineAt) => {
        expect(id).toBe(ref.id);
        expect(verbose).toBe(true);
        expect(deadlineAt).toBeGreaterThan(Date.now());
        return {
          kind: 'found',
          status: {
            workload: persistentVmWorkload(ref.id, {
              workloadType: WorkloadType.Service,
              state: WorkloadState.Terminated,
              completedAt: 20,
              cleanedAt: 30,
            }),
            events: [],
            status: WorkloadHealthStatus.Down,
            vms: [],
          },
        };
      },
    );
    const deleteForCleanup = vi.fn(
      async (_name: string, deadlineAt?: number) => {
        expect(deadlineAt).toBeGreaterThan(Date.now());
        if (bundleFailure) throw bundleFailure;
      },
    );
    let verifier:
      | ((ref: TrackedWorkloadRef, deadline: number) => Promise<void>)
      | undefined;
    const reserveWithProfile = vi.fn<PersistentVmCleanup['reserveWithProfile']>(
      async (_target, _id, _timeout, profile, verify) => {
        expect(profile).toEqual({ ...selected, gpus: 'all' });
        verifier = verify;
        return ref;
      },
    );
    const owner = new ServiceCleanup({
      cleanupApi: { lookupStatus },
      namedBundles: { deleteForCleanup },
      native: { reserveWithProfile },
      profiles: {
        serve: () => {
          throw new Error('CPU profile selected');
        },
        gpuServe: () => ({ ...selected, gpus: 'all' }),
      },
      dns: {
        observe: async (hostname, deadlineAt) => {
          expect(deadlineAt).toBeGreaterThan(Date.now());
          return {
            hostname,
            authorities: AUTHORITIES.map((server) => server.authority),
            answers: AUTHORITIES.map((server) => ({
              ...server,
              presence: 'absent' as const,
              diagnostic: 'NXDOMAIN',
            })),
            ...dnsOverride,
          };
        },
      },
      local: {
        observeAbsent: async () => {
          throw new Error('unexpected Local read');
        },
      },
      artifacts: {
        json: async (_name, value) => {
          receipts.push(value);
          if (artifactFailure) throw artifactFailure;
          return '/tmp/service-cleanup.json';
        },
      },
      wait: {
        for: async <T>(
          _label: string,
          probe: (deadlineAt: number) => Promise<T>,
          options: WaitOptions<T>,
        ): Promise<T> => {
          const value = await probe(Date.now() + options.timeoutMs);
          const unmet = options.unmet(value);
          if (unmet !== undefined) throw new Error(unmet);
          return value;
        },
      },
    });
    return {
      owner,
      receipts,
      reserveWithProfile,
      deleteForCleanup,
      lookupStatus,
      verify: async () => {
        if (!verifier) throw new Error('Service verifier was not registered');
        await verifier(ref, Date.now() + 1_000);
      },
    };
  }

  test('registers the exact GPU profile with native cleanup before proving authoritative DNS absence', async () => {
    const h = harness();
    await h.owner.reserve(target, adapter, 'service-one', 1_000);
    expect(h.reserveWithProfile).toHaveBeenCalledTimes(1);
    await h.verify();
    expect(h.receipts).toEqual([
      expect.objectContaining({
        workloadId: 'service-one',
        target,
        completed: true,
      }),
    ]);
  });

  test.each([
    { id: 'foreign' },
    { workloadType: WorkloadType.Job },
    { state: WorkloadState.Running },
    { completedAt: null },
    { completedAt: Number.NaN },
    { completedAt: Number.POSITIVE_INFINITY },
    { cleanedAt: null },
    { cleanedAt: Number.NaN },
    { cleanedAt: Number.POSITIVE_INFINITY },
    { completedAt: 31, cleanedAt: 30 },
  ])(
    'retains cleanup when the persisted Service proof is invalid: %j',
    async (change) => {
      const h = harness();
      h.lookupStatus.mockResolvedValue({
        kind: 'found',
        status: {
          workload: persistentVmWorkload('service-one', {
            workloadType: WorkloadType.Service,
            state: WorkloadState.Terminated,
            completedAt: 20,
            cleanedAt: 30,
            ...change,
          }),
          events: [],
          status: WorkloadHealthStatus.Down,
          vms: [],
        },
      });
      await h.owner.reserve(target, adapter, 'service-one', 1_000, ['bundle']);
      await expect(h.verify()).rejects.toThrow();
      expect(h.deleteForCleanup).not.toHaveBeenCalled();
      expect(h.receipts).toEqual([
        expect.objectContaining({ completed: false }),
      ]);
    },
  );

  test('an absent API record cannot replace persisted Service cleanup evidence', async () => {
    const h = harness();
    h.lookupStatus.mockResolvedValue({ kind: 'absent' });
    await h.owner.reserve(target, adapter, 'service-one', 1_000, ['bundle']);
    await expect(h.verify()).rejects.toThrow('no persisted terminal record');
    expect(h.deleteForCleanup).not.toHaveBeenCalled();
    expect(h.receipts).toEqual([expect.objectContaining({ completed: false })]);
  });

  test.each([
    { hostname: 'foreign.anycloud.sh' },
    { authorities: [] },
    { authorities: ['one.ns.example', 'one.ns.example'] },
    { answers: [] },
    {
      answers: [
        {
          ...AUTHORITIES[0]!,
          presence: 'absent' as const,
          diagnostic: 'NXDOMAIN',
        },
      ],
    },
  ])('rejects incomplete or foreign DNS coverage: %j', async (dns) => {
    const h = harness(dns);
    await h.owner.reserve(target, adapter, 'service-one', 1_000);
    await expect(h.verify()).rejects.toThrow(
      'omitted its hostname or an authority',
    );
    expect(h.receipts).toEqual([expect.objectContaining({ completed: false })]);
  });

  test('retains both observation and artifact failures', async () => {
    const h = harness({ answers: [] }, new Error('artifact disk unavailable'));
    await h.owner.reserve(target, adapter, 'service-one', 1_000);
    const error = await h.verify().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(AggregateError);
    expect(
      (error as AggregateError).errors.map((failure: Error) => failure.message),
    ).toEqual([
      'Service DNS cleanup omitted its hostname or an authority',
      'artifact disk unavailable',
    ]);
  });

  test('an artifact failure cannot report successful cleanup', async () => {
    const failure = new Error('artifact disk unavailable');
    const h = harness(undefined, failure);
    await h.owner.reserve(target, adapter, 'service-one', 1_000);
    await expect(h.verify()).rejects.toBe(failure);
  });

  test('rejects profile drift before native reservation', () => {
    const h = harness();
    expect(() =>
      h.owner.reserve(
        target,
        { ...adapter, diskSizeGb: 50 },
        'service-one',
        1_000,
      ),
    ).toThrow('original profile');
    expect(h.reserveWithProfile).not.toHaveBeenCalled();
  });

  test('binds the original named bundle and proves deletion before returning cleanup', async () => {
    const h = harness();
    const names = ['owned-bundle'];
    await h.owner.reserve(target, adapter, 'service-one', 1_000, names);
    names[0] = 'foreign-bundle';
    await h.verify();
    expect(h.deleteForCleanup).toHaveBeenCalledWith(
      'owned-bundle',
      expect.any(Number),
    );
    expect(h.receipts).toEqual([
      expect.objectContaining({
        completed: true,
        namedBundles: [{ name: 'owned-bundle', absent: true }],
      }),
    ]);
  });

  test('named bundle readback failure keeps Service cleanup incomplete', async () => {
    const failure = new Error('named bundle remains');
    const h = harness(undefined, undefined, failure);
    await h.owner.reserve(target, adapter, 'service-one', 1_000, [
      'owned-bundle',
    ]);
    await expect(h.verify()).rejects.toBe(failure);
    expect(h.receipts).toEqual([
      expect.objectContaining({ completed: false, namedBundles: [] }),
    ]);
  });
});

describe('named-secret durable absence', () => {
  const controller = {
    generation: 1,
    url: 'http://original-controller.invalid',
  };
  test('new bundle intents can use a restarted controller while original cleanup remains fenced', async () => {
    const cleanup = new CleanupStack();
    let generation = 1;
    const deleted: string[] = [];
    const api = {
      get controller() {
        return { ...controller, generation };
      },
      createSecret: async () => undefined,
      deleteSecret: async (name: string) => {
        deleted.push(name);
      },
    };
    const manager = new SecretManager(api, cleanup, api);
    await manager.create('original', { token: 'old-value' });
    generation++;
    await manager.create('new-intent', { token: 'new-value' });
    await expect(manager.delete('original')).rejects.toThrow('controller');
    await manager.delete('new-intent');
    await expect(cleanup.run()).rejects.toThrow('controller');
    expect(deleted).toEqual(['new-intent']);
    expect(cleanup.observations()).toEqual([
      { label: 'secret original', completed: false },
      { label: 'secret new-intent', completed: true },
    ]);
  });
  test('keeps cleanup registered until the API confirms the exact name is gone', async () => {
    const cleanup = new CleanupStack();
    const calls: string[] = [];
    let exists = true;
    const manager = new SecretManager(
      {
        controller,
        createSecret: async (name) => {
          calls.push(`create:${name}`);
        },
        deleteSecret: async (name) => {
          calls.push(`delete:${name}`);
          calls.push(`observe:${name}`);
          if (exists) throw new Error('Named secret remains after deletion');
        },
      },
      cleanup,
    );
    await manager.create('service-secret', { token: 'value' });
    await expect(manager.delete('service-secret')).rejects.toThrow(
      'remains after deletion',
    );
    expect(cleanup.observations()).toEqual([
      { label: 'secret service-secret', completed: false },
    ]);
    exists = false;
    await manager.delete('service-secret');
    expect(cleanup.observations()).toEqual([
      { label: 'secret service-secret', completed: true },
    ]);
    await cleanup.run();
    expect(calls).toEqual([
      'create:service-secret',
      'delete:service-secret',
      'observe:service-secret',
      'delete:service-secret',
      'observe:service-secret',
    ]);
  });

  test('uses independent cleanup reads after foreground cancellation', async () => {
    const cleanup = new CleanupStack();
    const calls: string[] = [];
    const manager = new SecretManager(
      {
        controller,
        createSecret: async () => undefined,
        deleteSecret: async () => {
          throw new Error('foreground cancelled');
        },
      },
      cleanup,
      {
        controller,
        deleteSecret: async (name) => {
          calls.push(`delete:${name}`);
          calls.push(`observe:${name}`);
        },
      },
    );
    await manager.create('service-secret', { token: 'value' });
    await expect(manager.delete('service-secret')).rejects.toThrow(
      'foreground cancelled',
    );
    await cleanup.run();
    expect(calls).toEqual(['delete:service-secret', 'observe:service-secret']);
    expect(cleanup.observations()).toEqual([
      { label: 'secret service-secret', completed: true },
    ]);
  });

  test('unknown cleanup observation retains the receipt and fails teardown', async () => {
    const cleanup = new CleanupStack();
    const manager = new SecretManager(
      {
        controller,
        createSecret: async () => undefined,
        deleteSecret: async () => {
          throw new Error('API unavailable');
        },
      },
      cleanup,
    );
    await manager.create('service-secret', { token: 'value' });
    await expect(cleanup.run()).rejects.toThrow('API unavailable');
    expect(cleanup.observations()).toEqual([
      { label: 'secret service-secret', completed: false },
    ]);
  });
});

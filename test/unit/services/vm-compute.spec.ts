import { afterEach, describe, expect, it, vi } from 'vitest';
import * as cloudConfig from '../../../src/api/services/cloud-config.js';
import type { DbVM } from '../../../src/api/services/entities.js';
import {
  bindVmCompute,
  loadWorkloadVmCompute,
  terminateVmComputes,
  vmComputeCredential,
  vmComputeIdentityKey,
  type VmComputeIdentity,
} from '../../../src/api/services/vm-compute.js';
import {
  createCloudCompute,
  VM_RELEASE_CANDIDATE,
  VM_RELEASED,
  vmReleaseUnknown,
} from '../../../src/api/services/gateways/cloud.js';
import { CloudType, type CloudConfig } from '../../../src/shared/cloud.js';
import {
  makeMockCloudCompute,
  makeMockVM,
  makeStoredWorkload,
  TEST_AWS_CRED,
  TEST_GCP_CRED,
} from '../helpers/fixtures.js';

const identity: VmComputeIdentity = {
  cloudId: 'attempt-native-id',
  provider: CloudType.GCP,
  credential: { source: 'attempt', credentialId: 'attempt-credential' },
  region: 'us-central1',
  availabilityZone: 'b',
};

function storedVm(overrides: Partial<DbVM> = {}): DbVM {
  return {
    ...makeMockVM({ cloudId: identity.cloudId }),
    createdAt: 100,
    endedAt: null,
    preempt: 0,
    credentialId: 'attempt-credential',
    cloudProvider: CloudType.GCP,
    region: 'us-central1',
    availabilityZone: 'b',
    inputHostPath: '/mnt/input',
    outputHostPath: '/mnt/output',
    checkpointHostPath: '/mnt/checkpoint',
    ...overrides,
  };
}

const currentConfig: CloudConfig = {
  cloudProvider: CloudType.GCP,
  credentials: TEST_GCP_CRED,
  region: 'us-east4',
  availabilityZone: 'c',
  vmType: 'e2-standard-2',
};

afterEach(() => vi.restoreAllMocks());

describe('bound VM compute', () => {
  it('freezes the full identity and sends only its original ID to lifecycle operations', async () => {
    const input = {
      ...identity,
      credential: {
        source: 'attempt' as const,
        credentialId: 'attempt-credential',
      },
    };
    const compute = makeMockCloudCompute({
      observeVMReleaseOnce: vi.fn().mockResolvedValue(VM_RELEASE_CANDIDATE),
      verifyVMPreemption: vi.fn().mockResolvedValue(true),
      startVM: vi.fn().mockResolvedValue('203.0.113.9'),
    });
    const vm = bindVmCompute(compute, input);
    input.cloudId = 'other-native-id';
    input.region = 'other-region';
    input.credential.credentialId = 'other-credential';
    input.availabilityZone = 'f';
    const controller = new AbortController();
    const options = { signal: controller.signal };

    await expect(vm.observeReleaseOnce(options)).resolves.toBe(
      VM_RELEASE_CANDIDATE,
    );
    await expect(vm.confirmRelease(options)).resolves.toBe(VM_RELEASED);
    await expect(vm.preemption?.observe()).resolves.toBe(true);
    await expect(vm.preemption?.restart()).resolves.toBe('203.0.113.9');
    await expect(terminateVmComputes([vm])).resolves.toEqual([vm]);

    expect(vm.identity).toEqual(identity);
    expect(Object.isFrozen(vm)).toBe(true);
    expect(Object.isFrozen(vm.identity)).toBe(true);
    expect(Object.isFrozen(vm.identity.credential)).toBe(true);
    expect(compute.observeVMReleaseOnce).toHaveBeenCalledTimes(2);
    expect(compute.observeVMReleaseOnce).toHaveBeenNthCalledWith(
      1,
      'attempt-native-id',
      options,
    );
    expect(compute.observeVMReleaseOnce).toHaveBeenNthCalledWith(
      2,
      'attempt-native-id',
      options,
    );
    expect(compute.verifyVMPreemption).toHaveBeenCalledWith(
      'attempt-native-id',
    );
    expect(compute.startVM).toHaveBeenCalledWith('attempt-native-id');
    expect(compute.terminateVMs).toHaveBeenCalledWith(['attempt-native-id']);
  });

  it('does not turn unknown observations or cancellation into release', async () => {
    const controller = new AbortController();
    controller.abort(new Error('foreground cancelled'));
    const unknown = vmReleaseUnknown(new Error('native API unavailable'));
    const compute = makeMockCloudCompute({
      observeVMReleaseOnce: vi.fn().mockResolvedValue(unknown),
    });
    const vm = bindVmCompute(compute, identity);
    await expect(
      vm.confirmRelease({ signal: controller.signal }),
    ).resolves.toEqual(unknown);
    expect(compute.observeVMReleaseOnce).toHaveBeenCalledWith(
      identity.cloudId,
      { signal: controller.signal },
    );
  });

  it('resolves a lazy gateway once and preserves provider confirmation policy', async () => {
    const compute = makeMockCloudCompute({
      releaseConfirmationPolicy: {
        requiredReleaseObservations: 2,
        minObservationIntervalMs: 1000,
      },
    });
    const factory = vi.fn(() => compute);
    const vm = bindVmCompute(factory, identity);
    expect(factory).not.toHaveBeenCalled();
    expect(vmComputeIdentityKey(vm)).toBe(
      JSON.stringify([
        'GCP',
        'attempt',
        'attempt-credential',
        null,
        'us-central1',
        'b',
        'attempt-native-id',
      ]),
    );
    expect(factory).not.toHaveBeenCalled();
    await vm.observeReleaseOnce();
    await vm.observeReleaseOnce();
    expect(factory).toHaveBeenCalledOnce();
    expect(vm.releaseConfirmationPolicy).toEqual({
      requiredReleaseObservations: 2,
      minObservationIntervalMs: 1000,
    });
  });

  it.each([{ provider: CloudType.AWS }, { region: 'us-west-2' }])(
    'rejects a gateway inconsistent with $provider / $region',
    (drift) => {
      expect(() =>
        bindVmCompute(makeMockCloudCompute(), { ...identity, ...drift }),
      ).toThrow('does not match its resolved gateway');
    },
  );

  it.each([
    { cloudId: '' },
    { credential: { source: 'attempt' as const, credentialId: '' } },
    { credential: { source: 'credentialless' as const, credentialId: null } },
  ])('rejects incomplete public-cloud identity %#', (incomplete) => {
    expect(() =>
      bindVmCompute(makeMockCloudCompute(), { ...identity, ...incomplete }),
    ).toThrow('identity is incomplete');
  });

  it('keeps batching and partial confirmations scoped to their original handles', async () => {
    const first = makeMockCloudCompute();
    const second = makeMockCloudCompute({ region: 'us-east4' });
    vi.mocked(first.terminateVMs).mockResolvedValue(['same-native-id']);
    vi.mocked(second.terminateVMs).mockResolvedValue([]);
    const a = bindVmCompute(first, { ...identity, cloudId: 'same-native-id' });
    const b = bindVmCompute(first, { ...identity, cloudId: 'still-present' });
    const c = bindVmCompute(second, {
      ...identity,
      cloudId: 'same-native-id',
      region: 'us-east4',
    });

    const confirmed = await terminateVmComputes([a, b, c]);
    expect(confirmed).toEqual([a]);
    expect(first.terminateVMs).toHaveBeenCalledExactlyOnceWith([
      'same-native-id',
      'still-present',
    ]);
    expect(second.terminateVMs).toHaveBeenCalledExactlyOnceWith([
      'same-native-id',
    ]);
  });

  it('rejects foreign confirmations and handles copied outside their owner', async () => {
    const compute = makeMockCloudCompute();
    const vm = bindVmCompute(compute, identity);
    const forged = { ...vm };
    await expect(terminateVmComputes([forged])).rejects.toThrow(
      'not created by its owner',
    );
    expect(() => vmComputeIdentityKey(forged)).toThrow(
      'not created by its owner',
    );
    expect(compute.terminateVMs).not.toHaveBeenCalled();
    vi.mocked(compute.terminateVMs).mockResolvedValue(['unrequested-id']);
    await expect(terminateVmComputes([vm])).rejects.toThrow('unrequested VM');
  });

  it('keys observations by every placement and credential coordinate', () => {
    const variants: VmComputeIdentity[] = [
      identity,
      { ...identity, cloudId: 'other-vm' },
      { ...identity, provider: CloudType.AWS },
      {
        ...identity,
        credential: { source: 'attempt', credentialId: 'other-credential' },
      },
      {
        ...identity,
        credential: { source: 'legacy-workload', credentialId: null },
      },
      { ...identity, region: 'us-east4' },
      { ...identity, availabilityZone: 'c' },
      { ...identity, availabilityZone: null },
    ];
    const keys = variants.map((input) =>
      vmComputeIdentityKey(
        bindVmCompute(
          makeMockCloudCompute({ type: input.provider, region: input.region }),
          input,
          TEST_GCP_CRED,
        ),
      ),
    );
    expect(new Set(keys).size).toBe(variants.length);
  });

  it('does not invent a preemption capability on credentialless providers', () => {
    const compute = createCloudCompute({
      type: CloudType.Local,
      region: 'local',
      vmType: 'local',
      rawValidateCredentials: vi.fn(),
      rawClassifyError: vi.fn(),
      rawNewVM: vi.fn(),
      rawRequestVMTermination: vi.fn(),
      rawTerminateNetworking: vi.fn(),
      rawGetAllVMs: vi.fn(),
      rawUpsertFirewall: vi.fn(),
      observeVMReleaseOnce: vi.fn(),
    });
    const vm = bindVmCompute(compute, {
      ...identity,
      provider: CloudType.Local,
      region: 'local',
      credential: vmComputeCredential(CloudType.Local, null),
    });
    expect(vm.preemption).toBeNull();
  });
});

describe('Workload attempt compute resolution', () => {
  it.each(['b', undefined])(
    'uses the attempt credential, region, and recorded zone %s instead of current placement',
    async (availabilityZone) => {
      const workload = makeStoredWorkload({ cloudProvider: CloudType.GCP });
      const vm = storedVm({ availabilityZone });
      const loaded = { ...currentConfig, credentials: { ...TEST_GCP_CRED } };
      const load = vi
        .spyOn(cloudConfig, 'loadWorkloadConfigs')
        .mockResolvedValue(loaded);
      const compute = makeMockCloudCompute();
      const create = vi
        .spyOn(cloudConfig, 'createComputeProvider')
        .mockReturnValue(compute);
      const resolution = await loadWorkloadVmCompute(workload, vm, {
        fallback: currentConfig,
      });
      expect(load).toHaveBeenCalledExactlyOnceWith(
        workload,
        'attempt-credential',
      );
      expect(resolution.vmCompute?.identity).toEqual({
        ...identity,
        availabilityZone: availabilityZone ?? null,
      });
      expect(create).not.toHaveBeenCalled();
      // Mutation after resolution must not change the delayed SDK construction.
      loaded.credentials.projectId = 'other-project';
      loaded.region = 'other-region';
      await resolution.vmCompute?.observeReleaseOnce();
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          cloudProvider: CloudType.GCP,
          credentials: TEST_GCP_CRED,
          region: 'us-central1',
          availabilityZone,
        }),
        'observed-vm',
      );
      expect(compute.observeVMReleaseOnce).toHaveBeenCalledWith(
        'attempt-native-id',
        undefined,
      );
    },
  );

  it.each([
    null,
    {
      ...currentConfig,
      cloudProvider: CloudType.AWS,
      credentials: TEST_AWS_CRED,
    },
  ])(
    'does not replace missing or wrong-provider attempt credentials with fallback %#',
    async (loaded) => {
      const workload = makeStoredWorkload({ cloudProvider: CloudType.GCP });
      const load = vi
        .spyOn(cloudConfig, 'loadWorkloadConfigs')
        .mockResolvedValue(loaded);
      const create = vi.spyOn(cloudConfig, 'createComputeProvider');
      const resolution = await loadWorkloadVmCompute(workload, storedVm(), {
        fallback: currentConfig,
      });
      expect(resolution.vmCompute).toBeNull();
      expect(resolution.reason).toMatch(
        /credentials unavailable|provider changed/,
      );
      expect(load).toHaveBeenCalledExactlyOnceWith(
        workload,
        'attempt-credential',
      );
      expect(create).not.toHaveBeenCalled();
    },
  );

  it('labels the existing legacy fallback without fabricating an attempt credential', async () => {
    const workload = makeStoredWorkload({ cloudProvider: CloudType.GCP });
    const load = vi.spyOn(cloudConfig, 'loadWorkloadConfigs');
    const resolution = await loadWorkloadVmCompute(
      workload,
      storedVm({ credentialId: undefined }),
      { fallback: currentConfig },
    );
    expect(resolution.vmCompute?.identity.credential).toEqual({
      source: 'legacy-workload',
      credentialId: null,
    });
    expect(load).not.toHaveBeenCalled();
  });

  it('applies each legacy rule to a row without a recorded credential', async () => {
    const workload = makeStoredWorkload({ cloudProvider: CloudType.GCP });
    const load = vi.spyOn(cloudConfig, 'loadWorkloadConfigs');
    const vm = storedVm({ credentialId: undefined });
    const fallback = await loadWorkloadVmCompute(workload, vm, {
      fallback: currentConfig,
    });
    expect(fallback.cloudConfig?.credentials).toEqual(
      currentConfig.credentials,
    );
    await expect(
      loadWorkloadVmCompute(workload, vm, 'defer'),
    ).resolves.toMatchObject({ vmCompute: null });
    expect(load).not.toHaveBeenCalled();
  });

  it('isolates legacy observation keys by concrete credentials while preserving provenance', async () => {
    const workload = makeStoredWorkload({ cloudProvider: CloudType.GCP });
    const vm = storedVm({ credentialId: undefined });
    const credentials = {
      projectId: 'original-project',
      clientEmail: 'original@example.invalid',
      privateKey: 'original-private-key',
    };
    const inputs = [
      credentials,
      { ...credentials, projectId: 'another-project' },
      { ...credentials, privateKey: 'rotated-private-key' },
      {
        privateKey: credentials.privateKey,
        clientEmail: credentials.clientEmail,
        projectId: credentials.projectId,
        billingExportDataset: undefined,
      },
    ];
    const create = vi.spyOn(cloudConfig, 'createComputeProvider');
    const keys: string[] = [];
    for (const selected of inputs) {
      const resolved = await loadWorkloadVmCompute(workload, vm, {
        fallback: { ...currentConfig, credentials: selected },
      });
      expect(resolved.vmCompute?.identity.credential).toEqual({
        source: 'legacy-workload',
        credentialId: null,
      });
      keys.push(vmComputeIdentityKey(resolved.vmCompute!));
    }
    expect(new Set(keys.slice(0, 3)).size).toBe(3);
    expect(keys[3]).toBe(keys[0]);
    expect(keys.join()).not.toContain(credentials.privateKey);
    expect(keys.join()).not.toContain(credentials.clientEmail);
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects a legacy handle without resolved fallback credentials', () => {
    const create = vi.fn(() => makeMockCloudCompute());
    expect(() =>
      bindVmCompute(create, {
        ...identity,
        credential: { source: 'legacy-workload', credentialId: null },
      }),
    ).toThrow('Legacy VM compute credentials are unavailable');
    expect(create).not.toHaveBeenCalled();
  });

  it.each([CloudType.GCP, null])(
    'defers public host-loss recovery without attempt credentials even when provider is %s',
    async (cloudProvider) => {
      const workload = makeStoredWorkload({ cloudProvider });
      const load = vi
        .spyOn(cloudConfig, 'loadWorkloadConfigs')
        .mockResolvedValue(currentConfig);
      const create = vi.spyOn(cloudConfig, 'createComputeProvider');
      const resolution = await loadWorkloadVmCompute(
        workload,
        storedVm({
          credentialId: undefined,
          cloudProvider: cloudProvider ?? undefined,
        }),
        'defer',
      );
      expect(resolution).toEqual({
        vmCompute: null,
        cloudConfig: null,
        reason: 'exact VM attempt credentials unavailable',
        attempt: 'legacy',
        missing: ['credential'],
        fallback: {},
      });
      expect(create).not.toHaveBeenCalled();
      if (cloudProvider) expect(load).not.toHaveBeenCalled();
      else expect(load).toHaveBeenCalledOnce();
    },
  );

  it.each([CloudType.Local])(
    'preserves credentialless %s recovery',
    async (provider) => {
      const workload = makeStoredWorkload({ cloudProvider: provider });
      vi.spyOn(cloudConfig, 'loadWorkloadConfigs').mockResolvedValue({
        cloudProvider: provider,
        region: 'local',
        vmType: 'local',
      });
      const compute = makeMockCloudCompute({ type: provider, region: 'local' });
      const create = vi
        .spyOn(cloudConfig, 'createComputeProvider')
        .mockReturnValue(compute);
      const [attempt] = await Promise.allSettled([
        loadWorkloadVmCompute(
          workload,
          storedVm({
            credentialId: undefined,
            cloudProvider: provider,
            region: 'local',
            availabilityZone: undefined,
          }),
          'defer',
        ),
      ]);
      expect(attempt.status).toBe('fulfilled');
      if (attempt.status !== 'fulfilled') throw attempt.reason;
      const resolution = attempt.value;
      expect(resolution.vmCompute?.identity.credential).toEqual({
        source: 'credentialless',
        credentialId: null,
      });
      await resolution.vmCompute?.observeReleaseOnce();
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          cloudProvider: provider,
          region: 'local',
          credentials: undefined,
        }),
        'observed-vm',
      );
      expect(compute.observeVMReleaseOnce).toHaveBeenCalledWith(
        'attempt-native-id',
        undefined,
      );
    },
  );
});

describe('Existing VM attempt variants', () => {
  const awsConfig: CloudConfig = {
    cloudProvider: CloudType.AWS,
    credentials: TEST_AWS_CRED,
    region: 'us-east-1',
    vmType: 't3.small',
  };
  const localConfig: CloudConfig = {
    cloudProvider: CloudType.Local,
    region: 'local',
    vmType: 'local',
  };

  it.each([
    ['GCP with its credential, region and zone', storedVm(), currentConfig],
    [
      'AWS without a zone',
      storedVm({ cloudProvider: CloudType.AWS, availabilityZone: undefined }),
      awsConfig,
    ],
    [
      'Local without a credential or zone',
      storedVm({
        credentialId: undefined,
        cloudProvider: CloudType.Local,
        region: 'local',
        availabilityZone: undefined,
      }),
      localConfig,
    ],
  ])('resolves %s as recorded', async (_case, vm, loaded) => {
    vi.spyOn(cloudConfig, 'loadWorkloadConfigs').mockResolvedValue(loaded);
    const resolution = await loadWorkloadVmCompute(
      makeStoredWorkload({ cloudProvider: vm.cloudProvider }),
      vm,
      'defer',
    );
    expect(resolution.vmCompute).not.toBeNull();
    expect(resolution.attempt).toBe('recorded');
    expect(resolution).not.toHaveProperty('missing');
    expect(resolution).not.toHaveProperty('fallback');
  });

  it('keeps a fallback region distinguishable from a recorded one', async () => {
    const workload = makeStoredWorkload({ cloudProvider: CloudType.GCP });
    const load = vi.spyOn(cloudConfig, 'loadWorkloadConfigs');
    const resolution = await loadWorkloadVmCompute(
      workload,
      storedVm({ credentialId: undefined, region: undefined }),
      { fallback: currentConfig },
    );
    expect(resolution).toMatchObject({
      attempt: 'legacy',
      missing: ['credential', 'region'],
      fallback: { region: currentConfig.region },
      cloudConfig: { region: currentConfig.region, availabilityZone: 'b' },
    });
    expect(resolution.vmCompute?.identity).toMatchObject({
      region: currentConfig.region,
      credential: { source: 'legacy-workload', credentialId: null },
    });
    expect(load).not.toHaveBeenCalled();
  });

  it('leaves a missing zone without a substitute for provider discovery', async () => {
    vi.spyOn(cloudConfig, 'loadWorkloadConfigs').mockResolvedValue(
      currentConfig,
    );
    const resolution = await loadWorkloadVmCompute(
      makeStoredWorkload({ cloudProvider: CloudType.GCP }),
      storedVm({ availabilityZone: undefined }),
      { fallback: currentConfig },
    );
    expect(resolution).toMatchObject({
      attempt: 'legacy',
      missing: ['zone'],
      fallback: {},
    });
    expect(resolution.vmCompute?.identity.availabilityZone).toBeNull();
  });

  // A row and workload without a provider need every fact, so the deferral is
  // labelled rather than throwing on the unknown provider.
  it.each([
    [
      'nothing',
      null,
      'compute credentials unavailable',
      ['credential', 'zone'],
    ],
    [
      'AWS',
      awsConfig,
      'exact VM attempt credentials unavailable',
      ['credential'],
    ],
  ])(
    'defers an attempt with no known provider when the load returns %s',
    async (_case, loaded, reason, missing) => {
      vi.spyOn(cloudConfig, 'loadWorkloadConfigs').mockResolvedValue(loaded);
      const resolution = await loadWorkloadVmCompute(
        makeStoredWorkload({ cloudProvider: null }),
        storedVm({
          cloudProvider: undefined,
          credentialId: undefined,
          availabilityZone: undefined,
        }),
        'defer',
      );
      expect(resolution).toEqual({
        vmCompute: null,
        cloudConfig: null,
        reason,
        attempt: 'legacy',
        missing,
        fallback: {},
      });
    },
  );

  it('keeps a recorded credential recorded when it no longer loads', async () => {
    vi.spyOn(cloudConfig, 'loadWorkloadConfigs').mockResolvedValue(null);
    await expect(
      loadWorkloadVmCompute(
        makeStoredWorkload({ cloudProvider: CloudType.GCP }),
        storedVm(),
        { fallback: currentConfig },
      ),
    ).resolves.toEqual({
      vmCompute: null,
      cloudConfig: null,
      reason: 'compute credentials unavailable',
      attempt: 'recorded',
    });
  });
});

import { describe, expect, test, vi } from 'vitest';

import { CloudType } from '../../src/shared/cloud.js';
import { Redactor } from '../integration/e2e/internal/artifacts.js';
import { Environment } from '../integration/e2e/internal/environment.js';
import { persistentVmContractPolicy } from '../integration/e2e/internal/contracts/persistent-vm-policy.js';
import type { PersistentVmContractPolicy } from '../integration/e2e/internal/contracts/persistent-vm-policy.js';
import { observePersistentVmRunning } from '../integration/e2e/internal/contracts/persistent-vm-running.js';
import { observePersistentVmTerminated } from '../integration/e2e/internal/contracts/persistent-vm.js';
import { LocalSmolvmPersistentVmAdapter } from '../integration/e2e/internal/targets/local-smolvm.js';
import type {
  PersistentVmRunningContext,
  PersistentVmRunningObservationAttempt,
  PersistentVmTargetTransport,
  PersistentVmTerminatedObservationAttempt,
} from '../integration/e2e/internal/targets/persistent-vm-types.js';
import { PublicCloudPersistentVmAdapter } from '../integration/e2e/internal/targets/public-cloud-vm.js';
import { submitPersistentVm } from '../integration/e2e/internal/persistent-vm-submission.js';
import {
  ProviderProfiles,
  type VmProfile,
} from '../integration/e2e/internal/profiles.js';
import type { WorkloadCliCreateTransport } from '../integration/e2e/internal/workload-mutations.js';
import { Waiter } from '../integration/e2e/internal/wait.js';
import { trackedWorkloadRefForTest } from './helpers/e2e.js';

const context: PersistentVmRunningContext = {
  availabilityZone: null,
  baseImageId: 'base-image-id',
  cloudId: '123',
  ref: trackedWorkloadRefForTest('vm-boundary'),
  region: 'US',
  sshHost: '203.0.113.10',
  sshPort: 32122,
  sshUsername: 'root',
};

function policy(
  overrides: Partial<PersistentVmContractPolicy> = {},
): PersistentVmContractPolicy {
  return {
    cleanupTimeoutMs: 1_000,
    hostLossFailureTimeoutMs: 1_000,
    hostReleaseTimeoutMs: 1_000,
    repairTimeoutMs: 1_000,
    runningTimeoutMs: 1_000,
    teardownMaxMs: 1_000,
    terminatedTimeoutMs: 1_000,
    ...overrides,
  };
}

class RecordingTransport implements PersistentVmTargetTransport {
  readonly calls: string[] = [];

  async deleteHost(received: PersistentVmRunningContext): Promise<void> {
    this.calls.push(`delete:${received.cloudId}`);
  }

  async observeRunning(
    received: PersistentVmRunningContext,
  ): Promise<PersistentVmRunningObservationAttempt> {
    this.calls.push(`running:${received.cloudId}`);
    return { kind: 'not-required' };
  }

  async observeTerminated(
    received: PersistentVmRunningContext,
  ): Promise<PersistentVmTerminatedObservationAttempt> {
    this.calls.push(`terminated:${received.cloudId}`);
    return {
      kind: 'observed',
      observation: {
        kind: 'provider-api',
        outcome: 'terminated',
        provider: CloudType.AWS,
      },
    };
  }
}

describe('persistent VM adapter boundaries', () => {
  test('keeps lifecycle deadlines in a contract-owned target policy', () => {
    const environment = {
      milliseconds: (_name: string, fallbackSeconds: number) =>
        fallbackSeconds * 1_000,
    };

    expect(persistentVmContractPolicy(environment, 'local-smolvm')).toEqual({
      cleanupTimeoutMs: 180_000,
      hostLossFailureTimeoutMs: 180_000,
      hostReleaseTimeoutMs: 60_000,
      repairTimeoutMs: 300_000,
      runningTimeoutMs: 300_000,
      terminatedTimeoutMs: 180_000,
    });
    expect(persistentVmContractPolicy(environment, 'lambda')).toEqual({
      cleanupTimeoutMs: 2_700_000,
      hostLossFailureTimeoutMs: 900_000,
      hostReleaseTimeoutMs: 600_000,
      repairTimeoutMs: 300_000,
      runningTimeoutMs: 1_200_000,
      teardownMaxMs: 420_000,
      terminatedObservation: { intervalMs: 5_000, timeoutMs: 60_000 },
      terminatedTimeoutMs: 300_000,
    });
  });

  test.each(['aws', 'azure', 'gcp', 'lambda', 'local-smolvm'] as const)(
    '0040/S3 honors independently named timeout overrides for %s',
    (target) => {
      const environment = new Environment(
        {
          VM_SMOKE_CLEANUP_TIMEOUT_SECONDS: '11',
          VM_HOST_LOSS_FAILURE_TIMEOUT_SECONDS: '13',
          VM_SMOKE_HOST_RELEASE_TIMEOUT_SECONDS: '17',
          VM_SMOKE_REPAIR_TIMEOUT_SECONDS: '19',
          VM_SMOKE_RUNNING_TIMEOUT_SECONDS: '23',
          E2E_TEARDOWN_MAX_SECONDS: '29',
          VM_SMOKE_PROVIDER_TERMINATION_TIMEOUT_SECONDS: '31',
          VM_SMOKE_TERMINATED_TIMEOUT_SECONDS: '37',
        },
        new Redactor(),
      );
      const result = persistentVmContractPolicy(environment, target);
      expect(result).toMatchObject({
        cleanupTimeoutMs: 11_000,
        hostLossFailureTimeoutMs: 13_000,
        hostReleaseTimeoutMs: 17_000,
        repairTimeoutMs: 19_000,
        runningTimeoutMs: 23_000,
        terminatedTimeoutMs: 37_000,
      });
      expect(result.teardownMaxMs).toBe(
        target === 'lambda' ? 29_000 : undefined,
      );
      expect(result.terminatedObservation).toEqual(
        target === 'local-smolvm'
          ? undefined
          : { intervalMs: 5_000, timeoutMs: 31_000 },
      );
    },
  );

  // Every public host now proves its own release through the provider, so a
  // missing budget is a target that would silently skip that proof.
  test.each(['aws', 'azure', 'gcp', 'lambda'] as const)(
    'requires %s to declare a provider termination budget',
    (target) => {
      const environment = {
        milliseconds: (_name: string, fallbackSeconds: number) =>
          fallbackSeconds * 1_000,
      };

      expect(
        persistentVmContractPolicy(environment, target).terminatedObservation,
      ).toEqual({
        intervalMs: 5_000,
        timeoutMs: target === 'azure' || target === 'gcp' ? 300_000 : 60_000,
      });
    },
  );

  test('leaves local smolvm without a provider termination budget', () => {
    const environment = {
      milliseconds: (_name: string, fallbackSeconds: number) =>
        fallbackSeconds * 1_000,
    };

    expect(
      persistentVmContractPolicy(environment, 'local-smolvm')
        .terminatedObservation,
    ).toBeUndefined();
  });

  test('reads the teardown budget from the same variable as the Bash leg', () => {
    // Both legs run the same target in CI, so a budget tuned on one and not the
    // other is worse than no budget: the disagreement reads as a provider
    // regression.
    const environment = {
      milliseconds: (name: string, fallbackSeconds: number) =>
        (name === 'E2E_TEARDOWN_MAX_SECONDS' ? 90 : fallbackSeconds) * 1_000,
    };

    expect(
      persistentVmContractPolicy(environment, 'lambda').teardownMaxMs,
    ).toBe(90_000);
  });

  // cleanedAt lands after networking teardown, and Azure retries firewall and
  // VNet deletion 180 x 10s each on the way there, so a bound tight enough to
  // catch a release regression on Lambda fails healthy runs elsewhere, so only
  // Lambda opts in.
  test.each(['aws', 'azure', 'gcp', 'local-smolvm'] as const)(
    'leaves %s with no teardown budget to assert',
    (target) => {
      const environment = {
        milliseconds: (_name: string, fallbackSeconds: number) =>
          fallbackSeconds * 1_000,
      };

      expect(
        persistentVmContractPolicy(environment, target).teardownMaxMs,
      ).toBeUndefined();
    },
  );

  test('adapters expose fixed profiles and only delegate typed operations', async () => {
    const transport = new RecordingTransport();
    const local = new LocalSmolvmPersistentVmAdapter(transport);
    const publicCloud = new PublicCloudPersistentVmAdapter(
      {
        credentialName: 'aws-test',
        provider: CloudType.AWS,
        target: 'aws',
      },
      transport,
    );

    expect(local.profile).toEqual({
      provider: CloudType.Local,
      target: 'local-smolvm',
    });
    expect(publicCloud.profile).toEqual({
      credentialName: 'aws-test',
      provider: CloudType.AWS,
      target: 'aws',
    });
    await local.observeRunning(context);
    await publicCloud.observeTerminated(context);
    await publicCloud.deleteHost(context);
    expect(transport.calls).toEqual([
      'running:123',
      'terminated:123',
      'delete:123',
    ]);
  });
});

describe('persistent VM contract-owned observations', () => {
  test('rejects absent, wrong-kind, and undeclared running evidence', async () => {
    const localObservation = {
      kind: 'local-smolvm' as const,
      machineCount: 1,
      machineName: 'ac-local-vm-boundary-0',
      machineState: 'running',
      portCount: 1,
      sshGuestPort: 22,
      sshHostPort: 32122,
    };
    for (const target of ['aws', 'azure'] as const) {
      await expect(
        observePersistentVmRunning(
          {
            targets: {
              observeRunning: async () => ({
                kind: 'observed',
                observation: localObservation,
              }),
            },
          },
          target,
          context,
        ),
      ).rejects.toThrow();
    }
    await expect(
      observePersistentVmRunning(
        {
          targets: { observeRunning: async () => ({ kind: 'not-required' }) },
        },
        'aws',
        context,
      ),
    ).rejects.toThrow();
  });

  test('validates the observed payload before accepting running evidence', async () => {
    const observeRunning = vi.fn(
      async (): Promise<PersistentVmRunningObservationAttempt> => ({
        kind: 'observed',
        observation: {
          kind: 'aws',
          rootVolumeType: 'gp2',
          rootVolumeIops: 8_000,
          rootVolumeThroughput: 1_000,
        },
      }),
    );
    await expect(
      observePersistentVmRunning(
        { targets: { observeRunning } },
        'aws',
        context,
      ),
    ).rejects.toThrow('AWS root volume must use gp3');
    expect(observeRunning).toHaveBeenCalledExactlyOnceWith('aws', context);
  });

  test('accepts no running observation for targets that declare none', async () => {
    const observeRunning = vi.fn(
      async (): Promise<PersistentVmRunningObservationAttempt> => ({
        kind: 'not-required',
      }),
    );
    for (const target of ['azure', 'gcp', 'lambda'] as const) {
      await observePersistentVmRunning(
        { targets: { observeRunning } },
        target,
        context,
      );
      expect(observeRunning).toHaveBeenLastCalledWith(target, context);
    }
    expect(observeRunning).toHaveBeenCalledTimes(3);
  });

  test('polls inconclusive termination attempts until evidence is conclusive', async () => {
    let attempts = 0;
    const artifacts: unknown[] = [];
    const qualification = await observePersistentVmTerminated(
      {
        artifacts: {
          json: async (_name, value) => {
            artifacts.push(value);
            return '/tmp/termination.json';
          },
        },
        targets: {
          observeTerminated: async () => {
            attempts += 1;
            return {
              kind: 'observed',
              observation: {
                kind: 'provider-api',
                outcome: attempts === 1 ? 'inconclusive' : 'terminated',
                provider: CloudType.Lambda,
              },
            };
          },
        },
        wait: new Waiter(new AbortController().signal),
      },
      'lambda',
      context,
      policy({
        terminatedObservation: { intervalMs: 1, timeoutMs: 100 },
      }),
    );

    expect(attempts).toBe(2);
    expect(qualification).toBe('conclusive');
    expect(artifacts).toEqual([
      {
        kind: 'provider-api',
        outcome: 'terminated',
        provider: CloudType.Lambda,
      },
    ]);
  });

  test('maps only an exhausted termination deadline to inconclusive', async () => {
    const artifacts: unknown[] = [];
    const dependencies = {
      artifacts: {
        json: async (_name: string, value: unknown) => {
          artifacts.push(value);
          return '/tmp/termination.json';
        },
      },
      targets: {
        observeTerminated:
          async (): Promise<PersistentVmTerminatedObservationAttempt> => ({
            kind: 'observed',
            observation: {
              kind: 'provider-api',
              outcome: 'inconclusive',
              provider: CloudType.Lambda,
            },
          }),
      },
      wait: new Waiter(new AbortController().signal),
    };
    const terminationPolicy = policy({
      terminatedObservation: { intervalMs: 1, timeoutMs: 10 },
    });

    await expect(
      observePersistentVmTerminated(
        dependencies,
        'lambda',
        context,
        terminationPolicy,
      ),
    ).resolves.toBe('inconclusive');
    expect(artifacts).toEqual([
      {
        kind: 'provider-api',
        outcome: 'inconclusive',
        provider: CloudType.Lambda,
      },
    ]);

    await expect(
      observePersistentVmTerminated(
        {
          ...dependencies,
          targets: {
            observeTerminated: async () => ({
              kind: 'observed',
              observation: {
                kind: 'provider-api',
                outcome: 'present',
                provider: CloudType.Lambda,
              },
            }),
          },
        },
        'lambda',
        context,
        terminationPolicy,
      ),
    ).rejects.toThrow('still reports 123 present');

    await expect(
      observePersistentVmTerminated(
        {
          ...dependencies,
          targets: {
            observeTerminated: async () => ({
              kind: 'observed',
              observation: {
                kind: 'provider-api',
                outcome: 'terminated',
                provider: CloudType.AWS,
              },
            }),
          },
        },
        'lambda',
        context,
        terminationPolicy,
      ),
    ).rejects.toThrow('wrong provider');
  });
});

// Cases kept from the retired persistent-VM adapter internals spec: local
// submission carries no compute placement, the family must not create a VM
// whose credential was never saved.
describe('persistent VM submission fences', () => {
  // RFC 0017 core invariant 7: only real targets serialize placement flags.
  test('uses one tracked CLI stage while serializing only real target placement', async () => {
    const profiles = new ProviderProfiles(
      new Environment(
        {
          AWS_ACCESS_KEY_ID: 'aws-access',
          AWS_SECRET_ACCESS_KEY: 'aws-secret',
          AZURE_CLIENT_ID: 'azure-client',
          AZURE_CLIENT_SECRET: 'azure-secret',
          AZURE_SUBSCRIPTION_ID: 'azure-subscription',
          AZURE_TENANT_ID: 'azure-tenant',
          GCP_CLIENT_EMAIL: 'gcp@example.com',
          GCP_PRIVATE_KEY: 'gcp-private',
          GCP_PROJECT_ID: 'gcp-project',
          LAMBDA_API_KEY: 'lambda-key',
          VM_SMOKE_DISK_SIZE_GB: '42',
          VM_SMOKE_REGION: 'test-region',
        },
        new Redactor(),
      ),
    );
    const profileCalls: string[] = [];
    const credentialCalls: string[] = [];
    const commandCalls: Array<{
      readonly args: readonly string[];
      readonly label: string | undefined;
      readonly target: string;
    }> = [];
    const dependencies = {
      credentials: {
        save: async (name: string) => {
          credentialCalls.push(name);
        },
      },
      profiles: {
        vm: (provider: Parameters<ProviderProfiles['vm']>[0]) => {
          profileCalls.push(provider);
          return profiles.vm(provider);
        },
      },
      mutations: {
        runCliCreateWithTransientRetries: async (
          ref: ReturnType<typeof trackedWorkloadRefForTest>,
          args: readonly string[],
          options?: { readonly label?: string },
        ): Promise<void> => {
          commandCalls.push({ args, label: options?.label, target: ref.id });
        },
      },
    };

    for (const target of [
      'local-smolvm',
      'aws',
      'azure',
      'gcp',
      'lambda',
    ] as const) {
      await submitPersistentVm(
        target,
        {
          environmentMarker: `environment-${target}`,
          image: 'alpine:3.20',
          ref: trackedWorkloadRefForTest(`vm-${target}`),
          secretName: `secret-${target}`,
        },
        dependencies,
      );
    }

    expect(commandCalls).toHaveLength(5);
    expect(commandCalls[0]).toEqual({
      target: 'vm-local-smolvm',
      label: 'local-smolvm-persistent-vm-submission',
      args: [
        'vm',
        '--id',
        'vm-local-smolvm',
        '--env',
        'VM_SMOKE_ENV_MARKER=environment-local-smolvm',
        '--secret',
        'secret-local-smolvm',
        'alpine:3.20',
      ],
    });
    expect(profileCalls).toEqual(['aws', 'azure', 'gcp', 'lambda']);
    expect(credentialCalls).toEqual([
      'aws-test',
      'azure-test',
      'gcp-test',
      'lambda-test',
    ]);
    for (const call of commandCalls.slice(1)) {
      // The image is the positional, after every flag.
      expect(call.args.slice(0, 7)).toEqual([
        'vm',
        '--id',
        call.target,
        '--env',
        `VM_SMOKE_ENV_MARKER=environment-${call.target.slice(3)}`,
        '--secret',
        `secret-${call.target.slice(3)}`,
      ]);
      expect(call.args.at(-1)).toBe('alpine:3.20');
      expect(call.args).toContain('--credentials');
      expect(call.args).toContain('--vm-type');
      expect(call.args).toContain('--region');
      expect(call.args).toContain('--disk-size');
      expect(call.args).not.toContain('--cluster');
    }
  });

  const profile: VmProfile = {
    slug: 'aws',
    provider: CloudType.AWS,
    credentialName: 'owned-credential',
    credential: {
      cloudProvider: CloudType.AWS,
      accessKeyId: 'explicit-access',
      secretAccessKey: 'explicit-secret',
    },
    vmTypes: ['t3.small', 't3.medium'],
  };

  test('does not submit when saving the credential fails', async () => {
    const failure = new Error('credential save failed');
    const create = vi
      .fn<WorkloadCliCreateTransport['runCliCreateWithTransientRetries']>()
      .mockResolvedValue(undefined);
    await expect(
      submitPersistentVm(
        'aws',
        {
          ref: trackedWorkloadRefForTest('vm-save-failed'),
          image: 'alpine:3.20',
          environmentMarker: 'marker',
          secretName: 'secret',
        },
        {
          credentials: {
            save: async () => {
              throw failure;
            },
          },
          profiles: { vm: () => profile },
          mutations: { runCliCreateWithTransientRetries: create },
        },
      ),
    ).rejects.toBe(failure);
    expect(create).not.toHaveBeenCalled();
  });
});

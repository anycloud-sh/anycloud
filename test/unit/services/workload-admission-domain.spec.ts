import { describe, expect, it, vi } from 'vitest';
import type { User } from '../../../src/api/services/entities.js';
import { CloudType } from '../../../src/shared/cloud.js';
import type { WorkloadAdmissionInput } from '../../../src/shared/api-contract/workload-admission-schemas.js';
import {
  createWorkloadAdmissionDomain,
  type WorkloadAdmissionDomainDependencies,
} from '../../../src/api/services/workload-admission-domain.js';

const actor: User = {
  id: 'owner-1',
  username: 'alice',
  token: 'github-token',
};

/** The test's resolve stands for VM-host admission past the flag checks. */
const RESOLVED = 'resolve reached';

function dependencies(): WorkloadAdmissionDomainDependencies {
  return {
    resolve: vi.fn(async () => {
      throw new Error(RESOLVED);
    }),
    prepare: vi.fn(async () => {
      throw new Error('prepare must not run');
    }),
    persist: vi.fn(async () => ({ id: 'vm-host' })),
    recordEvent: vi.fn(),
    now: () => 1000,
  };
}

describe('workload admission domain dispatch', () => {
  const image = 'ghcr.io/acme/ci:1';
  const notJobs = [
    { workloadType: 'service' as const },
    { workloadType: 'vm' as const },
  ];

  it.each<[string, Partial<WorkloadAdmissionInput>, string]>([
    ['--max-retries', { maxRetries: 0 }, '--max-retries applies only to a Job'],
    [
      '--require-nested-virtualization',
      { requireNestedVirtualization: true },
      '--require-nested-virtualization applies only to a Job',
    ],
    [
      '--regions',
      { cloudConfig: { regions: ['us-east-1', 'us-west-2'] } },
      '--regions applies only to a Job',
    ],
    [
      '--disk-iops',
      { cloudConfig: { diskIops: 3000 } },
      '--disk-iops/--disk-throughput apply only to a Job',
    ],
    [
      '--disk-throughput',
      { cloudConfig: { diskThroughputMibps: 500 } },
      '--disk-iops/--disk-throughput apply only to a Job',
    ],
    [
      '--host-docker',
      { hostDocker: true },
      '--host-docker applies only to a Job',
    ],
    [
      '--no-checkpoint',
      { noCheckpoint: true },
      '--no-checkpoint applies only to a Job',
    ],
  ])(
    'refuses %s outside a Job, and passes it on for a Job',
    async (_flag, flags, refusal) => {
      const deps = dependencies();
      const { submit } = createWorkloadAdmissionDomain(deps);
      const input = { image, cloudConfig: {}, ...flags };
      for (const target of notJobs)
        await expect(
          submit(actor, { ...input, ...target }, '0.0.0'),
        ).rejects.toThrow(refusal);
      expect(deps.resolve).not.toHaveBeenCalled();
      await expect(submit(actor, input, '0.0.0')).rejects.toThrow(RESOLVED);
    },
  );

  it('refuses --regions with --region or --zone, and --host-docker with --privileged', async () => {
    const deps = dependencies();
    const { submit } = createWorkloadAdmissionDomain(deps);
    const regions = ['us-east-1', 'us-west-2'];
    for (const cloudConfig of [
      { regions, region: 'us-east-1' },
      { regions, availabilityZone: 'us-east-1a' },
    ])
      await expect(
        submit(actor, { image, cloudConfig }, '0.0.0'),
      ).rejects.toThrow('--regions takes neither --region nor --zone');
    await expect(
      submit(
        actor,
        {
          image,
          cloudConfig: {},
          hostDocker: true,
          dockerOptions: { privileged: true },
        },
        '0.0.0',
      ),
    ).rejects.toThrow('--host-docker replaces --privileged');
    expect(deps.resolve).not.toHaveBeenCalled();
  });

  const vmHostJob: WorkloadAdmissionInput = {
    image: 'ghcr.io/acme/train:v1',
    cloudConfig: {},
    gpuType: 'h100:4',
  };

  it('0046/S20 admits a VM-host Job with default Job spec fields or a matching --gpus-per-node', async () => {
    const specs: Partial<WorkloadAdmissionInput>[] = [
      { nodes: 1, launch: 'single', mounts: [], resumable: false },
      { gpusPerNode: 4 },
      { gpusPerNode: 1, gpuType: 'h100' },
    ];
    for (const spec of specs) {
      const deps = dependencies();
      deps.resolve = vi.fn().mockResolvedValue({});
      deps.prepare = vi.fn().mockResolvedValue({});
      await expect(
        createWorkloadAdmissionDomain(deps).submit(
          actor,
          { ...vmHostJob, ...spec },
          '0.0.0',
        ),
      ).resolves.toEqual({ id: 'vm-host' });
      expect(deps.persist).toHaveBeenCalledOnce();
    }
  });

  const vmTypeJob = (
    vmType: string | string[],
    gpusPerNode: number,
  ): WorkloadAdmissionInput => ({
    image: 'ghcr.io/acme/train:v1',
    cloudConfig: { vmType },
    gpusPerNode,
  });

  function resolvingTo(vmType: string): WorkloadAdmissionDomainDependencies {
    const deps = dependencies();
    deps.resolve = vi.fn().mockResolvedValue({
      cloudConfig: { cloudProvider: CloudType.AWS, vmType },
    });
    deps.prepare = vi.fn().mockResolvedValue({});
    return deps;
  }

  it('admits a --vm-type GPU Job whose --gpus-per-node equals the catalog count', async () => {
    const deps = resolvingTo('g6e.12xlarge');
    await expect(
      createWorkloadAdmissionDomain(deps).submit(
        actor,
        vmTypeJob('g6e.12xlarge', 4),
        '0.0.0',
      ),
    ).resolves.toEqual({ id: 'vm-host' });
    expect(deps.persist).toHaveBeenCalledOnce();
  });

  it.each<[string, number, string]>([
    ['g6e.xlarge', 2, 'gpusPerNode 2 \\(--gpus-per-node\\) other than 1'],
    ['m5.large', 1, 'gpusPerNode 1 \\(--gpus-per-node\\) yet'],
  ])(
    'refuses --vm-type %s with --gpus-per-node %d before preparing anything',
    async (vmType, gpusPerNode, refusal) => {
      const deps = resolvingTo(vmType);
      await expect(
        createWorkloadAdmissionDomain(deps).submit(
          actor,
          vmTypeJob(vmType, gpusPerNode),
          '0.0.0',
        ),
      ).rejects.toThrow(new RegExp(`^A Job on a VM host .*${refusal}`));
      expect(deps.prepare).not.toHaveBeenCalled();
      expect(deps.persist).not.toHaveBeenCalled();
    },
  );

  it('refuses --gpus-per-node with several --vm-type values before resolving', async () => {
    const deps = dependencies();
    await expect(
      createWorkloadAdmissionDomain(deps).submit(
        actor,
        vmTypeJob(['g6e.xlarge', 'g6.xlarge'], 1),
        '0.0.0',
      ),
    ).rejects.toThrow(/^A Job on a VM host .*gpusPerNode 1/);
    expect(deps.resolve).not.toHaveBeenCalled();
  });

  it.each<[Partial<WorkloadAdmissionInput>, string]>([
    [{ nodes: 2 }, 'A Job on a VM host .*nodes 2 \\(--nodes\\)'],
    [{ launch: 'distributed' }, 'A Job on a VM host .*launch distributed'],
    [
      { mounts: [{ name: '/data', path: '/data', ro: true }] },
      'A Job on a VM host .*mounts',
    ],
    [{ timeLimit: 86_400 }, 'A Job on a VM host .*timeLimit'],
    [{ resumable: true }, 'A Job on a VM host .*resumable'],
    [{ gpusPerNode: 8 }, 'A Job on a VM host .*gpusPerNode 8 .*other than 4'],
    [
      { gpusPerNode: 1, gpuType: undefined },
      'A Job on a VM host .*gpusPerNode 1',
    ],
    [
      { gpusPerNode: 4, gpuType: ['h100:4', 'a100:4'] },
      'A Job on a VM host .*gpusPerNode 4',
    ],
    [
      { gpusPerNode: 4, dockerOptions: { gpus: 'all' } },
      'A Job on a VM host .*gpusPerNode 4',
    ],
    [
      { workloadType: 'service', resumable: true },
      'A Service on a VM host .*resumable',
    ],
  ])(
    '0046/S21 refuses %j on a VM host before resolving or storing anything',
    async (spec, refusal) => {
      const deps = dependencies();
      await expect(
        createWorkloadAdmissionDomain(deps).submit(
          actor,
          { ...vmHostJob, ...spec },
          '0.0.0',
        ),
      ).rejects.toThrow(new RegExp(`^${refusal}`));
      expect(deps.resolve).not.toHaveBeenCalled();
      expect(deps.persist).not.toHaveBeenCalled();
    },
  );
});

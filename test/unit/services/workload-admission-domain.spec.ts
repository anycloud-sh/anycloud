import { describe, expect, it, vi } from 'vitest';
import type { User } from '../../../src/api/services/entities.js';
import { CloudType } from '../../../src/shared/cloud.js';
import type { DedicatedWorkloadAdmissionInput } from '../../../src/shared/api-contract/workload-admission-schemas.js';
import {
  createWorkloadAdmissionDomain,
  type WorkloadAdmissionDomainDependencies,
} from '../../../src/api/services/workload-admission-domain.js';

const actor: User = {
  id: 'owner-1',
  username: 'alice',
  token: 'github-token',
};

function dependencies(): WorkloadAdmissionDomainDependencies {
  return {
    resolve: vi.fn(async () => {
      throw new Error('resolve must not run for a node pool request');
    }),
    prepare: vi.fn(async () => {
      throw new Error('prepare must not run for a node pool request');
    }),
    persist: vi.fn(async () => ({ id: 'vm-host' })),
    submitTargeted: vi.fn(async () => ({ id: 'targeted' })),
    submitNodePoolService: vi.fn(async () => ({ id: 'svc-a' })),
    submitPoolJob: vi.fn(async () => ({ id: 'pool-job' })),
    recordEvent: vi.fn(),
    now: () => 1000,
    workloadApiUrl: () => 'https://api.example.com',
  };
}

const loopbackRefusal =
  "Pods can't reach this API to claim Jobs: its workload URL http://localhost:8080 is loopback. Run Deployments and Jobs on node pools through the cluster's API: `anycloud api use https://<cluster-id>.anycloud.sh`.";

describe('workload admission domain dispatch', () => {
  it('routes a node-pool-targeted request to node pool Service admission and records the target', async () => {
    const deps = dependencies();
    const domain = createWorkloadAdmissionDomain(deps);
    const input = {
      image: 'ghcr.io/acme/api:v1',
      cloudConfig: {},
      workloadType: 'service' as const,
      nodePool: 'aws-east',
      env: { MODE: 'prod' },
    };
    await expect(domain.submit(actor, input, '0.0.0')).resolves.toEqual({
      id: 'svc-a',
    });
    expect(deps.submitNodePoolService).toHaveBeenCalledWith(
      actor,
      input,
      undefined,
    );
    expect(deps.resolve).not.toHaveBeenCalled();
    expect(deps.recordEvent).toHaveBeenCalledWith(
      actor,
      'new',
      expect.objectContaining({
        id: 'svc-a',
        workloadType: 'service',
        targetNodePool: 'aws-east',
        targetDeployment: undefined,
        envCount: 1,
      }),
    );
  });

  it('routes a Job with a node pool to pool Job admission', async () => {
    const deps = dependencies();
    const input = {
      image: 'ghcr.io/acme/train:v1',
      cloudConfig: {},
      nodePool: 'aws-east',
    };
    await expect(
      createWorkloadAdmissionDomain(deps).submit(actor, input, '0.0.0'),
    ).resolves.toEqual({ id: 'pool-job' });
    expect(deps.submitPoolJob).toHaveBeenCalledWith(actor, input, undefined);
    expect(deps.submitNodePoolService).not.toHaveBeenCalled();
  });

  it('refuses --max-retries outside a Job', async () => {
    const deps = dependencies();
    for (const input of [
      {
        image: 'ghcr.io/acme/api:v1',
        cloudConfig: {},
        nodePool: 'aws-east',
        workloadType: 'service' as const,
        maxRetries: 0,
      },
      {
        image: 'ghcr.io/acme/box:v1',
        cloudConfig: {},
        workloadType: 'vm' as const,
        maxRetries: 2,
      },
    ]) {
      await expect(
        createWorkloadAdmissionDomain(deps).submit(actor, input, '0.0.0'),
      ).rejects.toThrow('--max-retries applies only to a Job');
    }
    expect(deps.resolve).not.toHaveBeenCalled();
    expect(deps.submitNodePoolService).not.toHaveBeenCalled();
  });

  it('admits --require-nested-virtualization only on a Job on a VM', async () => {
    const deps = dependencies();
    const { submit } = createWorkloadAdmissionDomain(deps);
    for (const input of [
      {
        image: 'ghcr.io/acme/ci:1',
        cloudConfig: {},
        nodePool: 'aws-east',
        requireNestedVirtualization: true,
      },
      {
        image: 'ghcr.io/acme/box:1',
        cloudConfig: {},
        workloadType: 'vm' as const,
        requireNestedVirtualization: true,
      },
    ])
      await expect(submit(actor, input, '0.0.0')).rejects.toThrow(
        '--require-nested-virtualization applies only to a Job on a VM',
      );
    expect(deps.resolve).not.toHaveBeenCalled();
    // A VM Job passes the flag checks on to VM-host admission.
    await expect(
      submit(
        actor,
        {
          image: 'ghcr.io/acme/ci:1',
          cloudConfig: {},
          requireNestedVirtualization: true,
        },
        '0.0.0',
      ),
    ).rejects.toThrow('resolve must not run for a node pool request');
  });

  it('admits --regions only on a Job on a VM, and never with --region or --zone', async () => {
    const deps = dependencies();
    const { submit } = createWorkloadAdmissionDomain(deps);
    const image = 'ghcr.io/acme/ci:1';
    const regions = ['us-east-1', 'us-west-2'];
    for (const target of [
      { nodePool: 'aws-east' },
      { workloadType: 'vm' as const },
      { workloadType: 'service' as const },
    ])
      await expect(
        submit(actor, { image, cloudConfig: { regions }, ...target }, '0.0.0'),
      ).rejects.toThrow('--regions applies only to a Job on a VM');
    for (const cloudConfig of [
      { regions, region: 'us-east-1' },
      { regions, availabilityZone: 'us-east-1a' },
    ])
      await expect(
        submit(actor, { image, cloudConfig }, '0.0.0'),
      ).rejects.toThrow('--regions takes neither --region nor --zone');
    expect(deps.resolve).not.toHaveBeenCalled();
  });

  it('admits --host-docker only on a Job on a VM, never with --privileged', async () => {
    const deps = dependencies();
    const { submit } = createWorkloadAdmissionDomain(deps);
    const image = 'ghcr.io/acme/ci:1';
    for (const input of [
      { image, cloudConfig: {}, nodePool: 'aws-east', hostDocker: true },
      { image, cloudConfig: {}, workloadType: 'vm' as const, hostDocker: true },
      {
        image,
        cloudConfig: {},
        workloadType: 'service' as const,
        hostDocker: true,
      },
      {
        image,
        cloudConfig: {},
        workloadType: 'service' as const,
        nodePool: 'aws-east',
        hostDocker: true,
      },
    ])
      await expect(submit(actor, input, '0.0.0')).rejects.toThrow(
        '--host-docker applies only to a Job on a VM',
      );
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
    expect(deps.submitPoolJob).not.toHaveBeenCalled();
    expect(deps.submitNodePoolService).not.toHaveBeenCalled();
    await expect(
      submit(actor, { image, cloudConfig: {}, hostDocker: true }, '0.0.0'),
    ).rejects.toThrow('resolve must not run for a node pool request');
  });

  it('admits --disk-iops and --disk-throughput only on a Job on a VM', async () => {
    const deps = dependencies();
    const { submit } = createWorkloadAdmissionDomain(deps);
    const image = 'ghcr.io/acme/ci:1';
    for (const cloudConfig of [
      { diskIops: 3000 },
      { diskThroughputMibps: 500 },
    ])
      for (const target of [
        { nodePool: 'aws-east' },
        { workloadType: 'vm' as const },
        { workloadType: 'service' as const },
      ])
        await expect(
          submit(actor, { image, cloudConfig, ...target }, '0.0.0'),
        ).rejects.toThrow(
          '--disk-iops/--disk-throughput apply only to a Job on a VM',
        );
    expect(deps.resolve).not.toHaveBeenCalled();
    expect(deps.submitPoolJob).not.toHaveBeenCalled();
  });

  it('admits --max-retries and --no-checkpoint on a VM Job', async () => {
    const deps = dependencies();
    const input = {
      image: 'ghcr.io/acme/train:v1',
      cloudConfig: {},
      maxRetries: 0,
      noCheckpoint: true,
    };
    // The test's resolve stands for VM-host admission past the flag checks.
    await expect(
      createWorkloadAdmissionDomain(deps).submit(actor, input, '0.0.0'),
    ).rejects.toThrow('resolve must not run for a node pool request');
    expect(deps.resolve).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'a Job on a node pool',
      { image: 'ghcr.io/acme/train:v1', cloudConfig: {}, nodePool: 'aws-east' },
    ],
    ['a Job on a Deployment', { deployment: 'model-deployments' }],
  ])(
    'refuses %s when replicas would claim from a loopback URL',
    async (_name, input) => {
      const deps = {
        ...dependencies(),
        workloadApiUrl: () => 'http://localhost:8080',
      };
      await expect(
        createWorkloadAdmissionDomain(deps).submit(actor, input, '0.0.0'),
      ).rejects.toMatchObject({ statusCode: 400, message: loopbackRefusal });
      expect(deps.submitPoolJob).not.toHaveBeenCalled();
      expect(deps.submitTargeted).not.toHaveBeenCalled();
    },
  );

  it('admits a Service on a node pool from a loopback URL, since nothing claims', async () => {
    const deps = {
      ...dependencies(),
      workloadApiUrl: () => 'http://localhost:8080',
    };
    await expect(
      createWorkloadAdmissionDomain(deps).submit(
        actor,
        {
          image: 'ghcr.io/acme/api:v1',
          cloudConfig: {},
          workloadType: 'service',
          nodePool: 'aws-east',
        },
        '0.0.0',
      ),
    ).resolves.toEqual({ id: 'svc-a' });
  });

  it('refuses --no-checkpoint outside a Job and --cache outside a Job on a node pool', async () => {
    const deps = dependencies();
    const service = {
      image: 'ghcr.io/acme/api:v1',
      cloudConfig: {},
      nodePool: 'aws-east',
      workloadType: 'service' as const,
    };
    const vmJob = { image: 'ghcr.io/acme/train:v1', cloudConfig: {} };
    const { submit } = createWorkloadAdmissionDomain(deps);
    const cases: Array<[Parameters<typeof submit>[1], string]> = [
      [
        { ...service, noCheckpoint: true },
        '--no-checkpoint applies only to a Job',
      ],
      [
        { ...vmJob, caches: ['pip:/root/.cache/pip'] },
        '--cache applies only to a Job on a node pool',
      ],
      [
        { ...service, caches: ['pip:/root/.cache/pip'] },
        '--cache applies only to a Job on a node pool',
      ],
    ];
    for (const [input, message] of cases) {
      await expect(submit(actor, input, '0.0.0')).rejects.toThrow(message);
    }
    expect(deps.resolve).not.toHaveBeenCalled();
    expect(deps.submitNodePoolService).not.toHaveBeenCalled();
  });

  it('refuses --timeout outside a Job on a node pool', async () => {
    const deps = dependencies();
    for (const input of [
      { image: 'ghcr.io/acme/train:v1', cloudConfig: {}, timeout: 60 },
      {
        image: 'ghcr.io/acme/api:v1',
        cloudConfig: {},
        nodePool: 'aws-east',
        workloadType: 'service' as const,
        timeout: 60,
      },
    ]) {
      await expect(
        createWorkloadAdmissionDomain(deps).submit(actor, input, '0.0.0'),
      ).rejects.toThrow(
        '--timeout applies only to a Job on a node pool or a Deployment',
      );
    }
    expect(deps.submitNodePoolService).not.toHaveBeenCalled();
  });

  it('still routes Deployment targets to targeted Job admission', async () => {
    const deps = dependencies();
    const domain = createWorkloadAdmissionDomain(deps);
    await expect(
      domain.submit(actor, { deployment: 'model-a' }, '0.0.0'),
    ).resolves.toEqual({ id: 'targeted' });
    expect(deps.submitNodePoolService).not.toHaveBeenCalled();
    expect(deps.recordEvent).toHaveBeenCalledWith(
      actor,
      'new',
      expect.objectContaining({
        targetDeployment: 'model-a',
        targetNodePool: undefined,
      }),
    );
  });

  const vmHostJob: DedicatedWorkloadAdmissionInput = {
    image: 'ghcr.io/acme/train:v1',
    cloudConfig: {},
    gpuType: 'h100:4',
  };

  it('0046/S20 admits a VM-host Job with default Job spec fields or a matching --gpus-per-node', async () => {
    const specs: Partial<DedicatedWorkloadAdmissionInput>[] = [
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
  ): DedicatedWorkloadAdmissionInput => ({
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

  it.each<[Partial<DedicatedWorkloadAdmissionInput>, string]>([
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

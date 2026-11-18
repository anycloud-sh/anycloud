import { describe, expect, it } from 'vitest';
import { CloudType } from '../../../../src/shared/cloud';
import {
  nodePoolNodeSize,
  normalizeKubernetesCpus,
  normalizeKubernetesMemory,
  normalizeKubernetesShmSize,
  replicaSize,
  resolveKubernetesRuntimeClass,
  validateKubernetesDockerOptions,
} from '../../../../src/api/services/kubernetes/pod-options';

describe('Kubernetes Pod Docker options', () => {
  it('normalizes supported memory and shared-memory options', () => {
    expect(normalizeKubernetesShmSize('32g')).toBe('32Gi');
    expect(normalizeKubernetesShmSize('67108864')).toBe('67108864');
    expect(normalizeKubernetesMemory('1024m')).toBe('1Gi');
    expect(normalizeKubernetesShmSize('1500')).toBe('1500');
    expect(normalizeKubernetesMemory('1000000000')).toBe('1G');
    expect(normalizeKubernetesMemory('64000000')).toBe('64M');
    // The API server's canonical CPU form: whole cores, else millicores.
    expect(
      ['2', '0.5', '1.5', '0.001'].map((cpus) => normalizeKubernetesCpus(cpus)),
    ).toEqual(['2', '500m', '1500m', '1m']);
    expect(normalizeKubernetesMemory('32g')).toBe('32Gi');
    expect(() =>
      validateKubernetesDockerOptions({
        gpus: '8',
        shmSize: '32g',
        memory: '80g',
        cpus: '12',
        runtime: 'nvidia',
      }),
    ).not.toThrow();
  });

  it.each([
    ['--ipc', { ipc: 'host' }],
    ['--ulimit', { ulimits: ['memlock=-1'] }],
    ['--network', { network: 'host' }],
  ])(
    'rejects unsupported %s instead of silently dropping it',
    (flag, options) => {
      expect(() =>
        validateKubernetesDockerOptions(options, 'Kubernetes Serve'),
      ).toThrow(`Kubernetes Serve does not support ${flag} yet.`);
    },
  );

  it('accepts disposable volumes and rejects host binds', () => {
    expect(() =>
      validateKubernetesDockerOptions({ binds: ['/models'] }),
    ).not.toThrow();
    expect(() =>
      validateKubernetesDockerOptions({ binds: ['/models:/models'] }),
    ).toThrow('only supports anonymous --bind');
  });

  it('rejects invalid shared-memory values', () => {
    expect(() => normalizeKubernetesShmSize('0g')).toThrow(/positive integer/);
  });

  it('rejects explicit runc when GPU injection requires NVIDIA runtime', () => {
    expect(() =>
      resolveKubernetesRuntimeClass({ gpus: 'all', runtime: 'runc' }, 1),
    ).toThrow('omit --runtime or use --runtime nvidia');
  });

  it('requires an allocation before enabling the NVIDIA runtime', () => {
    expect(() =>
      resolveKubernetesRuntimeClass({ runtime: 'nvidia' }, 0),
    ).toThrow('requires a verified GPU allocation');
  });

  it('sizes a pool by its smallest VM type, which every Node can hold', () => {
    // g5.2xlarge: 8 vCPUs, 32 GiB; g5.xlarge: 4 vCPUs, 16 GiB; one A10G each.
    expect(
      nodePoolNodeSize({
        cloudProvider: CloudType.AWS,
        vmTypes: ['g5.2xlarge', 'g5.xlarge'],
      }),
    ).toEqual({ vCPUs: 4, memoryGiB: 16 });
    // A CPU type is sized too: m5.4xlarge has 16 vCPUs and 64 GiB.
    expect(
      nodePoolNodeSize({
        cloudProvider: CloudType.AWS,
        vmTypes: ['m5.4xlarge'],
      }),
    ).toEqual({ vCPUs: 16, memoryGiB: 64 });
    expect(
      nodePoolNodeSize({
        cloudProvider: CloudType.AWS,
        vmTypes: ['g5.xlarge', 'not-a-type'],
      }),
    ).toBeUndefined();
  });

  it("caps a default replica's memory and its limit at a Node's allocatable", () => {
    // A 1-vCPU, 1 GiB Node allocates about 850 MiB: MemTotal less the
    // kubelet's 100 MiB eviction threshold. 90% of the VM, 921 MiB, would
    // stay Pending, so the replica takes 1024 − 256 − 100 MiB.
    for (const [cloudProvider, vmType] of [
      [CloudType.AWS, 't2.micro'],
      [CloudType.Azure, 'Standard_B1s'],
    ] as const) {
      const size = nodePoolNodeSize({ cloudProvider, vmTypes: [vmType] });
      expect(size).toEqual({ vCPUs: 1, memoryGiB: 1 });
      expect(replicaSize(size, 0, 0, undefined)).toEqual({
        cpus: '1',
        memory: '668m',
        memoryLimit: '668m',
      });
    }
    // A VM type missing from the catalog gets 1 GiB, and with --cpus that is
    // the limit too, so the replica is Guaranteed (C30).
    expect(replicaSize(undefined, 0, 0, undefined)).toEqual({
      cpus: '1',
      memory: '1024m',
    });
    expect(replicaSize(undefined, 0, 0, '2')).toEqual({
      cpus: '2',
      memory: '1024m',
      memoryLimit: '1024m',
    });
    // A larger Node keeps its 90% share: 1 vCPU of 2 on 8 GiB.
    expect(
      replicaSize({ vCPUs: 2, memoryGiB: 8 }, 0, 0, undefined).memory,
    ).toBe('3686m');
    // Below 512 MiB of allocatable, the floored limit is the allocatable:
    // GCP f1-micro, 0.6 GiB, allocates 614 − 356 MiB. With --cpus the request
    // is the limit (C30), not the 55 MiB share.
    const f1Micro = nodePoolNodeSize({
      cloudProvider: CloudType.GCP,
      vmTypes: ['f1-micro'],
    });
    expect(replicaSize(f1Micro, 0, 0, '0.1')).toEqual({
      cpus: '0.1',
      memory: '258m',
      memoryLimit: '258m',
    });
  });

  it('RFC 0049 C32 leaves room for a Pod overhead wherever the allocatable cap binds', () => {
    const t2Micro = { vCPUs: 1, memoryGiB: 1 };
    const t3Small = { vCPUs: 2, memoryGiB: 2 };
    const sizes = (overheadMi: number) => ({
      // The default share, which the cap binds on a 1 GiB type only.
      defaultShare: replicaSize(t2Micro, 0, 0, undefined, overheadMi),
      wideDefault: replicaSize(t3Small, 0, 0, undefined, overheadMi),
      // --cpus below every vCPU, and at every vCPU, where 90% of the VM is
      // more than its allocatable.
      someCpus: replicaSize(t3Small, 0, 0, '1', overheadMi),
      everyCpu: replicaSize(t3Small, 0, 0, '2', overheadMi),
    });
    expect(sizes(0)).toEqual({
      defaultShare: { cpus: '1', memory: '668m', memoryLimit: '668m' },
      wideDefault: { cpus: '1', memory: '921m', memoryLimit: '921m' },
      someCpus: { cpus: '1', memory: '921m', memoryLimit: '921m' },
      everyCpu: { cpus: '2', memory: '1692m', memoryLimit: '1692m' },
    });
    expect(sizes(32)).toEqual({
      defaultShare: { cpus: '1', memory: '636m', memoryLimit: '636m' },
      wideDefault: { cpus: '1', memory: '921m', memoryLimit: '921m' },
      someCpus: { cpus: '1', memory: '921m', memoryLimit: '921m' },
      everyCpu: { cpus: '2', memory: '1660m', memoryLimit: '1660m' },
    });
  });
});

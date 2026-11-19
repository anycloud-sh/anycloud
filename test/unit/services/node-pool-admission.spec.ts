import { describe, expect, it, vi } from 'vitest';
import type { StoredNodePool } from '../../../src/api/services/cluster-store.js';
import {
  assertNodePoolImage,
  assertNodePoolVmTypes,
  assertUserNamespaceVmTypes,
  nestedVirtualizationVmTypes,
  resolveReadyNodePool,
  type NodePoolRefusal,
} from '../../../src/api/services/node-pool-admission.js';
import { CloudType, DiskTier } from '../../../src/shared/cloud.js';
import {
  getRegionsForVMType,
  nestedVirtualizationSupport,
} from '../../../src/shared/cloud-config.js';
import {
  ImageInspectionFailureReason,
  ImageRuntime,
  ImageVerdict,
} from '../../../src/shared/image.js';
import { NodePoolState } from '../../../src/shared/node-pools.js';

const scope = { kind: 'api' } as const;

function pool(state: NodePoolState): StoredNodePool {
  const nodePool: StoredNodePool = {
    id: 'np-1',
    clusterId: 'cluster-a',
    ownerUserId: 'owner',
    name: 'gpu',
    state,
    computeCredentialId: 'cred',
    cloudProvider: CloudType.AWS,
    region: 'us-east-1',
    zone: null,
    clusterRegion: null,
    vmTypes: ['g4dn.xlarge'],
    minVmCount: 1,
    maxVmCount: 1,
    osDiskSizeGb: null,
    osDiskTier: null,
    spot: false,
    allowPrivilegedJobs: false,
    userNamespaceJobs: false,
    requireNestedVirtualization: false,
    lastError: null,
    provisioningFailures: 0,
    provisioningFailedAt: null,
    ingressEntryVmId: null,
    ingressEntryChangedAt: null,
    createdAt: 1,
    updatedAt: 1,
  };
  return nodePool;
}

describe('node pool admission', () => {
  it('resolves by id, then by name, and hands every other state to the caller to word', async () => {
    const refuse = vi.fn((refusal: NodePoolRefusal) => new Error(refusal.kind));
    const lookup = (found: StoredNodePool | null, byName = found) => ({
      getForScope: vi.fn(async (id: string) => (id === 'np-1' ? found : null)),
      getByNameForScope: vi.fn(async () => byName),
    });
    const ready = pool(NodePoolState.Ready);
    await expect(
      resolveReadyNodePool(lookup(ready), 'np-1', scope, refuse),
    ).resolves.toBe(ready);
    await expect(
      resolveReadyNodePool(lookup(null, ready), 'gpu', scope, refuse),
    ).resolves.toBe(ready);
    await expect(
      resolveReadyNodePool(lookup(null), 'gpu', scope, refuse),
    ).rejects.toThrow('missing');
    for (const state of [
      NodePoolState.Creating,
      NodePoolState.Failed,
      NodePoolState.Deleting,
      NodePoolState.Deleted,
    ]) {
      const nodePool = pool(state);
      await expect(
        resolveReadyNodePool(lookup(nodePool), 'np-1', scope, refuse),
      ).rejects.toThrow(state);
      expect(refuse).toHaveBeenLastCalledWith({ kind: state, nodePool });
    }
  });

  it('refuses what the registry rejects with one wording, and images the pool VMs cannot run', () => {
    const inspection = (
      verdict: ImageVerdict,
      failureReason?: ImageInspectionFailureReason,
      imageRuntime = ImageRuntime.Unknown,
    ) => ({
      verdict,
      amd64Digest: null,
      imageRuntime,
      compressedLayerBytes: null,
      failureReason,
    });
    const cuda = pool(NodePoolState.Ready);
    const check = (i: ReturnType<typeof inspection>) => () =>
      assertNodePoolImage('ghcr.io/a/b', i, cuda);
    expect(check(inspection(ImageVerdict.Ok))).not.toThrow();
    expect(check(inspection(ImageVerdict.NotFound))).toThrow(
      'Image "ghcr.io/a/b" not found',
    );
    expect(check(inspection(ImageVerdict.NoAmd64))).toThrow('amd64');
    expect(check(inspection(ImageVerdict.Unauthorized))).toThrow(
      'For a private GHCR image, run `anycloud login`',
    );
    // A GitHub App sign-in keeps no GitHub token, so its pull is refused here.
    expect(
      check(
        inspection(
          ImageVerdict.Unauthorized,
          ImageInspectionFailureReason.GhcrSignInRequired,
        ),
      ),
    ).toThrow(
      'a GitHub App sign-in or a service token pulls only public images',
    );
    expect(
      check(
        inspection(
          ImageVerdict.Unauthorized,
          ImageInspectionFailureReason.GhcrTokenExchangeFailed,
        ),
      ),
    ).toThrow(
      'Can\'t access image "ghcr.io/a/b". To sign in again, run `anycloud login` (`anycloud login <api-url>` on a hosted API), and verify that the token can read this GHCR package.',
    );
    expect(
      check(inspection(ImageVerdict.Ok, undefined, ImageRuntime.Rocm)),
    ).toThrow('Image requires a ROCM GPU runtime incompatible');
  });

  it.each([
    [CloudType.AWS, ['t3.large', 't3.xlarge']],
    [CloudType.AWS, ['g5.xlarge', 'g6.xlarge']],
    [CloudType.Lambda, ['gpu_1x_a10', 'gpu_1x_a100_sxm4']],
  ])('admits %s VM types %j that share one accelerator', (cloud, vmTypes) => {
    expect(() => assertNodePoolVmTypes(cloud, vmTypes)).not.toThrow();
  });

  it.each([
    [
      ['t3.large', 'g5.xlarge'],
      /t3.large has no GPU, g5.xlarge has 1 NVIDIA GPUs/,
    ],
    [
      ['g5.xlarge', 'g5.12xlarge'],
      /g5.xlarge has 1 NVIDIA GPUs, g5.12xlarge has 4/,
    ],
    [['t3.large', 'zz.unknown'], /AWS does not offer VM type "zz.unknown"$/],
    // The catalog offers g6.xlarge elsewhere, but not in the pinned region.
    [
      ['g5.xlarge', 'g6.xlarge'],
      /AWS does not offer VM type "g6.xlarge" in eu-west-1/,
      'eu-west-1',
    ],
  ])('refuses VM types %j', (vmTypes, message, region?: string) => {
    expect(() => assertNodePoolVmTypes(CloudType.AWS, vmTypes, region)).toThrow(
      message,
    );
  });

  it('C10 keeps the VM types with catalog-reported nested virtualization in the pool region, or anywhere when unpinned', () => {
    const regions = getRegionsForVMType('m7i.large', CloudType.AWS);
    const where = (support: boolean | null) =>
      regions.find(
        (region) =>
          nestedVirtualizationSupport(CloudType.AWS, 'm7i.large', region) ===
          support,
      );
    // The premise, from catalog data: m7i.large is supported in one region
    // and unknown in another; t3.large is supported nowhere.
    const [supported, unknown] = [where(true), where(null)];
    expect(supported && unknown).toBeTruthy();
    expect(nestedVirtualizationSupport(CloudType.AWS, 't3.large')).not.toBe(
      true,
    );

    const vmTypes = ['t3.large', 'm7i.large'];
    expect(
      nestedVirtualizationVmTypes(CloudType.AWS, vmTypes, supported),
    ).toEqual(['m7i.large']);
    expect(nestedVirtualizationVmTypes(CloudType.AWS, vmTypes)).toEqual([
      'm7i.large',
    ]);
    // Unknown support counts as none.
    expect(() =>
      nestedVirtualizationVmTypes(CloudType.AWS, vmTypes, unknown),
    ).toThrow(
      `--require-nested-virtualization: the AWS catalog reports nested virtualization for none of t3.large, m7i.large in ${unknown}`,
    );
    expect(() =>
      nestedVirtualizationVmTypes(CloudType.AWS, ['t3.large']),
    ).toThrow(/none of t3.large;/);
  });

  it('RFC 0049 C32 admits user-namespace Jobs on CPU VM types only', () => {
    expect(() =>
      assertUserNamespaceVmTypes(CloudType.AWS, ['m7i.xlarge']),
    ).not.toThrow();
    expect(() =>
      assertUserNamespaceVmTypes(CloudType.AWS, ['g5.xlarge']),
    ).toThrow(
      '--user-namespace-jobs needs CPU VM types; AWS VM type "g5.xlarge" has GPUs',
    );
  });

  it('refuses a Premium OS disk tier on a VM type without Premium storage', () => {
    const vmTypes = ['Standard_D2s_v5', 'Standard_D2_v5'];
    expect(() =>
      assertNodePoolVmTypes(CloudType.Azure, vmTypes, undefined, DiskTier.High),
    ).toThrow(
      '--disk-tier high needs a Premium disk, which Azure VM type "Standard_D2_v5" does not support',
    );
    expect(() =>
      assertNodePoolVmTypes(
        CloudType.Azure,
        vmTypes,
        undefined,
        DiskTier.Medium,
      ),
    ).not.toThrow();
    expect(() =>
      assertNodePoolVmTypes(
        CloudType.Azure,
        ['Standard_D2s_v5'],
        undefined,
        DiskTier.Ultra,
      ),
    ).not.toThrow();
  });

  it('ST2b refuses an OS disk that leaves replicas no ephemeral storage, naming the minimum', () => {
    const t4 = ['Standard_NC4as_T4_v3'];
    const disk = (gb: number) => () =>
      assertNodePoolVmTypes(CloudType.Azure, t4, undefined, undefined, gb);
    expect(disk(64)).toThrow(
      '--disk-size 64 GB leaves replicas no ephemeral storage after the 55 GB each Node reserves for the OS and images; use --disk-size 66 or more',
    );
    expect(disk(66)).not.toThrow();
    // NVMe sizes keep kubelet scratch off the OS disk.
    expect(() =>
      assertNodePoolVmTypes(
        CloudType.Azure,
        ['Standard_ND96isr_H100_v5'],
        undefined,
        undefined,
        30,
      ),
    ).not.toThrow();
  });
});

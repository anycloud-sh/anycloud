import { describe, expect, it } from 'vitest';
import { nodePoolDisk } from '../../../../src/api/services/kubernetes/node-pool-disk.js';
import { NVME_GIB } from '../../../../src/shared/catalog/queries.js';
import { readCatalog } from '../../../../src/shared/catalog/index.js';
import { CloudType } from '../../../../src/shared/cloud.js';

const pool = (cloudProvider: CloudType, vmTypes: string[], disk?: number) => ({
  cloudProvider,
  vmTypes,
  osDiskSizeGb: disk ?? null,
});

describe('node pool disk (ST2b)', () => {
  it('lists every catalogued H100 and A100 size on every pool cloud', () => {
    for (const cloud of [CloudType.AWS, CloudType.Azure, CloudType.GCP]) {
      const sizes = Object.entries(readCatalog(cloud)!.typesPerAccelerator)
        .filter(([name]) => /^(H100|A100)/i.test(name))
        .flatMap(([, types]) => types.map((t) => t.instanceType));
      expect(sizes.length).toBeGreaterThan(0);
      for (const vmType of sizes) {
        // AWS reads its catalog's instance store; the rest need a table row.
        const listed =
          cloud === CloudType.AWS
            ? nodePoolDisk(pool(cloud, [vmType])).nvme
            : vmType.toLowerCase() in NVME_GIB;
        expect(listed, `${cloud} ${vmType}`).toBe(true);
      }
    }
  });

  it('sizes each VM class: NVMe, a GPU or CPU OS disk, or unknown', () => {
    // 8 x 3,576 GiB of NVMe; the 100 GiB image allowance is all it reserves.
    expect(
      nodePoolDisk(pool(CloudType.Azure, ['Standard_ND96isr_H100_v5'])),
    ).toEqual({
      nvme: true,
      systemReservedGi: 0,
      kubeReservedGi: 100,
      allocatableGi: 25647,
      minimumDiskGb: 113,
    });
    expect(nodePoolDisk(pool(CloudType.AWS, ['p5.48xlarge']))).toMatchObject({
      nvme: true,
      allocatableGi: 25380,
    });
    // RFC 0044's 100 GB GPU disk is the tight case: T4 and the A2 Standard
    // without bundled Local SSD.
    for (const [cloud, vmType] of [
      [CloudType.Azure, 'Standard_NC4as_T4_v3'],
      [CloudType.GCP, 'a2-highgpu-1g'],
    ] as const) {
      expect(nodePoolDisk(pool(cloud, [vmType]))).toMatchObject({
        nvme: false,
        systemReservedGi: 25,
        kubeReservedGi: 30,
        allocatableGi: 30,
      });
    }
    // Lambda's fixed root disk isn't the 100 GB a pool can't set there, so
    // its size is unknown.
    expect(
      nodePoolDisk(pool(CloudType.Lambda, ['gpu_8x_h100_sxm5'])),
    ).not.toHaveProperty('allocatableGi');
    // A pool mixing a size without NVMe stays on its OS disk.
    expect(
      nodePoolDisk(
        pool(CloudType.GCP, ['a3-edgegpu-8g', 'a3-edgegpu-8g-nolssd'], 200),
      ),
    ).toMatchObject({ nvme: false, allocatableGi: 115 });
    expect(nodePoolDisk(pool(CloudType.AWS, ['t3.small']))).toEqual({
      nvme: false,
      systemReservedGi: 10,
      kubeReservedGi: 10,
      minimumDiskGb: 25,
    });
    expect(
      nodePoolDisk(pool(CloudType.AWS, ['t3.small'], 40)).allocatableGi,
    ).toBe(14);
  });

  it("fits a CPU Node's reservation on every cloud's default OS disk", () => {
    // AWS and GCP raise a pool's default disk to minimumDiskGb; Azure boots
    // its 30 GB Ubuntu 24.04 image disk, which a smaller size can't shrink.
    for (const [cloud, vmType, defaultGb] of [
      [CloudType.AWS, 't3.small', undefined],
      [CloudType.GCP, 'e2-standard-4', undefined],
      [CloudType.Azure, 'Standard_D2s_v5', 30],
    ] as const) {
      const { minimumDiskGb } = nodePoolDisk(pool(cloud, [vmType]));
      const diskGb = defaultGb ?? minimumDiskGb;
      expect(diskGb, cloud).toBeGreaterThanOrEqual(minimumDiskGb);
      expect(
        nodePoolDisk(pool(cloud, [vmType], diskGb)).allocatableGi,
        cloud,
      ).toBeGreaterThan(0);
    }
  });
});

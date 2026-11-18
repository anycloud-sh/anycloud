import { describe, expect, it } from 'vitest';
import { AZURE_FAMILY_TO_GPU } from '../../../../src/shared/catalog/azure-gpu-map.js';
import {
  azureQuotaResourceKeyFromName,
  getAzureQuotaGroupForVMType,
  getAzureQuotaResourceKeyForVMType,
  resolveAzureQuotaResources,
} from '../../../../src/shared/quota-resolvers/azure.js';
import { azureQuotaResourceKey } from '../../../../src/shared/quota-resolvers/azure-identity.js';
import { getRegions, getVMTypes } from '../../../../src/shared/cloud-config.js';
import { readCatalog } from '../../../../src/shared/catalog/index.js';
import { CloudType } from '../../../../src/shared/cloud.js';

// Azure GPU SKUs whose real quota family carries a token the VM name does NOT
// contain, so the fallback name parser cannot reconstruct it. These must be
// backed by the catalog QuotaGroup column (or a live Resource SKU read) for a
// correct family.
const CATALOG_REQUIRED = new Set([
  'standard_nd96asr_v4', // real standardndasv4_a100family — name has no "A100" token
  'standard_ncc40ads_h100_v5', // real standardnccads2023family — "2023" is nowhere in the name
  'standard_nc80adis_h100_v5', // confidential NCadis H100 — family not derivable from the name
]);

function uniqueAzure(select: (region: string) => string[]): string[] {
  const out = new Set<string>();
  for (const region of getRegions(CloudType.Azure)) {
    for (const vmType of select(region)) out.add(vmType);
  }
  return [...out].sort();
}

describe('Azure quota resolver', () => {
  describe('getAzureQuotaGroupForVMType', () => {
    it('maps NC ads H100 v5 to the family key suffix', () => {
      expect(getAzureQuotaGroupForVMType('Standard_NC40ads_H100_v5')).toBe(
        'standardncadsh100v5family',
      );
    });

    it('maps NC as T4 v3 to the family key suffix', () => {
      expect(getAzureQuotaGroupForVMType('Standard_NC4as_T4_v3')).toBe(
        'standardncasv3_t4family',
      );
    });

    it('maps NV ads A10 v5 to the family key suffix', () => {
      expect(getAzureQuotaGroupForVMType('Standard_NV6ads_A10_v5')).toBe(
        'standardnvadsa10v5family',
      );
    });

    it('maps ND amsr A100 v4 to the family key suffix', () => {
      expect(getAzureQuotaGroupForVMType('Standard_ND96amsr_A100_v4')).toBe(
        'standardndamsv4_a100family',
      );
    });

    it('maps ND isr H100 v5 to the family key suffix', () => {
      expect(getAzureQuotaGroupForVMType('Standard_ND96isr_H100_v5')).toBe(
        'standardndsh100v5family',
      );
    });

    it('maps ND isr H200 v5 to the family key suffix', () => {
      expect(getAzureQuotaGroupForVMType('Standard_ND96isr_H200_v5')).toBe(
        'standardndisrh200v5family',
      );
    });

    it('maps a CPU family (Ds v3) to the family key suffix', () => {
      expect(getAzureQuotaGroupForVMType('Standard_D4s_v3')).toBe(
        'standarddsv3family',
      );
    });

    it('produces keys that match entries in AZURE_FAMILY_TO_GPU for supported GPU SKUs', () => {
      const cases: Array<[string, string]> = [
        ['Standard_NC40ads_H100_v5', 'standardncadsh100v5family'],
        ['Standard_NC4as_T4_v3', 'standardncasv3_t4family'],
        ['Standard_NV6ads_A10_v5', 'standardnvadsa10v5family'],
        ['Standard_ND96amsr_A100_v4', 'standardndamsv4_a100family'],
        ['Standard_ND96isr_H100_v5', 'standardndsh100v5family'],
        ['Standard_ND96isr_H200_v5', 'standardndisrh200v5family'],
        ['Standard_NC24ads_A100_v4', 'standardncadsa100v4family'],
      ];
      for (const [vmType, expected] of cases) {
        expect(getAzureQuotaGroupForVMType(vmType)).toBe(expected);
        expect(AZURE_FAMILY_TO_GPU[expected]).toBeDefined();
      }
    });

    // Families where Azure reorders/drops tokens relative to the VM name, so the
    // generic digit-stripping parser derives the wrong key suffix. These names
    // still contain enough signal to reconstruct the real family without a live
    // SKU read; assert each resolves to a real AZURE_FAMILY_TO_GPU key.
    it.each([
      // MI300X: generation token v5 moves BEFORE the accelerator, "isr" -> "is".
      ['Standard_ND96isr_MI300X_v5', 'standardndisv5mi300xfamily'],
      // Bare NV "as" -> "s" (MI25 family).
      ['Standard_NV4as_v4', 'standardnvsv4family'],
      ['Standard_NV16as_v4', 'standardnvsv4family'],
      ['Standard_NV32as_v4', 'standardnvsv4family'],
      // Bare NC "rs" -> "s" (V100 family).
      ['Standard_NC24rs_v3', 'standardncsv3family'],
      // Bare ND "rs" -> "s" (V100-32GB family).
      ['Standard_ND40rs_v2', 'standardndsv2family'],
      // NV "adms" -> "ads" A10 family.
      ['Standard_NV36adms_A10_v5', 'standardnvadsa10v5family'],
    ])(
      'resolves the real Azure family for token-reordered SKU %s',
      (vmType, expected) => {
        expect(getAzureQuotaGroupForVMType(vmType)).toBe(expected);
        expect(AZURE_FAMILY_TO_GPU[expected]).toBeDefined();
      },
    );
  });

  describe('azureQuotaResourceKey', () => {
    // Regression: callers that match live Usage API rows (spaced for some
    // families, e.g. "Standard NCASv3_T4 Family") pass that raw provider name
    // straight into this function. It used to only lowercase, so a spaced
    // match produced "azure:standard ncasv3_t4 family" instead of the
    // canonical "azure:standardncasv3_t4family" that resolveAzureQuotaResources
    // generates for the same family — request/status rows for that family
    // then couldn't be matched against local-operation rows keyed by the
    // canonical form (statusCellKey in cli/use-cases/quota-status.ts).
    it('normalizes whitespace in a raw Usage API family name to the canonical key', () => {
      expect(azureQuotaResourceKey('Standard NCASv3_T4 Family')).toBe(
        'azure:standardncasv3_t4family',
      );
    });

    it('resolves a VM type directly to a full canonical key', () => {
      expect(getAzureQuotaResourceKeyForVMType('Standard_NC4as_T4_v3')).toBe(
        'azure:standardncasv3_t4family',
      );
    });

    it('agrees with the canonical key already-clean callers produce', () => {
      expect(azureQuotaResourceKey('standardncasv3_t4family')).toBe(
        'azure:standardncasv3_t4family',
      );
    });
  });

  describe('azureQuotaResourceKeyFromName', () => {
    // The display-name key path (normalizeResourceKeyPart, which drops
    // underscores, bridged back by FAMILY_BY_FLATTENED_KEY) must land on the
    // same key the provider-name path (azureQuotaResourceKey, which keeps
    // underscores) produces. This pins the two underscore normalizations
    // together so a change to one can't silently desync family joins.
    it('agrees with azureQuotaResourceKey for every GPU family', () => {
      for (const family of Object.keys(AZURE_FAMILY_TO_GPU)) {
        expect(azureQuotaResourceKeyFromName(family)).toBe(
          azureQuotaResourceKey(family),
        );
      }
    });

    it.each([
      'Public IP Addresses - Standard',
      'Public IPv4 Addresses - Standard',
      'Public IP Addresses',
      'IPv4 Standard SKU Public IP Addresses',
      'IPv4 Basic SKU Public IP Addresses',
      'IPv6 Standard SKU Public IP Addresses',
      'Public IP Prefixes',
      'IPv4 Standard Public IPs',
    ])(
      'does not recover public-IP display name %s as the current semantic key',
      (name) => {
        expect(azureQuotaResourceKeyFromName(name)).not.toBe(
          'azure:standardskupublicipaddresses',
        );
      },
    );
  });

  describe('resource-key overrides', () => {
    const input = {
      cloud: CloudType.Azure,
      vmType: 'Standard_NC4as_T4_v3',
      spot: false,
    } as const;

    it('accepts a full canonical provider-observed key', () => {
      expect(
        resolveAzureQuotaResources(input, {
          resourceKey: 'azure:providerobservedfamily',
        })[0],
      ).toEqual({
        key: 'azure:providerobservedfamily',
        name: 'Standard NCas T4 v3 Family vCPUs',
        kind: 'vm-family',
        unit: 'vcpus',
        required: 4,
      });
    });

    it('rejects a raw provider name in the canonical-key option', () => {
      expect(() =>
        resolveAzureQuotaResources(input, {
          resourceKey: 'Provider Observed Family',
        }),
      ).toThrow('Invalid Azure quota resource key');
    });
  });

  describe('spot vs on-demand resource shape', () => {
    const base = {
      cloud: CloudType.Azure,
      vmType: 'Standard_NC4as_T4_v3',
    } as const;

    it('emits the family plus the on-demand regional aggregate for on-demand', () => {
      expect(resolveAzureQuotaResources({ ...base, spot: false })).toEqual([
        {
          key: 'azure:standardncasv3_t4family',
          name: 'Standard NCas T4 v3 Family vCPUs',
          kind: 'vm-family',
          unit: 'vcpus',
          required: 4,
        },
        {
          key: 'azure:cores',
          name: 'Total Regional vCPUs',
          kind: 'regional-aggregate',
          unit: 'vcpus',
          required: 4,
        },
      ]);
    });

    it('emits only the spot regional aggregate for spot', () => {
      // Spot draws from a separate quota pool gated only by the regional
      // low-priority vCPU quota; the VM-family quota never applies to it.
      expect(resolveAzureQuotaResources({ ...base, spot: true })).toEqual([
        {
          key: 'azure:lowprioritycores',
          name: 'Total Regional Low-priority vCPUs',
          kind: 'regional-aggregate',
          unit: 'vcpus',
          required: 4,
        },
      ]);
    });
  });

  // Per-VM correctness sweep over the live catalog. The oracle is the catalog's
  // own accelerator label: for every GPU SKU the catalog offers, the family we
  // resolve must be a family FOR THE SAME GPU (AZURE_FAMILY_TO_GPU[family] ===
  // the SKU's accelerator). This is what catches a wrong-GPU resolution such as
  // MI300X -> a V100 family — the weaker "is it any known family" check would
  // have passed that. (It cannot distinguish two families that share a GPU,
  // e.g. the three H100 families; the explicit cases above pin those exactly.)
  describe('resolves every GPU SKU to a family for the right GPU', () => {
    const catalog = readCatalog(CloudType.Azure);
    const seen = new Set<string>();
    const gpuPairs: Array<{ vmType: string; gpu: string }> = [];
    for (const [gpu, entries] of Object.entries(
      catalog?.typesPerAccelerator ?? {},
    )) {
      for (const entry of entries) {
        if (seen.has(entry.instanceType)) continue;
        seen.add(entry.instanceType);
        gpuPairs.push({ vmType: entry.instanceType, gpu });
      }
    }
    gpuPairs.sort((a, b) => a.vmType.localeCompare(b.vmType));

    it('enumerates a non-empty GPU set from the catalog', () => {
      expect(gpuPairs.length).toBeGreaterThan(0);
    });

    it.each(gpuPairs)(
      'resolves $vmType (catalog GPU $gpu) to a family for that GPU',
      ({ vmType, gpu }) => {
        const familyGpu =
          AZURE_FAMILY_TO_GPU[getAzureQuotaGroupForVMType(vmType)];
        expect(familyGpu).toBe(gpu);
      },
    );

    it('keeps parser gaps backed by catalog quota groups', () => {
      const gpuVmTypes = new Set(gpuPairs.map((p) => p.vmType.toLowerCase()));
      for (const vmType of CATALOG_REQUIRED) {
        expect(gpuVmTypes.has(vmType)).toBe(true);
        expect(catalog?.quotaGroupPerType[vmType]).toBeDefined();
      }
    });
  });

  // Broad no-crash / no-empty guard across the ENTIRE Azure catalog (CPU + GPU),
  // for which AZURE_FAMILY_TO_GPU is not an oracle: a family must always be a
  // plausible non-empty "standard…family" token.
  describe('returns a well-formed family for every catalog SKU', () => {
    const allVmTypes = uniqueAzure((region) =>
      getVMTypes(CloudType.Azure, region),
    );

    it('enumerates a non-empty SKU set from the catalog', () => {
      expect(allVmTypes.length).toBeGreaterThan(0);
    });

    it.each(allVmTypes)('derives a well-formed family for %s', (vmType) => {
      expect(getAzureQuotaGroupForVMType(vmType)).toMatch(/^standard.*family$/);
    });
  });
});

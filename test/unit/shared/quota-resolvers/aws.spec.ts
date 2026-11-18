import { describe, expect, it } from 'vitest';
import {
  awsQuotaCodeForVMType,
  awsQuotaFamilyForVMType,
  awsQuotaResourceKey,
  awsQuotaResourceKeyFromName,
  canonicalAwsQuotaResourceKey,
} from '../../../../src/shared/quota-resolvers/aws.js';
import { quotaStatusResourceKey } from '../../../../src/shared/quota-groups.js';
import { readCatalog } from '../../../../src/shared/catalog/index.js';
import { CloudType } from '../../../../src/shared/cloud.js';

// AWS accelerators with no entry in AWS_QUOTA_CODES: non-NVIDIA-datacenter
// accelerators anycloud's quota model does not manage (Habana Gaudi, Xilinx
// FPGAs). They legitimately fall into the catch-all classification. Listed
// exhaustively so a NEW accelerator instance landing in "Standard" (e.g. a
// GPU family whose name the prefix classifier doesn't recognize) fails the
// sweep loudly instead of silently requesting the wrong quota.
const UNMANAGED_ACCEL_PREFIXES = new Set(['f2']);

function awsAcceleratorInstances(): string[] {
  const catalog = readCatalog(CloudType.AWS);
  if (!catalog) return [];
  const out = new Set<string>();
  for (const entries of Object.values(catalog.typesPerAccelerator)) {
    for (const entry of entries) out.add(entry.instanceType);
  }
  return [...out].sort();
}

describe('AWS quota resolver', () => {
  describe('awsQuotaFamilyForVMType', () => {
    it.each([
      ['g6e.48xlarge', 'G and VT'],
      ['gr6.4xlarge', 'G and VT'], // RAM-optimized G (L4) — must not fall to Standard
      ['p5.48xlarge', 'P'],
      ['trn1.32xlarge', 'Trn'],
      ['inf2.48xlarge', 'Inf'],
      ['m7i.2xlarge', 'Standard'],
    ])('classifies %s as %s', (vmType, family) => {
      expect(awsQuotaFamilyForVMType(vmType)).toBe(family);
    });

    // Coverage sweep over the live catalog: every accelerator instance AWS
    // actually offers must map to a managed (non-Standard) quota bucket — a GPU
    // instance in the generic "Standard" CPU bucket means we request the wrong
    // quota and never unblock it. The only escape is the documented
    // unmanaged-accelerator allow-list.
    describe('classifies every accelerator instance into a managed bucket', () => {
      const instances = awsAcceleratorInstances();

      it('enumerates a non-empty accelerator set from the catalog', () => {
        expect(instances.length).toBeGreaterThan(0);
      });

      it.each(instances)(
        'classifies %s out of the Standard bucket',
        (vmType) => {
          const prefix = vmType.split('.')[0].toLowerCase();
          const managed = awsQuotaFamilyForVMType(vmType) !== 'Standard';
          expect(managed || UNMANAGED_ACCEL_PREFIXES.has(prefix)).toBe(true);
        },
      );

      it('keeps the unmanaged-accelerator allow-list free of stale entries', () => {
        const prefixes = new Set(
          instances.map((vmType) => vmType.split('.')[0].toLowerCase()),
        );
        for (const prefix of UNMANAGED_ACCEL_PREFIXES) {
          expect(prefixes.has(prefix)).toBe(true);
        }
      });
    });
  });

  describe('canonicalAwsQuotaResourceKey', () => {
    it('passes an already-canonical quota-code key through unchanged', () => {
      expect(canonicalAwsQuotaResourceKey('aws:l-7212ccbc')).toBe(
        'aws:l-7212ccbc',
      );
    });

    it('migrates a legacy on-demand family key to the quota code', () => {
      expect(canonicalAwsQuotaResourceKey('aws:on-demand:gandvt')).toBe(
        awsQuotaResourceKey(awsQuotaCodeForVMType('g6e.48xlarge', false)),
      );
      expect(canonicalAwsQuotaResourceKey('aws:on-demand:gandvt')).toBe(
        'aws:l-db2e81ba',
      );
    });

    it('migrates a legacy spot family key to the quota code', () => {
      expect(canonicalAwsQuotaResourceKey('aws:spot:p')).toBe('aws:l-7212ccbc');
    });

    it('returns null for an unknown legacy family', () => {
      expect(canonicalAwsQuotaResourceKey('aws:on-demand:bogus')).toBeNull();
    });

    it('returns null for a malformed key', () => {
      expect(canonicalAwsQuotaResourceKey('not-a-key')).toBeNull();
    });
  });

  describe('awsQuotaResourceKeyFromName', () => {
    it('maps a spot request name to its quota-code key', () => {
      expect(awsQuotaResourceKeyFromName('All P Spot Instance Requests')).toBe(
        'aws:l-7212ccbc',
      );
    });

    it('maps an on-demand request name to its quota-code key', () => {
      expect(
        awsQuotaResourceKeyFromName('Running On-Demand G and VT instances'),
      ).toBe('aws:l-db2e81ba');
    });

    it('collapses the verbose Standard display name to the Standard code', () => {
      expect(
        awsQuotaResourceKeyFromName(
          'All Standard (A, C, D, H, I, M, R, T, Z) Spot Instance Requests',
        ),
      ).toBe('aws:l-34b43a08');
    });

    it('returns null for an unparseable name', () => {
      expect(awsQuotaResourceKeyFromName('not a quota name')).toBeNull();
    });
  });

  describe('quotaStatusResourceKey fallback', () => {
    it('keeps an unknown legacy key verbatim when canonicalization fails', () => {
      // canonicalAwsQuotaResourceKey returns null, so quotaStatusResourceKey
      // must fall back to the stored key rather than throwing or dropping it.
      expect(
        quotaStatusResourceKey({
          cloud: CloudType.AWS,
          region: 'us-east-1',
          resourceName: 'Mystery quota',
          resourceKey: 'aws:on-demand:bogus',
          status: 'PENDING',
        }),
      ).toBe('aws:on-demand:bogus');
    });
  });
});

import { describe, it, expect } from 'vitest';
import { readCatalog } from '../../../src/shared/catalog/index';
import { CloudType } from '../../../src/shared/cloud.js';
import { resolveWorkloadPrice } from '../../../src/shared/catalog/index';

function realAwsPriceTarget(): {
  vmType: string;
  region: string;
  price: number;
} {
  const catalog = readCatalog(CloudType.AWS);
  expect(catalog).toBeDefined();
  const [vmType, prices] = Object.entries(catalog!.pricePerTypeRegion)[0]!;
  const [region, price] = Object.entries(prices)[0]!;
  return { vmType, region, price };
}

describe('resolveWorkloadPrice — ordered-fallback walk', () => {
  it('walks past a fake/unpriceable head to the first catalog-priced fallback', () => {
    const target = realAwsPriceTarget();
    expect(
      resolveWorkloadPrice(
        CloudType.AWS,
        ['totally_fake_nonexistent_vm', target.vmType],
        target.region,
        false,
      ),
    ).toBe(target.price);
  });

  it('prices a scalar vmType', () => {
    const target = realAwsPriceTarget();
    expect(
      resolveWorkloadPrice(CloudType.AWS, target.vmType, target.region, false),
    ).toBe(target.price);
  });

  it('returns undefined when every fallback entry is unpriceable', () => {
    expect(
      resolveWorkloadPrice(
        CloudType.AWS,
        ['totally_fake_nonexistent_vm', 'also-fake'],
        'us-east-1',
        false,
      ),
    ).toBeUndefined();
  });

  it('returns undefined without a cloud provider or region', () => {
    const target = realAwsPriceTarget();
    expect(
      resolveWorkloadPrice(null, target.vmType, target.region, false),
    ).toBeUndefined();
    expect(
      resolveWorkloadPrice(CloudType.AWS, target.vmType, null, false),
    ).toBeUndefined();
  });
});

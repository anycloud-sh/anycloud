import {
  DescribeInstanceTypesCommand,
  type DescribeInstanceTypesResult,
} from '@aws-sdk/client-ec2';
import { parse } from 'csv-parse/sync';
import { describe, expect, it, vi } from 'vitest';
import { enrichAwsCatalog } from '../../../scripts/catalog-aws.js';
import { parseCatalogCSV } from '../../../src/shared/catalog/index.js';
import { CloudType } from '../../../src/shared/cloud.js';

const CSV =
  'InstanceType,Region,vCPUs,MemoryGiB,Price,SpotPrice,Extra\n' +
  'r7i.4xlarge,us-east-1,16,128,1.0584,0.3,"keep,me"\n' +
  't3.micro,us-east-1,2,1,0.01,,extra\n' +
  'future.large,us-east-1,4,16,0.2,,unknown\n' +
  'r7i.4xlarge,us-west-2,16,128,1.0584,,west\n';

describe('AWS catalog capability enrichment', () => {
  it('paginates metadata by region and preserves all upstream fields', async () => {
    const eastSend = vi
      .fn<
        (
          command: DescribeInstanceTypesCommand,
        ) => Promise<DescribeInstanceTypesResult>
      >()
      .mockResolvedValueOnce({
        InstanceTypes: [
          {
            InstanceType: 'r7i.4xlarge',
            ProcessorInfo: { SupportedFeatures: ['nested-virtualization'] },
          },
        ],
        NextToken: 'page2',
      })
      .mockResolvedValueOnce({
        InstanceTypes: [
          {
            InstanceType: 't3.micro',
            ProcessorInfo: { SupportedFeatures: [] },
          },
        ],
      });
    const westSend = vi
      .fn<
        (
          command: DescribeInstanceTypesCommand,
        ) => Promise<DescribeInstanceTypesResult>
      >()
      .mockResolvedValue({
        InstanceTypes: [
          {
            InstanceType: 'r7i.4xlarge',
            ProcessorInfo: { SupportedFeatures: [] },
          },
        ],
      });
    const enriched = await enrichAwsCatalog(CSV, (region) => ({
      send: region === 'us-east-1' ? eastSend : westSend,
    }));
    expect(eastSend).toHaveBeenCalledTimes(2);
    expect(eastSend.mock.calls[1][0]).toBeInstanceOf(
      DescribeInstanceTypesCommand,
    );
    expect(eastSend.mock.calls[1][0].input).toEqual({ NextToken: 'page2' });
    expect(westSend).toHaveBeenCalledTimes(1);
    const before = parse(CSV, { columns: true }) as Record<string, string>[];
    const after = parse(enriched, { columns: true }) as Record<
      string,
      string
    >[];
    expect(
      after.map(({ NestedVirtualizationSupported: _, ...row }) => row),
    ).toEqual(before);
    expect(after.map((row) => row.NestedVirtualizationSupported)).toEqual([
      'true',
      'false',
      '',
      'false',
    ]);
    expect(
      parseCatalogCSV(enriched, CloudType.AWS)
        .nestedVirtualizationPerTypeRegion,
    ).toEqual({
      'r7i.4xlarge': { 'us-east-1': true, 'us-west-2': false },
      't3.micro': { 'us-east-1': false },
    });
  });

  it('leaves unmatched and inaccessible-region metadata unknown, clearing old values', async () => {
    const send = vi
      .fn<
        (
          command: DescribeInstanceTypesCommand,
        ) => Promise<DescribeInstanceTypesResult>
      >()
      .mockResolvedValue({ InstanceTypes: [{ InstanceType: 'r7i.4xlarge' }] });
    const enriched = await enrichAwsCatalog(
      CSV,
      () => ({ send }),
      new Set(['us-east-1']),
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      parseCatalogCSV(enriched, CloudType.AWS)
        .nestedVirtualizationPerTypeRegion,
    ).toEqual({});
    const old =
      'InstanceType,Region,NestedVirtualizationSupported\nr7i.4xlarge,us-east-1,true\n';
    expect(
      parseCatalogCSV(
        await enrichAwsCatalog(old, () => ({ send })),
        CloudType.AWS,
      ).nestedVirtualizationPerTypeRegion,
    ).toEqual({});
  });

  it('rejects metadata failures and malformed upstream catalogs', async () => {
    const send = vi
      .fn<
        (
          command: DescribeInstanceTypesCommand,
        ) => Promise<DescribeInstanceTypesResult>
      >()
      .mockRejectedValue(new Error('metadata unavailable'));
    await expect(enrichAwsCatalog(CSV, () => ({ send }))).rejects.toThrow(
      'metadata unavailable',
    );
    await expect(
      enrichAwsCatalog('Type,Price\nx,1\n', () => ({ send })),
    ).rejects.toThrow('requires');
  });
});

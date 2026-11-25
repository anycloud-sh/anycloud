import { describe, expect, it } from 'vitest';
import { buildAzureUsageFamilyArtifacts } from '../../../scripts/fetch-catalog.js';
import {
  validateAzureUsageFamilies,
  validateGcpCatalog,
} from '../../../scripts/validate-catalog.js';

type Row = Record<string, string>;

function row(instanceType: string, region: string, quotaGroup?: string): Row {
  return {
    InstanceType: instanceType,
    Region: region,
    QuotaGroup: quotaGroup ?? '',
  };
}

function v2(
  families: Record<
    string,
    { rawNames: string[]; regions: string; [key: string]: unknown }
  >,
) {
  return { version: 2, families };
}

function resultFor(rows: Row[], artifact: unknown, message: string) {
  const result = validateAzureUsageFamilies(rows, artifact).find((entry) =>
    entry.message.includes(message),
  );
  expect(
    result,
    `missing validation result containing "${message}"`,
  ).toBeDefined();
  return result!;
}

describe('validateAzureUsageFamilies', () => {
  it('accepts v2 whitespace/case variants and covers every SKU dynamically', () => {
    const rows = [
      row('Standard_NC4as_T4_v3', 'westus2', 'Standard NCASv3_T4 Family'),
      row('standard_nc4as_t4_v3', 'eastus', 'standardncasv3_t4family'),
      row('Standard_D4s_v5', 'eastus', 'StandardDSv5Family'),
    ];
    const artifact = v2({
      'azure:standarddsv5family': {
        rawNames: ['StandardDSv5Family'],
        regions: 'eastus',
      },
      'azure:standardncasv3_t4family': {
        rawNames: ['Standard NCASv3_T4 Family', 'standardncasv3_t4family'],
        regions: 'eastus,westus2',
      },
    });

    const results = validateAzureUsageFamilies(rows, artifact);
    expect(results.every((entry) => entry.passed)).toBe(true);
    expect(
      resultFor(rows, artifact, 'Catalog SKUs observed').message,
    ).toContain('2/2');
    expect(resultFor(rows, artifact, 'artifact v2 entries').passed).toBe(true);
  });

  it('accepts the published legacy v1 schema unchanged', () => {
    const rows = [row('Standard_D4s_v5', 'eastus', 'StandardDSv5Family')];
    const artifact = {
      standarddsv5family: {
        raw: 'Standard DSv5 Family',
        regions: 'eastus',
      },
    };

    const results = validateAzureUsageFamilies(rows, artifact);
    expect(results.every((entry) => entry.passed)).toBe(true);
    expect(resultFor(rows, artifact, 'artifact v1 entries').passed).toBe(true);
  });

  it('builds a stable legacy artifact and a lossless versioned artifact', () => {
    const artifacts = buildAzureUsageFamilyArtifacts({
      'azure:standarddsv5family': {
        rawNames: [
          'standarddsv5family',
          'Standard DSv5 Family',
          'standarddsv5family',
        ],
        regions: 'eastus,westus2',
      },
    });

    expect(artifacts.legacy).toEqual({
      standarddsv5family: {
        raw: 'Standard DSv5 Family',
        regions: 'eastus,westus2',
      },
    });
    expect(artifacts.v2).toEqual({
      version: 2,
      families: {
        'azure:standarddsv5family': {
          rawNames: ['Standard DSv5 Family', 'standarddsv5family'],
          regions: 'eastus,westus2',
        },
      },
    });
  });

  it('fails when any SKU row lacks a family', () => {
    const rows = [
      row('Standard_D4s_v5', 'eastus', 'StandardDSv5Family'),
      row('Standard_E4s_v5', 'eastus'),
    ];
    const artifact = v2({
      'azure:standarddsv5family': {
        rawNames: ['StandardDSv5Family'],
        regions: 'eastus',
      },
    });

    expect(resultFor(rows, artifact, 'SKUs with a quota family')).toMatchObject(
      { passed: false },
    );
  });

  it('fails case-insensitive SKU mappings that disagree on canonical family', () => {
    const rows = [
      row('Standard_D4s_v5', 'eastus', 'StandardDSv5Family'),
      row('standard_d4s_v5', 'westus2', 'StandardESv5Family'),
    ];
    const artifact = v2({
      'azure:standarddsv5family': {
        rawNames: ['StandardDSv5Family'],
        regions: 'eastus',
      },
      'azure:standardesv5family': {
        rawNames: ['StandardESv5Family'],
        regions: 'westus2',
      },
    });

    expect(
      resultFor(rows, artifact, 'family mappings unambiguous'),
    ).toMatchObject({ passed: false });
  });

  it('fails missing families and SKUs not observed in an offered region', () => {
    const rows = [
      row('Standard_D4s_v5', 'eastus', 'StandardDSv5Family'),
      row('Standard_E4s_v5', 'westus2', 'StandardESv5Family'),
    ];
    const artifact = v2({
      'azure:standarddsv5family': {
        rawNames: ['StandardDSv5Family'],
        regions: 'westus2',
      },
    });

    expect(
      resultFor(rows, artifact, 'Catalog families observed'),
    ).toMatchObject({ passed: false });
    expect(resultFor(rows, artifact, 'Catalog SKUs observed')).toMatchObject({
      passed: false,
    });
  });

  it('rejects malformed v2 entries and unexpected families', () => {
    const rows = [row('Standard_D4s_v5', 'eastus', 'StandardDSv5Family')];
    const artifact = v2({
      'Azure:Standard DSv5 Family': {
        rawNames: ['StandardDSv5Family'],
        regions: 'eastus',
      },
      'azure:standarddsv5family': {
        rawNames: ['StandardESv5Family'],
        regions: 'eastus',
      },
      'azure:standardesv5family': {
        rawNames: ['StandardESv5Family'],
        regions: 'eastus',
      },
    });

    expect(
      resultFor(rows, artifact, 'entries canonical and valid'),
    ).toMatchObject({ passed: false });
    expect(resultFor(rows, artifact, 'no unexpected keys')).toMatchObject({
      passed: false,
    });
  });

  it.each([
    ['unsorted', ['standarddsv5family', 'Standard DSv5 Family']],
    ['duplicate', ['Standard DSv5 Family', 'Standard DSv5 Family']],
  ])('rejects %s v2 raw names', (_label, rawNames) => {
    const rows = [row('Standard_D4s_v5', 'eastus', 'StandardDSv5Family')];
    const artifact = v2({
      'azure:standarddsv5family': {
        rawNames,
        regions: 'eastus',
      },
    });

    expect(
      resultFor(rows, artifact, 'entries canonical and valid'),
    ).toMatchObject({ passed: false });
  });

  it('rejects a legacy raw name that does not derive to its key', () => {
    const rows = [row('Standard_D4s_v5', 'eastus', 'StandardDSv5Family')];
    const artifact = {
      standarddsv5family: {
        raw: 'StandardESv5Family',
        regions: 'eastus',
      },
    };

    expect(
      resultFor(rows, artifact, 'entries canonical and valid'),
    ).toMatchObject({ passed: false });
  });

  it('requires at least 90% of catalog regions in the Usage artifact', () => {
    const rows = Array.from({ length: 10 }, (_, index) =>
      row(`Standard_D${index}s_v5`, `region${index}`, 'StandardDSv5Family'),
    );
    const artifact = v2({
      'azure:standarddsv5family': {
        rawNames: ['StandardDSv5Family'],
        regions: Array.from({ length: 8 }, (_, index) => `region${index}`).join(
          ',',
        ),
      },
    });

    expect(resultFor(rows, artifact, 'catalog-region coverage')).toMatchObject({
      passed: false,
    });
  });
});

const GCP_BASELINE: Record<string, number[]> = {
  A100: [1, 2, 4, 8, 16],
  'A100-80GB': [1, 2, 4, 8],
  H100: [1, 2, 4, 8],
  'H100-MEGA': [8],
  H200: [8],
  B200: [8],
  L4: [1, 2, 4, 8],
  RTXPRO6000: [1, 2, 4, 8],
};

const GCP_ARM64_BASELINE = ['standard', 'highmem'].flatMap((shape) =>
  [4, 8, 16].map((vCpus) => ({
    InstanceType: `c4a-${shape}-${vCpus}`,
    Arch: 'arm64',
    Price: '0.2',
    SpotPrice: '0.08',
    Region: 'europe-west4',
    AvailabilityZone: 'europe-west4-a',
  })),
);

function validGcpRows(): Row[] {
  return [...GCP_ARM64_BASELINE, ...gpuRows()];
}

function gpuRows(): Row[] {
  return Object.entries(GCP_BASELINE).flatMap(([name, counts]) =>
    counts.map((count) => ({
      InstanceType:
        name === 'RTXPRO6000'
          ? `g4-standard-${48 * count}`
          : `${name.toLowerCase()}-${count}g`,
      AcceleratorName: name,
      AcceleratorCount: String(count),
      vCPUs: String(name === 'RTXPRO6000' ? 48 * count : 16 * count),
      MemoryGiB: String(64 * count),
      Price: String(2 * count),
      SpotPrice: String(count),
      Region: 'us-central1',
      AvailabilityZone: 'us-central1-a',
    })),
  );
}

function gcpResult(rows: Row[], message: string) {
  const result = validateGcpCatalog(rows).find((entry) =>
    entry.message.includes(message),
  );
  expect(result, `missing GCP result containing "${message}"`).toBeDefined();
  return result!;
}

describe('validateGcpCatalog', () => {
  it('accepts the complete baseline', () => {
    const rows = validGcpRows();
    expect(validateGcpCatalog(rows).every((result) => result.passed)).toBe(
      true,
    );
  });

  it('fails when an RTXPRO6000 count is missing', () => {
    const rows = validGcpRows().filter(
      (entry) =>
        !(
          entry.AcceleratorName === 'RTXPRO6000' &&
          entry.AcceleratorCount === '4'
        ),
    );
    expect(gcpResult(rows, 'RTXPRO6000')).toMatchObject({
      passed: false,
    });
  });

  it('fails when a C4A type lacks a spot price or its arm64 mark', () => {
    const rows = validGcpRows().map((entry) =>
      entry.InstanceType === 'c4a-highmem-16'
        ? { ...entry, SpotPrice: '' }
        : entry.InstanceType === 'c4a-standard-4'
          ? { ...entry, Arch: '' }
          : entry,
    );
    expect(gcpResult(rows, 'arm64 baseline')).toMatchObject({
      passed: false,
      message: expect.stringContaining('missing c4a-standard-4/c4a-highmem-16'),
    });
  });

  it('rejects fractional/misclassified G4 and GPU-to-CPU leaks', () => {
    const rows = validGcpRows();
    rows.push({
      ...rows.find((entry) => entry.AcceleratorName === 'RTXPRO6000')!,
      InstanceType: 'g4-standard-24',
      vCPUs: '24',
    });
    rows.push({
      InstanceType: 'g4-standard-48',
      AcceleratorName: '',
      Region: 'us-central1',
      AvailabilityZone: 'us-central1-a',
    });

    expect(gcpResult(rows, 'whole RTXPRO6000')).toMatchObject({
      passed: false,
    });
    expect(gcpResult(rows, 'absent from CPU rows')).toMatchObject({
      passed: false,
    });
  });
});

import { describe, it, expect } from 'vitest';
import {
  displayWidth,
  buildStatusMatrixLines,
} from '../../../../src/cli/renderers/quota-status.js';
import { quotaStatusView } from '../../../../src/cli/use-cases/quota-status.js';
import { type QuotaStatusEntry } from '../../../../src/shared/api-contract/quota-schemas.js';
import { CloudType } from '../../../../src/shared/cloud.js';
import { current, entry, local } from '../../helpers/quota-status-entries.js';

const statusLines = (entries: QuotaStatusEntry[]) =>
  buildStatusMatrixLines(quotaStatusView(entries));

describe('displayWidth', () => {
  it('counts plain text one column per char', () => {
    expect(displayWidth('us-east-1')).toBe(9);
  });

  it('counts summary emoji two columns wide', () => {
    expect(displayWidth('✅ 96')).toBe(5);
    expect(displayWidth('96')).toBe(2);
    expect(displayWidth('48/96')).toBe(5);
    expect(displayWidth('—')).toBe(1);
  });

  it('ignores ANSI color codes', () => {
    expect(displayWidth('\x1b[32m96\x1b[39m')).toBe(2);
  });
});

describe('buildStatusMatrixLines', () => {
  it('names canceled targets for manual follow-up without treating them as provider requests', () => {
    const lines = statusLines([
      entry({
        source: 'local_operation',
        status: 'CANCELED',
        operationId: 'quota-old',
        operationTargetId: 'target-old',
        vmType: 'p5.48xlarge',
        spot: true,
      }),
    ]).join('\n');
    expect(lines).toContain('CANCELED LOCAL SUBMISSIONS');
    expect(lines).toContain('p5.48xlarge (spot)');
    expect(lines).toContain('operation quota-old');
    expect(lines).not.toContain('No quota requests');
  });

  it('shows unavailable provider scopes and canceled local targets together', () => {
    const lines = statusLines([
      entry({
        source: 'local_operation',
        status: 'CANCELED',
        operationId: 'quota-old',
        operationTargetId: 'target-old',
        vmType: 'p5.48xlarge',
      }),
      entry({
        kind: 'unavailable',
        status: 'UNAVAILABLE',
        resourceName: 'Compute requests',
        message: 'provider unavailable',
      }),
    ]).join('\n');

    expect(lines).toContain('Unavailable in us-east-1: Compute requests');
    expect(lines).toContain('CANCELED LOCAL SUBMISSIONS');
    expect(lines).toContain('operation quota-old');
  });

  const entries: QuotaStatusEntry[] = [
    // Older duplicate for the same cell — must lose to the approved entry.
    entry({
      region: 'us-east-1',
      status: 'CASE_OPENED',
      requestedAt: '2026-06-01T00:00:00.000Z',
    }),
    entry({
      region: 'us-east-1',
      status: 'APPROVED',
      grantedLimit: 96,
      requestedAt: '2026-06-04T00:00:00.000Z',
    }),
    entry({
      region: 'us-east-1',
      resourceName: 'All G and VT Spot Instance Requests',
      requestedLimit: 4,
    }),
    entry({
      region: 'eu-west-1',
      status: 'PARTIAL',
      grantedLimit: 48,
    }),
    entry({
      region: 'eu-west-1',
      resourceName:
        'All Standard (A, C, D, H, I, M, R, T, Z) Spot Instance Requests',
      status: 'DENIED',
      requestedLimit: 192,
    }),
  ];

  const lines = statusLines(entries);
  const text = lines.join('\n');

  it('summarizes status buckets and regions', () => {
    expect(lines[0]).toContain('✅  1 approved');
    expect(lines[0]).toContain('⚠️  1 partial');
    expect(lines[0]).toContain('⏳  1 waiting');
    expect(lines[0]).toContain('❌  1 denied');
    expect(lines[0]).toContain('2 regions');
  });

  it('orders readable quota-group columns by total requested and labels AWS sections', () => {
    const header = lines.find((line) => line.includes('REGION'));
    const section = lines.find((line) => line.includes('SPOT'));
    expect(header).toBeDefined();
    expect(section).toBeDefined();
    const p = header!.indexOf('P GPUs');
    const standard = header!.indexOf('CPU');
    const g = header!.indexOf('G/VT GPUs');
    expect(p).toBeGreaterThan(-1);
    expect(standard).toBeGreaterThan(p);
    expect(g).toBeGreaterThan(standard);
  });

  it('uses compact AWS quota group headers', () => {
    expect(text).toContain('P GPUs');
    expect(text).toContain('G/VT GPUs');
    expect(text).toContain('CPU');
  });

  it('renders the latest entry per cell with status color only', () => {
    const usEast = lines.find((line) => line.startsWith('us-east-1'));
    expect(usEast).toContain('96'); // approved beats the older open entry
    expect(usEast).toContain('—'); // no Standard request in us-east-1
    expect(usEast).toMatch(/ 4$/);
    expect(usEast).not.toContain('✓');
    expect(usEast).not.toContain('…');
    const euWest = lines.find((line) => line.startsWith('eu-west-1'));
    expect(euWest).toContain('48/96');
    expect(euWest).toContain('192');
    expect(euWest).not.toContain('⚠');
    expect(euWest).not.toContain('✗');
  });

  it('splits AWS spot and on-demand into separate matrices', () => {
    const mixed = statusLines([
      entry({
        region: 'us-east-1',
        resourceName: 'All P Spot Instance Requests',
        status: 'CASE_OPENED',
      }),
      entry({
        region: 'us-east-1',
        resourceName: 'Running On-Demand P instances',
        status: 'APPROVED',
        grantedLimit: 96,
      }),
    ]);
    const spotIndex = mixed.findIndex((line) => line.includes('SPOT'));
    const onDemandIndex = mixed.findIndex((line) => line.includes('ON-DEMAND'));

    expect(spotIndex).toBeGreaterThan(-1);
    expect(onDemandIndex).toBeGreaterThan(spotIndex);
    expect(mixed[spotIndex + 1]).toMatch(/REGION\s+P GPUs/);
    expect(mixed[spotIndex + 2]).toContain('96');
    expect(mixed[spotIndex + 2]).not.toContain('…');
    expect(mixed[onDemandIndex + 1]).toMatch(/REGION\s+P GPUs/);
    expect(mixed[onDemandIndex + 2]).toContain('96');
    expect(mixed[onDemandIndex + 2]).not.toContain('✓');
  });

  it('aligns every cell to the same column start', () => {
    const header = lines.find((line) => line.includes('REGION'))!;
    const usEast = lines.find((line) => line.startsWith('us-east-1'))!;
    // The P column starts right after the REGION column in every row: the
    // prefix up to each row's second column must have equal display width.
    const headerPrefix = header.slice(0, header.indexOf('P GPUs'));
    const cellPrefix = usEast.slice(0, usEast.indexOf('96'));
    expect(displayWidth(cellPrefix)).toBe(displayWidth(headerPrefix));
  });

  it('renders current nonzero limits when no requests exist', () => {
    const currentOnly = statusLines([
      current({
        region: 'us-east-1',
        resourceName: 'All P Spot Instance Requests',
        currentLimit: 96,
      }),
      current({
        region: 'us-west-2',
        resourceName: 'All P Spot Instance Requests',
        currentLimit: 0,
      }),
    ]);
    const text = currentOnly.join('\n');

    expect(currentOnly[0]).toContain('No quota requests');
    expect(currentOnly[0]).toContain('Current nonzero quota limits');
    expect(text).toContain('us-east-1');
    expect(text).toContain('96');
    expect(text).not.toContain('us-west-2');
  });

  it('prefers request cells over current-limit cells and fills empty cells', () => {
    const mixed = statusLines([
      entry({
        region: 'us-east-1',
        resourceName: 'All P Spot Instance Requests',
        status: 'PENDING',
        requestedLimit: 384,
      }),
      current({
        region: 'us-east-1',
        resourceName: 'All P Spot Instance Requests',
        currentLimit: 96,
      }),
      current({
        region: 'us-east-1',
        resourceName: 'All G and VT Spot Instance Requests',
        currentLimit: 4,
      }),
    ]);
    const usEast = mixed.find((line) => line.startsWith('us-east-1'))!;

    expect(mixed[0]).toContain('⏳  1 waiting');
    expect(usEast).toContain('384');
    expect(usEast).toContain('4');
    expect(usEast).not.toContain('96');
  });

  it('renders queued and running local operation rows as visible cells', () => {
    const lines = statusLines([
      local({
        region: 'us-east-1',
        status: 'QUEUED',
      }),
      local({
        region: 'us-west-2',
        status: 'RUNNING',
      }),
    ]);
    const text = lines.join('\n');

    expect(lines[0]).toContain('⏳  2 waiting');
    expect(text).toContain('SPOT');
    expect(text).toContain('P GPUs');
    expect(text).toContain('queued');
    expect(text).toContain('running');
  });

  it('canonicalizes resource keys so legacy local rows hide matching current-limit rows', () => {
    const lines = statusLines([
      local({
        cloud: CloudType.Azure,
        region: 'northcentralus',
        resourceName: 'Standard Das v5 Family vCPUs',
        resourceKey: 'Azure:Standard Das v5 Family',
        status: 'QUEUED',
        vmType: 'Standard_D2as_v5',
        spot: true,
      }),
      current({
        cloud: CloudType.Azure,
        region: 'northcentralus',
        resourceName: 'Standard Dasv5 Family vCPUs',
        resourceKey: 'azure:standarddasv5family',
        currentLimit: 3,
      }),
      current({
        cloud: CloudType.Azure,
        region: 'northcentralus',
        resourceName: 'Public IPv4 Addresses - Standard',
        resourceKey: 'azure:standardskupublicipaddresses',
        currentLimit: 100,
      }),
    ]);
    const text = lines.join('\n');

    expect(lines[0]).toContain('⏳  1 waiting');
    expect(text).toContain('queued');
    expect(text).toContain('Public IPs');
    expect(text).toContain('100');
    expect(text).not.toContain('3');
  });

  it('keeps AWS zero-only current family columns visible as dashes', () => {
    const lines = statusLines([
      current({
        resourceName: 'Running On-Demand Standard instances',
        currentLimit: 64,
      }),
      current({
        resourceName: 'Running On-Demand P instances',
        currentLimit: 0,
      }),
      current({
        resourceName: 'Running On-Demand G and VT instances',
        currentLimit: 0,
      }),
      current({
        resourceName: 'Running On-Demand Inf instances',
        currentLimit: 0,
      }),
    ]);
    const onDemandIndex = lines.findIndex((line) => line.includes('ON-DEMAND'));
    const header = lines[onDemandIndex + 1];
    const row = lines[onDemandIndex + 2];

    expect(header).toContain('CPU');
    expect(header).toContain('P GPUs');
    expect(header).toContain('G/VT GPUs');
    expect(header).toContain('Inferentia');
    expect(row).toContain('64');
    expect(row).toContain('—');
    expect(row).not.toContain('0');
  });

  it('renders zero current limits when every visible current limit is zero', () => {
    const zeroOnly = statusLines([
      current({
        region: 'us-east-1',
        resourceName: 'All P Spot Instance Requests',
        currentLimit: 0,
      }),
      current({
        region: 'us-west-2',
        resourceName: 'All G and VT Spot Instance Requests',
        currentLimit: 0,
      }),
    ]);
    const text = zeroOnly.join('\n');

    expect(zeroOnly[0]).toContain('No quota requests');
    expect(zeroOnly[0]).toContain('all visible current limits are 0');
    expect(text).toContain('us-east-1');
    expect(text).toContain('us-west-2');
    expect(text).toContain('0');
  });

  it('uses compact Azure current-limit headers', () => {
    const lines = statusLines([
      current({
        cloud: CloudType.Azure,
        region: 'eastus',
        resourceName: 'Total Regional Low-priority vCPUs',
        currentLimit: 3,
      }),
      current({
        cloud: CloudType.Azure,
        region: 'eastus',
        resourceName: 'Total Regional vCPUs',
        currentLimit: 65,
      }),
      current({
        cloud: CloudType.Azure,
        region: 'eastus',
        resourceName: 'Public IPv4 Addresses - Standard',
        resourceKey: 'azure:standardskupublicipaddresses',
        currentLimit: 100,
      }),
      current({
        cloud: CloudType.Azure,
        region: 'eastus',
        resourceName: 'Standard NCads H100 v5 Family vCPUs',
        currentLimit: 40,
      }),
    ]);
    const text = lines.join('\n');

    expect(text).toContain('Spot vCPUs');
    expect(text).toContain('vCPUs');
    expect(text).toContain('Public IPs');
    expect(text).toContain('NCads H100 v5');
    expect(text).not.toContain('Total Regional Low-priority vCPUs');
    expect(text).not.toContain('Public IPv4 Addresses - Standard');
    expect(text).not.toContain('Standard NCads H100 v5 Family vCPUs');
  });

  it('keeps current, Basic, and historical Azure public-IP rows in distinct columns', () => {
    const lines = statusLines([
      current({
        cloud: CloudType.Azure,
        region: 'eastus',
        resourceName: 'Public IPv4 Addresses - Standard',
        resourceKey: 'azure:standardskupublicipaddresses',
        currentLimit: 100,
      }),
      current({
        cloud: CloudType.Azure,
        region: 'eastus',
        resourceName: 'Public IP Addresses',
        resourceKey: 'azure:publicipaddresses',
        currentLimit: 20,
      }),
      current({
        cloud: CloudType.Azure,
        region: 'eastus',
        resourceName: 'Public IP Addresses',
        resourceKey: 'azure:publicipv4addressesstandard',
        currentLimit: 70,
      }),
    ]);
    const header = lines.find((line) => line.includes('REGION'))!;
    const row = lines.find((line) => line.startsWith('eastus'))!;

    expect(header).toContain('Public IPs');
    expect(header).toContain('Basic Public IPs');
    expect(header).toContain('Public IP Addresses');
    expect(header.match(/Basic Public IPs/g)).toHaveLength(1);
    expect(row).toContain('100');
    expect(row).toContain('20');
    expect(row).toContain('70');
  });

  it('labels the canonical Azure public-IP key independently of its localized display name', () => {
    const lines = statusLines([
      current({
        cloud: CloudType.Azure,
        region: 'eastus',
        resourceName: 'Öffentliche IPv4-Adressen – Standard',
        resourceKey: 'azure:standardskupublicipaddresses',
        currentLimit: 100,
      }),
    ]);
    const text = lines.join('\n');

    expect(text).toContain('Public IPs');
    expect(text).toContain('100');
    expect(text).not.toContain('Öffentliche');
  });

  it('labels the Basic Azure public-IP key independently of its localized display name', () => {
    const lines = statusLines([
      current({
        cloud: CloudType.Azure,
        region: 'eastus',
        resourceName: 'Öffentliche IP-Adressen',
        resourceKey: 'azure:publicipaddresses',
        currentLimit: 20,
      }),
    ]);
    const text = lines.join('\n');

    expect(text).toContain('Basic Public IPs');
    expect(text).toContain('20');
    expect(text).not.toContain('Öffentliche');
  });
});

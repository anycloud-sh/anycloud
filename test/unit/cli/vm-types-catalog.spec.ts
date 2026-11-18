import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/cli/utils/catalog-bootstrap.js', () => ({
  bootstrapCatalogsWithUI: vi.fn().mockResolvedValue(undefined),
}));

import { createVmTypesCommand } from '../../../src/cli/commands/vm-types.js';
import { setJsonMode } from '../../../src/cli/utils/output.js';

afterEach(() => {
  setJsonMode(false);
  vi.restoreAllMocks();
});

async function run(...args: string[]): Promise<string> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  log.mockClear();
  await createVmTypesCommand().parseAsync(['node', 'vm-types', ...args]);
  return log.mock.calls.map((call) => String(call[0])).join('\n');
}

// Uses the published catalogs, whose GCP offerings are keyed by zone.
describe('vm-types against the published catalogs', () => {
  it('lists a GCP region across its zones, with parent-region prices', async () => {
    const records = JSON.parse(
      await run('gcp', 'us-central1', '--details', '--json'),
    ) as {
      vmType: string;
      vCPUs: number | null;
      regions: { region: string; onDemandPricePerHour: number | null }[];
    }[];
    expect(records.length).toBeGreaterThan(10);
    const n2 = records.find((record) => record.vmType === 'n2-standard-8');
    expect(n2?.vCPUs).toBe(8);
    const zones = n2!.regions.filter((offering) =>
      offering.region.startsWith('us-central1-'),
    );
    expect(zones.length).toBeGreaterThan(1);
    for (const zone of zones)
      expect(zone.onDemandPricePerHour).toBeGreaterThan(0);
    const names = JSON.parse(await run('gcp', 'us-central1', '--json'));
    expect(names).toEqual(records.map((record) => record.vmType));
  });

  it.each(['us-central1', 'us-central1-a'])(
    'prices the detail table for GCP %s',
    async (placement) => {
      const row = (await run('gcp', placement, '--details'))
        .split('\n')
        .find((line) => line.includes('│ n2-standard-8 '));
      const [, , vCPUs, , , onDemand, spot] = row!
        .split('│')
        .map((cell) => cell.trim());
      expect(vCPUs).toBe('8');
      expect(Number(onDemand)).toBeGreaterThan(0);
      expect(Number(spot)).toBeGreaterThan(0);
    },
  );
});

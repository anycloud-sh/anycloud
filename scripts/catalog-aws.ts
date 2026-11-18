import {
  EC2Client,
  DescribeInstanceTypesCommand,
  DescribeRegionsCommand,
  type DescribeInstanceTypesResult,
} from '@aws-sdk/client-ec2';
import { parse } from 'csv-parse/sync';

const UPSTREAM =
  'https://raw.githubusercontent.com/skypilot-org/skypilot-catalog/master/catalogs/v8/aws/vms.csv';

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Keep upstream hardware/pricing columns and add live, region-specific capabilities. */
export async function enrichAwsCatalog(
  csv: string,
  clientForRegion: (region: string) => {
    send(
      command: DescribeInstanceTypesCommand,
    ): Promise<DescribeInstanceTypesResult>;
  } = (region) => new EC2Client({ region }),
  enabledRegions?: ReadonlySet<string>,
): Promise<string> {
  const rows = parse(csv, { skip_empty_lines: true }) as string[][];
  const header = rows.shift();
  if (!header) throw new Error('AWS catalog has no header');
  const typeColumn = header.indexOf('InstanceType');
  const regionColumn = header.indexOf('Region');
  if (typeColumn < 0 || regionColumn < 0 || rows.length === 0) {
    throw new Error('AWS catalog requires InstanceType, Region, and data rows');
  }
  let capabilityColumn = header.indexOf('NestedVirtualizationSupported');
  if (capabilityColumn < 0) {
    capabilityColumn = header.length;
    header.push('NestedVirtualizationSupported');
  }
  const capabilities = new Map<string, Map<string, boolean>>();
  // Bound requests: paginate one region at a time; SDK retry policy handles throttling.
  for (const region of new Set(
    rows.map((row) => row[regionColumn]).filter(Boolean),
  )) {
    // Opt-in regions unavailable to the publishing identity remain unknown.
    if (enabledRegions && !enabledRegions.has(region)) continue;
    const client = clientForRegion(region);
    const byType = new Map<string, boolean>();
    let nextToken: string | undefined;
    do {
      const response = await client.send(
        new DescribeInstanceTypesCommand({ NextToken: nextToken }),
      );
      for (const type of response.InstanceTypes ?? []) {
        if (type.InstanceType && type.ProcessorInfo) {
          byType.set(
            type.InstanceType.toLowerCase(),
            type.ProcessorInfo.SupportedFeatures?.includes(
              'nested-virtualization',
            ) ?? false,
          );
        }
      }
      nextToken = response.NextToken;
    } while (nextToken);
    capabilities.set(region, byType);
  }
  for (const row of rows) {
    const supported = capabilities
      .get(row[regionColumn])
      ?.get(row[typeColumn].toLowerCase());
    // Replace previous upstream values: only this refresh's metadata is authoritative.
    row[capabilityColumn] = supported === undefined ? '' : String(supported);
  }
  return (
    [header, ...rows]
      .map((row) =>
        Array.from({ length: header.length }, (_, i) =>
          csvCell(row[i] ?? ''),
        ).join(','),
      )
      .join('\n') + '\n'
  );
}

export async function fetchAwsCatalog(): Promise<string> {
  const response = await fetch(UPSTREAM);
  if (!response.ok)
    throw new Error(`AWS upstream catalog HTTP ${response.status}`);
  const regions = await new EC2Client({ region: 'us-east-1' }).send(
    new DescribeRegionsCommand({}),
  );
  const enabled = new Set(
    (regions.Regions ?? []).flatMap((region) =>
      region.RegionName ? [region.RegionName] : [],
    ),
  );
  if (enabled.size === 0) throw new Error('AWS returned no enabled regions');
  return enrichAwsCatalog(await response.text(), undefined, enabled);
}

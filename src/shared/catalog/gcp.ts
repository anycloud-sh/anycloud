/**
 * GCP catalog fetcher.
 *
 * SkyPilot publishes machine and accelerator prices as separate rows. Compute
 * Engine's Machine Types API is the source of truth that relates a VM type to
 * its built-in accelerator. Joining those sources avoids maintaining a static
 * GPU-to-representative-VM map. New accelerator-optimized families are
 * discovered automatically, but publication remains gated by the runtime
 * capability registry.
 *
 * SkyPilot has no rows for some series (C4A). Those come from the same API's
 * machine types, priced from Cloud Billing's per-vCPU and per-GiB SKUs. The
 * API also gives each type's CPU architecture.
 */

import { MachineTypesClient, protos } from '@google-cloud/compute';
import { JWT } from 'google-auth-library';
import { parse } from 'csv-parse/sync';
import { gcpGpuMachineCapability } from '../gcp-machine-capabilities.js';
import { withRetry } from '../utils.js';
import type { CloudCatalogFetcher, VMCatalogEntry } from './fetcher.js';
import { errorMessage } from '../log-diagnostics.js';
import { gcpNestedVirtualization } from './nested-virtualization.js';

const DEFAULT_UPSTREAM =
  'https://raw.githubusercontent.com/skypilot-org/skypilot-catalog/master/catalogs/v8/gcp/vms.csv';

/** Compute Engine's service in the Cloud Billing Catalog API. */
const COMPUTE_SKUS_URL =
  'https://cloudbilling.googleapis.com/v1/services/6F81-5844-456A/skus';

/**
 * Series SkyPilot doesn't publish, by the stem of their core and RAM SKUs'
 * descriptions, e.g. "Spot Preemptible C4A Arm Instance Core running in ...".
 */
const BILLING_PRICED_SERIES: Readonly<Record<string, string>> = {
  c4a: 'C4A Arm Instance',
};
const SKU_DESCRIPTION = /^(?:Spot Preemptible )?(.+) (Core|Ram) running in /;
/** The unit each SKU kind must be billed in for the hourly price to hold. */
const SKU_USAGE_UNIT: Readonly<Record<string, string>> = {
  Core: 'h',
  Ram: 'GiBy.h',
};

const INTENTIONALLY_EXCLUDED_ACCELERATORS = new Set([
  'T4',
  'V100',
  'P100',
  'P4',
  'K80',
]);

interface UpstreamRow {
  InstanceType: string;
  vCPUs: string;
  MemoryGiB: string;
  AcceleratorName: string;
  AcceleratorCount: string;
  GpuInfo: string;
  Region: string;
  AvailabilityZone: string;
  Price: string;
  SpotPrice: string;
}

export interface GcpMachineTypeMetadata {
  instanceType: string;
  zone: string;
  guestCpus: number;
  memoryMb: number;
  acceleratorType: string;
  acceleratorCount: number;
}

/** A machine type in a zone, for a series priced from Cloud Billing. */
interface GcpBillingPricedMachine {
  readonly series: string;
  readonly instanceType: string;
  readonly zone: string;
  readonly guestCpus: number;
  readonly memoryMb: number;
}

interface GcpMachineTypes {
  readonly gpu: GcpMachineTypeMetadata[];
  readonly billingPriced: GcpBillingPricedMachine[];
  /** Each type's architecture, by lowercased name. */
  readonly architectures: Map<string, 'arm64' | 'x86_64'>;
}

interface BillingSku {
  description?: string;
  category?: { usageType?: string };
  serviceRegions?: string[];
  pricingInfo?: {
    pricingExpression?: {
      usageUnit?: string;
      tieredRates?: { unitPrice?: { units?: string; nanos?: number } }[];
    };
  }[];
}

export interface GcpCatalogFetcherOptions {
  projectId: string;
  clientEmail: string;
  privateKey: string;
  upstreamUrl?: string;
  machineTypesClient?: Pick<MachineTypesClient, 'aggregatedListAsync'>;
  billing?: Pick<JWT, 'request'>;
  fetchImpl?: typeof fetch;
}

interface GcpCatalogDiagnostics {
  /** Upstream GPU machine price rows absent from Machine Types in that zone. */
  readonly machinePriceRowsWithoutMetadata: readonly string[];
  /** Authoritative GPU machines lacking the matching accelerator price row. */
  readonly gpuMachinesWithoutAcceleratorPrice: readonly string[];
  /** Fractional G4 rows intentionally withheld from the whole-GPU catalog. */
  readonly fractionalGpuMachineRows: readonly string[];
  /** Accelerator price components that did not join to any published machine. */
  readonly unusedAcceleratorPriceComponents: readonly string[];
}

export interface NormalizedGcpCatalog {
  readonly entries: VMCatalogEntry[];
  readonly diagnostics: GcpCatalogDiagnostics;
}

interface AcceleratorPriceComponent {
  row: UpstreamRow;
  name: string;
  count: number;
  zone: string;
}

function parseNum(value: string): number | null {
  if (!value?.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parsePositiveInteger(value: string): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function resourceName(value: string): string {
  return value.trim().split('/').filter(Boolean).at(-1) ?? '';
}

function normalizedAcceleratorToken(value: string): string {
  return resourceName(value)
    .replace(/^nvidia-/i, '')
    .replace(/^tesla-/i, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function acceleratorTokenWithoutTerminalMemoryCapacity(value: string): string {
  const leaf = resourceName(value)
    .replace(/^nvidia-/i, '')
    .replace(/^tesla-/i, '')
    .replace(/[-_\s]\d+(?:gb|gib)$/i, '');
  return normalizedAcceleratorToken(leaf);
}

function summarize(values: Iterable<string>, limit = 20): string {
  const sorted = [...values].sort();
  const displayed = sorted.slice(0, limit).join(', ');
  return sorted.length > limit
    ? `${displayed}, ... (${sorted.length} total)`
    : displayed;
}

function isIntentionallyExcludedAccelerator(name: string): boolean {
  return (
    name.toLowerCase().startsWith('tpu') ||
    INTENTIONALLY_EXCLUDED_ACCELERATORS.has(name.toUpperCase())
  );
}

/** Resolve a Compute Engine accelerator type to exactly one SkyPilot name. */
export function resolveGcpAcceleratorName(
  acceleratorType: string,
  availableNames: Iterable<string>,
): string {
  const names = [...new Set(availableNames)];
  const target = normalizedAcceleratorToken(acceleratorType);
  if (!target) {
    throw new Error(`Invalid GCP accelerator type: ${acceleratorType}`);
  }

  const match = (token: string): string | null => {
    const matches = names.filter(
      (name) => normalizedAcceleratorToken(name) === token,
    );
    if (matches.length > 1) {
      throw new Error(
        `Ambiguous GCP accelerator type "${acceleratorType}": ${matches.sort().join(', ')}`,
      );
    }
    return matches[0] ?? null;
  };

  const exact = match(target);
  if (exact) return exact;

  const withoutMemory =
    acceleratorTokenWithoutTerminalMemoryCapacity(acceleratorType);
  if (withoutMemory !== target) {
    const fallback = match(withoutMemory);
    if (fallback) return fallback;
  }

  throw new Error(
    `Unknown GCP accelerator type "${acceleratorType}"; upstream names: ${summarize(names) || 'none'}`,
  );
}

function isWholeGpuMachine(metadata: GcpMachineTypeMetadata): boolean {
  if (!metadata.instanceType.toLowerCase().startsWith('g4-')) return true;
  return metadata.guestCpus === 48 * metadata.acceleratorCount;
}

function machineKey(zone: string, instanceType: string): string {
  return `${zone}|${instanceType.toLowerCase()}`;
}

function acceleratorKey(zone: string, name: string, count: number): string {
  return `${zone}|${name}|${count}`;
}

function fullPrice(
  machinePrice: string,
  acceleratorPrice: string,
): number | null {
  const machine = parseNum(machinePrice);
  const accelerator = parseNum(acceleratorPrice);
  return machine === null ||
    machine < 0 ||
    accelerator === null ||
    accelerator < 0
    ? null
    : Number((machine + accelerator).toFixed(10));
}

function regionFromZone(zone: string): string | null {
  const separator = zone.lastIndexOf('-');
  return separator > 0 ? zone.slice(0, separator) : null;
}

function toCpuEntry(row: UpstreamRow): VMCatalogEntry {
  return {
    instanceType: row.InstanceType,
    region: row.Region,
    availabilityZone: row.AvailabilityZone || null,
    price: parseNum(row.Price),
    spotPrice: parseNum(row.SpotPrice),
    vCPUs: parseNum(row.vCPUs),
    memoryGiB: parseNum(row.MemoryGiB),
    acceleratorName: null,
    acceleratorCount: null,
    gpuInfo: null,
    generation: null,
    nestedVirtualizationSupported: gcpNestedVirtualization(row.InstanceType),
  };
}

/** Join SkyPilot price components to authoritative Compute Engine metadata. */
export function normalizeGcpCatalogWithDiagnostics(
  csv: string,
  machineTypes: readonly GcpMachineTypeMetadata[],
): NormalizedGcpCatalog {
  const records = parse(csv, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
  }) as UpstreamRow[];

  const acceleratorRows = records.filter(
    (row) => !row.InstanceType?.trim() && row.AcceleratorName?.trim(),
  );
  const availableAcceleratorNames = new Set(
    acceleratorRows
      .map((row) => row.AcceleratorName.trim())
      .filter((name) => !isIntentionallyExcludedAccelerator(name)),
  );

  const components = new Map<string, AcceleratorPriceComponent>();
  for (const row of acceleratorRows) {
    const name = row.AcceleratorName.trim();
    if (isIntentionallyExcludedAccelerator(name)) continue;
    const count = parsePositiveInteger(row.AcceleratorCount);
    const zone = row.AvailabilityZone?.trim();
    if (!count || !zone || !row.Region?.trim()) {
      throw new Error(
        `Invalid GCP accelerator price row: ${name || 'unknown'}:${row.AcceleratorCount || 'unknown'} in ${zone || 'unknown zone'}`,
      );
    }
    const key = acceleratorKey(zone, name, count);
    if (components.has(key)) {
      throw new Error(`Duplicate GCP accelerator price component: ${key}`);
    }
    components.set(key, { row, name, count, zone });
  }

  const metadataByMachine = new Map<string, GcpMachineTypeMetadata>();
  const eligibleMachineNames = new Set<string>();
  const excludedMachineNames = new Set<string>();
  for (const metadata of machineTypes) {
    const instanceType = metadata.instanceType?.trim();
    const zone = metadata.zone?.trim();
    const acceleratorType = metadata.acceleratorType?.trim();
    if (
      !instanceType ||
      !zone ||
      !acceleratorType ||
      !Number.isInteger(metadata.guestCpus) ||
      metadata.guestCpus <= 0 ||
      !Number.isFinite(metadata.memoryMb) ||
      metadata.memoryMb <= 0 ||
      !Number.isInteger(metadata.acceleratorCount) ||
      metadata.acceleratorCount <= 0
    ) {
      throw new Error(
        `Invalid GCP GPU machine metadata: ${zone || 'unknown zone'}/${instanceType || 'unknown type'}`,
      );
    }

    const key = machineKey(zone, instanceType);
    if (metadataByMachine.has(key)) {
      throw new Error(`Duplicate GCP GPU machine metadata: ${key}`);
    }
    metadataByMachine.set(key, metadata);
    if (isWholeGpuMachine(metadata)) {
      eligibleMachineNames.add(instanceType.toLowerCase());
    } else {
      excludedMachineNames.add(instanceType.toLowerCase());
    }
  }

  const consumedAcceleratorPairs = new Set<string>();
  const consumedAcceleratorComponents = new Set<string>();
  const errors = new Set<string>();
  const machinePriceRowsWithoutMetadata = new Set<string>();
  const gpuMachinesWithoutAcceleratorPrice = new Set<string>();
  const fractionalGpuMachineRows = new Set<string>();
  const out: VMCatalogEntry[] = [];

  for (const row of records) {
    const instanceType = row.InstanceType?.trim();
    if (!instanceType) continue;
    if (row.AcceleratorName?.trim()) {
      errors.add(`unexpected combined machine/accelerator row ${instanceType}`);
      continue;
    }

    const zone = row.AvailabilityZone?.trim();
    const normalizedInstanceType = instanceType.toLowerCase();
    const metadata = zone
      ? metadataByMachine.get(machineKey(zone, instanceType))
      : undefined;

    if (!metadata) {
      if (excludedMachineNames.has(normalizedInstanceType)) {
        fractionalGpuMachineRows.add(
          `${zone || 'unknown zone'}/${instanceType}`,
        );
        continue;
      }
      if (
        eligibleMachineNames.has(normalizedInstanceType) ||
        gcpGpuMachineCapability(instanceType)
      ) {
        // The upstream price catalog and Compute Engine availability do not
        // always agree at zone granularity. The API is authoritative: do not
        // emit this row, and do not let it leak into the CPU catalog.
        machinePriceRowsWithoutMetadata.add(
          `${zone || 'unknown zone'}/${instanceType}`,
        );
        continue;
      }
      out.push(toCpuEntry(row));
      continue;
    }

    if (!isWholeGpuMachine(metadata)) {
      fractionalGpuMachineRows.add(`${zone || 'unknown zone'}/${instanceType}`);
      continue;
    }
    if (!zone) {
      errors.add(`missing zone for GPU machine ${instanceType}`);
      continue;
    }
    const capability = gcpGpuMachineCapability(instanceType);
    if (!capability) {
      errors.add(
        `GCP GPU machine series is not launch-qualified: ${instanceType} (unknown series)`,
      );
      continue;
    }
    if (!capability.launchQualified) {
      errors.add(
        `GCP GPU machine series is not launch-qualified: ${instanceType} (${capability.reason})`,
      );
      continue;
    }
    const region = regionFromZone(zone);
    if (!region || row.Region?.trim() !== region) {
      errors.add(
        `region/zone mismatch for ${zone}/${instanceType}: ${row.Region || 'missing region'}`,
      );
      continue;
    }

    let acceleratorName: string;
    try {
      acceleratorName = resolveGcpAcceleratorName(
        metadata.acceleratorType,
        availableAcceleratorNames,
      );
    } catch (error) {
      errors.add(errorMessage(error));
      continue;
    }

    const componentKey = acceleratorKey(
      zone,
      acceleratorName,
      metadata.acceleratorCount,
    );
    const component = components.get(componentKey);
    if (!component) {
      // SkyPilot can have a machine component without the corresponding
      // accelerator component in a zone. Without both components there is no
      // complete VM price, so this zone is not eligible for publication.
      gpuMachinesWithoutAcceleratorPrice.add(
        `${zone}/${instanceType}/${acceleratorName}:${metadata.acceleratorCount}`,
      );
      continue;
    }

    const price = fullPrice(row.Price, component.row.Price);
    const spotPrice = fullPrice(row.SpotPrice, component.row.SpotPrice);
    if (
      !((price !== null && price > 0) || (spotPrice !== null && spotPrice > 0))
    ) {
      errors.add(`no complete price for ${zone}/${instanceType}`);
      continue;
    }

    consumedAcceleratorPairs.add(
      `${component.name}:${metadata.acceleratorCount}`,
    );
    consumedAcceleratorComponents.add(componentKey);
    out.push({
      instanceType,
      region,
      availabilityZone: zone,
      price,
      spotPrice,
      vCPUs: metadata.guestCpus,
      memoryGiB: metadata.memoryMb / 1024,
      acceleratorName: component.name,
      acceleratorCount: metadata.acceleratorCount,
      gpuInfo: component.row.GpuInfo || null,
      generation: null,
      nestedVirtualizationSupported: gcpNestedVirtualization(instanceType),
    });
  }

  const upstreamAcceleratorPairs = new Set(
    [...components.values()].map(
      (component) => `${component.name}:${component.count}`,
    ),
  );
  const unconsumed = [...upstreamAcceleratorPairs].filter(
    (pair) => !consumedAcceleratorPairs.has(pair),
  );
  if (unconsumed.length > 0) {
    errors.add(
      `unconsumed accelerator name/count pairs: ${summarize(unconsumed)}`,
    );
  }
  if (errors.size > 0) {
    throw new Error(`GCP catalog join failed: ${summarize(errors)}`);
  }

  return {
    entries: out,
    diagnostics: {
      machinePriceRowsWithoutMetadata: [
        ...machinePriceRowsWithoutMetadata,
      ].sort(),
      gpuMachinesWithoutAcceleratorPrice: [
        ...gpuMachinesWithoutAcceleratorPrice,
      ].sort(),
      fractionalGpuMachineRows: [...fractionalGpuMachineRows].sort(),
      unusedAcceleratorPriceComponents: [...components.keys()]
        .filter((key) => !consumedAcceleratorComponents.has(key))
        .sort(),
    },
  };
}

/** Hourly on-demand or spot price per vCPU or GiB, by series, region and kind. */
function skuRates(skus: readonly BillingSku[]): Map<string, number> {
  const seriesByStem = new Map(
    Object.entries(BILLING_PRICED_SERIES).map(([series, stem]) => [
      stem,
      series,
    ]),
  );
  const rates = new Map<string, number>();
  for (const sku of skus) {
    const match = SKU_DESCRIPTION.exec(sku.description ?? '');
    const series = match && seriesByStem.get(match[1]);
    const usage = sku.category?.usageType;
    const expression = sku.pricingInfo?.[0]?.pricingExpression;
    const rate = expression?.tieredRates?.at(-1)?.unitPrice;
    if (
      !series ||
      (usage !== 'OnDemand' && usage !== 'Preemptible') ||
      expression?.usageUnit !== SKU_USAGE_UNIT[match[2]] ||
      !rate
    )
      continue;
    const price = Number(rate.units ?? 0) + (rate.nanos ?? 0) / 1e9;
    for (const region of sku.serviceRegions ?? []) {
      rates.set(`${series}|${region}|${usage}|${match[2]}`, price);
    }
  }
  return rates;
}

/** Catalog rows for Billing-priced series' machine types SkyPilot lacks. */
function billingPricedEntries(
  machines: readonly GcpBillingPricedMachine[],
  skus: readonly BillingSku[],
  publishedTypes: ReadonlySet<string>,
): VMCatalogEntry[] {
  const rates = skuRates(skus);
  const priced = new Set<string>();
  const out: VMCatalogEntry[] = [];
  for (const machine of machines) {
    if (publishedTypes.has(machine.instanceType.toLowerCase())) continue;
    const region = regionFromZone(machine.zone);
    const memoryGiB = machine.memoryMb / 1024;
    const price = (usage: string) => {
      const core = rates.get(`${machine.series}|${region}|${usage}|Core`);
      const ram = rates.get(`${machine.series}|${region}|${usage}|Ram`);
      return core === undefined || ram === undefined
        ? null
        : Number((core * machine.guestCpus + ram * memoryGiB).toFixed(10));
    };
    const onDemand = price('OnDemand');
    const spot = price('Preemptible');
    if (!region || (onDemand === null && spot === null)) continue;
    priced.add(machine.series);
    out.push({
      instanceType: machine.instanceType,
      region,
      availabilityZone: machine.zone,
      price: onDemand,
      spotPrice: spot,
      vCPUs: machine.guestCpus,
      memoryGiB,
      acceleratorName: null,
      acceleratorCount: null,
      gpuInfo: null,
      generation: null,
      nestedVirtualizationSupported: gcpNestedVirtualization(
        machine.instanceType,
      ),
    });
  }
  const unpriced = new Set(
    machines.map(({ series }) => series).filter((s) => !priced.has(s)),
  );
  if (unpriced.size > 0) {
    throw new Error(
      `Cloud Billing has no complete price for ${summarize(unpriced)}`,
    );
  }
  return out;
}

export class GcpCatalogFetcher implements CloudCatalogFetcher {
  private readonly upstreamUrl: string;
  private readonly machineTypesClient: Pick<
    MachineTypesClient,
    'aggregatedListAsync'
  >;
  private readonly fetchImpl: typeof fetch;
  private readonly billing: Pick<JWT, 'request'>;

  constructor(private readonly options: GcpCatalogFetcherOptions) {
    this.upstreamUrl = options.upstreamUrl ?? DEFAULT_UPSTREAM;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.billing =
      options.billing ??
      new JWT({
        email: options.clientEmail,
        key: options.privateKey,
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      });
    this.machineTypesClient =
      options.machineTypesClient ??
      new MachineTypesClient({
        projectId: options.projectId,
        credentials: {
          client_email: options.clientEmail,
          private_key: options.privateKey,
        },
      });
  }

  async fetchAll(): Promise<VMCatalogEntry[]> {
    const [csv, machineTypes, skus] = await Promise.all([
      this.fetchUpstream(),
      this.fetchMachineTypes(),
      this.fetchSkus(),
    ]);
    const normalized = normalizeGcpCatalogWithDiagnostics(
      csv,
      machineTypes.gpu,
    );
    const diagnostics = Object.entries(normalized.diagnostics).filter(
      ([, values]) => values.length > 0,
    );
    if (diagnostics.length > 0) {
      console.warn(
        'GCP catalog join diagnostics:\n' +
          diagnostics
            .map(
              ([reason, values]) =>
                `  ${reason}: ${values.length} (${summarize(values)})`,
            )
            .join('\n'),
      );
    }
    const entries = [
      ...normalized.entries,
      ...billingPricedEntries(
        machineTypes.billingPriced,
        skus,
        new Set(normalized.entries.map((e) => e.instanceType.toLowerCase())),
      ),
    ];
    return entries.map((entry) => ({
      ...entry,
      arch:
        machineTypes.architectures.get(entry.instanceType.toLowerCase()) ??
        null,
    }));
  }

  private fetchSkus(): Promise<BillingSku[]> {
    return withRetry(
      async () => {
        const skus: BillingSku[] = [];
        let pageToken = '';
        do {
          const url = `${COMPUTE_SKUS_URL}?currencyCode=USD&pageSize=5000${pageToken && `&pageToken=${encodeURIComponent(pageToken)}`}`;
          const { data } = await this.billing.request<{
            skus?: BillingSku[];
            nextPageToken?: string;
          }>({ url, timeout: 60_000 });
          skus.push(...(data.skus ?? []));
          pageToken = data.nextPageToken ?? '';
        } while (pageToken);
        return skus;
      },
      'Fetch Compute Engine SKUs from Cloud Billing',
      { maxAttempts: 3, waitMs: 5_000 },
    );
  }

  private fetchUpstream(): Promise<string> {
    return withRetry(
      async () => {
        const response = await this.fetchImpl(this.upstreamUrl, {
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
      },
      'Fetch SkyPilot GCP catalog',
      { maxAttempts: 3, waitMs: 5_000 },
    );
  }

  private fetchMachineTypes(): Promise<GcpMachineTypes> {
    return withRetry(
      async () => {
        const machineTypes: GcpMachineTypeMetadata[] = [];
        const billingPriced: GcpBillingPricedMachine[] = [];
        const architectures = new Map<string, 'arm64' | 'x86_64'>();
        let listed = 0;
        const request: protos.google.cloud.compute.v1.IAggregatedListMachineTypesRequest =
          {
            project: this.options.projectId,
            maxResults: 500,
            returnPartialSuccess: false,
          };

        for await (const [
          scope,
          scopedList,
        ] of this.machineTypesClient.aggregatedListAsync(request)) {
          const scopeZone = resourceName(scope);
          for (const machineType of scopedList.machineTypes ?? []) {
            listed++;
            const name = machineType.name ?? '';
            const zone = resourceName(machineType.zone ?? '') || scopeZone;
            const architecture = machineType.architecture;
            if (architecture === 'ARM64' || architecture === 'X86_64') {
              architectures.set(
                name.toLowerCase(),
                architecture === 'ARM64' ? 'arm64' : 'x86_64',
              );
            }
            // Local SSD and bare-metal variants have SKUs of their own.
            const [series] = name.split('-');
            if (
              BILLING_PRICED_SERIES[series] &&
              new RegExp(`^${series}-[a-z]+-\\d+$`).test(name)
            ) {
              billingPriced.push({
                series,
                instanceType: name,
                zone,
                guestCpus: machineType.guestCpus ?? 0,
                memoryMb: machineType.memoryMb ?? 0,
              });
            }
            const accelerators = machineType.accelerators ?? [];
            if (accelerators.length === 0) continue;
            if (accelerators.length !== 1) {
              throw new Error(
                `Expected exactly one accelerator type for ${scopeZone}/${machineType.name ?? 'unknown type'}`,
              );
            }
            const accelerator = accelerators[0];
            machineTypes.push({
              instanceType: name,
              zone,
              guestCpus: machineType.guestCpus ?? 0,
              memoryMb: machineType.memoryMb ?? 0,
              acceleratorType: resourceName(
                accelerator.guestAcceleratorType ?? '',
              ),
              acceleratorCount: accelerator.guestAcceleratorCount ?? 0,
            });
          }
        }

        if (listed === 0) {
          throw new Error(
            'Compute Engine Machine Types API returned no machine types',
          );
        }
        return { gpu: machineTypes, billingPriced, architectures };
      },
      'Fetch GCP machine type metadata',
      { maxAttempts: 3, waitMs: 5_000 },
    );
  }
}

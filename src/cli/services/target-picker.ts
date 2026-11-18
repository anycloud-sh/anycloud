import { CloudType } from '../../shared/cloud.js';
import {
  getGpuOfferings,
  getCpuOfferings,
  getDiskForVMType,
  type GpuOffering,
  type CpuOffering,
  type DiskOffering,
  type GetGpuOfferingsOptions,
} from '../../shared/catalog/queries.js';
import { resolveVMType } from '../../shared/cloud-config.js';
import { safePrompts } from '../utils/safe-prompts.js';
import { exitWithError } from '../utils/output.js';
import { suggestFilter } from '../utils/suggest-filter.js';

export interface ComputeTarget {
  kind: 'vmType';
  vmType: string;
}

interface GpuComputeTarget {
  kind: 'gpuType';
  gpuType: string;
}

export type InteractiveComputeTarget = ComputeTarget | GpuComputeTarget;

interface ComputeTargetQuotaHints {
  label: string;
  regionsForVmType: (vmType: string) => string[];
}

export interface PickComputeTargetOptions {
  allowGpuTypes?: boolean;
  quota?: ComputeTargetQuotaHints;
  spotOnly?: boolean;
}

type PriceLabelMode = 'on-demand-preferred' | 'spot';

function formatRateLabel(rate: number, spot: boolean): string {
  const price = rate >= 1 ? rate.toFixed(2) : rate.toFixed(4);
  return spot ? `$${price}/hr spot` : `$${price}/hr`;
}

/** Rate label for an offering ("$/hr"), or "—" when unpriced. */
function rateLabel(o: GpuOffering | CpuOffering, mode: PriceLabelMode): string {
  if (mode === 'spot') {
    const rate = o.spot?.pricePerHour;
    return rate === undefined ? '—' : formatRateLabel(rate, true);
  }

  const rate = o.onDemand?.pricePerHour;
  if (rate !== undefined) return formatRateLabel(rate, false);
  const spotRate = o.spot?.pricePerHour;
  if (spotRate !== undefined) return formatRateLabel(spotRate, true);
  return '—';
}

function storageLabel(gb: number): string {
  if (gb >= 1000) {
    const tb = gb / 1000;
    return `${Number.isInteger(tb) ? tb.toFixed(0) : tb.toFixed(1)} TB`;
  }
  return `${gb.toFixed(Number.isInteger(gb) ? 0 : 1)} GB`;
}

function diskLabel(disk: DiskOffering | undefined): string {
  if (!disk) return '';
  if (disk.kind === 'disk') return `${storageLabel(disk.totalGb)} disk`;
  return `${storageLabel(disk.totalGb)} ${(disk.type ?? 'SSD').toUpperCase()}`;
}

interface TargetChoiceRow {
  key: string;
  compute: string;
  cpu: string;
  memory: string;
  disk: string;
  rate: string;
  quota: string;
  hasQuota: boolean;
}

function formatChoices(
  rows: TargetChoiceRow[],
): Map<string, { title: string; value: string }> {
  const showDisk = rows.some((r) => r.disk);
  const showQuota = rows.some((r) => r.quota);
  const widths = {
    key: Math.max(...rows.map((r) => r.key.length)),
    compute: Math.max(...rows.map((r) => r.compute.length)),
    cpu: Math.max(...rows.map((r) => r.cpu.length)),
    memory: Math.max(...rows.map((r) => r.memory.length)),
    disk: showDisk ? Math.max(...rows.map((r) => r.disk.length)) : 0,
    quota: showQuota ? Math.max(...rows.map((r) => r.quota.length)) : 0,
  };

  return new Map(
    rows.map((row) => {
      const columns = [
        row.key.padEnd(widths.key),
        row.compute.padEnd(widths.compute),
        row.cpu.padStart(widths.cpu),
        row.memory.padStart(widths.memory),
      ];
      if (showDisk) columns.push(row.disk.padEnd(widths.disk));
      columns.push(row.rate);
      if (showQuota) columns.push(row.quota.padEnd(widths.quota));

      return [row.key, { title: columns.join('  ').trimEnd(), value: row.key }];
    }),
  );
}

function quotaLabel(
  hints: ComputeTargetQuotaHints | undefined,
  vmType: string,
): { quota: string; hasQuota: boolean } {
  if (!hints) return { quota: '', hasQuota: false };
  const regions = hints.regionsForVmType(vmType);
  if (regions.length === 0) return { quota: '', hasQuota: false };
  const shown = regions.slice(0, 2);
  const more = regions.length - shown.length;
  const suffix = more > 0 ? ` +${more} more` : '';
  return {
    quota: `${hints.label}: ${shown.join(', ')}${suffix}`,
    hasQuota: true,
  };
}

function rankRows(rows: TargetChoiceRow[]): TargetChoiceRow[] {
  return [
    ...rows.filter((row) => row.hasQuota),
    ...rows.filter((row) => !row.hasQuota),
  ];
}

function validGpuOfferings(
  cloud: CloudType,
  options?: GetGpuOfferingsOptions,
): GpuOffering[] {
  // Drop fractional-GPU offerings (e.g. L4:0.125) — not a sensible submit target
  // (mirrors quota.ts buildGPUChoices).
  const offerings = options
    ? getGpuOfferings(cloud, undefined, options)
    : getGpuOfferings(cloud);
  return offerings.filter((o) => Number.isInteger(o.count) && o.count >= 1);
}

export function hasSpotComputeOfferings(cloud: CloudType): boolean {
  return (
    validGpuOfferings(cloud, { pricingMode: 'spot' }).some(
      (o) => o.spot !== null,
    ) || getCpuOfferings(cloud).some((o) => o.spot !== null)
  );
}

function cpuPickerOfferings(
  cloud: CloudType,
  options: PickComputeTargetOptions,
): CpuOffering[] {
  const cpu = getCpuOfferings(cloud).filter(
    (o) => !options.spotOnly || o.spot !== null,
  );
  if (!options.spotOnly) return cpu;

  return cpu.sort(
    (a, b) =>
      (a.spot?.pricePerHour ?? Infinity) - (b.spot?.pricePerHour ?? Infinity) ||
      a.vmType.localeCompare(b.vmType),
  );
}

interface ComputeOfferings {
  /** Concrete VM offerings for the exact-VM picker. */
  gpu: GpuOffering[];
  /** GPU aliases whose server-resolved representative supports this pricing mode. */
  gpuAliases: GpuOffering[];
  gpuByAlias: Map<string, GpuOffering>;
  cpu: CpuOffering[];
}

function loadComputeOfferings(
  cloud: CloudType,
  options: PickComputeTargetOptions,
): ComputeOfferings {
  // The server resolves aliases using the catalog's on-demand-ranked index.
  // Keep those representatives separately so alias rows always describe the
  // VM that will actually be provisioned, even when spot pricing ranks a
  // different sibling as cheaper.
  const resolvedGpu = validGpuOfferings(cloud);
  const gpuByAlias = new Map(resolvedGpu.map((o) => [gpuAlias(o), o]));
  const gpu = options.spotOnly
    ? validGpuOfferings(cloud, { pricingMode: 'spot' })
    : resolvedGpu;
  const gpuAliases = options.spotOnly
    ? gpu.filter((o) => {
        const resolved = gpuByAlias.get(gpuAlias(o));
        return resolved?.spot !== null;
      })
    : resolvedGpu;
  return {
    gpu,
    gpuAliases,
    gpuByAlias,
    cpu: cpuPickerOfferings(cloud, options),
  };
}

function gpuAlias(o: GpuOffering): string {
  return `${o.gpu.toLowerCase()}:${o.count}`;
}

function gpuAliasRows(
  cloud: CloudType,
  gpu: GpuOffering[],
  gpuByAlias: Map<string, GpuOffering>,
  options: PickComputeTargetOptions,
  priceLabelMode: PriceLabelMode,
): TargetChoiceRow[] {
  return gpu.map((o) => {
    const alias = gpuAlias(o);
    const resolvedVmType = resolveVMType(alias, cloud);
    // `gpuByAlias` is built with the same on-demand-ranked catalog view as
    // resolveVMType, so it supplies the resolved VM's specs, price, and quota.
    const resolved = gpuByAlias.get(alias);
    const representative =
      resolved?.vmType.toLowerCase() === resolvedVmType.toLowerCase()
        ? resolved
        : o;
    // An offering loaded from the catalog always resolves. Keep the fallback
    // for isolated callers with a partial catalog.
    const vmType =
      resolvedVmType === alias ? representative.vmType : resolvedVmType;
    const quota = quotaLabel(options.quota, representative.vmType);
    return {
      key: alias,
      compute: vmType,
      cpu: `${representative.vCPUs} vCPU`,
      memory: `${representative.memoryGiB} GiB`,
      disk: diskLabel(getDiskForVMType(cloud, representative.vmType)),
      rate: rateLabel(representative, priceLabelMode),
      ...quota,
    };
  });
}

async function pickGpuTypeTargetFromOfferings(
  cloud: CloudType,
  offerings: ComputeOfferings,
  options: PickComputeTargetOptions,
): Promise<GpuComputeTarget> {
  if (offerings.gpuAliases.length === 0) {
    exitWithError(
      options.spotOnly
        ? `No spot GPU offerings found for ${cloud}. Pass --gpu-type <type> explicitly or omit --spot.`
        : `No GPU offerings found for ${cloud}. Pass --gpu-type <type> explicitly.`,
    );
  }

  const priceLabelMode: PriceLabelMode = options.spotOnly
    ? 'spot'
    : 'on-demand-preferred';
  const rows = rankRows(
    gpuAliasRows(
      cloud,
      offerings.gpuAliases,
      offerings.gpuByAlias,
      options,
      priceLabelMode,
    ),
  );
  const choiceByAlias = formatChoices(rows);
  const choices = rows.map((r) => choiceByAlias.get(r.key)!);

  const selection = await safePrompts<'gpuType'>({
    type: 'autocomplete',
    name: 'gpuType',
    message: 'Pick a GPU type',
    hint: `⌨️  Type to search all ${choices.length} GPU types`,
    limit: 12,
    choices,
    suggest: suggestFilter,
  });
  const gpuType = selection.gpuType as string | undefined;
  if (!gpuType) process.exit(0);

  return {
    kind: 'gpuType',
    gpuType,
  };
}

async function pickVmTypeTargetFromOfferings(
  cloud: CloudType,
  offerings: ComputeOfferings,
  options: PickComputeTargetOptions,
): Promise<ComputeTarget> {
  const { gpu, cpu } = offerings;

  if (gpu.length === 0 && cpu.length === 0) {
    exitWithError(
      options.spotOnly
        ? `No spot compute offerings found for ${cloud}. Pass --vm-type <type> explicitly or omit --spot.`
        : `No compute offerings found for ${cloud}. Pass --vm-type <type> explicitly.`,
    );
  }

  const priceLabelMode: PriceLabelMode = options.spotOnly
    ? 'spot'
    : 'on-demand-preferred';
  const gpuRows: TargetChoiceRow[] = [];
  for (const o of gpu) {
    const quota = quotaLabel(options.quota, o.vmType);
    gpuRows.push({
      key: o.vmType,
      compute: `${o.count}x ${o.gpu}`,
      cpu: `${o.vCPUs} vCPU`,
      memory: `${o.memoryGiB} GiB`,
      disk: diskLabel(getDiskForVMType(cloud, o.vmType)),
      rate: rateLabel(o, priceLabelMode),
      ...quota,
    });
  }

  const cpuRows: TargetChoiceRow[] = [];
  for (const o of cpu) {
    const quota = quotaLabel(options.quota, o.vmType);
    cpuRows.push({
      key: o.vmType,
      compute: 'CPU',
      cpu: `${o.vCPUs} vCPU`,
      memory: `${o.memoryGiB} GiB`,
      disk: diskLabel(getDiskForVMType(cloud, o.vmType)),
      rate: rateLabel(o, priceLabelMode),
      ...quota,
    });
  }

  const rankedRows = rankRows([...gpuRows, ...cpuRows]);
  const choiceByVmType = formatChoices(rankedRows);
  const choices = rankedRows.map((r) => choiceByVmType.get(r.key)!);

  // Curated default (shown before any typing): all GPU offerings + the cheapest
  // CPU instance at each common vCPU tier — keeps the no-typing list short on
  // clouds with 100+ CPU shapes. `cpu` is cheapest-first, so the first match per
  // tier is cheapest; everything else stays reachable by typing (see `suggest`).
  const CPU_VCPU_TIERS = [2, 4, 8, 16, 32, 64, 128];
  const curatedCpuRows: TargetChoiceRow[] = [];
  for (const tier of CPU_VCPU_TIERS) {
    const match = cpu.find((o) => o.vCPUs === tier);
    const row = match && cpuRows.find((r) => r.key === match.vmType);
    if (row) curatedCpuRows.push(row);
  }
  const curated = rankRows([...gpuRows, ...curatedCpuRows]).map(
    (row) => choiceByVmType.get(row.key)!,
  );

  const selection = await safePrompts<'vmType'>({
    type: 'autocomplete',
    name: 'vmType',
    message: 'Pick a VM type',
    hint: `⌨️  Type to search all ${choices.length} instance types`,
    limit: 12,
    choices,
    // Empty input → short curated view; typing → full substring search over all.
    suggest: (input: string) =>
      input.trim() ? suggestFilter(input, choices) : Promise.resolve(curated),
  });
  const vmType = selection.vmType as string | undefined;
  if (!vmType) process.exit(0);

  return {
    kind: 'vmType',
    vmType,
  };
}

/** Autocomplete over the given regions; exits cleanly when the user aborts. */
export async function pickRegion(regions: string[]): Promise<string> {
  const selection = await safePrompts<'region'>({
    type: 'autocomplete',
    name: 'region',
    message: 'Pick a region',
    hint: 'Type to filter',
    choices: regions.map((region) => ({ title: region, value: region })),
    suggest: suggestFilter,
  });
  if (!selection.region) process.exit(0);
  return String(selection.region);
}

/**
 * Interactive single-select compute-target picker for a cloud. One searchable
 * autocomplete list of GPU offerings + CPU shapes (deduped to cheapest-per-(vCPU,
 * memory)). Catalogs run 150+ rows per cloud, so the no-typing view shows a short
 * curated set (all GPU offerings + the cheapest CPU at each common vCPU tier) and
 * typing searches the FULL catalog — nothing is hidden. Resolves to a concrete vmType.
 *
 * Catalog-only by design — an off-catalog vmType can't deploy cleanly in the
 * unpinned-region flow, so the `--vm-type` flag is the explicit escape.
 */
export async function pickVmTypeTarget(
  cloud: CloudType,
  options: PickComputeTargetOptions = {},
): Promise<ComputeTarget> {
  return pickVmTypeTargetFromOfferings(
    cloud,
    loadComputeOfferings(cloud, options),
    options,
  );
}

export async function pickComputeTarget(
  cloud: CloudType,
  options: PickComputeTargetOptions = {},
): Promise<InteractiveComputeTarget> {
  const offerings = loadComputeOfferings(cloud, options);
  if (!options.allowGpuTypes || offerings.gpuAliases.length === 0) {
    return pickVmTypeTargetFromOfferings(cloud, offerings, options);
  }

  const selection = await safePrompts<'targetKind'>({
    type: 'select',
    name: 'targetKind',
    message: 'Pick compute target',
    choices: [
      { title: 'Pick by GPU type', value: 'gpuType' },
      { title: 'Pick exact VM type', value: 'vmType' },
    ],
  });
  const targetKind = selection.targetKind as 'gpuType' | 'vmType' | undefined;
  if (!targetKind) process.exit(0);

  return targetKind === 'gpuType'
    ? pickGpuTypeTargetFromOfferings(cloud, offerings, options)
    : pickVmTypeTargetFromOfferings(cloud, offerings, options);
}

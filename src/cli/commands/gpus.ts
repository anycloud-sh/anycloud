import { Command } from 'commander';
import chalk from 'chalk';
import { newTable } from '../renderers/table.js';
import {
  getGpuOfferings,
  type GpuOffering,
} from '../../shared/catalog/queries.js';
import { getAvailableGPUs as getAvailableGpuNames } from '../../shared/cloud-config.js';
import { CloudType } from '../../shared/cloud.js';
import { bootstrapCatalogsWithUI } from '../utils/catalog-bootstrap.js';
import {
  normalizeProvider,
  PROVIDER_PROMPT_CHOICES,
} from '../utils/providers.js';
import { CATALOG_BACKED_CLOUDS } from '../../shared/providers.js';
import {
  printError,
  printInfo,
  setJsonMode,
  exitWithError,
} from '../utils/output.js';
import { suggestFilter } from '../utils/suggest-filter.js';
import { safePrompts, shouldAllowPrompts } from '../utils/safe-prompts.js';

const ROLLUP_CLOUDS: readonly CloudType[] = CATALOG_BACKED_CLOUDS;

interface CrossCloudRow {
  cloud: CloudType;
  gpu: string;
  count: number;
  vmType: string;
  region: string;
  pricePerHour: number;
  spot: boolean;
}

type GpuTarget = 'all' | string;

async function promptGpuTarget(): Promise<GpuTarget> {
  const selection = await safePrompts<'target'>({
    type: 'select',
    name: 'target',
    message: 'Show GPUs for',
    choices: [
      { title: 'Compare all clouds', value: 'all' },
      ...PROVIDER_PROMPT_CHOICES,
    ],
  });
  if (!selection.target) process.exit(0);
  return String(selection.target);
}

async function promptGpuTypeAcrossClouds(): Promise<string> {
  const names = new Set<string>();
  for (const cloud of ROLLUP_CLOUDS) {
    for (const gpu of getAvailableGpuNames(cloud)) names.add(gpu);
  }

  const choices = [...names]
    .sort((a, b) => a.localeCompare(b))
    .map((gpu) => ({ title: gpu, value: gpu }));
  if (choices.length === 0) {
    exitWithError('No GPU types found in the catalogs.');
  }

  const selection = await safePrompts<'gpuType'>({
    type: 'autocomplete',
    name: 'gpuType',
    message: 'Pick a GPU type',
    hint: 'Type to filter',
    choices,
    suggest: suggestFilter,
  });
  if (!selection.gpuType) process.exit(0);
  return String(selection.gpuType);
}

function pickCheapest(
  offering: GpuOffering,
  spotPreferred: boolean,
): { region: string; pricePerHour: number; spot: boolean } | null {
  if (spotPreferred && offering.spot) {
    return { ...offering.spot, spot: true };
  }
  if (offering.onDemand) {
    return { ...offering.onDemand, spot: false };
  }
  if (offering.spot) {
    return { ...offering.spot, spot: true };
  }
  return null;
}

export function createGpusCommand(): Command {
  return new Command('gpus')
    .description('🎮 List available GPUs and prices for a cloud')
    .argument(
      '[cloud]',
      'Cloud: aws, gcp, azure, or lambda. Omit to compare the cheapest match across all clouds (requires --type non-interactively).',
    )
    .option(
      '--type <gpu>',
      'Filter to a specific GPU SKU (e.g. H100). Required when cloud is omitted non-interactively.',
    )
    .option(
      '--count <n>',
      'Filter the cross-cloud comparison to a specific GPU count (e.g. 8).',
    )
    .option(
      '--spot',
      'Sort the cross-cloud comparison by spot price (falls back to on-demand if a cloud has no spot data).',
    )
    .option('--json', 'Emit results as JSON')
    .addHelpText(
      'after',
      `
Examples:
  $ anycloud gpus
  $ anycloud gpus aws
  $ anycloud gpus gcp --type H100
  $ anycloud gpus --type H100 --count 8 --spot
  $ anycloud gpus --type H200 --json
`,
    )
    .action(
      async (
        provider: string | undefined,
        options?: {
          type?: string;
          count?: string;
          spot?: boolean;
          json?: boolean;
        },
      ) => {
        try {
          if (options?.json) setJsonMode(true);
          const allowPrompt = !options?.json && shouldAllowPrompts();

          if (!provider) {
            if (!options?.type && allowPrompt) {
              const target = await promptGpuTarget();
              if (target === 'all') {
                await bootstrapCatalogsWithUI();
                const type = await promptGpuTypeAcrossClouds();
                await runCrossCloud(
                  { ...options, type },
                  { catalogsBootstrapped: true },
                );
                return;
              }
              provider = target;
            } else {
              await runCrossCloud(options);
              return;
            }
          }

          if (!provider) {
            await runCrossCloud(options);
            return;
          }

          const cloud = normalizeProvider(provider);
          await bootstrapCatalogsWithUI();
          const offerings = getGpuOfferings(cloud, options?.type);

          if (options?.json) {
            console.log(JSON.stringify(offerings, null, 2));
            return;
          }

          if (offerings.length === 0) {
            printInfo(
              options?.type
                ? `No ${options.type} offerings on ${cloud}.`
                : `No GPUs available on ${cloud}.`,
            );
            return;
          }

          printOfferingsTable(offerings);
        } catch (error) {
          printError(`Failed to fetch GPUs: ${(error as Error).message}`);
          process.exit(1);
        }
      },
    );
}

async function runCrossCloud(
  options?: {
    type?: string;
    count?: string;
    spot?: boolean;
    json?: boolean;
  },
  opts?: { catalogsBootstrapped?: boolean },
): Promise<void> {
  const gpuType = options?.type;
  if (!gpuType) {
    exitWithError(
      'Provide a cloud (aws|gcp|azure|lambda) or pass --type to compare across clouds.',
    );
    return;
  }

  let gpuCount: number | undefined;
  if (options?.count !== undefined) {
    gpuCount = Number.parseInt(options.count, 10);
    if (Number.isNaN(gpuCount)) {
      exitWithError(`Invalid --count value: ${options.count}`);
      return;
    }
  }

  if (!opts?.catalogsBootstrapped) {
    await bootstrapCatalogsWithUI();
  }
  const perCloud = ROLLUP_CLOUDS.map((cloud) => ({
    cloud,
    offerings: getGpuOfferings(cloud, gpuType),
  }));

  const rows: CrossCloudRow[] = [];
  for (const { cloud, offerings } of perCloud) {
    let pick: CrossCloudRow | null = null;
    for (const offering of offerings) {
      if (gpuCount !== undefined && offering.count !== gpuCount) continue;
      const cheapest = pickCheapest(offering, options?.spot ?? false);
      if (!cheapest) continue;
      if (!pick || cheapest.pricePerHour < pick.pricePerHour) {
        pick = {
          cloud,
          gpu: offering.gpu,
          count: offering.count,
          vmType: offering.vmType,
          region: cheapest.region,
          pricePerHour: cheapest.pricePerHour,
          spot: cheapest.spot,
        };
      }
    }
    if (pick) rows.push(pick);
  }

  rows.sort((a, b) => a.pricePerHour - b.pricePerHour);

  if (options?.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  if (rows.length === 0) {
    printInfo(
      gpuCount
        ? `No ${gpuCount}x ${gpuType} offerings found.`
        : `No ${gpuType} offerings found.`,
    );
    return;
  }

  const table = newTable({
    head: [
      chalk.cyan('CLOUD'),
      chalk.cyan('COUNT'),
      chalk.cyan('VM TYPE'),
      chalk.cyan('REGION'),
      chalk.cyan('$/hr'),
      chalk.cyan('KIND'),
    ],
    style: { head: [], border: ['dim'] },
  });
  for (const row of rows) {
    table.push([
      row.cloud,
      String(row.count),
      row.vmType,
      row.region,
      `$${row.pricePerHour.toFixed(4)}`,
      row.spot ? 'spot' : 'on-demand',
    ]);
  }
  console.log(table.toString());
}

function printOfferingsTable(offerings: GpuOffering[]): void {
  const table = newTable({
    head: [
      chalk.cyan('GPU'),
      chalk.cyan('COUNT'),
      chalk.cyan('VM TYPE'),
      chalk.cyan('On-demand $/hr (region)'),
      chalk.cyan('Spot $/hr (region)'),
    ],
    style: { head: [], border: ['dim'] },
  });
  for (const o of offerings) {
    table.push([
      o.gpu,
      String(o.count),
      o.vmType,
      o.onDemand
        ? `$${o.onDemand.pricePerHour.toFixed(4)} (${o.onDemand.region})`
        : '—',
      o.spot ? `$${o.spot.pricePerHour.toFixed(4)} (${o.spot.region})` : '—',
    ]);
  }
  console.log(table.toString());
}

import { Command } from 'commander';
import {
  extractGCPRegion,
  getRegions,
  getVMTypes,
  getGPUVMTypes,
} from '../../shared/cloud-config.js';
import { CloudType } from '../../shared/cloud.js';
import { getVMTypeDetails } from '../../shared/catalog/vm-details.js';
import { newTable } from '../renderers/table.js';
import { bootstrapCatalogsWithUI } from '../utils/catalog-bootstrap.js';
import { normalizeProviderOrPrompt } from '../utils/providers.js';
import {
  exitWithError,
  printError,
  printInfo,
  setJsonMode,
} from '../utils/output.js';
import { shouldAllowPrompts } from '../utils/safe-prompts.js';
import { pickRegion } from '../services/target-picker.js';

const USAGE = 'Usage: anycloud vm-types <cloud> <region>';

async function resolveRegion(
  cloud: CloudType,
  provided: string | undefined,
  allowPrompt: boolean,
): Promise<string> {
  if (provided !== undefined) return provided;
  if (!allowPrompt) exitWithError(`Region required. ${USAGE}`);

  const regions = getRegions(cloud);
  if (regions.length === 0) {
    exitWithError(`No regions available for ${cloud}.`);
  }

  return pickRegion(regions);
}

export function createVmTypesCommand(): Command {
  return new Command('vm-types')
    .description('💻 List available VM types in a region')
    .argument('[cloud]', 'Cloud: aws, gcp, azure, or lambda')
    .argument('[region]', 'Region (e.g. us-east-1)')
    .option(
      '--accelerator <gpu>',
      'Filter to VM types that include a given accelerator (e.g. H100)',
    )
    .option('--json', 'Emit VM types as JSON')
    .option(
      '--details',
      'Include CPU, memory, accelerators, regional prices, quota group, and capabilities (unknown values are null in JSON)',
    )
    .addHelpText(
      'after',
      `
Examples:
  $ anycloud vm-types
  $ anycloud vm-types aws us-east-1
  $ anycloud vm-types gcp us-central1 --accelerator H100
  $ anycloud vm-types azure eastus --json
  $ anycloud vm-types aws us-east-1 --details --json
`,
    )
    .action(
      async (
        provider: string | undefined,
        region: string | undefined,
        options?: { accelerator?: string; json?: boolean; details?: boolean },
      ) => {
        try {
          if (options?.json) setJsonMode(true);
          const allowPrompt = !options?.json && shouldAllowPrompts();
          const cloud = await normalizeProviderOrPrompt(provider, {
            allowPrompt,
            missingError: `Cloud required. ${USAGE}`,
          });
          if (!region && !allowPrompt) {
            exitWithError(`Region required. ${USAGE}`);
          }

          await bootstrapCatalogsWithUI();
          const resolvedRegion = await resolveRegion(
            cloud,
            region,
            allowPrompt,
          );
          const types = options?.accelerator
            ? getGPUVMTypes(cloud, resolvedRegion, options.accelerator)
            : getVMTypes(cloud, resolvedRegion);

          const details = options?.details
            ? getVMTypeDetails(cloud, resolvedRegion, types)
            : undefined;
          if (options?.json) {
            console.log(JSON.stringify(details ?? types, null, 2));
            return;
          }

          if (types.length === 0) {
            printInfo(`No VM types available in ${resolvedRegion}.`);
            return;
          }

          if (details) {
            const table = newTable({
              head: [
                'VM TYPE',
                'vCPUs',
                'RAM GiB',
                'GPU',
                'ON-DEMAND $/h',
                'SPOT $/h',
                'QUOTA GROUP',
                'NESTED VIRTUALIZATION',
                'PREMIUM STORAGE',
              ],
            });
            for (const detail of details) {
              // A GCP region matches its zones, priced at the region; other
              // clouds' region names pass through extractGCPRegion unchanged.
              const prices = detail.regions.find(
                (entry) =>
                  entry.region === resolvedRegion ||
                  extractGCPRegion(entry.region) === resolvedRegion,
              );
              table.push([
                detail.vmType,
                detail.vCPUs ?? 'unknown',
                detail.memoryGiB ?? 'unknown',
                detail.accelerators
                  ?.map((gpu) => `${gpu.name}:${gpu.count}`)
                  .join(', ') || (detail.accelerators ? 'none' : 'unknown'),
                prices?.onDemandPricePerHour ?? 'unknown',
                prices?.spotPricePerHour ?? 'unknown',
                detail.quotaGroup ?? 'unknown',
                detail.capabilities.nestedVirtualization === null
                  ? 'unknown'
                  : String(detail.capabilities.nestedVirtualization),
                detail.capabilities.premiumStorage === null
                  ? 'unknown'
                  : String(detail.capabilities.premiumStorage),
              ]);
            }
            console.log(table.toString());
            return;
          }
          for (const t of types) {
            console.log(t);
          }
        } catch (error) {
          printError(`Failed to fetch VM types: ${(error as Error).message}`);
          process.exit(1);
        }
      },
    );
}

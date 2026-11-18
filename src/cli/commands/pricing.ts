import { Command } from 'commander';
import chalk from 'chalk';
import { newTable } from '../renderers/table.js';
import { getPricing } from '../../shared/catalog/queries.js';
import { bootstrapCatalogsWithUI } from '../utils/catalog-bootstrap.js';
import { pickVmTypeTarget } from '../services/target-picker.js';
import { normalizeProviderOrPrompt } from '../utils/providers.js';
import {
  exitWithError,
  printError,
  printInfo,
  setJsonMode,
} from '../utils/output.js';
import { shouldAllowPrompts } from '../utils/safe-prompts.js';

const USAGE = 'Usage: anycloud pricing <cloud> <vm-type>';

export function createPricingCommand(): Command {
  return new Command('pricing')
    .description('💰 Look up VM pricing per region')
    .argument('[cloud]', 'Cloud: aws, gcp, azure, or lambda')
    .argument('[vm-type]', 'VM type (e.g. p5.48xlarge)')
    .option('--region <region>', 'Limit to a single region')
    .option('--spot', 'Spot pricing instead of on-demand')
    .option('--json', 'Emit pricing as JSON')
    .addHelpText(
      'after',
      `
Examples:
  $ anycloud pricing
  $ anycloud pricing aws p5.48xlarge
  $ anycloud pricing aws p5.48xlarge --region us-east-1
  $ anycloud pricing gcp a2-highgpu-1g --spot --json
`,
    )
    .action(
      async (
        provider: string | undefined,
        vmType: string | undefined,
        options?: { region?: string; spot?: boolean; json?: boolean },
      ) => {
        try {
          if (options?.json) setJsonMode(true);
          const allowPrompt = !options?.json && shouldAllowPrompts();
          const cloud = await normalizeProviderOrPrompt(provider, {
            allowPrompt,
            missingError: `Cloud required. ${USAGE}`,
          });
          if (!vmType && !allowPrompt) {
            exitWithError(`VM type required. ${USAGE}`);
          }

          await bootstrapCatalogsWithUI();
          const resolvedVmType =
            vmType ?? (await pickVmTypeTarget(cloud)).vmType;
          const pricing = getPricing(
            cloud,
            resolvedVmType,
            options?.region,
            options?.spot ?? false,
          );

          if (!pricing) {
            if (options?.json) {
              console.log(JSON.stringify(null));
              return;
            }
            printInfo(
              options?.region
                ? `No pricing for "${resolvedVmType}" in ${options.region}.`
                : `No pricing data for VM type "${resolvedVmType}".`,
            );
            return;
          }

          if (options?.json) {
            console.log(JSON.stringify(pricing, null, 2));
            return;
          }

          const kind = pricing.spot ? 'spot' : 'on-demand';

          if (pricing.region && pricing.pricePerHour !== undefined) {
            console.log(
              `${pricing.vmType} (${kind}) in ${pricing.region}: $${pricing.pricePerHour.toFixed(4)}/hr`,
            );
            return;
          }

          if (!pricing.regions || pricing.regions.length === 0) {
            printInfo(`No pricing data for ${resolvedVmType}.`);
            return;
          }

          const table = newTable({
            head: [chalk.cyan('REGION'), chalk.cyan('$/hr')],
            style: { head: [], border: ['dim'] },
          });
          for (const entry of pricing.regions) {
            table.push([entry.region, `$${entry.pricePerHour.toFixed(4)}`]);
          }
          console.log(`${pricing.vmType} (${kind})`);
          console.log(table.toString());
        } catch (error) {
          printError(`Failed to fetch pricing: ${(error as Error).message}`);
          process.exit(1);
        }
      },
    );
}

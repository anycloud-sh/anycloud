import { Command } from 'commander';
import { getRegions, getRegionsForVMType } from '../../shared/cloud-config.js';
import { bootstrapCatalogsWithUI } from '../utils/catalog-bootstrap.js';
import { pickVmTypeTarget } from '../services/target-picker.js';
import { normalizeProviderOrPrompt } from '../utils/providers.js';
import {
  printError,
  printInfo,
  setJsonMode,
  exitWithError,
} from '../utils/output.js';
import { shouldAllowPrompts } from '../utils/safe-prompts.js';

const USAGE = 'Usage: anycloud regions <cloud>';

export function createRegionsCommand(): Command {
  return new Command('regions')
    .description('🌍 List available regions for a cloud')
    .argument('[cloud]', 'Cloud: aws, gcp, azure, or lambda')
    .option(
      '--vm-type <type>',
      'Only regions that offer this VM type (sorted cheapest first)',
    )
    .option(
      '--spot',
      'Use spot pricing for the --vm-type sort (requires --vm-type)',
    )
    .option('--json', 'Emit regions as JSON')
    .addHelpText(
      'after',
      `
Examples:
  $ anycloud regions
  $ anycloud regions aws
  $ anycloud regions aws --vm-type p5.48xlarge
  $ anycloud regions aws --vm-type p5.48xlarge --spot --json
`,
    )
    .action(
      async (
        provider: string | undefined,
        options?: { vmType?: string; spot?: boolean; json?: boolean },
      ) => {
        try {
          if (options?.json) setJsonMode(true);
          const allowPrompt = !options?.json && shouldAllowPrompts();
          const cloud = await normalizeProviderOrPrompt(provider, {
            allowPrompt,
            missingError: `Cloud required. ${USAGE}`,
          });
          let vmType = options?.vmType;
          if (options?.spot && !vmType && !allowPrompt) {
            exitWithError('--spot requires --vm-type');
          }

          await bootstrapCatalogsWithUI();
          if (options?.spot && !vmType) {
            vmType = (await pickVmTypeTarget(cloud)).vmType;
          }

          const regions = vmType
            ? getRegionsForVMType(vmType, cloud, options?.spot)
            : getRegions(cloud);

          if (options?.json) {
            console.log(JSON.stringify(regions, null, 2));
            return;
          }

          if (regions.length === 0) {
            printInfo(
              vmType
                ? `No regions offer ${vmType} on ${cloud}.`
                : `No regions available for ${cloud}.`,
            );
            return;
          }

          for (const region of regions) {
            console.log(region);
          }
        } catch (error) {
          printError(`Failed to fetch regions: ${(error as Error).message}`);
          process.exit(1);
        }
      },
    );
}

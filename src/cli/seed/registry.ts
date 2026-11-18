import { createAwsSeed } from './aws.js';
import { createAzureSeed } from './azure.js';
import { createCloudCli } from './cloud-cli.js';
import { createGcpSeed } from './gcp.js';
import {
  SeedUnavailableError,
  type CloudCli,
  type CloudSeed,
  type SeedCloud,
} from './types.js';

/** Each cloud's seed, built on its CLI; lanes S2 to S4 register theirs here. */
const SEEDS: Partial<Record<SeedCloud, (cli: CloudCli) => CloudSeed>> = {
  aws: createAwsSeed,
  azure: createAzureSeed,
  gcp: (cli) => createGcpSeed(cli),
};

/** The seed for a cloud on the user's own CLI, or a refusal naming the cloud. */
export function seedFor(
  cloud: SeedCloud,
  cli: CloudCli = createCloudCli(cloud),
): CloudSeed {
  const create = SEEDS[cloud];
  if (!create) {
    throw new SeedUnavailableError(
      `cluster create on ${cloud} isn't available in this build`,
    );
  }
  return create(cli);
}

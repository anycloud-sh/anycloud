import { Command } from 'commander';
import { apiClient } from '../services/auth.js';
import type { RedactedCredential } from '../../shared/api-contract/credentials-schemas.js';
import { createSpinner, printError, printInfo } from '../utils/output.js';
import type { CloudType } from '../../shared/cloud.js';
import { shouldAllowPrompts } from '../utils/safe-prompts.js';
import { pickCredential, resolveOptionalNamedCredential } from './shared.js';
import { pickQuotaTypes } from '../prompts/quota-types.js';
import {
  buildStatusMatrixLines,
  quotaStatusTypeScope,
} from '../renderers/quota-status.js';
import {
  quotaStatusView,
  readQuotaStatus,
  type QuotaStatusTarget,
} from '../use-cases/quota-status.js';
import { cloudQuotaStatus } from './quota-cloud.js';

function shouldEmitJson(jsonFlag: boolean | undefined): boolean {
  return Boolean(jsonFlag) || !process.stdout.isTTY;
}

function emitJson(entries: unknown): void {
  process.stdout.write(JSON.stringify(entries) + '\n');
}

async function resolveQuotaStatusTarget(opts: {
  credentials?: string;
  region?: string;
  spot?: boolean;
  onDemand?: boolean;
  json?: boolean;
}): Promise<QuotaStatusTarget> {
  if (opts.spot && opts.onDemand) {
    printError('Choose either --spot or --on-demand, not both.');
    process.exit(1);
  }

  let cred: RedactedCredential & { cloudProvider: CloudType };
  if (opts.credentials) {
    cred = await resolveOptionalNamedCredential({
      credentials: opts.credentials,
      computeOnly: true,
      flagName: '--credentials',
      allowPrompt: false,
    });
  } else {
    cred = await pickCredential();
  }

  let spotValues: boolean[] | undefined;
  if (opts.spot) {
    spotValues = [true];
  } else if (opts.onDemand) {
    spotValues = [false];
  } else if (!shouldEmitJson(opts.json) && shouldAllowPrompts()) {
    spotValues = await pickQuotaTypes();
    if (spotValues.length === 0) {
      printError('No quota type selected');
      process.exit(1);
    }
  }

  return {
    cloud: cred.cloudProvider,
    credentialName: cred.name,
    ...(opts.region && { region: opts.region }),
    ...(spotValues && { spotValues }),
  };
}

function createStatusCommand(): Command {
  return new Command('status')
    .description(
      'List quota requests and current quota limits. Defaults to every region in the catalog when --region is omitted',
    )
    .option('--credentials <name>', 'Named credentials to use')
    .option(
      '--cloud <cloud>',
      "aws, gcp or azure: read current limits through that cloud's own CLI (aws, gcloud, az), signed in on this machine, with no API; needs --region",
    )
    .option(
      '--region <name>',
      'Region to query. Omit to query every region in the catalog',
    )
    .option('--spot', 'Only show spot/preemptible quota')
    .option('--on-demand', 'Only show on-demand quota')
    .option(
      '--canceled',
      'Show canceled local submissions without provider access',
    )
    .option('--json', 'Emit JSON (auto-enabled when stdout is not a TTY)')
    .action(
      async (opts: {
        cloud?: string;
        credentials?: string;
        region?: string;
        spot?: boolean;
        onDemand?: boolean;
        canceled?: boolean;
        json?: boolean;
      }) => {
        if (opts.cloud !== undefined)
          return cloudQuotaStatus({ ...opts, cloud: opts.cloud });
        try {
          const api = await apiClient();
          if (opts.canceled) {
            if (opts.credentials || opts.region || opts.spot || opts.onDemand) {
              throw new Error(
                '--canceled cannot be combined with credentials, region, or quota type filters',
              );
            }
            const entries = await readQuotaStatus(api, {
              canceled: true,
            });
            if (shouldEmitJson(opts.json)) {
              emitJson(entries);
            } else {
              process.stdout.write(
                buildStatusMatrixLines(quotaStatusView(entries)).join('\n') +
                  '\n',
              );
            }
            return;
          }
          const target = await resolveQuotaStatusTarget(opts);

          const useJson = shouldEmitJson(opts.json);
          const scope = `${target.region ?? 'all regions'}, ${quotaStatusTypeScope(target.spotValues)}`;

          const spinner = useJson
            ? null
            : createSpinner(
                `Fetching quota requests on ${target.cloud} (${scope})...`,
              ).start();
          const entries = await readQuotaStatus(api, target);
          spinner?.stop();

          if (useJson) {
            emitJson(entries);
            return;
          }

          if (entries.length === 0) {
            printInfo('No quota requests or current quota limits found.');
            return;
          }

          const lines = buildStatusMatrixLines(quotaStatusView(entries));
          process.stdout.write(lines.join('\n') + '\n');
        } catch (err) {
          printError(
            `Quota status failed: ${(err as Error).message ?? String(err)}`,
          );
          process.exit(1);
        }
      },
    );
}

export function createQuotaCommand(): Command {
  const quota = new Command('quota').description(
    '📊 Inspect cloud provider quotas and requests',
  );
  quota.addCommand(createStatusCommand());
  return quota;
}

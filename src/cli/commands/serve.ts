import { runWait } from './wait.js';
import { apiClient } from '../services/auth.js';
import { Command, InvalidArgumentError } from 'commander';
import { getApiUrl, getLoopbackApiPort } from '../../shared/config.js';
import {
  printInfo,
  printError,
  printWarning,
  createSpinner,
  exitWithError,
} from '../utils/output.js';
import { shouldAllowPrompts } from '../utils/safe-prompts.js';
import { type WorkloadAdmissionInput as WorkloadRequest } from '../../shared/api-contract/workload-admission-schemas.js';
import { DISK_TIER_VALUES } from '../../shared/cloud.js';
import { WorkloadType } from '../../shared/workload.js';
import { detectSession } from '../session/detect.js';
import {
  parseEnvVars,
  resolveCloudConfig,
  buildDockerOptions,
  type WorkloadConfigOptions,
  type DockerRuntimeOptions,
} from './shared.js';
import { pickGHCRImage } from '../services/ghcr-picker.js';
import { createListCommand } from './list.js';
import { parseWorkloadIdOption } from '../utils/workload-id-option.js';

interface ServiceWorkloadOptions
  extends WorkloadConfigOptions,
    DockerRuntimeOptions {
  id?: string;
  secret?: string[];
}

async function buildServiceWorkloadRequest(params: {
  image: string;
  command?: string[];
  options: ServiceWorkloadOptions;
  env?: Record<string, string>;
}): Promise<WorkloadRequest> {
  const { image, command, options, env } = params;
  const resolved = await resolveCloudConfig(options, {
    allowSpotPrompt: false,
  });
  if (resolved.cloudConfig.spot) {
    throw new Error('--spot is not supported for service workloads');
  }
  if (
    resolved.cloudConfig.checkpointBucket &&
    !resolved.credentialName &&
    !resolved.cloudConfig.credentials
  ) {
    throw new Error(
      'Service checkpoint buckets require selected compute credentials. Pass --credentials or inline compute credentials.',
    );
  }
  const dockerOptions = buildDockerOptions(options);
  const detected = detectSession();

  return {
    image,
    cloudConfig: resolved.cloudConfig,
    credentialName: resolved.credentialName,
    ...(resolved.checkpointStorageCredentialName
      ? {
          checkpointStorageCredentialName:
            resolved.checkpointStorageCredentialName,
        }
      : {}),
    gpuType: resolved.gpuType,
    workloadType: 'service',
    id: options.id,
    env,
    secrets:
      options.secret && options.secret.length > 0 ? options.secret : undefined,
    dockerOptions,
    command: command && command.length > 0 ? command : undefined,
    session: detected?.session,
    agent: detected?.agent ?? undefined,
    sessionLabel: detected?.label,
  };
}

export function createServeCommand(): Command {
  const serviceCommand = new Command('service')
    .enablePositionalOptions()
    .description('Run, list, and upgrade long-running HTTP services')
    .addCommand(createListCommand(WorkloadType.Service))
    .argument('[image]', 'Container image (e.g., ghcr.io/user/repo:latest)')
    .argument(
      '[command...]',
      'Command to run in container (use -- before flag-like args)',
    )
    .option(
      '-i, --id <id>',
      'Service ID (optional - auto-generated if not provided)',
      parseWorkloadIdOption,
    )
    .option(
      '-e, --env <env>',
      'Environment variable (KEY=VALUE or KEY to read from shell, repeatable)',
      (val: string, prev: string[]) => [...prev, val],
      [] as string[],
    )
    .option('--env-file <file>', 'Environment file (.env format)')
    .option(
      '--secret <name>',
      'Named secret to inject as env vars (repeatable)',
      (val: string, prev: string[]) => [...prev, val],
      [] as string[],
    )
    .option(
      '--credentials <name>',
      'Compute credentials name (from anycloud credentials); required when selection is ambiguous.',
      (val: string, prev?: string) => {
        if (prev) {
          throw new InvalidArgumentError(
            '--credentials can only be specified once',
          );
        }
        return val;
      },
    )
    .option('--region <region>', 'Cloud region (e.g., us-east-1)')
    .option(
      '--vm-type <type>',
      'VM type (e.g., g6e.xlarge). Repeatable for an ordered fallback pool.',
      (val: string, prev: string[]) => [...prev, val],
      [] as string[],
    )
    .option(
      '--gpu-type <type>',
      'GPU type (e.g., h100, a100:8). Repeatable for an ordered fallback pool.',
      (val: string, prev: string[]) => [...prev, val],
      [] as string[],
    )
    .option('--disk-size <gb>', 'Disk size in GB', parseInt)
    .option(
      '--disk-tier <tier>',
      `Disk performance tier (${DISK_TIER_VALUES.join(', ')})`,
    )
    .option(
      '--checkpoint-bucket <name>',
      'Existing read-write checkpoint bucket mounted at /mnt/checkpoint',
    )
    .option(
      '--checkpoint-storage-credentials <name>',
      'Separate storage credentials for the checkpoint bucket',
    )
    .option(
      '--checkpoint-storage-region <region>',
      'Storage region for checkpoint bucket',
    )
    .option('--zone <zone>', 'Availability zone (e.g., a, b, 1, 2)')
    .option('--shm-size <size>', 'Shared memory size (e.g., 8g)')
    .option('--gpus <gpus>', 'GPU access (all or count)')
    .option('--ipc <mode>', 'IPC mode (host, private, shareable)')
    .option(
      '--ulimit <ulimit>',
      'Ulimit settings (repeatable)',
      (val: string, prev: string[]) => [...prev, val],
      [] as string[],
    )
    .option('--memory <limit>', 'Memory limit (e.g., 32g)')
    .option('--cpus <count>', 'CPU limit')
    .option('--runtime <runtime>', 'Container runtime (e.g., nvidia)')
    .option('--bind <bind...>', 'Volume bind mounts (e.g., /host:/container)')
    .option(
      '--wait',
      'Wait until the Service is running; exits like anycloud wait',
    )
    .addHelpText(
      'after',
      `
Examples:
  $ anycloud service list
  $ anycloud service ghcr.io/user/api:latest --credentials my-aws --vm-type t3.medium
  $ anycloud service ghcr.io/user/api:latest --credentials my-aws --vm-type t3.medium --checkpoint-bucket api-state
  $ anycloud service nginx:latest --credentials my-aws --vm-type t3.small
  $ anycloud service nginx:latest --env PORT=9000 --credentials my-aws --vm-type t3.small

The service container must listen on $PORT. Defaults to 8088; override with --env PORT=<port>.
Access the service at https://<id>.anycloud.sh after workload.

The names 'list' and 'ls' are subcommands. To run an image with either name,
include its tag, e.g. 'anycloud service list:latest'. Put listing options after 'list'.
`,
    )
    .action(
      async (
        image: string | undefined,
        command: string[],
        options: {
          id?: string;
          env?: string[];
          envFile?: string;
          secret?: string[];
          credentials?: string;
          region?: string;
          vmType?: string[];
          gpuType?: string[];
          diskSize?: number;
          diskTier?: string;
          checkpointBucket?: string;
          checkpointStorageCredentials?: string;
          checkpointStorageRegion?: string;
          zone?: string;
          shmSize?: string;
          gpus?: string;
          ipc?: string;
          ulimit?: string[];
          memory?: string;
          cpus?: string;
          runtime?: string;
          bind?: string[];
          wait?: boolean;
        },
      ) => {
        try {
          if (!image) {
            if (!shouldAllowPrompts()) {
              exitWithError(
                'Image required. Pass it as the first argument, e.g. anycloud service ghcr.io/owner/repo:tag.',
              );
            }
            const picked = await pickGHCRImage();
            if (!picked) process.exit(0);
            image = picked;
          }

          const envVars = parseEnvVars(options);
          const request = await buildServiceWorkloadRequest({
            image,
            command,
            options,
            env: envVars,
          });
          const warnAboutCheckpointRenewal =
            'cloudConfig' in request &&
            request.cloudConfig.checkpointBucket &&
            request.checkpointStorageCredentialName &&
            request.checkpointStorageCredentialName !==
              request.credentialName &&
            getLoopbackApiPort(getApiUrl()) !== undefined;
          const spinner = createSpinner('Creating service workload...').start();
          const response = await (await apiClient()).admission.submit(request);
          spinner.succeed('Service workload created!');
          console.log('');
          printInfo(`ID: ${response.id}`);
          // The server decides whether a public endpoint exists (substrates
          // like Local publish none); render only what it returned.
          if (response.url) {
            printInfo(`URL: ${response.url}`);
          }
          if (warnAboutCheckpointRenewal) {
            printWarning(
              'This Service uses temporary S3 checkpoint credentials renewed by your local API. Keep this computer awake and the API running and connected. If credentials expire while the API is offline, checkpoint uploads pause until renewal succeeds. The Service keeps running.',
            );
          }
          console.log('');
          if (options.wait) process.exitCode = await runWait([response.id], {});
        } catch (error) {
          printError((error as Error).message);
          process.exit(1);
        }
      },
    );

  serviceCommand
    .command('upgrade')
    .description(
      'Upgrade an existing service workload while preserving its URL',
    )
    .argument('<id>', 'Service workload ID to upgrade')
    .argument('<image>', 'Container image (e.g., ghcr.io/user/repo:latest)')
    .argument(
      '[command...]',
      'Command to run in container (use -- before flag-like args)',
    )
    .option(
      '-e, --env <env>',
      'Add or replace an environment value (KEY=VALUE or KEY from shell, repeatable)',
      (val: string, prev: string[]) => [...prev, val],
      [] as string[],
    )
    .option('--env-file <file>', 'Merge environment values from a dotenv file')
    .option(
      '--bind <bind...>',
      'Replace the complete volume bind list; include every mount to retain',
    )
    .addHelpText(
      'after',
      `
Examples:
  $ anycloud service upgrade api ghcr.io/user/api:v2
  $ anycloud service upgrade api ghcr.io/user/api:v2 -- node server.js
  $ anycloud service upgrade api ghcr.io/user/api:v2 --env MODE=production --bind api-data:/data api-workspaces:/workspace

The upgrade preserves https://<id>.anycloud.sh and replaces the backing VM.
Environment values merge with existing values. --bind replaces the complete bind list.
`,
    )
    .action(
      async (
        id: string,
        image: string,
        command: string[],
        options: {
          env?: string[];
          envFile?: string;
          bind?: string[];
        },
      ) => {
        try {
          const api = await apiClient();
          const env =
            options.env?.length || options.envFile
              ? parseEnvVars(options)
              : undefined;
          const spinner = createSpinner('Queuing service upgrade...').start();
          const response = await api.serviceUpgrade.upgrade({
            params: { id },
            body: {
              image,
              command: command.length > 0 ? command : undefined,
              ...(env === undefined ? {} : { env }),
              ...(options.bind === undefined ? {} : { binds: options.bind }),
            },
          });
          spinner.succeed('Service upgrade queued!');
          console.log('');
          printInfo(`ID: ${response.id}`);
          if (response.url) {
            printInfo(`URL: ${response.url}`);
          }
          console.log('');
        } catch (error) {
          printError((error as Error).message);
          process.exit(1);
        }
      },
    );

  return serviceCommand;
}

import { runWait } from './wait.js';
import { apiClient } from '../services/auth.js';
import { Command, InvalidArgumentError } from 'commander';
import { type WorkloadAdmissionInput as WorkloadRequest } from '../../shared/api-contract/workload-admission-schemas.js';
import { DISK_TIER_VALUES } from '../../shared/cloud.js';
import { WorkloadType } from '../../shared/workload.js';
import { detectSession } from '../session/detect.js';
import { pickGHCRImage } from '../services/ghcr-picker.js';
import {
  createSpinner,
  exitWithError,
  printError,
  printInfo,
} from '../utils/output.js';
import { shouldAllowPrompts } from '../utils/safe-prompts.js';
import { createListCommand } from './list.js';
import {
  parseEnvVars,
  resolveCloudConfig,
  type WorkloadConfigOptions,
} from './shared.js';
import { parseWorkloadIdOption } from '../utils/workload-id-option.js';

const RECOMMENDED_CPU_VM_IMAGE =
  'mcr.microsoft.com/devcontainers/base:ubuntu24.04';
const RECOMMENDED_NVIDIA_GPU_VM_IMAGE =
  'pytorch/pytorch:2.13.0-cuda12.6-cudnn9-runtime';

interface VmWorkloadOptions extends WorkloadConfigOptions {
  id?: string;
  wait?: boolean;
  env?: string[];
  envFile?: string;
  secret?: string[];
}

async function buildVmWorkloadRequest(params: {
  image: string;
  options: VmWorkloadOptions;
  env?: Record<string, string>;
}): Promise<WorkloadRequest> {
  const { image, options, env } = params;
  const resolved = await resolveCloudConfig(options, {
    allowSpotPrompt: false,
  });
  if (resolved.cloudConfig.spot) {
    throw new Error('--spot is not supported for vm workloads');
  }

  const detected = detectSession();
  return {
    image,
    cloudConfig: resolved.cloudConfig,
    credentialName: resolved.credentialName,
    gpuType: resolved.gpuType,
    workloadType: WorkloadType.Vm,
    id: options.id,
    env,
    secrets:
      options.secret && options.secret.length > 0 ? options.secret : undefined,
    session: detected?.session,
    agent: detected?.agent ?? undefined,
    sessionLabel: detected?.label,
  };
}

export function createVmCommand(): Command {
  return new Command('vm')
    .enablePositionalOptions()
    .description('Create, list, and access persistent VMs')
    .addCommand(createListCommand(WorkloadType.Vm))
    .argument('[image]', 'Container image (e.g., ghcr.io/user/dev:latest)')
    .option(
      '-i, --id <id>',
      'Workload ID (optional - auto-generated if not provided)',
      parseWorkloadIdOption,
    )
    .option(
      '-e, --env <env>',
      'Environment variable (KEY=VALUE or KEY to read from shell, repeatable)',
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option('--env-file <file>', 'Environment file (.env format)')
    .option(
      '--secret <name>',
      'Named secret to inject as env vars (repeatable)',
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option(
      '--credentials <name>',
      'Compute credentials name; required when selection is ambiguous.',
      (value: string, previous?: string) => {
        if (previous) {
          throw new InvalidArgumentError(
            '--credentials can only be specified once',
          );
        }
        return value;
      },
    )
    .option('--region <region>', 'Cloud region (e.g., us-east-1)')
    .option(
      '--vm-type <type>',
      'VM type. Repeatable for an ordered fallback pool.',
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option(
      '--gpu-type <type>',
      'GPU type and optional count. Repeatable for an ordered fallback pool.',
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option('--disk-size <gb>', 'Disk size in GB', Number.parseInt)
    .option(
      '--disk-tier <tier>',
      `Disk performance tier (${DISK_TIER_VALUES.join(', ')})`,
    )
    .option('--zone <zone>', 'Availability zone (e.g., a, b, 1, 2)')
    .option('--wait', 'Wait until the VM is running; exits like anycloud wait')
    .addHelpText(
      'after',
      `
Examples:
  $ anycloud vm list
  $ anycloud vm alpine:3.22 --credentials my-aws --vm-type t3.large
  $ anycloud vm ghcr.io/acme/dev:latest --gpu-type h100 --disk-size 200

Use 'anycloud ssh <id>' for the VM container or
'anycloud ssh <id> --host' for the underlying cloud VM.

The names 'list' and 'ls' are subcommands. To run an image with either name,
include its tag, e.g. 'anycloud vm list:latest'. Put listing options after 'list'.
`,
    )
    .action(async (image: string | undefined, options: VmWorkloadOptions) => {
      try {
        // `vm new <image>` was the 0.1.58 spelling. Without an image the bare
        // word would otherwise be accepted as the image name.
        if (image === 'new') {
          exitWithError(
            'anycloud vm new was replaced by anycloud vm <image>, e.g. anycloud vm ghcr.io/owner/repo:tag.',
          );
        }

        if (!image) {
          if (!shouldAllowPrompts()) {
            exitWithError(
              `Image required. Pass it as the first argument.

Recommended starting images:
  ${RECOMMENDED_CPU_VM_IMAGE} — Ubuntu Development (CPU)
  ${RECOMMENDED_NVIDIA_GPU_VM_IMAGE} — PyTorch + CUDA (NVIDIA GPU)`,
            );
          }
          const picked = await pickGHCRImage();
          if (!picked) process.exit(0);
          image = picked;
        }

        const env = parseEnvVars(options);
        const request = await buildVmWorkloadRequest({
          image,
          options,
          env,
        });

        const spinner = createSpinner('Creating VM workload...').start();
        const response = await (await apiClient()).admission.submit(request);
        spinner.succeed('VM workload created!');
        console.log('');
        printInfo(`ID: ${response.id}`);
        printInfo(`Connect: anycloud ssh ${response.id}`);
        console.log('');
        if (options.wait) process.exitCode = await runWait([response.id], {});
      } catch (error) {
        printError((error as Error).message);
        process.exit(1);
      }
    });
}

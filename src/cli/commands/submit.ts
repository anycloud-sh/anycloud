import { Command, InvalidArgumentError } from 'commander';
import { apiClient } from '../services/auth.js';
import {
  printInfo,
  printError,
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
  warnPrivilegedDeprecated,
} from './shared.js';
import { pickGHCRImage } from '../services/ghcr-picker.js';
import { createListCommand } from './list.js';
import { runWait } from './wait.js';
import {
  addJobSpecOptions,
  jobSpecRequest,
  type JobSpecOptions,
} from './job-spec-options.js';
import { parseWorkloadIdOption } from '../utils/workload-id-option.js';

export function createSubmitCommand(): Command {
  return (
    addJobSpecOptions(new Command('job'))
      .enablePositionalOptions()
      .description('Run and list finite container jobs')
      .addCommand(createListCommand(WorkloadType.Job))
      .argument('[image]', 'Container image (e.g., ghcr.io/user/repo:latest)')
      .argument(
        '[command...]',
        'Command to run in container (use -- before flag-like args, e.g. -- python train.py --epochs 10)',
      )
      .option(
        '-i, --id <id>',
        'Workload ID (optional - auto-generated if not provided)',
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
      // Inline workload config options
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
      .option('--spot', 'Use spot/preemptible instances')
      .option('--disk-size <gb>', 'Disk size in GB', parseInt)
      .option(
        '--disk-tier <tier>',
        `Disk performance tier (${DISK_TIER_VALUES.join(', ')})`,
      )
      .option(
        '--regions <a,b,c>',
        'On a VM: the regions the Job may launch in, instead of one --region; it rotates across them after a failure',
        (value: string) => {
          const regions = value
            .split(',')
            .map((region) => region.trim())
            .filter(Boolean);
          if (regions.length === 0) {
            throw new InvalidArgumentError('--regions names no region.');
          }
          return regions;
        },
      )
      .option(
        '--disk-iops <n>',
        "AWS or GCP: the VM's gp3 or Hyperdisk Balanced root IOPS (from 3000; at most 500 per GiB of the root), overriding --disk-tier",
        wholeNumber('--disk-iops'),
      )
      .option(
        '--disk-throughput <MiBps>',
        "AWS or GCP: the VM's gp3 or Hyperdisk Balanced root throughput in MiB/s (at most 0.25 per IOPS), overriding --disk-tier",
        wholeNumber('--disk-throughput'),
      )
      .option('--input-bucket <name>', 'Input bucket name')
      .option('--output-bucket <name>', 'Output bucket name')
      .option(
        '--checkpoint-bucket <name>',
        'Existing read-write checkpoint bucket mounted at /mnt/checkpoint',
      )
      .option(
        '--input-storage-credentials <name>',
        'Storage credentials for input bucket (cross-cloud)',
      )
      .option(
        '--input-storage-region <region>',
        'Storage region for input bucket (cross-cloud)',
      )
      .option(
        '--output-storage-credentials <name>',
        'Storage credentials for output bucket (cross-cloud)',
      )
      .option(
        '--output-storage-region <region>',
        'Storage region for output bucket (cross-cloud)',
      )
      .option(
        '--checkpoint-storage-credentials <name>',
        'Storage credentials for checkpoint bucket (cross-cloud)',
      )
      .option(
        '--checkpoint-storage-region <region>',
        'Storage region for checkpoint bucket (cross-cloud)',
      )
      .option('--zone <zone>', 'Availability zone (e.g., a, b, 1, 2)')
      // Docker runtime options
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
      .option(
        '--bind <path>',
        'Volume bind mount (repeatable)',
        (value: string, all: string[]) => [...all, value],
        [] as string[],
      )
      .option(
        '--privileged',
        'Deprecated, removed in the next release: use --host-docker. Privileged container, root on its host',
      )
      .option(
        '--max-retries <count>',
        'Retry at most this many times after a disruption (0 for none)',
        (value: string) => {
          if (!/^\d+$/.test(value)) {
            throw new InvalidArgumentError(
              '--max-retries must be a whole number, 0 or more.',
            );
          }
          return Number(value);
        },
      )
      .option(
        '--require-nested-virtualization',
        'Keep only the VM types the catalog reports as supporting nested virtualization (KVM), and launch them with it on',
      )
      .option(
        '--host-docker',
        "On a VM: the host's Docker socket and a /workspace bind mount, plus /dev/kvm with --require-nested-virtualization; root on the Job's own VM, without --privileged",
      )
      .option('--no-checkpoint', 'No checkpoint bucket or upload, even on spot')
      .option(
        '--wait',
        'Wait until the Job completes; exits like anycloud wait',
      )
      .addHelpText(
        'after',
        `
Examples:
  $ anycloud job list
  $ anycloud job list -n 400
  $ anycloud job ghcr.io/user/repo:latest \\
      --credentials my-aws --gpu-type h100 \\
      --spot --gpus all -- python train.py
  $ anycloud job ghcr.io/user/repo:v1.0 \\
      --credentials my-aws --vm-type g6e.xlarge --spot \\
      -- python train.py --epochs 10

The names 'list' and 'ls' are subcommands. To run an image with either name,
include its tag, e.g. 'anycloud job list:latest'. Put listing options after 'list'.

Bring your own image:
  anycloud runs an image you have already pushed to a registry; private
  ghcr.io images work after 'anycloud login'. To push to ghcr.io from your
  laptop, log Docker in with the GitHub CLI (with GH_TOKEN and GITHUB_TOKEN
  unset; gh auth refresh fails while either is set), then build, push and run it:

    gh auth refresh -s write:packages
    gh auth token | docker login ghcr.io -u "$(gh api user -q .login)" \\
      --password-stdin
    docker buildx build --platform linux/amd64 \\
      -t ghcr.io/<owner>/<repo>:latest --push .

  Use linux/amd64 for Mac/Apple Silicon and cloud GPU VMs. In GitHub
  Actions, use the built-in GITHUB_TOKEN with 'packages: write'.
  Guide: https://anycloud.sh/platform/container-images

Environment variables:
    GITHUB_TOKEN                GitHub token for authentication
    ANYCLOUD_CREDENTIALS_NAME   Credentials name to use (alternative to --credentials)
`,
      )
      .action(
        async (
          image: string | undefined,
          command: string[],
          options: JobSpecOptions & {
            id?: string;
            env?: string[];
            envFile?: string;
            secret?: string[];
            // Inline workload config options
            maxRetries?: number;
            checkpoint?: boolean;
            credentials?: string;
            region?: string;
            vmType?: string[];
            gpuType?: string[];
            spot?: boolean;
            diskSize?: number;
            diskTier?: string;
            regions?: string[];
            diskIops?: number;
            diskThroughput?: number;
            inputBucket?: string;
            outputBucket?: string;
            checkpointBucket?: string;
            inputStorageCredentials?: string;
            inputStorageRegion?: string;
            outputStorageCredentials?: string;
            outputStorageRegion?: string;
            checkpointStorageCredentials?: string;
            checkpointStorageRegion?: string;
            zone?: string;
            // Docker runtime options
            shmSize?: string;
            gpus?: string;
            ipc?: string;
            ulimit?: string[];
            memory?: string;
            cpus?: string;
            runtime?: string;
            bind?: string[];
            privileged?: boolean;
            wait?: boolean;
            requireNestedVirtualization?: boolean;
            hostDocker?: boolean;
          },
        ) => {
          try {
            if (options.privileged) warnPrivilegedDeprecated('--privileged');
            if (!image) {
              if (!shouldAllowPrompts()) {
                exitWithError(
                  'Image required. Pass it as the first argument, e.g. anycloud job ghcr.io/owner/repo:tag.',
                );
              }
              const picked = await pickGHCRImage();
              if (!picked) process.exit(0);
              image = picked;
            }

            const workloadId = options.id;
            const spinner = createSpinner('Creating job workload...').start();
            const detected = detectSession();
            const envVars = parseEnvVars(options);
            const resolved = await resolveCloudConfig(options);
            console.log('');
            printInfo(`Deploying image: ${image}`);
            const request: WorkloadRequest = {
              image: image!,
              cloudConfig: {
                ...resolved.cloudConfig,
                ...(options.regions?.length && { regions: options.regions }),
                ...(options.diskIops !== undefined && {
                  diskIops: options.diskIops,
                }),
                ...(options.diskThroughput !== undefined && {
                  diskThroughputMibps: options.diskThroughput,
                }),
              },
              credentialName: resolved.credentialName,
              inputStorageCredentialName: resolved.inputStorageCredentialName,
              outputStorageCredentialName: resolved.outputStorageCredentialName,
              checkpointStorageCredentialName:
                resolved.checkpointStorageCredentialName,
              gpuType: resolved.gpuType,
              maxRetries: options.maxRetries,
              noCheckpoint: options.checkpoint === false || undefined,
              requireNestedVirtualization:
                options.requireNestedVirtualization || undefined,
              hostDocker: options.hostDocker || undefined,
              workloadType: WorkloadType.Job,
              id: workloadId,
              env: envVars,
              secrets:
                options.secret && options.secret.length > 0
                  ? options.secret
                  : undefined,
              dockerOptions: buildDockerOptions(options),
              command: command.length > 0 ? command : undefined,
              session: detected?.session,
              agent: detected?.agent ?? undefined,
              sessionLabel: detected?.label,
              ...jobSpecRequest(options),
            };
            const response = await (
              await apiClient()
            ).admission.submit(request);
            spinner.succeed('Job workload created!');
            console.log('');
            printInfo(`ID: ${response.id}`);
            console.log('');
            if (options.wait)
              process.exitCode = await runWait([response.id], {});
          } catch (error) {
            printError((error as Error).message);
            process.exit(1);
          }
        },
      )
  );
}

/** A flag's whole-number value; the API checks its range. */
function wholeNumber(flag: string): (value: string) => number {
  return (value) => {
    if (!/^\d+$/.test(value)) {
      throw new InvalidArgumentError(`${flag} must be a whole number.`);
    }
    return Number(value);
  };
}

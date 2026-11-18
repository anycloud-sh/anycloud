import { runWait } from './wait.js';
import { apiClient } from '../services/auth.js';
import { Command, InvalidArgumentError, Option } from 'commander';
import { formatColumns } from '../renderers/table.js';
import {
  deploymentReadinessProbeSchema,
  type DeploymentReadinessProbe,
  type CreateDeploymentRequest,
  type UpdateDeploymentRequest,
} from '../../shared/api-contract/deployments-schemas.js';
import { printError, printSuccess, setJsonMode } from '../utils/output.js';
import { formatAge, parseDurationMs } from '../utils/duration.js';
import {
  formatDeploymentJobs,
  formatDeploymentReplicas,
  formatDeploymentState,
  printDeploymentSummary,
} from '../utils/kubernetes-output.js';
import {
  buildDockerOptions,
  parseEnvVars,
  warnPrivilegedDeprecated,
} from './shared.js';

interface JsonOptions {
  json?: boolean;
}

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError('expected a positive integer');
  }
  return parsed;
}

/** `--replicas N` is shorthand for `--min-replicas N --max-replicas N`. */
function replicaOptions(): Option[] {
  return [
    new Option(
      '--replicas <count>',
      'Fixed replica Pods: the same as --min-replicas and --max-replicas',
    ).conflicts(['minReplicas', 'maxReplicas']),
    new Option(
      '--min-replicas <count>',
      'Fewest replica Pods; replicas scale on queued plus running Jobs',
    ),
    new Option(
      '--max-replicas <count>',
      'Most replica Pods (defaults to --min-replicas on create)',
    ),
  ].map((option) => option.argParser(positiveInteger));
}

function replicaBounds(options: {
  replicas?: number;
  minReplicas?: number;
  maxReplicas?: number;
}): { minReplicas?: number; maxReplicas?: number } {
  return {
    minReplicas: options.replicas ?? options.minReplicas,
    maxReplicas: options.replicas ?? options.maxReplicas,
  };
}

/** Whole seconds with a unit; a bare number would be days. */
function gracePeriod(value: string): number {
  if (!/^\d+[smh]$/.test(value.trim())) {
    throw new InvalidArgumentError('expected a duration such as 90s or 10m');
  }
  return parseDurationMs(value) / 1000;
}

function json(value: unknown): void {
  setJsonMode(true);
  console.log(JSON.stringify(value));
}

function readinessProbe(value: string): {
  probe: DeploymentReadinessProbe | null;
} {
  let input: unknown;
  try {
    input = JSON.parse(value);
  } catch {
    throw new InvalidArgumentError('readiness probe must be valid JSON');
  }
  const result = deploymentReadinessProbeSchema.nullable().safeParse(input);
  if (!result.success) {
    throw new InvalidArgumentError(
      result.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; '),
    );
  }
  // Commander normalizes a null parser result to an empty string.
  return { probe: result.data };
}

function createCommand(): Command {
  const [replicas, minReplicas, maxReplicas] = replicaOptions();
  return new Command('create')
    .description('Create a Kubernetes Deployment that accepts Jobs')
    .argument('<name>', 'Deployment name')
    .argument('<image>', 'Container image')
    .argument(
      '[command...]',
      'Long-running process command (use -- before flags)',
    )
    .requiredOption(
      '--node-pool <id-or-name>',
      'Target node pool in the cluster',
    )
    .option(
      '--readiness-probe <json>',
      'Native exec readiness probe as JSON',
      readinessProbe,
    )
    .option(
      '--grace-period <duration>',
      'Time a replica gets between SIGTERM and SIGKILL (default 30s)',
      gracePeriod,
    )
    .option(
      '--max-concurrent-jobs-per-replica <count>',
      'Maximum simultaneous Jobs in the long-running process',
      positiveInteger,
      1,
    )
    .addOption(replicas)
    .addOption(minReplicas)
    .addOption(maxReplicas)
    .option('--gpus <gpus>', 'GPU access (all or count)')
    .option('--runtime <runtime>', 'Container runtime (runc or nvidia)')
    .option(
      '-e, --env <env>',
      'Environment variable (repeatable)',
      (value, all: string[]) => [...all, value],
      [],
    )
    .option('--env-file <file>', 'Environment file (.env format)')
    .option(
      '--secret <name>',
      'Named secret to inject as env vars (repeatable)',
      (value, all: string[]) => [...all, value],
      [],
    )
    .option('--shm-size <size>', 'Shared memory size')
    .option('--memory <limit>', 'Memory limit')
    .option('--cpus <count>', 'CPU limit')
    .option(
      '--privileged',
      'Deprecated, removed in the next release: grant host device and privileged runtime access',
    )
    .option(
      '--bind <path>',
      'Disposable volume at an absolute container path (repeatable)',
      (value, all: string[]) => [...all, value],
      [],
    )
    .option('--json', 'Emit the Deployment as JSON')
    .option(
      '--wait',
      'Wait until the Deployment is ready; exits like anycloud wait',
    )
    .action(async (name: string, image: string, command: string[], options) => {
      if (options.json) setJsonMode(true);
      try {
        if (options.privileged) warnPrivilegedDeprecated('--privileged');
        const api = await apiClient();
        const request: CreateDeploymentRequest = {
          name,
          nodePool: options.nodePool,
          image,
          readinessProbe: options.readinessProbe?.probe,
          gracePeriodSeconds: options.gracePeriod,
          command: command.length > 0 ? command : undefined,
          env: parseEnvVars(options),
          secrets: options.secret.length > 0 ? options.secret : undefined,
          dockerOptions: buildDockerOptions({
            shmSize: options.shmSize,
            memory: options.memory,
            cpus: options.cpus,
            gpus: options.gpus,
            runtime: options.runtime,
            privileged: options.privileged,
            bind: options.bind?.length ? options.bind : undefined,
          }),
          maxConcurrentJobsPerReplica: options.maxConcurrentJobsPerReplica,
          ...replicaBounds(options),
        };
        const { deployment } = await api.deployments.create(request);
        if (options.json) json(deployment);
        else {
          printSuccess(`Deployment ${deployment.name} creation started.`);
          printDeploymentSummary(deployment);
        }
        if (options.wait) {
          process.exitCode = await runWait(
            [{ kind: 'deployment', id: deployment.id }],
            { json: options.json },
          );
        }
      } catch (error) {
        printError(`Failed to create Deployment: ${(error as Error).message}`);
        process.exit(1);
      }
    });
}

function listCommand(): Command {
  return new Command('list')
    .aliases(['ls', 'get'])
    .description('List Kubernetes Deployments')
    .option('--node-pool <id-or-name>', 'Only Deployments on this node pool')
    .option('--json', 'Emit Deployments as JSON')
    .action(async (options: JsonOptions & { nodePool?: string }) => {
      if (options.json) setJsonMode(true);
      try {
        const api = await apiClient();
        const { deployments } = await api.deployments.list(
          options.nodePool !== undefined
            ? { query: { nodePool: options.nodePool } }
            : undefined,
        );
        if (options.json) return json(deployments);
        const rows = deployments.map((deployment) => [
          deployment.managed ? `${deployment.name} (managed)` : deployment.name,
          deployment.id,
          deployment.nodePoolId,
          String(deployment.generation),
          formatDeploymentReplicas(deployment),
          formatDeploymentJobs(deployment),
          formatAge(deployment.createdAt),
          formatDeploymentState(deployment),
        ]);
        const head = [
          'NAME',
          'ID',
          'NODE POOL',
          'REVISION',
          'REPLICAS',
          'JOBS',
          'AGE',
          'STATE',
        ];
        console.log(formatColumns([head, ...rows]).join('\n'));
      } catch (error) {
        printError(`Failed to list Deployments: ${(error as Error).message}`);
        process.exit(1);
      }
    });
}

function statusCommand(): Command {
  return new Command('status')
    .alias('describe')
    .description('Show Kubernetes Deployment status')
    .argument('<id-or-name>')
    .option('--verbose', 'Show revisions, Pod identity, and every blocking Job')
    .option('--json', 'Emit the Deployment as JSON')
    .action(
      async (
        identifier: string,
        options: JsonOptions & { verbose?: boolean },
      ) => {
        if (options.json) setJsonMode(true);
        try {
          const api = await apiClient();
          const { deployment } = await api.deployments.get({
            params: { id: identifier },
          });
          if (options.json) return json(deployment);
          printDeploymentSummary(deployment, { verbose: options.verbose });
        } catch (error) {
          printError(`Failed to get Deployment: ${(error as Error).message}`);
          process.exit(1);
        }
      },
    );
}

function upgradeCommand(): Command {
  const [replicas, minReplicas, maxReplicas] = replicaOptions();
  return new Command('upgrade')
    .alias('update')
    .description(
      'Upgrade and roll out a Kubernetes Deployment after Jobs drain',
    )
    .argument('<id-or-name>')
    .argument(
      '[command...]',
      'Replacement long-running command (use -- before flags)',
    )
    .option('--image <image>', 'Replacement container image')
    .option(
      '--readiness-probe <json>',
      'Replace the native exec probe (JSON); null removes it',
      readinessProbe,
    )
    .option(
      '--grace-period <duration>',
      'Time a replica gets between SIGTERM and SIGKILL',
      gracePeriod,
    )
    .option(
      '--max-concurrent-jobs-per-replica <count>',
      'Maximum simultaneous Jobs in the long-running process',
      positiveInteger,
    )
    .addOption(replicas)
    .addOption(minReplicas)
    .addOption(maxReplicas)
    .option('--gpus <gpus>', 'GPU access (all or count)')
    .option('--runtime <runtime>', 'Container runtime (runc or nvidia)')
    .option('--shm-size <size>', 'Shared memory size')
    .option('--memory <limit>', 'Memory limit')
    .option('--cpus <count>', 'CPU limit')
    .option(
      '--privileged',
      'Deprecated, removed in the next release: grant host device and privileged runtime access',
    )
    .option('--no-privileged', 'Disable privileged runtime access')
    .option(
      '--secret <name>',
      'Replacement named secrets to inject as env vars (repeatable)',
      (value, all: string[] | false | undefined) => [...(all || []), value],
    )
    .option('--no-secret', 'Remove every named secret')
    .option(
      '--bind <path>',
      'Replacement disposable volumes (repeatable)',
      (value, all: string[]) => [...all, value],
      [],
    )
    .option('--json', 'Emit the Deployment as JSON')
    .option(
      '--wait',
      'Wait until this revision is ready; exits like anycloud wait',
    )
    .action(async (identifier: string, command: string[], options) => {
      if (options.json) setJsonMode(true);
      try {
        if (options.privileged) warnPrivilegedDeprecated('--privileged');
        const dockerOptions: UpdateDeploymentRequest['dockerOptions'] = {
          gpus: options.gpus,
          runtime: options.runtime,
          shmSize: options.shmSize,
          memory: options.memory,
          cpus: options.cpus,
          privileged: options.privileged,
          binds: options.bind?.length ? options.bind : undefined,
        };
        const body: UpdateDeploymentRequest = {
          image: options.image,
          readinessProbe: options.readinessProbe?.probe,
          gracePeriodSeconds: options.gracePeriod,
          command: command.length > 0 ? command : undefined,
          secrets: options.secret === false ? null : options.secret,
          dockerOptions: Object.values(dockerOptions).some(
            (value) => value !== undefined,
          )
            ? dockerOptions
            : undefined,
          maxConcurrentJobsPerReplica: options.maxConcurrentJobsPerReplica,
          ...replicaBounds(options),
        };
        for (const key of Object.keys(body) as Array<keyof typeof body>) {
          if (body[key] === undefined) delete body[key];
        }
        if (Object.keys(body).length === 0) {
          throw new Error('Pass at least one field to upgrade');
        }
        const api = await apiClient();
        const { deployment } = await api.deployments.update({
          params: { id: identifier },
          body,
        });
        if (options.json) json(deployment);
        else {
          printSuccess(`Deployment ${deployment.name} upgrade accepted.`);
          printDeploymentSummary(deployment);
        }
        if (options.wait) {
          // Ready means the Pod on this or a later revision is ready.
          process.exitCode = await runWait(
            [{ kind: 'deployment', id: deployment.id }],
            { json: options.json },
          );
        }
      } catch (error) {
        printError(`Failed to upgrade Deployment: ${(error as Error).message}`);
        process.exit(1);
      }
    });
}

function deleteCommand(): Command {
  return new Command('delete')
    .aliases(['terminate', 'rm'])
    .description('Drain and delete a Kubernetes Deployment')
    .argument('<id-or-name>')
    .option('--json', 'Emit the Deployment as JSON')
    .action(async (identifier: string, options: JsonOptions) => {
      if (options.json) setJsonMode(true);
      try {
        const api = await apiClient();
        const { deployment } = await api.deployments.delete({
          params: { id: identifier },
        });
        if (options.json) return json(deployment);
        printSuccess(`Deployment ${deployment.name} deletion started.`);
        printDeploymentSummary(deployment);
      } catch (error) {
        printError(`Failed to delete Deployment: ${(error as Error).message}`);
        process.exit(1);
      }
    });
}

export function createDeploymentCommand(): Command {
  const deployment = new Command('deployment').description(
    'Create and manage Kubernetes Deployments',
  );
  deployment.addCommand(createCommand());
  deployment.addCommand(listCommand());
  deployment.addCommand(statusCommand());
  deployment.addCommand(upgradeCommand());
  deployment.addCommand(deleteCommand());
  return deployment;
}

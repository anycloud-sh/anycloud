import type {
  ServiceUpgradeInput,
  ServiceUpgradeResponse,
} from '../../shared/api-contract/service-upgrade-schemas.js';
import { resolveCheckpointTarget } from '../../shared/checkpoint.js';
import {
  GithubSignInRequiredError,
  InvalidAnycloudConfigError,
  SERVICE_URL_NEEDS,
} from '../../shared/errors.js';
import { isHostedApiImage } from '../../shared/hosted-api.js';
import {
  DEFAULT_BUCKET_HOST_PATHS,
  bucketHostPathsForProvider,
} from '../../shared/providers.js';
import {
  assertVmHostContainerConfiguration,
  type StoredWorkload,
} from './workload-record.js';
import { WorkloadState, WorkloadType } from '../../shared/workload.js';
import type { User } from './entities.js';
import { assertImageAccessible } from './image-manifest.js';
import type { ImageInspection } from '../../shared/image-registry.js';
import type { ImageArchitecture } from '../../shared/image.js';
import { vmArchitecture } from '../../shared/cloud-config.js';
import { toArray } from '../../shared/utils.js';
import type { OwnershipScope } from './repositories/ownership-filter.js';
import type { ServeUpdateRequest } from './serve/runtime.js';
import { serveUrl } from './serve.js';
import { errorMessage } from '../../shared/log-diagnostics.js';
import { validateDockerOptionsRequest } from '../../shared/docker-options.js';

export class ServiceUpgradeError extends Error {
  constructor(
    message: string,
    public readonly statusCode: 400 | 404 | 409,
    public readonly telemetryError: string = message,
  ) {
    super(message);
    this.name = 'ServiceUpgradeError';
  }
}

export interface ServiceUpgradeDomain {
  upgrade(
    actor: User,
    input: ServiceUpgradeInput,
    clientVersion: string,
    signal?: AbortSignal,
  ): Promise<ServiceUpgradeResponse>;
}

export interface ServiceUpgradeDomainDependencies {
  store: {
    getWorkloadForScope(
      workloadId: string,
      scope: OwnershipScope,
    ): Promise<StoredWorkload | null>;
  };
  resolveScope(actor: User): Promise<OwnershipScope>;
  prepareCheckpoint(workload: StoredWorkload, action: 'upgrade'): Promise<void>;
  preflightSecrets(
    secretNames: readonly string[] | null | undefined,
  ): Promise<void>;
  inspectImage(
    image: string,
    githubToken: string | null,
    architecture: ImageArchitecture,
  ): Promise<ImageInspection>;
  buildDockerCommand(args: {
    workload: StoredWorkload;
    image: string;
    command: string[] | null;
    env: Record<string, string> | null;
    checkpointHostPath?: string;
  }): string;
  updateService(request: ServeUpdateRequest): Promise<boolean>;
  recordEvent(
    actor: Pick<User, 'username'>,
    event: string,
    properties?: Record<string, unknown>,
  ): void;
  now(): number;
}

export function createServiceUpgradeDomain(
  dependencies: ServiceUpgradeDomainDependencies,
): ServiceUpgradeDomain {
  return {
    async upgrade(actor, input, clientVersion, signal) {
      const startedAt = dependencies.now();
      let failureMessage: string | undefined;
      let workload: StoredWorkload | undefined;
      try {
        signal?.throwIfAborted();
        const scope = await dependencies.resolveScope(actor);
        const found = await dependencies.store.getWorkloadForScope(
          input.id,
          scope,
        );
        if (!found) {
          throw new ServiceUpgradeError('Workload not found', 404);
        }
        workload = found;
        if (found.workloadType !== WorkloadType.Service) {
          throw new ServiceUpgradeError(
            'serve upgrade only supports service workloads',
            400,
            'Not a service workload',
          );
        }
        if (found.state !== WorkloadState.Running) {
          throw new ServiceUpgradeError(
            `Service workload must be running to upgrade; current state is ${found.state}`,
            409,
            'Service workload is not running',
          );
        }

        // A Service with a public DNS record keeps it with a GitHub token.
        if (found.dnsRecordId && !actor.token) {
          throw GithubSignInRequiredError.needs(SERVICE_URL_NEEDS);
        }
        assertVmHostContainerConfiguration(found);
        if (isHostedApiImage(found.image) || isHostedApiImage(input.image)) {
          throw new InvalidAnycloudConfigError(
            'VM-hosted APIs are no longer supported. Use `anycloud api create` to host an API, then `anycloud api use` to select it.',
          );
        }
        const effectiveDockerOptions =
          input.binds === undefined
            ? found.dockerOptions
            : { ...found.dockerOptions, binds: input.binds };
        validateDockerOptionsRequest(effectiveDockerOptions, found);
        await dependencies.prepareCheckpoint(found, 'upgrade');
        await dependencies.preflightSecrets(found.secretNames);

        // Admission keeps a type list to one architecture.
        const [vmType] = toArray(found.vmType);
        const architecture =
          found.cloudProvider && vmType
            ? vmArchitecture(found.cloudProvider, vmType)
            : 'amd64';
        const inspection = await dependencies.inspectImage(
          input.image,
          actor.token,
          architecture,
        );
        assertImageAccessible(input.image, inspection, architecture);
        const { digest } = inspection;

        const requestedCommand =
          input.command && input.command.length > 0 ? input.command : undefined;
        const effectiveCommand = requestedCommand ?? found.command;
        const effectiveEnv =
          input.env === undefined ? found.env : { ...found.env, ...input.env };
        const bucketHostPaths = found.cloudProvider
          ? bucketHostPathsForProvider(found.cloudProvider)
          : DEFAULT_BUCKET_HOST_PATHS;
        const dockerCommand = dependencies.buildDockerCommand({
          workload: { ...found, dockerOptions: effectiveDockerOptions },
          image: input.image,
          command: effectiveCommand,
          env: effectiveEnv,
          ...(resolveCheckpointTarget(input.id, found)
            ? { checkpointHostPath: bucketHostPaths.checkpoint }
            : {}),
        });

        signal?.throwIfAborted();
        const queued = await dependencies.updateService({
          workload: found,
          update: {
            id: input.id,
            scope,
            image: input.image,
            previousImage: found.image,
            dockerCommand,
            command: effectiveCommand,
            env: effectiveEnv,
            ...(input.binds === undefined
              ? {}
              : { dockerOptions: effectiveDockerOptions }),
            imageDigest: digest ?? undefined,
            githubToken: actor.token ?? null,
          },
        });
        if (!queued) {
          throw new ServiceUpgradeError(
            'Service workload changed before the upgrade could be queued; retry after it returns to running.',
            409,
            'Service workload changed before upgrade',
          );
        }
        return {
          id: input.id,
          url: found.dnsRecordId ? serveUrl(input.id) : null,
        };
      } catch (error) {
        failureMessage =
          error instanceof ServiceUpgradeError
            ? error.telemetryError
            : errorMessage(error);
        throw error;
      } finally {
        dependencies.recordEvent(actor, 'serve_upgrade', {
          version: clientVersion,
          durationMs: dependencies.now() - startedAt,
          id: input.id,
          image: input.image,
          hasCommand: input.command !== undefined && input.command.length > 0,
          ...(failureMessage && { error: failureMessage }),
          ...(workload && { workloadState: workload.state }),
        });
      }
    },
  };
}

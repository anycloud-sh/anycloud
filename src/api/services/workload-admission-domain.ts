import type {
  DedicatedWorkloadAdmissionInput,
  WorkloadAdmissionInput,
  WorkloadAdmissionResponse,
} from '../../shared/api-contract/workload-admission-schemas.js';
import { type CloudConfig } from '../../shared/cloud.js';
import type {
  AdmissionProgress,
  WorkloadCreationPlan,
} from './workload-admission-plan.js';
import type { ResolvedWorkloadAdmission } from './workload-admission-resolution.js';
import type { NodePoolServiceAdmissionInput } from './node-pool-service-admission.js';
import type { User } from './entities.js';
import { errorMessage } from '../../shared/log-diagnostics.js';
import { gpuCountForVMType, parseGpuType } from '../../shared/cloud-config.js';
import { toArray } from '../../shared/utils.js';
import { InvalidAnycloudConfigError } from '../../shared/errors.js';
import { assertDefaultJobSpec } from './job-spec-admission.js';
import { unclaimableWorkloadApiUrl } from './workload-api-url.js';

const WORKLOAD_NAMES = { job: 'Job', service: 'Service', vm: 'VM' } as const;

/**
 * The GPU count a VM-host request already selects: that of its one
 * `--gpu-type`, or the catalog's count for its one `--vm-type`, which defers
 * to `--gpus-per-node` until placement resolves the provider. None when
 * `--gpus` also selects GPUs.
 */
function singleGpuCount(
  input: DedicatedWorkloadAdmissionInput,
  resolved?: CloudConfig,
): number | undefined {
  const gpuTypes = toArray(input.gpuType);
  const vmTypes = toArray(input.cloudConfig.vmType);
  if (
    input.gpusPerNode === undefined ||
    input.dockerOptions?.gpus !== undefined
  )
    return undefined;
  if (gpuTypes.length > 0)
    return gpuTypes.length === 1 ? parseGpuType(gpuTypes[0]!).count : undefined;
  if (vmTypes.length !== 1) return undefined;
  return resolved
    ? gpuCountForVMType(resolved.cloudProvider, vmTypes[0]!)
    : input.gpusPerNode;
}

export interface WorkloadAdmissionDomain {
  submit(
    actor: User,
    input: WorkloadAdmissionInput,
    clientVersion: string,
    signal?: AbortSignal,
  ): Promise<WorkloadAdmissionResponse>;
}

export interface WorkloadAdmissionDomainDependencies {
  resolve(args: {
    actor: User;
    input: DedicatedWorkloadAdmissionInput;
  }): Promise<ResolvedWorkloadAdmission>;
  prepare(args: {
    resolved: ResolvedWorkloadAdmission;
    progress: AdmissionProgress;
    signal?: AbortSignal;
  }): Promise<WorkloadCreationPlan>;
  persist(plan: WorkloadCreationPlan): Promise<WorkloadAdmissionResponse>;
  submitTargeted(
    actor: User,
    input: Extract<WorkloadAdmissionInput, { deployment: string }>,
    signal?: AbortSignal,
  ): Promise<WorkloadAdmissionResponse>;
  submitNodePoolService(
    actor: User,
    input: NodePoolServiceAdmissionInput,
    signal?: AbortSignal,
  ): Promise<WorkloadAdmissionResponse>;
  submitPoolJob(
    actor: User,
    input: NodePoolServiceAdmissionInput,
    signal?: AbortSignal,
  ): Promise<WorkloadAdmissionResponse>;
  recordEvent(
    actor: Pick<User, 'username'>,
    event: string,
    properties?: Record<string, unknown>,
  ): void;
  now(): number;
  /** The origin replicas claim Jobs from (`getWorkloadApiUrl`). */
  workloadApiUrl(): string;
}

export function createWorkloadAdmissionDomain(
  dependencies: WorkloadAdmissionDomainDependencies,
): WorkloadAdmissionDomain {
  return {
    async submit(actor, input, clientVersion, signal) {
      const startedAt = dependencies.now();
      let failureMessage: string | undefined;
      const progress: AdmissionProgress = {};
      // Telemetry reports the placement admission resolved. A request rejected
      // before resolution finished never reached one, so it reports what the
      // caller sent.
      let admitted: CloudConfig | undefined;

      try {
        signal?.throwIfAborted();
        // Both kinds of Job wait for a Deployment replica to claim them.
        const refuseUnclaimable = () => {
          const refusal = unclaimableWorkloadApiUrl(
            dependencies.workloadApiUrl(),
          );
          if (refusal) throw new InvalidAnycloudConfigError(refusal);
        };
        if ('deployment' in input) {
          refuseUnclaimable();
          return await dependencies.submitTargeted(actor, input, signal);
        }
        const job = (input.workloadType ?? 'job') === 'job';
        const poolJob = input.nodePool !== undefined && job;
        if (input.maxRetries !== undefined && !job) {
          throw new InvalidAnycloudConfigError(
            '--max-retries applies only to a Job',
          );
        }
        if (input.timeout !== undefined && !poolJob) {
          throw new InvalidAnycloudConfigError(
            '--timeout applies only to a Job on a node pool or a Deployment',
          );
        }
        if (input.requireNestedVirtualization && (!job || poolJob)) {
          throw new InvalidAnycloudConfigError(
            '--require-nested-virtualization applies only to a Job on a VM; a node pool sets it for its Jobs',
          );
        }
        if (input.cloudConfig.regions !== undefined) {
          if (!job || poolJob) {
            throw new InvalidAnycloudConfigError(
              '--regions applies only to a Job on a VM',
            );
          }
          if (input.cloudConfig.region || input.cloudConfig.availabilityZone) {
            throw new InvalidAnycloudConfigError(
              '--regions takes neither --region nor --zone',
            );
          }
        }
        if (
          (input.cloudConfig.diskIops !== undefined ||
            input.cloudConfig.diskThroughputMibps !== undefined) &&
          (!job || poolJob)
        ) {
          throw new InvalidAnycloudConfigError(
            '--disk-iops/--disk-throughput apply only to a Job on a VM',
          );
        }
        if (input.hostDocker && (!job || poolJob)) {
          throw new InvalidAnycloudConfigError(
            '--host-docker applies only to a Job on a VM',
          );
        }
        // It replaces --privileged: the Job uses the host's Docker instead.
        if (input.hostDocker && input.dockerOptions?.privileged) {
          throw new InvalidAnycloudConfigError(
            '--host-docker replaces --privileged; pass only --host-docker',
          );
        }
        if (input.noCheckpoint && !job) {
          throw new InvalidAnycloudConfigError(
            '--no-checkpoint applies only to a Job',
          );
        }
        if (input.caches?.length && !poolJob) {
          throw new InvalidAnycloudConfigError(
            '--cache applies only to a Job on a node pool',
          );
        }
        if (input.nodePool !== undefined) {
          if (poolJob) refuseUnclaimable();
          const submit = poolJob
            ? dependencies.submitPoolJob
            : dependencies.submitNodePoolService;
          const response = await submit(
            actor,
            { ...input, nodePool: input.nodePool },
            signal,
          );
          progress.finalId = response.id;
          return response;
        }
        const subject = `A ${WORKLOAD_NAMES[input.workloadType ?? 'job']} on a VM host`;
        assertDefaultJobSpec(input, subject, singleGpuCount(input));
        const resolved = await dependencies.resolve({ actor, input });
        admitted = resolved.cloudConfig;
        assertDefaultJobSpec(
          input,
          subject,
          singleGpuCount(input, resolved.cloudConfig),
        );
        const plan = await dependencies.prepare({
          resolved,
          progress,
          signal,
        });
        return await dependencies.persist(plan);
      } catch (error) {
        failureMessage = errorMessage(error);
        throw error;
      } finally {
        const targeted = 'deployment' in input;
        const cloudConfig = admitted ?? (targeted ? {} : input.cloudConfig);
        dependencies.recordEvent(actor, 'new', {
          version: clientVersion,
          durationMs: dependencies.now() - startedAt,
          ...(failureMessage && { error: failureMessage }),
          ...(progress.finalId && { id: progress.finalId }),
          workloadType: input.workloadType,
          cloudProvider: cloudConfig.cloudProvider,
          region: cloudConfig.region,
          vmType: cloudConfig.vmType,
          gpuType: targeted ? undefined : input.gpuType,
          spot: cloudConfig.spot,
          image: targeted ? undefined : input.image,
          targetDeployment: targeted ? input.deployment : undefined,
          targetNodePool: targeted ? undefined : input.nodePool,
          hasCommand: targeted ? false : input.command !== undefined,
          hasBuckets: !!(cloudConfig.inputBucket || cloudConfig.outputBucket),
          hasCredentialName: targeted ? false : !!input.credentialName,
          diskSizeGb: cloudConfig.diskSizeGb,
          diskTier: cloudConfig.diskTier,
          shmSize: targeted ? undefined : input.dockerOptions?.shmSize,
          envCount: targeted || !input.env ? 0 : Object.keys(input.env).length,
          secretCount: targeted ? 0 : (input.secrets?.length ?? 0),
          bindCount: targeted ? 0 : (input.dockerOptions?.binds?.length ?? 0),
          ulimitCount: targeted
            ? 0
            : (input.dockerOptions?.ulimits?.length ?? 0),
        });
      }
    },
  };
}

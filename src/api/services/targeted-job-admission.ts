import type {
  WorkloadAdmissionResponse,
  DeploymentWorkloadAdmissionInput,
} from '../../shared/api-contract/workload-admission-schemas.js';
import {
  WorkloadIdExistsError,
  InvalidAnycloudConfigError,
} from '../../shared/errors.js';
import { generateJobId } from '../../shared/id-generator.js';
import { assertDefaultJobSpec } from './job-spec-admission.js';
import { normalizeAttribution } from './workload-operation-helpers.js';
import type { DeploymentRepository } from './deployment-store.js';
import type { CreateTargetedWorkloadInput } from './repositories/targeted-job-creation.js';
import type { User } from './entities.js';
import type { OwnershipScope } from './repositories/ownership-filter.js';

export interface TargetedJobAdmissionDependencies {
  deployments: Pick<DeploymentRepository, 'getMetadataForScope'>;
  persist(workload: CreateTargetedWorkloadInput): Promise<boolean>;
  resolveScope(actor: User): Promise<OwnershipScope>;
  validateId(id: string): Promise<string>;
  now(): number;
}

function isWorkloadIdConstraint(error: unknown): error is Error {
  return (
    error instanceof Error &&
    (error.message.includes('UNIQUE constraint failed: workloads.id') ||
      error.message.includes('workload identity already exists'))
  );
}

/** Admit identity-only finite work against one persistent Deployment. */
export async function submitTargetedJob(
  dependencies: TargetedJobAdmissionDependencies,
  actor: User,
  input: DeploymentWorkloadAdmissionInput,
  signal?: AbortSignal,
): Promise<WorkloadAdmissionResponse> {
  const claimDeadlineAt =
    input.timeout === undefined
      ? null
      : dependencies.now() + Math.floor(input.timeout * 1000);
  if (claimDeadlineAt !== null && !Number.isSafeInteger(claimDeadlineAt)) {
    throw new InvalidAnycloudConfigError('Submission timeout is too large');
  }
  signal?.throwIfAborted();
  const scope = await dependencies.resolveScope(actor);
  const target = await dependencies.deployments.getMetadataForScope(
    input.deployment,
    scope,
  );
  if (!target || target.deletionRequestedAt !== null) {
    if (!target) {
      throw new InvalidAnycloudConfigError(
        `Deployment "${input.deployment}" not found`,
      );
    }
    throw new InvalidAnycloudConfigError(
      `Deployment "${input.deployment}" is draining`,
    );
  }
  if (target.managed) {
    throw new InvalidAnycloudConfigError(
      `Deployment "${input.deployment}" runs pool Jobs; submit with anycloud job IMAGE --node-pool instead`,
    );
  }
  assertDefaultJobSpec(input, 'A Job on a Deployment');
  const id = await dependencies.validateId(input.id ?? generateJobId());
  signal?.throwIfAborted();
  let persisted: boolean;
  try {
    persisted = await dependencies.persist({
      id,
      userId: actor.username,
      ownerUserId: actor.id,
      deploymentId: target.id,
      claimDeadlineAt,
      maxRetries: input.maxRetries,
      session: normalizeAttribution(input.session) ?? undefined,
      agent: normalizeAttribution(input.agent) ?? undefined,
      sessionLabel: normalizeAttribution(input.sessionLabel) ?? undefined,
    });
  } catch (error) {
    if (isWorkloadIdConstraint(error)) {
      throw new WorkloadIdExistsError();
    }
    throw error;
  }
  if (!persisted) {
    throw new InvalidAnycloudConfigError(
      `Deployment "${input.deployment}" is draining`,
    );
  }
  return { id, submissionRevision: 0, claimDeadlineAt };
}

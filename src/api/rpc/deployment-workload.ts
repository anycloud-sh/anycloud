import { DeploymentWorkloadError } from '../services/deployment-errors.js';
import { throwDeclaredError, type DeclaredErrorCodes } from './errors.js';
import {
  workloadImplementation as workload,
  boundedWorkloadImplementation as bounded,
} from './base.js';

const CODES = {
  400: 'CLIENT_VERSION_MISMATCH',
  401: 'WORKLOAD_UNAUTHORIZED',
  403: 'WORKLOAD_FORBIDDEN',
  404: 'WORKLOAD_NOT_FOUND',
  409: 'WORKLOAD_CONFLICT',
  503: 'WORKLOAD_UNAVAILABLE',
} satisfies DeclaredErrorCodes & { 401: string; 403: string };

function raise(error: unknown): never {
  if (error instanceof DeploymentWorkloadError) {
    // The shared helper models operator endpoints and omits 401, so retain the
    // same explicit ORPC mapping via the handler's declared factories below.
    throw error;
  }
  throw error;
}

async function map<T>(
  operation: () => Promise<T>,
  errors: Record<string, (options: { message: string; cause: Error }) => Error>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!(error instanceof DeploymentWorkloadError)) raise(error);
    const factory = errors[error.code ?? CODES[error.statusCode]];
    if (!factory) {
      if (error.statusCode === 401 || error.statusCode === 403) {
        const authorizationFactory =
          error.statusCode === 401
            ? errors.WORKLOAD_UNAUTHORIZED
            : errors.WORKLOAD_FORBIDDEN;
        throw authorizationFactory({
          message: error.message,
          cause: error,
        });
      }
      throwDeclaredError(error, error.statusCode, error.message, CODES);
    }
    throw factory({ message: error.message, cause: error });
  }
}

export const deploymentWorkloadRouter = {
  candidate: bounded.deploymentWorkload.candidate.handler(
    ({ context, input, errors }) =>
      map(
        () =>
          context.domains.deploymentWorkload.candidate(
            input.params.deploymentId,
            input.query.waitMs,
            context.authorization,
            context.operation,
            context.clientVersion,
          ),
        errors,
      ),
  ),
  claim: bounded.deploymentWorkload.claim.handler(
    ({ context, input, errors }) =>
      map(
        () =>
          context.domains.deploymentWorkload.claim(
            input.params.deploymentId,
            input.params.jobId,
            input.headers['idempotency-key'],
            input.body,
            context.authorization,
            context.operation,
            context.clientVersion,
          ),
        errors,
      ),
  ),
  cancellation: bounded.deploymentWorkload.cancellation.handler(
    ({ context, input, errors }) =>
      map(
        () =>
          context.domains.deploymentWorkload.cancellation(
            input.params.deploymentId,
            input.params.jobId,
            input.query.executionId,
            context.authorization,
            input.query.waitMs,
            context.operation,
            context.clientVersion,
          ),
        errors,
      ),
  ),
  outcome: workload.deploymentWorkload.outcome.handler(
    ({ context, input, errors }) =>
      map(
        () =>
          context.domains.deploymentWorkload.outcome(
            input.params.deploymentId,
            input.params.jobId,
            input.body,
            context.authorization,
            context.clientVersion,
          ),
        errors,
      ),
  ),
  cleanup: workload.deploymentWorkload.cleanup.handler(
    ({ context, input, errors }) =>
      map(
        () =>
          context.domains.deploymentWorkload.cleanup(
            input.params.deploymentId,
            input.params.jobId,
            input.body.executionId,
            context.authorization,
            context.clientVersion,
          ),
        errors,
      ),
  ),
  execution: workload.deploymentWorkload.execution.handler(
    ({ context, input, errors }) =>
      map(
        () =>
          context.domains.deploymentWorkload.execution(
            input.params.deploymentId,
            input.params.jobId,
            input.query.executionId,
            context.authorization,
            context.clientVersion,
          ),
        errors,
      ),
  ),
  report: workload.deploymentWorkload.report.handler(
    ({ context, input, errors }) =>
      map(
        () =>
          context.domains.deploymentWorkload.report(
            input.params.deploymentId,
            input.params.jobId,
            input.body,
            context.authorization,
            context.clientVersion,
          ),
        errors,
      ),
  ),
};

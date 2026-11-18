import { WorkloadManagementError } from '../services/workload-management-domain.js';
import {
  throwDeclaredDeployError,
  throwDeclaredError,
  type DeclaredErrorCodes,
} from './errors.js';
import { clientWindowAuthenticatedImplementation as authenticated } from './base.js';

const MANAGEMENT_CODES = {
  400: 'WORKLOAD_MANAGEMENT_REQUEST_INVALID',
  404: 'WORKLOAD_MANAGEMENT_NOT_FOUND',
  409: 'WORKLOAD_MANAGEMENT_CONFLICT',
  503: 'WORKLOAD_MANAGEMENT_UNAVAILABLE',
} satisfies DeclaredErrorCodes;

function throwProcedureError(error: unknown): never {
  if (error instanceof WorkloadManagementError) {
    throwDeclaredError(
      error,
      error.statusCode,
      error.message,
      MANAGEMENT_CODES,
    );
  }
  throwDeclaredDeployError(error, MANAGEMENT_CODES);
}

async function withWorkloadDomain<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throwProcedureError(error);
  }
}

export const workloadManagementRouter = {
  cost: authenticated.workloads.cost.handler(({ context, input, signal }) =>
    withWorkloadDomain(() =>
      context.domains.workloadManagement.costForWorkload(
        context.actor,
        input,
        context.clientVersion,
        signal,
      ),
    ),
  ),
  costReport: authenticated.workloads.costReport.handler(
    ({ context, input, signal }) =>
      withWorkloadDomain(() =>
        context.domains.workloadManagement.costWindow(
          context.actor,
          input.query,
          context.clientVersion,
          signal,
        ),
      ),
  ),
  list: authenticated.workloads.list.handler(({ context, input, signal }) =>
    withWorkloadDomain(() =>
      context.domains.workloadManagement.list(
        context.actor,
        input.query,
        context.clientVersion,
        signal,
      ),
    ),
  ),
  terminate: authenticated.workloads.terminate.handler(
    ({ context, input, signal }) =>
      withWorkloadDomain(() =>
        context.domains.workloadManagement.terminate(
          context.actor,
          input,
          context.clientVersion,
          signal,
        ),
      ),
  ),
  status: authenticated.workloads.status.handler(({ context, input, signal }) =>
    withWorkloadDomain(() =>
      context.domains.workloadManagement.status(
        context.actor,
        input,
        context.clientVersion,
        signal,
      ),
    ),
  ),
  sshAccess: authenticated.workloads.sshAccess.handler(
    ({ context, input, signal }) =>
      withWorkloadDomain(() =>
        context.domains.workloadManagement.sshAccess(
          context.actor,
          input,
          context.clientVersion,
          signal,
        ),
      ),
  ),
  resubmit: authenticated.workloads.resubmit.handler(
    ({ context, input, signal }) =>
      withWorkloadDomain(() =>
        context.domains.workloadManagement.resubmit(
          context.actor,
          input,
          context.clientVersion,
          signal,
        ),
      ),
  ),
};

import { throwDeclaredDeployError, type DeclaredErrorCodes } from './errors.js';
import { clientWindowAuthenticatedImplementation as authenticated } from './base.js';

const ADMISSION_CODES = {
  400: 'WORKLOAD_ADMISSION_REJECTED',
  409: 'WORKLOAD_ID_CONFLICT',
  503: 'WORKLOAD_ADMISSION_UNAVAILABLE',
} satisfies DeclaredErrorCodes;

export const workloadAdmissionRouter = {
  submit: authenticated.admission.submit.handler(
    async ({ context, input, signal }) => {
      try {
        return await context.domains.workloadAdmission.submit(
          context.actor,
          input,
          context.clientVersion,
          signal,
        );
      } catch (error) {
        throwDeclaredDeployError(error, ADMISSION_CODES);
      }
    },
  ),
};

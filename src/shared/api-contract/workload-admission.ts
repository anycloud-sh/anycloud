import { authenticatedEndpoints } from './base.js';
import {
  workloadAdmissionInputSchema,
  workloadAdmissionResponseSchema,
} from './workload-admission-schemas.js';

const authenticated = authenticatedEndpoints({}, 'Workload Admission');

const submit = authenticated
  .command(
    {
      method: 'POST',
      path: '/workloads',
      operationId: 'submitWorkload',
      summary: 'Validate and submit a workload',
      successStatus: 202,
    },
    {
      replay: 'not-processed',
      timeoutMs: null,
    },
  )
  .input(workloadAdmissionInputSchema)
  .output(workloadAdmissionResponseSchema)
  .errors({
    WORKLOAD_ADMISSION_REJECTED: {
      status: 400,
      message: 'Workload admission rejected',
    },
    WORKLOAD_ID_CONFLICT: {
      status: 409,
      message: 'Workload ID already exists',
    },
    WORKLOAD_ADMISSION_UNAVAILABLE: {
      status: 503,
      message: 'Workload admission unavailable',
    },
  });

export const workloadAdmissionContract = { submit };

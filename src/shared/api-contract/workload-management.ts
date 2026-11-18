import { authenticatedEndpoints } from './base.js';
import {
  aggregateWorkloadCostRequestSchema,
  workloadActionResponseSchema,
  workloadCostReportSchema,
  workloadCostRowsSchema,
  workloadListRequestSchema,
  workloadListResponseSchema,
  workloadResubmitRequestSchema,
  workloadResubmitResponseSchema,
  jobSubmissionObservationRequestSchema,
  jobSubmissionObservationSchema,
  workloadSshAccessRequestSchema,
  workloadSshAccessResponseSchema,
  workloadStatusRequestSchema,
  workloadStatusResponseSchema,
  workloadTerminateRequestSchema,
  exactWorkloadCostRequestSchema,
} from './workload-management-schemas.js';

// Deployment execution endpoints already own WORKLOAD_* error codes. Keep the
// management family distinct so generated clients have unambiguous errors.
const management = authenticatedEndpoints(
  {
    WORKLOAD_MANAGEMENT_REQUEST_INVALID: {
      status: 400,
      message: 'Invalid workload request',
    },
    WORKLOAD_MANAGEMENT_NOT_FOUND: {
      status: 404,
      message: 'Workload not found',
    },
    WORKLOAD_MANAGEMENT_CONFLICT: {
      status: 409,
      message: 'Workload operation conflict',
    },
    WORKLOAD_MANAGEMENT_UNAVAILABLE: {
      status: 503,
      message: 'Workload service unavailable',
    },
  },
  'Workloads',
);

const cost = management
  .query({
    method: 'GET',
    path: '/workloads/{id}/cost',
    operationId: 'getWorkloadCost',
    summary: 'Read one workload cost',
    inputStructure: 'detailed',
  })
  .input(exactWorkloadCostRequestSchema)
  .output(workloadCostRowsSchema);

const costReport = management
  .query({
    method: 'GET',
    path: '/workload-costs',
    operationId: 'getWorkloadCostReport',
    summary: 'Read aggregate workload costs',
    inputStructure: 'detailed',
  })
  .input(aggregateWorkloadCostRequestSchema)
  .output(workloadCostReportSchema);

const list = management
  .query({
    method: 'GET',
    path: '/workloads',
    operationId: 'listWorkloads',
    summary: 'List workloads',
    inputStructure: 'detailed',
  })
  .input(workloadListRequestSchema)
  .output(workloadListResponseSchema);

const terminate = management
  .command({
    method: 'DELETE',
    path: '/workloads/{id}',
    operationId: 'terminateWorkload',
    summary: 'Schedule workload termination',
    inputStructure: 'detailed',
    successStatus: 202,
  })
  .input(workloadTerminateRequestSchema)
  .output(workloadActionResponseSchema);

const status = management
  .query({
    method: 'GET',
    path: '/workloads/{id}',
    operationId: 'getWorkloadStatus',
    summary: 'Read workload status and health',
    inputStructure: 'detailed',
  })
  .input(workloadStatusRequestSchema)
  .output(workloadStatusResponseSchema);

const sshAccess = management
  .query({
    method: 'GET',
    path: '/workloads/{id}/ssh-access',
    operationId: 'getWorkloadSshAccess',
    summary: 'Read workload SSH access material',
    inputStructure: 'detailed',
  })
  .input(workloadSshAccessRequestSchema)
  .output(workloadSshAccessResponseSchema);

const resubmit = management
  .command({
    method: 'POST',
    path: '/workloads/{id}/resubmissions',
    operationId: 'resubmitWorkload',
    summary: 'Resubmit a terminal workload',
    inputStructure: 'detailed',
    successStatus: 202,
  })
  .input(workloadResubmitRequestSchema)
  .output(workloadResubmitResponseSchema);

const observeSubmission = management
  .command(
    {
      method: 'POST',
      path: '/workloads/{id}/claim-observation',
      operationId: 'observeJobSubmission',
      summary: 'Observe or expire one Deployment Job submission',
      inputStructure: 'detailed',
    },
    { replay: 'safe', timeoutMs: 30_000 },
  )
  .input(jobSubmissionObservationRequestSchema)
  .output(jobSubmissionObservationSchema);

export const workloadManagementContract = {
  cost,
  costReport,
  list,
  terminate,
  status,
  sshAccess,
  resubmit,
  observeSubmission,
};

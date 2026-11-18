import { workloadEndpoints } from './base.js';
import { noContentSchema } from './common-schemas.js';
import {
  selectedJobSchema,
  workloadCandidateInputSchema,
  workloadCandidateResponseSchema,
  workloadClaimJobInputSchema,
  workloadCancellationInputSchema,
  workloadCancellationResponseSchema,
  workloadCleanupInputSchema,
  workloadExecutionInputSchema,
  workloadExecutionSchema,
  workloadOutcomeInputSchema,
  workloadRunnerReportInputSchema,
} from './deployment-workload-schemas.js';

const workload = workloadEndpoints(
  {
    WORKLOAD_NOT_FOUND: { status: 404, message: 'Job execution not found' },
    WORKLOAD_CONFLICT: {
      status: 409,
      message: 'Stale Job execution operation',
    },
    WORKLOAD_CANDIDATE_STALE: {
      status: 409,
      message: 'This Job candidate can never be claimed',
    },
    WORKLOAD_EXECUTION_USED: {
      status: 409,
      message: 'This execution UUID has already been used',
    },
    CLIENT_VERSION_MISMATCH: {
      status: 400,
      message: 'Client/API version mismatch',
    },
    WORKLOAD_UNAVAILABLE: {
      status: 503,
      message: 'Workload verification unavailable',
    },
  },
  'Deployment Workload',
);

const candidate = workload
  .query(
    {
      method: 'GET',
      path: '/deployments/{deploymentId}/jobs/candidate',
      operationId: 'discoverDeploymentJobCandidate',
      summary: 'Observe an eligible Job without starting it',
      inputStructure: 'detailed',
      outputStructure: 'detailed',
    },
    { timeoutMs: 30_000 },
  )
  .input(workloadCandidateInputSchema)
  .output(workloadCandidateResponseSchema);

const claim = workload
  .command(
    {
      method: 'POST',
      path: '/deployments/{deploymentId}/jobs/{jobId}/claim',
      operationId: 'claimDeploymentJob',
      summary: 'Start or recover one exact Job candidate',
      inputStructure: 'detailed',
    },
    { replay: 'safe', timeoutMs: 30_000 },
  )
  .input(workloadClaimJobInputSchema)
  .output(selectedJobSchema);

const cancellation = workload
  .query(
    {
      method: 'GET',
      path: '/deployments/{deploymentId}/jobs/{jobId}/cancellation',
      operationId: 'getDeploymentJobCancellation',
      summary: 'Observe whether a targeted Job was terminated',
      inputStructure: 'detailed',
    },
    { timeoutMs: 30_000 },
  )
  .input(workloadCancellationInputSchema)
  .output(workloadCancellationResponseSchema);

const outcome = workload
  .command(
    {
      method: 'POST',
      path: '/deployments/{deploymentId}/jobs/{jobId}/outcome',
      operationId: 'reportDeploymentJobOutcome',
      summary: 'Publish a targeted Job outcome',
      inputStructure: 'detailed',
      successStatus: 204,
    },
    { replay: 'safe' },
  )
  .input(workloadOutcomeInputSchema)
  .output(noContentSchema);

const cleanup = workload
  .command(
    {
      method: 'POST',
      path: '/deployments/{deploymentId}/jobs/{jobId}/cleanup',
      operationId: 'cleanupDeploymentJob',
      summary: 'Confirm that a terminated local task stopped',
      inputStructure: 'detailed',
      successStatus: 204,
    },
    { replay: 'safe' },
  )
  .input(workloadCleanupInputSchema)
  .output(noContentSchema);

const execution = workload
  .query({
    method: 'GET',
    path: '/deployments/{deploymentId}/jobs/{jobId}/execution',
    operationId: 'getDeploymentJobExecution',
    summary: "Read a claimed Job's command, env and storage credentials",
    inputStructure: 'detailed',
  })
  .input(workloadExecutionInputSchema)
  .output(workloadExecutionSchema);

const report = workload
  .command(
    {
      method: 'POST',
      path: '/deployments/{deploymentId}/jobs/{jobId}/report',
      operationId: 'reportDeploymentJobRunner',
      summary: "Publish a runner's phase or why its attempt ended",
      inputStructure: 'detailed',
      successStatus: 204,
    },
    { replay: 'safe' },
  )
  .input(workloadRunnerReportInputSchema)
  .output(noContentSchema);

export const deploymentWorkloadContract = {
  candidate,
  claim,
  cancellation,
  outcome,
  cleanup,
  execution,
  report,
};

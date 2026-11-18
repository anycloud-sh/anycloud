/** Deployment-targeted Job fixtures shared by the Deployment execution and query specs. */
import { getDeploymentStore } from '../../../src/api/services/persistence.js';
import type { CreateTargetedWorkloadInput } from '../../../src/api/services/repositories/targeted-job-creation.js';
import { getWorkloadAdmissionWriter } from '../../../src/api/services/workload-admission-writer.js';
import { seedReadyNodePool } from './node-pool-seed.js';

export const firstExecution = '11111111-1111-4111-8111-111111111111';
export const secondExecution = '22222222-2222-4222-8222-222222222222';

/** The `target` Deployment on a ready node pool, owned by `target-owner`. */
export async function createTarget(
  maxConcurrentJobs = 1,
  id = 'target',
): Promise<void> {
  await seedReadyNodePool({
    nodePoolId: 'target-pool',
    ownerUserId: 'target-owner',
  });
  await getDeploymentStore().create(
    {
      id,
      ownerUserId: 'target-owner',
      name: id,
      nodePoolId: 'target-pool',
      config: {
        image: 'example/deployment:latest',
        imageDigest: null,
        command: null,
        env: null,
        registryUsername: 'target-owner',
        registryToken: null,
        dockerOptions: null,
      },
      gpuCount: 0,
      maxConcurrentJobsPerReplica: maxConcurrentJobs,
    },
    { kind: 'api' },
  );
}

export async function createTargetedJob(
  id: string,
  options: Partial<Omit<CreateTargetedWorkloadInput, 'id'>> = {},
): Promise<boolean> {
  return getWorkloadAdmissionWriter().createTargetedWorkload({
    id,
    userId: 'target-owner',
    ownerUserId: 'target-owner',
    deploymentId: 'target',
    ...options,
  });
}

/** A first-revision claim of `jobId` by one `target` replica. */
export function claimInput(
  jobId: string,
  executionId: string,
  previousExecutionId: string | null = null,
  podUid = 'pod-a',
) {
  return {
    jobId,
    submissionRevision: 0,
    previousExecutionId,
    deploymentId: 'target',
    executionId,
    generation: 1,
    podUid,
    containerId: 'containerd://container-a',
  };
}

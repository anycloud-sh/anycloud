import type { CloudType } from '../../shared/cloud.js';
import {
  createWorkload,
  type CreateWorkloadInput,
} from './repositories/workload-creation.js';
import { upsertCredential } from './repositories/credential-secrets.js';
import {
  createPoolJob,
  createTargetedWorkload,
  type CreatePoolJobInput,
  type CreateTargetedWorkloadInput,
} from './repositories/targeted-job-creation.js';
import { getDB } from './repositories/db.js';
import { getPersistence } from './persistence.js';

export interface WorkloadAdmissionWriter {
  createWorkload(input: CreateWorkloadInput): Promise<void>;
  createTargetedWorkload(input: CreateTargetedWorkloadInput): Promise<boolean>;
  createPoolJob(input: CreatePoolJobInput): Promise<string | null>;
  upsertCredential(
    credentialId: string,
    encryptedData: string,
    cloudProvider: CloudType,
  ): Promise<string>;
}

/** Admission-only durable writes, which no runtime repository exposes. */
export function getWorkloadAdmissionWriter(): WorkloadAdmissionWriter {
  const db = getDB();
  const { jobChanges } = getPersistence();
  return Object.freeze({
    createWorkload: (input: CreateWorkloadInput) => createWorkload(db, input),
    createTargetedWorkload: (input: CreateTargetedWorkloadInput) =>
      createTargetedWorkload(db, jobChanges, input),
    createPoolJob: (input: CreatePoolJobInput) =>
      createPoolJob(db, jobChanges, input),
    upsertCredential: (
      credentialId: string,
      encryptedData: string,
      cloudProvider: CloudType,
    ) => upsertCredential(db, credentialId, encryptedData, cloudProvider),
  });
}

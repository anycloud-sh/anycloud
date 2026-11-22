import type { CloudType } from '../../shared/cloud.js';
import {
  createWorkload,
  type CreateWorkloadInput,
} from './repositories/workload-creation.js';
import { upsertCredential } from './repositories/credential-secrets.js';
import { getDB } from './repositories/db.js';

export interface WorkloadAdmissionWriter {
  createWorkload(input: CreateWorkloadInput): Promise<void>;
  upsertCredential(
    credentialId: string,
    encryptedData: string,
    cloudProvider: CloudType,
  ): Promise<string>;
}

/** Admission-only durable writes, which no runtime repository exposes. */
export function getWorkloadAdmissionWriter(): WorkloadAdmissionWriter {
  const db = getDB();
  return Object.freeze({
    createWorkload: (input: CreateWorkloadInput) => createWorkload(db, input),
    upsertCredential: (
      credentialId: string,
      encryptedData: string,
      cloudProvider: CloudType,
    ) => upsertCredential(db, credentialId, encryptedData, cloudProvider),
  });
}

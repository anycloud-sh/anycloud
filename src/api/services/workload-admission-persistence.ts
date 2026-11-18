import type { WorkloadAdmissionResponse } from '../../shared/api-contract/workload-admission-schemas.js';
import { type CloudCredentials } from '../../shared/cloud.js';
import { encryptCredential, hashCredential } from './cloud-config.js';
import type { WorkloadCreationPlan } from './workload-admission-plan.js';
import {
  getWorkloadAdmissionWriter,
  type WorkloadAdmissionWriter,
} from './workload-admission-writer.js';

async function storeCredential(
  writer: WorkloadAdmissionWriter,
  credentials: CloudCredentials | undefined,
): Promise<string | undefined> {
  if (!credentials) return undefined;
  return writer.upsertCredential(
    hashCredential(credentials),
    await encryptCredential(credentials),
    credentials.cloudProvider,
  );
}

/** Persist a fully admitted plan. No request validation belongs in this stage. */
export async function persistWorkloadCreation(
  plan: WorkloadCreationPlan,
): Promise<WorkloadAdmissionResponse> {
  const writer = getWorkloadAdmissionWriter();
  const credentialId =
    plan.resolvedComputeCredentialId ??
    (await storeCredential(writer, plan.inlineComputeCredentials));
  const inputStorageCredentialId = await storeCredential(
    writer,
    plan.inputStorageCredentials,
  );
  const outputStorageCredentialId = await storeCredential(
    writer,
    plan.outputStorageCredentials,
  );
  const checkpointStorageCredentialId = await storeCredential(
    writer,
    plan.checkpointStorageCredentials,
  );

  await writer.createWorkload({
    ...plan.workload,
    credentialId,
    inputStorageCredentialId,
    outputStorageCredentialId,
    checkpointStorageCredentialId,
  });
  return plan.response;
}

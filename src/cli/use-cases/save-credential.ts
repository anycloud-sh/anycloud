import { ORPCError } from '@orpc/client';
import type { RedactedCredential } from '../../shared/api-contract/credentials-schemas.js';
import { errorMessage } from '../../shared/log-diagnostics.js';
import type { ApiClient } from '../../shared/services/api-client/rpc.js';
import type {
  CredentialAcquisition,
  CredentialLease,
} from '../services/credential-onboarding/index.js';

export interface CredentialSaveClient {
  credentials: Pick<ApiClient['credentials'], 'list' | 'save'>;
}

export async function credentialNameTaken(
  client: CredentialSaveClient,
  name: string,
): Promise<boolean> {
  const existing = await client.credentials.list();
  return existing.some((credential) => credential.name === name);
}

function isDefinitiveCredentialSaveRejection(error: unknown): boolean {
  if (!(error instanceof ORPCError)) return false;
  return (
    error.status >= 400 &&
    error.status < 500 &&
    ![408, 425, 429, 499].includes(error.status)
  );
}

function retainedIdentityError(
  saveError: unknown,
  lease: CredentialLease,
  verificationError?: unknown,
): Error {
  const verification = verificationError
    ? ` (${errorMessage(verificationError)})`
    : '';
  return new Error(
    `${errorMessage(saveError)} The API could not confirm whether the credential was saved${verification}, so the generated ${lease.identityDescription} was retained for safe manual reconciliation.`,
  );
}

export async function saveCredential(
  client: CredentialSaveClient,
  name: string,
  acquired: CredentialAcquisition,
  overwrite: boolean,
): Promise<void> {
  const { credential, lease } = acquired;
  try {
    // A later rejection cannot prove an earlier attempt did not commit.
    // Reconcile the original failure before deciding whether to clean up.
    await client.credentials.save(
      {
        params: { name },
        query: { overwrite: overwrite ? 'true' : 'false' },
        body: credential,
      },
      lease ? { context: { retry: 0 } } : undefined,
    );
    lease?.commit();
    return;
  } catch (saveError) {
    // Imported secrets cannot be compared safely through the redacted API.
    // Their save error must remain authoritative.
    if (!lease) throw saveError;

    if (isDefinitiveCredentialSaveRejection(saveError)) {
      try {
        await lease.rollback();
      } catch (cleanupError) {
        const retainedResources = lease.retainedResourcesAfterCleanup
          ? ` ${lease.retainedResourcesAfterCleanup}`
          : '';
        throw new Error(
          `${errorMessage(saveError)} Cleanup of the generated cloud identity also failed: ${errorMessage(cleanupError)}${retainedResources}`,
        );
      }
      if (lease.retainedResourcesAfterCleanup) {
        throw new Error(
          `${errorMessage(saveError)} ${lease.retainedResourcesAfterCleanup}`,
        );
      }
      throw saveError;
    }

    let stored: RedactedCredential | undefined;
    try {
      stored = (await client.credentials.list()).find(
        (credential) => credential.name === name,
      );
    } catch (verificationError) {
      lease.retainForReconciliation();
      throw retainedIdentityError(saveError, lease, verificationError);
    }

    // A response can be lost after the server commits. Treat the operation as
    // successful only when the API reports this exact provider identity.
    if (stored && lease.matchesStored(stored)) {
      lease.commit();
      return;
    }

    // An empty read may be stale after a timeout. Never destroy a generated
    // identity unless the API has definitively rejected the mutation.
    lease.retainForReconciliation();
    throw retainedIdentityError(saveError, lease);
  }
}

import { ORPCError } from '@orpc/client';
import { exitWithError } from '../utils/output.js';
import type { RedactedCredential } from '../../shared/api-contract/credentials-schemas.js';
import { type CloudType } from '../../shared/cloud.js';
import { isCloudType } from '../../shared/cloud-config.js';
import { apiClient } from './auth.js';

export type ResolvedCredentialMetadata = RedactedCredential & {
  cloudProvider: CloudType;
};

/**
 * Get metadata for a named credential via redacted API call.
 * Only fetches metadata (name + cloudProvider), not full secrets.
 */
export async function getCredentialMetadata(
  name: string,
): Promise<ResolvedCredentialMetadata> {
  let redacted: RedactedCredential;
  try {
    redacted = await (
      await apiClient()
    ).credentials.get({
      params: { name },
    });
  } catch (error) {
    if (error instanceof ORPCError && error.status === 404) {
      exitWithError(
        `Credential "${name}" not found.\n` +
          '   Run "anycloud credentials list" to see available credentials.',
      );
    }
    if (error instanceof Error) {
      exitWithError(error.message);
    }
    exitWithError(
      `Failed to fetch credential "${name}".\n` +
        '   Run "anycloud credentials list" to see available credentials.',
    );
  }

  if (!isCloudType(redacted.cloudProvider)) {
    exitWithError(`Unknown cloud provider "${redacted.cloudProvider}".`);
  }

  return {
    ...redacted,
    cloudProvider: redacted.cloudProvider,
  };
}

/**
 * Get the cloud provider for a named credential via redacted API call.
 * Only fetches metadata (name + cloudProvider), not full secrets.
 */
export async function getCredentialCloudProvider(
  name: string,
): Promise<CloudType> {
  const redacted = await getCredentialMetadata(name);
  return redacted.cloudProvider;
}

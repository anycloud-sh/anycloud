import { type ComputeCloudCredentials } from '../../shared/cloud.js';
import { isComputeCredentials } from '../../shared/cloud-config.js';
import { storageOnlyComputeMessage } from '../../shared/providers.js';
import { exitWithError } from '../utils/output.js';
import { normalizeProvider } from '../utils/providers.js';
import {
  buildCredentialFromEnvironment,
  credentialEnvironmentError,
} from './credential-onboarding/index.js';

/**
 * Build cloud credentials from environment variables in non-interactive mode
 */
export function getCredentialsFromEnv(): ComputeCloudCredentials {
  const rawProvider = process.env.ANYCLOUD_CLOUD_PROVIDER;

  try {
    const credentials = buildCredentialFromEnvironment(
      rawProvider ? normalizeProvider(rawProvider) : undefined,
      process.env,
    );
    if (!isComputeCredentials(credentials)) {
      exitWithError(storageOnlyComputeMessage(credentials.cloudProvider));
    }
    return credentials;
  } catch (error) {
    const environmentError = credentialEnvironmentError(error);
    if (environmentError?.kind === 'provider-not-detected') {
      exitWithError(
        'Could not auto-detect cloud provider from environment.\n' +
          '   Set ANYCLOUD_CLOUD_PROVIDER to AWS, Azure, GCP, or Lambda, and provide required credentials.',
      );
    }
    if (environmentError?.kind === 'missing-variable') {
      exitWithError(
        `${environmentError.description} required.\n` +
          `   Pass the equivalent flag or set ${environmentError.variableName} environment variable.`,
      );
    }
    throw error;
  }
}

/**
 * Get credentials name from environment variable
 */
export function getCredentialsNameFromEnv(): string | undefined {
  return process.env.ANYCLOUD_CREDENTIALS_NAME;
}

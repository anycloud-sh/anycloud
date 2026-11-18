import {
  getCredentialsNameFromEnv,
  getCredentialsFromEnv,
} from './non-interactive.js';
import { type WorkloadAdmissionCloudConfig as WorkloadRequestCloudConfig } from '../../shared/api-contract/workload-admission-schemas.js';
import {
  extractCredentials,
  normalizeDiskTier,
} from '../../shared/cloud-config.js';

/**
 * Resolved config: CloudConfig + optional credential names for server-side lookup.
 * When credentialName is set, cloudConfig.credentials is omitted — the server resolves it.
 */
export interface ResolvedConfig {
  cloudConfig: WorkloadRequestCloudConfig;
  credentialName?: string;
  inputStorageCredentialName?: string;
  outputStorageCredentialName?: string;
  checkpointStorageCredentialName?: string;
  gpuType?: string | string[];
}

/**
 * Inline config flags passed via CLI
 */
export interface InlineConfigFlags {
  credentials?: string;
  region?: string;
  vmType?: string | string[];
  gpuType?: string | string[];
  spot?: boolean;
  diskSizeGb?: number;
  diskTier?: string;
  inputBucket?: string;
  outputBucket?: string;
  checkpointBucket?: string;
  inputStorageCredentials?: string;
  inputStorageRegion?: string;
  outputStorageCredentials?: string;
  outputStorageRegion?: string;
  checkpointStorageCredentials?: string;
  checkpointStorageRegion?: string;
  availabilityZone?: string;
}

/**
 * Build CloudConfig entirely from inline CLI flags.
 * Uses --credentials / ANYCLOUD_CREDENTIALS_NAME when provided. Workload
 * commands resolve a saved named credential before calling this helper when
 * one exists and no inline credential environment is present. An empty saved
 * set remains credentialless for API-side capability resolution.
 * Named credentials are resolved server-side; inline env vars are embedded directly.
 */
export async function buildCloudConfigFromFlags(
  flags: InlineConfigFlags,
): Promise<ResolvedConfig> {
  const credentialsName = flags.credentials || getCredentialsNameFromEnv();
  const diskTier = normalizeDiskTier(flags.diskTier);

  if (credentialsName) {
    // Named credential — server will resolve full creds and cloudProvider
    // from its DB during workload admission.
    const cloudConfig: WorkloadRequestCloudConfig = {
      region: flags.region,
      vmType: flags.vmType,
      spot: flags.spot,
      diskSizeGb: flags.diskSizeGb,
      diskTier,
      inputBucket: flags.inputBucket,
      outputBucket: flags.outputBucket,
      checkpointBucket: flags.checkpointBucket,
      inputStorageRegion: flags.inputStorageRegion,
      outputStorageRegion: flags.outputStorageRegion,
      checkpointStorageRegion: flags.checkpointStorageRegion,
      availabilityZone: flags.availabilityZone,
    };

    return {
      cloudConfig,
      credentialName: credentialsName,
      inputStorageCredentialName: flags.inputStorageCredentials,
      outputStorageCredentialName: flags.outputStorageCredentials,
      checkpointStorageCredentialName: flags.checkpointStorageCredentials,
      gpuType: flags.gpuType,
    };
  }

  if (hasInlineCredentialEnv()) {
    // Build credentials from environment variables (inline, no server lookup).
    const credentials = getCredentialsFromEnv();

    const cloudConfig: WorkloadRequestCloudConfig = {
      cloudProvider: credentials.cloudProvider,
      // The environment holds keys only.
      credentials: extractCredentials(
        credentials,
      ) as WorkloadRequestCloudConfig['credentials'],
      region: flags.region,
      vmType: flags.vmType,
      spot: flags.spot,
      diskSizeGb: flags.diskSizeGb,
      diskTier,
      inputBucket: flags.inputBucket,
      outputBucket: flags.outputBucket,
      checkpointBucket: flags.checkpointBucket,
      inputStorageRegion: flags.inputStorageRegion,
      outputStorageRegion: flags.outputStorageRegion,
      checkpointStorageRegion: flags.checkpointStorageRegion,
      availabilityZone: flags.availabilityZone,
    };

    return {
      cloudConfig,
      inputStorageCredentialName: flags.inputStorageCredentials,
      outputStorageCredentialName: flags.outputStorageCredentials,
      checkpointStorageCredentialName: flags.checkpointStorageCredentials,
      gpuType: flags.gpuType,
    };
  }

  const cloudConfig: WorkloadRequestCloudConfig = {
    region: flags.region,
    vmType: flags.vmType,
    spot: flags.spot,
    diskSizeGb: flags.diskSizeGb,
    diskTier,
    inputBucket: flags.inputBucket,
    outputBucket: flags.outputBucket,
    checkpointBucket: flags.checkpointBucket,
    inputStorageRegion: flags.inputStorageRegion,
    outputStorageRegion: flags.outputStorageRegion,
    checkpointStorageRegion: flags.checkpointStorageRegion,
    availabilityZone: flags.availabilityZone,
  };

  return {
    cloudConfig,
    inputStorageCredentialName: flags.inputStorageCredentials,
    outputStorageCredentialName: flags.outputStorageCredentials,
    checkpointStorageCredentialName: flags.checkpointStorageCredentials,
    gpuType: flags.gpuType,
  };
}

export function hasInlineCredentialEnv(): boolean {
  return !!(
    process.env.ANYCLOUD_CLOUD_PROVIDER ||
    process.env.AWS_ACCESS_KEY_ID ||
    process.env.AZURE_APPLICATION_ID ||
    process.env.GCP_PROJECT_ID ||
    process.env.LAMBDA_API_KEY
  );
}

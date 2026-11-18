import { CloudType, type CloudCredentials } from '../../../shared/cloud.js';
import {
  credentialUpdateSchema,
  type CredentialUpdate,
} from '../../../shared/api-contract/credentials-schemas.js';
import { printInfo, printSuccess } from '../../utils/output.js';
import { safePrompts } from '../../utils/safe-prompts.js';
import {
  acquireCredentialsFromOptions as acquireCredentialsFromOptionsInternal,
  acquireCredentialsInteractive as acquireCredentialsInteractiveInternal,
  acquireAzureGeneratedCredentials as acquireAzureGeneratedCredentialsInternal,
  acquireGeneratedCredentials as acquireGeneratedCredentialsInternal,
  buildCredentialsFromOptions as buildCredentialsFromOptionsInternal,
  buildCredentialsInteractive as buildCredentialsInteractiveInternal,
  buildAzureGeneratedCredentials as buildAzureGeneratedCredentialsInternal,
  resolveCredentialName as resolveCredentialNameInternal,
  validateAzureGenerationSelection as validateAzureGenerationSelectionInternal,
  validateGenerationSelection as validateGenerationSelectionInternal,
  type NewCredentialsOptions,
} from './acquisition.js';
import type {
  AcquiredCredential,
  GeneratedCredentialLease,
} from './acquired-credential.js';
import {
  buildCredentialFromEnvironment as buildCredentialFromEnvironmentInternal,
  CredentialProviderNotDetectedError,
  MissingCredentialEnvironmentVariableError,
  type CredentialFields,
} from './credential-builders.js';
import { discoverCredentialSources as discoverCredentialSourcesInternal } from './discovery.js';
import {
  extractGCPCredentials,
  readServiceAccountKey,
} from './gcp-key-files.js';
import { validateAWSAccessCredentials } from './aws-validation.js';
import { verifyCloudflareToken } from '../../../shared/cloudflare-token.js';
import type { CredentialCandidate } from './types.js';

export type CredentialOnboardingOptions = NewCredentialsOptions;
export type CredentialAcquisition = AcquiredCredential;
export type CredentialLease = GeneratedCredentialLease;

export interface CredentialEditOptions extends CredentialFields {
  keyFile?: string;
}

interface AWSCredentialIdentity {
  account: string;
  arn: string;
}

export type CredentialEnvironmentError =
  | { kind: 'provider-not-detected' }
  | {
      kind: 'missing-variable';
      variableName: string;
      description: string;
    };

/**
 * Command-facing credential onboarding facade.
 *
 * Commands deliberately enter credential acquisition through this module so
 * provider CLI adapters, secret readers, builders, and bootstrap lifecycles
 * remain implementation details of the onboarding service.
 */
export function discoverCredentialSources(): Promise<CredentialCandidate[]> {
  return discoverCredentialSourcesInternal();
}

export function acquireCredentialsFromOptions(
  options: CredentialOnboardingOptions,
): Promise<CredentialAcquisition> {
  return acquireCredentialsFromOptionsInternal(options);
}

export function acquireCredentialsInteractive(
  credentialName: string,
  options: CredentialOnboardingOptions,
): Promise<CredentialAcquisition> {
  return acquireCredentialsInteractiveInternal(credentialName, options);
}

export function acquireAzureGeneratedCredentials(
  credentialName: string,
  options: CredentialOnboardingOptions,
): Promise<CredentialAcquisition> {
  return acquireAzureGeneratedCredentialsInternal(credentialName, options);
}

export function acquireGeneratedCredentials(
  credentialName: string,
  options: CredentialOnboardingOptions,
): Promise<CredentialAcquisition> {
  return acquireGeneratedCredentialsInternal(credentialName, options);
}

export function validateGenerationSelection(
  credentialName: string,
  options: CredentialOnboardingOptions,
): void {
  validateGenerationSelectionInternal(credentialName, options);
}

export function buildCredentialsFromOptions(
  options: CredentialOnboardingOptions,
): Promise<CloudCredentials> {
  return buildCredentialsFromOptionsInternal(options);
}

export function buildCredentialsInteractive(
  credentialName: string,
  options: CredentialOnboardingOptions,
): Promise<CloudCredentials> {
  return buildCredentialsInteractiveInternal(credentialName, options);
}

export function buildAzureGeneratedCredentials(
  credentialName: string,
  options: CredentialOnboardingOptions,
): Promise<CloudCredentials> {
  return buildAzureGeneratedCredentialsInternal(credentialName, options);
}

export function resolveCredentialName(
  name: string | undefined,
): Promise<string> {
  return resolveCredentialNameInternal(name);
}

export function validateAzureGenerationSelection(
  credentialName: string,
  options: CredentialOnboardingOptions,
): void {
  validateAzureGenerationSelectionInternal(credentialName, options);
}

async function validateAcquiredCredential(
  acquired: CredentialAcquisition,
): Promise<AWSCredentialIdentity | undefined> {
  const { credential, lease, metadata } = acquired;
  if (credential.cloudProvider === CloudType.Cloudflare) {
    await verifyCloudflareToken(credential);
    printSuccess('Cloudflare API token verified');
    return undefined;
  }
  if (
    credential.cloudProvider !== CloudType.AWS ||
    'kind' in credential ||
    lease !== undefined
  ) {
    return undefined;
  }

  const accessCredentials = {
    accessKeyId: credential.accessKeyId,
    secretAccessKey: credential.secretAccessKey,
    ...(credential.sessionToken
      ? { sessionToken: credential.sessionToken }
      : {}),
  };
  return metadata?.awsRegion
    ? validateAWSAccessCredentials(accessCredentials, metadata.awsRegion)
    : validateAWSAccessCredentials(accessCredentials);
}

function credentialImportReview(credential: CloudCredentials): {
  provider: string;
  fields: Array<[string, string]>;
} {
  // cloudtype-boundary-ok: Import reviews allowlist non-secret identity fields at the onboarding boundary.
  switch (credential.cloudProvider) {
    case CloudType.AWS:
      return { provider: 'AWS', fields: [] };
    case CloudType.Azure:
      return {
        provider: 'Azure',
        fields: [
          ['Tenant ID', credential.directoryId],
          ['Subscription ID', credential.subscriptionId],
          ['Application ID', credential.applicationId],
        ],
      };
    case CloudType.GCP:
      return {
        provider: 'GCP',
        fields:
          'kind' in credential
            ? [
                [
                  'Workload identity provider',
                  credential.workloadIdentityProvider,
                ],
                ['Service account', credential.serviceAccountEmail],
              ]
            : [
                ['Project ID', credential.projectId],
                ['Service account', credential.clientEmail],
              ],
      };
    case CloudType.Lambda:
      return { provider: 'Lambda Labs', fields: [] };
    case CloudType.Cloudflare:
      return {
        provider: 'Cloudflare',
        fields: [['Account ID', credential.accountId]],
      };
  }
}

/** Validate and approve an import before either local or API persistence. */
export async function approveCredentialSave(
  name: string,
  acquired: CredentialAcquisition,
): Promise<boolean> {
  const identity = await validateAcquiredCredential(acquired);
  const source = acquired.metadata?.importConfirmationSource;
  const review = credentialImportReview(acquired.credential);
  if (source) {
    printInfo(`Provider: ${review.provider}`);
    printInfo(`Credential name: ${name}`);
    printInfo(`Source: ${source}`);
    for (const [label, value] of review.fields) {
      printInfo(`${label}: ${value}`);
    }
    if (acquired.metadata?.awsRegion) {
      printInfo(`Region: ${acquired.metadata.awsRegion}`);
    }
  }
  if (identity) {
    printSuccess('AWS credentials authenticated');
    printInfo(`Account ID: ${identity.account}`);
    printInfo(`Identity: ${identity.arn}`);
  }
  if (!source) return true;

  const answer = await safePrompts<'confirmed'>({
    type: 'confirm',
    name: 'confirmed',
    message: `Save these ${review.provider} credentials as "${name}"?`,
    initial: true,
  });
  if (!answer.confirmed) return false;

  await acquired.afterImportApproval?.();
  return true;
}

/** The fields an edit changes; the API merges them into the stored credential. */
export async function credentialUpdateFields({
  keyFile,
  ...fields
}: CredentialEditOptions): Promise<CredentialUpdate> {
  const fromKey = keyFile
    ? extractGCPCredentials(await readServiceAccountKey(keyFile))
    : undefined;
  const parsed = credentialUpdateSchema.safeParse(
    fromKey
      ? {
          ...fields,
          projectId: fields.projectId ?? fromKey.projectId,
          clientEmail: fields.clientEmail ?? fromKey.clientEmail,
          privateKey: fromKey.privateKey,
        }
      : fields,
  );
  if (parsed.success) return parsed.data;
  throw new Error(
    parsed.error.issues
      .map((issue) => {
        const flag = `--${String(issue.path[0]).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
        if (issue.code === 'invalid_value') {
          const values = issue.values.map(String);
          return `${flag} must be ${values.slice(0, -1).join(', ')}, or ${values.at(-1)}`;
        }
        if (issue.code === 'too_small') return `${flag} must not be empty`;
        return `${flag}: ${issue.message}`;
      })
      .join('; '),
  );
}

export function buildCredentialFromEnvironment(
  provider: CloudType | undefined,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): CloudCredentials {
  return buildCredentialFromEnvironmentInternal(provider, environment);
}

export function credentialEnvironmentError(
  error: unknown,
): CredentialEnvironmentError | undefined {
  if (error instanceof CredentialProviderNotDetectedError) {
    return { kind: 'provider-not-detected' };
  }
  if (error instanceof MissingCredentialEnvironmentVariableError) {
    return {
      kind: 'missing-variable',
      variableName: error.variableName,
      description: error.description,
    };
  }
  return undefined;
}

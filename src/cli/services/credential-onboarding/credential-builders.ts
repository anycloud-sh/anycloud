import { cloudCredentialSchema } from '../../../shared/api-contract/credentials-schemas.js';
import {
  CLOUDFLARE_JURISDICTIONS,
  CloudType,
  type CloudCredentials,
} from '../../../shared/cloud.js';

export interface CredentialFields {
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  applicationId?: string;
  secret?: string;
  subscriptionId?: string;
  directoryId?: string;
  projectId?: string;
  clientEmail?: string;
  privateKey?: string;
  billingExportDataset?: string;
  apiKey?: string;
  accountId?: string;
  apiToken?: string;
  jurisdiction?: string;
}

type CredentialEnvironment = Readonly<Record<string, string | undefined>>;

export class MissingCredentialEnvironmentVariableError extends Error {
  constructor(
    readonly variableName: string,
    readonly description: string,
  ) {
    super(`${description} required`);
    this.name = 'MissingCredentialEnvironmentVariableError';
  }
}

export class CredentialProviderNotDetectedError extends Error {
  constructor() {
    super('Could not auto-detect a credential provider');
    this.name = 'CredentialProviderNotDetectedError';
  }
}

class UnsupportedCredentialProviderError extends Error {
  constructor(readonly provider: CloudType) {
    super(`Unsupported credential provider: ${provider}`);
    this.name = 'UnsupportedCredentialProviderError';
  }
}

function parseCredential(candidate: unknown): CloudCredentials {
  // cloud.ts cannot derive its type from this schema without a module cycle,
  // so the CLI validates at runtime before crossing back to the legacy type.
  return cloudCredentialSchema.parse(candidate) as CloudCredentials;
}

export function buildCredentialFromFields(
  provider: CloudType,
  fields: CredentialFields,
): CloudCredentials {
  // cloudtype-boundary-ok: Canonical credential construction owns provider-specific persisted shapes.
  switch (provider) {
    case CloudType.AWS:
      return parseCredential({
        cloudProvider: CloudType.AWS,
        accessKeyId: fields.accessKeyId,
        secretAccessKey: fields.secretAccessKey,
        ...(fields.sessionToken !== undefined
          ? { sessionToken: fields.sessionToken }
          : {}),
      });
    case CloudType.Azure:
      return parseCredential({
        cloudProvider: CloudType.Azure,
        applicationId: fields.applicationId,
        secret: fields.secret,
        subscriptionId: fields.subscriptionId,
        directoryId: fields.directoryId,
      });
    // cloudtype-boundary-ok: Canonical credential construction owns provider-specific persisted shapes.
    case CloudType.GCP:
      return parseCredential({
        cloudProvider: CloudType.GCP,
        projectId: fields.projectId,
        clientEmail: fields.clientEmail,
        privateKey: fields.privateKey,
        ...(fields.billingExportDataset !== undefined
          ? { billingExportDataset: fields.billingExportDataset }
          : {}),
      });
    // cloudtype-boundary-ok: Canonical credential construction owns provider-specific persisted shapes.
    case CloudType.Lambda:
      return parseCredential({
        cloudProvider: CloudType.Lambda,
        apiKey: fields.apiKey,
      });
    case CloudType.Cloudflare:
      if (
        fields.jurisdiction !== undefined &&
        !(CLOUDFLARE_JURISDICTIONS as readonly string[]).includes(
          fields.jurisdiction,
        )
      ) {
        throw new Error('--jurisdiction must be default, eu, or fedramp');
      }
      return parseCredential({
        cloudProvider: CloudType.Cloudflare,
        accountId: fields.accountId,
        apiToken: fields.apiToken,
        ...(fields.jurisdiction !== undefined
          ? { jurisdiction: fields.jurisdiction }
          : {}),
      });
    case CloudType.Local:
      throw new UnsupportedCredentialProviderError(provider);
  }
}

function requireEnvironmentValue(
  environment: CredentialEnvironment,
  variableName: string,
  description: string,
): string {
  const value = environment[variableName];
  if (!value) {
    throw new MissingCredentialEnvironmentVariableError(
      variableName,
      description,
    );
  }
  return value;
}

function detectCredentialProvider(
  environment: CredentialEnvironment,
): CloudType {
  // cloudtype-boundary-ok: Environment auto-detection preserves the documented provider precedence.
  if (environment.AWS_ACCESS_KEY_ID && environment.AWS_SECRET_ACCESS_KEY) {
    return CloudType.AWS;
  }
  if (
    environment.AZURE_APPLICATION_ID &&
    environment.AZURE_SECRET &&
    environment.AZURE_SUBSCRIPTION_ID &&
    environment.AZURE_DIRECTORY_ID
  ) {
    return CloudType.Azure;
  }
  if (
    environment.GCP_PROJECT_ID &&
    environment.GCP_CLIENT_EMAIL &&
    environment.GCP_PRIVATE_KEY
  ) {
    // cloudtype-boundary-ok: Environment auto-detection preserves the documented provider precedence.
    return CloudType.GCP;
  }
  // cloudtype-boundary-ok: Environment auto-detection preserves the documented provider precedence.
  if (environment.LAMBDA_API_KEY) return CloudType.Lambda;
  throw new CredentialProviderNotDetectedError();
}

export function buildCredentialFromEnvironment(
  provider: CloudType | undefined,
  environment: CredentialEnvironment = process.env,
): CloudCredentials {
  const resolvedProvider = provider ?? detectCredentialProvider(environment);

  // cloudtype-boundary-ok: Environment acquisition maps into the canonical provider fields.
  switch (resolvedProvider) {
    case CloudType.AWS:
      return buildCredentialFromFields(resolvedProvider, {
        accessKeyId: requireEnvironmentValue(
          environment,
          'AWS_ACCESS_KEY_ID',
          'AWS Access Key ID',
        ),
        secretAccessKey: requireEnvironmentValue(
          environment,
          'AWS_SECRET_ACCESS_KEY',
          'AWS Secret Access Key',
        ),
        // AWS_SESSION_TOKEN is intentionally excluded: persisted onboarding
        // credentials must be durable.
      });
    // cloudtype-boundary-ok: Environment acquisition maps into the canonical provider fields.
    case CloudType.Azure:
      return buildCredentialFromFields(resolvedProvider, {
        applicationId: requireEnvironmentValue(
          environment,
          'AZURE_APPLICATION_ID',
          'Azure Application ID',
        ),
        secret: requireEnvironmentValue(
          environment,
          'AZURE_SECRET',
          'Azure Secret',
        ),
        subscriptionId: requireEnvironmentValue(
          environment,
          'AZURE_SUBSCRIPTION_ID',
          'Azure Subscription ID',
        ),
        directoryId: requireEnvironmentValue(
          environment,
          'AZURE_DIRECTORY_ID',
          'Azure Directory ID',
        ),
      });
    // cloudtype-boundary-ok: Environment acquisition maps into the canonical provider fields.
    case CloudType.GCP:
      return buildCredentialFromFields(resolvedProvider, {
        projectId: requireEnvironmentValue(
          environment,
          'GCP_PROJECT_ID',
          'GCP Project ID',
        ),
        clientEmail: requireEnvironmentValue(
          environment,
          'GCP_CLIENT_EMAIL',
          'GCP Client Email',
        ),
        privateKey: requireEnvironmentValue(
          environment,
          'GCP_PRIVATE_KEY',
          'GCP Private Key',
        ),
      });
    // cloudtype-boundary-ok: Environment acquisition maps into the canonical provider fields.
    case CloudType.Lambda:
      return buildCredentialFromFields(resolvedProvider, {
        apiKey: requireEnvironmentValue(
          environment,
          'LAMBDA_API_KEY',
          'Lambda Labs API Key',
        ),
      });
    // cloudtype-boundary-ok: Unsupported providers are rejected at the credential-construction boundary.
    // Cloudflare is storage-only, so no compute command builds it from the
    // environment, and auto-detection never picks it.
    case CloudType.Cloudflare:
    case CloudType.Local:
      throw new UnsupportedCredentialProviderError(resolvedProvider);
  }
}

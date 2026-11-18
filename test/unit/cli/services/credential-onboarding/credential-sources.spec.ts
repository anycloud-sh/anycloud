import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudType } from '../../../../../src/shared/cloud.js';

const aws = vi.hoisted(() => ({
  listSummaries: vi.fn(),
  resolveProfile: vi.fn(),
}));

const gcp = vi.hoisted(() => ({
  getADCPath: vi.fn(),
  getAllKeyPaths: vi.fn(),
  readSummary: vi.fn(),
  readCredentials: vi.fn(),
}));

vi.mock('../../../../../src/cli/services/slurp/aws.js', () => ({
  listImportableAWSProfileSummaries: aws.listSummaries,
  resolveAWSProfileSource: aws.resolveProfile,
}));

vi.mock('../../../../../src/cli/services/slurp/gcp.js', () => ({
  getADCPath: gcp.getADCPath,
  getAllServiceAccountKeyPaths: gcp.getAllKeyPaths,
}));

vi.mock(
  '../../../../../src/cli/services/credential-onboarding/gcp-key-files.js',
  () => ({
    readServiceAccountKeySummary: gcp.readSummary,
    readServiceAccountKey: gcp.readCredentials,
    extractGCPCredentials: (credentials: unknown) => credentials,
  }),
);

import { discoverCredentialSources } from '../../../../../src/cli/services/credential-onboarding/discovery.js';
import {
  CredentialSourceMaterializationError,
  materializeCredential,
} from '../../../../../src/cli/services/credential-onboarding/materialization.js';

const forbiddenCandidateProperties = new Set([
  'apiKey',
  'privateKey',
  'secret',
  'secretAccessKey',
  'sessionToken',
]);

function candidateSecretProperties(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(candidateSecretProperties);
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => [
    ...(forbiddenCandidateProperties.has(key) ? [key] : []),
    ...candidateSecretProperties(child),
  ]);
}

describe('local credential sources', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    aws.listSummaries.mockResolvedValue([
      { profileName: 'production', accessKeyId: 'AKIA-PRODUCTION' },
    ]);
    gcp.getADCPath.mockReturnValue('/keys/gcp.json');
    gcp.getAllKeyPaths.mockResolvedValue(['/keys/gcp.json']);
    gcp.readSummary.mockResolvedValue({
      projectId: 'gcp-project',
      clientEmail: 'service@gcp-project.iam.gserviceaccount.com',
    });
  });

  it('discovers only redacted AWS and GCP candidate metadata', async () => {
    const candidates = await discoverCredentialSources();

    expect(candidates).toEqual([
      {
        id: 'aws-profile:production',
        kind: 'aws-profile',
        provider: CloudType.AWS,
        profileName: 'production',
        source: 'aws profile: production',
        identity: 'Access Key: AKIA-PRODUCTION',
      },
      {
        id: 'gcp-key-file:%2Fkeys%2Fgcp.json',
        kind: 'gcp-key-file',
        provider: CloudType.GCP,
        keyPath: '/keys/gcp.json',
        source: 'gcloud ADC',
        status: 'available',
        identity:
          'Project: gcp-project\nEmail: service@gcp-project.iam.gserviceaccount.com',
      },
    ]);
    expect(candidateSecretProperties(candidates)).toEqual([]);
    expect(JSON.stringify(candidates)).not.toContain('AWS-SECRET-MATERIAL');
    expect(JSON.stringify(candidates)).not.toContain('GCP-PRIVATE-KEY');
    expect(aws.resolveProfile).not.toHaveBeenCalled();
    expect(gcp.readCredentials).not.toHaveBeenCalled();
  });

  it('does not expose a GCP metadata-reader error', async () => {
    gcp.readSummary.mockRejectedValue(
      new Error('parse failed near GCP-PRIVATE-KEY'),
    );

    const candidates = await discoverCredentialSources({
      provider: CloudType.GCP,
    });

    expect(candidates).toEqual([
      expect.objectContaining({
        status: 'invalid',
        identity: 'Invalid or unsupported service-account key',
      }),
    ]);
    expect(JSON.stringify(candidates)).not.toContain('GCP-PRIVATE-KEY');
    expect(aws.listSummaries).not.toHaveBeenCalled();
  });

  it('materializes an AWS profile only after selection', async () => {
    aws.resolveProfile.mockResolvedValue({
      kind: 'static',
      credentials: {
        profileName: 'production',
        accessKeyId: 'AKIA-PRODUCTION',
        secretAccessKey: 'AWS-SECRET-MATERIAL',
        region: 'us-gov-west-1',
      },
    });
    const [candidate] = await discoverCredentialSources({
      provider: CloudType.AWS,
    });

    await expect(materializeCredential(candidate)).resolves.toEqual({
      credential: {
        cloudProvider: CloudType.AWS,
        accessKeyId: 'AKIA-PRODUCTION',
        secretAccessKey: 'AWS-SECRET-MATERIAL',
      },
      metadata: { awsRegion: 'us-gov-west-1' },
    });
    expect(aws.resolveProfile).toHaveBeenCalledWith('production');
  });

  it('materializes a GCP key only after selection', async () => {
    gcp.readCredentials.mockResolvedValue({
      projectId: 'gcp-project',
      clientEmail: 'service@gcp-project.iam.gserviceaccount.com',
      privateKey: 'GCP-PRIVATE-KEY',
    });
    const [candidate] = await discoverCredentialSources({
      provider: CloudType.GCP,
    });

    await expect(materializeCredential(candidate)).resolves.toEqual({
      credential: {
        cloudProvider: CloudType.GCP,
        projectId: 'gcp-project',
        clientEmail: 'service@gcp-project.iam.gserviceaccount.com',
        privateKey: 'GCP-PRIVATE-KEY',
      },
    });
    expect(gcp.readCredentials).toHaveBeenCalledWith('/keys/gcp.json');
  });

  it('keeps a selected AWS profile disappearance distinguishable', async () => {
    aws.resolveProfile.mockResolvedValue({
      kind: 'missing',
      profileName: 'production',
    });
    const [candidate] = await discoverCredentialSources({
      provider: CloudType.AWS,
    });

    const error = await materializeCredential(candidate).catch(
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(CredentialSourceMaterializationError);
    expect(error).toMatchObject({ reason: 'missing' });
    expect((error as Error).message).toContain(
      'Available static profiles: production',
    );
  });
});

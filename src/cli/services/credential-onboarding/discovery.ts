import { basename } from 'path';
import { CloudType } from '../../../shared/cloud.js';
import { listImportableAWSProfileSummaries } from '../slurp/aws.js';
import { getADCPath, getAllServiceAccountKeyPaths } from '../slurp/gcp.js';
import { readServiceAccountKeySummary } from './gcp-key-files.js';
import type {
  AWSCredentialCandidate,
  CredentialCandidate,
  DiscoverableCredentialProvider,
  GCPCredentialCandidate,
} from './types.js';

function candidateId(kind: CredentialCandidate['kind'], value: string): string {
  return `${kind}:${encodeURIComponent(value)}`;
}

async function discoverAWSCredentialSources(): Promise<
  AWSCredentialCandidate[]
> {
  const profiles = await listImportableAWSProfileSummaries();
  // cloudtype-boundary-ok: The discovery adapter creates redacted provider-specific candidate descriptors.
  return profiles.map(({ profileName, accessKeyId }) => ({
    id: candidateId('aws-profile', profileName),
    kind: 'aws-profile',
    provider: CloudType.AWS,
    profileName,
    source: `aws profile: ${profileName}`,
    identity: `Access Key: ${accessKeyId}`,
  }));
}

async function discoverGCPCredentialSources(): Promise<
  GCPCredentialCandidate[]
> {
  const keyPaths = await getAllServiceAccountKeyPaths();
  const adcPath = getADCPath();

  return Promise.all(
    keyPaths.map(async (keyPath): Promise<GCPCredentialCandidate> => {
      const source =
        keyPath === adcPath
          ? process.env.GOOGLE_APPLICATION_CREDENTIALS
            ? '$GOOGLE_APPLICATION_CREDENTIALS'
            : 'gcloud ADC'
          : `anycloud key: ${basename(keyPath)}`;
      try {
        const summary = await readServiceAccountKeySummary(keyPath);
        // cloudtype-boundary-ok: The discovery adapter creates redacted provider-specific candidate descriptors.
        return {
          id: candidateId('gcp-key-file', keyPath),
          kind: 'gcp-key-file',
          provider: CloudType.GCP,
          keyPath,
          source,
          status: 'available',
          identity: `Project: ${summary.projectId}\nEmail: ${summary.clientEmail}`,
        };
      } catch {
        // cloudtype-boundary-ok: Invalid GCP files remain redacted GCP candidates so list and new share inventory.
        return {
          id: candidateId('gcp-key-file', keyPath),
          kind: 'gcp-key-file',
          provider: CloudType.GCP,
          keyPath,
          source,
          status: 'invalid',
          identity: 'Invalid or unsupported service-account key',
        };
      }
    }),
  );
}

export async function discoverCredentialSources(options?: {
  provider?: DiscoverableCredentialProvider;
}): Promise<CredentialCandidate[]> {
  // cloudtype-boundary-ok: Local credential discovery is intentionally limited to AWS profiles and GCP key files.
  if (options?.provider === CloudType.AWS) {
    return discoverAWSCredentialSources();
  }
  if (options?.provider === CloudType.GCP) {
    return discoverGCPCredentialSources();
  }

  const [aws, gcp] = await Promise.all([
    discoverAWSCredentialSources().catch(() => []),
    discoverGCPCredentialSources(),
  ]);
  return [...aws, ...gcp];
}

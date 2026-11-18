import { CloudType } from '../../../shared/cloud.js';
import {
  acquiredCredential,
  type AcquiredCredential,
} from './acquired-credential.js';
import { buildCredentialFromFields } from './credential-builders.js';
import { discoverCredentialSources } from './discovery.js';
import type { CredentialCandidate } from './types.js';
import { resolveAWSProfileSource } from '../slurp/aws.js';
import {
  extractGCPCredentials,
  readServiceAccountKey,
} from './gcp-key-files.js';

type MaterializationFailure =
  | 'missing'
  | 'incomplete'
  | 'temporary'
  | 'non-static';

export class CredentialSourceMaterializationError extends Error {
  constructor(
    readonly reason: MaterializationFailure,
    message: string,
  ) {
    super(message);
    this.name = 'CredentialSourceMaterializationError';
  }
}

export async function materializeAWSProfile(
  profileName: string,
): Promise<AcquiredCredential> {
  const source = await resolveAWSProfileSource(profileName);
  if (source.kind === 'missing') {
    // cloudtype-boundary-ok: AWS profile materialization reuses the redacted AWS discovery inventory for guidance.
    const available = await discoverCredentialSources({
      provider: CloudType.AWS,
    });
    const availableNames = available.flatMap((candidate) =>
      candidate.kind === 'aws-profile' ? [candidate.profileName] : [],
    );
    const suffix =
      availableNames.length === 0
        ? ''
        : ` Available static profiles: ${availableNames.join(', ')}.`;
    throw new CredentialSourceMaterializationError(
      'missing',
      `AWS profile "${profileName}" was not found.${suffix}`,
    );
  }
  if (source.kind === 'incomplete') {
    throw new CredentialSourceMaterializationError(
      'incomplete',
      `AWS profile "${profileName}" is incomplete; missing ${source.missing.join(' and ')}.`,
    );
  }
  if (source.kind === 'temporary') {
    throw new CredentialSourceMaterializationError(
      'temporary',
      `AWS profile "${profileName}" contains temporary session credentials, which cannot be saved because they expire. ` +
        'Use a durable static profile or enter long-lived access keys.',
    );
  }
  if (source.kind === 'non-static') {
    throw new CredentialSourceMaterializationError(
      'non-static',
      `AWS profile "${profileName}" does not contain durable access keys and cannot be imported. ` +
        'Use a durable static profile or enter long-lived access keys.',
    );
  }

  // cloudtype-boundary-ok: Local materialization converts a selected AWS source into the canonical credential shape.
  return acquiredCredential(
    buildCredentialFromFields(CloudType.AWS, {
      accessKeyId: source.credentials.accessKeyId,
      secretAccessKey: source.credentials.secretAccessKey,
    }),
    source.credentials.region
      ? { awsRegion: source.credentials.region }
      : undefined,
  );
}

export async function materializeCredential(
  candidate: CredentialCandidate,
): Promise<AcquiredCredential> {
  // cloudtype-boundary-ok: Materialization dispatches the two supported local credential-source kinds.
  switch (candidate.kind) {
    case 'aws-profile':
      return materializeAWSProfile(candidate.profileName);
    case 'gcp-key-file': {
      const fields = extractGCPCredentials(
        await readServiceAccountKey(candidate.keyPath),
      );
      return acquiredCredential(
        buildCredentialFromFields(CloudType.GCP, fields),
      );
    }
  }
}

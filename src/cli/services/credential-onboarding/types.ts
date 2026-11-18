import { CloudType } from '../../../shared/cloud.js';

// cloudtype-boundary-ok: Credential-source types model the two providers with local discovery surfaces.
export type DiscoverableCredentialProvider = CloudType.AWS | CloudType.GCP;

interface CredentialCandidateBase {
  id: string;
  provider: DiscoverableCredentialProvider;
  source: string;
  identity: string;
}

export interface AWSCredentialCandidate extends CredentialCandidateBase {
  kind: 'aws-profile';
  provider: CloudType.AWS;
  profileName: string;
}

// cloudtype-boundary-ok: Candidate discriminants keep AWS profiles and GCP key files type-safe without carrying secrets.
export interface GCPCredentialCandidate extends CredentialCandidateBase {
  kind: 'gcp-key-file';
  provider: CloudType.GCP;
  keyPath: string;
  status: 'available' | 'invalid';
}

export type CredentialCandidate =
  | AWSCredentialCandidate
  | GCPCredentialCandidate;

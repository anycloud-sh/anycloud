import type { RedactedCredential } from '../../../shared/api-contract/credentials-schemas.js';
import { CloudType, type CloudCredentials } from '../../../shared/cloud.js';

export interface CredentialAcquisitionMetadata {
  awsRegion?: string;
  /** A wizard-selected import must be reviewed before it is saved. */
  importConfirmationSource?: string;
}

export interface AcquiredCredential<
  TCredential extends CloudCredentials = CloudCredentials,
> {
  credential: TCredential;
  metadata?: CredentialAcquisitionMetadata;
  /** Persist a prepared local import only after the user approves its review. */
  afterImportApproval?: () => Promise<void>;
  lease?: GeneratedCredentialLease<TCredential>;
}

type GeneratedCredentialLeaseState =
  | 'pending'
  | 'committed'
  | 'rolling-back'
  | 'rolled-back'
  | 'rollback-failed'
  | 'retained';

export interface GeneratedCredentialLease<
  TCredential extends CloudCredentials = CloudCredentials,
> {
  readonly credential: TCredential;
  readonly identityDescription: string;
  readonly retainedResourcesAfterCleanup?: string;
  readonly state: GeneratedCredentialLeaseState;
  matchesStored(stored: RedactedCredential): boolean;
  commit(): void;
  rollback(): Promise<void>;
  retainForReconciliation(): void;
}

export function acquiredCredential<
  TCredential extends CloudCredentials = CloudCredentials,
>(
  credential: TCredential,
  metadata?: CredentialAcquisitionMetadata,
): AcquiredCredential<TCredential> {
  return metadata ? { credential, metadata } : { credential };
}

function isSameStoredCredential(
  stored: RedactedCredential,
  credential: CloudCredentials,
): boolean {
  if (stored.cloudProvider !== credential.cloudProvider) return false;
  // cloudtype-boundary-ok: Credential reconciliation compares each provider's redacted identity fields.
  switch (credential.cloudProvider) {
    case CloudType.AWS:
      return (
        stored.cloudProvider === CloudType.AWS &&
        ('kind' in credential
          ? stored.roleArn === credential.roleArn
          : stored.accessKeyId === credential.accessKeyId)
      );
    case CloudType.Azure:
      return (
        stored.cloudProvider === CloudType.Azure &&
        stored.applicationId === credential.applicationId &&
        stored.subscriptionId === credential.subscriptionId
      );
    case CloudType.GCP:
      // cloudtype-boundary-ok: Secret-only providers deliberately cannot reconcile from redacted API fields.
      // A redacted GCP credential cannot distinguish two keys for the same
      // service account, so a lost response is not safe to call successful.
      return false;
    case CloudType.Lambda:
    case CloudType.Cloudflare:
      // A redacted API key or token likewise cannot distinguish two keys.
      return false;
  }
}

export function generatedCredential<
  TCredential extends CloudCredentials = CloudCredentials,
>(
  credential: TCredential,
  cleanup: (() => Promise<void>) | undefined,
  options: {
    identityDescription?: string;
    retainedResourcesAfterCleanup?: string;
  } = {},
): AcquiredCredential<TCredential> {
  let state: GeneratedCredentialLeaseState = 'pending';
  let rollbackPromise: Promise<void> | undefined;

  const lease: GeneratedCredentialLease<TCredential> = {
    credential,
    identityDescription:
      options.identityDescription ?? `${credential.cloudProvider} identity`,
    retainedResourcesAfterCleanup: options.retainedResourcesAfterCleanup,
    get state() {
      return state;
    },
    matchesStored(stored) {
      return isSameStoredCredential(stored, credential);
    },
    commit() {
      if (state === 'pending') state = 'committed';
    },
    rollback() {
      if (rollbackPromise) return rollbackPromise;
      if (state !== 'pending') return Promise.resolve();

      state = 'rolling-back';
      rollbackPromise = (async () => {
        try {
          await cleanup?.();
          state = 'rolled-back';
        } catch (error) {
          state = 'rollback-failed';
          throw error;
        }
      })();
      return rollbackPromise;
    },
    retainForReconciliation() {
      if (state === 'pending') state = 'retained';
    },
  };

  return { credential, lease };
}

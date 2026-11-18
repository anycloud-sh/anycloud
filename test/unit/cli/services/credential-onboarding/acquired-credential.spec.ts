import { describe, expect, it, vi } from 'vitest';
import {
  acquiredCredential,
  generatedCredential,
} from '../../../../../src/cli/services/credential-onboarding/acquired-credential.js';
import { CloudType } from '../../../../../src/shared/cloud.js';

describe('acquired credentials', () => {
  it('carries imported AWS validation metadata independently of object identity', () => {
    const acquired = acquiredCredential(
      {
        cloudProvider: CloudType.AWS,
        accessKeyId: 'AKIA-IMPORTED',
        secretAccessKey: 'imported-secret',
      },
      { awsRegion: 'us-gov-west-1' },
    );
    const rebuilt = {
      ...acquired,
      credential: { ...acquired.credential },
    };

    expect(rebuilt.metadata?.awsRegion).toBe('us-gov-west-1');
  });

  it('rolls a generated identity back exactly once across concurrent calls', async () => {
    let finishCleanup: (() => void) | undefined;
    const cleanup = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishCleanup = resolve;
        }),
    );
    const { lease } = generatedCredential(
      {
        cloudProvider: CloudType.AWS,
        accessKeyId: 'AKIA-GENERATED',
        secretAccessKey: 'generated-secret',
      },
      cleanup,
    );

    const first = lease!.rollback();
    const second = lease!.rollback();
    expect(second).toBe(first);
    expect(cleanup).toHaveBeenCalledOnce();
    finishCleanup?.();
    await Promise.all([first, second]);

    expect(lease?.state).toBe('rolled-back');
  });

  it('caches a rollback failure instead of retrying cleanup', async () => {
    const cleanupError = new Error('cleanup denied');
    const cleanup = vi.fn().mockRejectedValue(cleanupError);
    const { lease } = generatedCredential(
      {
        cloudProvider: CloudType.Azure,
        applicationId: 'generated-application',
        secret: 'generated-secret',
        subscriptionId: 'generated-subscription',
        directoryId: 'generated-directory',
      },
      cleanup,
    );

    const first = lease!.rollback();
    await expect(first).rejects.toBe(cleanupError);
    await expect(lease!.rollback()).rejects.toBe(cleanupError);

    expect(cleanup).toHaveBeenCalledOnce();
    expect(lease?.state).toBe('rollback-failed');
  });

  it.each([
    [
      'commit',
      (lease: NonNullable<ReturnType<typeof generatedCredential>['lease']>) =>
        lease.commit(),
      'committed',
    ],
    [
      'retention',
      (lease: NonNullable<ReturnType<typeof generatedCredential>['lease']>) =>
        lease.retainForReconciliation(),
      'retained',
    ],
  ] as const)(
    'makes %s terminal and prevents later cleanup',
    async (_label, finish, expectedState) => {
      const cleanup = vi.fn().mockResolvedValue(undefined);
      const { lease } = generatedCredential(
        {
          cloudProvider: CloudType.GCP,
          projectId: 'generated-project',
          clientEmail: 'generated@generated-project.iam.gserviceaccount.com',
          privateKey: 'generated-private-key',
        },
        cleanup,
      );

      finish(lease!);
      finish(lease!);
      await lease!.rollback();

      expect(cleanup).not.toHaveBeenCalled();
      expect(lease?.state).toBe(expectedState);
    },
  );

  it('matches only identities that redacted API data can prove exactly', () => {
    const aws = generatedCredential(
      {
        cloudProvider: CloudType.AWS,
        accessKeyId: 'AKIA-EXACT',
        secretAccessKey: 'generated-secret',
      },
      undefined,
    );
    const azure = generatedCredential(
      {
        cloudProvider: CloudType.Azure,
        applicationId: 'exact-application',
        secret: 'generated-secret',
        subscriptionId: 'exact-subscription',
        directoryId: 'generated-directory',
      },
      undefined,
    );
    const gcp = generatedCredential(
      {
        cloudProvider: CloudType.GCP,
        projectId: 'same-project',
        clientEmail: 'same@same-project.iam.gserviceaccount.com',
        privateKey: 'unobservable-key',
      },
      undefined,
    );

    expect(
      aws.lease?.matchesStored({
        name: 'stored',
        cloudProvider: CloudType.AWS,
        accessKeyId: 'AKIA-EXACT',
      }),
    ).toBe(true);
    expect(
      azure.lease?.matchesStored({
        name: 'stored',
        cloudProvider: CloudType.Azure,
        applicationId: 'exact-application',
        subscriptionId: 'exact-subscription',
      }),
    ).toBe(true);
    expect(
      gcp.lease?.matchesStored({
        name: 'stored',
        cloudProvider: CloudType.GCP,
        projectId: 'same-project',
        clientEmail: 'same@same-project.iam.gserviceaccount.com',
      }),
    ).toBe(false);
  });
});

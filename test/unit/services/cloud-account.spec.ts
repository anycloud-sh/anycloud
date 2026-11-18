import { describe, expect, it } from 'vitest';
import { cloudAccount } from '../../../src/api/services/cloud-account.js';
import { CloudType } from '../../../src/shared/cloud.js';

const sts = async (key: { accessKeyId: string }) =>
  key.accessKeyId === 'AKIA1' ? '111122223333' : 'wrong';

const role = { issuer: 'i', audience: 'a', subject: 's' } as const;

describe('cloudAccount', () => {
  it.each([
    [
      'an AWS key, as STS reports it',
      {
        cloudProvider: CloudType.AWS,
        accessKeyId: 'AKIA1',
        secretAccessKey: 'secret',
      },
      '111122223333',
    ],
    [
      'an AWS role, from its ARN',
      {
        cloudProvider: CloudType.AWS,
        kind: 'role',
        roleArn: 'arn:aws:iam::444455556666:role/anycloud',
        ...role,
      },
      '444455556666',
    ],
    [
      'a GCP key, its project',
      {
        cloudProvider: CloudType.GCP,
        projectId: 'my-project',
        privateKey: 'k',
        clientEmail: 'sa@my-project.iam.gserviceaccount.com',
      },
      'my-project',
    ],
    [
      'a GCP role, the project its service account belongs to',
      {
        cloudProvider: CloudType.GCP,
        kind: 'role',
        workloadIdentityProvider: 'projects/1/locations/global/x',
        serviceAccountEmail: 'anycloud@other-project.iam.gserviceaccount.com',
        ...role,
      },
      'other-project',
    ],
    [
      'an Azure key, its subscription',
      {
        cloudProvider: CloudType.Azure,
        applicationId: 'app',
        secret: 's',
        directoryId: 'dir',
        subscriptionId: 'sub-1',
      },
      'sub-1',
    ],
    [
      'an Azure role, its subscription',
      {
        cloudProvider: CloudType.Azure,
        kind: 'role',
        applicationId: 'app',
        directoryId: 'dir',
        subscriptionId: 'sub-2',
        ...role,
      },
      'sub-2',
    ],
    [
      'a Lambda key, none',
      { cloudProvider: CloudType.Lambda, apiKey: 'k' },
      null,
    ],
  ] as const)('reads %s', async (_name, credentials, expected) => {
    await expect(cloudAccount(credentials, sts)).resolves.toBe(expected);
  });

  it('refuses a role whose identifier names no account', async () => {
    await expect(
      cloudAccount(
        {
          cloudProvider: CloudType.AWS,
          kind: 'role',
          roleArn: 'arn:aws:iam::bad:role/x',
          ...role,
        },
        sts,
      ),
    ).rejects.toThrow('No AWS account');
  });
});

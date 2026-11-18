import { describe, expect, it } from 'vitest';
import { selectOutputStorageValidationTargets } from '../../../src/api/services/workload-admission-plan';
import { CloudType } from '../../../src/shared/cloud.js';

describe('selectOutputStorageValidationTargets', () => {
  it('collapses one GCP credential spread across many regions', () => {
    const targets = [
      {
        name: 'gcp-test',
        config: {
          cloudProvider: CloudType.GCP,
          region: 'us-central1',
          credentials: {
            projectId: 'project-a',
            privateKey: 'test-private-key',
            clientEmail: 'svc@project-a.iam.gserviceaccount.com',
          },
        },
      },
      {
        name: 'gcp-test',
        config: {
          cloudProvider: CloudType.GCP,
          region: 'us-west1',
          credentials: {
            projectId: 'project-a',
            privateKey: 'test-private-key',
            clientEmail: 'svc@project-a.iam.gserviceaccount.com',
          },
        },
      },
    ];

    expect(selectOutputStorageValidationTargets(targets)).toEqual([targets[0]]);
  });

  it('keeps distinct GCP storage identities', () => {
    const targets = [
      {
        name: 'gcp-a',
        config: {
          cloudProvider: CloudType.GCP,
          region: 'us-central1',
          credentials: {
            projectId: 'project-a',
            privateKey: 'test-private-key',
            clientEmail: 'svc@project-a.iam.gserviceaccount.com',
          },
        },
      },
      {
        name: 'gcp-b',
        config: {
          cloudProvider: CloudType.GCP,
          region: 'us-central1',
          credentials: {
            projectId: 'project-b',
            privateKey: 'test-private-key',
            clientEmail: 'svc@project-b.iam.gserviceaccount.com',
          },
        },
      },
    ];

    expect(selectOutputStorageValidationTargets(targets)).toEqual(targets);
  });

  it('collapses one AWS account even when target names differ', () => {
    const targets = [
      {
        name: 'aws-east',
        config: {
          cloudProvider: CloudType.AWS,
          region: 'us-east-1',
          credentials: {
            accessKeyId: 'AKIA-SAME',
            secretAccessKey: 'test-secret',
          },
        },
      },
      {
        name: 'aws-west',
        config: {
          cloudProvider: CloudType.AWS,
          region: 'us-west-2',
          credentials: {
            accessKeyId: 'AKIA-SAME',
            secretAccessKey: 'test-secret',
          },
        },
      },
    ];

    expect(selectOutputStorageValidationTargets(targets)).toEqual([targets[0]]);
  });
});

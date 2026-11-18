/**
 * AWS Sad Path Integration Test
 *
 * Tests failure scenarios: verifies that when VM creation fails (e.g., due to
 * invalid config or quota), the workload errors with the right kind and no VM
 * is leaked. The security group is shared (anycloud-vm), so it is NOT torn down
 * on a failed workload's rollback — it must survive for reuse.
 *
 * Requirements:
 * - AWS credentials in environment (from .env.aws):
 *   - AWS_ACCESS_KEY_ID
 *   - AWS_SECRET_ACCESS_KEY
 *
 * Run with:
 *   source .env.aws && yarn test test/integration/aws-sad.spec.ts
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { completeCloudConfig } from '../../src/shared/cloud-config.js';
import {
  AWS,
  AWS_SHARED_VM_SG_NAME,
} from '../../src/api/services/gateways/aws';
import { CloudConfig, CloudType } from '../../src/shared/cloud.js';
import { ensureVMTerminated } from './aws-test-utils';
import { DescribeSecurityGroupsCommand } from '@aws-sdk/client-ec2';
import { errorText } from './helpers/external-errors';

describe('AWS sad path integration', () => {
  beforeAll(() => {
    // Fail hard if AWS credentials are not configured
    if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
      throw new Error(
        'AWS credentials not found in environment. Please set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY',
      );
    }
  });
  const region = 'us-east-1';
  const availabilityZone = undefined;
  const testConfig: CloudConfig = {
    cloudProvider: CloudType.AWS,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
    region,
    availabilityZone,
    vmType: 't2.small',
  };

  it('should clean up resources when VM creation fails due to invalid VM type', async () => {
    const timestamp = Date.now();
    const vmId = `cleanup-test-${timestamp}`;
    const workloadId = `fw-${vmId}`;

    // Create AWS instance with INVALID VM type to force failure
    const invalidConfig: CloudConfig = {
      ...testConfig,
      vmType: 'INVALID_VM_TYPE_DOES_NOT_EXIST',
    };
    const awsInvalid = new AWS(completeCloudConfig(invalidConfig));

    // Ensure the shared security group exists (newVM attaches it at launch).
    await awsInvalid.compute().upsertFirewall([], workloadId, '0.0.0-test', '');

    // Verify the shared SG exists (named anycloud-vm, not per-workload).
    const sgData = await awsInvalid.ec2client.send(
      new DescribeSecurityGroupsCommand({
        GroupNames: [AWS_SHARED_VM_SG_NAME],
      }),
    );
    expect(sgData.SecurityGroups?.[0]?.GroupName).toBe(AWS_SHARED_VM_SG_NAME);

    // Attempt VM creation - should fail due to invalid VM type
    try {
      await awsInvalid.compute().newVM({
        startupScript: '#!/bin/bash\necho test',
        ipWhitelist: [],
        vmId,
        workloadId,
        version: '0.0.0-test',
        userId: '',
      });
      expect.fail('VM creation should have failed with invalid VM type');
    } catch (error) {
      // Verify it's an invalid instance type error, not some other error
      const errorStr = errorText(error);
      console.log('AWS error string:', errorStr);
      const normalizedError = errorStr.toLowerCase();
      const isExpectedError =
        normalizedError.includes('invalidparametervalue') ||
        normalizedError.includes('invalid instance') ||
        normalizedError.includes('invalidinstance') ||
        normalizedError.includes('not supported') ||
        normalizedError.includes('unsupported') ||
        normalizedError.includes('invalid_vm_type');
      if (!isExpectedError) {
        console.error(
          'Unexpected AWS error (not matching known invalid VM type patterns):',
          errorStr,
        );
      }
      expect(isExpectedError).toBe(true);

      // Simulate vm-provisioner rollback. The SG is shared, so this is a no-op
      // for it (no per-workload SG named workloadId exists) — and must not
      // throw or delete the shared SG.
      await awsInvalid.compute().terminateNetworking(workloadId);
    }

    // Verify VM was never created (or cleaned up)
    const aws = new AWS(completeCloudConfig(testConfig));
    await ensureVMTerminated(aws, vmId);

    // The shared SG must survive the failed workload's rollback (reused).
    const sharedSg = await aws.ec2client.send(
      new DescribeSecurityGroupsCommand({
        GroupNames: [AWS_SHARED_VM_SG_NAME],
      }),
    );
    expect(sharedSg.SecurityGroups?.[0]?.GroupName).toBe(AWS_SHARED_VM_SG_NAME);
  }, 600000); // 10 minute timeout (allows for retry delays and cleanup)
});

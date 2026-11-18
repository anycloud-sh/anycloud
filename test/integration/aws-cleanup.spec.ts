/**
 * AWS Cleanup Integration Test
 *
 * Tests the account resource sweep for AWS.
 *
 * NOTE: This test is for local development/verification only.
 * NOT included in CI - CI uses ci/cleanup/aws.ts in pre/post cleanup jobs instead.
 *
 * Requirements:
 * - AWS credentials in environment (from .env.aws):
 *   - AWS_ACCESS_KEY_ID
 *   - AWS_SECRET_ACCESS_KEY
 *
 * Run with:
 *   source .env.aws && yarn test test/integration/aws-cleanup.spec.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { completeCloudConfig } from '../../src/shared/cloud-config.js';
import {
  AWS,
  AWS_SHARED_VM_SG_NAME,
} from '../../src/api/services/gateways/aws';
import { CloudConfig, CloudType } from '../../src/shared/cloud.js';
import {
  DescribeInstancesCommand,
  DescribeSecurityGroupsCommand,
  DescribeVpcsCommand,
  CreateSecurityGroupCommand,
  CreateTagsCommand,
} from '@aws-sdk/client-ec2';
import { TEST_RESOURCE_SWEEP_OPTIONS } from '../helpers/resource-sweep-policy';

describe('AWS resource sweep integration', () => {
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

  beforeAll(async () => {
    // Fail hard if AWS credentials are not configured
    if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
      throw new Error(
        'AWS credentials not found in environment. Please set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY',
      );
    }

    // Cleanup orphaned resources before tests
    console.log('Running pre-test cleanup...');
    const aws = new AWS(completeCloudConfig(testConfig));
    const result = await aws
      .sweeper()
      .sweepResources(TEST_RESOURCE_SWEEP_OPTIONS);
    console.log(
      `Pre-test cleanup: removed ${result.vmIds.length} VMs, ${result.otherResources.length} other resources`,
    );
  }, 300000); // 5 minute timeout for cleanup

  afterAll(async () => {
    // Cleanup orphaned resources after tests (runs even on failure/cancellation)
    console.log('Running post-test cleanup...');
    const aws = new AWS(completeCloudConfig(testConfig));
    const result = await aws
      .sweeper()
      .sweepResources(TEST_RESOURCE_SWEEP_OPTIONS);
    console.log(
      `Post-test cleanup: removed ${result.vmIds.length} VMs, ${result.otherResources.length} other resources`,
    );
  }, 300000); // 5 minute timeout for cleanup

  it('cleans up a VM with an ended_at tag and leaves the shared SG intact', async () => {
    const timestamp = Date.now();
    const vmId = `cleanup-ended-${timestamp}`;
    const workloadId = `cleanup-fw-${timestamp}`;

    const aws = new AWS(completeCloudConfig(testConfig));

    // Ensure the shared SG exists and create a VM that attaches it.
    await aws
      .compute()
      .upsertFirewall([], workloadId, '0.0.0-test', 'anycloud-test');
    const vm = await aws.compute().newVM({
      startupScript: '#!/bin/bash\necho "cleanup test"',
      ipWhitelist: [],
      vmId,
      workloadId,
      version: '0.0.0-test',
      userId: 'anycloud-test',
    });

    // Mark the VM orphaned with an ended_at tag.
    await aws.ec2client.send(
      new CreateTagsCommand({
        Resources: [vm.cloudId],
        Tags: [{ Key: 'anycloud_ended_at', Value: Date.now().toString() }],
      }),
    );

    // Run cleanup
    const result = await aws
      .sweeper()
      .sweepResources(TEST_RESOURCE_SWEEP_OPTIONS);

    expect(result.vmIds).toContain(vm.cloudId);
    const ourVmError = result.errors.find((e) => e.resourceId === vm.cloudId);
    expect(ourVmError).toBeUndefined();

    // Verify VM was deleted
    const vmsData = await aws.ec2client.send(
      new DescribeInstancesCommand({
        InstanceIds: [vm.cloudId],
      }),
    );
    const instances = vmsData.Reservations?.flatMap((r) => r.Instances) || [];
    // Instance should be terminated (state code 48) or shutting down (state code 32)
    expect(instances[0]?.State?.Code).toBeGreaterThanOrEqual(32);

    // The shared SG carries no anycloud_deployment tag, so it must survive.
    const sharedSg = await aws.ec2client.send(
      new DescribeSecurityGroupsCommand({
        GroupNames: [AWS_SHARED_VM_SG_NAME],
      }),
    );
    expect(sharedSg.SecurityGroups?.[0]?.GroupName).toBe(AWS_SHARED_VM_SG_NAME);
  }, 600000); // 10 min timeout

  it('reaps a legacy per-workload SG but never the shared one', async () => {
    const timestamp = Date.now();
    const workloadId = `cleanup-legacy-${timestamp}`;

    const aws = new AWS(completeCloudConfig(testConfig));

    // Ensure the shared SG exists (it must survive cleanup).
    await aws
      .compute()
      .upsertFirewall([], workloadId, '0.0.0-test', 'anycloud-test');

    // Create a legacy-shaped per-workload SG directly (an orphan from the old
    // per-workload design): named by workloadId, tagged anycloud_deployment
    // + anycloud_ended_at. Cleanup must reap it.
    const vpcs = await aws.ec2client.send(new DescribeVpcsCommand({}));
    const vpcId = (vpcs.Vpcs?.find((v) => v.IsDefault) ?? vpcs.Vpcs?.[0])
      ?.VpcId;
    const legacy = await aws.ec2client.send(
      new CreateSecurityGroupCommand({
        Description: 'legacy per-workload sg',
        GroupName: workloadId,
        VpcId: vpcId,
        TagSpecifications: [
          {
            ResourceType: 'security-group',
            Tags: [
              { Key: 'anycloud_deployment', Value: workloadId },
              { Key: 'anycloud_ended_at', Value: Date.now().toString() },
            ],
          },
        ],
      }),
    );
    const legacyId = legacy.GroupId!;

    const result = await aws
      .sweeper()
      .sweepResources(TEST_RESOURCE_SWEEP_OPTIONS);

    // Legacy per-workload SG was reaped...
    expect(
      result.otherResources.some(
        (r) => r.type === 'securityGroup' && r.id === legacyId,
      ),
    ).toBe(true);
    const remainingLegacy = await aws.ec2client.send(
      new DescribeSecurityGroupsCommand({
        Filters: [{ Name: 'group-name', Values: [workloadId] }],
      }),
    );
    expect(remainingLegacy.SecurityGroups ?? []).toHaveLength(0);

    // ...but the shared SG survived.
    const sharedSg = await aws.ec2client.send(
      new DescribeSecurityGroupsCommand({
        GroupNames: [AWS_SHARED_VM_SG_NAME],
      }),
    );
    expect(sharedSg.SecurityGroups?.[0]?.GroupName).toBe(AWS_SHARED_VM_SG_NAME);
  }, 600000); // 10 min timeout

  it('should cleanup test resources (empty userId)', async () => {
    const timestamp = Date.now();
    const vmId = `cleanup-test-${timestamp}`;
    const workloadId = `cleanup-test-fw-${timestamp}`;

    const aws = new AWS(completeCloudConfig(testConfig));

    // Create resources with userId=''
    await aws.compute().upsertFirewall([], workloadId, '0.0.0-test', '');
    const vm = await aws.compute().newVM({
      startupScript: '#!/bin/bash\necho "test resource"',
      ipWhitelist: [],
      vmId,
      workloadId,
      version: '0.0.0-test',
      userId: '',
    });

    // Run cleanup
    const result = await aws
      .sweeper()
      .sweepResources(TEST_RESOURCE_SWEEP_OPTIONS);

    expect(result.vmIds).toContain(vm.cloudId);
    // Only check that our specific resources didn't error
    const ourVmError = result.errors.find((e) => e.resourceId === vm.cloudId);
    expect(ourVmError).toBeUndefined();

    // Verify VM was deleted
    const vmsData = await aws.ec2client.send(
      new DescribeInstancesCommand({
        InstanceIds: [vm.cloudId],
      }),
    );
    const instances = vmsData.Reservations?.flatMap((r) => r.Instances) || [];
    expect(instances[0]?.State?.Code).toBeGreaterThanOrEqual(32); // Terminated or shutting down
  }, 600000); // 10 min timeout

  it('should not delete active resources', async () => {
    const timestamp = Date.now();
    const vmId = `cleanup-active-${timestamp}`;
    const workloadId = `cleanup-active-fw-${timestamp}`;

    const aws = new AWS(completeCloudConfig(testConfig));

    // Create resources without ended_at tag and with real userId
    await aws
      .compute()
      .upsertFirewall([], workloadId, '0.0.0-test', 'real-user');
    const vm = await aws.compute().newVM({
      startupScript: '#!/bin/bash\necho "active resource"',
      ipWhitelist: [],
      vmId,
      workloadId,
      version: '0.0.0-test',
      userId: 'real-user',
    });

    // Run cleanup
    const result = await aws
      .sweeper()
      .sweepResources(TEST_RESOURCE_SWEEP_OPTIONS);

    // Should not include our VM
    expect(result.vmIds).not.toContain(vm.cloudId);

    // Verify VM still exists and is running
    const vmsData = await aws.ec2client.send(
      new DescribeInstancesCommand({
        InstanceIds: [vm.cloudId],
      }),
    );
    const instances = vmsData.Reservations?.flatMap((r) => r.Instances) || [];
    expect(instances).toHaveLength(1);
    expect(instances[0]?.InstanceId).toBe(vm.cloudId);
    // State should be running (16) or pending (0)
    expect(instances[0]?.State?.Code).toBeLessThan(32);

    // Cleanup after test
    await aws.compute().terminateVMs([vm.cloudId]);
    await aws.compute().terminateNetworking(workloadId);
  }, 600000); // 10 min timeout

  it('should support dry run', async () => {
    const timestamp = Date.now();
    const vmId = `cleanup-dryrun-${timestamp}`;
    const workloadId = `cleanup-dryrun-fw-${timestamp}`;

    const aws = new AWS(completeCloudConfig(testConfig));

    // Create resources with ended_at tag
    await aws
      .compute()
      .upsertFirewall([], workloadId, '0.0.0-test', 'anycloud-test');
    const vm = await aws.compute().newVM({
      startupScript: '#!/bin/bash\necho "dryrun test"',
      ipWhitelist: [],
      vmId,
      workloadId,
      version: '0.0.0-test',
      userId: 'anycloud-test',
    });

    // Tag with ended_at
    await aws.ec2client.send(
      new CreateTagsCommand({
        Resources: [vm.cloudId],
        Tags: [
          {
            Key: 'anycloud_ended_at',
            Value: Date.now().toString(),
          },
        ],
      }),
    );

    // Dry run
    const dryResult = await aws.sweeper().sweepResources({
      ...TEST_RESOURCE_SWEEP_OPTIONS,
      dryRun: true,
    });
    expect(dryResult.vmIds).toContain(vm.cloudId);

    // Verify VM NOT deleted (still exists)
    let vmsData = await aws.ec2client.send(
      new DescribeInstancesCommand({
        InstanceIds: [vm.cloudId],
      }),
    );
    let instances = vmsData.Reservations?.flatMap((r) => r.Instances) || [];
    expect(instances).toHaveLength(1);
    expect(instances[0]?.State?.Code).toBeLessThan(32); // Still running

    // Actual cleanup
    const result = await aws
      .sweeper()
      .sweepResources(TEST_RESOURCE_SWEEP_OPTIONS);
    expect(result.vmIds).toContain(vm.cloudId);

    // Verify VM was deleted this time
    vmsData = await aws.ec2client.send(
      new DescribeInstancesCommand({
        InstanceIds: [vm.cloudId],
      }),
    );
    instances = vmsData.Reservations?.flatMap((r) => r.Instances) || [];
    expect(instances[0]?.State?.Code).toBeGreaterThanOrEqual(32); // Terminated or shutting down
  }, 600000); // 10 min timeout
});

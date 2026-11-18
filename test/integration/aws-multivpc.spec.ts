/**
 * AWS Multi-VPC Provisioning Integration Test
 *
 * Regression for the reported AWS provisioning failure:
 *   "Security group sg-... and subnet subnet-... belong to different networks."
 *
 * Root cause: the security group was created in DescribeVpcs's first VPC, but
 * newVM launches with no SubnetId so AWS auto-selects a subnet from the account's
 * DEFAULT VPC. On a multi-VPC account where a non-default VPC sorts first, the SG
 * and the auto-selected subnet land in different VPCs.
 *
 * This test reproduces the multi-VPC condition on a real account (by creating a
 * throwaway, bare, non-default VPC) and asserts the invariant the fix guarantees:
 * the shared and resource-scoped (cluster/node pool) security groups are created
 * in the DEFAULT VPC, and a scoped VM launches there with its group attached.
 *
 * DescribeVpcs order is not controllable, so a green run does not prove the
 * throwaway VPC was listed first; the deterministic guard is the unit spec. The
 * throwaway VPC stays bare (everything lands in the default VPC). It is deleted
 * once both groups are placed, before the VM launch, with a finally block as
 * the backstop; ci/cleanup/aws.ts reclaims one that a cancelled or timed-out
 * run leaks.
 *
 * NOTE: local development / CI verification. Requires AWS credentials:
 *   - AWS_ACCESS_KEY_ID
 *   - AWS_SECRET_ACCESS_KEY
 *
 * Run with:
 *   source .env.aws && yarn test test/integration/aws-multivpc.spec.ts
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { completeCloudConfig } from '../../src/shared/cloud-config.js';
import {
  AWS,
  AWS_SHARED_VM_SG_NAME,
} from '../../src/api/services/gateways/aws';
import { canManageCloudResources } from '../../src/api/services/gateways/cloud.js';
import { createCloudResourceScope } from '../../src/api/services/cloud-resource-scope.js';
import { TEST_USERNAMES } from '../../src/api/services/test-identity.js';
import { CloudConfig, CloudType } from '../../src/shared/cloud.js';
import {
  CreateVpcCommand,
  DeleteVpcCommand,
  DescribeInstancesCommand,
  DescribeVpcsCommand,
  DescribeSecurityGroupsCommand,
  TerminateInstancesCommand,
} from '@aws-sdk/client-ec2';

describe('AWS multi-VPC provisioning', () => {
  const testConfig: CloudConfig = {
    cloudProvider: CloudType.AWS,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
    region: 'us-east-1',
    availabilityZone: undefined,
    vmType: 't2.small',
  };

  beforeAll(() => {
    if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
      throw new Error(
        'AWS credentials not found in environment. Please set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY',
      );
    }
  });

  it('places shared and scoped SGs in the default VPC and launches a scoped VM there', async () => {
    const aws = new AWS(completeCloudConfig(testConfig));

    // The account must have a default VPC for this scenario (and for any
    // subnet-less RunInstances launch) to be meaningful.
    const vpcs = await aws.ec2client.send(new DescribeVpcsCommand({}));
    const defaultVpcId = vpcs.Vpcs?.find((v) => v.IsDefault)?.VpcId;
    expect(defaultVpcId).toBeDefined();

    let throwawayVpcId: string | undefined;
    const deleteThrowawayVpc = async () => {
      const VpcId = throwawayVpcId;
      throwawayVpcId = undefined;
      if (VpcId) await aws.ec2client.send(new DeleteVpcCommand({ VpcId }));
    };
    try {
      // Make the account multi-VPC: a bare, throwaway, NON-default VPC.
      // AWS allows overlapping CIDRs across VPCs, so a fixed block is fine.
      const created = await aws.ec2client.send(
        new CreateVpcCommand({
          CidrBlock: '10.250.0.0/16',
          TagSpecifications: [
            {
              ResourceType: 'vpc',
              // ci/cleanup/aws.ts sweeps leaked VPCs by these two tags.
              Tags: [
                { Key: 'anycloud_test_throwaway', Value: 'multivpc' },
                {
                  Key: 'anycloud_test_created_at',
                  Value: new Date().toISOString(),
                },
              ],
            },
          ],
        }),
      );
      throwawayVpcId = created.Vpc?.VpcId;
      expect(throwawayVpcId).toBeDefined();

      // The fix: the shared SG must land in the DEFAULT VPC, not the throwaway
      // non-default one — otherwise the instance (which launches into the
      // default VPC's auto-selected subnet) would fail with "belong to
      // different networks".
      const sgId = await aws.ensureSharedSecurityGroup();
      const sg = await aws.ec2client.send(
        new DescribeSecurityGroupsCommand({ GroupIds: [sgId] }),
      );
      const sgVpcId = sg.SecurityGroups?.[0]?.VpcId;
      expect(sg.SecurityGroups?.[0]?.GroupName).toBe(AWS_SHARED_VM_SG_NAME);
      expect(sgVpcId).toBe(defaultVpcId);
      expect(sgVpcId).not.toBe(throwawayVpcId);

      const listed = await aws.ec2client.send(new DescribeVpcsCommand({}));
      console.log(
        `DescribeVpcs listed the default VPC first: ${listed.Vpcs?.[0]?.VpcId === defaultVpcId}`,
      );

      // The cluster/node pool path: a scoped SG and a VM launched with it.
      // The test user tag keeps any leak reclaimable by the CI sweeper.
      const compute = aws.compute();
      if (!canManageCloudResources(compute))
        throw new Error('AWS compute lacks resource-scoped operations');
      const scope = createCloudResourceScope(`multivpc-${Date.now()}`, {
        anycloud_user: TEST_USERNAMES[0],
      });
      const noIngress = { ingress: [] };
      try {
        const network = await compute.prepareResourceNetwork(
          noIngress,
          scope,
          '0.0.0-test',
        );
        const scopedSgId = network?.securityGroupId;
        const scopedSg = await aws.ec2client.send(
          new DescribeSecurityGroupsCommand({ GroupIds: [scopedSgId!] }),
        );
        expect(scopedSg.SecurityGroups?.[0]?.VpcId).toBe(defaultVpcId);

        // Both groups are placed. The launch needs no second VPC: it uses the
        // scoped group, and RunInstances with no subnet uses the default VPC.
        // Deleting now keeps a cancelled or timed-out run from leaking it.
        await deleteThrowawayVpc();

        const vm = await compute.newResourceVM({
          scope,
          vmId: scope.id,
          ipWhitelist: [],
          startupScript: '#!/bin/bash\ntrue',
          gpuRuntime: null,
          version: '0.0.0-test',
          network,
          ingressSpec: noIngress,
        });
        const described = await aws.ec2client.send(
          new DescribeInstancesCommand({ InstanceIds: [vm.cloudId] }),
        );
        const instance = described.Reservations?.[0]?.Instances?.[0];
        expect(instance?.VpcId).toBe(defaultVpcId);
        expect(instance?.SecurityGroups?.map((g) => g.GroupId)).toContain(
          scopedSgId,
        );
      } finally {
        try {
          // Find the VM by Name tag: a launch that fails after RunInstances
          // never returns its id.
          const leftovers = await aws.ec2client.send(
            new DescribeInstancesCommand({
              Filters: [{ Name: 'tag:Name', Values: [scope.id] }],
            }),
          );
          const ids = (leftovers.Reservations ?? [])
            .flatMap((r) => r.Instances ?? [])
            .filter((i) => i.State?.Name !== 'terminated')
            .map((i) => i.InstanceId!);
          if (ids.length > 0) {
            await aws.ec2client.send(
              new TerminateInstancesCommand({ InstanceIds: ids }),
            );
          }
        } finally {
          // Retries the delete for up to 5 min while the VM's ENI detaches.
          await compute.terminateResourceNetwork(scope);
        }
      }
    } finally {
      // Backstop for a failure before the early delete. The VPC is bare
      // (every SG lives in the default VPC), so nothing blocks DeleteVpc.
      await deleteThrowawayVpc();
    }
  }, 600000); // launch, termination, and up to 5 min of SG deletion retries
});

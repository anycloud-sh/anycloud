/**
 * Shared test utilities for AWS integration tests
 */
import { expect } from 'vitest';
import { AWS } from '../../src/api/services/gateways/aws';
import { DescribeInstancesCommand } from '@aws-sdk/client-ec2';
import { retryUntil } from '../../src/shared/utils';

/**
 * Helper to verify VM and associated resources are deleted.
 * Polls until VM reaches terminated state.
 */
export async function ensureVMTerminated(aws: AWS, vmId: string) {
  await retryUntil(
    async () => {
      // Query by Name tag - AWS returns empty if not found, doesn't throw
      const data = await aws.ec2client.send(
        new DescribeInstancesCommand({
          Filters: [
            {
              Name: 'tag:Name',
              Values: [vmId],
            },
          ],
        }),
      );

      // Check if any non-terminated instances exist
      const instances =
        data.Reservations?.flatMap((r) => r.Instances ?? []) || [];
      const nonTerminatedInstances = instances.filter(
        (i) => i.State?.Code !== 48,
      );

      // Return state information for condition check
      return {
        isTerminated: nonTerminatedInstances.length === 0,
        currentState: nonTerminatedInstances[0]?.State?.Name,
      };
    },
    (result) => {
      // If not terminated and in unexpected state, fail immediately
      if (!result.isTerminated && result.currentState !== 'shutting-down') {
        expect.fail(
          `VM should be terminated but found in state: ${result.currentState}`,
        );
      }
      return result.isTerminated;
    },
    'VM termination',
    { maxAttempts: 24, waitMs: 5000 }, // 2 minutes total (24 * 5s)
  );
}

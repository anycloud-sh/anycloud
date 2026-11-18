#!/usr/bin/env node
/**
 * Cleanup orphaned AWS resources
 *
 * This script is called by CI before and after AWS integration test suites
 * to clean up any orphaned resources from previous failed test runs.
 *
 * Usage: CIPHER_KEY=$(openssl rand -hex 32) npx tsx ci/cleanup/aws.ts
 *        (add --multivpc-vpcs to run only the multi-VPC test VPC pass)
 */

import {
  EC2Client,
  DeleteVpcCommand,
  DescribeRegionsCommand,
  DescribeVpcsCommand,
} from '@aws-sdk/client-ec2';
import { completeCloudConfig } from '../../src/shared/cloud-config.js';
import { AWS } from '../../src/api/services/gateways/aws';
import { CloudConfig, CloudType } from '../../src/shared/cloud.js';
import { CI_RESOURCE_SWEEP_POLICY } from './policy';
import { runCloudCleanup } from './runner';

async function main() {
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    console.error(
      'AWS credentials not found in environment. Please set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY',
    );
    process.exit(1);
  }

  const sessionToken = process.env.AWS_SESSION_TOKEN;
  const credentials = {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    ...(sessionToken ? { sessionToken } : {}),
  };

  const mkConfig = (region: string): CloudConfig => ({
    cloudProvider: CloudType.AWS,
    credentials,
    region,
    vmType: 't2.micro',
  });

  const ec2 = new EC2Client({ credentials, region: 'us-east-1' });

  // Reclaim throwaway VPCs that aws-multivpc.spec.ts leaked. DeleteVpc refuses
  // a non-empty VPC; any EC2 error is logged and the cleanup continues.
  const { Vpcs = [] } = await ec2
    .send(
      new DescribeVpcsCommand({
        Filters: [
          { Name: 'tag:anycloud_test_throwaway', Values: ['multivpc'] },
        ],
      }),
    )
    .catch((e) => {
      console.warn(`Could not list multi-VPC test VPCs: ${e}`);
      return { Vpcs: [] };
    });
  for (const { VpcId, Tags } of Vpcs) {
    const createdAt = Tags?.find((t) => t.Key === 'anycloud_test_created_at');
    // Untagged ones predate the created-at tag.
    if (createdAt && Date.now() - Date.parse(createdAt.Value!) < 30 * 60_000)
      continue;
    await ec2
      .send(new DeleteVpcCommand({ VpcId }))
      .then(() => console.log(`Deleted stale multi-VPC test VPC ${VpcId}`))
      .catch((e) => console.warn(`Could not delete VPC ${VpcId}: ${e}`));
  }
  if (process.argv.includes('--multivpc-vpcs')) return;

  // Discover all enabled regions in the account (one API call)
  console.log('Discovering enabled AWS regions...');
  const regionsResp = await ec2.send(new DescribeRegionsCommand({}));
  const regions = (regionsResp.Regions ?? [])
    .map((r) => r.RegionName!)
    .filter(Boolean);
  console.log(`Found ${regions.length} enabled regions`);

  await runCloudCleanup({
    cloud: 'AWS',
    units: regions,
    cleanupUnit: async (region) => {
      const aws = new AWS(completeCloudConfig(mkConfig(region)));
      const result = await aws.sweeper().sweepResources({
        policy: CI_RESOURCE_SWEEP_POLICY,
      });
      return result;
    },
    // S3 buckets are account-global; run their cleanup once, not per region.
    // Route through a us-east-1 client because ListBuckets is region-agnostic
    // and us-east-1 is always available.
    accountWide: {
      label: 'bucket',
      run: () =>
        new AWS(completeCloudConfig(mkConfig('us-east-1'))).sweeper()
          .sweepStorage!({
          policy: CI_RESOURCE_SWEEP_POLICY,
        }),
    },
  });
}

main().catch((error) => {
  console.error('Cleanup failed:', error);
  process.exit(1);
});

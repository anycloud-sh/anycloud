/**
 * AWS per-VM cost calculator.
 *
 * Uses plain GetCostAndUsage with a tag filter over a batch of owners,
 * grouped by that tag. We get one number per owner per day — the aggregate
 * tagged spend — and split it across the owner's VMs proportionally by
 * VM-hour share. For single-VM
 * workloads that's exact (the aggregate IS the VM's cost). For multi-VM
 * workloads it's an approximation, but Cost Explorer can't tell us which
 * volume/IP belongs to which EC2 instance anyway (the resource-level API
 * returns vol-XXX and i-YYY as siblings, not with parent/child linkage), so
 * we can't do meaningfully better without a separate DescribeVolumes round
 * trip per VM.
 *
 * Customer setup (documented in changelog): IAM ce:GetCostAndUsage + active
 * cost-allocation tag anycloud_deployment. No resource-level data opt-in
 * needed.
 */

import {
  type CostExplorerClient,
  GetCostAndUsageCommand,
} from '@aws-sdk/client-cost-explorer';
import { log } from '../logger.js';
import type { VmNeedingCost } from '../repositories/billing.js';
import type { AWSCreds, AWSRoleCreds } from '../../../shared/cloud.js';
import type { VmCostIdentity, VmCostMap, VmCostResource } from './contracts.js';
import {
  awsClientCredentials,
  createAwsCostExplorerClient,
} from '../provider-clients/aws.js';

// Cost Explorer is a global service but the endpoint lives in us-east-1.
const COST_EXPLORER_REGION = 'us-east-1';

export async function calculateAwsVmCosts(
  cloudConfig: VmCostIdentity,
  resource: VmCostResource,
  groups: VmNeedingCost[][],
): Promise<VmCostMap> {
  const creds = cloudConfig.credentials as AWSCreds | AWSRoleCreds;
  const vms = groups.flat();
  const client: CostExplorerClient = createAwsCostExplorerClient(
    awsClientCredentials(creds),
    {
      region: COST_EXPLORER_REGION,
      maxAttempts: 5,
    },
  );

  const earliestCreated = Math.min(...vms.map((v) => v.created_at));
  const latestEnded = Math.max(...vms.map((v) => v.ended_at));
  const start = formatDate(earliestCreated);
  // End is exclusive; pad one day past the latest ended_at so partial-day
  // usage is captured even when the VM ended late in the UTC day.
  const end = formatDate(latestEnded + 24 * 60 * 60 * 1000);

  if (start >= end) {
    return new Map();
  }

  const command = new GetCostAndUsageCommand({
    TimePeriod: { Start: start, End: end },
    Granularity: 'DAILY',
    Metrics: ['UnblendedCost'],
    Filter: {
      Tags: {
        Key: resource.tag,
        Values: resource.ids,
        MatchOptions: ['EQUALS'],
      },
    },
    GroupBy: [{ Type: 'TAG', Key: resource.tag }],
  });

  // Sum each owner's tagged spend within its own days, because an owner id
  // also tags earlier attempts' spend; group keys are `<tag>$<owner id>`.
  const spans = new Map(
    groups.map((group) => [
      group[0].resource_id,
      {
        start: formatDate(Math.min(...group.map((v) => v.created_at))),
        end: formatDate(
          Math.max(...group.map((v) => v.ended_at)) + 24 * 60 * 60 * 1000,
        ),
      },
    ]),
  );
  const totals = new Map<string, number>();
  let nextPageToken: string | undefined;
  do {
    if (nextPageToken) command.input.NextPageToken = nextPageToken;
    const response = await client.send(command);
    for (const day of response.ResultsByTime ?? []) {
      for (const group of day.Groups ?? []) {
        const owner = group.Keys?.[0]?.slice(resource.tag.length + 1) ?? '';
        const amount = parseFloat(group.Metrics?.UnblendedCost?.Amount ?? '');
        const span = spans.get(owner);
        const date = day.TimePeriod?.Start ?? '';
        const outside = !span || date < span.start || date >= span.end;
        if (outside || Number.isNaN(amount)) continue;
        totals.set(owner, (totals.get(owner) ?? 0) + amount);
      }
    }
    nextPageToken = response.NextPageToken;
  } while (nextPageToken);

  // Split each owner's total across its VMs proportionally by VM-hour share.
  // Exact for single-VM workloads; an approximation otherwise.
  const result: VmCostMap = new Map();
  for (const group of groups) {
    const totalCost = totals.get(group[0].resource_id) ?? 0;
    const totalDurationMs = group.reduce(
      (s, v) => s + Math.max(0, v.ended_at - v.created_at),
      0,
    );
    if (totalCost <= 0 || totalDurationMs <= 0) continue;
    for (const vm of group) {
      const share = Math.max(0, vm.ended_at - vm.created_at) / totalDurationMs;
      result.set(vm.cloud_id, totalCost * share);
    }
  }

  log.info('AWS cost calculation complete', {
    id: resource.ids[0],
    groups: resource.ids.length,
    vmsRequested: vms.length,
    vmsCalculated: result.size,
  });

  return result;
}

function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

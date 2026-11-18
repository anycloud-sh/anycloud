/**
 * Azure per-VM cost calculator.
 *
 * Uses Cost Management's Query API with subscription scope, filtering by
 * the batch's owner tag values and grouping by ResourceId. The SDK returns
 * only the first page, so later pages are fetched from `nextLink`. The service principal
 * needs the built-in "Cost Management Reader" role on the subscription —
 * added to the setup flow.
 */

import { createPipelineRequest } from '@azure/core-rest-pipeline';
import type { QueryDefinition } from '@azure/arm-costmanagement';
import { log } from '../logger.js';
import { armClientOptions } from '../azure-client-options.js';
import type { VmNeedingCost } from '../repositories/billing.js';
import { AzureConnectionCreds } from '../../../shared/cloud.js';
import type { VmCostIdentity, VmCostMap, VmCostResource } from './contracts.js';
import {
  createAzureCredential,
  createAzureCostManagementClient,
} from '../provider-clients/azure.js';

export async function calculateAzureVmCosts(
  cloudConfig: VmCostIdentity,
  resource: VmCostResource,
  vms: VmNeedingCost[],
): Promise<VmCostMap> {
  const creds = cloudConfig.credentials as AzureConnectionCreds;
  const credential = createAzureCredential(creds);
  const client = createAzureCostManagementClient(
    credential,
    armClientOptions(),
  );

  const earliestCreated = Math.min(...vms.map((v) => v.created_at));
  const latestEnded = Math.max(...vms.map((v) => v.ended_at));

  const scope = `/subscriptions/${creds.subscriptionId}`;
  const query: QueryDefinition = {
    type: 'ActualCost',
    timeframe: 'Custom',
    timePeriod: {
      from: new Date(earliestCreated),
      to: new Date(latestEnded + 24 * 60 * 60 * 1000),
    },
    dataset: {
      granularity: 'None',
      aggregation: {
        totalCost: { name: 'Cost', function: 'Sum' },
      },
      grouping: [{ type: 'Dimension', name: 'ResourceId' }],
      filter: {
        tags: { name: resource.tag, operator: 'In', values: resource.ids },
      },
    },
  };
  const response = await client.query.usage(scope, query);
  const rows = [...(response.rows ?? [])];
  for (let next = response.nextLink; next; ) {
    const request = createPipelineRequest({
      url: next,
      method: 'POST',
      body: JSON.stringify(query),
    });
    request.headers.set('Content-Type', 'application/json');
    const page = await client.sendRequest(request);
    if (page.status !== 200) {
      throw Object.assign(
        new Error(`Cost query page failed with ${page.status}`),
        // Headers only: the request would expose its Authorization header.
        { statusCode: page.status, response: { headers: page.headers } },
      );
    }
    const { properties } = JSON.parse(page.bodyAsText ?? '{}');
    rows.push(...(properties?.rows ?? []));
    next = properties?.nextLink;
  }

  // Azure returns rows as ordered arrays paired with a `columns` schema —
  // resolve the indices once, then walk rows.
  const columns = response.columns ?? [];
  const costIdx = columns.findIndex(
    (c) =>
      c.name?.toLowerCase() === 'cost' || c.name?.toLowerCase() === 'costusd',
  );
  const resourceIdx = columns.findIndex(
    (c) => c.name?.toLowerCase() === 'resourceid',
  );
  const result: VmCostMap = new Map();
  if (costIdx < 0 || resourceIdx < 0) {
    log.warn('Azure cost response missing expected columns', {
      id: resource.ids[0],
      columns: columns.map((c) => c.name),
    });
    return result;
  }

  // Azure resource IDs are full ARM paths
  // (/subscriptions/.../resourceGroups/.../providers/.../<leaf-name>). The
  // gateway names a VM's public IP and NIC exactly after the VM, and Azure
  // names its OS disk `<vm>_OsDisk_1_<hex>`. VM names never contain `_`, so
  // the leaf up to its first `_` is the parent VM's name; summing by it adds
  // compute + disk + NIC + IP and keeps `vm-1` from taking `vm-10`'s or
  // another owner's resources.
  const vmsByName = new Map(vms.map((v) => [v.cloud_id.toLowerCase(), v]));
  for (const row of rows) {
    const resourceId = row[resourceIdx];
    const cost = row[costIdx];
    if (typeof resourceId !== 'string' || typeof cost !== 'number') continue;
    const leaf = resourceId.split('/').pop()?.toLowerCase() ?? '';
    const match = vmsByName.get(leaf.split('_')[0]);
    if (!match) continue;
    result.set(match.cloud_id, (result.get(match.cloud_id) ?? 0) + cost);
  }

  log.info('Azure cost calculation complete', {
    id: resource.ids[0],
    groups: resource.ids.length,
    vmsRequested: vms.length,
    vmsCalculated: result.size,
  });

  return result;
}

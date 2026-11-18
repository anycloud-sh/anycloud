/**
 * GCP per-VM cost calculator.
 *
 * Queries the customer's Cloud Billing BigQuery export. Requires:
 *   1. Customer enabled "detailed usage cost" billing export to BigQuery
 *      with resource-level detail
 *   2. Service account has roles/bigquery.dataViewer on the billing dataset
 *   3. GCPCreds.billingExportDataset populated ("project.dataset")
 *
 * VMs created before the customer enabled export are permanently uncalculable
 * — they stay vms.cost = NULL and keep showing the catalog estimate.
 */

import type { BigQuery } from '@google-cloud/bigquery';
import { log } from '../logger.js';
import type { VmNeedingCost } from '../repositories/billing.js';
import type { GCPCreds, GCPRoleCreds } from '../../../shared/cloud.js';
import type { VmCostIdentity, VmCostMap, VmCostResource } from './contracts.js';
import { createGcpBigQueryClient } from '../provider-clients/gcp.js';

export async function calculateGcpVmCosts(
  cloudConfig: VmCostIdentity,
  resource: VmCostResource,
  vms: VmNeedingCost[],
): Promise<VmCostMap> {
  const creds = cloudConfig.credentials as GCPCreds | GCPRoleCreds;
  // A role connection names no billing export.
  if ('kind' in creds || !creds.billingExportDataset) {
    return new Map();
  }

  const bigquery: BigQuery = createGcpBigQueryClient(creds);

  const earliestCreated = new Date(Math.min(...vms.map((v) => v.created_at)));
  const latestEnded = new Date(
    Math.max(...vms.map((v) => v.ended_at)) + 24 * 60 * 60 * 1000,
  );

  // Resource-level export table follows a fixed naming convention. The wildcard
  // suffix matches the date-partitioned shards.
  const tableRef = `\`${creds.billingExportDataset}.gcp_billing_export_resource_v1_*\``;

  const query = `
    SELECT
      resource.name AS resource_name,
      SUM(cost) - IFNULL(SUM(
        (SELECT SUM(c.amount) FROM UNNEST(credits) c)
      ), 0) AS net_cost,
      currency
    FROM ${tableRef}
    WHERE _PARTITIONTIME BETWEEN @start AND @end
      AND EXISTS (
        SELECT 1 FROM UNNEST(labels) l
        WHERE l.key = @resourceTag AND l.value IN UNNEST(@resourceIds)
      )
    GROUP BY resource_name, currency
  `;

  const [rows] = await bigquery.query({
    query,
    params: {
      start: earliestCreated.toISOString(),
      end: latestEnded.toISOString(),
      resourceTag: resource.tag,
      resourceIds: resource.ids,
    },
  });

  const result: VmCostMap = new Map();
  for (const row of rows as Array<{
    resource_name: string | null;
    net_cost: number | null;
    currency: string | null;
  }>) {
    if (!row.resource_name || row.net_cost == null) continue;
    if (row.currency && row.currency !== 'USD') {
      log.warn('GCP billing export uses non-USD currency; skipping VM', {
        id: resource.ids[0],
        currency: row.currency,
      });
      continue;
    }
    result.set(row.resource_name, row.net_cost);
  }

  log.info('GCP cost calculation complete', {
    id: resource.ids[0],
    groups: resource.ids.length,
    vmsRequested: vms.length,
    vmsCalculated: result.size,
  });

  return result;
}

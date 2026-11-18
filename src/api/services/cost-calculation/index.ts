/**
 * Cost calculation: pull real billed cost from the cloud provider's billing
 * API and map it back to per-VM `cloud_id`s. Used by the cost-calculation
 * background monitor to populate `vms.cost` for terminal VMs once their bill
 * has settled.
 *
 * Per-provider implementations live next to this file. Each answers a batch
 * of owner groups with one billing query and returns a Map<cloudId, costUsd>
 * for their VMs; missing entries mean "no data yet" and are silently skipped
 * (the monitor retries next hour).
 */

import type { VmNeedingCost } from '../repositories/billing.js';
import { CloudType } from '../../../shared/cloud.js';
import { providerHttpStatus } from '../gateways/cloud.js';
import { log } from '../logger.js';
import { calculateAwsVmCosts } from './aws.js';
import { calculateAzureVmCosts } from './azure.js';
import { calculateGcpVmCosts } from './gcp.js';
import {
  isBillingThrottle,
  type VmCostIdentity,
  type VmCostMap,
} from './contracts.js';

/**
 * All groups share one provider resource tag and credential (and therefore
 * the same cloud account). The tag is `anycloud_deployment` for workload VMs
 * and `anycloud_resource` for managed cluster capacity. Providers do not
 * document how large a batch may be, so a batch rejected with 400 is retried
 * one group at a time; a group that still fails is skipped until next hour,
 * and a throttle stops the batch.
 */
export async function calculateVmCosts(
  cloudConfig: VmCostIdentity,
  groups: VmNeedingCost[][],
): Promise<VmCostMap> {
  if (groups.length === 0) return new Map();
  try {
    return await calculateBatch(cloudConfig, groups);
  } catch (err) {
    const splittable =
      providerHttpStatus(err) === 400 && !isBillingThrottle(err);
    if (groups.length === 1 || !splittable) throw err;
    const costs: VmCostMap = new Map();
    for (const group of groups) {
      try {
        for (const entry of await calculateBatch(cloudConfig, [group])) {
          costs.set(...entry);
        }
      } catch (groupErr) {
        if (isBillingThrottle(groupErr)) throw groupErr;
        log.warn('Cost calculation failed', {
          id: group[0].resource_id,
          credentialId: group[0].credential_id,
          error: groupErr,
        });
      }
    }
    return costs;
  }
}

async function calculateBatch(
  cloudConfig: VmCostIdentity,
  groups: VmNeedingCost[][],
): Promise<VmCostMap> {
  const resource = {
    tag: groups[0][0].resource_tag,
    ids: groups.map((group) => group[0].resource_id),
  };
  switch (cloudConfig.cloudProvider) {
    case CloudType.AWS:
      return calculateAwsVmCosts(cloudConfig, resource, groups);
    case CloudType.Azure:
      return calculateAzureVmCosts(cloudConfig, resource, groups.flat());
    case CloudType.GCP:
      return calculateGcpVmCosts(cloudConfig, resource, groups.flat());
    case CloudType.Lambda:
    case CloudType.Local:
    case CloudType.Cloudflare:
      // Cloudflare is storage-only, so it has no VMs to cost.
      // No billing API integration yet — silently no-op so the monitor
      // doesn't churn on them. A new provider must take a position here.
      return new Map();
  }
}

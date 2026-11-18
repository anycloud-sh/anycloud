/**
 * Cost-calculation monitor: settles real billed cost into `vms.cost` once a
 * VM's bill has settled.
 */

import { setImmediate as yieldToIo } from 'node:timers/promises';
import { log } from '../logger.js';
import {
  listVmCostGroupsPage,
  settleVmCostGroup,
  type VmCostGroupCursor,
} from '../repositories/billing.js';
import { loadBillingIdentity } from '../cloud-config.js';
import { pAllSettledLimit } from '../gateways/cloud.js';
import { COST_CALCULATION_CONCURRENCY } from '../../config.js';
import { calculateVmCosts } from './index.js';
import { costManagementRetryAfterMs, isBillingThrottle } from './contracts.js';
import type { VmCostIdentity, VmCostMap } from './contracts.js';

export const COST_CALCULATION_INTERVAL_MS = 60 * 60_000; // 1 hour
const COST_CALCULATION_BILL_LAG_MS = 24 * 60 * 60_000; // 24h — bills settle slowly
const COST_CALCULATION_GIVE_UP_MS = 7 * 24 * 60 * 60_000;

/**
 * Pull real billed cost from each cloud's billing API for VMs whose bill has
 * settled (~24h after termination), and write the result to vms.cost. Once
 * populated, workload cost aggregation uses it instead of the catalog
 * estimate. VMs whose billing API returns nothing (untagged, pre-export, or
 * outside the provider's retention window) stay NULL and keep showing the
 * estimate — that's correct behavior. Asks stop a week after a group's last
 * VM ended or its owner finished or was deleted, whichever is later; a
 * throttled credential sits out the wait its billing API names, or the sweep.
 *
 * `billLagMs` is parameterized so integration tests can pass 0 instead of
 * waiting 24h.
 */
export async function runCostCalculationOnce(
  opts: { billLagMs?: number } = {},
): Promise<void> {
  const billLagMs = opts.billLagMs ?? COST_CALCULATION_BILL_LAG_MS;
  const cutoffMs = Date.now() - billLagMs;
  const oldestEndedMs = Date.now() - COST_CALCULATION_GIVE_UP_MS;
  // When each throttled credential may query again in this sweep.
  const notBefore = new Map<string | null, number>();
  let cursor: VmCostGroupCursor | null = null;
  let vmCount = 0;
  let groupCount = 0;
  let hasMore = true;
  while (hasMore) {
    const page = await listVmCostGroupsPage({
      oldestEndedMs,
      cutoffMs,
      pageSize: COST_CALCULATION_CONCURRENCY,
      cursor,
    });
    hasMore = !page.finished;
    cursor = page.cursor;
    groupCount += page.groups.length;
    vmCount += page.groups.reduce((count, group) => count + group.length, 0);
    // One billing query per credential and tag on this page.
    const batches = new Map<string, typeof page.groups>();
    for (const group of page.groups) {
      const key = `${group[0].credential_id}\0${group[0].resource_tag}`;
      batches.set(key, [...(batches.get(key) ?? []), group]);
    }
    let pendingSettlement: Promise<void> = Promise.resolve();
    await pAllSettledLimit(
      [...batches.values()],
      COST_CALCULATION_CONCURRENCY,
      async (groups) => {
        const credentialId = groups[0][0].credential_id;
        if ((notBefore.get(credentialId) ?? 0) > Date.now()) return;
        const fail = (
          group: (typeof groups)[number],
          error: unknown,
          batchSize = 1,
        ) =>
          log.warn('Cost calculation failed', {
            id: group[0].resource_id,
            credentialId,
            batchSize,
            error,
          });
        // Identity checks are per owner; every group shares the credential.
        let identity: VmCostIdentity | null = null;
        const billable: typeof groups = [];
        for (const group of groups) {
          try {
            const loaded = await loadBillingIdentity(group[0]);
            if (!loaded) continue;
            identity ??= loaded;
            billable.push(group);
          } catch (err) {
            fail(group, err);
          }
        }
        if (!identity) return;
        let costMap: VmCostMap;
        try {
          costMap = await calculateVmCosts(identity, billable);
        } catch (err) {
          if (isBillingThrottle(err)) {
            const waitMs = costManagementRetryAfterMs(err) ?? Infinity;
            notBefore.set(credentialId, Date.now() + waitMs);
          }
          fail(billable[0], err, billable.length);
          return;
        }
        for (const group of billable) {
          const costs = group.flatMap((vm) => {
            // Azure resource IDs are case-insensitive; keep the same lookup.
            const cost =
              costMap.get(vm.cloud_id) ??
              costMap.get(vm.cloud_id.toLowerCase());
            return cost === undefined ? [] : [{ vmId: vm.id, costUsd: cost }];
          });
          if (costs.length === 0) continue;
          // Writes are synchronous even while provider requests run in parallel.
          // Yield before each transaction so slow commits cannot accumulate into
          // one uninterrupted page. No transaction remains open across the yield.
          const settlement = pendingSettlement.then(async () => {
            await yieldToIo();
            await settleVmCostGroup(costs);
          });
          // Each group settles alone; later groups keep their turn.
          pendingSettlement = settlement.catch(() => undefined);
          await settlement.catch((err) => fail(group, err));
        }
      },
    );
    if (hasMore) {
      // Resolved promises only yield to microtasks. Empty/ineligible/error pages
      // must also let health requests and timers run before discovery continues.
      await yieldToIo();
    }
  }
  log.debug('Finished VM cost sweep', { id: 'system', vmCount, groupCount });
}

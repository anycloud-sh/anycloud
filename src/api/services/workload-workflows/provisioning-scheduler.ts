/**
 * The provisioning scheduler: admit Queued workloads into free pipeline slots,
 * resolve their placement under a deadline, gate dispatch on spend controls
 * (alerting once per blocking cap), claim Provisioning, and wake the pipeline.
 */

import { log } from '../logger.js';
import { resolveWorkloadPrice } from '../../../shared/catalog/index.js';
import { sendToNotifiers } from '../notify.js';
import { loadNotifiers } from '../../../shared/notifications/index.js';
import type {
  Notifier,
  NotificationsConfig,
} from '../../../shared/notifications/contracts.js';
import {
  buildProvisioningIntent,
  PROVISIONING_CONFIG_RESOLUTION_TIMEOUT_MS,
  resolveProvisioningConfig,
  type StorageCredentialReads,
  type WorkloadConfigStore,
} from '../cloud-config.js';
import type {
  BlockAlertIdentity,
  Budget,
  Throttle,
} from '../spend-controls-store.js';
import {
  BurnRateCache,
  blockAlertIdentity,
  findBlockingBudget,
  findBlockingCap,
  formatBlockReason,
  formatSpendBlockMessage,
  type SpendBlockAttribution,
  sameBlockAlertIdentity,
  SpendCache,
  type CapBlock,
} from '../spend-controls.js';
import { MAX_ACTIVE_DEPLOY_PIPELINES } from '../../config.js';
import { withTimeout } from '../../../shared/utils.js';
import { errorMessage } from '../../../shared/log-diagnostics.js';
import { WorkloadState } from '../../../shared/workload.js';
import {
  wakeWorkloadPipeline,
  type WorkloadPipelineDeps,
} from './workload-pipeline.js';

/** A Queued row as the scheduler reads it. */
interface QueuedWorkload {
  id: string;
  user_id: string;
  session: string | null;
}
/** The slot, queue and placement reads a tick makes. */
interface SchedulerStore extends WorkloadConfigStore {
  countDeploying(): Promise<number>;
  listQueued(limit: number): Promise<QueuedWorkload[]>;
}
/** The spend-attribution read a blocking cap's alert makes. */
interface SchedulerSpend {
  getCostReportInWindow(
    scope: { kind: 'api' },
    windowStartMs: number,
    windowEndMs: number,
    filter?: { session?: string | null; sessionExact?: boolean },
  ): Promise<{ byUser: Record<string, { cost: number }> }>;
}
/** The spend caps, and the alert debounce kept per blocking cap. */
interface SchedulerSpendControls {
  listThrottles(): Promise<Throttle[]>;
  listBudgets(): Promise<Budget[]>;
  lastBlockAlertAt(identity: BlockAlertIdentity): Promise<number | null>;
  recordBlockAlert(identity: BlockAlertIdentity, sentAt: number): Promise<void>;
}
export interface ProvisioningSchedulerDeps extends WorkloadPipelineDeps {
  store: WorkloadPipelineDeps['store'] & SchedulerStore;
  spend: SchedulerSpend;
  events: WorkloadPipelineDeps['events'] & {
    recordQueuedBlockReason(workloadId: string, message: string): Promise<void>;
  };
  spendControls: SchedulerSpendControls;
  notifications: { loadConfig(): Promise<NotificationsConfig> };
  credentials: StorageCredentialReads;
}

export async function runProvisioningScheduler(
  deps: ProvisioningSchedulerDeps,
): Promise<void> {
  const { store, events, credentials } = deps;

  // countDeploying excludes Queued intentionally — Queued jobs hold no cloud
  // resources and must not count against the concurrency cap.
  // Safety: createMonitor uses setTimeout-after-completion so this function is
  // never invoked concurrently. If that changes, the onlyIfIn:[Queued] claim
  // below prevents double-dispatch but would not prevent over-counting slots.
  const active = await store.countDeploying();
  const slots = MAX_ACTIVE_DEPLOY_PIPELINES - active;
  if (slots <= 0) return;

  const queued = await store.listQueued(slots);
  if (queued.length === 0) return;

  // Spend controls: load caps once per tick. Empty arrays = no gates active,
  // skip the recompute and the caches stay unused.
  const spendStore = deps.spendControls;
  const [throttles, budgets] = await Promise.all([
    spendStore.listThrottles(),
    spendStore.listBudgets(),
  ]);
  const burnCache = new BurnRateCache();
  const spendCache = new SpendCache();

  // Spend-block notifications: load channels once per tick (only when caps are
  // active) and debounce per cap within the tick, so one blocking cap yields
  // one alert even when many queued rows trip it on the same pass.
  const capsActive = throttles.length > 0 || budgets.length > 0;
  const notifiers = capsActive
    ? loadNotifiers(await deps.notifications.loadConfig())
    : [];
  const tickNow = Date.now();
  const alertedThisTick: BlockAlertIdentity[] = [];

  log.info('Provisioning scheduler dispatching queued workloads', {
    id: 'system',
    active,
    slots,
    dispatching: queued.length,
  });

  const recordSpendBlock = async (
    workloadId: string,
    block: CapBlock,
  ): Promise<void> => {
    const identity = blockAlertIdentity(block);
    const shouldNotify =
      notifiers.length > 0 &&
      !alertedThisTick.some((seen) => sameBlockAlertIdentity(seen, identity));
    if (shouldNotify) alertedThisTick.push(identity);

    await events.recordQueuedBlockReason(workloadId, formatBlockReason(block));
    if (shouldNotify) {
      await maybeNotifySpendBlock(
        deps,
        notifiers,
        identity,
        block,
        tickNow,
        queued,
      );
    }
  };

  // Resolve and claim each row in its own task so one slow provider/account
  // query cannot starve the rest of the queued workloads. Budget caps are
  // checked before resolution when possible, because they do not need selected
  // VM pricing. Throttles stay post-resolution so workloads are priced from
  // the selected provider target. BurnRateCache.withLock serializes throttle
  // pre-charge so a burst in one tick cannot overshoot the cap.
  const dispatchTasks: Promise<void>[] = [];
  for (const row of queued) {
    try {
      const workload = await store.getWorkload(row.id);
      if (!workload) continue;

      dispatchTasks.push(
        (async () => {
          const resolutionController = new AbortController();
          try {
            if (budgets.length > 0) {
              const budgetBlock = await findBlockingBudget(
                { session: workload.session ?? null },
                budgets,
                spendCache,
              );
              if (budgetBlock) {
                await recordSpendBlock(row.id, budgetBlock);
                return;
              }
            }

            const resolutionDeadlineAt =
              Date.now() + PROVISIONING_CONFIG_RESOLUTION_TIMEOUT_MS;
            const result = await withTimeout(
              resolveProvisioningConfig(workload, store, credentials, {
                signal: resolutionController.signal,
                deadlineAt: resolutionDeadlineAt,
              }),
              PROVISIONING_CONFIG_RESOLUTION_TIMEOUT_MS,
              `resolve provisioning config for ${row.id}`,
            );

            if (result.state !== WorkloadState.Provisioning) {
              if (result.state === WorkloadState.Invalid) {
                log.warn('Incomplete config — marking Invalid', {
                  id: row.id,
                  message: result.message,
                });
              }
              // A Queued resolution (blocked credential, transiently-blocked
              // target, …) re-occurs every scheduler tick. Route it through the
              // deduped queued-block path so a long-lived block can't grow
              // workload_events unbounded; the workload is already Queued, so
              // only the reason message needs refreshing. A terminal
              // transition (Invalid) is applied only if the workload remains
              // Queued.
              if (result.state === WorkloadState.Queued) {
                await events.recordQueuedBlockReason(
                  row.id,
                  result.message ?? '',
                );
              } else {
                const outcome = await deps.outcomes.publishTerminalOutcome(
                  row.id,
                  result.state,
                  WorkloadState.Queued,
                  { metadata: { message: result.message } },
                );
                if (outcome) {
                  await deps.reconciler.enqueueCleanupNow(row.id);
                }
              }
              return;
            }

            // Spend-controls gate: leave Queued if any cap blocks dispatch.
            // Throttle compares the live burn rate ($/hr across in-flight VMs)
            // plus the selected candidate's hourly rate; budget compares
            // calendar-window spend. See docs/platform/spend-controls.md.
            if (throttles.length > 0 || budgets.length > 0) {
              const hourlyUsd = resolveWorkloadPrice(
                result.config.cloudProvider,
                result.config.vmType,
                result.config.region,
                result.config.spot ?? false,
              );
              const block = await findBlockingCap(
                { session: workload.session ?? null, hourlyUsd },
                throttles,
                budgets,
                { burn: burnCache, spend: spendCache },
              );
              if (block) {
                await recordSpendBlock(row.id, block);
                return;
              }
            }

            // Claim the slot before dispatching — prevents double-dispatch if
            // scheduler ticks again before deploy() transitions state to
            // Provisioning via runStep.
            const provisioningMetadata: Record<string, unknown> = {};
            if (result.config.region) {
              provisioningMetadata.region = result.config.region;
            }
            if (result.eligibleRegions && result.eligibleRegions.length > 0) {
              provisioningMetadata.eligibleRegions = result.eligibleRegions;
            }
            // Every claim records it, so a retry never reads an older one.
            provisioningMetadata.untriedTargets = result.untriedTargets ?? 0;
            provisioningMetadata.provisioningIntent = buildProvisioningIntent(
              result.config,
              result.credentialId,
            );
            const admitted = await deps.lifecycle.updateState(
              row.id,
              WorkloadState.Provisioning,
              Object.keys(provisioningMetadata).length > 0
                ? { metadata: provisioningMetadata }
                : undefined,
            );
            if (!admitted) {
              log.info(
                'Provisioning scheduler: workload no longer Queued, skipping',
                { id: row.id },
              );
              return;
            }

            // Dispatch and restart recovery converge here. The shared runner
            // reconstructs placement from this durable claim and the VM ledger.
            await wakeWorkloadPipeline(deps, row.id);
          } catch (error) {
            resolutionController.abort(error);
            const message = errorMessage(error);
            await events.recordQueuedBlockReason(
              row.id,
              'Provisioning target resolution is taking longer than expected; retrying shortly',
            );
            log.warn(
              'Provisioning scheduler: config resolution did not finish',
              {
                id: row.id,
                error: message,
              },
            );
          }
        })(),
      );
    } catch (error) {
      log.error('Provisioning scheduler error', {
        id: row.id,
        error: error,
      });
    }
  }

  await Promise.allSettled(dispatchTasks);
}

// Re-notify at most once per cap per window while it keeps blocking dispatch —
// a throttle clears within minutes (VMs end) but a budget can stay capped for
// a whole calendar window, so this paces the "still paused" reminder.
const SPEND_BLOCK_ALERT_COOLDOWN_MS = 6 * 60 * 60_000; // 6h

/**
 * Name the people a cap is affecting, so a shared API's alert says whose work
 * is stuck and whose spend consumed the cap instead of just quoting a number.
 *
 * Deliberately best-effort: an alert must still go out if the cost rollup
 * fails, so a failure here degrades to the plain message rather than dropping
 * the notification.
 */
async function spendBlockAttribution(
  spend: SchedulerSpend,
  block: CapBlock,
  queued: QueuedWorkload[],
  now: number,
): Promise<SpendBlockAttribution | undefined> {
  const affected =
    block.scope === 'agent-session'
      ? queued.filter((row) => row.session === block.sessionId)
      : queued;
  const blockedCounts = new Map<string, number>();
  for (const row of affected) {
    if (!row.user_id) continue;
    blockedCounts.set(row.user_id, (blockedCounts.get(row.user_id) ?? 0) + 1);
  }
  const blockedUsers = [...blockedCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([username]) => username);

  let spendByUser: SpendBlockAttribution['spendByUser'] = [];
  // Read exactly the spend the cap measured, its calendar window and, for an
  // agent-session cap, only that session, so the per-user costs add up to the
  // total that tripped it.
  if (block.windowStartMs !== undefined) {
    try {
      const report = await spend.getCostReportInWindow(
        { kind: 'api' },
        block.windowStartMs,
        now,
        block.scope === 'agent-session'
          ? { session: block.sessionId, sessionExact: true }
          : undefined,
      );
      spendByUser = Object.entries(report.byUser)
        .filter(([, summary]) => summary.cost > 0)
        .map(([username, summary]) => ({ username, costUsd: summary.cost }))
        .sort((a, b) => b.costUsd - a.costUsd);
    } catch (error) {
      log.warn('Spend block alert could not attribute spend by user', {
        id: 'system',
        error,
      });
    }
  }

  const involvedUsers = new Set(blockedUsers);
  for (const { username } of spendByUser) involvedUsers.add(username);
  if (involvedUsers.size < 2) return undefined;
  return { blockedUsers, spendByUser };
}

// Best-effort: notify that a cap is now blocking dispatch, debounced via
// spend_block_alerts so we send at most once per cap per cooldown. Records the
// send only on success so a failed POST retries next tick (matching the
// digest's anySent gate). The caller already deduped this cap within the tick.
async function maybeNotifySpendBlock(
  { spend, spendControls: spendStore }: ProvisioningSchedulerDeps,
  notifiers: Notifier[],
  identity: BlockAlertIdentity,
  block: CapBlock,
  now: number,
  queued: QueuedWorkload[],
): Promise<void> {
  const last = await spendStore.lastBlockAlertAt(identity);
  if (last !== null && now - last < SPEND_BLOCK_ALERT_COOLDOWN_MS) return;
  const attribution = await spendBlockAttribution(spend, block, queued, now);
  const sent = await sendToNotifiers(
    notifiers,
    formatSpendBlockMessage(block, attribution),
  );
  if (sent) await spendStore.recordBlockAlert(identity, now);
}

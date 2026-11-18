import type { V1Job } from '@kubernetes/client-node';

import type { SystemUpgrade } from '../../../shared/api-contract/system-release-schemas.js';
import { ClusterReleaseState } from '../../../shared/clusters.js';
import { SYSTEM_RELEASE_HELM_CHART_NAME } from '../../../shared/system-release.js';
import { WorkloadState } from '../../../shared/workload.js';
import type { SystemReleaseIntent } from '../system-release-intent-store.js';

/**
 * The chart's post-install/post-upgrade hook Job for one release revision
 * (`charts/anycloud-api/templates/hooks.yaml`). It succeeds only when the
 * Pod for that revision runs the pinned image, is Ready and serves the
 * release's version through its endpoint.
 */
export function readyJobName(revision: number): string {
  return `anycloud-api-ready-${revision}`;
}

/**
 * helm-controller's install/upgrade Job for the API's HelmChart, in the
 * HelmChart's namespace. It is deleted and recreated whenever the HelmChart's
 * spec changes, and finishes only after Helm's hooks do.
 */
export const HELM_INSTALL_JOB = `helm-install-${SYSTEM_RELEASE_HELM_CHART_NAME}`;

/** The pre-upgrade hook Job that refuses a stale revision before the upgrade. */
export function guardJobName(revision: number): string {
  return `anycloud-api-guard-${revision}`;
}

/** A hook Job's outcome; `absent` when Helm has not created it yet. */
export type HookJobObservation = (
  | { outcome: 'succeeded' | 'running' | 'absent' }
  | { outcome: 'failed'; reason: string }
) & { uid?: string; /** Epoch ms, second resolution. */ createdAt?: number };

/**
 * Kubernetes stamps creation to the second, and helm-controller replaces its
 * Job only after the HelmChart patch the applied state follows.
 */
const HELM_JOB_CLOCK_SLACK_MS = 5_000;

const REASON_MAX_CHARS = 240;

export function observeHookJob(job: V1Job): HookJobObservation {
  const uid = job.metadata?.uid;
  const created = job.metadata?.creationTimestamp;
  return {
    ...observeHookJobOutcome(job),
    ...(uid ? { uid } : {}),
    ...(created ? { createdAt: new Date(created).getTime() } : {}),
  };
}

function observeHookJobOutcome(job: V1Job): HookJobObservation {
  const conditions = job.status?.conditions ?? [];
  const holds = (type: string) =>
    conditions.find(
      (condition) => condition.type === type && condition.status === 'True',
    );
  if (holds('Complete') || (job.status?.succeeded ?? 0) > 0) {
    return { outcome: 'succeeded' };
  }
  const failed = holds('Failed');
  if (failed || (job.status?.failed ?? 0) > 0) {
    const reason = [failed?.reason, failed?.message]
      .filter(Boolean)
      .join(': ')
      .replace(/\s+/gu, ' ')
      .slice(0, REASON_MAX_CHARS);
    return { outcome: 'failed', reason: reason || 'the Job failed' };
  }
  return { outcome: 'running' };
}

const STORED_UPGRADE_STATE: Record<
  ClusterReleaseState,
  SystemUpgrade['state']
> = {
  [ClusterReleaseState.Seeded]: WorkloadState.Starting,
  [ClusterReleaseState.Applied]: WorkloadState.Starting,
  [ClusterReleaseState.Completed]: WorkloadState.Running,
  [ClusterReleaseState.Failed]: WorkloadState.Failed,
};

/**
 * A release as `Upgrade N`, in its stored state unless `observed` says
 * otherwise. Revision 1 is the bootstrap release, not an upgrade.
 */
export function systemUpgrade(
  intent: SystemReleaseIntent | null,
  observed?: Pick<SystemUpgrade, 'state' | 'lastError'>,
): SystemUpgrade | null {
  if (!intent || intent.revision <= 1) return null;
  return {
    number: intent.revision - 1,
    apiVersion: intent.apiVersion,
    apiImage: intent.apiImage,
    state: observed?.state ?? STORED_UPGRADE_STATE[intent.state],
    lastError: observed ? observed.lastError : intent.lastError,
    createdAt: intent.createdAt,
    updatedAt: intent.updatedAt,
  };
}

/**
 * The latest upgrade as `api status` reports it. An applied release (its
 * HelmChart patched) is `running` once that revision's ready Job succeeded,
 * `failed` when it failed, and `starting` while it runs, has not been created
 * or cannot be read. With no ready Job, a failed guard Job (the upgrade never
 * ran) is `failed`, and so is a failed helm-install Job created for this
 * release (Helm never got to the hooks).
 */
export function reportSystemUpgrade(
  latest: SystemReleaseIntent | null,
  readyJob: HookJobObservation | null,
  guardJob: HookJobObservation | null,
  helmJob: HookJobObservation | null = null,
): SystemUpgrade | null {
  if (latest?.state !== ClusterReleaseState.Applied) {
    return systemUpgrade(latest);
  }
  const observed = (
    state: SystemUpgrade['state'],
    lastError: string | null = null,
  ) => systemUpgrade(latest, { state, lastError });
  if (readyJob?.outcome === 'succeeded') return observed(WorkloadState.Running);
  if (
    // A refusing guard or a failed ready check fails Helm too; its reason
    // is the one to report.
    readyJob?.outcome !== 'failed' &&
    guardJob?.outcome !== 'failed' &&
    helmJob?.outcome === 'failed' &&
    helmJob.createdAt !== undefined &&
    helmJob.createdAt >= latest.updatedAt - HELM_JOB_CLOCK_SLACK_MS
  ) {
    return observed(
      WorkloadState.Failed,
      `the Helm upgrade failed: ${helmJob.reason}`,
    );
  }
  if (!readyJob || (readyJob.outcome === 'absent' && !guardJob)) {
    return observed(
      WorkloadState.Starting,
      'could not read the ready check, so this upgrade is not confirmed running',
    );
  }
  if (readyJob.outcome === 'absent' && guardJob?.outcome === 'failed') {
    return observed(
      WorkloadState.Failed,
      `the pre-upgrade check failed: ${guardJob.reason}`,
    );
  }
  if (readyJob.outcome === 'failed') {
    return observed(
      WorkloadState.Failed,
      `the ready check failed: ${readyJob.reason}`,
    );
  }
  return observed(WorkloadState.Starting);
}

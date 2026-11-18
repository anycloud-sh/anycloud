import { readFileSync } from 'node:fs';

import type { V1Job } from '@kubernetes/client-node';
import { describe, expect, it } from 'vitest';

import {
  observeHookJob,
  readyJobName,
  reportSystemUpgrade,
  type HookJobObservation,
} from '../../../../src/api/services/system-release/ready-job.js';
import type { SystemReleaseIntent } from '../../../../src/api/services/system-release-intent-store.js';
import { ClusterReleaseState } from '../../../../src/shared/clusters.js';
import { WorkloadState } from '../../../../src/shared/workload.js';

const intent = (
  state: SystemReleaseIntent['state'] = ClusterReleaseState.Applied,
  revision = 3,
): SystemReleaseIntent => ({
  revision,
  operationId: 'rel-3',
  apiVersion: '0.1.65',
  apiImage: `ghcr.io/anycloud-sh/api:0.1.65@sha256:${'b'.repeat(64)}`,
  requestedByUserId: '1',
  state,
  lastError: null,
  createdAt: 1,
  updatedAt: 1,
});

describe('release ready Job', () => {
  it('names the hook Jobs after the revision exactly as the chart does', () => {
    const hooks = readFileSync(
      new URL(
        '../../../../charts/anycloud-api/templates/hooks.yaml',
        import.meta.url,
      ),
      'utf8',
    );
    expect(readyJobName(3)).toBe('anycloud-api-ready-3');
    expect(hooks).toContain(
      'name: anycloud-api-ready-{{ .Values.release.revision }}',
    );
    expect(hooks).toContain(
      'name: anycloud-api-guard-{{ .Values.release.revision }}',
    );
  });

  it.each<[V1Job, HookJobObservation]>([
    [{}, { outcome: 'running' }],
    [{ status: { active: 1 } }, { outcome: 'running' }],
    [
      { status: { conditions: [{ type: 'Complete', status: 'True' }] } },
      { outcome: 'succeeded' },
    ],
    [{ status: { succeeded: 1 } }, { outcome: 'succeeded' }],
    [
      {
        status: {
          conditions: [
            {
              type: 'Failed',
              status: 'True',
              reason: 'BackoffLimitExceeded',
              message: `Job has reached the\n specified backoff limit${' x'.repeat(200)}`,
            },
          ],
        },
      },
      {
        outcome: 'failed',
        reason:
          `BackoffLimitExceeded: Job has reached the specified backoff limit${' x'.repeat(200)}`.slice(
            0,
            240,
          ),
      },
    ],
    [
      { status: { failed: 1 } },
      { outcome: 'failed', reason: 'the Job failed' },
    ],
  ])('reads the Job outcome from its conditions and counts', (job, outcome) => {
    expect(observeHookJob(job)).toEqual(outcome);
  });

  // Revision 3 is the second upgrade: revision 1 is the bootstrap release.
  const upgrade = (state: WorkloadState, lastError: string | null = null) => ({
    number: 2,
    apiVersion: '0.1.65',
    apiImage: `ghcr.io/anycloud-sh/api:0.1.65@sha256:${'b'.repeat(64)}`,
    state,
    lastError,
    createdAt: 1,
    updatedAt: 1,
  });

  it('reports Upgrade N running only when the ready Job succeeded', () => {
    expect(
      reportSystemUpgrade(intent(), { outcome: 'succeeded' }, null),
    ).toEqual(upgrade(WorkloadState.Running));
  });

  it.each(['running', 'absent'] as const)(
    'reports an applied release as starting while its ready Job is %s',
    (outcome) => {
      // Applied is recorded when the HelmChart is patched; the Helm
      // controller has not finished the rollout or the hook yet.
      const guard = { outcome: 'absent' } as const;
      expect(reportSystemUpgrade(intent(), { outcome }, guard)).toEqual(
        upgrade(WorkloadState.Starting),
      );
    },
  );

  it('reports failed with the reason when the ready or guard Job failed', () => {
    const reason = 'DeadlineExceeded: Job was active longer than specified';
    expect(
      reportSystemUpgrade(intent(), { outcome: 'failed', reason }, null),
    ).toEqual(
      upgrade(WorkloadState.Failed, `the ready check failed: ${reason}`),
    );
    expect(
      reportSystemUpgrade(
        intent(),
        { outcome: 'absent' },
        { outcome: 'failed', reason },
      ),
    ).toEqual(
      upgrade(WorkloadState.Failed, `the pre-upgrade check failed: ${reason}`),
    );
  });

  it('reports failed when the helm-install Job made for this release failed, and ignores an older one', () => {
    const helm = (createdAt: number) => ({
      outcome: 'failed' as const,
      reason:
        'BackoffLimitExceeded: Job has reached the specified backoff limit',
      createdAt,
    });
    const applied = intent();
    const failed = upgrade(
      WorkloadState.Failed,
      'the Helm upgrade failed: BackoffLimitExceeded: Job has reached the specified backoff limit',
    );
    // Helm never got to the hooks: neither Job exists.
    expect(
      reportSystemUpgrade(
        applied,
        { outcome: 'absent' },
        { outcome: 'absent' },
        helm(applied.updatedAt),
      ),
    ).toEqual(failed);
    // Stamped to the second, it may read slightly before the applied state.
    expect(
      reportSystemUpgrade(applied, null, null, helm(applied.updatedAt - 1_000)),
    ).toEqual(failed);
    // Just outside the slack, it is an older Job's.
    expect(
      reportSystemUpgrade(
        applied,
        { outcome: 'absent' },
        { outcome: 'absent' },
        helm(applied.updatedAt - 5_001),
      ),
    ).toEqual(upgrade(WorkloadState.Starting));
    // A refusing guard fails Helm too: the guard's reason is reported.
    expect(
      reportSystemUpgrade(
        applied,
        { outcome: 'absent' },
        { outcome: 'failed', reason: 'stale revision' },
        helm(applied.updatedAt),
      ),
    ).toEqual(
      upgrade(
        WorkloadState.Failed,
        'the pre-upgrade check failed: stale revision',
      ),
    );
    // The Job a previous release left is not this one's.
    expect(
      reportSystemUpgrade(
        applied,
        { outcome: 'absent' },
        { outcome: 'absent' },
        helm(applied.updatedAt - 60_000),
      ),
    ).toEqual(upgrade(WorkloadState.Starting));
    // The ready Job decides once it has.
    expect(
      reportSystemUpgrade(
        applied,
        { outcome: 'succeeded' },
        null,
        helm(applied.updatedAt),
      ),
    ).toEqual(upgrade(WorkloadState.Running));
  });

  it('stamps the Job creation time on the observation', () => {
    expect(
      observeHookJob({
        metadata: { uid: 'u1', creationTimestamp: new Date(5_000) },
        status: { succeeded: 1 },
      }),
    ).toEqual({ outcome: 'succeeded', uid: 'u1', createdAt: 5_000 });
  });

  it('never reports running when the ready Job, or the guard Job behind an absent one, cannot be read', () => {
    const unread = upgrade(
      WorkloadState.Starting,
      'could not read the ready check, so this upgrade is not confirmed running',
    );
    expect(reportSystemUpgrade(intent(), null, null)).toEqual(unread);
    expect(reportSystemUpgrade(intent(), { outcome: 'absent' }, null)).toEqual(
      unread,
    );
  });

  it('reports other releases in their stored state, and the bootstrap release as no upgrade', () => {
    expect(
      reportSystemUpgrade(intent(ClusterReleaseState.Seeded), null, null),
    ).toEqual(upgrade(WorkloadState.Starting));
    expect(
      reportSystemUpgrade(
        { ...intent(ClusterReleaseState.Failed), lastError: 'bucket gone' },
        null,
        null,
      ),
    ).toEqual(upgrade(WorkloadState.Failed, 'bucket gone'));
    expect(
      reportSystemUpgrade(
        intent(ClusterReleaseState.Applied, 1),
        { outcome: 'succeeded' },
        null,
      ),
    ).toBeNull();
    expect(
      reportSystemUpgrade(null, { outcome: 'succeeded' }, null),
    ).toBeNull();
  });
});

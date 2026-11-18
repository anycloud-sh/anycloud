import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { randomBytes } from 'crypto';
import {
  getDeploymentStore,
  resetPersistence,
  getWorkloadLifecycle as lifecycle,
  getWorkloadEventStore as eventLog,
  getWorkloadQueryStore as queries,
  getDeploymentExecutionStore as executions,
  getWorkloadOutcomes as outcomes,
  getWorkloadSpendStore,
} from '../../../../src/api/services/persistence.js';
import { walkToState } from '../../../helpers/workload-store.js';
import { getDB } from '../../../../src/api/services/repositories/db.js';
import type { AttemptEnd } from '../../../../src/api/services/repositories/workload-attempts.js';
import { WorkloadState } from '../../../../src/shared/workload.js';
import config from '../../../../src/api/config';
import {
  claimInput,
  createTarget,
  createTargetedJob,
  firstExecution,
  secondExecution,
} from '../../helpers/targeted-jobs.js';

describe('workload_events JSON index usage', () => {
  beforeAll(() => {
    config.cipherKey = randomBytes(32).toString('hex');
  });

  describe('persistent Deployment Job executions', () => {
    beforeEach(() => {
      resetPersistence();
    });

    it('test:0036/S4 atomically selects Deployment Jobs without specs or VM rows and enforces capacity', async () => {
      await createTarget();
      await createTargetedJob('job-a');
      await createTargetedJob('job-b');
      const store = executions();

      await expect(queries().getWorkload('job-a')).resolves.toMatchObject({
        deploymentId: 'target',
        state: WorkloadState.Queued,
        env: null,
        githubToken: null,
        registryUsername: null,
        image: null,
        imageDigest: null,
        command: null,
        dockerOptions: null,
        sshPrivateKey: '',
      });
      expect(
        await getDB().query(
          'SELECT * FROM container_specs WHERE workload_id IS NOT NULL',
        ),
      ).toEqual([]);
      expect(
        await getDB().query(
          'SELECT submitted_at, ssh_private_key, docker_command FROM workloads WHERE id = ?',
          ['job-a'],
        ),
      ).toEqual([
        {
          submitted_at: expect.any(Number),
          ssh_private_key: '',
          docker_command: '',
        },
      ]);
      await expect(queries().getWorkload('job-b')).resolves.toMatchObject({
        deploymentId: 'target',
        state: WorkloadState.Queued,
      });

      const [selected, replayed] = await Promise.all([
        store.claimTargetedJob(claimInput('job-a', firstExecution)),
        store.claimTargetedJob(claimInput('job-a', firstExecution)),
      ]);
      expect(selected).toEqual({
        kind: 'selected',
        jobId: 'job-a',
        executionId: firstExecution,
      });
      expect(replayed).toEqual({
        kind: 'selected',
        jobId: 'job-a',
        executionId: firstExecution,
      });
      await expect(
        store.claimTargetedJob(
          claimInput('job-a', firstExecution, null, 'another-pod'),
        ),
      ).resolves.toEqual({ kind: 'conflict' });
      await expect(
        store.claimTargetedJob(claimInput('job-b', secondExecution)),
      ).resolves.toEqual({ kind: 'conflict' });

      const runningEvents = await getDB().query<{ count: number }>(
        `SELECT COUNT(*) AS count FROM workload_events
         WHERE workload_id = ? AND state = ?
           AND json_extract(metadata, '$.executionId') = ?`,
        ['job-a', WorkloadState.Running, firstExecution],
      );
      expect(runningEvents[0]?.count).toBe(1);
      await expect(store.countTargetedJobs('target')).resolves.toMatchObject({
        queued: 1,
        running: 1,
        unreleased: 1,
      });
      expect(await getDB().query('SELECT * FROM vms')).toEqual([]);
    });

    it('test:0036/S2 test:0036/S3 test:0036/S19 binds new executions to current Deployment configuration while Jobs retain only target identity', async () => {
      await createTarget();
      await createTargetedJob('job-a');
      await createTargetedJob('job-b');
      const store = executions();
      const deployments = getDeploymentStore();
      async function replaceDeploymentImage(image: string): Promise<void> {
        const deployment = (await deployments.getById('target'))!;
        expect(
          await deployments.update(
            {
              id: deployment.id,
              expectedGeneration: deployment.generation,
              config: { ...deployment.config, image },
              secretNames: [],
              gpuCount: deployment.gpuCount,
              maxConcurrentJobsPerReplica:
                deployment.maxConcurrentJobsPerReplica,
            },
            { kind: 'api' },
          ),
        ).toBe(deployment.generation + 1);
      }
      await replaceDeploymentImage('example/deployment:second');
      const listed = await queries().listWorkloads({ kind: 'api' }, 1, {
        search: 'target',
        limitExplicit: true,
      });
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({
        deploymentId: 'target',
        image: null,
      });
      for (const key of ['env', 'githubToken', 'sshPrivateKey']) {
        expect(listed[0]).not.toHaveProperty(key);
      }
      expect(
        await queries().listWorkloads({ kind: 'api' }, 1, {
          search: 'example/deployment:second',
          limitExplicit: true,
        }),
      ).toEqual([]);
      expect(
        await queries().listWorkloads({ kind: 'api' }, 1, {
          search: 'example/deployment:latest',
          limitExplicit: true,
        }),
      ).toEqual([]);
      expect(
        await getWorkloadSpendStore().listWorkloadCostsForId(
          { kind: 'api' },
          'job-a',
        ),
      ).toMatchObject([{ image: null }]);
      await expect(
        store.claimTargetedJob(claimInput('job-a', firstExecution)),
      ).resolves.toEqual({ kind: 'conflict' });
      await expect(
        store.claimTargetedJob({
          ...claimInput('job-a', firstExecution),
          generation: 2,
        }),
      ).resolves.toMatchObject({ kind: 'selected', jobId: 'job-a' });
      expect(await store.getTargetedExecution('job-a')).toMatchObject({
        generation: 2,
      });
      expect((await deployments.getById('target'))?.config.image).toBe(
        'example/deployment:second',
      );
      expect(
        await store.reportTargetedJobExecution('job-a', firstExecution, {
          state: WorkloadState.Retrying,
          reason: 'runtime lost',
        }),
      ).toBe(true);
      const retry = (await eventLog().getWorkloadEvents('job-a')).at(-1)!;
      expect(await lifecycle().queueRetryCandidate('job-a', retry.id)).toBe(
        'queued',
      );
      await replaceDeploymentImage('example/deployment:third');
      await expect(
        store.claimTargetedJob({
          ...claimInput('job-a', secondExecution, firstExecution),
          generation: 2,
        }),
      ).resolves.toEqual({ kind: 'conflict' });
      await expect(
        store.claimTargetedJob({
          ...claimInput('job-a', secondExecution, firstExecution, 'pod-c'),
          generation: 3,
        }),
      ).resolves.toMatchObject({ kind: 'selected', jobId: 'job-a' });
      expect(
        await store.reportTargetedJobExecution('job-a', firstExecution, {
          state: WorkloadState.Completed,
        }),
      ).toBe(false);
      expect(
        await store.reportTargetedJobExecution('job-a', secondExecution, {
          state: WorkloadState.Completed,
        }),
      ).toBe(true);
      expect((await queries().getWorkload('job-a'))?.image).toBeNull();
      expect(
        await getDB().query(
          'SELECT * FROM container_specs WHERE workload_id IS NOT NULL',
        ),
      ).toEqual([]);
      expect(await getDB().query('SELECT * FROM vms')).toEqual([]);
    });

    it('rejects fresh work from an outdated generation but replays its already selected execution', async () => {
      await createTarget(2);
      await createTargetedJob('job-a');
      await createTargetedJob('job-b');
      const store = executions();
      const selected = await store.claimTargetedJob(
        claimInput('job-a', firstExecution),
      );
      expect(selected).toMatchObject({ kind: 'selected', jobId: 'job-a' });
      const deployment = (await getDeploymentStore().getById('target'))!;
      await getDeploymentStore().update(
        { ...deployment, expectedGeneration: deployment.generation },
        { kind: 'api' },
      );
      await expect(
        store.claimTargetedJob(claimInput('job-a', firstExecution)),
      ).resolves.toEqual(selected);
      await expect(
        store.claimTargetedJob(claimInput('job-b', secondExecution)),
      ).resolves.toEqual({ kind: 'conflict' });
      expect((await queries().getWorkload('job-b'))?.state).toBe(
        WorkloadState.Queued,
      );
    });

    it('fences retry delivery and every outcome to the current execution', async () => {
      await createTarget();
      await createTargetedJob('job-a');
      const store = executions();
      await store.claimTargetedJob(claimInput('job-a', firstExecution));

      await expect(
        store.reportTargetedJobExecution('job-a', firstExecution, {
          state: WorkloadState.Retrying,
          reason: 'temporary',
        }),
      ).resolves.toBe(true);
      await expect(
        store.reportTargetedJobExecution('job-a', firstExecution, {
          state: WorkloadState.Retrying,
          reason: 'different reason',
        }),
      ).resolves.toBe(false);
      await expect(
        store.reportTargetedJobExecution('job-a', firstExecution, {
          state: WorkloadState.Retrying,
          reason: 'temporary',
        }),
      ).resolves.toBe(true);
      const retryEvent = (await eventLog().getWorkloadEvents('job-a')).at(-1);
      expect(retryEvent?.state).toBe(WorkloadState.Retrying);
      await expect(
        lifecycle().queueRetryCandidate('job-a', retryEvent!.id),
      ).resolves.toBe('queued');

      await expect(
        store.claimTargetedJob(claimInput('job-a', firstExecution)),
      ).resolves.toEqual({ kind: 'execution-used' });
      await expect(
        store.claimTargetedJob(
          claimInput('job-a', secondExecution, firstExecution),
        ),
      ).resolves.toEqual({
        kind: 'selected',
        jobId: 'job-a',
        executionId: secondExecution,
      });
      await expect(
        store.claimTargetedJob(claimInput('job-a', firstExecution)),
      ).resolves.toEqual({ kind: 'execution-used' });
      await expect(
        store.reportTargetedJobExecution('job-a', firstExecution, {
          state: WorkloadState.Completed,
        }),
      ).resolves.toBe(false);
      await expect(
        store.reportTargetedJobExecution('job-a', secondExecution, {
          state: WorkloadState.Completed,
        }),
      ).resolves.toBe(true);
      await expect(store.getTargetedExecution('job-a')).resolves.toMatchObject({
        executionId: secondExecution,
        generation: 1,
        podUid: 'pod-a',
        containerId: 'containerd://container-a',
        state: WorkloadState.Completed,
      });
      await expect(
        store.reportTargetedJobExecution('job-a', secondExecution, {
          state: WorkloadState.Completed,
        }),
      ).resolves.toBe(true);
      await expect(
        store.reportTargetedJobExecution('job-a', secondExecution, {
          state: WorkloadState.Completed,
          reason: 'different result',
        }),
      ).resolves.toBe(false);
      await expect(
        store.reportTargetedJobExecution('job-a', secondExecution, {
          state: WorkloadState.Errored,
        }),
      ).resolves.toBe(false);
    });

    it('keeps a terminated running Job capacity-bound until matching cleanup', async () => {
      await createTarget();
      await createTargetedJob('job-a');
      await createTargetedJob('job-b');
      const store = executions();
      await store.claimTargetedJob(claimInput('job-a', firstExecution));

      await expect(
        outcomes().requestTermination('job-a', { kind: 'api' }),
      ).resolves.toMatchObject({ previousState: WorkloadState.Running });
      await expect(
        store.claimTargetedJob(claimInput('job-a', firstExecution)),
      ).resolves.toEqual({
        kind: 'selected',
        jobId: 'job-a',
        executionId: firstExecution,
      });
      await expect(store.getTargetedExecution('job-a')).resolves.toMatchObject({
        executionId: firstExecution,
        state: WorkloadState.Terminated,
      });
      await expect(store.countTargetedJobs('target')).resolves.toMatchObject({
        running: 0,
        unreleased: 1,
      });
      await expect(
        store.claimTargetedJob(claimInput('job-b', secondExecution)),
      ).resolves.toEqual({ kind: 'conflict' });
      await expect(
        store.completeTargetedJobCleanup('job-a', 'stale-execution'),
      ).resolves.toBe(false);
      await expect(
        store.completeTargetedJobCleanup('job-a', firstExecution),
      ).resolves.toBe(true);
      await expect(
        store.completeTargetedJobCleanup('job-a', firstExecution),
      ).resolves.toBe(true);
      await expect(
        store.claimTargetedJob(claimInput('job-a', firstExecution)),
      ).resolves.toEqual({ kind: 'execution-used' });
      await expect(
        store.claimTargetedJob(claimInput('job-b', secondExecution)),
      ).resolves.toEqual({
        kind: 'selected',
        jobId: 'job-b',
        executionId: secondExecution,
      });
    });

    const executionReports: Array<{
      name: string;
      report: AttemptEnd;
      stateWhenReportWins: WorkloadState;
      stateAfterTermination: WorkloadState;
    }> = [
      {
        name: 'completed',
        report: { state: WorkloadState.Completed },
        stateWhenReportWins: WorkloadState.Completed,
        stateAfterTermination: WorkloadState.Completed,
      },
      {
        name: 'errored',
        report: {
          state: WorkloadState.Errored,
          reason: 'application failed',
        },
        stateWhenReportWins: WorkloadState.Errored,
        stateAfterTermination: WorkloadState.Errored,
      },
      {
        name: 'invalid',
        report: { state: WorkloadState.Invalid },
        stateWhenReportWins: WorkloadState.Invalid,
        stateAfterTermination: WorkloadState.Invalid,
      },
      {
        name: 'retryable',
        report: {
          state: WorkloadState.Retrying,
          reason: 'application requested retry',
        },
        stateWhenReportWins: WorkloadState.Retrying,
        stateAfterTermination: WorkloadState.Terminated,
      },
    ];

    it.each(
      executionReports.flatMap((entry) => [
        { ...entry, ordering: 'report-first' as const },
        { ...entry, ordering: 'termination-first' as const },
      ]),
    )(
      '0029/S5 resolves $name execution reports when $ordering',
      async ({
        report,
        ordering,
        stateWhenReportWins,
        stateAfterTermination,
      }) => {
        await createTarget();
        await createTargetedJob('job-a');
        await createTargetedJob('job-b');
        const store = executions();
        await store.claimTargetedJob(claimInput('job-a', firstExecution));

        if (ordering === 'report-first') {
          await expect(
            store.reportTargetedJobExecution('job-a', firstExecution, report),
          ).resolves.toBe(true);
          await expect(queries().getWorkload('job-a')).resolves.toMatchObject({
            state: stateWhenReportWins,
          });
          await expect(
            outcomes().requestTermination('job-a', { kind: 'api' }),
          ).resolves.toMatchObject({ previousState: stateWhenReportWins });
        } else {
          await expect(
            outcomes().requestTermination('job-a', { kind: 'api' }),
          ).resolves.toMatchObject({ previousState: WorkloadState.Running });
          await expect(
            store.claimTargetedJob(claimInput('job-b', secondExecution)),
          ).resolves.toEqual({ kind: 'conflict' });
          await expect(
            store.reportTargetedJobExecution('job-a', firstExecution, report),
          ).resolves.toBe(true);
        }

        await expect(
          store.reportTargetedJobExecution(
            'job-a',
            '33333333-3333-4333-8333-333333333333',
            report,
          ),
        ).resolves.toBe(false);
        await expect(
          store.reportTargetedJobExecution('job-a', firstExecution, report),
        ).resolves.toBe(true);
        await expect(queries().getWorkload('job-a')).resolves.toMatchObject({
          state:
            ordering === 'termination-first'
              ? WorkloadState.Terminated
              : stateAfterTermination,
          cleanedAt: expect.any(Number),
        });
        await expect(
          store.claimTargetedJob(claimInput('job-b', secondExecution)),
        ).resolves.toEqual({
          kind: 'selected',
          jobId: 'job-b',
          executionId: secondExecution,
        });
      },
    );

    const redactedExecutionReports: Array<{
      name: string;
      report: AttemptEnd;
    }> = [
      {
        name: 'retry reason',
        report: {
          state: WorkloadState.Retrying,
          reason: 'request failed with token ghp_1234567890abcdefghij',
        },
      },
      {
        name: 'outcome message',
        report: {
          state: WorkloadState.Errored,
          reason: 'request failed with token ghp_1234567890abcdefghij',
        },
      },
    ];

    it.each(redactedExecutionReports)(
      'replays an exact $name after event metadata redaction',
      async ({ report }) => {
        await createTarget();
        await createTargetedJob('job-a');
        const store = executions();
        await store.claimTargetedJob(claimInput('job-a', firstExecution));

        await expect(
          store.reportTargetedJobExecution('job-a', firstExecution, report),
        ).resolves.toBe(true);
        await expect(
          store.reportTargetedJobExecution('job-a', firstExecution, report),
        ).resolves.toBe(true);
      },
    );

    it('atomically rejects create and resubmit after the target starts draining', async () => {
      await createTarget();
      await expect(createTargetedJob('accepted')).resolves.toBe(true);
      const store = queries();
      await walkToState('accepted', WorkloadState.Errored);
      await outcomes().markCleanupComplete('accepted');
      await getDeploymentStore().requestDeletion('target', {
        kind: 'api',
      });

      await expect(createTargetedJob('rejected')).resolves.toBe(false);
      await expect(store.getWorkload('rejected')).resolves.toBeNull();
      await expect(outcomes().resubmitWorkload('accepted')).resolves.toBe(
        false,
      );
    });

    it('cleans queued and retrying targeted Jobs without runtime acknowledgement', async () => {
      await createTarget();
      await createTargetedJob('queued-job');
      await createTargetedJob('retrying-job');
      await walkToState('retrying-job', WorkloadState.Retrying);

      await executions().terminateUnassignedTargetedJobs('target');
      await expect(queries().getWorkload('queued-job')).resolves.toMatchObject({
        state: WorkloadState.Terminated,
        cleanedAt: expect.any(Number),
      });
      await expect(
        queries().getWorkload('retrying-job'),
      ).resolves.toMatchObject({
        state: WorkloadState.Terminated,
        cleanedAt: expect.any(Number),
      });
      await expect(
        executions().countTargetedJobs('target'),
      ).resolves.toMatchObject({ unreleased: 0 });
    });
  });
});

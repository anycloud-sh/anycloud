import { claimSpendBlock } from '../../../src/api/services/spend-controls.js';
import {
  getWorkloadQueryStore as queries,
  getDeploymentExecutionStore,
  getWorkloadOutcomes,
} from '../../../src/api/services/persistence.js';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiRpcDomains } from '../../../src/api/composition.js';
import { createApiRpcMiddleware } from '../../../src/api/rpc/express.js';
import { DeploymentExecutionStore } from '../../../src/api/services/repositories/deployment-executions.js';
import {
  getPersistence,
  getDeploymentStore,
  resetPersistence,
} from '../../../src/api/services/persistence.js';
import { getDB } from '../../../src/api/services/repositories/db.js';
import { createDeploymentWorkloadDomain } from '../../../src/api/services/deployment-workload-domain.js';
import { ANYCLOUD_WORKLOAD_TOKEN_AUDIENCE } from '../../../src/api/services/kubernetes/pool-objects.js';
import {
  kubernetesWorkloadPodSelector,
  kubernetesWorkloadResourceName,
} from '../../../src/api/services/kubernetes/identity.js';
import { WorkloadState } from '../../../src/shared/workload.js';
import { createApiClient } from '../../../src/shared/services/api-client/rpc.js';
import {
  makeContainerSpec,
  makeClusterKubernetesClientFixture,
} from '../helpers/fixtures.js';
import { seedReadyNodePool } from '../helpers/node-pool-seed.js';
import { WorkloadQueryStore } from '../../../src/api/services/repositories/workload-queries.js';
import { getWorkloadAdmissionWriter } from '../../../src/api/services/workload-admission-writer.js';

const actor = {
  id: '1',
  username: 'anycloud-test',
  token: 'token',
};
const runtime = {
  deploymentId: 'deployment',
  generation: 1,
  podUid: 'pod',
  containerId: 'container',
};

describe('committed Job changes over HTTP', () => {
  let server: Server | undefined;
  let apiUrl: string;
  let directory: string | undefined;
  let shutdown: AbortController;

  async function stopApi() {
    shutdown?.abort(new Error('API shutdown'));
    if (server) {
      const closing = server;
      server = undefined;
      closing.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        closing.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }

  async function startApi() {
    shutdown = new AbortController();
    const persistence = getPersistence();
    const deploymentWorkload = createDeploymentWorkloadDomain({
      reconcile: () => undefined,
      jobChanges: persistence.jobChanges,
      claimSpendBlock,
      mintStorage: async () => ({}),
      deployments: persistence.deployments,
      jobs: persistence.deploymentExecutions,
      runtimes: {
        resolve: vi.fn().mockResolvedValue({
          config: { namespace: 'test' },
          cluster: makeClusterKubernetesClientFixture({
            authentication: {
              createTokenReview: vi.fn().mockResolvedValue({
                status: {
                  authenticated: true,
                  audiences: [ANYCLOUD_WORKLOAD_TOKEN_AUDIENCE],
                  user: {
                    username: `system:serviceaccount:test:${kubernetesWorkloadResourceName('deployment', 'deployment')}`,
                    extra: {
                      'authentication.kubernetes.io/pod-uid': ['pod'],
                      'authentication.kubernetes.io/pod-name': ['pod'],
                    },
                  },
                },
              }),
            },
            core: {
              readNamespacedPod: vi.fn().mockResolvedValue({
                metadata: {
                  name: 'pod',
                  uid: 'pod',
                  labels: Object.fromEntries([
                    kubernetesWorkloadPodSelector('deployment').split('='),
                  ]) as Record<string, string>,
                  annotations: { 'anycloud.sh/generation': '1' },
                },
                status: {
                  phase: 'Running',
                  containerStatuses: [
                    {
                      name: 'workload',
                      ready: true,
                      containerID: 'container',
                      image: 'image',
                      imageID: 'image-id',
                      restartCount: 0,
                    },
                  ],
                },
              }),
            },
          }),
        }),
      },
    });
    const app = express();
    app.use(
      createApiRpcMiddleware({
        shutdownSignal: shutdown.signal,
        authenticate: async () => actor,
        domains: createApiRpcDomains({ overrides: { deploymentWorkload } }),
      }),
    );
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const address = server!.address();
        if (!address || typeof address === 'string')
          throw new Error('Missing HTTP address');
        apiUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  }

  async function seedDeployment() {
    await seedReadyNodePool({ nodePoolId: 'pool', ownerUserId: actor.id });
    await getDeploymentStore().create(
      {
        id: 'deployment',
        ownerUserId: actor.id,
        name: 'deployment',
        nodePoolId: 'pool',
        config: makeContainerSpec(),
        gpuCount: 0,
        maxConcurrentJobsPerReplica: 2,
      },
      { kind: 'api' },
    );
  }

  async function admit(id = 'job', claimDeadlineAt?: number) {
    expect(
      await getWorkloadAdmissionWriter().createTargetedWorkload({
        id,
        deploymentId: 'deployment',
        userId: actor.username,
        ownerUserId: actor.id,
        claimDeadlineAt,
      }),
    ).toBe(true);
  }

  async function claim(id = 'job') {
    const executionId = randomUUID();
    expect(
      await getDeploymentExecutionStore().claimTargetedJob({
        ...runtime,
        jobId: id,
        submissionRevision: 0,
        previousExecutionId: null,
        executionId,
      }),
    ).toMatchObject({ kind: 'selected' });
    return executionId;
  }

  function cancellation(
    executionId: string,
    signal?: AbortSignal,
    fetchImpl?: typeof fetch,
  ) {
    return createApiClient('workload-token', {
      apiUrl,
      fetch: fetchImpl,
    }).deploymentWorkload.cancellation(
      {
        params: { deploymentId: 'deployment', jobId: 'job' },
        query: { executionId, waitMs: 20_000 },
      },
      { signal },
    );
  }

  beforeEach(async () => {
    // Replicas claim from this origin; a loopback one refuses targeted Jobs.
    vi.stubEnv('ANYCLOUD_WORKLOAD_API_URL', 'https://api.example.com');
    resetPersistence();
    await seedDeployment();
    await startApi();
  });

  afterEach(async () => {
    await stopApi();
    resetPersistence();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it('shares the notifier with the admission writer and accepts the Job ID error', async () => {
    const notified = vi.spyOn(getPersistence().jobChanges, 'notify');
    const client = createApiClient('token', { apiUrl });
    await expect(
      client.admission.submit({ deployment: 'deployment', id: 'error' }),
    ).resolves.toMatchObject({ id: 'error' });
    expect(notified).toHaveBeenCalledWith('error');
    const read = vi.spyOn(
      DeploymentExecutionStore.prototype,
      'observeTargetedJobSubmission',
    );
    const controller = new AbortController();
    const pending = client.workloads.observeSubmission(
      {
        params: { id: 'error' },
        body: { submissionRevision: 0, waitMs: 20_000 },
      },
      { signal: controller.signal },
    );
    void pending.catch(() => undefined);
    try {
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
      await delay(1100);
      expect(read).toHaveBeenCalledTimes(1);
      await claim('error');
      await expect(pending).resolves.toMatchObject({
        outcome: 'claimed',
        claimed: true,
      });
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      controller.abort();
      await pending.catch(() => undefined);
    }
  });

  it('keeps the original TypeScript cancellation request open beyond six seconds', async () => {
    await admit();
    const executionId = await claim();
    const read = vi.spyOn(
      DeploymentExecutionStore.prototype,
      'getTargetedExecution',
    );
    const fetchImpl = vi.fn(fetch);
    const controller = new AbortController();
    const pending = cancellation(executionId, controller.signal, fetchImpl);
    void pending.catch(() => undefined);
    try {
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
      await delay(7_000);
      expect(read).toHaveBeenCalledTimes(1);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      await getWorkloadOutcomes().requestTermination('job', { kind: 'api' });
      await expect(pending).resolves.toEqual({ cancelled: true });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(
        await getDeploymentExecutionStore().countTargetedJobs('deployment'),
      ).toMatchObject({ unreleased: 1 });
      await getDeploymentExecutionStore().completeTargetedJobCleanup(
        'job',
        executionId,
      );
      expect(
        await getDeploymentExecutionStore().countTargetedJobs('deployment'),
      ).toMatchObject({ unreleased: 0 });
    } finally {
      controller.abort();
      await pending.catch(() => undefined);
    }
  });

  it('does not notify on rollback or unchanged claim replay', async () => {
    await admit();
    const executionId = await claim();
    const read = vi.spyOn(
      DeploymentExecutionStore.prototype,
      'getTargetedExecution',
    );
    const notify = vi.spyOn(getPersistence().jobChanges, 'notify');
    const controller = new AbortController();
    const pending = cancellation(executionId, controller.signal);
    void pending.catch(() => undefined);
    try {
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
      await getDeploymentExecutionStore().claimTargetedJob({
        ...runtime,
        jobId: 'job',
        submissionRevision: 0,
        previousExecutionId: null,
        executionId,
      });
      await getDB()
        .query(`CREATE TEMP TRIGGER reject_outcome BEFORE INSERT ON workload_events
        WHEN NEW.state = 'completed' BEGIN SELECT RAISE(ABORT, 'reject outcome'); END`);
      await expect(
        getDeploymentExecutionStore().reportTargetedJobExecution(
          'job',
          executionId,
          {
            state: WorkloadState.Completed,
          },
        ),
      ).rejects.toThrow('reject outcome');
      expect(notify).not.toHaveBeenCalled();
      expect((await queries().getWorkload('job'))?.state).toBe(
        WorkloadState.Running,
      );
      await getDB().query('DROP TRIGGER reject_outcome');
      await getDeploymentExecutionStore().reportTargetedJobExecution(
        'job',
        executionId,
        { state: WorkloadState.Completed },
      );
      await expect(pending).resolves.toEqual({ cancelled: false });
      expect(notify).toHaveBeenCalledTimes(1);
    } finally {
      controller.abort();
      await pending.catch(() => undefined);
    }
  });

  it('observes a claim committed between the SQLite snapshot and awaiting its subscription', async () => {
    await admit();
    const original =
      DeploymentExecutionStore.prototype.observeTargetedJobSubmission;
    vi.spyOn(
      DeploymentExecutionStore.prototype,
      'observeTargetedJobSubmission',
    ).mockImplementationOnce(async function (
      this: DeploymentExecutionStore,
      ...args
    ) {
      const snapshot = await original.apply(this, args);
      await claim();
      return snapshot;
    });
    const client = createApiClient('token', { apiUrl });
    await expect(
      client.workloads.observeSubmission(
        {
          params: { id: 'job' },
          body: { submissionRevision: 0, waitMs: 20_000 },
        },
        { signal: AbortSignal.timeout(2_000) },
      ),
    ).resolves.toMatchObject({ outcome: 'claimed' });
  });

  it('wakes at the first-claim deadline and commits expiry', async () => {
    await admit('job', Date.now() + 100);
    const client = createApiClient('token', { apiUrl });
    await expect(
      client.workloads.observeSubmission(
        {
          params: { id: 'job' },
          body: { submissionRevision: 0, waitMs: 20_000 },
        },
        { signal: AbortSignal.timeout(2_000) },
      ),
    ).resolves.toMatchObject({ outcome: 'expired', claimed: false });
    expect((await queries().getWorkload('job'))?.state).toBe(
      WorkloadState.Terminated,
    );
  });

  it('uses the current submission deadline when resubmission follows the ownership lookup', async () => {
    await admit();
    await getWorkloadOutcomes().requestTermination('job', { kind: 'api' });
    const original = WorkloadQueryStore.prototype.getWorkloadForScope;
    vi.spyOn(
      WorkloadQueryStore.prototype,
      'getWorkloadForScope',
    ).mockImplementationOnce(async function (
      this: WorkloadQueryStore,
      ...args
    ) {
      const previous = await original.apply(this, args);
      await getWorkloadOutcomes().resubmitWorkloadForScope(
        'job',
        { kind: 'api' },
        undefined,
        { claimDeadlineAt: Date.now() + 100 },
      );
      return previous;
    });
    const client = createApiClient('token', { apiUrl });
    await expect(
      client.workloads.observeSubmission(
        {
          params: { id: 'job' },
          body: { submissionRevision: 1, waitMs: 20_000 },
        },
        { signal: AbortSignal.timeout(2_000) },
      ),
    ).resolves.toMatchObject({ outcome: 'expired', submissionRevision: 1 });
  });

  it.each(['expiry', 'Deployment deletion'] as const)(
    'wakes claim observation after background %s',
    async (change) => {
      const future = Date.now() + 60_000;
      await admit('job', future);
      const read = vi.spyOn(
        DeploymentExecutionStore.prototype,
        'observeTargetedJobSubmission',
      );
      const pending = createApiClient('token', {
        apiUrl,
      }).workloads.observeSubmission(
        {
          params: { id: 'job' },
          body: { submissionRevision: 0, waitMs: 20_000 },
        },
        { signal: AbortSignal.timeout(2_000) },
      );
      void pending.catch(() => undefined);
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
      if (change === 'expiry')
        await getDeploymentExecutionStore().expireDueTargetedJobSubmissions(
          future,
        );
      else
        await getDeploymentExecutionStore().terminateUnassignedTargetedJobs(
          'deployment',
        );
      await expect(pending).resolves.toMatchObject({
        outcome: change === 'expiry' ? 'expired' : 'terminated',
      });
    },
  );

  it.each(['disconnect', 'shutdown'] as const)(
    'releases the HTTP subscription on %s',
    async (reason) => {
      await admit();
      const executionId = await claim();
      const subscribe = vi.spyOn(getPersistence().jobChanges, 'subscribe');
      const controller = new AbortController();
      const pending = cancellation(executionId, controller.signal);
      void pending.catch(() => undefined);
      try {
        await vi.waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1));
        const dispose = vi.spyOn(subscribe.mock.results[0].value, 'dispose');
        if (reason === 'disconnect') controller.abort();
        else shutdown.abort(new Error('API shutdown'));
        await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));
      } finally {
        controller.abort();
        await pending.catch(() => undefined);
      }
    },
  );

  it.each(['claim', 'cancellation'] as const)(
    'recovers committed %s state from SQLite after restarting before notification delivery',
    async (kind) => {
      await stopApi();
      resetPersistence();
      directory = await mkdtemp(join(tmpdir(), 'anycloud-job-waits-'));
      vi.stubEnv('SQLITE_PATH', join(directory, 'state.sqlite'));
      await seedDeployment();
      await startApi();
      await admit();
      const executionId = kind === 'cancellation' ? await claim() : undefined;
      const changes = getPersistence().jobChanges;
      const subscribed = vi.spyOn(changes, 'subscribe');
      const controller = new AbortController();
      const observe = () =>
        kind === 'cancellation'
          ? cancellation(executionId!, controller.signal)
          : createApiClient('token', { apiUrl }).workloads.observeSubmission(
              {
                params: { id: 'job' },
                body: { submissionRevision: 0, waitMs: 20_000 },
              },
              { signal: controller.signal },
            );
      const pending = observe();
      void pending.catch(() => undefined);
      await vi.waitFor(() => expect(subscribed).toHaveBeenCalled());
      // Model a process disappearing after commit but before delivering the event.
      vi.spyOn(changes, 'notify').mockImplementationOnce(() =>
        controller.abort(),
      );
      if (kind === 'cancellation')
        await getWorkloadOutcomes().requestTermination('job', {
          kind: 'api',
        });
      else await claim();
      await expect(pending).rejects.toBeDefined();
      await stopApi();
      resetPersistence();
      await startApi();
      expect(getPersistence().jobChanges).not.toBe(changes);
      const result =
        kind === 'cancellation'
          ? await cancellation(executionId!)
          : await createApiClient('token', {
              apiUrl,
            }).workloads.observeSubmission({
              params: { id: 'job' },
              body: { submissionRevision: 0, waitMs: 20_000 },
            });
      expect(result).toMatchObject(
        kind === 'cancellation'
          ? { cancelled: true }
          : { outcome: 'claimed', claimed: true },
      );
      const executions = await getDB().query<{ count: number }>(
        "SELECT COUNT(*) AS count FROM workload_events WHERE workload_id = 'job' AND state = 'running'",
      );
      expect(executions[0].count).toBe(1);
    },
  );
});

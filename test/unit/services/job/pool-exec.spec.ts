import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { V1Pod } from '@kubernetes/client-node';
import { describe, expect, it, vi } from 'vitest';
import {
  createDeploymentExec,
  createPoolJobExec,
} from '../../../../src/api/services/job/pool-exec.js';
import type { JobExecPreparation } from '../../../../src/api/services/job/operations.js';
import { kubernetesWorkloadPodSelector } from '../../../../src/api/services/kubernetes/identity.js';
import { KUBERNETES_DEPLOYMENT_CONTAINER } from '../../../../src/api/services/kubernetes/pool-objects.js';
import type { PoolJobLogWindow } from '../../../../src/api/services/repositories/pool-job-store.js';
import { WorkloadState } from '../../../../src/shared/workload.js';
import type { StoredDeployment } from '../../../../src/api/services/deployment-store.js';
import { makeContainerSpec } from '../../helpers/fixtures.js';
import { localExec } from '../../helpers/local-pod-exec.js';

const NAMESPACE = 'anycloud-pool-a';

function pod(name: string, uid: string, ready = true): V1Pod {
  return {
    metadata: { name, uid },
    status: {
      conditions: [{ type: 'Ready', status: ready ? 'True' : 'False' }],
      containerStatuses: [
        {
          name: KUBERNETES_DEPLOYMENT_CONTAINER,
          image: 'runner',
          imageID: 'runner',
          ready,
          restartCount: 0,
          state: { running: {} },
        },
      ],
    },
  };
}

function cluster(pods: V1Pod[]) {
  const listNamespacedPod = vi.fn(async () => ({ items: pods }));
  const local = localExec({ core: { listNamespacedPod } });
  const runtimes = {
    resolve: vi.fn(async () => ({
      config: { namespace: NAMESPACE },
      cluster: local.cluster,
      nodePool: { clusterId: 'c', nodePoolId: 'pool-a', nvidiaGpusPerNode: 0 },
    })),
  };
  return { ...local, listNamespacedPod, runtimes };
}

function window(overrides: Partial<PoolJobLogWindow> = {}): PoolJobLogWindow {
  return {
    managed: true,
    deploymentId: 'managed-1',
    nodePoolId: 'pool-a',
    state: WorkloadState.Running,
    attempt: { podUid: 'uid-1', openedAt: 1, endedAt: null, tail: null },
    ...overrides,
  };
}

async function output(prepared: JobExecPreparation | null) {
  if (!prepared?.ok) throw new Error(JSON.stringify(prepared));
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await prepared.run({
    signal: new AbortController().signal,
    onStdout: (chunk) => void stdout.push(chunk.toString()),
    onStderr: (chunk) => void stderr.push(chunk.toString()),
  });
  return { code, stdout: stdout.join(''), stderr: stderr.join('') };
}

describe('pool Job exec', () => {
  const prepare = (windows: PoolJobLogWindow[], pods: V1Pod[]) => {
    const fake = cluster(pods);
    let reads = 0;
    const exec = createPoolJobExec({
      window: async () => windows[Math.min(reads++, windows.length - 1)]!,
      runtimes: fake.runtimes,
    });
    return { fake, exec };
  };

  it('leaves a Job on a user Deployment to the targeted-Job refusal', async () => {
    const { exec } = prepare([window({ managed: false })], []);
    await expect(exec('job-1', 'true')).resolves.toBeNull();
  });

  it.each([
    ['queued', window({ state: WorkloadState.Queued, attempt: null })],
    [
      'ended',
      window({
        state: WorkloadState.Completed,
        attempt: { podUid: 'uid-1', openedAt: 1, endedAt: 5, tail: null },
      }),
    ],
  ])('refuses a %s Job without touching its replica', async (_, current) => {
    const { exec, fake } = prepare([current], [pod('r-1', 'uid-1')]);

    await expect(exec('job-1', 'true')).resolves.toMatchObject({
      ok: false,
      status: 409,
    });
    expect(fake.exec).not.toHaveBeenCalled();
  });

  it("runs only in the replica holding the Job's claim, found by the managed Deployment's selector", async () => {
    const { exec, fake } = prepare(
      [window()],
      [pod('r-0', 'uid-0'), pod('r-1', 'uid-1')],
    );

    await expect(output(await exec('job-1', 'echo ran'))).resolves.toEqual({
      code: 0,
      stdout: 'ran\n',
      stderr: '',
    });
    expect(fake.listNamespacedPod).toHaveBeenCalledWith(
      {
        namespace: NAMESPACE,
        labelSelector: kubernetesWorkloadPodSelector('managed-1'),
      },
      expect.anything(),
    );
    expect(fake.exec.mock.calls.map((call) => call.slice(0, 3))).toEqual([
      [NAMESPACE, 'r-1', KUBERNETES_DEPLOYMENT_CONTAINER],
    ]);
  });

  it("refuses when the claim's replica is not among the Deployment's Pods", async () => {
    const { exec, fake } = prepare([window()], [pod('r-0', 'uid-0')]);

    await expect(exec('job-1', 'true')).resolves.toMatchObject({
      ok: false,
      status: 409,
    });
    expect(fake.exec).not.toHaveBeenCalled();
  });

  it.each([
    ['ends', window({ state: WorkloadState.Completed })],
    [
      'is claimed again',
      window({
        attempt: { podUid: 'uid-1', openedAt: 9, endedAt: null, tail: null },
      }),
    ],
  ])(
    'never starts the command when the Job %s before it starts',
    async (_, later) => {
      const ran = join(mkdtempSync(join(tmpdir(), 'pool-exec-')), 'ran');
      const { exec } = prepare([window(), later], [pod('r-1', 'uid-1')]);

      await expect(output(await exec('job-1', `touch ${ran}`))).rejects.toThrow(
        'Job job-1 ended before the command started',
      );
      expect(existsSync(ran)).toBe(false);
    },
  );
});

describe('Deployment exec', () => {
  const deployment: StoredDeployment = {
    id: 'd-1',
    ownerUserId: 'owner',
    name: 'handler',
    nodePoolId: 'pool-a',
    config: makeContainerSpec(),
    readinessProbe: null,
    gracePeriodSeconds: 30,
    secretNames: [],
    gpuCount: 0,
    maxConcurrentJobsPerReplica: 1,
    minReplicas: 1,
    maxReplicas: 3,
    managed: false,
    runnerRelease: null,
    generation: 1,
    deletionRequestedAt: null,
    deletedAt: null,
    createdAt: 1,
    updatedAt: 1,
  };
  const pods = [
    pod('r-2', 'uid-2'),
    pod('r-0', 'uid-0', false),
    pod('r-1', 'uid-1'),
  ];

  it('runs in the first ready replica by name', async () => {
    const fake = cluster(pods);

    await expect(
      output(
        await createDeploymentExec(fake)(deployment, 'echo ran', undefined),
      ),
    ).resolves.toEqual({ code: 0, stdout: 'ran\n', stderr: '' });
    expect(fake.exec.mock.calls[0]![1]).toBe('r-1');
  });

  it('runs in the replica --replica names, Ready or not', async () => {
    const fake = cluster(pods);

    await expect(
      output(await createDeploymentExec(fake)(deployment, 'exit 4', 'r-0')),
    ).resolves.toEqual({ code: 4, stdout: '', stderr: '' });
    expect(fake.exec.mock.calls[0]![1]).toBe('r-0');
  });

  it.each([
    ['an unknown --replica', pods, 'r-9'],
    ['no ready replica', [pod('r-0', 'uid-0', false)], undefined],
  ])('refuses %s, naming the running replicas', async (_, items, replica) => {
    const fake = cluster(items);

    const prepared = await createDeploymentExec(fake)(
      deployment,
      'true',
      replica,
    );

    expect(prepared).toMatchObject({ ok: false, status: 409 });
    expect(!prepared.ok && prepared.clientError).toContain('r-0');
    expect(fake.exec).not.toHaveBeenCalled();
  });

  it("refuses a pool Job's managed Deployment, whose replica runs other Jobs", async () => {
    const fake = cluster(pods);

    await expect(
      createDeploymentExec(fake)(
        { ...deployment, managed: true },
        'true',
        undefined,
      ),
    ).resolves.toMatchObject({ ok: false, status: 400 });
    expect(fake.listNamespacedPod).not.toHaveBeenCalled();
  });
});

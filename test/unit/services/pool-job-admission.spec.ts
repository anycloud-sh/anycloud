import packageJson from '../../../package.json' with { type: 'json' };
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { NodePoolServiceAdmissionInput } from '../../../src/api/services/node-pool-service-admission.js';
import {
  getPersistence,
  resetPersistence,
} from '../../../src/api/services/persistence.js';
import {
  submitPoolJob,
  type PoolJobAdmissionDependencies,
} from '../../../src/api/services/pool-job-admission.js';
import { createApiRpcDomains } from '../../../src/api/composition.js';
import { getDefaultDeploymentControl } from '../../../src/api/services/deployment-controller.js';
import { renderDeploymentObjects } from '../../../src/api/services/deployment-objects.js';
import { getDefaultNodePoolRuntime } from '../../../src/api/services/node-pool-runtime-default.js';
import { NodePoolReferencedError } from '../../../src/api/services/node-pool-errors.js';
import { getDB } from '../../../src/api/services/repositories/db.js';
import { persistPoolJob } from '../../../src/api/services/workload-admission-persistence.js';
import type { User } from '../../../src/api/services/entities.js';
import { ImageRuntime, ImageVerdict } from '../../../src/shared/image.js';
import { seedReadyNodePool } from '../helpers/node-pool-seed.js';
import { WorkloadState } from '../../../src/shared/workload.js';
import type { V1Pod } from '@kubernetes/client-node';
import { kubernetesWorkloadPodSelector } from '../../../src/api/services/kubernetes/identity.js';
import { observePoolRunners } from '../../../src/api/services/pool-runners.js';
import { makeClusterKubernetesClientFixture } from '../helpers/fixtures.js';

const actor: User = { id: 'owner', username: 'user', token: 'github-token' };
const digest = `sha256:${'a'.repeat(64)}`;

function dependencies(): PoolJobAdmissionDependencies {
  const persistence = getPersistence();
  return {
    nodePools: persistence.nodePools,
    resolveScope: async () => ({ kind: 'api' }),
    inspectImage: vi.fn(async () => ({
      verdict: ImageVerdict.Ok,
      amd64Digest: digest,
      imageRuntime: ImageRuntime.Unknown,
      compressedLayerBytes: null,
      entrypoint: ['/entrypoint.sh'],
      cmd: ['serve'],
    })),
    validateId: async (id) => id,
    preflightSecrets: vi.fn(async () => {}),
    admitStorage: vi.fn(async () => ({})),
    persist: persistPoolJob,
    schedule: vi.fn(),
  };
}

function job(
  overrides: Partial<NodePoolServiceAdmissionInput> = {},
): NodePoolServiceAdmissionInput {
  return {
    image: 'ghcr.io/acme/train:1',
    cloudConfig: {},
    nodePool: 'cpu-pool',
    command: ['python', 'train.py'],
    ...overrides,
  };
}

async function rows() {
  return getDB().query<{
    id: string;
    deployment_id: string;
    managed: number;
    grace: number;
    command: string | null;
  }>(
    `SELECT w.id, w.deployment_id, t.managed,
            t.grace_period_seconds AS grace, s.command
     FROM workloads w JOIN deployments t ON t.id = w.deployment_id
     JOIN container_specs s ON s.workload_id = w.id ORDER BY w.id`,
  );
}

describe('pool Job admission (RFC 0044 decision 26)', () => {
  beforeEach(async () => {
    resetPersistence();
    await seedReadyNodePool({
      nodePoolId: 'cpu-pool',
      ownerUserId: actor.id,
    });
  });

  it('runs Jobs of one image and shape on one managed Deployment and gives another shape its own', async () => {
    const deps = dependencies();
    const shape = { cpus: '1', memory: '1g' };
    await Promise.all([
      submitPoolJob(deps, actor, job({ id: 'a', dockerOptions: shape })),
      submitPoolJob(deps, actor, job({ id: 'b', dockerOptions: shape })),
    ]);
    await submitPoolJob(
      deps,
      actor,
      job({ id: 'c', command: undefined, dockerOptions: { cpus: '2' } }),
    );

    const [a, b, c] = await rows();
    // AWS's spot notice, for the runner's final upload.
    expect(a).toMatchObject({
      managed: 1,
      grace: 120,
      command: '["python","train.py"]',
    });
    expect(b!.deployment_id).toBe(a!.deployment_id);
    // Without a command the runner starts the image's Cmd, as Docker does.
    expect(c).toMatchObject({ managed: 1, command: null });
    expect(c!.deployment_id).not.toBe(a!.deployment_id);
    const deployments = await getDB().query(
      `SELECT t.id, t.gpu_count, t.max_concurrent_jobs_per_replica AS perReplica,
              s.entrypoint, s.command, s.docker_options AS options
       FROM deployments t JOIN container_specs s ON s.deployment_id = t.id
       ORDER BY t.created_at, t.id`,
    );
    expect(deployments).toEqual([
      {
        id: a!.deployment_id,
        gpu_count: 0,
        perReplica: 1,
        entrypoint: '["/entrypoint.sh"]',
        command: '["serve"]',
        options: JSON.stringify(shape),
      },
      {
        id: c!.deployment_id,
        gpu_count: 0,
        perReplica: 1,
        entrypoint: '["/entrypoint.sh"]',
        command: '["serve"]',
        options: '{"cpus":"2"}',
      },
    ]);
    expect(deps.schedule).toHaveBeenCalledTimes(3);
    const status =
      await getPersistence().workloadQueries.getWorkloadStatusForScope('a', {
        kind: 'api',
      });
    expect(status?.workload).toMatchObject({
      deploymentId: a!.deployment_id,
      nodePoolName: 'cpu-pool',
      image: 'ghcr.io/acme/train:1',
    });
  });

  it('makes the replica options part of the shape: /dev/shm and Secrets', async () => {
    await seedReadyNodePool({
      nodePoolId: 'gpu-pool',
      ownerUserId: actor.id,
      vmType: 'g4dn.12xlarge',
    });
    const deps = dependencies();
    const submitted: [string, Partial<NodePoolServiceAdmissionInput>][] = [
      ['plain', {}],
      ['shm', { dockerOptions: { shmSize: '8g' } }],
      // `--ipc host` sizes /dev/shm to the replica's memory request.
      ['ipc-memory', { dockerOptions: { ipc: 'host', memory: '2g' } }],
      ['ipc-cpu', { dockerOptions: { ipc: 'host' } }],
      ['ipc-cpus', { dockerOptions: { ipc: 'host', cpus: '0.1' } }],
      [
        'ipc-gpu',
        { nodePool: 'gpu-pool', dockerOptions: { ipc: 'host', gpus: '1' } },
      ],
      ['ipc-same', { dockerOptions: { ipc: 'host', shmSize: '8g' } }],
      ['shm-same', { dockerOptions: { shmSize: '8192m' } }],
      ['sized', { dockerOptions: { cpus: '0.5', memory: '8g' } }],
      ['sized-same', { dockerOptions: { cpus: '0.50', memory: '8192m' } }],
      ['secret', { secrets: ['github', 'hf'] }],
      ['secret-same', { secrets: ['hf', 'github', 'hf'] }],
    ];
    for (const [id, overrides] of submitted) {
      await submitPoolJob(deps, actor, job({ id, ...overrides }));
    }
    expect(deps.preflightSecrets).toHaveBeenCalledWith(['github', 'hf']);
    const shapes = await getDB().query<{
      id: string;
      deployment_id: string;
      options: string;
      secrets: string | null;
    }>(
      `SELECT w.id, w.deployment_id, s.docker_options AS options,
              t.secret_names AS secrets
       FROM workloads w JOIN deployments t ON t.id = w.deployment_id
       JOIN container_specs s ON s.deployment_id = t.id`,
    );
    expect(
      Object.fromEntries(
        shapes.map((row) => [row.id, `${row.options} ${row.secrets}`]),
      ),
    ).toEqual({
      plain: '{} null',
      shm: '{"shmSize":"8g"} null',
      'ipc-memory': '{"memory":"2g","shmSize":"2g"} null',
      // 1 vCPU of t3.small's 2, so half its 2 GiB, less K9's 10% headroom.
      'ipc-cpu': '{"shmSize":"921m"} null',
      // C30: with --cpus the request is the floored limit, 512 MiB, not the
      // 92 MiB share of 0.1 vCPU.
      'ipc-cpus': '{"cpus":"0.1","shmSize":"512m"} null',
      // A quarter of the VM's 192 GiB, less K9's 10% headroom.
      'ipc-gpu': '{"gpus":"1","shmSize":"44236m"} null',
      'ipc-same': '{"shmSize":"8g"} null',
      'shm-same': '{"shmSize":"8g"} null',
      sized: '{"cpus":"0.5","memory":"8g"} null',
      'sized-same': '{"cpus":"0.5","memory":"8g"} null',
      secret: '{} ["github","hf"]',
      'secret-same': '{} ["github","hf"]',
    });
    // Only the `-same` Jobs share a Deployment, with `shm`, `sized` and `secret`.
    const deployments = new Set(shapes.map((row) => row.deployment_id));
    expect(deployments.size).toBe(submitted.length - 4);
  });

  it('lets a Secret be deleted once no pool Job using it is live', async () => {
    await submitPoolJob(dependencies(), actor, job({ secrets: ['github'] }));
    const secrets = getPersistence().credentialSecrets;
    const [queued] = await rows();
    await expect(
      secrets.deleteSecretIfNotReferenced('github', false),
    ).resolves.toEqual({ deleted: false, blocking: [queued!.deployment_id] });
    await getDB().query("UPDATE workloads SET state = 'completed'");
    // The idle managed Deployment no longer holds it.
    await expect(
      secrets.deleteSecretIfNotReferenced('github', false),
    ).resolves.toEqual({ deleted: false, blocking: [] });
  });

  it('refuses a Secret that is not saved before storing the Job', async () => {
    const deps = dependencies();
    vi.mocked(deps.preflightSecrets).mockRejectedValue(
      new Error('Secret "github" does not exist'),
    );
    await expect(
      submitPoolJob(deps, actor, job({ secrets: ['github'] })),
    ).rejects.toThrow('Secret "github" does not exist');
    expect(await rows()).toEqual([]);
  });

  it("renews the managed Deployment's pull token from each admitted Job", async () => {
    const deps = dependencies();
    await submitPoolJob(deps, actor, job({ id: 'a' }));
    await submitPoolJob(
      deps,
      { ...actor, token: 'newer-token' },
      job({ id: 'b' }),
    );
    const [a] = await rows();
    const stored = await getPersistence().deployments.getById(a!.deployment_id);
    expect(stored?.config).toMatchObject({
      registryToken: 'newer-token',
      entrypoint: ['/entrypoint.sh'],
      command: ['serve'],
    });
  });

  it("RFC 0049 C29 gives a registered Deployment's Job its own managed Deployment, which renders no imagePullSecrets", async () => {
    const deps = dependencies();
    const shape = { cpus: '1', memory: '1g' };
    await submitPoolJob(
      deps,
      actor,
      job({ id: 'member', dockerOptions: shape }),
    );
    const client: User = {
      id: 'serviceaccount:backmesh/listener',
      username: 'backmesh/listener',
      token: null,
    };
    await submitPoolJob(
      deps,
      client,
      job({ id: 'client', dockerOptions: shape }),
    );
    await submitPoolJob(
      deps,
      actor,
      job({ id: 'member-2', dockerOptions: shape }),
    );

    const byId = Object.fromEntries((await rows()).map((row) => [row.id, row]));
    expect(byId['member-2']!.deployment_id).toBe(byId.member!.deployment_id);
    expect(byId.client!.deployment_id).not.toBe(byId.member!.deployment_id);
    const pullSecrets = async (id: string) => {
      const stored = await getPersistence().deployments.getById(id);
      return renderDeploymentObjects(
        stored!,
        'pool-namespace',
        'https://api.example.test',
        {
          clusterId: 'cluster-a',
          nodePoolId: 'cpu-pool',
          nvidiaGpusPerNode: 0,
        },
      ).kubernetesDeployment.spec!.template.spec!.imagePullSecrets;
    };
    // The member's replicas pull with the member's sign-in; the client's
    // carry none, so its Jobs reach no member's GitHub token.
    expect(await pullSecrets(byId.member!.deployment_id)).toHaveLength(1);
    expect(await pullSecrets(byId.client!.deployment_id)).toBeUndefined();
  });

  it('RFC 0049 C29 keeps one managed Deployment for a non-ghcr.io image, which no submitter pulls with a token', async () => {
    const deps = dependencies();
    const image = 'docker.io/acme/train:1';
    await submitPoolJob(deps, actor, job({ id: 'member', image }));
    await submitPoolJob(
      deps,
      {
        id: 'serviceaccount:backmesh/listener',
        username: 'backmesh/listener',
        token: null,
      },
      job({ id: 'client', image }),
    );

    const [client, member] = await rows();
    expect(client!.deployment_id).toBe(member!.deployment_id);
  });

  it('lets node-pool delete through once its pool Jobs have ended, taking its managed Deployments along', async () => {
    const deps = dependencies();
    await submitPoolJob(deps, actor, job({ id: 'a' }));
    const { nodePools } = createApiRpcDomains({});
    await expect(nodePools.delete(actor, 'cpu-pool')).rejects.toBeInstanceOf(
      NodePoolReferencedError,
    );
    await getDB().query(
      "UPDATE workloads SET state = 'terminated', completed_at = 1, cleaned_at = 1",
    );
    const schedule = vi.spyOn(getDefaultDeploymentControl(), 'schedule');
    await expect(nodePools.delete(actor, 'cpu-pool')).resolves.toMatchObject({
      nodePool: { releasing: true },
    });
    // The Deployment owner tears it down now, not at its next resync.
    const [a] = await rows();
    await vi.waitFor(() =>
      expect(schedule).toHaveBeenCalledWith(a!.deployment_id),
    );
    expect(
      await getDB().query(
        'SELECT deletion_requested_at IS NOT NULL AS draining FROM deployments',
      ),
    ).toEqual([{ draining: 1 }]);
  });

  it("still wakes the node pool's reconcile when the managed Deployment listing fails", async () => {
    const reconcile = vi
      .spyOn(getDefaultNodePoolRuntime().reconciler, 'schedule')
      .mockResolvedValue(undefined);
    vi.spyOn(
      getPersistence().deployments,
      'listDeletingManaged',
    ).mockRejectedValue(new Error('SQLITE_BUSY'));
    const { nodePools } = createApiRpcDomains({});
    await nodePools.delete(actor, 'cpu-pool');
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledWith('cpu-pool'));
  });

  it('replaces a draining managed Deployment instead of queueing behind it', async () => {
    const deps = dependencies();
    await submitPoolJob(deps, actor, job({ id: 'a' }));
    await getDB().query(
      'UPDATE deployments SET deletion_requested_at = created_at',
    );
    await submitPoolJob(deps, actor, job({ id: 'b' }));
    const [a, b] = await rows();
    expect(b!.deployment_id).not.toBe(a!.deployment_id);
  });

  it("keeps the Job's buckets on its row, outside the replica shape", async () => {
    const deps = dependencies();
    vi.mocked(deps.admitStorage).mockImplementation(async (_pool, input) => ({
      inputBucket: input.cloudConfig.inputBucket,
      checkpointBucket: input.cloudConfig.checkpointBucket,
      checkpointStorageRegion: 'eastus',
    }));
    const buckets = { inputBucket: 'in', checkpointBucket: 'ckpt' };
    await submitPoolJob(deps, actor, job({ id: 'a', cloudConfig: buckets }));
    await submitPoolJob(deps, actor, job({ id: 'b' }));
    expect(deps.admitStorage).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'cpu-pool' }),
      expect.objectContaining({ cloudConfig: buckets }),
      'a',
      actor.username,
    );
    expect(
      await getDB().query(
        `SELECT id, deployment_id, input_bucket, output_bucket, checkpoint_bucket,
                checkpoint_storage_region
         FROM workloads ORDER BY id`,
      ),
    ).toEqual([
      expect.objectContaining({
        id: 'a',
        input_bucket: 'in',
        output_bucket: null,
        checkpoint_bucket: 'ckpt',
        checkpoint_storage_region: 'eastus',
      }),
      expect.objectContaining({ id: 'b', input_bucket: null }),
    ]);
    // Buckets aren't the shape: both Jobs share one managed Deployment.
    const [a, b] = await rows();
    expect(a!.deployment_id).toBe(b!.deployment_id);
  });

  it('stores nothing when its storage is refused', async () => {
    const deps = dependencies();
    vi.mocked(deps.admitStorage).mockRejectedValue(
      new Error('The input bucket is on AWS'),
    );
    await expect(
      submitPoolJob(deps, actor, job({ cloudConfig: { inputBucket: 'in' } })),
    ).rejects.toThrow('The input bucket is on AWS');
    expect(await rows()).toEqual([]);
  });

  it.each([
    [{ cloudConfig: { region: 'us-east-1' } }, '--region'],
    [{ credentialName: 'aws' }, 'compute credentials'],
    [{ gpuType: 'h100' }, '--gpu-type'],
    [{ cloudConfig: { spot: true } }, '--spot'],
    [{ dockerOptions: { privileged: true } }, '--privileged'],
    [{ dockerOptions: { binds: ['/data'] } }, '--bind'],
    // The opt-in refusal comes before `--bind` syntax, as it did before that fix.
    [{ dockerOptions: { binds: ['ghcr.io/acme/app:1'] } }, '--bind'],
    [{ dockerOptions: { runtime: 'runc' } }, '--runtime'],
    [{ dockerOptions: { runtime: 'nvidia' } }, '--runtime'],
    [{ dockerOptions: { ipc: 'private' } }, '--ipc private'],
    [{ nodes: 2 }, '--nodes'],
    [{ timeLimit: 60 }, '--time-limit'],
  ] as const)('0044/S9 refuses %j naming the pool', async (overrides, flag) => {
    const deps = dependencies();
    await expect(
      submitPoolJob(
        deps,
        actor,
        job(overrides as Partial<NodePoolServiceAdmissionInput>),
      ),
    ).rejects.toThrow(
      expect.objectContaining({
        message: expect.stringMatching(
          new RegExp(`node pool "cpu-pool".*${flag.replace(/[-/]/g, '\\$&')}`),
        ),
      }),
    );
    expect(await rows()).toEqual([]);
  });

  it('admits --privileged and --bind on an --allow-privileged-jobs pool, each on a replica of its own', async () => {
    await getDB().query(
      "UPDATE node_pools SET allow_privileged_jobs = 1 WHERE id = 'cpu-pool'",
    );
    const deps = dependencies();
    const submitted: [string, Partial<NodePoolServiceAdmissionInput>][] = [
      ['plain', {}],
      ['privileged', { dockerOptions: { privileged: true } }],
      ['privileged-same', { dockerOptions: { privileged: true } }],
      ['bind', { dockerOptions: { binds: ['/var/lib/docker'] } }],
    ];
    for (const [id, overrides] of submitted) {
      await submitPoolJob(deps, actor, job({ id, ...overrides }));
    }
    const shapes = await getDB().query<{
      id: string;
      deployment_id: string;
      options: string;
    }>(
      `SELECT w.id, w.deployment_id, s.docker_options AS options
       FROM workloads w JOIN deployments t ON t.id = w.deployment_id
       JOIN container_specs s ON s.deployment_id = t.id ORDER BY w.id`,
    );
    expect(
      Object.fromEntries(shapes.map((row) => [row.id, row.options])),
    ).toEqual({
      plain: '{}',
      privileged: '{"privileged":true}',
      'privileged-same': '{"privileged":true}',
      bind: '{"binds":["/var/lib/docker"]}',
    });
    // A privileged Job never shares a replica with an unprivileged one.
    const byId = Object.fromEntries(
      shapes.map((row) => [row.id, row.deployment_id]),
    );
    expect(byId['privileged-same']).toBe(byId.privileged);
    expect(new Set(Object.values(byId)).size).toBe(3);
  });

  it('RFC 0049 C32 runs every Job on a --user-namespace-jobs pool in a user namespace, with --bind on a replica of its own', async () => {
    await getDB().query(
      "UPDATE node_pools SET user_namespace_jobs = 1 WHERE id = 'cpu-pool'",
    );
    const deps = dependencies();
    await submitPoolJob(deps, actor, job({ id: 'plain' }));
    await submitPoolJob(
      deps,
      actor,
      job({ id: 'bind', dockerOptions: { binds: ['/var/lib/docker'] } }),
    );
    const shapes = await getDB().query<{
      id: string;
      deployment_id: string;
      options: string;
    }>(
      `SELECT w.id, w.deployment_id, s.docker_options AS options
       FROM workloads w JOIN deployments t ON t.id = w.deployment_id
       JOIN container_specs s ON s.deployment_id = t.id ORDER BY w.id`,
    );
    expect(shapes.map(({ id, options }) => [id, options])).toEqual([
      ['bind', '{"userNamespace":true,"binds":["/var/lib/docker"]}'],
      ['plain', '{"userNamespace":true}'],
    ]);
    expect(new Set(shapes.map((row) => row.deployment_id)).size).toBe(2);
    // t3.small: 2 GiB less the kernel, the eviction threshold and the Pod
    // overhead.
    await expect(
      submitPoolJob(deps, actor, job({ dockerOptions: { memory: '1661m' } })),
    ).rejects.toThrow('admits --memory up to 1660m');
    await expect(
      submitPoolJob(deps, actor, job({ caches: ['pip:/root/.cache/pip'] })),
    ).rejects.toThrow('does not accept --cache');
    await expect(
      submitPoolJob(deps, actor, job({ dockerOptions: { privileged: true } })),
    ).rejects.toThrow('does not accept --privileged');
    await submitPoolJob(
      deps,
      actor,
      job({ id: 'largest', dockerOptions: { memory: '1660m' } }),
    );
  });

  it('RFC 0049 C12 mounts --cache from the Node on any pool, as part of the shape', async () => {
    const deps = dependencies();
    const submitted: [string, Partial<NodePoolServiceAdmissionInput>][] = [
      ['plain', {}],
      ['cache', { caches: ['pip:/root/.cache/pip', 'hf:/models/'] }],
      ['cache-same', { caches: ['hf:/models', 'pip:/root/.cache/pip'] }],
    ];
    for (const [id, overrides] of submitted) {
      await submitPoolJob(deps, actor, job({ id, ...overrides }));
    }
    const byId = Object.fromEntries((await rows()).map((row) => [row.id, row]));
    expect(byId['cache-same']!.deployment_id).toBe(byId.cache!.deployment_id);
    expect(byId.cache!.deployment_id).not.toBe(byId.plain!.deployment_id);

    const stored = await getPersistence().deployments.getById(
      byId.cache!.deployment_id,
    );
    const pod = renderDeploymentObjects(
      stored!,
      'pool-namespace',
      'https://api.example.test',
      { clusterId: 'cluster-a', nodePoolId: 'cpu-pool', nvidiaGpusPerNode: 0 },
    ).kubernetesDeployment.spec!.template.spec!;
    const [install] = pod.initContainers!;
    const [workload] = pod.containers;
    // One directory per pool and name on the Node, shared by the pool's Jobs
    // there; the root init container opens it to the image's user.
    expect(pod.volumes).toEqual(
      expect.arrayContaining([
        {
          name: 'cache-hf',
          hostPath: {
            path: '/var/lib/anycloud/node-cache/cpu-pool/hf',
            type: 'DirectoryOrCreate',
          },
        },
        {
          name: 'cache-pip',
          hostPath: {
            path: '/var/lib/anycloud/node-cache/cpu-pool/pip',
            type: 'DirectoryOrCreate',
          },
        },
      ]),
    );
    expect(install!.command![2]).toMatch(
      / && chmod 1777 \/caches\/hf && chmod 1777 \/caches\/pip$/,
    );
    expect(install!.volumeMounts).toContainEqual({
      name: 'cache-hf',
      mountPath: '/caches/hf',
    });
    expect(workload!.volumeMounts).toEqual(
      expect.arrayContaining([
        { name: 'cache-hf', mountPath: '/models' },
        { name: 'cache-pip', mountPath: '/root/.cache/pip' },
      ]),
    );
    // The runner's reset leaves the caches alone.
    expect(workload!.env).toContainEqual({
      name: 'ANYCLOUD_RUNNER_CACHES',
      value: '["/models","/root/.cache/pip"]',
    });

    for (const caches of [
      ['Pip:/cache'],
      ['pip:cache'],
      ['pip:/a', 'pip:/b'],
      ['pip:/a', 'hf:/a/b'],
      // The runner empties or owns these between Jobs.
      ['pip:/tmp/pip'],
      ['out:/mnt/output'],
      ['mnt:/mnt'],
      ['dev:/dev/cache'],
      ['root:/'],
    ]) {
      await expect(submitPoolJob(deps, actor, job({ caches }))).rejects.toThrow(
        /--cache|volume/,
      );
    }
    expect(await rows()).toHaveLength(submitted.length);
  });

  it('0044/S9 needs --gpus on a GPU pool', async () => {
    await seedReadyNodePool({
      nodePoolId: 'gpu-pool',
      ownerUserId: actor.id,
      vmType: 'g4dn.12xlarge',
    });
    const deps = dependencies();
    await expect(
      submitPoolJob(deps, actor, job({ nodePool: 'gpu-pool' })),
    ).rejects.toThrow('Jobs on node pool "gpu-pool" need --gpus N (1 to 4).');
    await submitPoolJob(
      deps,
      actor,
      job({ id: 'a', nodePool: 'gpu-pool', dockerOptions: { gpus: '1' } }),
    );
    expect(await getDB().query('SELECT gpu_count FROM deployments')).toEqual([
      { gpu_count: 1 },
    ]);
  });

  it('--timeout bounds the wait for the first claim', async () => {
    const admitted = await submitPoolJob(
      dependencies(),
      actor,
      job({ id: 'timed', timeout: 90 }),
      undefined,
      1_000,
    );
    expect(admitted.claimDeadlineAt).toBe(91_000);
    expect(
      await getDB().query(
        "SELECT claim_deadline_at FROM workloads WHERE id = 'timed'",
      ),
    ).toEqual([{ claim_deadline_at: 91_000 }]);
  });
});

describe('pool Job lifecycle on its managed Deployment', () => {
  const runtime = (deploymentId: string, podUid = 'pod-a') => ({
    deploymentId,
    generation: 1,
    podUid,
    containerId: 'containerd://a',
    ready: true,
  });

  async function admit(id: string): Promise<string> {
    await submitPoolJob(dependencies(), actor, job({ id }));
    const [row] = await getDB().query<{ deployment_id: string }>(
      'SELECT deployment_id FROM workloads WHERE id = ?',
      [id],
    );
    return row!.deployment_id;
  }

  /** SLOT prices a claim from its replica's share, so replicas are bound. */
  async function bind(deploymentId: string): Promise<void> {
    const vm = await getPersistence().nodePoolVms.beginVmAttempt('cpu-pool', {
      cloudId: 'node-a',
      region: 'us-east-1',
      availabilityZone: null,
      vmType: 't3.large',
      pricePerHour: 1,
      desiredVmCount: 1,
    });
    const pods = ['pod-a', 'pod-b'];
    await getPersistence().deployments.recordOccupancy(
      deploymentId,
      pods.map((podUid) => ({
        podUid,
        vmId: vm!.vmRowId,
        share: 0.5,
        gpus: 0,
      })),
      pods,
    );
  }

  async function claim(deploymentId: string): Promise<string> {
    await bind(deploymentId);
    const executions = getPersistence().deploymentExecutions;
    const found = await executions.discoverTargetedJob(runtime(deploymentId));
    if (found.kind !== 'candidate') throw new Error(found.kind);
    const executionId = crypto.randomUUID();
    const claimed = await executions.claimTargetedJob({
      ...runtime(deploymentId),
      ...found.candidate,
      executionId,
    });
    expect(claimed.kind).toBe('selected');
    return executionId;
  }

  beforeEach(async () => {
    resetPersistence();
    await seedReadyNodePool({ nodePoolId: 'cpu-pool', ownerUserId: actor.id });
  });

  it("decision 30 holds a managed Deployment's claims while api upgrade drains and lists what runs", async () => {
    const deploymentId = await admit('running');
    const executionId = await claim(deploymentId);
    await submitPoolJob(dependencies(), actor, job({ id: 'held' }));
    const executions = getPersistence().deploymentExecutions;
    executions.pauseManagedClaims(Date.now() + 60_000);
    expect(
      await executions.discoverTargetedJob(runtime(deploymentId, 'pod-b')),
    ).toEqual({ kind: 'full' });
    expect(await getPersistence().poolJobs.inFlight()).toEqual([
      {
        id: 'running',
        state: WorkloadState.Syncing,
        deploymentId,
        nodePoolId: 'cpu-pool',
        nodePool: 'cpu-pool',
        executionId,
        podUid: 'pod-a',
        runnerRelease: packageJson.version,
      },
    ]);
    executions.pauseManagedClaims(Date.now() - 1);
    expect(
      (await executions.discoverTargetedJob(runtime(deploymentId, 'pod-b')))
        .kind,
    ).toBe('candidate');
  });

  it("reads a pool Job's log window: its replica and claim, then the tail kept", async () => {
    const deploymentId = await admit('logged');
    expect(await getPersistence().poolJobs.logWindow('logged')).toEqual({
      managed: true,
      deploymentId,
      nodePoolId: 'cpu-pool',
      state: WorkloadState.Queued,
      attempt: null,
    });
    const executionId = await claim(deploymentId);
    await getPersistence().deploymentExecutions.recordAttemptLogTail(
      executionId,
      { state: 'captured', text: 'done\n' },
    );
    expect(await getPersistence().poolJobs.logWindow('logged')).toMatchObject({
      state: WorkloadState.Syncing,
      attempt: {
        podUid: 'pod-a',
        openedAt: expect.any(Number),
        endedAt: null,
        tail: { state: 'captured', text: 'done\n' },
      },
    });
  });

  it('fails as invalid only the queued Jobs submitted before a replica that cannot run', async () => {
    const deploymentId = await admit('old');
    await getDB().query(
      "UPDATE workloads SET submitted_at = 1 WHERE id = 'old'",
    );
    await submitPoolJob(dependencies(), actor, job({ id: 'new' }));
    await getPersistence().deploymentExecutions.terminateUnassignedTargetedJobs(
      deploymentId,
      { message: "The image can't be pulled: not found", before: 2 },
    );
    expect(
      await getDB().query('SELECT id, state FROM workloads ORDER BY id'),
    ).toEqual([
      { id: 'new', state: WorkloadState.Queued },
      { id: 'old', state: WorkloadState.Invalid },
    ]);
  });

  it('marks a managed Deployment for deletion only after 24 h with no Job', async () => {
    const deploymentId = await admit('recent');
    const store = getPersistence().deployments;
    const day = Date.now() + 1;
    // Still queued, so held whatever its age.
    expect(await store.requestIdleDeletion(deploymentId, day)).toBe(false);
    await getDB().query(
      "UPDATE workloads SET state = 'completed', completed_at = ? WHERE id = 'recent'",
      [day - 10],
    );
    expect(await store.requestIdleDeletion(deploymentId, day - 20)).toBe(false);
    expect(await store.requestIdleDeletion(deploymentId, day)).toBe(true);
    expect(
      (await store.getById(deploymentId))?.deletionRequestedAt,
    ).not.toBeNull();
  });

  it("counts the managed replicas busy, idle and Pending with why, and leaves a user Deployment's out", async () => {
    const managed = await admit('running');
    await claim(managed);
    const pods = [
      pod('pod-a', managed, 'ready'),
      pod('pod-b', managed, 'ready'),
      pod('waiting', managed, 'pending'),
      pod('starting', managed, 'starting'),
      pod('user', 'user-deployment', 'ready'),
    ];
    const runners = await observePoolRunners(
      {
        rows: (id) => getPersistence().poolJobs.runnerRows(id),
        runtimes: {
          resolve: vi.fn(async () => ({
            config: { namespace: 'anycloud-pool-a' },
            cluster: makeClusterKubernetesClientFixture({
              core: { listNamespacedPod: vi.fn(async () => ({ items: pods })) },
            }),
            nodePool: {
              clusterId: 'c',
              nodePoolId: 'pool-a',
              nvidiaGpusPerNode: 0,
            },
          })),
        },
        capBlock: async () => null,
      },
      'cpu-pool',
    );
    expect(runners).toEqual({
      busy: 1,
      idle: 1,
      pending: 2,
      reasons: ['0/1 nodes are available: insufficient cpu'],
    });
  });
});

function pod(
  uid: string,
  deploymentId: string,
  state: 'ready' | 'pending' | 'starting',
): V1Pod {
  const [label, value] = kubernetesWorkloadPodSelector(deploymentId).split('=');
  return {
    metadata: { uid, labels: { [label!]: value! } },
    spec: {
      containers: [],
      ...(state !== 'pending' && { nodeName: 'node-a' }),
    },
    status: {
      phase: state === 'ready' ? 'Running' : 'Pending',
      conditions:
        state === 'pending'
          ? [
              {
                type: 'PodScheduled',
                status: 'False',
                message: '0/1 nodes are available: insufficient cpu',
              },
            ]
          : [{ type: 'Ready', status: state === 'ready' ? 'True' : 'False' }],
    },
  };
}

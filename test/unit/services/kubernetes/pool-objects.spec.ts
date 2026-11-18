import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { StoredDeployment } from '../../../../src/api/services/deployment-store.js';
import { renderDeploymentObjects } from '../../../../src/api/services/deployment-objects.js';
import { buildNodePoolServiceManifests } from '../../../../src/api/services/kubernetes/service-workload.js';
import { kubernetesWorkloadIdentity } from '../../../../src/api/services/kubernetes/identity.js';
import {
  MANAGEMENT_TAINT_KEY,
  NODE_POOL_MEMBER_LABEL,
} from '../../../../src/api/services/kubernetes/node-pool-scheduling.js';
import {
  ANYCLOUD_POD_FINALIZER,
  podPendingReason,
  podTemplate,
  releasePodFinalizer,
} from '../../../../src/api/services/kubernetes/pool-objects.js';
import { makeContainerSpec } from '../../helpers/fixtures.js';

/**
 * Golden renders of the native Deployment, Pod template included, and its
 * owned Secrets, for both owners. An upgrade that changes a template
 * restarts every replica, so a diff here is a restart, not a refactor; RT10
 * made the Deployment's one drained restart (env Secret, K6, K9, finalizer).
 */
function golden(name: string): string {
  return readFileSync(
    new URL(`./golden/${name}.json`, import.meta.url),
    'utf8',
  );
}

/**
 * The API server decodes into typed objects, so key order is not part of what
 * a replica sees; array order is. Keys are sorted, arrays kept.
 */
function render(value: unknown): string {
  const sorted = (node: unknown): unknown =>
    Array.isArray(node)
      ? node.map(sorted)
      : node && typeof node === 'object'
        ? Object.fromEntries(
            Object.entries(node)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, child]) => [key, sorted(child)]),
          )
        : node;
  return `${JSON.stringify(sorted(value), null, 2)}\n`;
}

const deployment: StoredDeployment = {
  readinessProbe: null,
  gracePeriodSeconds: 30,
  id: 'target-a',
  ownerUserId: 'user-a',
  name: 'deployment',
  nodePoolId: 'node-pool-a',
  config: makeContainerSpec({ image: 'busybox:latest' }),
  secretNames: [],
  gpuCount: 0,
  maxConcurrentJobsPerReplica: 1,
  minReplicas: 1,
  maxReplicas: 1,
  managed: false,
  apiIdentity: false,
  runnerRelease: null,
  generation: 2,
  deletionRequestedAt: null,
  deletedAt: null,
  createdAt: 1,
  updatedAt: 2,
};
const pool = { clusterId: 'cluster-a', nodePoolId: 'node-pool-a' };
const gpuOptions = {
  gpus: '2',
  cpus: '4',
  memory: '8g',
  shmSize: '1g',
  binds: ['/scratch'],
};
const service = {
  workloadId: 'svc-a',
  userId: 'alice',
  registryUsername: 'alice',
  ...pool,
  capability: { nvidiaGpus: 0 },
  image: 'example/api:v1',
  imageDigest: null,
  command: null,
  env: null,
  registryToken: null,
  dockerOptions: null,
  secretsEnv: null,
};

describe('pool Pod templates', () => {
  it.each([
    [
      'deployment-cpu',
      () =>
        renderDeploymentObjects(deployment, 'pool-ns', 'https://api.example', {
          ...pool,
          nvidiaGpusPerNode: 0,
        }),
    ],
    [
      'deployment-gpu',
      () =>
        renderDeploymentObjects(
          {
            ...deployment,
            gpuCount: 2,
            secretNames: ['db'],
            readinessProbe: { exec: { command: ['ready'] }, periodSeconds: 5 },
            config: makeContainerSpec({
              image: 'ghcr.io/acme/model:v1',
              imageDigest: `sha256:${'a'.repeat(64)}`,
              command: ['serve', '--port', '8000'],
              env: { MODEL: 'small', GITHUB_TOKEN: 'user-value' },
              registryUsername: 'alice',
              registryToken: 'ghp_token',
              dockerOptions: gpuOptions,
            }),
          },
          'pool-ns',
          'https://api.example',
          { ...pool, nvidiaGpusPerNode: 4 },
          { DB_PASSWORD: 'secret' },
        ),
    ],
    ['service-cpu', () => buildNodePoolServiceManifests(service)],
    [
      'service-gpu',
      () =>
        buildNodePoolServiceManifests({
          ...service,
          capability: { nvidiaGpus: 4 },
          image: 'ghcr.io/acme/api:v1',
          imageDigest: `sha256:${'b'.repeat(64)}`,
          command: ['serve'],
          env: { PORT: '9000', MODE: 'prod' },
          registryToken: 'ghp_token',
          dockerOptions: gpuOptions,
          secretsEnv: { DB_PASSWORD: 'secret' },
        }),
    ],
  ])('%s renders byte-identically to its golden file', (name, build) => {
    const { kubernetesDeployment, secrets } = build();
    expect(render({ kubernetesDeployment, secrets })).toBe(golden(name));
  });
});

describe('podTemplate', () => {
  // RFC 0044 invariants 8, 9 and 15.
  it('runs the admitted digest and command unmodified, on the pool only, with every option off', () => {
    const digest = `sha256:${'c'.repeat(64)}`;
    const { template, secrets } = podTemplate({
      namespace: 'pool-ns',
      identity: kubernetesWorkloadIdentity({
        kind: 'deployment',
        workloadId: 'job-a',
        userId: 'alice',
      }),
      workloadName: 'Job',
      request: {
        workloadId: 'job-a',
        image: 'ghcr.io/acme/train:v1',
        imageDigest: digest,
        gpuCount: 0,
      },
      command: ['python', 'train.py', '--epochs', '3'],
      ...pool,
      capability: { nvidiaGpus: 0 },
    });
    const spec = template.spec!;
    expect(spec.restartPolicy).toBe('Always');
    expect(spec.containers).toHaveLength(1);
    expect(spec.containers[0]).toMatchObject({
      name: 'workload',
      image: `ghcr.io/acme/train@${digest}`,
      args: ['python', 'train.py', '--epochs', '3'],
    });
    expect(spec.containers[0]!.securityContext).toBeUndefined();
    expect(spec.containers[0]!.envFrom).toBeUndefined();
    expect(spec.serviceAccountName).toBeUndefined();
    expect(spec.automountServiceAccountToken).toBe(false);
    expect(spec.volumes).toBeUndefined();
    expect(secrets).toEqual([]);
    expect(spec.nodeSelector).toEqual({
      [NODE_POOL_MEMBER_LABEL]: pool.nodePoolId,
    });
    expect(
      spec.tolerations?.some((t) => t.key === MANAGEMENT_TAINT_KEY),
    ).not.toBe(true);
  });

  // RFC 0044 invariant 8: the runner starts the command after the image's
  // Entrypoint; the container runs only the runner.
  it('makes the runner the entrypoint under tini, with the fixed paths as emptyDirs', () => {
    const options: Parameters<typeof podTemplate>[0] = {
      namespace: 'pool-ns',
      identity: kubernetesWorkloadIdentity({
        kind: 'deployment',
        workloadId: 'managed-a',
        userId: 'alice',
      }),
      workloadName: 'Kubernetes Deployment',
      request: {
        workloadId: 'managed-a',
        image: 'ghcr.io/acme/train:v1',
        imageDigest: `sha256:${'c'.repeat(64)}`,
        gpuCount: 0,
      },
      command: null,
      ...pool,
      capability: { nvidiaGpus: 0 },
      runtimeIdentity: { serviceAccountName: 'sa', audience: 'anycloud' },
      gracePeriodSeconds: 120,
      runner: {
        installImage: 'ghcr.io/anycloud-sh/api:0.1.71',
        entrypoint: ['/usr/bin/env', 'python'],
        cmd: ['train.py'],
      },
    };
    const { template } = podTemplate(options);
    const spec = template.spec!;
    expect(spec.initContainers).toEqual([
      expect.objectContaining({
        name: 'runner-install',
        image: 'ghcr.io/anycloud-sh/api:0.1.71',
        volumeMounts: [{ name: 'anycloud-runner', mountPath: '/install' }],
      }),
    ]);
    const container = spec.containers[0]!;
    expect(container.command).toEqual([
      '/opt/anycloud-runner/tini',
      '--',
      '/opt/anycloud-runner/anycloud-runner',
    ]);
    expect(container.args).toBeUndefined();
    expect(container.env).toContainEqual({
      name: 'ANYCLOUD_RUNNER_ENTRYPOINT',
      value: '["/usr/bin/env","python"]',
    });
    expect(container.env).toContainEqual({
      name: 'ANYCLOUD_RUNNER_CMD',
      value: '["train.py"]',
    });
    expect(container.env).toContainEqual({
      name: 'ANYCLOUD_RUNNER_WORKDIR_COPY',
      value: '/opt/anycloud-workdir',
    });
    expect(
      container.volumeMounts?.filter(
        (mount) => mount.mountPath !== '/var/run/secrets/anycloud',
      ),
    ).toEqual([
      {
        name: 'anycloud-runner',
        mountPath: '/opt/anycloud-runner',
        readOnly: true,
      },
      { name: 'anycloud-workdir', mountPath: '/opt/anycloud-workdir' },
      { name: 'anycloud-input', mountPath: '/mnt/input' },
      { name: 'anycloud-output', mountPath: '/mnt/output' },
      { name: 'anycloud-checkpoint', mountPath: '/mnt/checkpoint' },
    ]);
    for (const name of ['runner', 'workdir', 'input', 'output', 'checkpoint']) {
      expect(spec.volumes).toContainEqual({
        name: `anycloud-${name}`,
        emptyDir: {},
      });
    }
    expect(() =>
      podTemplate({ ...options, runtimeIdentity: undefined }),
    ).toThrow(/runtime identity/);
  });
});

describe('releasePodFinalizer', () => {
  const pod = (finalizers?: string[]) => ({
    metadata: { namespace: 'ns', name: 'p', uid: 'u', finalizers },
  });

  it('removes only the anycloud entry, guarded by the UID and the entry, as a JSON patch', async () => {
    const patchNamespacedPod = vi.fn().mockResolvedValue({});
    await releasePodFinalizer(
      { patchNamespacedPod },
      pod(['other', ANYCLOUD_POD_FINALIZER]),
    );
    expect(patchNamespacedPod).toHaveBeenCalledOnce();
    const [request, options] = patchNamespacedPod.mock.calls[0]!;
    expect(request.body).toEqual([
      { op: 'test', path: '/metadata/uid', value: 'u' },
      {
        op: 'test',
        path: '/metadata/finalizers/1',
        value: ANYCLOUD_POD_FINALIZER,
      },
      { op: 'remove', path: '/metadata/finalizers/1' },
    ]);
    const headers: Record<string, string> = {};
    for (const middleware of options.middleware) {
      await middleware.pre({
        setHeaderParam: (k: string, v: string) => (headers[k] = v),
      });
    }
    expect(headers['Content-Type']).toBe('application/json-patch+json');
    for (const finalizers of [undefined, ['other']]) {
      await releasePodFinalizer({ patchNamespacedPod }, pod(finalizers));
    }
    expect(patchNamespacedPod).toHaveBeenCalledOnce();
  });

  it('leaves a Pod already gone or changed to its next event, and throws anything else', async () => {
    for (const code of [404, 409, 422]) {
      const patchNamespacedPod = vi.fn().mockRejectedValue({ code });
      await expect(
        releasePodFinalizer(
          { patchNamespacedPod },
          pod([ANYCLOUD_POD_FINALIZER]),
        ),
      ).resolves.toBeUndefined();
    }
    const patchNamespacedPod = vi.fn().mockRejectedValue({ code: 500 });
    await expect(
      releasePodFinalizer(
        { patchNamespacedPod },
        pod([ANYCLOUD_POD_FINALIZER]),
      ),
    ).rejects.toEqual({ code: 500 });
  });
});

describe('podPendingReason', () => {
  it('names a waiting container first, then why the Pod is unscheduled', () => {
    expect(podPendingReason(undefined)).toBeNull();
    expect(
      podPendingReason({
        status: {
          containerStatuses: [
            {
              name: 'workload',
              image: 'i',
              imageID: '',
              ready: false,
              restartCount: 0,
              state: { waiting: { reason: 'ErrImagePull', message: 'denied' } },
            },
          ],
          conditions: [
            { type: 'PodScheduled', status: 'False', reason: 'Unschedulable' },
          ],
        },
      }),
    ).toBe('ErrImagePull: denied');
    expect(
      podPendingReason({
        status: {
          conditions: [
            { type: 'Ready', status: 'False', reason: 'NotReady' },
            {
              type: 'PodScheduled',
              status: 'False',
              reason: 'Unschedulable',
              message: '0/2 nodes are available',
            },
          ],
        },
      }),
    ).toBe('0/2 nodes are available');
    expect(
      podPendingReason({
        status: { conditions: [{ type: 'PodScheduled', status: 'True' }] },
      }),
    ).toBeNull();
  });
});

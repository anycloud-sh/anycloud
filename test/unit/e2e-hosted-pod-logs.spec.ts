import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  HOSTED_LOG_NAMESPACES,
  readHelmState,
  readHostedPodLogs,
  withinDeadline,
} from '../integration/e2e/internal/substrates/cloud-cluster/hosted-pod-logs.js';

describe("e2e-cluster-cloud's hosted Pod logs", () => {
  afterEach(() => vi.useRealTimers());

  test("reads the hosted API's namespace, its own Traefik release's and kube-system's, current and previous", async () => {
    const listed: string[] = [];
    const core = {
      listNamespacedPod: vi.fn(async ({ namespace }: { namespace: string }) => {
        listed.push(namespace);
        return {
          items: [
            {
              metadata: { name: `helm-install-${namespace}` },
              status: {
                phase: 'Running',
                containerStatuses: [
                  {
                    name: 'main',
                    image: 'image',
                    imageID: '',
                    ready: true,
                    restartCount: 1,
                  },
                ],
              },
            },
            { metadata: { name: 'coredns-1' }, status: { phase: 'Running' } },
          ],
        };
      }),
      readNamespacedPodLog: vi.fn(
        async ({ previous }: { previous?: boolean }) => {
          if (previous) throw new Error('no previous run');
          return 'log line\n';
        },
      ),
    };

    const record = await readHostedPodLogs(core);

    expect(listed).toEqual([
      'anycloud-system',
      'anycloud-api-ingress',
      'kube-system',
    ]);
    expect(HOSTED_LOG_NAMESPACES).toEqual(listed);
    expect(record).toMatchObject([
      {
        namespace: 'anycloud-system',
        pods: [
          {
            name: 'helm-install-anycloud-system',
            containers: [
              {
                name: 'main',
                restartCount: 1,
                current: 'log line\n',
                previous: { unavailable: 'no previous run' },
              },
            ],
          },
          { name: 'coredns-1' },
        ],
      },
      { namespace: 'anycloud-api-ingress' },
      {
        namespace: 'kube-system',
        pods: [{ name: 'helm-install-kube-system' }],
      },
    ]);
    // Outside kube-system every Pod; inside it, helm-controller's alone.
    expect((record as { pods: unknown[] }[]).map((n) => n.pods.length)).toEqual(
      [2, 2, 1],
    );
  });

  test("reads each release namespace's helm Jobs, HelmCharts and release Secrets without their values, and says which read was refused", async () => {
    const releaseLabels = {
      name: 'anycloud-api',
      owner: 'helm',
      status: 'pending-install',
      version: '1',
    };
    const core = {
      listNamespacedSecret: vi.fn(
        async ({
          namespace,
        }: {
          namespace: string;
          fieldSelector?: string;
        }) => ({
          items: [
            {
              metadata: {
                name: `sh.helm.release.v1.${namespace}.v1`,
                labels: releaseLabels,
              },
              type: 'helm.sh/release.v1',
              data: { release: 'c2VjcmV0' },
            },
          ],
        }),
      ),
    };
    const batch = {
      listNamespacedJob: vi.fn(
        async ({ namespace }: { namespace: string }) => ({
          items: [
            {
              metadata: {
                name: `helm-install-${namespace}`,
                labels: { a: 'b' },
              },
              status: {
                failed: 3,
                conditions: [{ type: 'Failed', status: 'True' }],
              },
            },
          ],
        }),
      ),
    };
    const custom = {
      listNamespacedCustomObject: vi.fn(
        async ({ namespace }: { namespace: string }) => ({
          items: [
            {
              metadata: { name: namespace, generation: 2 },
              spec: {
                chart: 'oci://x',
                valuesContent: 'secret: no',
                set: { a: '1' },
              },
              status: { jobName: `helm-install-${namespace}` },
            },
          ],
        }),
      ),
    };
    const state = (namespace: string) => ({
      namespace,
      jobs: [
        {
          name: `helm-install-${namespace}`,
          labels: { a: 'b' },
          status: {
            failed: 3,
            conditions: [{ type: 'Failed', status: 'True' }],
          },
        },
      ],
      helmCharts: [
        {
          name: namespace,
          generation: 2,
          spec: { chart: 'oci://x' },
          status: { jobName: `helm-install-${namespace}` },
        },
      ],
      // Name and labels only: the release's data never reaches the record.
      releases: [
        { name: `sh.helm.release.v1.${namespace}.v1`, labels: releaseLabels },
      ],
    });
    // The API's chart in its own namespace, the ingress's in kube-system.
    expect(await readHelmState(core, batch, custom)).toEqual([
      state('anycloud-system'),
      state('kube-system'),
    ]);
    custom.listNamespacedCustomObject.mockRejectedValueOnce(
      new Error('helmcharts.helm.cattle.io is forbidden'),
    );
    expect(await readHelmState(core, batch, custom)).toMatchObject([
      { helmCharts: { unavailable: 'helmcharts.helm.cattle.io is forbidden' } },
      state('kube-system'),
    ]);
    expect(core.listNamespacedSecret).toHaveBeenCalledWith({
      namespace: 'kube-system',
      fieldSelector: 'type=helm.sh/release.v1',
    });
  });

  test('gives up on reads that never settle after the deadline, saying so', async () => {
    vi.useFakeTimers();
    const capture = withinDeadline(new Promise<never>(() => {}), 60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(capture).resolves.toEqual({
      unavailable: 'timed out after 60 s',
    });
  });
});

import { describe, expect, it, vi } from 'vitest';
import { makeClusterKubernetesClientFixture } from '../../helpers/fixtures.js';
import { load as parseYaml } from 'js-yaml';
import { CLOUDFLARE_IP_RANGES } from '../../../../src/shared/cloudflare-ips.js';
import {
  electIngressEntry,
  entryQuiet,
  INGRESS_ENTRY_NOT_READY_GRACE_MS,
  nodePoolNetwork,
  observePoolIngressRelease,
  POOL_INGRESS_ROUTE_LABEL,
  POOL_INGRESS_WORKLOAD_NAME,
  poolIngressReleaseName,
  setIngressEntryLabel,
} from '../../../../src/api/services/kubernetes/node-pool-ingress.js';
import type { NodePoolNodeObservation } from '../../../../src/api/services/kubernetes/node-pool-nodes.js';
import {
  INGRESS_ENTRY_NODE_LABEL,
  MANAGEMENT_TAINT_KEY,
  NODE_POOL_MEMBER_LABEL,
  NODE_POOL_NODE_LABEL,
} from '../../../../src/api/services/kubernetes/node-pool-scheduling.js';
import {
  buildPoolIngressHelmChart,
  POOL_INGRESS_CLUSTER_ADDON,
  poolIngressTraefikValues,
} from '../../../../src/api/services/kubernetes/cluster-addons.js';
import {
  helmJobName,
  TRAEFIK_CHART_VERSION,
} from '../../../../src/shared/api-ingress.js';
import { generateNodePoolId } from '../../../../src/shared/id-generator.js';

function node(
  vmRowId: number,
  overrides: Partial<NodePoolNodeObservation> = {},
): NodePoolNodeObservation {
  return {
    name: `n${vmRowId}`,
    vmRowId,
    ready: true,
    readyTransitionAt: null,
    allocatableGpus: 0,
    allocatable: {
      cpu: 0,
      memory: 0,
      'nvidia.com/gpu': 0,
      'ephemeral-storage': 0,
    },
    notReadyTaint: false,
    accelerator: null,
    member: true,
    ingressEntry: false,
    outdated: false,
    unusableGpu: false,
    scaleInStamp: null,
    uid: `u${vmRowId}`,
    ...overrides,
  };
}

const live = [
  { id: 3, ip: '203.0.113.3' },
  { id: 1, ip: '203.0.113.1' },
  { id: 2, ip: null },
];

describe('ingress entry election', () => {
  it('elects the lowest live attempt with a Ready Node and a public IP', () => {
    const nodeByVm = new Map([
      [1, node(1)],
      [2, node(2)],
      [3, node(3)],
    ]);
    expect(
      electIngressEntry({ currentVmId: null, live, nodeByVm, now: 1_000 }),
    ).toEqual({ vmId: 1, changed: true });
    // The attempt without a public IP is never the entry even when Ready.
    expect(
      electIngressEntry({
        currentVmId: null,
        live: live.filter((vm) => vm.id !== 1),
        nodeByVm,
        now: 1_000,
      }),
    ).toEqual({ vmId: 3, changed: true });
  });

  it('keeps the current entry while it is Ready or briefly NotReady, then re-elects', () => {
    const notReadyAt = 1_000_000;
    const nodeByVm = new Map([
      [1, node(1)],
      [3, node(3, { ready: false, readyTransitionAt: notReadyAt })],
    ]);
    expect(
      electIngressEntry({
        currentVmId: 3,
        live,
        nodeByVm,
        now: notReadyAt + INGRESS_ENTRY_NOT_READY_GRACE_MS - 1,
      }),
    ).toEqual({ vmId: 3, changed: false });
    expect(
      electIngressEntry({
        currentVmId: 3,
        live,
        nodeByVm,
        now: notReadyAt + INGRESS_ENTRY_NOT_READY_GRACE_MS,
      }),
    ).toEqual({ vmId: 1, changed: true });
    // A lower-numbered newcomer does not displace a healthy entry.
    expect(
      electIngressEntry({
        currentVmId: 3,
        live,
        nodeByVm: new Map([
          [1, node(1)],
          [3, node(3)],
        ]),
        now: 0,
      }),
    ).toEqual({ vmId: 3, changed: false });
  });

  it('keeps a live entry with no Ready replacement, drops one whose attempt ended', () => {
    // NotReady past the grace, but nothing else is Ready: stay, no churn.
    expect(
      electIngressEntry({
        currentVmId: 3,
        live,
        nodeByVm: new Map([
          [3, node(3, { ready: false, readyTransitionAt: 0 })],
        ]),
        now: INGRESS_ENTRY_NOT_READY_GRACE_MS * 10,
      }),
    ).toEqual({ vmId: 3, changed: false });
    expect(
      electIngressEntry({
        currentVmId: 9,
        live,
        nodeByVm: new Map([[1, node(1, { ready: false })]]),
        now: 0,
      }),
    ).toEqual({ vmId: null, changed: true });
    expect(
      electIngressEntry({
        currentVmId: null,
        live,
        nodeByVm: new Map(),
        now: 0,
      }),
    ).toEqual({ vmId: null, changed: false });
  });

  it('labels and unlabels the entry Node by exact UID with a merge patch', async () => {
    const patches: unknown[] = [];
    const patchNode = vi.fn(async (request: unknown) => {
      patches.push(request);
      return {};
    });
    await setIngressEntryLabel({ patchNode }, node(1), 'pool-a');
    await setIngressEntryLabel({ patchNode }, node(2), null);
    expect(patches).toEqual([
      {
        name: 'n1',
        body: {
          metadata: {
            uid: 'u1',
            labels: { [INGRESS_ENTRY_NODE_LABEL]: 'pool-a' },
          },
        },
      },
      {
        name: 'n2',
        body: {
          metadata: { uid: 'u2', labels: { [INGRESS_ENTRY_NODE_LABEL]: null } },
        },
      },
    ]);
  });
});

describe('ingress entry quiet', () => {
  const namespace = poolIngressReleaseName('pool-a');
  const ready = { conditions: [{ type: 'Ready', status: 'True' }] };
  const access =
    '203.0.113.9 - - [29/Oct/2026:04:44:18 +0000] "GET /health HTTP/1.1" 502 11 "-" "-" 7 "web@kubernetescrd" "-" 0ms';
  const spec = {
    containers: [{ name: 'traefik', args: ['--accesslog=true'] }],
  };
  function core(logs: Record<string, string>, traefikSpec = spec) {
    return {
      listPodForAllNamespaces: vi.fn(async () => ({
        items: [
          {
            metadata: { name: 'traefik', namespace },
            spec: traefikSpec,
            status: ready,
          },
          { metadata: { name: 'surge', namespace }, spec, status: {} },
          { metadata: { name: 'web', namespace: 'svc' }, spec, status: ready },
        ],
      })),
      readNamespacedPodLog: vi.fn(
        async ({ name }: { name: string }) => logs[name] ?? '',
      ),
    };
  }
  const input = { nodePoolId: 'pool-a', nodeName: 'n1', windowMs: 20_000 };

  it("is quiet only while the entry's Traefik logged no request in the window", async () => {
    const busy = core({
      traefik: `2026-10-29T04:44:18Z INF started\n${access}\n`,
    });
    await expect(entryQuiet(busy, input)).resolves.toBe(false);
    expect(busy.readNamespacedPodLog).toHaveBeenCalledExactlyOnceWith(
      { name: 'traefik', namespace, sinceSeconds: 20 },
      undefined,
    );
    // Traefik's own log lines, the Service's access log and a Pod that
    // never started serve no request at the entry.
    await expect(
      entryQuiet(
        core({
          traefik: '2026-10-29T04:44:18Z INF started\n',
          web: access,
          surge: access,
        }),
        input,
      ),
    ).resolves.toBe(true);
  });

  it('is never quiet for a Traefik without the access log or whose log fails to read', async () => {
    const old = core({}, { containers: [{ name: 'traefik', args: [] }] });
    await expect(entryQuiet(old, input)).resolves.toBe(false);
    expect(old.readNamespacedPodLog).not.toHaveBeenCalled();
    const unreadable = core({});
    unreadable.readNamespacedPodLog.mockRejectedValueOnce(new Error('EOF'));
    await expect(entryQuiet(unreadable, input)).resolves.toBe(false);
  });
});

describe('node pool network', () => {
  it('stays outbound-only until the pool hosts a Service, then admits the Cloudflare edge on 80 only', () => {
    expect(nodePoolNetwork({ hostsServices: false })).toEqual({
      ingress: [],
      denyPublicIngress: true,
    });
    const withServices = nodePoolNetwork({ hostsServices: true });
    expect(withServices.denyPublicIngress).toBe(true);
    expect(
      withServices.ingress.map((rule) => [rule.protocol, rule.port]),
    ).toEqual([['tcp', 80]]);
    for (const rule of withServices.ingress) {
      expect(rule.sourceRanges).toEqual(CLOUDFLARE_IP_RANGES);
      expect(rule.sourceRanges).not.toContain('0.0.0.0/0');
    }
  });
});

describe('pool ingress cluster add-on', () => {
  const need = { nvidiaGpus: 0, ingressNodePoolId: 'pool-a' };

  it('is needed only by pools that host Services and renders one pinned HelmChart per pool', () => {
    expect(POOL_INGRESS_CLUSTER_ADDON.neededBy({ nvidiaGpus: 0 })).toBe(false);
    expect(POOL_INGRESS_CLUSTER_ADDON.neededBy(need)).toBe(true);
    expect(() => POOL_INGRESS_CLUSTER_ADDON.resources('cluster-a')).toThrow(
      'needs the node pool',
    );
    const resources = POOL_INGRESS_CLUSTER_ADDON.resources('cluster-a', need);
    expect(resources).toHaveLength(1);
    const resource = resources[0];
    const name = poolIngressReleaseName('pool-a');
    expect(name).toMatch(/^pool-ingress-[0-9a-f]{12}$/);
    expect(poolIngressReleaseName('pool-b')).not.toBe(name);
    // helm-controller names the install Job, its `job-name` label value and
    // the release's objects after the HelmChart; each is a 63-byte name. Live
    // runs 1–3 never got a Job because the pool id was part of the name.
    const longest = generateNodePoolId('x'.repeat(100));
    for (const id of [longest, 'p'.repeat(63)]) {
      const release = poolIngressReleaseName(id);
      expect(helmJobName(release).length).toBeLessThanOrEqual(63 - 10);
      expect(release.length).toBeLessThanOrEqual(63);
      expect(POOL_INGRESS_WORKLOAD_NAME.length).toBeLessThanOrEqual(63);
    }
    expect(resource).toMatchObject({
      apiVersion: 'helm.cattle.io/v1',
      kind: 'HelmChart',
      apiResource: 'helmcharts',
      namespace: 'kube-system',
      name,
    });
    expect(resource.requiresRecreate(resource.desired)).toBe(false);
    const chart = buildPoolIngressHelmChart('cluster-a', 'pool-a');
    expect(chart.spec).toMatchObject({
      chart: 'traefik',
      repo: 'https://traefik.github.io/charts',
      version: TRAEFIK_CHART_VERSION,
      targetNamespace: name,
      createNamespace: true,
      // Without this the helm-install Job cannot schedule on any tainted
      // Node of the cluster (live run 1: nothing ever listened on the entry).
      bootstrap: true,
    });
    expect(chart.metadata?.labels).toMatchObject({
      'anycloud.sh/cluster': 'cluster-a',
      'anycloud.sh/addon': 'pool-ingress',
      [NODE_POOL_NODE_LABEL]: 'pool-a',
    });
    expect(
      POOL_INGRESS_CLUSTER_ADDON.permissions.map((rule) => rule.label),
    ).toEqual([
      'get helmcharts in kube-system',
      'create helmcharts in kube-system',
      'update helmcharts in kube-system',
      'delete helmcharts in kube-system',
    ]);
  });

  it("runs Traefik only on the pool's ingress entry Node, on host port 80, watching that pool's routes only", () => {
    type Values = Record<
      string,
      Record<string, unknown> & Record<string, Record<string, unknown>>
    >;
    const values = parseYaml(poolIngressTraefikValues('pool-a')) as Values & {
      tolerations: Array<Record<string, string>>;
    };
    expect(values.deployment.kind).toBe('DaemonSet');
    expect(values.nodeSelector).toEqual({
      [INGRESS_ENTRY_NODE_LABEL]: 'pool-a',
      [NODE_POOL_MEMBER_LABEL]: 'pool-a',
    });
    expect(values.tolerations).toEqual([
      {
        key: NODE_POOL_NODE_LABEL,
        operator: 'Equal',
        value: 'pool-a',
        effect: 'NoSchedule',
      },
    ]);
    for (const toleration of values.tolerations) {
      expect(toleration.key).not.toBe(MANAGEMENT_TAINT_KEY);
      expect(toleration.key).not.toBe('node-role.kubernetes.io/control-plane');
    }
    expect(values.ports.web).toMatchObject({
      hostPort: 80,
      expose: { default: true },
    });
    // Edge connections end, so the edge follows a hand-off's record,
    // and each request is logged, so the controller sees an entry go quiet.
    expect(values.ports.web).toMatchObject({
      transport: {
        keepAliveMaxTime: '10s',
        lifeCycle: { requestAcceptGraceTimeout: '10s' },
      },
    });
    expect(values.logs).toEqual({ access: { enabled: true } });
    expect(values.ports.websecure).toEqual({ expose: { default: false } });
    expect(values.ports.traefik).toEqual({ expose: { default: false } });
    expect(values.service.type).toBe('ClusterIP');
    expect(values.ingressRoute.dashboard.enabled).toBe(false);
    expect(values.providers.kubernetesCRD).toEqual({
      enabled: true,
      labelSelector: `${POOL_INGRESS_ROUTE_LABEL}=pool-a`,
    });
    expect(values.providers.kubernetesIngress.enabled).toBe(false);
  });
});

describe('pool ingress release observation', () => {
  const release = {
    name: poolIngressReleaseName('p-abc'),
    nodePoolId: 'p-abc',
    entryNodeReady: true,
  };
  const gone = Object.assign(new Error('not found'), { code: 404 });
  /** A cluster holding the given objects; anything else reads as 404. */
  function cluster(objects: {
    chart?: boolean;
    job?: object;
    pod?: object;
    daemonSet?: object;
    events?: Array<{ namespace: string; name: string; text: string }>;
    eventsUnreadable?: boolean;
    /** Labelled IngressRoutes on the cluster; undefined = CRD not installed (404). */
    routes?: number;
  }) {
    const or404 = (value: object | undefined) =>
      value ? Promise.resolve(value) : Promise.reject(gone);
    return makeClusterKubernetesClientFixture({
      objects: {
        read: vi
          .fn()
          .mockImplementation(({ kind }: { kind?: string }) =>
            kind === 'HelmChart'
              ? or404(objects.chart ? {} : undefined)
              : or404(objects.job),
          ),
        list: vi
          .fn()
          .mockImplementation(() =>
            objects.routes === undefined
              ? Promise.reject(gone)
              : Promise.resolve({ items: Array(objects.routes).fill({}) }),
          ),
      },
      apps: {
        readNamespacedDaemonSet: vi
          .fn()
          .mockImplementation(() => or404(objects.daemonSet)),
      },
      core: {
        listNamespacedPod: vi
          .fn()
          .mockResolvedValue({ items: objects.pod ? [objects.pod] : [] }),
        listNamespacedEvent: vi
          .fn()
          .mockImplementation(async ({ namespace }: { namespace: string }) => ({
            items: objects.eventsUnreadable
              ? (undefined as never)
              : (objects.events ?? [])
                  .filter((event) => event.namespace === namespace)
                  // The client hands back ISO strings on this path and `Date`s
                  // on others (live run 4: `getTime is not a function`); a
                  // garbage value must not break the reading either.
                  .map((event, index) => ({
                    involvedObject: { name: event.name },
                    reason: 'Observed',
                    message: event.text,
                    lastTimestamp: [
                      new Date(1_000 + index).toISOString(),
                      new Date(1_000 + index),
                      'not a time',
                    ][index % 3],
                  })),
          })),
      },
    });
  }

  it('reports absent, installing, failed and installed shapes from the cluster objects', async () => {
    const jobName = helmJobName(release.name);
    await expect(
      observePoolIngressRelease(cluster({}), release),
    ).resolves.toEqual({
      state: 'absent',
      helmJob: null,
      daemonSet: null,
      lastEvent: null,
      routes: 0,
    });
    // No Job yet: the newest event on the Job or its Pods says why.
    await expect(
      observePoolIngressRelease(
        cluster({
          chart: true,
          events: [
            { namespace: 'kube-system', name: 'other', text: 'unrelated' },
            { namespace: 'kube-system', name: `${jobName}-x1`, text: 'older' },
            {
              namespace: 'kube-system',
              name: `${jobName}-x1`,
              text: 'garbage time',
            },
            {
              namespace: 'kube-system',
              name: `${jobName}-x1`,
              text: 'untolerated taint',
            },
          ],
        }),
        release,
      ),
    ).resolves.toEqual({
      state: 'installing',
      helmJob: { phase: 'pending', message: null },
      daemonSet: null,
      lastEvent: 'Observed: untolerated taint',
      routes: 0,
    });
    // Events only explain the rest: an unreadable list degrades to null.
    await expect(
      observePoolIngressRelease(
        cluster({
          chart: true,
          job: { status: { active: 1 } },
          eventsUnreadable: true,
        }),
        release,
      ),
    ).resolves.toMatchObject({
      state: 'installing',
      helmJob: { phase: 'running' },
      lastEvent: null,
    });
    await expect(
      observePoolIngressRelease(
        cluster({
          chart: true,
          job: { status: { failed: 1 } },
          pod: {
            status: {
              containerStatuses: [
                {
                  state: {
                    terminated: { exitCode: 1, message: 'chart not found' },
                  },
                },
              ],
            },
          },
        }),
        release,
      ),
    ).resolves.toMatchObject({
      state: 'failed',
      helmJob: { phase: 'failed', message: 'exit 1: chart not found' },
    });
    await expect(
      observePoolIngressRelease(
        cluster({
          chart: true,
          job: { status: { succeeded: 1 } },
          daemonSet: { status: { desiredNumberScheduled: 1, numberReady: 0 } },
          routes: 2,
          events: [
            {
              namespace: release.name,
              name: 'pool-ingress-abc',
              text: 'Pulling image',
            },
          ],
        }),
        { ...release, entryNodeReady: false },
      ),
    ).resolves.toEqual({
      state: 'installed',
      helmJob: { phase: 'succeeded', message: null },
      daemonSet: { desired: 1, ready: 0, entryNodeReady: false },
      lastEvent: 'Observed: Pulling image',
      routes: 2,
    });
  });
});

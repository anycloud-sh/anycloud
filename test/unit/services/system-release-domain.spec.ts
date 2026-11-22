import { systemReleaseStatusSchema } from '../../../src/shared/api-contract/system-release-schemas.js';
import { beforeEach, describe, expect, it } from 'vitest';
import type { User } from '../../../src/api/services/entities.js';
import BetterSqlite3 from 'better-sqlite3';
import * as semver from 'semver';
import packageJson from '../../../package.json' with { type: 'json' };
import { runMigrations } from '../../../src/api/services/repositories/migrations.js';
import {
  getPersistence,
  resetPersistence,
} from '../../../src/api/services/persistence.js';
import { ClusterReleaseConflictError } from '../../../src/api/services/cluster-errors.js';
import {
  assessReleaseTarget,
  createSystemReleaseDomain,
  SystemReleaseRefusedError,
  SystemReleaseStaleError,
  SystemReleaseUnavailableError,
  type SystemReleaseDomainDependencies,
} from '../../../src/api/services/system-release-domain.js';
import { type HelmChartObject } from '../../../src/shared/system-release-values.js';
import {
  RELEASE_INSTALLATION_ANNOTATION,
  RELEASE_OPERATION_ANNOTATION,
  RELEASE_REVISION_ANNOTATION,
} from '../../../src/shared/system-release.js';
import type { HookJobObservation } from '../../../src/api/services/system-release/ready-job.js';
import { apiIngressHelmChart } from '../../../src/shared/api-ingress.js';
import type {
  HostStepObservation,
  HostStepRequest,
} from '../../../src/api/services/system-release/host-step.js';
import { ClusterReleaseState } from '../../../src/shared/clusters.js';
import { WorkloadState } from '../../../src/shared/workload.js';
import { SYSTEM_RELEASE_HELM_JOB_IMAGE } from '../../../src/shared/system-release.js';

const owner: User = { id: '4242', username: 'owner', token: 't' };
const peer: User = { id: '7', username: 'peer', token: 'p' };
const image = (version: string, fill: string) =>
  `ghcr.io/anycloud-sh/api:${version}@sha256:${fill.repeat(64)}`;
const chartOf = (fill: string) =>
  `oci://ghcr.io/anycloud-sh/api-k8-chart@sha256:${fill.repeat(64)}`;
const INSTALLATION = 'install-production-1';

function installedChart(
  revision: number,
  operationId: string,
): HelmChartObject {
  return {
    apiVersion: 'helm.cattle.io/v1',
    kind: 'HelmChart',
    metadata: {
      name: 'anycloud-api',
      namespace: 'anycloud-system',
      resourceVersion: '100',
      annotations: {
        [RELEASE_REVISION_ANNOTATION]: String(revision),
        [RELEASE_OPERATION_ANNOTATION]: operationId,
        [RELEASE_INSTALLATION_ANNOTATION]: INSTALLATION,
      },
    },
    spec: {
      chart: chartOf('a'),
      targetNamespace: 'anycloud-system',
      createNamespace: true,
      jobImage: SYSTEM_RELEASE_HELM_JOB_IMAGE,
      bootstrap: true,
      failurePolicy: 'abort',
      backOffLimit: 0,
      timeout: '600s',
      valuesContent: JSON.stringify({
        release: {
          revision,
          operationId,
          image: image('0.1.64', 'a'),
          version: '0.1.64',
        },
        installation: {
          id: INSTALLATION,
          apiUrl: 'https://install-production-1.anycloud.sh',
        },
        cluster: { joinEndpoint: 'https://203.0.113.5:6443' },
        backup: { bucket: 'api-backups' },
      }),
    },
  };
}

/** The installed Traefik HelmChart, its spec this image's with `overrides`. */
function ingressChartWith(overrides: Record<string, unknown>): HelmChartObject {
  const installed = installedChart(1, 'op-bootstrap');
  return {
    ...installed,
    spec: {
      ...installed.spec,
      ...apiIngressHelmChart().spec,
      ...overrides,
    },
  };
}

describe('system release domain (hosted, industry pattern)', () => {
  let chart: HelmChartObject | null;
  let ingressChart: HelmChartObject | null;
  let events: string[];
  let applied: Array<{ chart: HelmChartObject; precondition: string | null }>;
  let conflicts: number;
  let schemaVersion: string | null;
  let deps: SystemReleaseDomainDependencies;
  let readyJob: HookJobObservation | null;
  let guardJob: HookJobObservation | null;
  let readyJobReads: string[];
  let managementLabel: boolean | null;
  let hostStepRuns: HostStepRequest[];
  let hostStep: HostStepObservation | null;

  beforeEach(async () => {
    readyJob = { outcome: 'succeeded' };
    managementLabel = true;
    hostStepRuns = [];
    hostStep = null;
    guardJob = null;
    readyJobReads = [];
    resetPersistence();
    const persistence = getPersistence();
    // The hosted API's own record carries the installation id.
    await persistence.clusters.recordSelf({
      id: INSTALLATION,
      ownerUserId: owner.id,
      name: 'production',
      kubernetesIdentity: 'uid-cluster-a',
      connection: JSON.stringify({
        kind: 'in-cluster',
        // service-terminology-ok: kubeconfig's own field name for the API endpoint
        server: 'https://203.0.113.5:6443',
        certificateAuthorityData: 'Y2E=',
      }),
    });
    chart = installedChart(1, 'op-bootstrap');
    ingressChart = null;
    events = [];
    applied = [];
    conflicts = 0;
    schemaVersion = '0.1.64';
    deps = {
      identity: { installationId: INSTALLATION },
      intents: persistence.systemReleases,
      clusterRecords: persistence.clusterRecords,
      parseConnection: (serialized) =>
        JSON.parse(serialized) as ReturnType<
          SystemReleaseDomainDependencies['parseConnection']
        >,
      releases: {
        getHelmChart: async (_connection, name) =>
          name === 'anycloud-api-ingress' ? ingressChart : chart,
        applyObject: async (_connection, object) => {
          events.push(`apply:${object.metadata.name}`);
          ingressChart = {
            ...ingressChart!,
            spec: object.spec as HelmChartObject['spec'],
          };
        },
        applyHelmChart: async (_connection, desired, precondition) => {
          events.push('patch');
          if (conflicts > 0) {
            conflicts -= 1;
            throw new ClusterReleaseConflictError();
          }
          applied.push({ chart: desired, precondition });
          chart = {
            ...desired,
            metadata: { ...desired.metadata, resourceVersion: '101' },
          };
        },
      },
      isConflict: (error): error is ClusterReleaseConflictError =>
        error instanceof ClusterReleaseConflictError,
      servedVersion: '0.1.64',
      schemaVersion: async () => schemaVersion,
      backup: {
        run: async (reason) => {
          events.push(`backup:${reason}`);
          return '2026-11-04T18:12:03.000Z';
        },
      },
      resolveApiImage: async (reference) => {
        if (
          reference === 'ghcr.io/anycloud-sh/api:0.1.65' ||
          reference === image('0.1.65', 'b')
        ) {
          return { digest: `sha256:${'b'.repeat(64)}`, chart: chartOf('b') };
        }
        if (reference === image('0.1.67', 'e')) {
          throw new Error(`The API image ${reference} names no chart`);
        }
        throw new Error(`manifest unknown for ${reference}`);
      },
      observeRollout: async () => ({
        observedGeneration: 3,
        replicas: 1,
        updatedReplicas: 1,
        readyReplicas: 1,
        conditions: [
          { type: 'Available', status: 'True', reason: null, message: null },
        ],
      }),
      observeManagementLabel: async () => managementLabel,
      hostSteps: {
        run: async (request) => {
          hostStepRuns.push(request);
          return (
            hostStep ?? {
              state: 'running',
              id: request.id,
              startedAt: null,
              waiting: null,
            }
          );
        },
        get: async (_kind, id) => (hostStep?.id === id ? hostStep : null),
        latest: async () => {
          if (hostStep?.id === 'unreadable')
            throw new Error('API server restarting');
          return hostStep;
        },
      },
      observeHookJob: async (name) => {
        readyJobReads.push(name);
        return name.startsWith('anycloud-api-guard-') ? guardJob : readyJob;
      },
      ownChart: chartOf('a'),
      generateOperationId: () => 'rel-1',
      selfDelete: null,
      log: { info: () => {}, warn: () => {} },
    };
  });

  const domain = () => createSystemReleaseDomain(deps);

  it('backs the database up before patching the HelmChart, records the intent first and bumps the revision', async () => {
    const { upgrade } = await domain().request(peer, {
      image: image('0.1.65', 'b'),
    });
    expect(events).toEqual(['backup:release rel-1', 'patch']);
    expect(upgrade).toMatchObject({
      number: 1,
      apiVersion: '0.1.65',
      apiImage: image('0.1.65', 'b'),
      state: WorkloadState.Starting,
    });
    await expect(
      getPersistence().systemReleases.get('rel-1'),
    ).resolves.toMatchObject({
      revision: 2,
      requestedByUserId: peer.id,
      state: ClusterReleaseState.Applied,
    });
    const [write] = applied;
    expect(write.precondition).toBe('100');
    expect(write.chart.metadata.annotations).toMatchObject({
      [RELEASE_REVISION_ANNOTATION]: '2',
      [RELEASE_OPERATION_ANNOTATION]: 'rel-1',
      [RELEASE_INSTALLATION_ANNOTATION]: INSTALLATION,
    });
    const values = JSON.parse(write.chart.spec.valuesContent) as {
      release: Record<string, unknown>;
      backup: unknown;
    };
    expect(values.release).toEqual({
      revision: 2,
      operationId: 'rel-1',
      image: image('0.1.65', 'b'),
      version: '0.1.65',
    });
    // Everything but the release block (backup values) is kept.
    expect(values.backup).toEqual({ bucket: 'api-backups' });
    // One write moves the chart with the image: Helm renders once.
    expect(write.chart.spec).toEqual({
      ...installedChart(1, 'op-bootstrap').spec,
      chart: chartOf('b'),
      chartContent: null,
      valuesContent: write.chart.spec.valuesContent,
    });
    expect((write.chart as { status?: unknown }).status).toBeUndefined();
  });

  it('replaces the inline chart of a release before 0.1.68 with the target chart', async () => {
    chart!.spec = { ...chart!.spec, chart: '', chartContent: 'Y2hhcnQ=' };
    await domain().request(peer, { image: image('0.1.65', 'b') });
    expect(applied[0].chart.spec).toMatchObject({
      chart: chartOf('b'),
      chartContent: null,
    });
  });

  it('refuses an image that names no chart before recording or backing up anything', async () => {
    await expect(
      domain().request(owner, { image: image('0.1.67', 'e') }),
    ).rejects.toThrow(
      `Release refused: The API image ${image('0.1.67', 'e')} names no chart`,
    );
    expect(events).toEqual([]);
    await expect(getPersistence().systemReleases.latest()).resolves.toBeNull();
  });

  it("pins this CLI's release tag to its published digest, and names the failure when none is published", async () => {
    const { upgrade } = await domain().request(peer, {
      image: 'ghcr.io/anycloud-sh/api:0.1.65',
    });
    expect(upgrade!.apiImage).toBe(image('0.1.65', 'b'));
    expect(JSON.parse(applied[0].chart.spec.valuesContent).release.image).toBe(
      image('0.1.65', 'b'),
    );
    await expect(
      domain().request(peer, { image: 'ghcr.io/anycloud-sh/api:0.1.99' }),
    ).rejects.toThrow(
      'no published API image for version 0.1.99 (manifest unknown for ghcr.io/anycloud-sh/api:0.1.99)',
    );
    expect(applied).toHaveLength(1);
  });

  it('aborts before the HelmChart patch when the backup fails, leaving the intent failed', async () => {
    deps.backup = {
      run: async () => {
        events.push('backup');
        throw new Error('bucket unreachable');
      },
    };
    await expect(
      domain().request(peer, { image: image('0.1.65', 'b') }),
    ).rejects.toThrow('bucket unreachable');
    expect(events).toEqual(['backup']);
    expect(applied).toHaveLength(0);
    await expect(
      getPersistence().systemReleases.get('rel-1'),
    ).resolves.toMatchObject({
      state: ClusterReleaseState.Failed,
      lastError: 'bucket unreachable',
    });
  });

  it('short-circuits a request for the image the release already carries: nothing recorded, no rollout', async () => {
    // The bootstrap image: no intent row in this database names it.
    await expect(
      domain().request(peer, { image: image('0.1.64', 'a') }),
    ).resolves.toEqual({ unchanged: true, upgrade: null });
    expect(events).toEqual([]);
    // After an applied release, a lost-response re-run returns that intent.
    const first = await domain().request(peer, { image: image('0.1.65', 'b') });
    deps.generateOperationId = () => 'rel-2';
    await expect(
      domain().request(peer, { image: image('0.1.65', 'b') }),
    ).resolves.toEqual({
      unchanged: true,
      // Observed through its ready Job, not reported as stored.
      upgrade: { ...first.upgrade, state: WorkloadState.Running },
    });
    expect(applied).toHaveLength(1);
    await expect(
      getPersistence().systemReleases.get('rel-2'),
    ).resolves.toBeNull();
  });

  it('records the failure and reports stale when the HelmChart moved underneath the request', async () => {
    conflicts = 1;
    await expect(
      domain().request(peer, { image: image('0.1.65', 'b') }),
    ).rejects.toThrow(SystemReleaseStaleError);
    await expect(
      getPersistence().systemReleases.get('rel-1'),
    ).resolves.toMatchObject({ state: ClusterReleaseState.Failed });
    // The database refuses a revision that is not newer than every recorded one.
    await expect(
      getPersistence().systemReleases.record({
        revision: 2,
        operationId: 'rel-stale',
        apiVersion: '0.1.65',
        apiImage: image('0.1.65', 'b'),
        requestedByUserId: peer.id,
      }),
    ).resolves.toBe('revision-not-newer');
  });

  it('refuses a request whose upgrade is no longer the next one, by upgrade number', async () => {
    const store = deps.intents;
    deps.intents = {
      record: async () => 'revision-not-newer',
      get: (operationId) => store.get(operationId),
      latest: () => store.latest(),
      setState: (operationId, state, lastError) =>
        store.setState(operationId, state, lastError),
    };
    await expect(
      domain().request(peer, { image: image('0.1.65', 'b') }),
    ).rejects.toThrow('upgrade 1 is no longer the next upgrade; retry');
    expect(applied).toHaveLength(0);
  });

  it('is unavailable without the Helm-managed identity, a backup, its own cluster record or a HelmChart naming this installation', async () => {
    await expect(
      createSystemReleaseDomain({ ...deps, identity: null }).request(peer, {
        image: image('0.1.65', 'b'),
      }),
    ).rejects.toThrow(SystemReleaseUnavailableError);
    await expect(
      createSystemReleaseDomain({ ...deps, backup: null }).request(peer, {
        image: image('0.1.65', 'b'),
      }),
    ).rejects.toThrow('no database backup is configured');
    await expect(
      createSystemReleaseDomain({
        ...deps,
        identity: { installationId: 'other' },
      }).request(peer, { image: image('0.1.65', 'b') }),
    ).rejects.toThrow('has not recorded the cluster it runs in');
    chart!.metadata.annotations[RELEASE_INSTALLATION_ANNOTATION] = 'other';
    await expect(
      domain().request(peer, { image: image('0.1.65', 'b') }),
    ).rejects.toThrow(`does not name installation ${INSTALLATION}`);
    expect(events).toEqual([]);
  });

  it("takes api delete's final backup and answers its time; unavailable without a backup or the Helm-managed identity", async () => {
    await expect(domain().backup(peer)).resolves.toEqual({
      backedUpAt: '2026-11-04T18:12:03.000Z',
    });
    expect(events).toEqual(['backup:api delete']);
    await expect(
      createSystemReleaseDomain({ ...deps, backup: null }).backup(peer),
    ).rejects.toThrow('no database backup is configured');
    await expect(
      createSystemReleaseDomain({ ...deps, identity: null }).backup(peer),
    ).rejects.toThrow(SystemReleaseUnavailableError);
  });

  it('reports served and schema versions, the latest upgrade, the Deployment rollout and the latest K3s step', async () => {
    await domain().request(peer, { image: image('0.1.65', 'b') });
    hostStep = {
      state: 'finished',
      id: 'step0001',
      startedAt: '2026-11-07T10:00:00.000Z',
      finishedAt: '2026-11-07T10:01:00.000Z',
      result: { code: 0, output: 'configuration=changed\n' },
    };
    await expect(domain().status(peer)).resolves.toMatchObject({
      servedVersion: '0.1.64',
      schemaVersion: '0.1.64',
      upgrade: { number: 1, state: WorkloadState.Running },
      rollout: { readyReplicas: 1, conditions: [{ type: 'Available' }] },
      kubernetes: {
        id: 'step0001',
        state: 'succeeded',
        configuration: 'changed',
        finishedAt: '2026-11-07T10:01:00.000Z',
      },
    });
    // Only the latest revision's ready Job is read.
    expect(readyJobReads).toEqual(['anycloud-api-ready-2']);

    // The previous release's CLI reads the label; an unreadable Node omits it.
    managementLabel = null;
    expect(await domain().status(peer)).not.toHaveProperty(
      'managementNodeLabelled',
    );
    managementLabel = false;
    await expect(domain().status(peer)).resolves.toMatchObject({
      managementNodeLabelled: false,
    });

    // No kept step, or one that can't be read, is left out.
    hostStep = null;
    expect(await domain().status(peer)).not.toHaveProperty('kubernetes');
    hostStep = {
      state: 'running',
      id: 'unreadable',
      startedAt: null,
      waiting: null,
    };
    expect(await domain().status(peer)).not.toHaveProperty('kubernetes');
  });

  describe('the K3s step', () => {
    it("runs on the target release's pinned image with the cluster's address and issuer", async () => {
      await expect(
        domain().kubernetes(peer, {
          id: 'step0001',
          image: 'ghcr.io/anycloud-sh/api:0.1.65',
        }),
      ).resolves.toEqual({
        step: {
          id: 'step0001',
          state: 'running',
          configuration: null,
          startedAt: null,
          finishedAt: null,
          reason: null,
        },
      });
      expect(hostStepRuns).toEqual([
        {
          id: 'step0001',
          image: image('0.1.65', 'b'),
          step: {
            kind: 'kubernetes',
            publicIp: '203.0.113.5',
            issuerUrl: 'https://install-production-1.anycloud.sh',
          },
        },
      ]);
      // It changes nothing the release request owns.
      expect(events).toEqual([]);
      // A poll observes the started step without resolving the image again.
      hostStep = {
        state: 'running',
        id: 'step0001',
        startedAt: null,
        waiting: 'ErrImagePull: not found',
      };
      deps.resolveApiImage = () => Promise.reject(new Error('registry down'));
      await expect(
        domain().kubernetes(peer, {
          id: 'step0001',
          image: 'ghcr.io/anycloud-sh/api:0.1.65',
        }),
      ).resolves.toMatchObject({
        step: { state: 'running', reason: 'ErrImagePull: not found' },
      });
      expect(hostStepRuns).toHaveLength(1);
    });

    it('reports success with whether the configuration changed, and a failure with its exit and output', async () => {
      const run = () =>
        domain().kubernetes(peer, {
          id: 'step0001',
          image: image('0.1.65', 'b'),
        });
      hostStep = {
        state: 'finished',
        id: 'step0001',
        startedAt: null,
        finishedAt: null,
        result: { code: 0, output: 'configuration=current\n' },
      };
      await expect(run()).resolves.toMatchObject({
        step: { state: 'succeeded', configuration: 'current', reason: null },
      });
      hostStep = {
        ...hostStep,
        result: {
          code: 75,
          output:
            'configuration=changed\nKubernetes did not become ready within 5 minutes\n',
        },
      };
      await expect(run()).resolves.toMatchObject({
        step: {
          state: 'failed',
          configuration: 'changed',
          reason:
            'the K3s step exited 75: Kubernetes did not become ready within 5 minutes',
        },
      });
      hostStep = {
        state: 'failed',
        id: 'step0001',
        startedAt: null,
        finishedAt: null,
        reason:
          'DeadlineExceeded: Job was active longer than specified deadline',
      };
      await expect(run()).resolves.toMatchObject({
        step: {
          state: 'failed',
          configuration: null,
          reason:
            'DeadlineExceeded: Job was active longer than specified deadline',
        },
      });
    });

    it('runs nothing for an image the release already carries or one it refuses', async () => {
      await expect(
        domain().kubernetes(peer, {
          id: 'step0001',
          image: image('0.1.64', 'a'),
        }),
      ).resolves.toEqual({ step: null });
      await expect(
        domain().kubernetes(peer, {
          id: 'step0001',
          image: `ghcr.io/someone/api:0.1.65@sha256:${'b'.repeat(64)}`,
        }),
      ).rejects.toThrow(SystemReleaseRefusedError);
      expect(hostStepRuns).toEqual([]);
    });
  });

  it('reports the first backup’s progress, which api create waits for, and omits it without a backup', async () => {
    expect(await domain().status(peer)).not.toHaveProperty('firstBackup');
    const pending = {
      state: 'pending' as const,
      attempts: 2,
      lastError: 'AccessDenied',
    };
    await expect(
      createSystemReleaseDomain({ ...deps, firstBackup: () => pending }).status(
        peer,
      ),
    ).resolves.toMatchObject({ firstBackup: pending });
    const parsed = systemReleaseStatusSchema.parse(
      await createSystemReleaseDomain({
        ...deps,
        firstBackup: () => ({
          state: 'landed',
          backedUpAt: '2026-11-07T00:00:00.000Z',
        }),
      }).status(peer),
    );
    expect(parsed.firstBackup).toEqual({
      state: 'landed',
      backedUpAt: '2026-11-07T00:00:00.000Z',
    });
  });

  it('reports failed when the ready Job is absent because the guard Job failed', async () => {
    await domain().request(peer, { image: image('0.1.65', 'b') });
    readyJob = { outcome: 'absent' };
    guardJob = { outcome: 'failed', reason: 'BackoffLimitExceeded' };
    await expect(domain().status(peer)).resolves.toMatchObject({
      upgrade: {
        state: WorkloadState.Failed,
        lastError: 'the pre-upgrade check failed: BackoffLimitExceeded',
      },
    });
  });

  it("reports failed when helm-controller's install Job for the release failed, instead of starting until the CLI times out", async () => {
    await domain().request(peer, { image: image('0.1.65', 'b') });
    readyJob = { outcome: 'absent' };
    guardJob = { outcome: 'absent' };
    deps.observeHookJob = async (name) => {
      readyJobReads.push(name);
      if (name === 'helm-install-anycloud-api') {
        return {
          outcome: 'failed',
          reason: 'BackoffLimitExceeded',
          createdAt: Date.now(),
        };
      }
      return name.startsWith('anycloud-api-guard-') ? guardJob : readyJob;
    };
    await expect(domain().status(peer)).resolves.toMatchObject({
      upgrade: {
        state: WorkloadState.Failed,
        lastError: 'the Helm upgrade failed: BackoffLimitExceeded',
      },
    });
    expect(readyJobReads).toContain('helm-install-anycloud-api');

    // Once the ready Job succeeded, Helm's Job is not read.
    readyJobReads.length = 0;
    readyJob = { outcome: 'succeeded' };
    await expect(domain().status(peer)).resolves.toMatchObject({
      upgrade: { state: WorkloadState.Running },
    });
    expect(readyJobReads).not.toContain('helm-install-anycloud-api');
  });

  it('reports an applied release as a starting upgrade until its ready Job succeeds, without changing the stored intent', async () => {
    await domain().request(peer, { image: image('0.1.65', 'b') });
    // The HelmChart is patched and the intent recorded applied.
    readyJob = { outcome: 'running' };
    await expect(domain().status(peer)).resolves.toMatchObject({
      upgrade: { number: 1, state: WorkloadState.Starting },
      rollout: { readyReplicas: 1, updatedReplicas: 1, replicas: 1 },
    });
    await expect(deps.intents.get('rel-1')).resolves.toMatchObject({
      state: ClusterReleaseState.Applied,
    });
  });

  describe('applying its own chart at start-up', () => {
    let helmJob: HookJobObservation | null;
    // The first start after an upgrade from a release before 0.1.68, which
    // patched only the values of its inline chart.
    const inline = () => {
      chart!.spec = { ...chart!.spec, chart: '', chartContent: 'Y2hhcnQ=' };
    };
    beforeEach(() => {
      inline();
      helmJob = { outcome: 'succeeded' };
      deps.observeHookJob = async (name) => {
        readyJobReads.push(name);
        return name === 'helm-install-anycloud-api' ? helmJob : readyJob;
      };
    });

    it('makes no call when the HelmChart already names its chart, and is current once Helm finished', async () => {
      chart = installedChart(1, 'op-bootstrap');
      helmJob = { outcome: 'running' };
      await expect(domain().applyOwnChart()).resolves.toBe('deferred');
      helmJob = { outcome: 'succeeded' };
      await expect(domain().applyOwnChart()).resolves.toBe('current');
      expect(events).toEqual([]);
      expect(applied).toEqual([]);
    });

    it('is a no-op on the first start after an upgrade that set its chart', async () => {
      chart = installedChart(1, 'op-bootstrap');
      await domain().request(peer, { image: image('0.1.65', 'b') });
      applied = [];
      const upgraded = createSystemReleaseDomain({
        ...deps,
        servedVersion: '0.1.65',
        ownChart: chartOf('b'),
      });
      await expect(upgraded.applyOwnChart()).resolves.toBe('current');
      expect(applied).toEqual([]);
    });

    it('switches an inline chart to its OCI reference once, keeping values and release annotations', async () => {
      const before = structuredClone(chart!);
      await expect(domain().applyOwnChart()).resolves.toBe('applied');
      await expect(domain().applyOwnChart()).resolves.toBe('current');
      expect(applied).toHaveLength(1);
      const [write] = applied;
      expect(write.precondition).toBe('100');
      expect(write.chart.spec).toEqual({
        ...before.spec,
        chart: chartOf('a'),
        chartContent: null,
      });
      expect(write.chart.metadata.annotations).toEqual(
        before.metadata.annotations,
      );
      expect(readyJobReads).toEqual([
        'helm-install-anycloud-api',
        'helm-install-anycloud-api',
      ]);
    });

    it('is current after its own patch only once a Helm run since the patch finished', async () => {
      const own = domain();
      helmJob = { outcome: 'succeeded', uid: 'helm-1' };
      await expect(own.applyOwnChart()).resolves.toBe('applied');
      // The Job from before the patch still stands: its run is not the patch's.
      await expect(own.applyOwnChart()).resolves.toBe('deferred');
      helmJob = { outcome: 'running' };
      await expect(own.applyOwnChart()).resolves.toBe('deferred');
      helmJob = { outcome: 'succeeded', uid: 'helm-2' };
      await expect(own.applyOwnChart()).resolves.toBe('current');
      const next = domain();
      chart!.spec.chart = chartOf('d');
      await expect(next.applyOwnChart()).resolves.toBe('applied');
      await expect(next.applyOwnChart()).resolves.toBe('deferred');
      // helm-controller replaced the Job: a new uid is the patched chart's run.
      helmJob = { outcome: 'succeeded', uid: 'helm-3' };
      await expect(next.applyOwnChart()).resolves.toBe('current');
    });

    it('fails when its image names no chart', async () => {
      await expect(
        createSystemReleaseDomain({ ...deps, ownChart: null }).applyOwnChart(),
      ).rejects.toThrow(
        'this API image names no chart (ANYCLOUD_API_CHART is unset)',
      );
      expect(applied).toEqual([]);
    });

    it('proceeds after a failed Helm Job: the new Job is the retry', async () => {
      helmJob = { outcome: 'failed', reason: 'BackoffLimitExceeded' };
      readyJob = { outcome: 'failed', reason: 'DeadlineExceeded' };
      await expect(domain().applyOwnChart()).resolves.toBe('applied');
      expect(applied).toHaveLength(1);
    });

    it('leaves a release for another version to the image it names', async () => {
      await domain().request(peer, { image: image('0.1.65', 'b') });
      applied = [];
      readyJobReads = [];
      await expect(domain().applyOwnChart()).resolves.toBe('superseded');
      expect(applied).toEqual([]);
      expect(readyJobReads).toEqual([]);
    });

    it('defers while a Helm Job runs or cannot be read, or the HelmChart moved', async () => {
      for (const observed of [
        { outcome: 'running' },
        { outcome: 'absent' },
        null,
      ] as const) {
        helmJob = observed;
        await expect(domain().applyOwnChart()).resolves.toBe('deferred');
      }
      expect(applied).toEqual([]);
      helmJob = { outcome: 'succeeded' };
      conflicts = 1;
      await expect(domain().applyOwnChart()).resolves.toBe('deferred');
      expect(applied).toEqual([]);
    });
  });

  it("moves an upgraded installation's Traefik onto the protected management label, and leaves a cluster without one alone", async () => {
    await expect(domain().applyApiIngress()).resolves.toBe('absent');
    expect(events).toEqual([]);

    // A bootstrap before that fix selected the label the Node sets itself.
    const desired = apiIngressHelmChart();
    const legacy = desired.spec.valuesContent.replace(
      "node-restriction.kubernetes.io/anycloud-management: 'true'",
      "anycloud.sh/cluster-management: 'true'",
    );
    expect(legacy).not.toBe(desired.spec.valuesContent);
    const installed = ingressChartWith({ valuesContent: legacy });
    ingressChart = installed;
    await expect(domain().applyApiIngress()).resolves.toBe('applied');
    expect(events).toEqual(['apply:anycloud-api-ingress']);
    expect(ingressChart?.spec).toMatchObject(desired.spec);

    // The next start finds it current and writes nothing.
    await expect(domain().applyApiIngress()).resolves.toBe('current');
    expect(events).toEqual(['apply:anycloud-api-ingress']);

    // Any field the chart sets counts, not only its values.
    ingressChart = ingressChartWith({ version: '0.0.1' });
    await expect(domain().applyApiIngress()).resolves.toBe('applied');
    expect(ingressChart?.spec).toMatchObject(desired.spec);
  });

  it("leaves the API's Traefik to the release the API chart names", async () => {
    ingressChart = ingressChartWith({ valuesContent: 'legacy' });
    deps.servedVersion = '0.1.63';
    await expect(domain().applyApiIngress()).resolves.toBe('superseded');
    expect(events).toEqual([]);
  });

  it('reads no ready Job for a release that is not recorded applied', async () => {
    await expect(domain().status(peer)).resolves.toMatchObject({
      upgrade: null,
    });
    expect(readyJobReads).toEqual([]);
  });
});

describe('release target rule', () => {
  // The owner's decision: no rollback. A hosted API serves only
  // after its start's full migration run stamped the database with its own
  // version, so the schema rule alone refuses every older target.
  it('refuses every target older than the served API once its start stamped the database', async () => {
    const sqlite = new BetterSqlite3(':memory:');
    const database = {
      get inTransaction() {
        return sqlite.inTransaction;
      },
      exec: (sql: string) => void sqlite.exec(sql),
      query: <T>(sql: string, params: unknown[] = []): T[] => {
        const statement = sqlite.prepare(sql);
        return (
          statement.reader
            ? statement.all(...params)
            : [{ rowsAffected: statement.run(...params).changes }]
        ) as T[];
      },
    };
    const served = packageJson.version;
    const [major, minor, patch] = served.split('.').map(Number);
    const stamp = () =>
      database.query<{ value: string }>(
        `SELECT value FROM _metadata WHERE key = 'schema_app_version'`,
      )[0]?.value;
    // A database last used by an older release, then this API's start.
    const older = `${major}.${minor - 1}.0`;
    await runMigrations(database, undefined, older);
    expect(stamp()).toBe(older);
    await runMigrations(database, undefined, served);
    const schemaVersion = stamp()!;
    expect(schemaVersion).toBe(served);
    for (const version of [
      `${major}.${minor}.${patch - 1}`,
      `${major}.${minor - 1}.${patch}`,
      `${major}.${minor - 1}.999`,
      '0.0.1',
      // A `.0` has no previous patch or minor.
    ].filter((version) => semver.valid(version))) {
      expect(
        assessReleaseTarget({ image: image(version, 'b'), schemaVersion }),
      ).toMatchObject({
        ok: false,
        reason: expect.stringContaining(
          `the database was last used by API ${served}; API ${version} would refuse to start against it. To go back, restore the pre-upgrade backup: https://anycloud.sh/platform/hosted-apis#back-up-and-restore`,
        ),
      });
    }
    sqlite.close();
  });

  const base = { schemaVersion: '0.1.65' };

  it('accepts only digest-pinned official release images', () => {
    expect(
      assessReleaseTarget({ ...base, image: image('0.1.66', 'b') }),
    ).toEqual({ ok: true, version: '0.1.66' });
    for (const bad of [
      'ghcr.io/anycloud-sh/api:0.1.66',
      `docker.io/evil/api:0.1.66@sha256:${'b'.repeat(64)}`,
      image('0.1.66-rc.1', 'b'),
    ]) {
      expect(assessReleaseTarget({ ...base, image: bad })).toMatchObject({
        ok: false,
      });
    }
  });
});

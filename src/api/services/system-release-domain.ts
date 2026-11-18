import type { SelfDelete } from './self-delete.js';
import type {
  SelfDeleteInput,
  SelfDeleteStatus,
} from '../../shared/api-contract/system-release-schemas.js';
import type { FirstBackupStatus } from './first-backup.js';
import * as semver from 'semver';
import { errorMessage } from '../../shared/log-diagnostics.js';
import type {
  KubernetesStep,
  KubernetesStepInput,
  KubernetesStepResponse,
  RequestSystemReleaseInput,
  SystemReleaseResponse,
  SystemReleaseRollout,
  SystemBackupResponse,
  SystemReleaseStatus,
} from '../../shared/api-contract/system-release-schemas.js';
import { ClusterReleaseState } from '../../shared/clusters.js';
import {
  apiImageTagReference,
  isPinnedApiImage,
  pinnedApiImage,
  SYSTEM_RELEASE_CHART_ENV,
  SYSTEM_RELEASE_HELM_CHART_NAME,
  SYSTEM_RELEASE_NAMESPACE,
} from '../../shared/system-release.js';
import type { User } from './entities.js';
import { apiIngressHelmChart } from '../../shared/api-ingress.js';
import type { ClusterConnectionDocument } from './kubernetes/cluster-connection.js';
import type { ClusterReleaseClient } from './clusters-domain.js';
import type { ClusterReleaseConflictError } from './cluster-errors.js';
import type { ClusterRecordRepository } from './cluster-store.js';
import {
  type HelmChartObject,
  type SystemReleaseValues,
} from '../../shared/system-release-values.js';
import {
  RELEASE_INSTALLATION_ANNOTATION,
  RELEASE_OPERATION_ANNOTATION,
  RELEASE_REVISION_ANNOTATION,
} from '../../shared/system-release.js';
import {
  guardJobName,
  HELM_INSTALL_JOB,
  readyJobName,
  reportSystemUpgrade,
  systemUpgrade,
  type HookJobObservation,
} from './system-release/ready-job.js';
import type {
  SystemReleaseIntent,
  SystemReleaseIntentRepository,
} from './system-release-intent-store.js';
import type {
  HostStepExecutor,
  HostStepObservation,
} from './system-release/host-step.js';
import { parseManagementReconfigure } from './system-release/management-host.js';

export class SystemReleaseRefusedError extends Error {
  constructor(reason: string) {
    super(`Release refused: ${reason}`);
    this.name = 'SystemReleaseRefusedError';
  }
}

export class SystemReleaseStaleError extends Error {
  constructor(reason: string) {
    super(`Release request is stale: ${reason}`);
    this.name = 'SystemReleaseStaleError';
  }
}

export class SystemReleaseUnavailableError extends Error {
  constructor(reason: string) {
    super(`API release updates are not available here: ${reason}`);
    this.name = 'SystemReleaseUnavailableError';
  }
}

/** What a Helm-managed API knows about itself from its chart-set environment. */
export interface HostedSystemReleaseIdentity {
  installationId: string;
}

export interface SystemReleaseDomainDependencies {
  /** Null on a local or Docker-hosted API: every call is unavailable. */
  identity: HostedSystemReleaseIdentity | null;
  intents: SystemReleaseIntentRepository;
  clusterRecords: Pick<ClusterRecordRepository, 'getConnection'>;
  parseConnection(serialized: string): ClusterConnectionDocument;
  releases: Pick<
    ClusterReleaseClient,
    'getHelmChart' | 'applyHelmChart' | 'applyObject'
  >;
  isConflict(error: unknown): error is ClusterReleaseConflictError;
  /** Version this process serves and the schema version its database reached. */
  servedVersion: string;
  schemaVersion(): Promise<string | null>;
  /** Null when this API has no backup configured: releases are refused. */
  backup: { run(reason: string): Promise<string> } | null;
  /**
   * An API image's immutable digest and the digest-pinned chart it was built
   * with; rejects when either is not published.
   */
  resolveApiImage(
    reference: string,
  ): Promise<{ digest: string; chart: string }>;
  /** The chart this API's image was built with; null when it names none. */
  ownChart: string | null;
  observeRollout(): Promise<SystemReleaseRollout | null>;
  /** The first backup's progress; null without a backup. */
  firstBackup?(): FirstBackupStatus | null;
  /** A release hook Job by name; null when it cannot be read. */
  observeHookJob(name: string): Promise<HookJobObservation | null>;
  generateOperationId(): string;
  /** Whether the management Node carries its label; null when unreadable. */
  observeManagementLabel(): Promise<boolean | null>;
  /** Root scripts on the management host, run from a host-step Job. */
  hostSteps: HostStepExecutor;
  /** Null where the API can't delete its own installation. */
  selfDelete: SelfDelete | null;
  log: {
    info(message: string, metadata?: Record<string, unknown>): void;
    warn(message: string, metadata?: Record<string, unknown>): void;
  };
}

export interface SystemReleaseDomain {
  request(
    actor: User,
    input: RequestSystemReleaseInput,
    signal?: AbortSignal,
  ): Promise<SystemReleaseResponse>;
  status(actor: User, signal?: AbortSignal): Promise<SystemReleaseStatus>;
  /** C28: `api delete`'s final backup, the one an upgrade takes. */
  backup(actor: User): Promise<SystemBackupResponse>;
  /** RFC 0049 C26 (b)'s K3s step, which `api upgrade` runs first. */
  kubernetes(
    actor: User,
    input: KubernetesStepInput,
  ): Promise<KubernetesStepResponse>;
  /** `api delete`: the installation, this API last. */
  selfDelete(actor: User, input: SelfDeleteInput): Promise<SelfDeleteStatus>;
  selfDeleteStatus(actor: User): Promise<SelfDeleteStatus>;
  /**
   * Start-up drift repair: puts this image's chart into the HelmChart. An
   * upgrade already sets it, so this writes only after an upgrade from a
   * release before 0.1.68 (whose inline chart it replaces) or a manual edit.
   * `current` waits for a running Helm operation to finish; `deferred` means
   * retry later; `superseded` means another release owns it.
   */
  applyOwnChart(): Promise<'current' | 'applied' | 'deferred' | 'superseded'>;
  /**
   * Start-up repair of the API's Traefik, which bootstrap applies once: writes
   * this image's values when they differ, so an upgrade moves it onto the
   * protected management label. `absent`: no bootstrap installed it;
   * `superseded`: another release owns the API chart.
   */
  applyApiIngress(): Promise<'current' | 'applied' | 'absent' | 'superseded'>;
}

function releaseVersionOf(image: string): string {
  const tag = image.slice(image.lastIndexOf(':', image.indexOf('@')) + 1);
  return tag.slice(0, tag.indexOf('@'));
}

/** `ghcr.io/anycloud-sh/api:<version>` without a digest, or null. */
function officialTagVersion(image: string): string | null {
  const version = image.slice(apiImageTagReference('').length);
  return image === apiImageTagReference(version) &&
    version.length > 0 &&
    !version.includes('@')
    ? version
    : null;
}

/**
 * The version rule is the one the API enforces on itself at startup
 * (`migrations.ts`): a database last used by a newer API refuses an older
 * one. Refusing here keeps a rollout from installing an image that would
 * crash-loop against the database it inherits. The serving API stamped the
 * database with its own version when it started, so this refuses every
 * target older than it: there is no rollback, only the pre-upgrade backup.
 */
export function assessReleaseTarget(input: {
  image: string;
  schemaVersion: string | null;
}): { ok: true; version: string } | { ok: false; reason: string } {
  if (!isPinnedApiImage(input.image)) {
    return {
      ok: false,
      reason:
        'image must be a digest-pinned reference from the official repository (ghcr.io/anycloud-sh/api:<version>@sha256:<digest>)',
    };
  }
  const version = releaseVersionOf(input.image);
  const target = semver.parse(version);
  if (!target || target.prerelease.length > 0 || target.build.length > 0) {
    return { ok: false, reason: `${version} is not a release version` };
  }
  if (
    input.schemaVersion &&
    semver.valid(input.schemaVersion) &&
    semver.gt(input.schemaVersion, target)
  ) {
    return {
      ok: false,
      reason: `the database was last used by API ${input.schemaVersion}; API ${target.version} would refuse to start against it. To go back, restore the pre-upgrade backup: https://anycloud.sh/platform/hosted-apis#back-up-and-restore`,
    };
  }
  return { ok: true, version: target.version };
}

/** The last lines of a failed step's output, as its reason. */
const STEP_REASON_LINES = 5;

function kubernetesStep(observation: HostStepObservation): KubernetesStep {
  const base = {
    id: observation.id,
    startedAt: observation.startedAt,
    finishedAt: observation.state === 'running' ? null : observation.finishedAt,
  };
  if (observation.state === 'running') {
    return {
      ...base,
      state: 'running',
      configuration: null,
      reason: observation.waiting,
    };
  }
  if (observation.state === 'failed') {
    return {
      ...base,
      state: 'failed',
      configuration: null,
      reason: observation.reason,
    };
  }
  const { code, output } = observation.result;
  const configuration = parseManagementReconfigure(output);
  if (code === 0) {
    return { ...base, state: 'succeeded', configuration, reason: null };
  }
  const tail = output
    .split('\n')
    .filter((line) => line.trim() && !line.startsWith('configuration='))
    .slice(-STEP_REASON_LINES)
    .join('\n');
  return {
    ...base,
    state: 'failed',
    configuration,
    reason: `the K3s step exited ${code}${tail ? `: ${tail}` : ''}`,
  };
}

/** The HelmChart as written back: its observed status is never sent. */
function writable(chart: HelmChartObject): HelmChartObject {
  const { status: _status, ...observed } = chart as HelmChartObject & {
    status?: unknown;
  };
  void _status;
  return observed;
}

export function createSystemReleaseDomain(
  deps: SystemReleaseDomainDependencies,
): SystemReleaseDomain {
  // The helm-install Job this process's chart patch replaces (undefined
  // before any patch), and whether a Helm run since was seen running.
  let replacedHelmUid: string | null | undefined;
  let helmRanSincePatch = false;
  function identity(): HostedSystemReleaseIdentity {
    if (!deps.identity) {
      throw new SystemReleaseUnavailableError(
        'not a Helm-managed API; `anycloud api upgrade` upgrades a Docker-hosted API along its existing path',
      );
    }
    return deps.identity;
  }

  /** This API's own cluster record and the HelmChart that names this installation. */
  async function ownCluster(): Promise<{
    connection: ClusterConnectionDocument;
    chart: HelmChartObject;
  }> {
    const own = identity();
    const stored = await deps.clusterRecords.getConnection(own.installationId);
    if (!stored) {
      throw new SystemReleaseUnavailableError(
        'this API has not recorded the cluster it runs in; it does so on start',
      );
    }
    const connection = deps.parseConnection(stored.connection);
    const chart = await deps.releases.getHelmChart(
      connection,
      SYSTEM_RELEASE_HELM_CHART_NAME,
      SYSTEM_RELEASE_NAMESPACE,
    );
    if (
      chart?.metadata.annotations[RELEASE_INSTALLATION_ANNOTATION] !==
      own.installationId
    ) {
      throw new SystemReleaseUnavailableError(
        `the ${SYSTEM_RELEASE_HELM_CHART_NAME} HelmChart in ${SYSTEM_RELEASE_NAMESPACE} does not name installation ${own.installationId}`,
      );
    }
    return { connection, chart };
  }

  /** The latest upgrade, with an applied one observed through its hook Jobs. */
  async function observeUpgrade(latest: SystemReleaseIntent | null) {
    // Only the latest revision's hook Jobs count; their names carry it.
    const readyJob =
      latest?.state === ClusterReleaseState.Applied
        ? await deps.observeHookJob(readyJobName(latest.revision))
        : null;
    const guardJob =
      latest && readyJob?.outcome === 'absent'
        ? await deps.observeHookJob(guardJobName(latest.revision))
        : null;
    const helmJob =
      latest?.state === ClusterReleaseState.Applied &&
      readyJob?.outcome !== 'succeeded'
        ? await deps.observeHookJob(HELM_INSTALL_JOB)
        : null;
    return reportSystemUpgrade(latest, readyJob, guardJob, helmJob);
  }

  /**
   * Everything that can refuse a release, or find it already carried,
   * before anything changes.
   */
  async function prepare(
    input: RequestSystemReleaseInput,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    identity();
    const { backup } = deps;
    if (!backup) {
      throw new SystemReleaseUnavailableError(
        'no database backup is configured; bootstrap records a backup bucket for new installations',
      );
    }
    // `anycloud api upgrade` names this CLI's release by tag; the API pins it
    // to the published digest here so the intent and the HelmChart carry an
    // immutable reference. An explicit digest is used as given. Either way
    // the image names the digest-pinned chart the upgrade moves to.
    const tagVersion = officialTagVersion(input.image);
    const resolve = (reference: string) =>
      deps.resolveApiImage(reference).catch((error: unknown) => {
        throw new SystemReleaseRefusedError(
          tagVersion
            ? `no published API image for version ${tagVersion} (${errorMessage(error)}); run "anycloud update" or pass --image with a digest`
            : errorMessage(error),
        );
      });
    const tagged = tagVersion
      ? { version: tagVersion, ...(await resolve(input.image)) }
      : null;
    const image = tagged
      ? pinnedApiImage(tagged.version, tagged.digest)
      : input.image;
    const verdict = assessReleaseTarget({
      image,
      schemaVersion: await deps.schemaVersion(),
    });
    if (!verdict.ok) throw new SystemReleaseRefusedError(verdict.reason);

    const { connection, chart } = await ownCluster();
    signal?.throwIfAborted();
    const carried = (
      JSON.parse(chart.spec.valuesContent) as SystemReleaseValues
    ).release?.image;
    return {
      tagged,
      image,
      verdict,
      connection,
      chart,
      resolve,
      carried,
      backup,
    };
  }

  const selfDelete = (): SelfDelete => {
    identity();
    if (!deps.selfDelete) {
      throw new SystemReleaseUnavailableError(
        'this API has no installation to delete',
      );
    }
    return deps.selfDelete;
  };

  return {
    async backup() {
      identity();
      if (!deps.backup) {
        throw new SystemReleaseUnavailableError(
          'no database backup is configured',
        );
      }
      return { backedUpAt: await deps.backup.run('api delete') };
    },

    async selfDelete(actor, input) {
      return selfDelete().request(actor.id, input);
    },
    async selfDeleteStatus() {
      return selfDelete().status();
    },
    async kubernetes(_actor, { id, image }) {
      // A poll observes the step it started without resolving the image
      // again, through an API server the step may be restarting.
      const started = await deps.hostSteps.get('kubernetes', id);
      if (started) return { step: kubernetesStep(started) };
      const prepared = await prepare({ image });
      if (prepared.carried === prepared.image) return { step: null };
      const { cluster, installation } = JSON.parse(
        prepared.chart.spec.valuesContent,
      ) as SystemReleaseValues;
      const observation = await deps.hostSteps.run({
        id,
        // The image the release moves to renders its own configuration.
        image: prepared.image,
        step: {
          kind: 'kubernetes',
          publicIp: new URL(cluster.joinEndpoint).hostname,
          issuerUrl: installation.apiUrl,
        },
      });
      const step = kubernetesStep(observation);
      deps.log.info('K3s step started', {
        id: 'system',
        step: step.id,
        image: prepared.image,
      });
      return { step };
    },

    async request(actor, input, signal) {
      const {
        tagged,
        image,
        verdict,
        connection,
        chart,
        resolve,
        carried,
        backup,
      } = await prepare(input, signal);
      const operationId = deps.generateOperationId();
      // A re-run or a lost-response retry for the image the release already
      // carries records nothing and triggers no second rollout.
      if (carried === image) {
        const latest = await deps.intents.latest();
        return {
          unchanged: true,
          upgrade:
            latest?.apiImage === image ? await observeUpgrade(latest) : null,
        };
      }
      const target = tagged ?? (await resolve(image));
      signal?.throwIfAborted();
      const observedRevision = Number(
        chart.metadata.annotations[RELEASE_REVISION_ANNOTATION] ?? 0,
      );
      const latest = await deps.intents.latest();
      const revision =
        Math.max(
          Number.isSafeInteger(observedRevision) ? observedRevision : 0,
          latest?.revision ?? 0,
        ) + 1;
      // Durable before any mutation: the database refuses a revision that is
      // not newer than every recorded one.
      const recorded = await deps.intents.record({
        revision,
        operationId,
        apiVersion: verdict.version,
        apiImage: image,
        requestedByUserId: actor.id,
      });
      if (recorded !== 'recorded') {
        throw new SystemReleaseStaleError(
          `upgrade ${revision - 1} is no longer the next upgrade; retry`,
        );
      }
      try {
        // A coherent copy of the database before the release can touch it.
        await backup.run(`release ${operationId}`);
        const values = JSON.parse(
          chart.spec.valuesContent,
        ) as SystemReleaseValues;
        values.release = {
          revision,
          operationId,
          image,
          version: verdict.version,
        };
        // The chart, the values and the release annotations change in one
        // write, so Helm renders the new chart and image once.
        await deps.releases.applyHelmChart(
          connection,
          {
            ...writable(chart),
            metadata: {
              ...chart.metadata,
              annotations: {
                ...chart.metadata.annotations,
                [RELEASE_REVISION_ANNOTATION]: String(revision),
                [RELEASE_OPERATION_ANNOTATION]: operationId,
              },
            },
            spec: {
              ...chart.spec,
              chart: target.chart,
              chartContent: null,
              valuesContent: JSON.stringify(values),
            },
          },
          chart.metadata.resourceVersion ?? null,
        );
      } catch (error) {
        const message = errorMessage(error);
        await deps.intents.setState(
          operationId,
          ClusterReleaseState.Failed,
          message,
        );
        if (deps.isConflict(error)) {
          throw new SystemReleaseStaleError(
            'the HelmChart changed while this request was being prepared; retry',
          );
        }
        throw error;
      }
      await deps.intents.setState(operationId, ClusterReleaseState.Applied);
      deps.log.info('API system release applied', {
        id: 'system',
        operationId,
        revision,
        image,
      });
      return {
        unchanged: false,
        upgrade: systemUpgrade(await deps.intents.get(operationId)),
      };
    },

    async applyApiIngress() {
      const { connection, chart } = await ownCluster();
      // As with the chart, the release the HelmChart names owns its Traefik.
      const { release } = JSON.parse(
        chart.spec.valuesContent,
      ) as SystemReleaseValues;
      if (release.version !== deps.servedVersion) return 'superseded';
      const desired = apiIngressHelmChart();
      const current = await deps.releases.getHelmChart(
        connection,
        desired.metadata.name,
        desired.metadata.namespace,
      );
      if (!current) return 'absent';
      const spec = current.spec as unknown as Record<string, unknown>;
      if (
        Object.entries(desired.spec).every(
          ([key, value]) => spec[key] === value,
        )
      ) {
        return 'current';
      }
      await deps.releases.applyObject(connection, desired);
      return 'applied';
    },

    async applyOwnChart() {
      const own = deps.ownChart;
      if (!own) {
        throw new Error(
          `this API image names no chart (${SYSTEM_RELEASE_CHART_ENV} is unset)`,
        );
      }
      const { connection, chart } = await ownCluster();
      if (chart.spec.chart === own && !chart.spec.chartContent) {
        // Its RBAC is in force only once the Helm run applying it finished;
        // after this process patched the chart, only a run since then counts.
        const helm = await deps.observeHookJob(HELM_INSTALL_JOB);
        if (helm?.outcome === 'running') {
          helmRanSincePatch = replacedHelmUid !== undefined;
          return 'deferred';
        }
        const ranSince =
          replacedHelmUid === undefined ||
          helmRanSincePatch ||
          (helm?.uid !== undefined && helm.uid !== replacedHelmUid);
        return ranSince ? 'current' : 'deferred';
      }
      // Never fight a release this image is not: the image it names applies
      // its own chart when it starts.
      const { release } = JSON.parse(
        chart.spec.valuesContent,
      ) as SystemReleaseValues;
      if (release.version !== deps.servedVersion) return 'superseded';
      // A spec change replaces helm-controller's Job; wait until no Helm
      // operation runs. A failed one does not block: the new Job is the retry.
      const helm = await deps.observeHookJob(HELM_INSTALL_JOB);
      if (helm?.outcome !== 'succeeded' && helm?.outcome !== 'failed') {
        return 'deferred';
      }
      try {
        await deps.releases.applyHelmChart(
          connection,
          {
            ...writable(chart),
            spec: { ...chart.spec, chart: own, chartContent: null },
          },
          chart.metadata.resourceVersion ?? null,
        );
      } catch (error) {
        if (deps.isConflict(error)) return 'deferred';
        throw error;
      }
      replacedHelmUid = helm.uid ?? null;
      helmRanSincePatch = false;
      deps.log.info('API system chart applied', {
        id: 'system',
        revision: release.revision,
        chart: own,
        previousHelmJob: helm.outcome,
      });
      return 'applied';
    },

    async status(_actor, signal) {
      signal?.throwIfAborted();
      identity();
      const [latest, schemaVersion, rollout, managementNodeLabelled, k3s] =
        await Promise.all([
          deps.intents.latest(),
          deps.schemaVersion(),
          deps.observeRollout(),
          deps.observeManagementLabel(),
          deps.hostSteps.latest('kubernetes').catch((error: unknown) => {
            deps.log.warn('Could not read the latest K3s step', {
              id: 'system',
              error: errorMessage(error),
            });
            return null;
          }),
        ]);
      const firstBackup = deps.firstBackup?.() ?? null;
      return {
        servedVersion: deps.servedVersion,
        schemaVersion,
        upgrade: await observeUpgrade(latest),
        rollout,
        ...(managementNodeLabelled === null ? {} : { managementNodeLabelled }),
        ...(firstBackup ? { firstBackup } : {}),
        ...(k3s ? { kubernetes: kubernetesStep(k3s) } : {}),
      };
    },
  };
}

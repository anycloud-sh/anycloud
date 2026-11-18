import {
  isTerminalState,
  WorkloadState,
} from '../../../../../src/shared/workload.js';

import type { ArtifactStore } from '../artifacts.js';
import type {
  SubstrateAbsent,
  WorkloadKernel,
  TrackedWorkloadRef,
} from '../workloads.js';
import type { Environment } from '../environment.js';
import type { FixtureNames } from '../names.js';
import type { ServeTargetFactory } from '../targets/serve.js';
import {
  publicServeUrl,
  type ServeAbsenceObservation,
  type ServeAbsenceObservationAttempt,
  type ServeBackingHost,
  type ServeReadyObservation,
  type ServeReadyObservationAttempt,
  type ServeSubmission,
  type ServeTarget,
  type ServeTargetAdapter,
  type ServeUpgradeTargetAdapter,
} from '../targets/serve-types.js';
import { isRecord, type StatusResponse } from '../types.js';
import type { VmLedgerProbe } from '../vm-ledger.js';
import type { Waiter } from '../wait.js';

export interface ServeStageDependencies {
  readonly nativeCleanup: {
    reserve(
      target: ServeTarget,
      profile: ServeTargetAdapter['profile'],
      id: string,
      timeoutMs: number,
      namedBundles: readonly string[],
    ): Promise<TrackedWorkloadRef>;
    capture(ref: TrackedWorkloadRef, status?: StatusResponse): Promise<void>;
    verify(
      ref: TrackedWorkloadRef,
      timeoutMs: number,
    ): Promise<SubstrateAbsent>;
  };
  readonly kernel: Pick<
    WorkloadKernel,
    | 'release'
    | 'requestTermination'
    | 'status'
    | 'waitForCleanupRecorded'
    | 'waitForState'
  >;
  readonly names: Pick<FixtureNames, 'workload'>;
  readonly targets: ServeTargetAdapter;
  readonly vmLedger: Pick<
    VmLedgerProbe,
    'assertCleared' | 'liveEntries' | 'liveVmCount' | 'snapshot'
  >;
  readonly wait: Pick<Waiter, 'for'>;
  now(this: void): number;
}

export interface ServeUpgradeStageDependencies
  extends Omit<ServeStageDependencies, 'targets'> {
  readonly targets: ServeUpgradeTargetAdapter;
}

/**
 * Every deadline a Serve stage may spend. Reaching Running and answering on the
 * published endpoint are separate budgets because they fail differently and by
 * different orders of magnitude: local state answers quickly, while a public
 * endpoint is a network round trip to another region.
 */
export interface ServeStageBudget {
  readonly cleanupMs: number;
  readonly endpointMs: number;
  readonly runningMs: number;
}

/**
 * What every Serve contract member needs before it can select its adapter. A
 * member resolves one target and then composes the stages above; it never
 * receives more than one adapter.
 */
export interface ServeMemberDependencies
  extends Omit<ServeStageDependencies, 'targets'> {
  readonly artifacts: Pick<ArtifactStore, 'json'>;
  readonly environment: Pick<Environment, 'milliseconds' | 'optional'>;
  readonly targets: Pick<ServeTargetFactory, 'adapter'>;
}

export interface SubmittedServe {
  readonly ref: TrackedWorkloadRef;
  readonly submission: ServeSubmission;
  readonly submittedStatus: StatusResponse;
}

export interface ReadyServe extends SubmittedServe {
  /** Every backing host observed so far, including replaced ones. */
  readonly hosts: readonly ServeBackingHost[];
  readonly readyObservation: ServeReadyObservation;
  readonly readyStatus: StatusResponse;
  readonly readiness: ServeReadinessTimeline;
}

/** The product's `running`: the container up, then this dwell (VM hosts from container start, node pools as `minReadySeconds`). */
export const SERVICE_STARTUP_DWELL_MS = 30_000;
/** Node pools: Pod Ready is read from the cluster clock and the product polls the Deployment; a skipped dwell reads near zero. */
export const SERVICE_DWELL_TOLERANCE_MS = 15_000;
/**
 * VM hosts: the `starting` event precedes the container start the product
 * dwells from, so `running − starting` exceeds the dwell by construction; the
 * slack covers the VM clock on the container's start time against the API's.
 */
export const SERVICE_STARTING_TOLERANCE_MS = 5_000;
/**
 * A VM host publishes its DNS record after the dwell, right before `running`;
 * the edge resolves the name within this window. Longer means the record never
 * landed, and any HTTP answer other than 200 meanwhile is the endpoint refusing.
 */
export const SERVICE_ENDPOINT_PUBLICATION_MS = 120_000;

/**
 * Product event times for the container start (`starting`) and `running`;
 * harness clock for the first endpoint answer and the first `running` read.
 */
export interface ServeReadinessTimeline {
  readonly startingEventAt: number;
  readonly runningEventAt: number;
  readonly readyAt: number;
  readonly runningAt: number;
}

/** The operator's bounded cleanup campaign fails only the completed live journey. */
export async function serviceCleanupFault(
  dependencies: Pick<ServeMemberDependencies, 'environment' | 'artifacts'>,
  service: ReadyServe,
  /** Keeps a member's second journey from overwriting the first one's records. */
  prefix?: string,
): Promise<void> {
  const name = (artifact: string) =>
    prefix ? `${prefix}-${artifact}` : artifact;
  const forced =
    dependencies.environment.optional(
      'E2E_SERVE_FORCE_FAILURE_BEFORE_FINALIZE',
    ) === '1';
  await dependencies.artifacts.json(name('service-finalization-boundary'), {
    schemaVersion: 1,
    workloadId: service.ref.id,
    target: service.submission.target,
    image: service.readyStatus.workload.image,
    imageDigest: service.readyStatus.workload.imageDigest,
    vmType: service.readyStatus.workload.vmType,
    region: service.readyStatus.workload.region,
    diskSizeGb: service.readyStatus.workload.diskSizeGb,
    hosts: service.hosts,
    dnsRecordId: service.readyStatus.workload.dnsRecordId,
    endpoint: service.readyObservation,
    forced,
  });
  if (!forced) return;
  await dependencies.artifacts.json(name('service-forced-cleanup'), {
    schemaVersion: 1,
    fault: 'before-finalize',
    workloadId: service.ref.id,
    target: service.submission.target,
    image: service.readyStatus.workload.image,
    imageDigest: service.readyStatus.workload.imageDigest,
    hosts: service.hosts,
    dnsRecordId: service.readyStatus.workload.dnsRecordId,
    expectedFailure: true,
  });
  throw new Error('Service forced cleanup: before-finalize');
}

/** The durable reason the control plane records for a URL-preserving upgrade. */
const SERVE_UPGRADE = 'serve-upgrade';

export function serveInvariant(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new Error(`Serve contract: ${message}`);
}

/**
 * What a substrate class is, stated once per kind rather than derived at each
 * decision. Adding a target kind is a compile error here, where the facts live,
 * instead of six silent fall-throughs spread across the stages.
 */
export interface ServeTargetClass {
  /** Live VM ledger rows a ready Service of this class must retain. */
  readonly liveVmRows: number;
  /**
   * Local state answers quickly; a public endpoint is a network round trip to
   * another region, which the Bash leg also polls at five seconds.
   */
  readonly observationIntervalMs: number;
  /** Whether readiness must find a persisted DNS record. */
  readonly publishesDns: boolean;
}

const SERVE_TARGET_CLASSES = {
  'local-smolvm': {
    liveVmRows: 1,
    observationIntervalMs: 1_000,
    publishesDns: false,
  },
  'public-cloud': {
    liveVmRows: 1,
    observationIntervalMs: 5_000,
    publishesDns: true,
  },
} as const satisfies Record<ServeTarget['kind'], ServeTargetClass>;

export function serveTargetClass(target: ServeTarget): ServeTargetClass {
  return SERVE_TARGET_CLASSES[target.kind];
}

function assertServeStatus(
  ref: TrackedWorkloadRef,
  status: StatusResponse,
): void {
  serveInvariant(
    status.workload.id === ref.id,
    `status identified ${status.workload.id}, expected ${ref.id}`,
  );
  serveInvariant(
    status.workload.workloadType === 'service',
    `${ref.id} persisted as ${status.workload.workloadType}, not Service`,
  );
}

function describeReadyObservation(observation: ServeReadyObservation): string {
  if (observation.kind === 'public-cloud') {
    return `${observation.url} returned HTTP ${String(observation.statusCode)}${observation.error ? ` (${observation.error})` : ''}`;
  }
  return `machines=${observation.machineCount}, state=${observation.machineState}, ssh=${observation.sshHostPort}, http=${observation.httpHostPort}, container=${observation.guestContainerId || 'absent'}`;
}

function describeReadyAttempt(
  attempt: ServeReadyObservationAttempt,
  expectedMarkers: readonly string[],
): string {
  if (attempt.kind === 'pending') return 'pending';
  const missing = missingMarkers(attempt.observation, expectedMarkers);
  const state = describeReadyObservation(attempt.observation);
  return missing.length === 0
    ? state
    : `${state}, response omitted ${missing.join(', ')}`;
}

function readyIdentityRejection(
  observation: ServeReadyObservation | ServeAbsenceObservation,
  target: ServeTarget,
): string | undefined {
  if (observation.kind === 'local-smolvm') {
    return target.kind === 'local-smolvm'
      ? undefined
      : 'target reported a local smolvm observation';
  }
  return target.kind === 'public-cloud' &&
    observation.provider === target.provider
    ? undefined
    : `target reported provider ${observation.provider}`;
}

/**
 * `ready`: the endpoint answers. `unobservable`: no answer reached the probe
 * (the hostname did not resolve, the connection failed, or the Cloudflare edge
 * answered 52x for an origin it cannot reach yet). `refused`: the endpoint
 * itself answered something other than 200, or a local host is not serving.
 */
function classifyReadyAttempt(
  attempt: ServeReadyObservationAttempt,
): 'ready' | 'unobservable' | 'refused' {
  if (attempt.kind === 'pending') return 'unobservable';
  if (ready(attempt.observation)) return 'ready';
  const { observation } = attempt;
  return observation.kind === 'public-cloud' &&
    (observation.statusCode === 0 ||
      (observation.statusCode >= 520 && observation.statusCode <= 530))
    ? 'unobservable'
    : 'refused';
}

function ready(observation: ServeReadyObservation): boolean {
  if (observation.kind === 'public-cloud')
    return observation.statusCode === 200;
  return (
    observation.machineCount === 1 &&
    observation.machineState === 'running' &&
    observation.sshHostPort > 0 &&
    observation.httpHostPort > 0 &&
    observation.sshHostPort !== observation.httpHostPort &&
    observation.guestContainerId.length > 0
  );
}

function missingMarkers(
  observation: ServeReadyObservation,
  expectedMarkers: readonly string[],
): readonly string[] {
  return expectedMarkers.filter(
    (marker) => !observation.responseBody.includes(marker),
  );
}

function assertReadyIdentity(
  observation: ServeReadyObservation,
  service: SubmittedServe,
): void {
  if (observation.kind === 'local-smolvm') {
    serveInvariant(
      observation.machineName === `ac-local-${service.ref.id}-0` ||
        observation.machineName.startsWith(`ac-local-${service.ref.id}-`),
      'target observed a microVM outside the workload ownership prefix',
    );
    return;
  }
  serveInvariant(
    observation.url === publicServeUrl(service.ref.id),
    'target observed an endpoint other than the Service public URL',
  );
}

async function waitForReadyObservation(
  dependencies: ServeStageDependencies,
  service: SubmittedServe,
  expectedMarkers: readonly string[],
  timeoutMs: number,
): Promise<ServeReadyObservation> {
  const attempt = await dependencies.wait.for(
    `Service ${service.ref.id} target readiness`,
    () =>
      dependencies.targets.observeReady(service.ref, service.submission.target),
    {
      timeoutMs,
      intervalMs: serveTargetClass(service.submission.target)
        .observationIntervalMs,
      probeError: 'fail',
      unmet: (candidate) =>
        candidate.kind === 'observed' &&
        ready(candidate.observation) &&
        missingMarkers(candidate.observation, expectedMarkers).length === 0
          ? undefined
          : describeReadyAttempt(candidate, expectedMarkers),
      reject: (candidate) =>
        candidate.kind === 'pending'
          ? undefined
          : readyIdentityRejection(
              candidate.observation,
              service.submission.target,
            ),
    },
  );
  serveInvariant(
    attempt.kind === 'observed',
    'target did not return a ready observation',
  );
  const observation = attempt.observation;
  serveInvariant(ready(observation), 'target Service is not ready');
  assertReadyIdentity(observation, service);
  serveInvariant(
    missingMarkers(observation, expectedMarkers).length === 0,
    `Service response omitted ${missingMarkers(observation, expectedMarkers).join(', ')}`,
  );
  return observation;
}

function describeAbsenceAttempt(
  attempt: ServeAbsenceObservationAttempt,
): string {
  if (attempt.kind === 'pending') return 'pending';
  const observation = attempt.observation;
  const hosts = observation.hosts
    .map((host) => `${host.cloudId} ${host.presence} (${host.diagnostic})`)
    .join('; ');
  return observation.kind === 'local-smolvm'
    ? `${hosts}; open ports ${observation.openForwardedPorts.join(', ') || 'none'}`
    : `${hosts}; DNS ${observation.dns.hostname}: ${observation.dns.answers.map((answer) => `${answer.authority} ${answer.presence} (${answer.diagnostic})`).join('; ')}`;
}

function absent(observation: ServeAbsenceObservation): boolean {
  if (observation.kind === 'public-cloud') {
    return (
      observation.hosts.every((host) => host.presence === 'absent') &&
      observation.dns.answers.length > 0 &&
      observation.dns.answers.every((answer) => answer.presence === 'absent')
    );
  }
  return (
    observation.hosts.every((host) => host.presence === 'absent') &&
    observation.openForwardedPorts.length === 0
  );
}

function assertAbsenceCoverage(
  observation: ServeAbsenceObservation,
  hosts: readonly ServeBackingHost[],
): void {
  const observed = observation.hosts.map((host) => host.cloudId).sort();
  const recorded = [...hosts.map((host) => host.cloudId)].sort();
  serveInvariant(
    recorded.length > 0,
    'no backing host was recorded before absence',
  );
  serveInvariant(
    JSON.stringify(observed) === JSON.stringify(recorded),
    'absence observation did not cover every recorded backing host',
  );
}

async function waitForTargetAbsence(
  dependencies: ServeStageDependencies,
  service: ReadyServe,
  timeoutMs: number,
): Promise<ServeAbsenceObservation> {
  const attempt = await dependencies.wait.for(
    `Service ${service.ref.id} target absence`,
    (deadlineAt) =>
      dependencies.targets.observeAbsent(
        service.ref,
        service.submission.target,
        service.hosts,
        deadlineAt,
      ),
    {
      timeoutMs,
      intervalMs: serveTargetClass(service.submission.target)
        .observationIntervalMs,
      probeError: 'fail',
      unmet: (candidate) =>
        candidate.kind === 'observed' && absent(candidate.observation)
          ? undefined
          : describeAbsenceAttempt(candidate),
      reject: (candidate) =>
        candidate.kind === 'pending'
          ? undefined
          : readyIdentityRejection(
              candidate.observation,
              service.submission.target,
            ),
    },
  );
  serveInvariant(
    attempt.kind === 'observed',
    'target did not return an absence observation',
  );
  assertAbsenceCoverage(attempt.observation, service.hosts);
  if (attempt.observation.kind === 'public-cloud') {
    const dns = attempt.observation.dns;
    serveInvariant(
      dns.hostname === new URL(publicServeUrl(service.ref.id)).hostname &&
        dns.authorities.length > 0 &&
        new Set(dns.authorities).size === dns.authorities.length &&
        JSON.stringify([...dns.authorities].sort()) ===
          JSON.stringify(dns.answers.map((answer) => answer.authority).sort()),
      'DNS absence did not cover the Service hostname and every delegated authority',
    );
  }
  serveInvariant(absent(attempt.observation), 'target resources still exist');
  return attempt.observation;
}

/** Normal and fallback finalization require the same persisted Service proof. */
export function assertServeCleanupRecorded(
  ref: TrackedWorkloadRef,
  status: StatusResponse,
): void {
  assertServeStatus(ref, status);
  const workload = status.workload;
  serveInvariant(
    workload.state === WorkloadState.Terminated,
    `cleanup recorded ${workload.state}, expected Terminated`,
  );
  serveInvariant(
    typeof workload.completedAt === 'number' &&
      Number.isFinite(workload.completedAt),
    'termination did not persist completedAt',
  );
  serveInvariant(
    typeof workload.cleanedAt === 'number' &&
      Number.isFinite(workload.cleanedAt) &&
      workload.cleanedAt >= workload.completedAt,
    'termination cleanup timestamps are invalid',
  );
}

/**
 * Reads the workload-owned backing host a ready Service is running on.
 */
export function serveBackingHosts(
  dependencies: ServeStageDependencies,
  ref: TrackedWorkloadRef,
  status: StatusResponse,
): readonly ServeBackingHost[] {
  const live = dependencies.vmLedger.liveEntries(
    dependencies.vmLedger.snapshot(ref, status),
  );
  serveInvariant(
    live.length === 1,
    `ready Service has ${String(live.length)} live VM rows, expected 1`,
  );
  const entry = live[0];
  serveInvariant(entry, 'ready Service did not expose a live VM');
  const cloudId = String(entry.cloudId ?? '');
  serveInvariant(cloudId.length > 0, 'live VM cloud ID is missing');
  return [
    {
      availabilityZone:
        entry.availabilityZone ?? status.workload.availabilityZone,
      cloudId,
      region: entry.region ?? status.workload.region,
    },
  ];
}

function mergedHosts(
  existing: readonly ServeBackingHost[],
  observed: readonly ServeBackingHost[],
): readonly ServeBackingHost[] {
  const known = new Set(existing.map((host) => host.cloudId));
  return [...existing, ...observed.filter((host) => !known.has(host.cloudId))];
}

export async function submitServe(
  dependencies: ServeStageDependencies,
  namePrefix: string,
  submission: ServeSubmission,
  budget: ServeStageBudget,
): Promise<SubmittedServe> {
  const ref = await dependencies.nativeCleanup.reserve(
    submission.target,
    dependencies.targets.profile,
    dependencies.names.workload(namePrefix),
    budget.cleanupMs,
    submission.secretNames ?? [],
  );
  const acceptance = await dependencies.targets.submit(ref, submission);
  serveInvariant(
    acceptance.id === ref.id,
    `submission accepted ${acceptance.id}, expected ${ref.id}`,
  );
  const submittedStatus = await dependencies.kernel.status(ref);
  await dependencies.nativeCleanup.capture(ref, submittedStatus);
  assertServeStatus(ref, submittedStatus);
  serveInvariant(
    submittedStatus.workload.image === submission.image,
    'persisted image does not match the submission',
  );
  return { ref, submission, submittedStatus };
}

/**
 * Two-sided on purpose: a target class that publishes no DNS must be shown not
 * to have published one. Checking only the positive case lets a substrate that
 * leaks a public record pass as though it were private.
 */
export function dnsUnmet(
  dnsRecordId: string | null | undefined,
  targetClass: Pick<ServeTargetClass, 'publishesDns'>,
): string | undefined {
  const published = (dnsRecordId ?? '').length > 0;
  if (published === targetClass.publishesDns) return undefined;
  return targetClass.publishesDns
    ? 'ready Service did not persist a DNS record'
    : 'target class publishes no DNS, yet a DNS record was persisted';
}

/**
 * Status and endpoint in the same pass until both `running` and the endpoint
 * answering are seen. A target class that publishes DNS is probed only once
 * status carries the record: a lookup before it exists caches the NXDOMAIN for
 * the zone's negative TTL. `running` while the endpoint refuses fails at that
 * pass; `running` while the endpoint is not observable yet is the DNS record
 * landing and is allowed for `SERVICE_ENDPOINT_PUBLICATION_MS`. The dwell is
 * checked on the product's own event times (`starting` → `running`), so the
 * edge's propagation never biases it. The response markers stay in
 * `waitForReadyObservation`.
 */
async function observeRunningAfterReadiness(
  dependencies: ServeStageDependencies,
  service: SubmittedServe,
  budget: ServeStageBudget,
): Promise<{
  readonly readyStatus: StatusResponse;
  readonly readiness: ServeReadinessTimeline;
}> {
  const target = service.submission.target;
  const { observationIntervalMs: intervalMs, publishesDns } =
    serveTargetClass(target);
  let readyAt: number | undefined;
  let runningAt: number | undefined;
  let readyStatus: StatusResponse | undefined;
  await dependencies.wait.for(
    `Service ${service.ref.id} readiness, then Running`,
    async () => {
      const status = await dependencies.kernel.status(service.ref);
      const observedAt = dependencies.now();
      const recordPersisted = !publishesDns || !!status.workload.dnsRecordId;
      // The record ID is persisted before the product's publication gate so
      // cleanup owns it on failure. Running follows that gate on VM hosts.
      const publicationReady =
        recordPersisted &&
        (!publishesDns || status.workload.state === WorkloadState.Running);
      const attempt: ServeReadyObservationAttempt = publicationReady
        ? await dependencies.targets.observeReady(service.ref, target)
        : { kind: 'pending' };
      const probe = classifyReadyAttempt(attempt);
      if (attempt.kind === 'observed') {
        const rejection = readyIdentityRejection(attempt.observation, target);
        serveInvariant(rejection === undefined, rejection ?? '');
        if (probe === 'ready') readyAt ??= observedAt;
      }
      if (status.workload.state === WorkloadState.Running) {
        readyStatus ??= status;
        runningAt ??= observedAt;
        if (readyAt === undefined) {
          serveInvariant(
            probe !== 'refused',
            `Service ${service.ref.id} reported running while its endpoint still refused (${describeReadyAttempt(attempt, [])})`,
          );
          serveInvariant(
            observedAt - runningAt <= SERVICE_ENDPOINT_PUBLICATION_MS,
            `Service ${service.ref.id} has been running for ${String(observedAt - runningAt)}ms while its endpoint stayed unreachable (${recordPersisted ? describeReadyAttempt(attempt, []) : 'no DNS record persisted'}); the publication window is ${String(SERVICE_ENDPOINT_PUBLICATION_MS)}ms`,
          );
        }
      }
      return status.workload.state;
    },
    {
      timeoutMs: budget.runningMs + budget.endpointMs,
      intervalMs,
      probeError: 'fail',
      reject: (state) =>
        isTerminalState(state) && state !== WorkloadState.Running
          ? `reached terminal state ${state}`
          : undefined,
      unmet: (state) =>
        runningAt !== undefined && readyAt !== undefined
          ? undefined
          : `${state}; endpoint ${readyAt === undefined ? 'not yet answering' : 'answering'}`,
    },
  );
  serveInvariant(
    readyStatus && readyAt !== undefined && runningAt !== undefined,
    'Service readiness timeline is incomplete',
  );
  // The product dwells from the container start, which its `starting` event
  // precedes; a `running` without the dwell lands seconds after `starting`.
  // A replayed step adopts the already-dwelt container, so it does not count.
  const runningIndex = readyStatus.events.findLastIndex(
    (event) => event.state === WorkloadState.Running,
  );
  const runningEventAt = readyStatus.events[runningIndex]?.createdAt;
  const startingEventAt = readyStatus.events
    .slice(0, Math.max(runningIndex, 0))
    .findLast(
      (event) =>
        event.state === WorkloadState.Starting &&
        !(
          isRecord(event.metadata) &&
          event.metadata.reason === 'active-step-replay'
        ),
    )?.createdAt;
  serveInvariant(
    runningEventAt !== undefined && startingEventAt !== undefined,
    'running status carries no starting and running events',
  );
  const dwellMs = runningEventAt - startingEventAt;
  serveInvariant(
    dwellMs >= SERVICE_STARTUP_DWELL_MS - SERVICE_STARTING_TOLERANCE_MS,
    `Service ${service.ref.id} reached running ${String(dwellMs)}ms after its container start began; the startup dwell is ${String(SERVICE_STARTUP_DWELL_MS)}ms`,
  );
  return {
    readyStatus,
    readiness: { startingEventAt, runningEventAt, readyAt, runningAt },
  };
}

export async function awaitServeReady(
  dependencies: ServeStageDependencies,
  service: SubmittedServe | ReadyServe,
  expectedMarkers: readonly string[],
  budget: ServeStageBudget,
): Promise<ReadyServe> {
  const target = service.submission.target;
  const { readyStatus, readiness } = await observeRunningAfterReadiness(
    dependencies,
    service,
    budget,
  );
  assertServeStatus(service.ref, readyStatus);
  const targetClass = serveTargetClass(target);
  serveInvariant(
    (await dependencies.vmLedger.liveVmCount(service.ref)) ===
      targetClass.liveVmRows,
    `ready Service did not retain ${String(targetClass.liveVmRows)} live VM rows`,
  );
  const dnsUnmetReason = dnsUnmet(
    readyStatus.workload.dnsRecordId,
    targetClass,
  );
  serveInvariant(dnsUnmetReason === undefined, dnsUnmetReason ?? '');
  const hosts = mergedHosts(
    'hosts' in service ? service.hosts : [],
    serveBackingHosts(dependencies, service.ref, readyStatus),
  );
  const readyObservation = await waitForReadyObservation(
    dependencies,
    service,
    expectedMarkers,
    budget.endpointMs,
  );
  await dependencies.nativeCleanup.capture(service.ref, readyStatus);
  return { ...service, hosts, readyObservation, readyStatus, readiness };
}

export async function provisionReadyServe(
  dependencies: ServeStageDependencies,
  namePrefix: string,
  submission: ServeSubmission,
  expectedMarkers: readonly string[],
  budget: ServeStageBudget,
): Promise<ReadyServe> {
  const submitted = await submitServe(
    dependencies,
    namePrefix,
    submission,
    budget,
  );
  return awaitServeReady(dependencies, submitted, expectedMarkers, budget);
}

export async function upgradeServe(
  dependencies: ServeUpgradeStageDependencies,
  service: ReadyServe,
  submission: ServeSubmission,
  expectedMarkers: readonly string[],
  budget: ServeStageBudget,
  afterAccepted?: () => Promise<void>,
): Promise<ReadyServe> {
  serveInvariant(
    JSON.stringify(submission.target) ===
      JSON.stringify(service.submission.target),
    'upgrade changed the target placement',
  );
  const baseline = (await dependencies.kernel.status(service.ref, true)).events
    .length;
  const previousHosts = new Set(service.hosts.map((host) => host.cloudId));
  await dependencies.targets.upgrade(service.ref, submission);
  await afterAccepted?.();
  const readyStatus = await dependencies.wait.for(
    `Service ${service.ref.id} upgrade to record Running`,
    () => dependencies.kernel.status(service.ref, true),
    {
      timeoutMs: budget.runningMs,
      // Persisted status, not the target, so this is the status cadence rather
      // than the target class's observation interval.
      intervalMs: 2_000,
      probeError: 'fail',
      unmet: (candidate) =>
        candidate.workload.state === WorkloadState.Running &&
        candidate.events
          .slice(baseline)
          .some((event) => event.state === WorkloadState.Running)
          ? undefined
          : `${candidate.workload.state}, ${candidate.events.length - baseline} new events`,
      reject: (candidate) =>
        [
          WorkloadState.Failed,
          WorkloadState.Errored,
          WorkloadState.Invalid,
          WorkloadState.Terminated,
        ].includes(candidate.workload.state)
          ? `reached ${candidate.workload.state}`
          : undefined,
    },
  );
  assertServeStatus(service.ref, readyStatus);
  serveInvariant(
    readyStatus.workload.image === submission.image,
    'upgrade did not persist the replacement image',
  );
  serveInvariant(
    readyStatus.workload.dnsRecordId ===
      service.readyStatus.workload.dnsRecordId,
    'upgrade changed the persisted Service DNS identity',
  );
  serveInvariant(
    readyStatus.events
      .slice(baseline)
      .some(
        (event) =>
          isRecord(event.metadata) && event.metadata.reason === SERVE_UPGRADE,
      ),
    'upgrade did not record a durable serve-upgrade transition',
  );
  const submitted: SubmittedServe = {
    ref: service.ref,
    submission,
    submittedStatus: readyStatus,
  };
  const readyObservation = await waitForReadyObservation(
    dependencies,
    submitted,
    expectedMarkers,
    budget.endpointMs,
  );
  const observed = serveBackingHosts(dependencies, service.ref, readyStatus);
  await dependencies.nativeCleanup.capture(service.ref, readyStatus);
  serveInvariant(
    observed.every((host) => !previousHosts.has(host.cloudId)),
    'upgrade reused the original backing VM',
  );
  return {
    ...submitted,
    hosts: mergedHosts(service.hosts, observed),
    readiness: service.readiness,
    readyObservation,
    readyStatus,
  };
}

/** Collect exact cleanup proofs while the Workload remains registered. */
export async function observeServeTermination(
  dependencies: ServeStageDependencies,
  service: ReadyServe,
  budget: ServeStageBudget,
): Promise<
  Parameters<ServeStageDependencies['kernel']['release']>[0] & {
    readonly nativeAbsence: ServeAbsenceObservation;
  }
> {
  await dependencies.kernel.requestTermination(service.ref, budget.cleanupMs);
  const terminal = await dependencies.kernel.waitForState(
    service.ref,
    WorkloadState.Terminated,
    budget.cleanupMs,
  );
  assertServeStatus(service.ref, terminal);
  const cleanup = await dependencies.kernel.waitForCleanupRecorded(
    service.ref,
    budget.cleanupMs,
  );
  assertServeCleanupRecorded(service.ref, cleanup.status);
  const ledger = await dependencies.vmLedger.assertCleared(service.ref);
  await dependencies.nativeCleanup.capture(service.ref, cleanup.status);
  const substrate = await dependencies.nativeCleanup.verify(
    service.ref,
    budget.cleanupMs,
  );
  const nativeAbsence = await waitForTargetAbsence(
    dependencies,
    service,
    budget.cleanupMs,
  );
  return {
    cleanup,
    ledger,
    nativeAbsence,
    substrate,
  };
}

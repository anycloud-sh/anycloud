import { randomUUID } from 'node:crypto';

import { CloudType } from '../../../../../src/shared/cloud.js';
import { awaitWithSignal } from '../../../../../src/api/services/request-budget.js';

import type { ArtifactStore } from '../artifacts.js';
import type { FixtureFiles } from '../files.js';
import type { ProcessRunner } from '../process.js';
import type { VmProfile } from '../profiles.js';
import { isRecord, type CommandOptions, type CommandResult } from '../types.js';
import {
  TargetHttpProtocolError,
  type TargetHttpClient,
  type TargetHttpResponse,
} from './http.js';

type CommandRunner = Pick<ProcessRunner, 'run'>;
type PresenceFiles = Pick<FixtureFiles, 'directory' | 'privateText'>;
type PresenceHttp = Pick<TargetHttpClient, 'get'>;
type Environment = Readonly<Record<string, string | undefined>>;
type PresenceResult = Pick<
  VmHostPresenceObservation,
  'diagnostic' | 'presence'
>;

interface AwsReservationInventory {
  readonly pages: number;
  readonly instanceIds: readonly string[];
}

export interface VmReservationPresenceObservation {
  /** An empty current inventory is not proof that creation never succeeded. */
  readonly kind: 'exact-attempt-current-presence';
  readonly observedAt: number;
  readonly provider: CloudType;
  readonly credentialName: string;
  readonly diagnostic: string;
  readonly inventory: {
    readonly pages: number;
    readonly instances: number;
    readonly complete: boolean;
  } | null;
  readonly attempts: readonly {
    readonly attemptId: string;
    readonly region: string | null;
    readonly availabilityZone: string | null;
    readonly presence: VmHostPresence;
    readonly instanceIds: readonly string[];
  }[];
}

interface VmReservationObservationOptions extends VmHostObservationOptions {
  /** Retain validated matches before any later page can fail or time out. */
  readonly onPartialObservation?: (
    observation: VmReservationPresenceObservation,
  ) => void;
}

/** Original ledger coordinates; a native read must never widen their scope. */
export interface VmHostLocation {
  readonly availabilityZone: string | null;
  readonly cloudId: string;
  readonly region: string | null;
}

/** Only `absent` satisfies an absence assertion. */
export type VmHostPresence = 'absent' | 'present' | 'unknown';

export interface VmHostPresenceObservation {
  readonly cloudId: string;
  readonly diagnostic: string;
  readonly presence: VmHostPresence;
  readonly provider: CloudType;
}

export interface VmHostObservationOptions {
  readonly deadlineAt?: number;
  readonly signal?: AbortSignal;
  /**
   * The Workload whose absent VM must also have no boot disk left. Lambda's
   * boot disk is part of the instance, so it has no separate read.
   */
  readonly bootDiskOwner?: string;
}

/** Authentication and schema failures are errors, never absence answers. */
export class VmHostPresenceProtocolError extends Error {}

/** A bounded observation expired; it establishes neither presence nor absence. */
export class VmHostPresenceDeadlineError extends Error {}

const AWS_ID = /^i-(?:[a-f0-9]{8}|[a-f0-9]{17})$/u;
const LAMBDA_ID = /^[a-f0-9]{32}$/u;
const AWS_STATES = new Set([
  'pending',
  'running',
  'shutting-down',
  'terminated',
  'stopping',
  'stopped',
]);
const LAMBDA_STATES = new Set([
  'booting',
  'active',
  'unhealthy',
  'terminating',
  'terminated',
  'preempted',
]);
const GCP_STATES = new Set([
  'PROVISIONING',
  'STAGING',
  'RUNNING',
  'STOPPING',
  'SUSPENDING',
  'SUSPENDED',
  'REPAIRING',
  'TERMINATED',
  'PENDING_STOP',
]);
const AZURE_STATES = new Set([
  'Creating',
  'Updating',
  'Deleting',
  'Succeeded',
  'Failed',
  'Migrating',
]);
const AUTH_ERRORS =
  /AuthFailure|UnauthorizedOperation|InvalidClientTokenId|RequestExpired|ExpiredToken|AccessDenied|AuthorizationFailed|AuthenticationFailed|InvalidAuthenticationToken|AADSTS|unauthoriz|unauthenticated|forbidden|permission|invalid credential|unable to locate credentials|please run .az login|active account/iu;
const TRANSIENT_ERRORS =
  /RequestLimitExceeded|Throttling|TooManyRequests|ServiceUnavailable|InternalError|GatewayTimeout|Retryable|temporarily unavailable|Quota exceeded|rateLimitExceeded|backendError|Service Unavailable|Deadline Exceeded|Could not connect|EndpointConnectionError/iu;
const GCP_API_ROOTS = [
  'https://www.googleapis.com/compute/v1/',
  'https://compute.googleapis.com/compute/v1/',
];
const LAMBDA_RELEASE_STABILITY_MS = 10_000;
const MAX_OBSERVATION_MS = 30_000;
const AWS_RESERVATION_MAX_PAGES = 100;
const RESERVATION_ABSENCE_STABILITY_MS = 10_000;

function reservationKey(attempt: VmHostLocation): string {
  return JSON.stringify([
    attempt.cloudId,
    attempt.region,
    attempt.availabilityZone,
  ]);
}

function invalid(message: string): never {
  throw new VmHostPresenceProtocolError(`Host presence: ${message}`);
}

function required(value: string | null, message: string): string {
  if (!value) invalid(message);
  return value;
}

function assertId(id: string, pattern: RegExp, provider: string): void {
  if (!pattern.test(id)) invalid(`${provider} native instance ID is malformed`);
}

function successBody(body: unknown, provider: string): Record<string, unknown> {
  if (
    !isRecord(body) ||
    'error' in body ||
    'errors' in body ||
    'Errors' in body
  )
    invalid(`${provider} response has an invalid or contradictory envelope`);
  return body;
}

function parsedBody(result: CommandResult, provider: string): unknown {
  if (result.stderr.trim())
    invalid(`${provider} success included error output`);
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    invalid(`${provider} response is not complete JSON`);
  }
}

export function awsZone(
  region: string,
  value: string | null,
): string | undefined {
  if (value === null) return undefined;
  let zone = value;
  if (/^[a-z]$/u.test(value)) zone = `${region}${value}`;
  // The AWS gateway persists the final hyphen-delimited component, e.g. 1f
  // from us-east-1f. Keep its number so a foreign region suffix still fails.
  else if (/^[0-9]+[a-z]$/u.test(value))
    zone = `${region.slice(0, region.lastIndexOf('-') + 1)}${value}`;
  if (
    !zone.startsWith(region) ||
    !/^(?:[a-z]|-[a-z0-9]+(?:-[a-z0-9]+)*)$/u.test(zone.slice(region.length))
  )
    invalid('AWS availability zone differs from its original region');
  return zone;
}

export function awsInstanceStates(
  value: unknown,
  expectedInstanceId: string,
  location?: Pick<VmHostLocation, 'region' | 'availabilityZone'>,
): readonly string[] {
  assertId(expectedInstanceId, AWS_ID, 'AWS');
  const body = successBody(value, 'AWS');
  if (
    !Array.isArray(body.Reservations) ||
    (body.NextToken !== undefined &&
      body.NextToken !== null &&
      body.NextToken !== '')
  )
    invalid('AWS response is not a complete instance inventory');
  const states: string[] = [];
  for (const reservation of body.Reservations) {
    if (!isRecord(reservation) || !Array.isArray(reservation.Instances))
      invalid('AWS reservation omitted its instances');
    for (const instance of reservation.Instances) {
      if (
        !isRecord(instance) ||
        instance.InstanceId !== expectedInstanceId ||
        !isRecord(instance.State) ||
        typeof instance.State.Name !== 'string' ||
        !AWS_STATES.has(instance.State.Name)
      )
        invalid(
          'AWS response has a foreign identity or malformed instance state',
        );
      if (location) {
        const region = required(location.region, 'AWS region is missing');
        const zone = isRecord(instance.Placement)
          ? instance.Placement.AvailabilityZone
          : undefined;
        const expectedZone = awsZone(region, location.availabilityZone);
        if (
          typeof zone !== 'string' ||
          awsZone(region, zone) !== zone ||
          (expectedZone !== undefined && zone !== expectedZone)
        )
          invalid('AWS instance differs from its original placement');
      }
      states.push(instance.State.Name);
    }
  }
  if (states.length > 1) invalid('AWS response repeats the requested identity');
  return states;
}

export function interpretAwsHostPresence(
  states: readonly string[],
): VmHostPresence {
  if (states.length > 1 || states.some((state) => !AWS_STATES.has(state)))
    invalid('AWS instance state observation is malformed or duplicated');
  return states.length === 0 || states[0] === 'terminated'
    ? 'absent'
    : 'present';
}

export interface LambdaNativeInstance {
  readonly id: string;
  readonly status: string;
  readonly region?: string;
  readonly name?: string;
}

function lambdaRow(value: unknown): LambdaNativeInstance {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !LAMBDA_ID.test(value.id) ||
    typeof value.status !== 'string' ||
    !LAMBDA_STATES.has(value.status)
  )
    invalid('Lambda instance identity or status is malformed');
  if (
    value.region !== undefined &&
    (!isRecord(value.region) ||
      typeof value.region.name !== 'string' ||
      !value.region.name)
  )
    invalid('Lambda instance region is malformed');
  if (
    value.name !== undefined &&
    (typeof value.name !== 'string' || value.name.length > 64)
  )
    invalid('Lambda instance name is malformed');
  return {
    id: value.id,
    status: value.status,
    ...(isRecord(value.region) ? { region: value.region.name as string } : {}),
    ...(typeof value.name === 'string' ? { name: value.name } : {}),
  };
}

function assertLambdaPlacement(
  row: ReturnType<typeof lambdaRow>,
  expectedRegion?: string,
): void {
  if (expectedRegion !== undefined && row.region !== expectedRegion)
    invalid('Lambda instance differs from its original placement');
}

function httpTransient(
  response: TargetHttpResponse,
  provider: string,
): boolean {
  if (
    !Number.isInteger(response.status) ||
    response.status < 100 ||
    response.status > 599
  )
    invalid(`${provider} HTTP status is malformed`);
  if (response.status === 401 || response.status === 403)
    invalid(`${provider} authentication was rejected`);
  return response.status === 429 || response.status >= 500;
}

export function interpretLambdaPointHostPresence(
  response: TargetHttpResponse,
  expectedInstanceId: string,
  expectedRegion?: string,
): VmHostPresence {
  assertId(expectedInstanceId, LAMBDA_ID, 'Lambda');
  if (httpTransient(response, 'Lambda')) return 'unknown';
  if (response.status === 404) {
    const body = response.body;
    if (
      !isRecord(body) ||
      Object.keys(body).length !== 1 ||
      !isRecord(body.error) ||
      body.error.code !== 'global/object-does-not-exist' ||
      typeof body.error.message !== 'string' ||
      !body.error.message.trim()
    )
      invalid('Lambda NotFound did not contain its typed native error');
    return 'absent';
  }
  if (response.status !== 200)
    invalid('Lambda point read returned an unexpected HTTP status');
  const row = lambdaRow(successBody(response.body, 'Lambda').data);
  if (row.id !== expectedInstanceId)
    invalid('Lambda point response has a foreign identity');
  assertLambdaPlacement(row, expectedRegion);
  return row.status === 'terminated' ? 'absent' : 'present';
}

export function interpretLambdaListHostPresence(
  response: TargetHttpResponse,
  expectedInstanceId: string,
  expectedRegion?: string,
): VmHostPresence {
  assertId(expectedInstanceId, LAMBDA_ID, 'Lambda');
  const rows = parseLambdaInstanceInventory(response);
  if (rows === null) return 'unknown';
  const row = rows.find((instance) => instance.id === expectedInstanceId);
  if (!row) return 'absent';
  assertLambdaPlacement(row, expectedRegion);
  return row.status === 'terminated' ? 'absent' : 'present';
}

/** A complete authenticated inventory, projected without notebook credentials. */
export function parseLambdaInstanceInventory(
  response: TargetHttpResponse,
): readonly LambdaNativeInstance[] | null {
  if (httpTransient(response, 'Lambda')) return null;
  if (response.status !== 200)
    invalid('Lambda list returned an unexpected HTTP status');
  const body = successBody(response.body, 'Lambda');
  if (
    !Array.isArray(body.data) ||
    Object.keys(body).some((key) => key !== 'data' && key !== 'page_token') ||
    // Lambda returns `page_token: null` only on the last page.
    (body.page_token !== undefined && body.page_token !== null)
  )
    invalid('Lambda list is not a complete instance inventory');
  const rows = body.data.map(lambdaRow);
  if (new Set(rows.map((row) => row.id)).size !== rows.length)
    invalid('Lambda list repeats an instance identity');
  return rows;
}

export function combineLambdaHostPresence(
  point: VmHostPresence,
  list: VmHostPresence,
): VmHostPresence {
  if (point === 'present' || list === 'present') return 'present';
  return point === 'absent' && list === 'absent' ? 'absent' : 'unknown';
}

function assertComplete(result: CommandResult, provider: string): void {
  if (
    result.outputTruncated !== false ||
    result.spawnError !== undefined ||
    result.signal !== null ||
    !Number.isSafeInteger(result.exitCode) ||
    result.exitCode === null ||
    result.exitCode < 0
  )
    invalid(`${provider} process receipt is incomplete`);
}

function nativeFailure(
  result: CommandResult,
  provider: CloudType,
  missing: (stderr: string) => boolean,
): PresenceResult {
  if (result.stdout.trim())
    invalid(`${provider} failure included contradictory output`);
  // Authentication and malformed identifiers take precedence over diagnostic
  // text that happens to quote a missing resource.
  if (
    AUTH_ERRORS.test(result.stderr) ||
    /InvalidInstanceID.Malformed/u.test(result.stderr)
  )
    invalid(`${provider} authentication or request identity was rejected`);
  if (TRANSIENT_ERRORS.test(result.stderr))
    return {
      presence: 'unknown',
      diagnostic: 'provider temporarily unavailable',
    };
  if (missing(result.stderr.trim()))
    return {
      presence: 'absent',
      diagnostic: 'exact native identity not found',
    };
  invalid(`${provider} failure is not a recognized exact-resource response`);
}

function azureGroup(region: string): string {
  return `anycloud-${region.replaceAll(/\s+/gu, '-').toLowerCase()}`;
}

/** A missing resource group, or the exact missing resource when one is named. */
function azureMissing(stderr: string, group: string, exact?: string): boolean {
  const envelope =
    /^(?:ERROR: )?\((ResourceNotFound|ResourceGroupNotFound)\) ([^\n]+)(?:\nCode: \1\nMessage: \2)?$/u.exec(
      stderr,
    );
  if (!envelope) return false;
  const message = envelope[2];
  if (envelope[1] === 'ResourceGroupNotFound')
    return message === `Resource group '${group}' could not be found.`;
  return (
    exact !== undefined &&
    (message === exact ||
      message ===
        `${exact} For more details please go to https://aka.ms/ARMResourceNotFoundFix`)
  );
}

function remainingMs(deadlineAt: number, signal?: AbortSignal): number {
  signal?.throwIfAborted();
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0)
    throw new VmHostPresenceDeadlineError(
      'Host presence observation deadline expired',
    );
  return Math.min(remaining, MAX_OBSERVATION_MS);
}

function isolatedEnvironment(
  prefix: RegExp,
): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.keys(process.env)
      .filter((name) => prefix.test(name))
      .map((name) => [name, undefined]),
  );
}

/** One private, immutable-credential session, shared only within its probe. */
class ProviderCliSession {
  #pending: Promise<Environment> | undefined;

  async environment(
    authenticate: () => Promise<Environment>,
    signal: AbortSignal,
  ): Promise<Environment> {
    this.#pending ??= authenticate().catch((error: unknown) => {
      this.#pending = undefined;
      throw error;
    });
    return awaitWithSignal(this.#pending, signal);
  }
}

export class PublicCloudVmHostPresenceProbeFactory {
  constructor(
    private readonly commands: CommandRunner,
    private readonly files: PresenceFiles,
    private readonly http: PresenceHttp,
    private readonly artifacts?: Pick<ArtifactStore, 'json'>,
  ) {}

  create(profile: VmProfile): PublicCloudVmHostPresenceProbe {
    return new PublicCloudVmHostPresenceProbe(
      profile,
      this.commands,
      this.files,
      this.http,
      this.artifacts,
    );
  }
}

export class PublicCloudVmHostPresenceProbe {
  readonly #commands: CommandRunner;
  readonly #files: PresenceFiles;
  readonly #http: PresenceHttp;
  readonly #profile: VmProfile;
  readonly #artifacts?: Pick<ArtifactStore, 'json'>;
  readonly #session = new ProviderCliSession();
  readonly #probeId = randomUUID();
  readonly #sessionPath = `native-host-presence/${this.#probeId}`;
  readonly #lambdaReleaseAgreementSince = new Map<string, number>();
  readonly #reservationAbsenceSince = new Map<string, number>();
  #observations = 0;

  constructor(
    profile: VmProfile,
    commands: CommandRunner,
    files: PresenceFiles,
    http: PresenceHttp,
    artifacts?: Pick<ArtifactStore, 'json'>,
  ) {
    if (profile.provider !== profile.credential.cloudProvider)
      invalid('profile provider and original credential disagree');
    this.#profile = structuredClone(profile);
    this.#commands = commands;
    this.#files = files;
    this.#http = http;
    this.#artifacts = artifacts;
  }

  async observe(
    originalLocation: VmHostLocation,
    options: VmHostObservationOptions = {},
  ): Promise<VmHostPresenceObservation> {
    const location = { ...originalLocation };
    this.#validateLocation(location);
    const requestedDeadline =
      options.deadlineAt ?? Date.now() + MAX_OBSERVATION_MS;
    if (!Number.isSafeInteger(requestedDeadline))
      invalid('observation deadline is invalid');
    const deadlineAt = Math.min(
      requestedDeadline,
      Date.now() + MAX_OBSERVATION_MS,
    );
    const controller = new AbortController();
    const observationDeadline = AbortSignal.timeout(
      remainingMs(deadlineAt, options.signal),
    );
    const signal = AbortSignal.any([
      controller.signal,
      observationDeadline,
      ...(options.signal ? [options.signal] : []),
    ]);
    try {
      let presence = await this.#presence(location, deadlineAt, signal);
      if (presence.presence === 'absent' && options.bootDiskOwner)
        presence =
          (await this.#bootDisk(
            location,
            options.bootDiskOwner,
            deadlineAt,
            signal,
          )) ?? presence;
      remainingMs(deadlineAt, signal);
      const observation = {
        cloudId: location.cloudId,
        diagnostic: presence.diagnostic,
        presence: presence.presence,
        provider: this.#profile.provider,
      };
      // Native HTTP bodies can include notebook tokens for unrelated hosts.
      // CLI output can contain credentials even on failure. Neither is retained.
      if (this.#artifacts)
        await awaitWithSignal(
          this.#artifacts.json(
            `${this.#profile.provider}-native-host-${this.#probeId}-${++this.#observations}`,
            {
              ...observation,
              region: location.region,
              availabilityZone: location.availabilityZone,
            },
          ),
          signal,
        );
      remainingMs(deadlineAt, signal);
      return observation;
    } catch (error) {
      // Authentication/schema errors and caller cancellation remain fatal even
      // if the observation's own deadline expires at the same time.
      if (
        error instanceof VmHostPresenceProtocolError ||
        error instanceof TargetHttpProtocolError
      )
        throw error;
      options.signal?.throwIfAborted();
      if (
        error instanceof VmHostPresenceDeadlineError ||
        observationDeadline.aborted
      ) {
        this.#lambdaReleaseAgreementSince.delete(JSON.stringify(location));
        throw new VmHostPresenceDeadlineError(
          'Host presence observation deadline expired',
          { cause: error },
        );
      }
      throw error;
    } finally {
      controller.abort();
    }
  }

  /** Original attempt coordinates and credentials also bind reservation reads. */
  async observeReservations(
    originalAttempts: readonly VmHostLocation[],
    options: VmReservationObservationOptions = {},
  ): Promise<VmReservationPresenceObservation> {
    if (this.#profile.provider !== CloudType.AWS)
      invalid('provider cannot observe reserved VM identities');
    const attempts = originalAttempts.map((attempt) => ({ ...attempt }));
    if (
      attempts.length === 0 ||
      new Set(attempts.map(reservationKey)).size !== attempts.length ||
      attempts.some(
        (attempt) =>
          typeof attempt.cloudId !== 'string' ||
          !/^[a-zA-Z][a-zA-Z0-9._-]*-[0-9]+$/u.test(attempt.cloudId) ||
          (attempt.region !== null && typeof attempt.region !== 'string') ||
          (attempt.availabilityZone !== null &&
            typeof attempt.availabilityZone !== 'string'),
      )
    )
      invalid('attempt identities are missing, duplicate, or malformed');
    for (const attempt of attempts) {
      if (
        attempt.cloudId.length > 64 ||
        AWS_ID.test(attempt.cloudId) ||
        !/^[a-z]{2}(?:-[a-z]+)+-[0-9]+$/u.test(
          required(attempt.region, 'AWS reservation region is missing'),
        )
      )
        invalid('AWS reservation token or original region is malformed');
      awsZone(attempt.region!, attempt.availabilityZone);
    }
    const requestedDeadline =
      options.deadlineAt ?? Date.now() + MAX_OBSERVATION_MS;
    if (
      !Number.isSafeInteger(requestedDeadline) ||
      requestedDeadline <= Date.now()
    )
      invalid('observation deadline is invalid');
    const deadlineAt = Math.min(
      requestedDeadline,
      Date.now() + MAX_OBSERVATION_MS,
    );
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(Math.max(1, deadlineAt - Date.now())),
      ...(options.signal ? [options.signal] : []),
    ]);
    try {
      return await this.#observeAwsReservations(
        attempts,
        options,
        deadlineAt,
        signal,
      );
    } catch (error) {
      for (const attempt of attempts)
        this.#reservationAbsenceSince.delete(reservationKey(attempt));
      throw error;
    } finally {
      controller.abort();
    }
  }

  #stableReservations(
    observation: VmReservationPresenceObservation,
  ): VmReservationPresenceObservation {
    return {
      ...observation,
      attempts: observation.attempts.map((attempt) => {
        const key = reservationKey({ ...attempt, cloudId: attempt.attemptId });
        let presence: VmHostPresence = 'unknown';
        if (
          !observation.inventory?.complete ||
          attempt.instanceIds.length > 0
        ) {
          this.#reservationAbsenceSince.delete(key);
          if (attempt.instanceIds.length > 0) presence = 'present';
        } else {
          const since =
            this.#reservationAbsenceSince.get(key) ?? observation.observedAt;
          this.#reservationAbsenceSince.set(key, since);
          if (
            observation.observedAt - since >=
            RESERVATION_ABSENCE_STABILITY_MS
          )
            presence = 'absent';
        }
        return { ...attempt, presence };
      }),
    };
  }

  async #observeAwsReservations(
    attempts: readonly VmHostLocation[],
    options: VmReservationObservationOptions,
    deadlineAt: number,
    signal: AbortSignal,
  ): Promise<VmReservationPresenceObservation> {
    const inventories = new Map<string, AwsReservationInventory>();
    const observation = (
      complete: boolean,
    ): VmReservationPresenceObservation => ({
      kind: 'exact-attempt-current-presence',
      observedAt: Date.now(),
      provider: this.#profile.provider,
      credentialName: this.#profile.credentialName,
      diagnostic: complete
        ? 'Complete AWS inventories checked exact client tokens in original regions'
        : 'AWS reservation inventory incomplete; validated matches retained',
      inventory:
        inventories.size === 0
          ? null
          : {
              pages: [...inventories.values()].reduce(
                (total, inventory) => total + inventory.pages,
                0,
              ),
              instances: [...inventories.values()].reduce(
                (total, inventory) => total + inventory.instanceIds.length,
                0,
              ),
              complete,
            },
      attempts: attempts.map((attempt) => {
        const instanceIds = [
          ...(inventories.get(reservationKey(attempt))?.instanceIds ?? []),
        ];
        return {
          attemptId: attempt.cloudId,
          region: attempt.region,
          availabilityZone: attempt.availabilityZone,
          presence: instanceIds.length > 0 ? 'present' : 'unknown',
          instanceIds,
        };
      }),
    });
    for (const attempt of attempts) {
      const inventory = await this.#awsReservationInventory(
        attempt,
        deadlineAt,
        signal,
        (page) => {
          inventories.set(reservationKey(attempt), page);
          options.onPartialObservation?.(observation(false));
        },
      );
      remainingMs(deadlineAt, signal);
      if (!inventory) return this.#stableReservations(observation(false));
      inventories.set(reservationKey(attempt), inventory);
    }
    return this.#stableReservations(observation(true));
  }

  async #awsReservationInventory(
    attempt: VmHostLocation,
    deadlineAt: number,
    signal: AbortSignal,
    retainPage: (inventory: AwsReservationInventory) => void,
  ): Promise<AwsReservationInventory | null> {
    const region = required(
      attempt.region,
      'AWS reservation region is missing',
    );
    const expectedZone = awsZone(region, attempt.availabilityZone);
    const instanceIds = new Set<string>();
    const tokens = new Set<string>();
    let nextToken: string | undefined;
    for (let page = 1; page <= AWS_RESERVATION_MAX_PAGES; page++) {
      // ClientToken is immutable; requiring the mutable Name tag could hide a host.
      const result = await this.#describeAws(
        [
          '--filters',
          JSON.stringify([{ Name: 'client-token', Values: [attempt.cloudId] }]),
          '--no-paginate',
          '--max-results',
          '100',
          ...(nextToken ? ['--next-token', nextToken] : []),
        ],
        region,
        'aws-observe-vm-reservation-presence',
        deadlineAt,
        signal,
      );
      if (result.timedOut || result.aborted) return null;
      assertComplete(result, 'AWS reservation');
      if (result.exitCode !== 0) {
        nativeFailure(result, CloudType.AWS, () => false);
        return null;
      }
      const body = successBody(parsedBody(result, 'AWS'), 'AWS');
      if (
        Object.keys(body).some(
          (key) => !['Reservations', 'NextToken'].includes(key),
        ) ||
        !Array.isArray(body.Reservations) ||
        (body.NextToken !== undefined &&
          body.NextToken !== null &&
          (typeof body.NextToken !== 'string' || !body.NextToken.trim()))
      )
        invalid('AWS reservation inventory has an incomplete envelope');
      const pageIds: string[] = [];
      for (const reservation of body.Reservations) {
        if (!isRecord(reservation) || !Array.isArray(reservation.Instances))
          invalid('AWS reservation omitted its instances');
        for (const instance of reservation.Instances) {
          if (
            !isRecord(instance) ||
            typeof instance.InstanceId !== 'string' ||
            !AWS_ID.test(instance.InstanceId) ||
            instance.ClientToken !== attempt.cloudId ||
            !isRecord(instance.State) ||
            typeof instance.State.Name !== 'string' ||
            !AWS_STATES.has(instance.State.Name) ||
            !isRecord(instance.Placement) ||
            typeof instance.Placement.AvailabilityZone !== 'string' ||
            awsZone(region, instance.Placement.AvailabilityZone) !==
              instance.Placement.AvailabilityZone ||
            (expectedZone !== undefined &&
              instance.Placement.AvailabilityZone !== expectedZone) ||
            instanceIds.has(instance.InstanceId) ||
            pageIds.includes(instance.InstanceId)
          )
            invalid(
              'AWS reservation inventory has a foreign, duplicate, or malformed instance',
            );
          pageIds.push(instance.InstanceId);
        }
      }
      if (typeof body.NextToken === 'string' && tokens.has(body.NextToken))
        invalid('AWS reservation inventory repeats a pagination cursor');
      for (const id of pageIds) instanceIds.add(id);
      // Keep all validated IDs, including terminated instances. The owner must
      // reconcile each against its original native ledger before releasing it.
      retainPage({ pages: page, instanceIds: [...instanceIds] });
      if (body.NextToken === undefined || body.NextToken === null)
        return { pages: page, instanceIds: [...instanceIds] };
      nextToken = body.NextToken;
      tokens.add(nextToken);
    }
    invalid('AWS reservation inventory exceeded the page bound');
  }

  #validateLocation(location: VmHostLocation): void {
    if (
      typeof location.cloudId !== 'string' ||
      (location.region !== null && typeof location.region !== 'string') ||
      (location.availabilityZone !== null &&
        typeof location.availabilityZone !== 'string')
    )
      invalid('original native identity or placement is incomplete');
    switch (this.#profile.provider) {
      case CloudType.AWS:
        assertId(location.cloudId, AWS_ID, 'AWS');
        if (
          !/^[a-z]{2}(?:-[a-z]+)+-[0-9]+$/u.test(
            required(location.region, 'AWS region is missing'),
          )
        )
          invalid('AWS region is malformed');
        awsZone(
          required(location.region, 'AWS region is missing'),
          location.availabilityZone,
        );
        break;
      case CloudType.Azure:
        if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u.test(location.cloudId))
          invalid('Azure native VM name is malformed');
        if (
          !/^[A-Za-z0-9]+(?:[ -][A-Za-z0-9]+)*$/u.test(
            required(location.region, 'Azure region is missing'),
          )
        )
          invalid('Azure region is malformed');
        break;
      case CloudType.GCP:
        if (!/^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(location.cloudId))
          invalid('GCP native VM name is malformed');
        if (
          !/^[a-z]+(?:-[a-z]+)+[0-9]+$/u.test(
            required(location.region, 'GCP region is missing'),
          )
        )
          invalid('GCP region is malformed');
        if (
          !/^[a-z]$/u.test(
            required(
              location.availabilityZone,
              'GCP availability zone is missing',
            ),
          )
        )
          invalid('GCP availability zone is malformed');
        break;
      case CloudType.Lambda:
        assertId(location.cloudId, LAMBDA_ID, 'Lambda');
        required(location.region, 'Lambda region is missing');
        break;
    }
  }

  async #presence(
    location: VmHostLocation,
    deadlineAt: number,
    signal: AbortSignal,
  ): Promise<PresenceResult> {
    switch (this.#profile.provider) {
      case CloudType.AWS:
        return this.#observeAws(location, deadlineAt, signal);
      case CloudType.Azure:
        return this.#observeAzure(location, deadlineAt, signal);
      case CloudType.GCP:
        return this.#observeGcp(location, deadlineAt, signal);
      case CloudType.Lambda:
        return this.#observeLambda(location, deadlineAt, signal);
    }
  }

  async #authenticate(
    deadlineAt: number,
    signal: AbortSignal,
  ): Promise<Environment> {
    const credential = this.#profile.credential;
    const configDirectory = await awaitWithSignal(
      this.#files.directory(this.#sessionPath, { private: true }),
      signal,
    );
    remainingMs(deadlineAt, signal);
    if (credential.cloudProvider === CloudType.Azure) {
      const environment = {
        ...isolatedEnvironment(/^(AZURE_|ARM_|MSI_|IDENTITY_)/u),
        AZURE_CONFIG_DIR: configDirectory,
        AZURE_CORE_COLLECT_TELEMETRY: 'false',
        AZURE_CORE_ONLY_SHOW_ERRORS: 'true',
        AZURE_EXTENSION_USE_DYNAMIC_INSTALL: 'no',
      };
      await this.#runOrThrow(
        'az',
        [
          'login',
          '--service-principal',
          '--username',
          credential.applicationId,
          '--password',
          credential.secret,
          '--tenant',
          credential.directoryId,
          '--only-show-errors',
          '--output',
          'none',
        ],
        'azure-host-presence-login',
        environment,
        deadlineAt,
        signal,
      );
      await this.#runOrThrow(
        'az',
        ['account', 'set', '--subscription', credential.subscriptionId],
        'azure-host-presence-subscription',
        environment,
        deadlineAt,
        signal,
      );
      return environment;
    }
    if (credential.cloudProvider === CloudType.GCP) {
      const keyPath = await awaitWithSignal(
        this.#files.privateText(
          `${this.#sessionPath}/key.json`,
          JSON.stringify({
            type: 'service_account',
            project_id: credential.projectId,
            private_key: credential.privateKey,
            client_email: credential.clientEmail,
            auth_uri: 'https://accounts.google.com/o/oauth2/auth',
            token_uri: 'https://oauth2.googleapis.com/token',
          }),
        ),
        signal,
      );
      const environment = {
        ...isolatedEnvironment(/^(CLOUDSDK_|GOOGLE_|GCP_)/u),
        CLOUDSDK_CONFIG: configDirectory,
        CLOUDSDK_PYTHON: process.env.CLOUDSDK_PYTHON,
        CLOUDSDK_PYTHON_SITEPACKAGES: process.env.CLOUDSDK_PYTHON_SITEPACKAGES,
        CLOUDSDK_AUTH_ACCESS_TOKEN: undefined,
        CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: '',
        CLOUDSDK_AUTH_ACCESS_TOKEN_FILE: '',
        CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT: '',
        CLOUDSDK_AUTH_LOGIN_CONFIG_FILE: '',
        CLOUDSDK_AUTH_DISABLE_CREDENTIALS: 'false',
        CLOUDSDK_CORE_CHECK_GCE_METADATA: 'false',
        CLOUDSDK_CORE_UNIVERSE_DOMAIN: 'googleapis.com',
        CLOUDSDK_CORE_DISABLE_PROMPTS: '1',
        CLOUDSDK_CORE_DISABLE_FILE_LOGGING: 'true',
        CLOUDSDK_CORE_DISABLE_USAGE_REPORTING: 'true',
        CLOUDSDK_CORE_LOG_HTTP: 'false',
      };
      await this.#runOrThrow(
        'gcloud',
        [
          'auth',
          'activate-service-account',
          credential.clientEmail,
          `--key-file=${keyPath}`,
          `--project=${credential.projectId}`,
          '--quiet',
          '--verbosity=error',
        ],
        'gcp-host-presence-auth',
        environment,
        deadlineAt,
        signal,
      );
      return environment;
    }
    invalid('provider does not support a CLI authentication session');
  }

  async #run(
    executable: string,
    args: readonly string[],
    options: CommandOptions & { readonly signal: AbortSignal },
  ): Promise<CommandResult> {
    const startedAt = Date.now();
    let result: CommandResult;
    try {
      result = await awaitWithSignal(
        this.#commands.run(executable, args, options),
        options.signal,
      );
    } catch (error) {
      // Process exceptions can quote login arguments or provider payloads, so
      // only the error class and Node's error code leave this boundary.
      const code = (error as { code?: unknown } | null)?.code;
      invalid(
        `${executable} did not return a complete native process receipt (elapsed=${Date.now() - startedAt}ms, aborted=${options.signal.aborted}, error=${error instanceof Error ? error.name : typeof error}${typeof code === 'string' ? `/${code.slice(0, 40)}` : ''})`,
      );
    }
    if (
      result.executable !== executable ||
      JSON.stringify(result.args) !== JSON.stringify(args)
    )
      invalid(
        'process receipt differs from the exact requested native operation',
      );
    return result;
  }

  async #runOrThrow(
    executable: string,
    args: readonly string[],
    label: string,
    env: Environment,
    deadlineAt: number,
    signal: AbortSignal,
  ): Promise<void> {
    const result = await this.#run(executable, args, {
      env,
      label,
      timeoutMs: remainingMs(deadlineAt, signal),
      signal,
      recordArtifact: false,
    });
    if (result.exitCode !== 0 || result.timedOut || result.aborted)
      invalid(`${label} authentication did not complete successfully`);
    assertComplete(result, label);
    remainingMs(deadlineAt, signal);
  }

  async #describeAws(
    selectors: readonly string[],
    region: string,
    label: string,
    deadlineAt: number,
    signal: AbortSignal,
    operation = 'describe-instances',
  ): Promise<CommandResult> {
    const credential = this.#profile.credential;
    if (credential.cloudProvider !== CloudType.AWS || 'kind' in credential)
      invalid('AWS credential mismatch');
    return this.#run(
      'aws',
      [
        'ec2',
        operation,
        ...selectors,
        '--region',
        region,
        '--output',
        'json',
        '--no-cli-pager',
        '--endpoint-url',
        `https://ec2.${region}.${region.startsWith('cn-') ? 'amazonaws.com.cn' : 'amazonaws.com'}`,
      ],
      {
        env: {
          ...isolatedEnvironment(/^AWS_/u),
          AWS_ACCESS_KEY_ID: credential.accessKeyId,
          AWS_SECRET_ACCESS_KEY: credential.secretAccessKey,
          AWS_SESSION_TOKEN: credential.sessionToken,
          AWS_CONFIG_FILE: '/dev/null',
          AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
          AWS_EC2_METADATA_DISABLED: 'true',
          AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true',
          AWS_CLI_AUTO_PROMPT: 'off',
          AWS_PAGER: '',
        },
        label,
        timeoutMs: remainingMs(deadlineAt, signal),
        signal,
        recordArtifact: false,
      },
    );
  }

  async #observeAws(
    location: VmHostLocation,
    deadlineAt: number,
    signal: AbortSignal,
  ): Promise<PresenceResult> {
    const result = await this.#describeAws(
      ['--instance-ids', location.cloudId],
      required(location.region, 'AWS region is missing'),
      'aws-observe-vm-host-presence',
      deadlineAt,
      signal,
    );
    if (result.timedOut || result.aborted)
      return {
        diagnostic: 'AWS request did not complete',
        presence: 'unknown',
      };
    assertComplete(result, 'AWS');
    if (result.exitCode !== 0)
      return nativeFailure(result, CloudType.AWS, (stderr) => {
        const missing =
          /^An error occurred \(InvalidInstanceID\.NotFound\) when calling the DescribeInstances operation: The instance ID '(i-[a-f0-9]+)' does not exist$/u.exec(
            stderr,
          );
        return missing?.[1] === location.cloudId;
      });
    const states = awsInstanceStates(
      parsedBody(result, 'AWS'),
      location.cloudId,
      location,
    );
    return {
      diagnostic: states.join(',') || 'empty exact-instance inventory',
      presence: interpretAwsHostPresence(states),
    };
  }

  async #observeAzure(
    location: VmHostLocation,
    deadlineAt: number,
    signal: AbortSignal,
  ): Promise<PresenceResult> {
    const credential = this.#profile.credential;
    if (credential.cloudProvider !== CloudType.Azure)
      invalid('Azure credential mismatch');
    const env = await this.#session.environment(
      () => this.#authenticate(deadlineAt, signal),
      signal,
    );
    const region = required(location.region, 'Azure region is missing');
    const group = azureGroup(region);
    const id = `/subscriptions/${credential.subscriptionId}/resourceGroups/${group}/providers/Microsoft.Compute/virtualMachines/${location.cloudId}`;
    const result = await this.#run(
      'az',
      [
        'vm',
        'show',
        '--subscription',
        credential.subscriptionId,
        '--resource-group',
        group,
        '--name',
        location.cloudId,
        '--output',
        'json',
        '--only-show-errors',
      ],
      {
        env,
        label: 'azure-observe-vm-host-presence',
        timeoutMs: remainingMs(deadlineAt, signal),
        signal,
        recordArtifact: false,
      },
    );
    if (result.timedOut || result.aborted)
      return {
        diagnostic: 'Azure request did not complete',
        presence: 'unknown',
      };
    assertComplete(result, 'Azure');
    if (result.exitCode !== 0)
      return nativeFailure(result, CloudType.Azure, (stderr) =>
        azureMissing(
          stderr,
          group,
          `The Resource 'Microsoft.Compute/virtualMachines/${location.cloudId}' under resource group '${group}' was not found.`,
        ),
      );
    const body = successBody(parsedBody(result, 'Azure'), 'Azure');
    if (
      typeof body.id !== 'string' ||
      body.id.toLowerCase() !== id.toLowerCase() ||
      body.name !== location.cloudId ||
      typeof body.resourceGroup !== 'string' ||
      body.resourceGroup.toLowerCase() !== group ||
      typeof body.location !== 'string' ||
      body.location.toLowerCase().replaceAll(' ', '') !==
        region.toLowerCase().replaceAll(' ', '') ||
      typeof body.provisioningState !== 'string' ||
      !AZURE_STATES.has(body.provisioningState)
    )
      invalid(
        'Azure response differs from its original identity, placement or state',
      );
    if (
      location.availabilityZone !== null &&
      (!Array.isArray(body.zones) ||
        body.zones.length !== 1 ||
        body.zones[0] !== location.availabilityZone)
    )
      invalid('Azure response differs from its original zone');
    return { diagnostic: body.provisioningState, presence: 'present' };
  }

  async #observeGcp(
    location: VmHostLocation,
    deadlineAt: number,
    signal: AbortSignal,
  ): Promise<PresenceResult> {
    const credential = this.#profile.credential;
    if (credential.cloudProvider !== CloudType.GCP)
      invalid('GCP credential mismatch');
    const env = await this.#session.environment(
      () => this.#authenticate(deadlineAt, signal),
      signal,
    );
    const zone = `${required(location.region, 'GCP region is missing')}-${required(location.availabilityZone, 'GCP availability zone is missing')}`;
    const resource = `projects/${credential.projectId}/zones/${zone}/instances/${location.cloudId}`;
    const result = await this.#run(
      'gcloud',
      [
        'compute',
        'instances',
        'describe',
        location.cloudId,
        `--account=${credential.clientEmail}`,
        `--project=${credential.projectId}`,
        `--zone=${zone}`,
        '--format=json',
        '--quiet',
        '--verbosity=error',
      ],
      {
        env,
        label: 'gcp-observe-vm-host-presence',
        timeoutMs: remainingMs(deadlineAt, signal),
        signal,
        recordArtifact: false,
      },
    );
    if (result.timedOut || result.aborted)
      return {
        diagnostic: 'GCP request did not complete',
        presence: 'unknown',
      };
    assertComplete(result, 'GCP');
    if (result.exitCode !== 0)
      return nativeFailure(
        result,
        CloudType.GCP,
        (stderr) =>
          stderr ===
          `ERROR: (gcloud.compute.instances.describe) Could not fetch resource:\n - The resource '${resource}' was not found`,
      );
    const body = successBody(parsedBody(result, 'GCP'), 'GCP');
    if (
      body.name !== location.cloudId ||
      !GCP_API_ROOTS.some((root) => body.selfLink === `${root}${resource}`) ||
      !GCP_API_ROOTS.some(
        (root) =>
          body.zone === `${root}projects/${credential.projectId}/zones/${zone}`,
      ) ||
      typeof body.status !== 'string' ||
      !GCP_STATES.has(body.status)
    )
      invalid(
        'GCP response differs from its original identity, placement or state',
      );
    return { diagnostic: body.status, presence: 'present' };
  }

  async #observeLambda(
    location: VmHostLocation,
    deadlineAt: number,
    signal: AbortSignal,
  ): Promise<PresenceResult> {
    const credential = this.#profile.credential;
    if (credential.cloudProvider !== CloudType.Lambda)
      invalid('Lambda credential mismatch');
    const key = JSON.stringify(location);
    try {
      const options = {
        headers: { Authorization: `Bearer ${credential.apiKey}` },
        redirect: 'error' as const,
        deadlineAt,
        signal,
      };
      const point = await this.#http.get(
        'lambda-vm-host-presence',
        new URL(`https://cloud.lambda.ai/api/v1/instances/${location.cloudId}`),
        { ...options, timeoutMs: remainingMs(deadlineAt, signal) },
      );
      remainingMs(deadlineAt, signal);
      const pointPresence = interpretLambdaPointHostPresence(
        point,
        location.cloudId,
        location.region ?? undefined,
      );
      if (pointPresence === 'present') {
        this.#lambdaReleaseAgreementSince.delete(key);
        return { diagnostic: 'exact instance present', presence: 'present' };
      }
      const list = await this.#http.get(
        'lambda-vm-host-list',
        new URL('https://cloud.lambda.ai/api/v1/instances'),
        { ...options, timeoutMs: remainingMs(deadlineAt, signal) },
      );
      remainingMs(deadlineAt, signal);
      const combined = combineLambdaHostPresence(
        pointPresence,
        interpretLambdaListHostPresence(
          list,
          location.cloudId,
          location.region ?? undefined,
        ),
      );
      return {
        diagnostic: `point=${pointPresence}, list agreement=${combined}`,
        presence: this.#stableLambdaHostPresence(key, combined),
      };
    } catch (error) {
      this.#lambdaReleaseAgreementSince.delete(key);
      if (error instanceof VmHostPresenceProtocolError) throw error;
      if (error instanceof TargetHttpProtocolError)
        invalid('Lambda native HTTP read rejected a redirect');
      signal.throwIfAborted();
      return { diagnostic: 'Lambda request failed', presence: 'unknown' };
    }
  }

  /** Read after the VM is absent; the product deletes the disk with or after it. */
  async #bootDisk(
    location: VmHostLocation,
    owner: string,
    deadlineAt: number,
    signal: AbortSignal,
  ): Promise<PresenceResult | undefined> {
    const credential = this.#profile.credential;
    const provider = credential.cloudProvider;
    const region = location.region!;
    const group = azureGroup(region);
    const zone = `${region}-${location.availabilityZone}`;
    const gcpDisk = `projects/${credential.cloudProvider === CloudType.GCP ? credential.projectId : ''}/zones/${zone}/disks/${location.cloudId}`;
    let result: CommandResult;
    if (credential.cloudProvider === CloudType.AWS)
      // Root volumes carry the Workload's launch tags, not the instance ID.
      result = await this.#describeAws(
        [
          '--filters',
          JSON.stringify([
            { Name: 'tag:anycloud_deployment', Values: [owner] },
          ]),
        ],
        region,
        'aws-observe-boot-disk-presence',
        deadlineAt,
        signal,
        'describe-volumes',
      );
    else if (
      credential.cloudProvider === CloudType.Azure ||
      credential.cloudProvider === CloudType.GCP
    )
      result = await this.#run(
        credential.cloudProvider === CloudType.Azure ? 'az' : 'gcloud',
        credential.cloudProvider === CloudType.Azure
          ? [
              'disk',
              'list',
              '--subscription',
              credential.subscriptionId,
              '--resource-group',
              group,
              '--output',
              'json',
              '--only-show-errors',
            ]
          : // The product leaves the boot disk unnamed, so GCP names it after
            // the VM. A list answers absence with `[]`; describe's not-found
            // stderr also matches the auth pattern.
            [
              'compute',
              'disks',
              'list',
              `--account=${credential.clientEmail}`,
              `--project=${credential.projectId}`,
              `--zones=${zone}`,
              `--filter=name=${location.cloudId}`,
              '--format=json',
              '--quiet',
              '--verbosity=error',
            ],
        {
          env: await this.#session.environment(
            () => this.#authenticate(deadlineAt, signal),
            signal,
          ),
          label: `${provider.toLowerCase()}-observe-boot-disk-presence`,
          timeoutMs: remainingMs(deadlineAt, signal),
          signal,
          recordArtifact: false,
        },
      );
    else return undefined;
    if (result.timedOut || result.aborted)
      return {
        diagnostic: `${provider} request did not complete`,
        presence: 'unknown',
      };
    assertComplete(result, provider);
    if (result.exitCode !== 0)
      return nativeFailure(
        result,
        provider,
        (stderr) => provider === CloudType.Azure && azureMissing(stderr, group),
      );
    const body = parsedBody(result, provider);
    let disks: unknown[];
    if (provider === CloudType.AWS) {
      const envelope = successBody(body, provider);
      if (
        Object.keys(envelope).some((key) => key !== 'Volumes') ||
        !Array.isArray(envelope.Volumes) ||
        !envelope.Volumes.every(
          (volume: unknown) =>
            isRecord(volume) &&
            typeof volume.VolumeId === 'string' &&
            Array.isArray(volume.Tags) &&
            volume.Tags.some(
              (tag: unknown) =>
                isRecord(tag) &&
                tag.Key === 'anycloud_deployment' &&
                tag.Value === owner,
            ),
        )
      )
        invalid('AWS volume inventory is incomplete or foreign');
      disks = envelope.Volumes.map(
        (volume: { VolumeId: string }) => volume.VolumeId,
      );
    } else if (provider === CloudType.Azure) {
      const prefix = `/subscriptions/${credential.cloudProvider === CloudType.Azure ? credential.subscriptionId : ''}/resourceGroups/${group}/providers/Microsoft.Compute/disks/`;
      if (
        !Array.isArray(body) ||
        !body.every(
          (disk: unknown) =>
            isRecord(disk) &&
            typeof disk.name === 'string' &&
            typeof disk.id === 'string' &&
            disk.id.toLowerCase() === `${prefix}${disk.name}`.toLowerCase(),
        )
      )
        invalid('Azure disk inventory is malformed or foreign');
      // Azure names an OS disk `<vm>_OsDisk_1_<hex>`; VM names never contain `_`.
      disks = body
        .map((disk: { name: string }) => disk.name)
        .filter(
          (name: string) =>
            name.split('_')[0].toLowerCase() === location.cloudId.toLowerCase(),
        );
    } else {
      if (
        !Array.isArray(body) ||
        !body.every(
          (disk: unknown) =>
            isRecord(disk) &&
            disk.name === location.cloudId &&
            GCP_API_ROOTS.some((root) => disk.selfLink === `${root}${gcpDisk}`),
        )
      )
        invalid(
          'GCP disk list differs from its original identity or placement',
        );
      disks = body.map((disk: { name: string }) => disk.name);
    }
    return disks.length === 0
      ? { diagnostic: 'boot disk absent', presence: 'absent' }
      : { diagnostic: `boot disk ${disks.join(', ')}`, presence: 'present' };
  }

  #stableLambdaHostPresence(
    key: string,
    presence: VmHostPresence,
  ): VmHostPresence {
    if (presence !== 'absent') {
      this.#lambdaReleaseAgreementSince.delete(key);
      return presence;
    }
    const now = Date.now();
    const since = this.#lambdaReleaseAgreementSince.get(key);
    if (since === undefined) {
      this.#lambdaReleaseAgreementSince.set(key, now);
      return 'unknown';
    }
    return now - since >= LAMBDA_RELEASE_STABILITY_MS ? 'absent' : 'unknown';
  }
}

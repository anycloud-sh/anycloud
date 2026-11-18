/**
 * Lambda Labs cloud provider (compute only — no storage).
 *
 * API docs: https://docs-api.lambda.ai/api/cloud
 * Base URL: https://cloud.lambda.ai/api/v1
 * Auth: HTTP Basic (API key as username, empty password)
 *
 * Key constraints:
 * - Launch endpoint rate limit: 1 req / 12s (5/min)
 * - ssh_key_names is required at launch — we register a placeholder key
 *   and rely on cloud-init (user_data) for real SSH auth, same as Azure
 * - No spot instances
 * - user_data supports cloud-init
 */

import { createHash, generateKeyPairSync } from 'crypto';
import type { ResolvedCloudConfig } from '../../../shared/cloud-config.js';
import {
  CloudCompute,
  CandidateRegionAvailability,
  createCandidateRegionFilter,
  createCloudCompute,
  createVMReleaseConfirmer,
  pAllSettledLimit,
  VM_PRESENT,
  VM_RELEASE_CANDIDATE,
  VMReleaseState,
  vmReleaseUnknown,
  type VMReleaseObservation,
  type VMReleaseObservationOptions,
} from './cloud.js';
import {
  CloudType,
  CloudFailureDiagnosis,
  LambdaCreds,
} from '../../../shared/cloud.js';
import {
  type CloudResourceSweeper,
  createCloudResourceSweeper,
  isOlderThan,
  isResourceSweepCandidate,
  type ResourceSweepOptions,
  type ResourceSweepResult,
} from './resource-sweeper.js';
import {
  type CloudResourceScope,
  type ResourceVM,
  type GatewayVM,
  type IngressSpec,
  type NewVMProps,
  type ProvisioningAttemptIdentity,
} from '../entities.js';
import { log } from '../logger.js';
import { retryUntil, sleep, withRetry } from '../../../shared/utils.js';
import {
  DeployError,
  ResourceStateIndeterminateError,
} from '../../../shared/errors.js';
import { SSH_PORT, hasNonSshIngress, uniqueIngressRules } from '../network.js';
import { CandidatePreflightCache } from '../candidate-preflight-cache.js';
import { VMCreationError } from '../codes.js';
import { getApiIdentity } from '../api-identity.js';
import { errorMessage } from '../../../shared/log-diagnostics.js';
import {
  LAMBDA_429_RETRY_BASE_MS,
  LAMBDA_429_RETRY_CAP_MS,
  LAMBDA_429_RETRY_MAX_ATTEMPTS,
  PROVISIONING_TIMEOUT_MS,
} from '../../config.js';
import { lambdaApiBase } from '../cloud-endpoints.js';
import { lambdaOsImageFamily } from '../../../shared/catalog/lambda.js';

const LAMBDA_API_TIMEOUT_MS = 30_000;
const LAMBDA_429_RETRY_FLOOR_FRACTION = 0.5;

/** The HTTP status, rather than Lambda's response body, owns retryability. */
class LambdaHttp429Error extends Error {
  readonly statusCode = 429;

  constructor(
    message: string,
    readonly providerCode: string,
  ) {
    super(message);
    this.name = 'LambdaHttp429Error';
  }
}

/** `explicit-rejection-only` retries completed 429 responses, but turns a
 * transport failure or 5xx into an outcome-unknown error for reconciliation. */
type LambdaApiRetrySafety = 'idempotent' | 'explicit-rejection-only';

interface LambdaApiRequestOptions {
  retrySafety: LambdaApiRetrySafety;
  body?: unknown;
  /** Absolute wall-clock boundary for this request and all of its 429 retries. */
  deadlineAt?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Return the whole success body instead of unwrapping its `data`. */
  envelope?: boolean;
}

/** Internal control flow for an idempotent request that consumed its absolute
 * retry deadline. It is deliberately distinct from provider failures so a
 * reconciliation poll can retain the last concrete Lambda diagnostic. */
class LambdaApiDeadlineExceededError extends Error {
  constructor(method: string, path: string) {
    super(`Lambda API ${method} ${path} exceeded its retry deadline`);
    this.name = 'LambdaApiDeadlineExceededError';
  }
}

/** A non-idempotent request was dispatched, but no response established
 * whether Lambda applied it. Callers must observe provider state rather than
 * issue the mutation again. */
class LambdaMutationOutcomeUnknownError extends Error {
  constructor(method: string, path: string, originalError: unknown) {
    super(
      `Lambda API ${method} ${path} outcome is unknown: ${errorMessage(originalError)}`,
    );
    this.name = 'LambdaMutationOutcomeUnknownError';
  }
}

/**
 * Lambda instance IDs are 128-bit hexadecimal identifiers. The API currently
 * returns the compact 32-character form, while older responses and persisted
 * workloads may use the hyphenated UUID form. Accept both so only Anycloud's
 * internal attempted VM names are filtered as placeholders during cleanup.
 */
const LAMBDA_INSTANCE_ID_RE =
  /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

interface LambdaInstance {
  id: string;
  name: string | null;
  ip: string | null;
  private_ip: string | null;
  status:
    | 'booting'
    | 'active'
    | 'unhealthy'
    | 'terminated'
    | 'terminating'
    | 'preempted';
  region: { name: string; description: string };
  instance_type: { name: string };
  ssh_key_names: string[];
  tags?: LambdaTag[];
}

interface LambdaTag {
  key: string;
  value: string;
}

interface LambdaError {
  code: string;
  message: string;
  suggestion?: string;
}

interface LambdaFirewallRule {
  protocol: 'tcp';
  port_range: [number, number];
  source_network: string;
  description: string;
}

interface LambdaFirewallRuleset {
  id: string;
  name: string;
  region: { name: string; description?: string };
  rules: LambdaFirewallRule[];
  created?: string;
  instance_ids?: string[];
}

interface LambdaInstanceTypeEntry {
  instance_type: {
    name?: string;
    price_cents_per_hour?: number;
    description?: string;
  };
  regions_with_capacity_available?: { name: string }[];
}
// this.api<T>() already unwraps {data: T}, so T here is the unwrapped record
// itself, matching how LambdaInstance[] etc. are used elsewhere. This IS the
// candidate-filter preflight type — no separate wrapper needed; the raw
// response is used directly, keyed by vmType, in filterPreflight below.
type LambdaInstanceTypesData = Record<string, LambdaInstanceTypeEntry>;

const FIREWALL_RULESET_DELETE_MAX_ATTEMPTS = 10;
const FIREWALL_RULESET_DELETE_WAIT_MS = 5_000;

/** Lambda's terminating → terminated transition is not instant, and both
 *  of its instance views must stop reporting a live VM (see
 *  observeVMReleaseOnce).
 *  The shared
 *  createCloudCompute default of 4 attempts / 2s would give up ~7s after the
 *  terminate request and report a normally-transitioning instance as
 *  unconfirmed.
 *
 *  Lambda's terminate endpoint returns on acknowledgement and hands back no
 *  operation to poll, so unlike Azure (ARM poller) and GCP (zone delete), this
 *  gateway is the only one that does not itself wait for the instance to be
 *  gone. Whatever this budget does not cover falls to the cleanup lane, where
 *  every deferral is billed to the user as live GPU time — so the budget is
 *  sized against the transition, matching GCP's 30 x 10s delete wait. Ten-second
 *  polling rather than five: granularity is irrelevant at this ceiling, and it
 *  halves the steady-state read volume. */
const LAMBDA_RELEASE_CONFIRM_MAX_ATTEMPTS = 30;
const LAMBDA_RELEASE_CONFIRM_WAIT_MS = 10_000;

/** Lambda's account list can briefly report an instance gone and then show it
 *  live again on a later replica. Require two fresh, complete observations one
 *  poll interval apart before releasing the durable row. */
const LAMBDA_RELEASE_CONFIRMATION_POLICY = Object.freeze({
  requiredReleaseObservations: 2,
  minObservationIntervalMs: 10_000,
});

/** The stale-instance sweep polls stale ids with bounded concurrency and keeps
 *  the original short budget deliberately: a launch must
 *  not wait out a teardown-sized transition to start.
 *
 *  It is not the only pre-launch path that terminates, though — createCloudCompute
 *  applies LAMBDA_RELEASE_CONFIRM_* to every terminateVMs caller, and teardownVMs
 *  reaches it from vm-host-startup.ts's Initializing-failure handler and retry-recovery.ts's
 *  pre-recovery teardown. Those keep the long budget on purpose: they end the VM
 *  rows they confirm, and an unconfirmed row survives to the next teardown because
 *  a non-terminal workload never enters the cleanup lane. */
const LAMBDA_SWEEP_CONFIRM_MAX_ATTEMPTS = 6;
const LAMBDA_SWEEP_CONFIRM_WAIT_MS = 5_000;

/** Bound teardown fan-out so one workload cannot create an unbounded burst
 *  of point/list observations. Lambda API throttles remain reactive: the API
 *  helper handles 429 responses within each caller's deadline rather than
 *  imposing proactive account-wide pacing. */
export const LAMBDA_TERMINATE_CONCURRENCY = 4;

/** Placeholder SSH key name registered with Lambda to satisfy the required ssh_key_names field.
 *  Real SSH auth is handled via cloud-init in user_data (same pattern as Azure). */
const PLACEHOLDER_SSH_KEY_NAME = 'anycloud-api';

/** Name prefix to identify anycloud-managed instances. */
const NAME_PREFIX = 'ac';
const NAME_SEPARATOR = '|';
const WORKLOAD_NAME_PREFIX = 'd=';
const LAMBDA_TAG_WORKLOAD_ID = 'anycloud:deployment-id';
const LAMBDA_TAG_USER_ID = 'anycloud:user-id';
const LAMBDA_TAG_OWNER_API = 'anycloud:owner-api';
const LAMBDA_TAG_RESOURCE = 'anycloud:resource';
const LAMBDA_TAG_ATTEMPT = 'anycloud:attempt';

/** Encode userId and creation timestamp into the instance name.
 *  Format: ac|{userId}|{timestamp}|{random}
 *  Random suffix prevents collisions when two launches for the same userId
 *  land in the same second (Lambda uses second-precision timestamps). */
function encodeName(userId: string): string {
  const random = Math.random().toString(36).slice(2, 8);
  return [NAME_PREFIX, userId, Math.floor(Date.now() / 1000), random].join(
    NAME_SEPARATOR,
  );
}

/** Parse an anycloud-encoded instance name. Returns null if not ours. */
function parseName(
  name: string | null,
): { userId: string; createdAt: number; workloadId?: string } | null {
  if (!name) return null;
  const parts = name.split(NAME_SEPARATOR);
  if (parts.length < 3 || parts[0] !== NAME_PREFIX) return null;
  const workloadMarker = parts.at(-1);
  const workloadId = workloadMarker?.startsWith(WORKLOAD_NAME_PREFIX)
    ? workloadMarker.slice(WORKLOAD_NAME_PREFIX.length)
    : undefined;
  const endIdx = workloadId ? parts.length - 1 : parts.length;
  // Old format (ac|user|ts) has 3 parts; current format has 4. A brief
  // pre-tag format may have appended a workload marker. Use part count
  // rather than digit-sniffing — the random suffix is base36 and can
  // legitimately be all digits.
  const tsIdx = endIdx >= 4 ? endIdx - 2 : endIdx - 1;
  const createdAt = Number(parts[tsIdx]);
  if (isNaN(createdAt)) return null;
  const userId = parts.slice(1, tsIdx).join(NAME_SEPARATOR);
  return { userId, createdAt, ...(workloadId && { workloadId }) };
}

function isGoneInstanceStatus(status: LambdaInstance['status']): boolean {
  return status === 'terminated';
}

function lambdaInstanceTags(workloadId: string, userId: string): LambdaTag[] {
  return [
    { key: LAMBDA_TAG_WORKLOAD_ID, value: workloadId },
    { key: LAMBDA_TAG_USER_ID, value: userId },
    { key: LAMBDA_TAG_OWNER_API, value: getApiIdentity() },
  ];
}

/** Lambda tag keys allow only lowercase letters, digits, `-` and `:`, so a
 *  scope tag such as `anycloud_user` is stamped as `anycloud:user`. */
function lambdaResourceInstanceTags(
  scope: CloudResourceScope,
  vmId: string,
): LambdaTag[] {
  return Object.entries({
    ...Object.fromEntries(
      Object.entries(scope.tags).map(([key, value]) => [
        key.toLowerCase().replace(/_/g, ':'),
        value,
      ]),
    ),
    [LAMBDA_TAG_RESOURCE]: scope.id,
    [LAMBDA_TAG_ATTEMPT]: vmId,
    [LAMBDA_TAG_OWNER_API]: getApiIdentity(),
  }).map(([key, value]) => ({ key, value }));
}

/**
 * The tag that marks one provisioning attempt's instances, for adoption and
 * the duplicate sweep. A workload's attempts share its workload tag, but a
 * resource scope's tag is shared by sibling VMs, so its attempts match on the
 * attempt tag instead.
 */
function launchOwnerTag(attempt: {
  workloadId: string;
  vmId: string;
  resourceScope?: CloudResourceScope;
}): LambdaTag {
  return attempt.resourceScope
    ? { key: LAMBDA_TAG_ATTEMPT, value: attempt.vmId }
    : { key: LAMBDA_TAG_WORKLOAD_ID, value: attempt.workloadId };
}

function hasLambdaTag(
  instance: LambdaInstance,
  key: string,
  value: string,
): boolean {
  return (
    Array.isArray(instance.tags) &&
    instance.tags.some((tag) => tag.key === key && tag.value === value)
  );
}

function firewallRulesetName(workloadId: string): string {
  // Workload IDs are validated to max 28 lowercase chars/hyphens, so this is
  // well under Lambda's 64-character firewall-ruleset name cap.
  return `anycloud-${workloadId}`;
}

function isIPv4SourceRange(sourceRange: string): boolean {
  const [address] = sourceRange.split('/');
  if (!address) return false;
  const octets = address.split('.');
  return (
    octets.length === 4 &&
    octets.every((part) => {
      if (!/^\d{1,3}$/.test(part)) return false;
      const value = Number(part);
      return value >= 0 && value <= 255;
    })
  );
}

function toLambdaFirewallRules(spec: IngressSpec): LambdaFirewallRule[] {
  const rules: LambdaFirewallRule[] = [];
  for (const rule of uniqueIngressRules(spec)) {
    const ipv4Sources = rule.sourceRanges.filter(isIPv4SourceRange);
    if (ipv4Sources.length === 0) {
      throw new DeployError(
        `Lambda firewall rules for TCP port ${rule.port} require at least one IPv4 source range`,
        400,
      );
    }
    for (const source of ipv4Sources) {
      rules.push({
        protocol: rule.protocol,
        port_range: [rule.port, rule.port],
        source_network: source,
        description: rule.description ?? `TCP ${rule.port}`,
      });
    }
  }
  return rules;
}

function sameFirewallRules(
  a: LambdaFirewallRule[],
  b: LambdaFirewallRule[],
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isFirewallRulesetInUse(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes('firewall-rulesets/firewall-ruleset-in-use')
  );
}

function hashLambdaApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex');
}

const LAMBDA_LAUNCH_PATH = '/instance-operations/launch';

function lambda429RetryWaitMs(attempt: number): number {
  const maximum = Math.min(
    LAMBDA_429_RETRY_BASE_MS * 2 ** (attempt - 1),
    LAMBDA_429_RETRY_CAP_MS,
  );
  return (
    maximum *
    (LAMBDA_429_RETRY_FLOOR_FRACTION +
      Math.random() * (1 - LAMBDA_429_RETRY_FLOOR_FRACTION))
  );
}

// This is not request pacing. It bounds the eventual-consistency poll that
// checks whether an ambiguous launch response actually created an instance.
const LAMBDA_LAUNCH_SETTLE_WINDOW_MS = 12_000;

// GET /instance-types returns one account-wide inventory, independent of the
// candidate shape asking for it. This is Lambda's only availability cache:
// assessments are projected from the raw snapshot on every caller.
const lambdaInstanceTypesCache =
  new CandidatePreflightCache<LambdaInstanceTypesData>();

/** Launch-retry settle-poll cadence (see pollForAdoptableInstance): poll every
 *  1.5s across one launch slot so the final check lands at the launch boundary.
 *  ATTEMPTS is a safety cap that only bites under a mocked/instant clock; the
 *  real terminator is the one-launch-interval deadline. */
const RECONCILE_POLL_INTERVAL_MS = 1_500;
const RECONCILE_POLL_ATTEMPTS =
  Math.ceil(LAMBDA_LAUNCH_SETTLE_WINDOW_MS / RECONCILE_POLL_INTERVAL_MS) + 1;

/** Test-only: clear the process-wide Lambda inventory snapshot cache. */
export function resetLambdaCandidatePreflightCache(): void {
  lambdaInstanceTypesCache.clear();
}

export class Lambda {
  readonly type = CloudType.Lambda;
  readonly region: string;
  readonly vmType: string;
  readonly spot = false; // Lambda does not support spot instances

  private apiKey: string;
  private computeProvider?: CloudCompute;
  private sweeperProvider?: CloudResourceSweeper;
  private placeholderKeyRegistered = false;
  constructor(config: ResolvedCloudConfig) {
    const creds = config.credentials as LambdaCreds;
    this.apiKey = creds.apiKey;
    this.region = config.region ?? '';
    // vmType is collapsed to a scalar by completeCloudConfig before construction.
    this.vmType = Array.isArray(config.vmType)
      ? (config.vmType[0] ?? '')
      : (config.vmType ?? '');
  }

  compute(): CloudCompute {
    this.computeProvider ??= createCloudCompute({
      type: this.type,
      region: this.region,
      spot: this.spot,
      vmType: this.vmType,
      rawValidateCredentials: () => this.validateCredentials(),
      rawClassifyError: (error) => this.classifyError(error),
      rawAdoptProvisioningAttempt: (attempt) =>
        this.adoptProvisioningAttempt(attempt),
      rawNewVM: (params) => this.newVM(params),
      rawRequestVMTermination: (vmId) => this.terminateVM(vmId),
      rawTerminateNetworking: (workloadId) =>
        this.terminateNetworking(workloadId),
      rawGetAllVMs: () => this.getAllVMs(),
      rawUpsertFirewall: (ipWhiteList, workloadId, version, userId) =>
        this.upsertFirewall(ipWhiteList, workloadId, version, userId),
      rawPrepareNetwork: (spec, workloadId, version, userId) =>
        this.prepareNetwork(spec, workloadId, version, userId),
      observeVMReleaseOnce: (cloudId, options) =>
        this.observeVMReleaseOnce(cloudId, options),
      isPlaceholderVMId: (vmId) => !LAMBDA_INSTANCE_ID_RE.test(vmId),
      releaseConfirmMaxAttempts: LAMBDA_RELEASE_CONFIRM_MAX_ATTEMPTS,
      releaseConfirmWaitMs: LAMBDA_RELEASE_CONFIRM_WAIT_MS,
      releaseConfirmationPolicy: LAMBDA_RELEASE_CONFIRMATION_POLICY,
      terminateVMsConcurrency: LAMBDA_TERMINATE_CONCURRENCY,
      ingressSupport: {
        supportsIngress: () => true,
      },
      candidateRegionFilter: this.createCandidateRegionFilter(),
      terminalAuthErrorClassifier: {
        isTerminalAuthError: (error) => this.isTerminalAuthError(error),
      },
    });
    return this.computeProvider;
  }

  sweeper(): CloudResourceSweeper {
    this.sweeperProvider ??= createCloudResourceSweeper({
      type: this.type,
      region: this.region,
      rawSweepResources: (options) => this.sweepResources(options),
    });
    return this.sweeperProvider;
  }

  private async api<T>(
    method: string,
    path: string,
    options: LambdaApiRequestOptions,
  ): Promise<T> {
    const startedAt = Date.now();
    const {
      retrySafety,
      body,
      deadlineAt = startedAt + PROVISIONING_TIMEOUT_MS,
      timeoutMs = LAMBDA_API_TIMEOUT_MS,
      signal: callerSignal,
      envelope,
    } = options;
    const retryBudgetMs = Math.max(0, deadlineAt - startedAt);
    let retryCount = 0;
    let lastRateLimit: LambdaHttp429Error | undefined;
    const failRateLimit = (
      error: LambdaHttp429Error,
      attempts: number,
      deadlineExhausted: boolean,
    ): never => {
      log.warn('Lambda HTTP 429 retry budget exhausted', {
        method,
        path,
        attempts,
        providerCode: error.providerCode,
        ...(deadlineExhausted && {
          elapsedBudgetMs: retryBudgetMs,
        }),
      });
      throw error;
    };

    for (let attempt = 1; attempt <= LAMBDA_429_RETRY_MAX_ATTEMPTS; attempt++) {
      callerSignal?.throwIfAborted();
      if (Date.now() >= deadlineAt) {
        if (lastRateLimit) {
          failRateLimit(lastRateLimit, attempt - 1, true);
        }
        throw new LambdaApiDeadlineExceededError(method, path);
      }

      try {
        const result = await this.apiAttempt<T>(method, path, {
          retrySafety,
          body,
          deadlineAt,
          timeoutMs,
          signal: callerSignal,
          envelope,
        });
        if (retryCount > 0) {
          log.info('Lambda request recovered after HTTP 429', {
            method,
            path,
            retryCount,
            providerCode: lastRateLimit?.providerCode ?? 'unknown',
          });
        }
        return result;
      } catch (error) {
        // Only a typed deadline may fall back to the last completed provider
        // rejection. An in-flight non-idempotent failure is outcome-unknown
        // and passes through unchanged, even when an earlier attempt was 429.
        if (error instanceof LambdaApiDeadlineExceededError) {
          if (lastRateLimit) failRateLimit(lastRateLimit, attempt, true);
          throw error;
        }
        if (!(error instanceof LambdaHttp429Error)) throw error;

        lastRateLimit = error;
        if (attempt === LAMBDA_429_RETRY_MAX_ATTEMPTS) {
          failRateLimit(error, attempt, false);
        }

        const waitMs = lambda429RetryWaitMs(attempt);
        const remainingMs = deadlineAt - Date.now();
        if (waitMs >= remainingMs) {
          if (remainingMs > 0) await sleep(remainingMs, callerSignal);
          failRateLimit(error, attempt, true);
        }

        retryCount = attempt;
        log.debug('Retrying Lambda request after HTTP 429', {
          method,
          path,
          attempt,
          maxAttempts: LAMBDA_429_RETRY_MAX_ATTEMPTS,
          providerCode: error.providerCode,
        });
        await sleep(waitMs, callerSignal);
      }
    }

    throw lastRateLimit ?? new LambdaApiDeadlineExceededError(method, path);
  }

  /** Execute exactly one HTTP attempt. This layer owns the important outcome
   * distinction: a completed response is authoritative, while cancellation of
   * a dispatched non-idempotent mutation is always ambiguous. */
  private async apiAttempt<T>(
    method: string,
    path: string,
    options: LambdaApiRequestOptions & {
      deadlineAt: number;
      timeoutMs: number;
    },
  ): Promise<T> {
    const {
      retrySafety,
      body,
      deadlineAt,
      timeoutMs,
      signal: callerSignal,
      envelope,
    } = options;
    callerSignal?.throwIfAborted();

    const remainingMs = Math.floor(deadlineAt - Date.now());
    if (remainingMs < 1) {
      throw new LambdaApiDeadlineExceededError(method, path);
    }
    const deadlineLimited = remainingMs <= timeoutMs;
    const attemptTimeoutMs = Math.max(1, Math.min(timeoutMs, remainingMs));
    const attemptController = new AbortController();
    const timeoutError = deadlineLimited
      ? new LambdaApiDeadlineExceededError(method, path)
      : new DOMException(
          `Lambda API ${method} ${path} request timed out`,
          'TimeoutError',
        );
    const attemptTimeout = setTimeout(
      () => attemptController.abort(timeoutError),
      attemptTimeoutMs,
    );
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, attemptController.signal])
      : attemptController.signal;
    const requestFailure = (error: unknown): unknown => {
      // Once a non-idempotent request is dispatched, any interruption is an
      // unknown provider outcome. Never turn it back into a prior 429.
      if (retrySafety === 'explicit-rejection-only') {
        return new LambdaMutationOutcomeUnknownError(method, path, error);
      }
      if (callerSignal?.aborted) return callerSignal.reason;
      if (attemptController.signal.aborted && deadlineLimited) {
        return timeoutError;
      }
      return error;
    };

    try {
      const url = `${lambdaApiBase()}${path}`;
      const opts: RequestInit = {
        method,
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.apiKey}:`).toString('base64')}`,
          'Content-Type': 'application/json',
        },
        signal,
      };
      if (body) opts.body = JSON.stringify(body);
      let res: Response;
      try {
        res = await fetch(url, opts);
      } catch (error) {
        throw requestFailure(error);
      }

      // Read the status before trusting the body. Lambda's edge can answer
      // with a non-JSON payload on 429, so parsing first would lose the one
      // fact that owns retryability.
      let json: { data: T } | { error: LambdaError } | undefined;
      try {
        json = (await res.json()) as { data: T } | { error: LambdaError };
      } catch (error) {
        if (res.ok) throw requestFailure(error);
        json = undefined;
      }

      if (!res.ok || (json && 'error' in json)) {
        const err =
          json && 'error' in json
            ? json.error
            : { code: `HTTP ${res.status}`, message: 'Unknown error' };
        const message = `Lambda API ${method} ${path}: [${err.code}] ${err.message}${err.suggestion ? ` (${err.suggestion})` : ''}`;
        if (res.status === 429) {
          throw new LambdaHttp429Error(message, err.code);
        }
        const responseError = Object.assign(new Error(message), {
          statusCode: res.status,
        });
        if (retrySafety === 'explicit-rejection-only' && res.status >= 500) {
          throw new LambdaMutationOutcomeUnknownError(
            method,
            path,
            responseError,
          );
        }
        throw responseError;
      }

      // A parsed response wins a timeout race. It definitively establishes the
      // provider outcome, so the retry layer must not inspect the signal again.
      return envelope ? (json as T) : (json as { data: T }).data;
    } finally {
      clearTimeout(attemptTimeout);
    }
  }

  private async validateCredentials(): Promise<void> {
    await this.api<unknown>('GET', '/ssh-keys', {
      retrySafety: 'idempotent',
    });
  }

  /**
   * Register a placeholder SSH key with Lambda if not already present.
   * Lambda requires ssh_key_names at launch — we register a throwaway key
   * and rely on cloud-init (user_data) for real SSH auth, same as Azure.
   */
  private async ensurePlaceholderSSHKey(): Promise<void> {
    if (this.placeholderKeyRegistered) return;

    const keys = await this.api<Array<{ id: string; name: string }>>(
      'GET',
      '/ssh-keys',
      { retrySafety: 'idempotent' },
    );
    if (keys.some((k) => k.name === PLACEHOLDER_SSH_KEY_NAME)) {
      this.placeholderKeyRegistered = true;
      return;
    }

    // Generate a throwaway RSA key pair (same pattern as Azure's generateSSHKeyPair)
    const { publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    // Posted as the SPKI PEM verbatim — Lambda accepts it, so no OpenSSH
    // conversion is needed. The private half is discarded: this key only
    // satisfies the required ssh_key_names field, and real SSH auth arrives
    // through user_data.
    try {
      await this.api<unknown>('POST', '/ssh-keys', {
        retrySafety: 'explicit-rejection-only',
        body: {
          name: PLACEHOLDER_SSH_KEY_NAME,
          public_key: publicKey,
        },
      });
      log.info('Registered placeholder SSH key with Lambda');
    } catch (error: any) {
      // Racing caller already created the key — Lambda returns duplicate /
      // "already exists" style errors. Treat as success.
      const msg = error?.message ?? '';
      if (!/already exists|duplicate/i.test(msg)) throw error;
    }

    this.placeholderKeyRegistered = true;
  }

  private async connectToProvisioningInstance(
    instanceId: string,
    owner: LambdaTag,
  ): Promise<GatewayVM> {
    // Poll until instance has a public IP (booting → active)
    let lastStatus: string | null = null;
    let lastHasIp = false;
    let instance;
    try {
      await this.sweepOwnedInstances(owner, instanceId);

      instance = await retryUntil(
        async () => {
          const inst = await this.api<LambdaInstance>(
            'GET',
            `/instances/${instanceId}`,
            { retrySafety: 'idempotent' },
          );
          lastStatus = inst.status;
          lastHasIp = !!inst.ip;

          // Fail fast on any state from which we cannot recover. `unhealthy`
          // and `preempted` both indicate the instance won't reach active
          // without external action — waiting the full 5-minute budget only
          // burns money.
          if (
            inst.status === 'terminated' ||
            inst.status === 'terminating' ||
            inst.status === 'unhealthy' ||
            inst.status === 'preempted'
          ) {
            throw new Error(
              `Lambda instance ${instanceId} entered ${inst.status} during boot`,
            );
          }

          return inst;
        },
        (inst) => !!inst.ip,
        `Lambda instance IP for ${instanceId}`,
        { maxAttempts: 60, waitMs: 5_000 }, // 5 minutes
      );
    } catch (error: any) {
      // Boot wait or post-launch duplicate sweep failed — the instance is
      // still billable. Preserve its real ID for confirmed cleanup.
      await this.terminateVM(instanceId).catch((termError) => {
        log.warn('Failed to terminate orphan Lambda instance on boot failure', {
          instanceId,
          termError: termError?.message ?? String(termError),
        });
      });

      const bootError = error.message?.includes('failed after')
        ? new Error(
            `Lambda instance ${instanceId} did not get IP: status=${lastStatus ?? 'unknown'}, hasIp=${lastHasIp}`,
          )
        : error instanceof Error
          ? error
          : new Error(String(error));
      throw new VMCreationError(bootError, [instanceId]);
    }

    log.info('Lambda instance IP assigned', {
      instanceId,
      ip: instance.ip,
      status: instance.status,
      owner: owner.value,
    });

    const parsedName = parseName(instance.name);
    return {
      cloudId: instanceId,
      ip: instance.ip!,
      privateIp: instance.private_ip ?? undefined,
      ...(parsedName && { createdAt: parsedName.createdAt * 1000 }),
    };
  }

  private async adoptProvisioningAttempt(
    attempt: ProvisioningAttemptIdentity,
  ): Promise<GatewayVM | null> {
    const owner = launchOwnerTag(attempt);
    const existing = await this.pollForAdoptableInstance(owner);
    if (!existing) return null;
    log.info('Adopting existing Lambda provisioning attempt', {
      workloadId: attempt.workloadId,
      instanceId: existing.id,
      status: existing.status,
      vmId: attempt.vmId,
    });
    return this.connectToProvisioningInstance(existing.id, owner);
  }

  private async newVM(params: NewVMProps): Promise<GatewayVM> {
    const { startupScript, workloadId, vmId, userId, network, resourceScope } =
      params;
    const owner = launchOwnerTag(params);

    await this.ensurePlaceholderSSHKey();

    const firewallRulesets = network?.firewallRulesetIds?.map((id) => ({
      id,
    }));

    let result: { instance_ids: string[] } | undefined;
    if (params.adoptExistingAttempt) {
      const adopt = await this.pollForAdoptableInstance(owner);
      if (adopt) {
        log.info('Adopting existing Lambda provisioning attempt', {
          workloadId,
          instanceId: adopt.id,
          status: adopt.status,
          vmId,
        });
        result = { instance_ids: [adopt.id] };
      }
    }

    if (!result) await this.sweepOwnedInstances(owner);

    if (!result) {
      try {
        // Lambda has no launch idempotency key. api() retries only explicit
        // 429 rejections; a transport failure, 5xx, or interrupted response is
        // outcome-unknown and must be reconciled instead of re-posted.
        result = await this.api<{ instance_ids: string[] }>(
          'POST',
          LAMBDA_LAUNCH_PATH,
          {
            retrySafety: 'explicit-rejection-only',
            body: {
              region_name: this.region,
              instance_type_name: this.vmType,
              image: { family: lambdaOsImageFamily(this.vmType) },
              ssh_key_names: [PLACEHOLDER_SSH_KEY_NAME],
              name: encodeName(userId),
              tags: resourceScope
                ? lambdaResourceInstanceTags(resourceScope, vmId)
                : lambdaInstanceTags(workloadId, userId),
              user_data: startupScript,
              ...(firewallRulesets?.length
                ? { firewall_rulesets: firewallRulesets }
                : {}),
            },
          },
        );
      } catch (error) {
        if (!(error instanceof LambdaMutationOutcomeUnknownError)) throw error;

        const adopt = await this.pollForAdoptableInstance(owner);
        if (!adopt) {
          throw new ResourceStateIndeterminateError(
            `Could not determine Lambda provisioning attempt ${vmId} after an uncertain launch`,
            error,
          );
        }
        log.info('Adopting Lambda instance after an uncertain launch', {
          workloadId,
          instanceId: adopt.id,
          status: adopt.status,
          vmId,
        });
        result = { instance_ids: [adopt.id] };
      }
    }

    if (!result) {
      throw new Error('Lambda launch did not return a result');
    }
    const instanceId = result.instance_ids[0];
    if (!instanceId) {
      throw new Error('Lambda launch returned no instance IDs');
    }

    log.info('Lambda instance launched', {
      instanceId,
      vmId,
      id: workloadId,
      region: this.region,
      vmType: this.vmType,
    });

    return this.connectToProvisioningInstance(instanceId, owner);
  }

  private async terminateVM(vmId: string): Promise<void> {
    log.info('Terminating Lambda instances', {
      vmCount: 1,
    });

    try {
      const result = await this.api<{ terminated_instances: LambdaInstance[] }>(
        'POST',
        '/instance-operations/terminate',
        {
          retrySafety: 'idempotent',
          body: { instance_ids: [vmId] },
        },
      );
      if (!result.terminated_instances.some((inst) => inst.id === vmId)) {
        throw new Error(
          `Lambda terminate request for ${vmId} returned ok but did not report it as terminated`,
        );
      }
    } catch (error: any) {
      // Instance already terminated — same outcome as a successful delete.
      if (error.message?.includes('object-does-not-exist')) {
        log.debug('Lambda instances already terminated', {
          vmIds: [vmId],
        });
        return;
      }
      log.warn('Lambda terminateVM failed', {
        vmIds: [vmId],
        error: error,
      });
      throw error;
    }
  }

  /** Pick an instance safe to adopt for THIS attempt's target: recoverable
   *  (active/booting) and matching region + type, preferring one already active
   *  over one still booting. Never relies on API list ordering. Adopting a
   *  mismatched or unhealthy/preempted instance would let the keep-one sweep
   *  kill the healthy launch, or record the VM under the wrong
   *  region/type/price. */
  private selectAdoptableInstance(
    instances: LambdaInstance[],
  ): LambdaInstance | null {
    const adoptable = instances.filter(
      (inst) =>
        (inst.status === 'active' || inst.status === 'booting') &&
        inst.region.name === this.region &&
        inst.instance_type.name === this.vmType,
    );
    return (
      adoptable.find((inst) => inst.status === 'active') ?? adoptable[0] ?? null
    );
  }

  /** Settle-poll used on a launch retry: give a prior attempt's instance time
   *  to become listable (Lambda's list is eventually consistent) and adopt it
   *  rather than launch a duplicate. Returns the instance to adopt, or null if
   *  at least one authoritative read found none within the poll budget (the
   *  durable recovery can later decide whether to launch). Individual
   *  transient list errors are retried; a window with no successful read is
   *  indeterminate. An immediate caller recovering an uncertain mutation must
   *  also treat a successful empty poll as indeterminate: eventual consistency
   *  means it is not permission to re-send the create. */
  private async pollForAdoptableInstance(
    owner: LambdaTag,
  ): Promise<LambdaInstance | null> {
    // Bound the whole poll to one launch interval so a hanging /instances can't
    // eat the provisioning budget. The same absolute deadline bounds each
    // nested /instances 429 loop and every poll sleep; no second cancellation
    // signal is needed. Individual list errors do not abort the poll, but at
    // least one successful read is required before absence is authoritative.
    const deadlineAt = Date.now() + LAMBDA_LAUNCH_SETTLE_WINDOW_MS;
    let successfulRead = false;
    let lastListError: unknown;
    let deadlineError: LambdaApiDeadlineExceededError | undefined;
    for (let attempt = 0; attempt < RECONCILE_POLL_ATTEMPTS; attempt++) {
      if (Date.now() >= deadlineAt) break;
      try {
        const found = this.selectAdoptableInstance(
          await this.findOwnedInstances(owner, deadlineAt),
        );
        successfulRead = true;
        if (found) return found;
      } catch (listError) {
        if (listError instanceof LambdaApiDeadlineExceededError) {
          // Deadline expiry is control flow, not a provider diagnostic.
          deadlineError = listError;
          break;
        }
        lastListError = listError;
        log.warn('Lambda launch-retry reconcile poll failed', {
          owner: owner.value,
          error: listError,
        });
      }
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) break;
      await sleep(Math.min(RECONCILE_POLL_INTERVAL_MS, remainingMs));
    }

    if (!successfulRead) {
      throw new ResourceStateIndeterminateError(
        `Could not inspect Lambda provisioning attempt ${owner.value}`,
        lastListError ??
          deadlineError ??
          new LambdaApiDeadlineExceededError('GET', '/instances'),
      );
    }
    return null;
  }

  /** Every instance in the account. Lambda pages `GET /instances` (50 per
   *  page by default) and returns `page_token: null` on the last page, so a
   *  single read misses instances in larger accounts. */
  private async listInstances(
    options: Pick<
      LambdaApiRequestOptions,
      'deadlineAt' | 'timeoutMs' | 'signal'
    > = {},
  ): Promise<LambdaInstance[]> {
    const instances: LambdaInstance[] = [];
    const seenTokens = new Set<string>();
    let pageToken: string | null | undefined;
    do {
      const page = await this.api<{
        data: LambdaInstance[];
        page_token?: string | null;
      }>(
        'GET',
        pageToken
          ? `/instances?page_token=${encodeURIComponent(pageToken)}`
          : '/instances',
        { ...options, retrySafety: 'idempotent', envelope: true },
      );
      instances.push(...page.data);
      pageToken = page.page_token;
      if (pageToken && seenTokens.has(pageToken))
        throw new Error('Lambda API GET /instances repeated a page token');
      if (pageToken) seenTokens.add(pageToken);
    } while (pageToken);
    return instances;
  }

  /** Provider-visible instances currently carrying this tag. Shared by the
   *  sweep (which terminates duplicates) and launch-retry reconciliation.
   *  Keep `terminating` instances visible so a replacement cannot launch until
   *  the existing confirmation poll observes that they are actually gone. */
  private async findOwnedInstances(
    owner: LambdaTag,
    deadlineAt?: number,
  ): Promise<LambdaInstance[]> {
    const instances = await this.listInstances({ deadlineAt });
    return instances
      .filter((inst) => !isGoneInstanceStatus(inst.status))
      .filter((inst) => hasLambdaTag(inst, owner.key, owner.value));
  }

  private async sweepOwnedInstances(
    owner: LambdaTag,
    keepInstanceId?: string,
  ): Promise<void> {
    const staleInstanceIds = (await this.findOwnedInstances(owner))
      .map((inst) => inst.id)
      .filter((id) => id !== keepInstanceId);

    if (staleInstanceIds.length === 0) return;

    log.info('Sweeping existing Lambda instances for provisioning attempt', {
      owner: owner.value,
      instanceIds: staleInstanceIds,
      keepInstanceId,
    });

    try {
      const result = await this.api<{
        terminated_instances: LambdaInstance[];
      }>('POST', '/instance-operations/terminate', {
        retrySafety: 'idempotent',
        body: { instance_ids: staleInstanceIds },
      });
      const reported = new Set(
        result.terminated_instances.map((inst) => inst.id),
      );
      const unreported = staleInstanceIds.filter((id) => !reported.has(id));
      if (unreported.length > 0) {
        log.warn(
          'Lambda sweep terminate returned ok without reporting every instance',
          {
            owner: owner.value,
            instanceIds: unreported,
          },
        );
      }
    } catch (error: any) {
      if (!error.message?.includes('object-does-not-exist')) {
        log.warn('Lambda workload instance sweep failed', {
          owner: owner.value,
          instanceIds: staleInstanceIds,
          error: error,
        });
        throw error;
      }
    }

    const releaseConfirmers = new Map(
      staleInstanceIds.map((id) => [
        id,
        createVMReleaseConfirmer(LAMBDA_RELEASE_CONFIRMATION_POLICY),
      ]),
    );
    await retryUntil(
      async () => {
        // Bounded, not Promise.all: an unbounded fan-out over N stale instances
        // creates a burst of API reads and delays unrelated work on the same
        // credential. Same cap the shared teardown path uses for the identical
        // check.
        const settled = await pAllSettledLimit(
          staleInstanceIds,
          LAMBDA_TERMINATE_CONCURRENCY,
          (id) =>
            releaseConfirmers
              .get(id)!
              .observe(() => this.observeVMReleaseOnce(id)),
        );
        // A poll that failed is unknown, never gone: keep waiting rather than
        // let a transient read error read as confirmation.
        return settled.every(
          (result) =>
            result.status === 'fulfilled' &&
            result.value.state === VMReleaseState.Released,
        );
      },
      (allTerminated) => allTerminated,
      `Lambda instance sweep for ${owner.value}`,
      {
        maxAttempts: LAMBDA_SWEEP_CONFIRM_MAX_ATTEMPTS,
        waitMs: LAMBDA_SWEEP_CONFIRM_WAIT_MS,
      },
    );
  }

  private async terminateNetworking(workloadId: string): Promise<void> {
    const name = firewallRulesetName(workloadId);
    const rulesets = await this.listFirewallRulesets();
    // Regional failover can create workload-scoped rulesets in multiple
    // regions before final teardown runs.
    const matching = rulesets.filter((ruleset) => ruleset.name === name);
    for (const ruleset of matching) {
      const deleted = await this.deleteFirewallRuleset(ruleset, {
        workloadId,
        retryInUse: true,
      });
      if (!deleted) {
        throw new Error(
          `Lambda firewall ruleset ${ruleset.id} (${ruleset.name}) was not deleted`,
        );
      }
    }
  }

  private async getAllVMs(): Promise<GatewayVM[]> {
    const instances = await this.listInstances();
    return instances
      .filter((i) => !isGoneInstanceStatus(i.status))
      .map((i) => ({
        cloudId: i.id,
        ip: i.ip ?? '',
        privateIp: i.private_ip ?? undefined,
      }));
  }

  private async upsertFirewall(
    ipWhiteList: string[],
    _workloadId: string,
    _version: string,
    _userId: string,
  ): Promise<void> {
    // Lambda default policy: only ICMP and SSH (port 22) inbound.
    // Firewall rulesets can only be attached at launch time and are
    // region-scoped, so a post-launch whitelist cannot be applied. Warn
    // loudly instead of silently dropping the caller's intent.
    if (ipWhiteList.length > 0) {
      log.warn(
        'Lambda: ipWhitelist is ignored — Lambda firewall rulesets can only be attached at launch time',
        { ipCount: ipWhiteList.length },
      );
      return;
    }
    log.debug('Lambda: using default firewall policy (SSH + ICMP only)');
  }

  private async prepareNetwork(
    spec: IngressSpec,
    workloadId: string,
    version: string,
    userId: string,
  ): Promise<{ firewallRulesetIds: string[] } | undefined> {
    if (!hasNonSshIngress(spec)) {
      const sshSourceRanges = spec.ingress
        .filter((rule) => rule.protocol === 'tcp' && rule.port === SSH_PORT)
        .flatMap((rule) => rule.sourceRanges);
      const defaultPublicSsh =
        sshSourceRanges.length === 1 && sshSourceRanges[0] === '0.0.0.0/0';
      await this.upsertFirewall(
        defaultPublicSsh ? [] : sshSourceRanges,
        workloadId,
        version,
        userId,
      );
      return undefined;
    }

    const rules = toLambdaFirewallRules(spec);
    const ruleset = await this.upsertFirewallRuleset(
      firewallRulesetName(workloadId),
      rules,
    );
    return { firewallRulesetIds: [ruleset.id] };
  }

  private async listFirewallRulesets(): Promise<LambdaFirewallRuleset[]> {
    return this.api<LambdaFirewallRuleset[]>('GET', '/firewall-rulesets', {
      retrySafety: 'idempotent',
    });
  }

  private async deleteFirewallRuleset(
    ruleset: LambdaFirewallRuleset,
    context: { workloadId?: string; retryInUse?: boolean } = {},
  ): Promise<boolean> {
    try {
      await withRetry(
        () =>
          this.api<unknown>('DELETE', `/firewall-rulesets/${ruleset.id}`, {
            retrySafety: 'idempotent',
          }),
        `Lambda firewall ruleset ${ruleset.id} delete`,
        {
          maxAttempts: context.retryInUse
            ? FIREWALL_RULESET_DELETE_MAX_ATTEMPTS
            : 1,
          waitMs: FIREWALL_RULESET_DELETE_WAIT_MS,
          maxWaitMs: FIREWALL_RULESET_DELETE_WAIT_MS,
          exponentialBackoff: false,
          jitter: false,
          shouldRetry: isFirewallRulesetInUse,
          onRetry: (attempt, maxAttempts, error) =>
            log.info(
              `Retrying Lambda firewall ruleset delete (${attempt}/${maxAttempts})`,
              {
                workloadId: context.workloadId,
                rulesetId: ruleset.id,
                error: error,
              },
            ),
        },
      );
      log.info('Lambda firewall ruleset deleted', {
        workloadId: context.workloadId,
        rulesetId: ruleset.id,
        name: ruleset.name,
      });
      return true;
    } catch (error: any) {
      if (error.message?.includes('object-does-not-exist')) return true;
      log.warn('Lambda: failed to delete firewall ruleset', {
        workloadId: context.workloadId,
        rulesetId: ruleset.id,
        error: error,
      });
      return false;
    }
  }

  private async upsertFirewallRuleset(
    name: string,
    rules: LambdaFirewallRule[],
  ): Promise<LambdaFirewallRuleset> {
    const existing = (await this.listFirewallRulesets()).find(
      (ruleset) =>
        ruleset.name === name && ruleset.region?.name === this.region,
    );
    if (existing) {
      if (!sameFirewallRules(existing.rules, rules)) {
        await this.api<LambdaFirewallRuleset>(
          'PATCH',
          `/firewall-rulesets/${existing.id}`,
          { retrySafety: 'idempotent', body: { rules } },
        );
      }
      return { ...existing, rules };
    }

    try {
      const created = await this.api<LambdaFirewallRuleset>(
        'POST',
        '/firewall-rulesets',
        {
          retrySafety: 'explicit-rejection-only',
          body: {
            name,
            region: this.region,
            rules,
          },
        },
      );
      log.info('Lambda firewall ruleset created', {
        name,
        region: this.region,
        rulesetId: created.id,
      });
      return created;
    } catch (error: any) {
      if (
        !/already exists|duplicate|conflict|\[HTTP 409\]/i.test(
          error?.message ?? '',
        )
      ) {
        throw error;
      }
      const createdByRacingRequest = (await this.listFirewallRulesets()).find(
        (ruleset) =>
          ruleset.name === name && ruleset.region?.name === this.region,
      );
      if (!createdByRacingRequest) throw error;
      return createdByRacingRequest;
    }
  }

  private async sweepResources(
    options: ResourceSweepOptions,
  ): Promise<ResourceSweepResult> {
    const dryRun = options.dryRun ?? false;
    const result: ResourceSweepResult = {
      vmIds: [],
      otherResources: [],
      errors: [],
    };

    // Use the instance name as AnyCloud's broad resource-sweep marker. Normal
    // workload cleanup uses the provider instance ID, and launch cleanup uses
    // Lambda tags to match workload ownership.
    const instances = await this.listInstances();
    const activeInstanceIds = new Set(
      instances.filter((i) => !isGoneInstanceStatus(i.status)).map((i) => i.id),
    );

    const orphaned: string[] = [];
    for (const inst of instances) {
      if (isGoneInstanceStatus(inst.status)) continue;

      const parsed = parseName(inst.name);
      if (!parsed) continue; // not ours

      const ageMs = Date.now() - parsed.createdAt * 1000;
      if (
        !isResourceSweepCandidate(
          {
            userId: parsed.userId,
            createdAt: parsed.createdAt * 1000,
          },
          options.policy,
        )
      )
        continue;

      orphaned.push(inst.id);
      log.info('Lambda orphaned instance', {
        id: inst.id,
        name: inst.name,
        userId: parsed.userId,
        ageHours: (ageMs / 3_600_000).toFixed(1),
        dryRun,
      });
    }

    if (dryRun) {
      result.vmIds = orphaned;
    } else if (orphaned.length > 0) {
      // Reuse the same request + exact-status confirmation contract as normal
      // workload teardown. Only provider-confirmed IDs are safe to report as
      // removed or to detach from dependent firewall cleanup.
      result.vmIds = await this.compute().terminateVMs(orphaned);
      const confirmed = new Set(result.vmIds);
      for (const id of orphaned) {
        if (confirmed.has(id)) continue;
        result.errors.push({
          resourceType: 'vm',
          resourceId: id,
          error: 'Lambda did not confirm instance termination',
        });
      }
    }

    const activeForRulesets = new Set(activeInstanceIds);
    for (const id of result.vmIds) activeForRulesets.delete(id);
    await this.sweepDetachedFirewallRulesets(
      result,
      activeForRulesets,
      dryRun,
      options.policy.minAgeMs,
    );
    return result;
  }

  private async sweepDetachedFirewallRulesets(
    result: ResourceSweepResult,
    activeInstanceIds: Set<string>,
    dryRun: boolean,
    minAgeMs: number,
  ): Promise<void> {
    let rulesets: LambdaFirewallRuleset[];
    try {
      rulesets = await this.listFirewallRulesets();
    } catch (error) {
      result.errors.push({
        resourceType: 'firewallRuleset',
        resourceId: 'list-firewall-rulesets',
        error: errorMessage(error),
      });
      return;
    }
    if (!Array.isArray(rulesets)) return;

    for (const ruleset of rulesets) {
      if (!ruleset.name.startsWith('anycloud-')) continue;
      const createdAt = Date.parse(ruleset.created ?? '');
      if (!isOlderThan(createdAt, minAgeMs)) continue;
      const attachedToActiveInstance = (ruleset.instance_ids ?? []).some((id) =>
        activeInstanceIds.has(id),
      );
      if (attachedToActiveInstance) continue;

      if (dryRun) {
        result.otherResources.push({
          type: 'firewallRuleset',
          id: ruleset.id,
        });
        continue;
      }

      const deleted = await this.deleteFirewallRuleset(ruleset);
      if (deleted) {
        result.otherResources.push({
          type: 'firewallRuleset',
          id: ruleset.id,
        });
      } else {
        result.errors.push({
          resourceType: 'firewallRuleset',
          resourceId: ruleset.id,
          error: 'delete failed',
        });
      }
    }
  }

  private async observeVMReleaseOnce(
    cloudId: string,
    options: VMReleaseObservationOptions = {},
  ): Promise<VMReleaseObservation> {
    const pointStatus = await this.observeVMPointReleaseOnce(cloudId, options);
    if (pointStatus.state !== VMReleaseState.Candidate) return pointStatus;

    try {
      // This must be a fresh read taken after the point lookup. Reusing an
      // earlier account-list result could miss a newly visible instance and
      // falsely claim that both Lambda views agree it has been released.
      const instances = await this.listInstances({
        timeoutMs: LAMBDA_API_TIMEOUT_MS,
        signal: options.signal,
      });
      const stillPresent = instances.some(
        (instance) =>
          instance.id === cloudId && !isGoneInstanceStatus(instance.status),
      );
      return stillPresent ? VM_PRESENT : VM_RELEASE_CANDIDATE;
    } catch (error) {
      return vmReleaseUnknown(error);
    }
  }

  private async observeVMPointReleaseOnce(
    cloudId: string,
    options: VMReleaseObservationOptions,
  ): Promise<VMReleaseObservation> {
    try {
      const instance = await this.api<LambdaInstance>(
        'GET',
        `/instances/${cloudId}`,
        {
          retrySafety: 'idempotent',
          timeoutMs: LAMBDA_API_TIMEOUT_MS,
          signal: options.signal,
        },
      );
      return instance.status === 'terminated'
        ? VM_RELEASE_CANDIDATE
        : VM_PRESENT;
    } catch (error: any) {
      if (error?.message?.includes('object-does-not-exist')) {
        return VM_RELEASE_CANDIDATE;
      }
      return vmReleaseUnknown(error);
    }
  }

  // Lambda's live endpoint is one atomic account-wide read. Positive capacity
  // is a useful ordering signal; missing capacity is volatile, so it remains
  // Unknown rather than becoming a durable Unavailable assessment.
  private createCandidateRegionFilter() {
    return createCandidateRegionFilter({
      // regions_with_capacity_available is genuine live inventory, not an
      // entitlement check, so it is safe to rank on.
      providesLiveCapacitySignal: true,
      cache: lambdaInstanceTypesCache,
      // Inventory is account-wide: candidate shape and spot mode are not cache
      // dimensions for Lambda.
      cacheKey: () => hashLambdaApiKey(this.apiKey),
      operationName: ({ workloadId }) =>
        `read Lambda instance types for ${workloadId}`,
      runPreflight: ({ signal, deadlineAt }) => {
        const timeoutMs = Math.max(
          1,
          Math.min(LAMBDA_API_TIMEOUT_MS, deadlineAt - Date.now()),
        );
        return this.api<LambdaInstanceTypesData>('GET', '/instance-types', {
          retrySafety: 'idempotent',
          timeoutMs,
          signal,
        });
      },
      assess: (instanceTypes, candidate) => {
        const regions =
          instanceTypes[candidate.vmType]?.regions_with_capacity_available;
        return Array.isArray(regions) &&
          regions.some((region) => region.name === candidate.region)
          ? CandidateRegionAvailability.Verified
          : CandidateRegionAvailability.Unknown;
      },
    });
  }

  // TerminalAuthErrorClassifier: 'invalid-api-key' means the bearer key itself is
  // unrecognized — the only Lambda auth signal that re-fails until the key is
  // re-entered (capacity/quota/config have distinct codes). Lambda's analogue of
  // Azure's invalid_client.
  isTerminalAuthError(error: unknown): boolean {
    const msg = errorMessage(error);
    return /\binvalid-api-key\b/i.test(msg);
  }

  private classifyError(error: unknown): CloudFailureDiagnosis {
    const msg = errorMessage(error);

    // Structural target mismatch — no path to success in the chosen region.
    if (/Instance type\b.*\bdoes not exist/i.test(msg))
      return CloudFailureDiagnosis.InvalidTarget;
    if (/can't host a cluster's management VM/i.test(msg))
      return CloudFailureDiagnosis.InvalidTarget;
    if (/Unknown region\b/i.test(msg))
      return CloudFailureDiagnosis.InvalidTarget;
    // Image families are resolved within the selected region. A family can be
    // present account-wide but unavailable for that region's architecture
    // (for example, us-east-3 currently exposes ARM64 Lambda Stack images while
    // cpu_4x_general is x86-64). Retrying the same target cannot repair that
    // structural mismatch; rotate an unpinned workload to another region.
    if (
      /POST \/instance-operations\/launch: \[global\/object-does-not-exist\] Image\b.*(?:doesn't exist|do not have permission)/i.test(
        msg,
      )
    )
      return CloudFailureDiagnosis.InvalidTarget;
    // Some regions (us-south-1, run 37831607151) don't support firewall
    // rulesets, which Workload VMs require. Region-structural, not a bad request — rotate to another
    // region (or terminate cleanly if the region was pinned). Carries
    // [global/invalid-parameters], so this must precede the generic check below.
    if (/Firewall rulesets are not supported in the .+ region/i.test(msg))
      return CloudFailureDiagnosis.InvalidTarget;

    // Capacity is region-rotatable; Lambda reports account instance quota with
    // a global code, so rotating regions only burns launch attempts.
    if (/\binsufficient-capacity\b/i.test(msg))
      return CloudFailureDiagnosis.CapacityExhausted;
    if (/\bquota-exceeded\b/i.test(msg))
      return CloudFailureDiagnosis.QuotaExhaustedAccount;
    // A launch Lambda accepted but never delivered — stuck in booting without
    // an IP for the whole boot budget, or dead before boot completed — is a
    // fault of that capacity pool, not a transient API hiccup. Retrying the
    // same target re-draws from that pool: in qualification run 33635355557
    // the attempt's ledger row was still unresolved ten minutes later, so the
    // workload never reached its two other VM types. Capacity lets an
    // unpinned workload rotate to its next VM type or region; pinned
    // workloads degrade to retry-in-place as with any capacity failure.
    if (
      /\bdid not get IP\b/i.test(msg) ||
      /\bentered \S+ during boot\b/i.test(msg)
    )
      return CloudFailureDiagnosis.CapacityExhausted;

    // Auth-class — BadCredential. The workload terminates as Invalid.
    if (/\binvalid-api-key\b/i.test(msg))
      return CloudFailureDiagnosis.BadCredential;
    // Caller config — terminal, never retry.
    if (msg.includes('[global/invalid-parameters]'))
      return CloudFailureDiagnosis.InvalidRequest;

    return CloudFailureDiagnosis.TemporaryProviderFailure;
  }
}

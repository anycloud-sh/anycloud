/**
 * Lambda gateway unit tests (mocked fetch).
 *
 * Covers error/edge branches that the real-API integration tests at
 * test/integration/lambda-*.spec.ts cannot reach without fault injection:
 *
 *  - classifyError() mapping table (InvalidTarget, QuotaExhaustedRegion, CapacityExhausted, UserError, Transient)
 *  - observeVMReleaseOnce() distinguishes 404 from transient errors
 *  - newVM() cleans up the orphan when IP assignment times out
 *  - boot-wait aborts on unhealthy / preempted, not only terminated/terminating
 *  - ensurePlaceholderSSHKey swallows "already exists" from concurrent callers
 *  - upsertFirewall warns when a non-empty ipWhitelist is passed
 *  - prepareNetwork creates regional firewall rulesets for Service ingress
 *  - encodeName returns distinct names for two calls in the same second
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mock,
} from 'vitest';

// Replace retryUntil / withRetry with no-sleep equivalents so the gateway
// burns through its attempt budgets without consuming real time. Mocking
// sleep alone doesn't work because retryUntil/withRetry close over the
// original sleep reference at module-load time.
vi.mock('../../../src/shared/utils', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/shared/utils')>();
  const sleepMock = vi.fn().mockResolvedValue(undefined);
  const throwIfAborted = (signal?: AbortSignal) => {
    if (!signal?.aborted) return;
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException('The operation was aborted', 'AbortError');
  };
  return {
    ...actual,
    sleep: sleepMock,
    retryUntil: async <T>(
      operation: () => Promise<T>,
      condition: (result: T) => boolean,
      name: string,
      opts: { maxAttempts?: number; waitMs?: number } = {},
    ): Promise<T> => {
      const maxAttempts = opts.maxAttempts ?? 30;
      for (let i = 0; i < maxAttempts; i++) {
        const r = await operation();
        if (condition(r)) return r;
        // Skip the wall-clock wait but still let fake time move. Reconciliation
        // polls use Date.now() for their total settle-window deadline.
        if (opts.waitMs && vi.isFakeTimers()) {
          vi.setSystemTime(Date.now() + opts.waitMs);
        }
      }
      throw new Error(`${name} failed after ${maxAttempts} attempts`);
    },
    withRetry: async <T>(
      operation: () => Promise<T>,
      _name: string,
      opts: {
        maxAttempts?: number;
        waitMs?: number;
        maxWaitMs?: number;
        exponentialBackoff?: boolean;
        jitter?: boolean;
        jitterFloorFraction?: number;
        signal?: AbortSignal;
        shouldRetry?: (error: unknown) => boolean;
        onRetry?: (
          attempt: number,
          maxAttempts: number,
          error: unknown,
        ) => void;
      } = {},
    ): Promise<T> => {
      const maxAttempts = opts.maxAttempts ?? 10;
      let lastError: unknown;
      for (let i = 0; i < maxAttempts; i++) {
        throwIfAborted(opts.signal);
        try {
          const result = await operation();
          throwIfAborted(opts.signal);
          return result;
        } catch (e) {
          lastError = e;
          throwIfAborted(opts.signal);
          if (opts.shouldRetry && !opts.shouldRetry(e)) throw e;
          if (i < maxAttempts - 1) {
            opts.onRetry?.(i + 1, maxAttempts, e);
            let wait = opts.waitMs ?? 10_000;
            if (opts.exponentialBackoff ?? true) {
              wait *= Math.pow(2, i);
            }
            wait = Math.min(wait, opts.maxWaitMs ?? Infinity);
            if (opts.jitter ?? true) {
              const floor = Math.min(
                1,
                Math.max(0, opts.jitterFloorFraction ?? 0),
              );
              wait *= floor + Math.random() * (1 - floor);
            }
            if (opts.signal) {
              await sleepMock(wait, opts.signal);
            } else {
              await sleepMock(wait);
            }
          }
        }
      }
      throw lastError;
    },
  };
});

// Silence gateway logging and capture .warn calls for assertions.
// vi.mock hoists, so use vi.hoisted to share the mock across factory + tests.
const { logMock } = vi.hoisted(() => ({
  logMock: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock('../../../src/api/services/logger', () => ({ log: logMock }));

import {
  LAMBDA_TERMINATE_CONCURRENCY,
  Lambda,
  resetLambdaCandidatePreflightCache,
} from '../../../src/api/services/gateways/lambda';
import {
  LAMBDA_429_RETRY_BASE_MS,
  LAMBDA_429_RETRY_MAX_ATTEMPTS,
  PROVISIONING_TIMEOUT_MS,
} from '../../../src/api/config';
import {
  canFilterCandidateRegions,
  VM_PRESENT,
  VM_RELEASE_CANDIDATE,
  type CandidateRegion,
  type CandidateRegionFilterOptions,
} from '../../../src/api/services/gateways/cloud';
import {
  CloudFailureDiagnosis,
  CloudType,
  type CloudConfig,
} from '../../../src/shared/cloud.js';
import { CLOUDFLARE_IPV4_RANGES } from '../../../src/shared/cloudflare-ips';
import { completeCloudConfig } from '../../../src/shared/cloud-config.js';
import { buildServeIngressSpec } from '../../../src/api/services/network';
import { sleep } from '../../../src/shared/utils';
import { VMCreationError } from '../../../src/api/services/codes';
import { ResourceStateIndeterminateError } from '../../../src/shared/errors';
import { TEST_RESOURCE_SWEEP_OPTIONS } from '../../helpers/resource-sweep-policy';
import { makeNewVMProps } from '../helpers/fixtures';

type FetchMock = Mock<typeof fetch>;

const LAMBDA_TAG_WORKLOAD_ID = 'anycloud:deployment-id';
const LAMBDA_TAG_USER_ID = 'anycloud:user-id';
const LAMBDA_TAG_OWNER_API = 'anycloud:owner-api';
const TEST_API_IDENTITY = '00000000000000000000000000000001';

const baseConfig: CloudConfig = {
  cloudProvider: CloudType.Lambda,
  credentials: { apiKey: 'test-api-key' },
  region: 'us-east-1',
  availabilityZone: undefined,
  vmType: 'gpu_1x_a100',
};

function jsonResponse(
  body: unknown,
  init: { ok?: boolean; status?: number } = {},
): Response {
  const stub = {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  };
  return stub as Response;
}

/** Lambda's edge can answer with HTML or an empty payload; its OpenAPI spec
 *  documents no 429 response at all, so this is the only shape a throttle is
 *  known to arrive in. */
function unparseableResponse(
  init: { ok?: boolean; status?: number } = {},
): Response {
  const stub = {
    ok: init.ok ?? false,
    status: init.status ?? 429,
    // Annotated rather than inferred: a bare throwing body infers
    // Promise<never>, which stops the stub overlapping Response at all and
    // makes the cast below a type error. jsonResponse above gets
    // Promise<unknown> for free because it returns a value.
    json: async (): Promise<unknown> => {
      throw new SyntaxError('Unexpected token < in JSON at position 0');
    },
  };
  return stub as Response;
}

function activeInstance(
  instanceId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: instanceId,
    name: null,
    ip: '1.2.3.4',
    private_ip: null,
    status: 'active',
    region: { name: 'us-east-1', description: '' },
    instance_type: { name: 'gpu_1x_a100' },
    ssh_key_names: [],
    ...overrides,
  };
}

function emptyInstancesResponse(): Response {
  return jsonResponse({ data: [] });
}

function lambdaTags(workloadId: string, userId = 'u-1') {
  return [
    { key: LAMBDA_TAG_WORKLOAD_ID, value: workloadId },
    { key: LAMBDA_TAG_USER_ID, value: userId },
    { key: LAMBDA_TAG_OWNER_API, value: TEST_API_IDENTITY },
  ];
}

function useTimedSleepMock(): void {
  vi.mocked(sleep).mockImplementation(
    (waitMs: number, signal?: AbortSignal): Promise<void> =>
      new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          finish();
          resolve();
        }, waitMs);
        function finish() {
          clearTimeout(timeoutId);
          signal?.removeEventListener('abort', abort);
        }
        function abort() {
          finish();
          reject(
            signal?.reason instanceof Error
              ? signal.reason
              : new DOMException('The operation was aborted', 'AbortError'),
          );
        }
        if (signal?.aborted) {
          abort();
          return;
        }
        signal?.addEventListener('abort', abort, { once: true });
      }),
  );
}

function makeLambda(overrides: Partial<CloudConfig> = {}): Lambda {
  return new Lambda(completeCloudConfig({ ...baseConfig, ...overrides }));
}

function sweepLambda(lambda = makeLambda(), dryRun = false) {
  return lambda.sweeper().sweepResources({
    ...TEST_RESOURCE_SWEEP_OPTIONS,
    dryRun,
  });
}

function filterCandidateRegions(
  lambda: Lambda,
  candidates: CandidateRegion[],
  spot: boolean,
  workloadId: string,
  options: CandidateRegionFilterOptions = {},
) {
  const compute = lambda.compute();
  if (!canFilterCandidateRegions(compute)) {
    throw new Error(
      'Lambda compute provider did not expose candidate filtering',
    );
  }
  return compute.filterCandidateRegions(candidates, spot, workloadId, options);
}

beforeEach(() => {
  logMock.info.mockClear();
  logMock.warn.mockClear();
  logMock.debug.mockClear();
  logMock.error.mockClear();
});

describe('Lambda.classifyError', () => {
  const lambda = makeLambda();

  it.each([
    [
      'invalid instance type',
      'Lambda API POST /instance-operations/launch: [global/invalid-parameters] Instance type gpu_fake does not exist',
      CloudFailureDiagnosis.InvalidTarget,
    ],
    [
      'invalid region',
      'Lambda API POST /instance-operations/launch: [global/invalid-parameters] Unknown region. (Choose a different region.)',
      CloudFailureDiagnosis.InvalidTarget,
    ],
    [
      'image family unavailable in target region',
      "Lambda API POST /instance-operations/launch: [global/object-does-not-exist] Image doesn't exist, or you do not have permission to use it. (Check the image specification and try again.)",
      CloudFailureDiagnosis.InvalidTarget,
    ],
    [
      'firewall rulesets unsupported in region',
      'Lambda API POST /firewall-rulesets: [global/invalid-parameters] Firewall rulesets are not supported in the us-south-1 region. (Choose a different region that supports firewall rulesets.)',
      CloudFailureDiagnosis.InvalidTarget,
    ],
    [
      'insufficient capacity',
      'Lambda API POST /instance-operations/launch: [instance-operations/launch/insufficient-capacity] No capacity for gpu_1x_a100 in us-east-1',
      CloudFailureDiagnosis.CapacityExhausted,
    ],
    [
      'API quota exceeded',
      'Lambda API POST /instance-operations/launch: [global/quota-exceeded] Too many instances',
      CloudFailureDiagnosis.QuotaExhaustedAccount,
    ],
    [
      'instance stuck booting without an IP',
      'Lambda instance 8f26a84293a94edca562c4a51e2d1af4 did not get IP: status=booting, hasIp=false',
      CloudFailureDiagnosis.CapacityExhausted,
    ],
    [
      'instance dead before boot completed',
      'Lambda instance 8f26a84293a94edca562c4a51e2d1af4 entered unhealthy during boot',
      CloudFailureDiagnosis.CapacityExhausted,
    ],
    [
      'invalid API key',
      'Lambda API GET /ssh-keys: [global/invalid-api-key] API key not recognised',
      CloudFailureDiagnosis.BadCredential,
    ],
    [
      'generic invalid parameters',
      'Lambda API POST /instance-operations/launch: [global/invalid-parameters] Something else went wrong',
      CloudFailureDiagnosis.InvalidRequest,
    ],
    [
      'unknown transient error',
      'Lambda API GET /instances/abc: [HTTP 502] Bad Gateway',
      CloudFailureDiagnosis.TemporaryProviderFailure,
    ],
  ])('maps "%s" to the expected kind', (_name, message, expected) => {
    expect(lambda.compute().classifyError(new Error(message))).toBe(expected);
  });
});

describe('Lambda.isTerminalAuthError', () => {
  it('flags an unrecognized API key as terminal', () => {
    expect(
      makeLambda().isTerminalAuthError(
        new Error(
          'Lambda API GET /ssh-keys: [global/invalid-api-key] API key not recognised',
        ),
      ),
    ).toBe(true);
  });

  it('does not flag non-auth-key errors', () => {
    expect(
      makeLambda().isTerminalAuthError(
        new Error('[global/quota-exceeded] Too many instances'),
      ),
    ).toBe(false);
    expect(
      makeLambda().isTerminalAuthError(new Error('[HTTP 502] Bad Gateway')),
    ).toBe(false);
  });
});

describe('Lambda fetch-backed behaviour', () => {
  let fetchMock: FetchMock;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    fetchMock = vi.fn() as unknown as FetchMock;
    global.fetch = fetchMock;
  });

  afterEach(() => {
    vi.useRealTimers();
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('non-JSON error bodies', () => {
    it('still propagates a parse failure on a successful response', async () => {
      fetchMock.mockResolvedValueOnce(
        unparseableResponse({ ok: true, status: 200 }),
      );

      await expect(
        makeLambda().compute().validateCredentials(),
      ).rejects.toThrow(/Unexpected token </);
    });

    it('retains an explicit provider status on a validation failure', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(
          { error: { code: 'HTTP 503', message: 'Service Unavailable' } },
          { ok: false, status: 503 },
        ),
      );

      const error = await makeLambda()
        .compute()
        .validateCredentials()
        .catch((caught: unknown) => caught);

      expect(error).toMatchObject({ statusCode: 503 });
    });
  });

  describe('observeVMReleaseOnce', () => {
    it('returns one release candidate when both Lambda views agree once', async () => {
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse({
            data: activeInstance('vm-1', { status: 'terminated' }),
          }),
        )
        .mockResolvedValueOnce(jsonResponse({ data: [] }));
      await expect(
        makeLambda().compute().observeVMReleaseOnce('vm-1'),
      ).resolves.toBe(VM_RELEASE_CANDIDATE);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('keeps the VM present when the point view is terminal but the account list is stale', async () => {
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse({
            data: activeInstance('vm-1', { status: 'terminated' }),
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            data: [activeInstance('vm-1', { status: 'terminating' })],
          }),
        );

      await expect(
        makeLambda().compute().observeVMReleaseOnce('vm-1'),
      ).resolves.toBe(VM_PRESENT);
    });

    it('keeps terminating instances live until Lambda confirms they are gone', async () => {
      // The terminate endpoint itself returns status=terminating. Treating
      // that accepted transition as final drops the VM from cleanup retries
      // even though Lambda still has the instance.
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          data: activeInstance('vm-1', { status: 'terminating' }),
        }),
      );
      await expect(
        makeLambda().compute().observeVMReleaseOnce('vm-1'),
      ).resolves.toMatchObject({ state: 'present' });
    });

    it('returns released when the point lookup is not found and the list agrees', async () => {
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse(
            {
              error: {
                code: 'global/object-does-not-exist',
                message: 'Instance vm-gone not found',
              },
            },
            { ok: false, status: 404 },
          ),
        )
        .mockResolvedValueOnce(jsonResponse({ data: [] }));
      await expect(
        makeLambda().compute().observeVMReleaseOnce('vm-gone'),
      ).resolves.toBe(VM_RELEASE_CANDIDATE);
    });

    it('returns unknown when the API is transiently failing (5xx)', async () => {
      // A transient 502 must NOT be interpreted as "terminated" — otherwise
      // the workload monitor marks a healthy VM dead and tears the
      // workload down.
      fetchMock.mockResolvedValueOnce(
        jsonResponse(
          { error: { code: 'HTTP 502', message: 'Bad Gateway' } },
          { ok: false, status: 502 },
        ),
      );
      await expect(
        makeLambda().compute().observeVMReleaseOnce('vm-1'),
      ).resolves.toMatchObject({ state: 'unknown' });
    });

    it('returns unknown when the point view is terminal but the account list fails', async () => {
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse({
            data: activeInstance('vm-1', { status: 'terminated' }),
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse(
            { error: { code: 'HTTP 502', message: 'Bad Gateway' } },
            { ok: false, status: 502 },
          ),
        );

      await expect(
        makeLambda().compute().observeVMReleaseOnce('vm-1'),
      ).resolves.toMatchObject({ state: 'unknown' });
    });

    it('declares the stable-release evidence policy at the interface boundary', () => {
      expect(makeLambda().compute().releaseConfirmationPolicy).toEqual({
        requiredReleaseObservations: 2,
        minObservationIntervalMs: 10_000,
      });
    });
  });

  describe('terminateVMs confirmation budget', () => {
    // Lambda's terminate returns on acknowledgement and hands back no operation
    // to poll, so this gateway — alone among ours — does not itself wait for
    // the instance to be gone. Whatever the confirm poll does not cover falls
    // to the cleanup lane and is billed as live GPU time.
    function mockTerminateThenStatuses(vmId: string, statuses: string[]) {
      let statusChecks = 0;
      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input);
        if (
          url.endsWith('/instance-operations/terminate') &&
          (init?.method ?? 'GET') === 'POST'
        ) {
          return jsonResponse({
            data: { terminated_instances: [{ id: vmId }] },
          });
        }
        if (url.includes(`/instances/${vmId}`)) {
          const status =
            statuses[Math.min(statusChecks, statuses.length - 1)] ??
            'terminated';
          statusChecks += 1;
          return jsonResponse({ data: activeInstance(vmId, { status }) });
        }
        if (url.endsWith('/instances')) {
          return jsonResponse({ data: [] });
        }
        return jsonResponse({ data: {} });
      });
      return () => statusChecks;
    }

    it('confirms an instance that stays terminating well past the old 30s budget', async () => {
      // Twelve polls is two minutes of real transition — over the previous
      // 6-attempt budget, which reported this normal transition as unconfirmed
      // and handed the workload to a five-minute retry it paid for.
      vi.useFakeTimers();
      const vmId = '11111111-1111-1111-1111-111111111111';
      const statusChecks = mockTerminateThenStatuses(vmId, [
        ...Array(12).fill('terminating'),
        'terminated',
      ]);

      await expect(
        makeLambda().compute().terminateVMs([vmId]),
      ).resolves.toEqual([vmId]);
      // The thirteenth poll first sees terminal; one fresh point read then
      // confirms that the release observation remained stable.
      expect(statusChecks()).toBe(14);
    });

    it('still gives up rather than confirming an instance that never goes away', async () => {
      // The budget buys patience, not credulity: an instance that never reaches
      // terminated must stay out of the deleted set so its row stays live.
      vi.useFakeTimers();
      const vmId = '22222222-2222-2222-2222-222222222222';
      const statusChecks = mockTerminateThenStatuses(vmId, ['terminating']);

      await expect(
        makeLambda().compute().terminateVMs([vmId]),
      ).resolves.toEqual([]);
      // Pin the reason: the whole budget was spent on a still-terminating
      // instance, not cut short by an unrelated failure that also yields [].
      expect(statusChecks()).toBe(30);
    });
  });

  describe('upsertFirewall', () => {
    it('is silent when the whitelist is empty', async () => {
      await makeLambda().compute().upsertFirewall([], 'd-1', '0.0.0', 'u-1');
      expect(logMock.warn).not.toHaveBeenCalled();
    });

    it('warns when a non-empty whitelist is passed (Lambda cannot apply it)', async () => {
      await makeLambda()
        .compute()
        .upsertFirewall(['1.2.3.4/32', '5.6.7.8/32'], 'd-1', '0.0.0', 'u-1');
      expect(logMock.warn).toHaveBeenCalledTimes(1);
      expect(logMock.warn.mock.calls[0][0]).toMatch(/ipWhitelist is ignored/);
    });
  });

  describe('prepareNetwork', () => {
    it('creates a regional firewall ruleset for Service ingress', async () => {
      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url.endsWith('/firewall-rulesets') && method === 'GET') {
          return jsonResponse({ data: [] });
        }
        if (url.endsWith('/firewall-rulesets') && method === 'POST') {
          const body = JSON.parse(String(init?.body ?? '{}'));
          return jsonResponse({
            data: {
              id: 'fw-1',
              name: body.name,
              region: { name: body.region, description: '' },
              rules: body.rules,
              created: '2026-06-24T00:00:00Z',
              instance_ids: [],
            },
          });
        }
        return jsonResponse({ data: {} });
      });

      const result = await makeLambda().compute().prepareNetwork!(
        buildServeIngressSpec(['10.0.0.0/8']),
        'serve-1',
        '0.0.0-test',
        'u-1',
      );

      expect(result).toEqual({ firewallRulesetIds: ['fw-1'] });
      const postCall = fetchMock.mock.calls.find(([input, init]) => {
        return (
          String(input).endsWith('/firewall-rulesets') &&
          (init?.method ?? 'GET') === 'POST'
        );
      });
      expect(postCall).toBeDefined();
      const body = JSON.parse(String(postCall?.[1]?.body ?? '{}'));
      expect(body.name).toBe('anycloud-serve-1');
      expect(body.region).toBe('us-east-1');
      expect(body.rules).toContainEqual({
        protocol: 'tcp',
        port_range: [22, 22],
        source_network: '10.0.0.0/8',
        description: 'SSH',
      });
      const httpRules = body.rules.filter(
        (rule: { port_range: [number, number] }) =>
          rule.port_range[0] === 80 && rule.port_range[1] === 80,
      );
      expect(httpRules).toHaveLength(CLOUDFLARE_IPV4_RANGES.length);
      expect(
        httpRules.every(
          (rule: { source_network: string }) =>
            !rule.source_network.includes(':'),
        ),
      ).toBe(true);
    });

    it('reuses an existing matching firewall ruleset', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          data: [
            {
              id: 'fw-existing',
              name: 'anycloud-serve-1',
              region: { name: 'us-east-1', description: '' },
              rules: [
                {
                  protocol: 'tcp',
                  port_range: [22, 22],
                  source_network: '0.0.0.0/0',
                  description: 'SSH',
                },
                ...CLOUDFLARE_IPV4_RANGES.map((source) => ({
                  protocol: 'tcp',
                  port_range: [80, 80] as [number, number],
                  source_network: source,
                  description: 'HTTP',
                })),
              ],
              created: '2026-06-24T00:00:00Z',
              instance_ids: [],
            },
          ],
        }),
      );

      const result = await makeLambda().compute().prepareNetwork!(
        buildServeIngressSpec(),
        'serve-1',
        '0.0.0-test',
        'u-1',
      );

      expect(result).toEqual({ firewallRulesetIds: ['fw-existing'] });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('terminateNetworking', () => {
    it('deletes matching workload rulesets across failover regions', async () => {
      const deleted: string[] = [];
      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url.endsWith('/firewall-rulesets') && method === 'GET') {
          return jsonResponse({
            data: [
              {
                id: 'fw-east-1',
                name: 'anycloud-serve-1',
                region: { name: 'us-east-1', description: '' },
                rules: [],
                created: '2026-06-24T00:00:00Z',
                instance_ids: [],
              },
              {
                id: 'fw-east-2',
                name: 'anycloud-serve-1',
                region: { name: 'us-east-2', description: '' },
                rules: [],
                created: '2026-06-24T00:00:00Z',
                instance_ids: [],
              },
              {
                id: 'fw-other-workload',
                name: 'anycloud-other-serve',
                region: { name: 'us-east-1', description: '' },
                rules: [],
                created: '2026-06-24T00:00:00Z',
                instance_ids: [],
              },
            ],
          });
        }
        if (url.includes('/firewall-rulesets/') && method === 'DELETE') {
          deleted.push(url.split('/').pop() ?? '');
          return jsonResponse({ data: {} });
        }
        return jsonResponse({ data: {} });
      });

      await expect(
        makeLambda().compute().terminateNetworking('serve-1'),
      ).resolves.toBeUndefined();
      expect(deleted.sort()).toEqual(['fw-east-1', 'fw-east-2']);
    });

    it('propagates ruleset list failures during final teardown', async () => {
      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url.endsWith('/firewall-rulesets') && method === 'GET') {
          return jsonResponse(
            {
              error: {
                code: 'provider/internal-unavailable',
                message: 'Provider unavailable',
              },
            },
            { ok: false, status: 503 },
          );
        }
        return jsonResponse({ data: {} });
      });

      await expect(
        makeLambda().compute().terminateNetworking('serve-1'),
      ).rejects.toThrow(/Provider unavailable/);
    });

    it('retries ruleset deletion while Lambda reports it in use', async () => {
      let deleteAttempts = 0;
      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url.endsWith('/firewall-rulesets') && method === 'GET') {
          return jsonResponse({
            data: [
              {
                id: 'fw-serve-1',
                name: 'anycloud-serve-1',
                region: { name: 'us-east-1', description: '' },
                rules: [],
                created: '2026-06-24T00:00:00Z',
                instance_ids: ['vm-terminating'],
              },
            ],
          });
        }
        if (
          url.endsWith('/firewall-rulesets/fw-serve-1') &&
          method === 'DELETE'
        ) {
          deleteAttempts += 1;
          if (deleteAttempts === 1) {
            return jsonResponse(
              {
                error: {
                  code: 'firewall-rulesets/firewall-ruleset-in-use',
                  message:
                    'Firewall ruleset is still associated with instances',
                },
              },
              { ok: false, status: 400 },
            );
          }
          return jsonResponse({ data: {} });
        }
        return jsonResponse({ data: {} });
      });

      await expect(
        makeLambda().compute().terminateNetworking('serve-1'),
      ).resolves.toBeUndefined();
      expect(deleteAttempts).toBe(2);
    });

    it('throws when a matching ruleset remains in use after retries', async () => {
      let deleteAttempts = 0;
      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url.endsWith('/firewall-rulesets') && method === 'GET') {
          return jsonResponse({
            data: [
              {
                id: 'fw-serve-1',
                name: 'anycloud-serve-1',
                region: { name: 'us-east-1', description: '' },
                rules: [],
                created: '2026-06-24T00:00:00Z',
                instance_ids: ['vm-terminating'],
              },
            ],
          });
        }
        if (
          url.endsWith('/firewall-rulesets/fw-serve-1') &&
          method === 'DELETE'
        ) {
          deleteAttempts += 1;
          return jsonResponse(
            {
              error: {
                code: 'firewall-rulesets/firewall-ruleset-in-use',
                message: 'Firewall ruleset is still associated with instances',
              },
            },
            { ok: false, status: 400 },
          );
        }
        return jsonResponse({ data: {} });
      });

      await expect(
        makeLambda().compute().terminateNetworking('serve-1'),
      ).rejects.toThrow(/was not deleted/);
      expect(deleteAttempts).toBe(10);
    });
  });

  describe('encodeName (via newVM instance name)', () => {
    it('produces distinct names for two launches in the same second', async () => {
      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url.endsWith('/ssh-keys') && method === 'GET') {
          return jsonResponse({
            data: [{ id: 'k1', name: 'anycloud-api' }],
          });
        }
        if (url.endsWith('/instances') && method === 'GET') {
          return emptyInstancesResponse();
        }
        if (url.endsWith('/instance-operations/launch') && method === 'POST') {
          return jsonResponse({
            data: { instance_ids: ['vm-' + Math.random().toString(36)] },
          });
        }
        if (url.includes('/instances/')) {
          return jsonResponse({ data: activeInstance('vm-x') });
        }
        return jsonResponse({ data: {} });
      });

      vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);

      const lambda = makeLambda();
      const launch = (vmId: string) =>
        lambda.compute().newVM(
          makeNewVMProps({
            startupScript: '#!/bin/bash\ntrue',
            ipWhitelist: [],
            vmId,
            workloadId: 'd-1',
            version: '0.0.0-test',
            userId: 'user-1',
          }),
        );

      await Promise.all([launch('a'), launch('b')]);

      const launchBodies = fetchMock.mock.calls
        .filter(([input]) =>
          String(input).endsWith('/instance-operations/launch'),
        )
        .map(([, init]) => JSON.parse(String(init?.body ?? '{}')));
      const nameCalls = launchBodies.map((body) => body.name as string);

      expect(nameCalls).toHaveLength(2);
      expect(new Set(nameCalls).size).toBe(2);
      expect(
        nameCalls.every((name) =>
          /^ac\|user-1\|1700000000\|[a-z0-9]{6}$/.test(name),
        ),
      ).toBe(true);
      expect(nameCalls.every((name) => name.length <= 64)).toBe(true);
      expect(launchBodies.every((body) => !body.name.includes('|d='))).toBe(
        true,
      );
      expect(launchBodies.every((body) => body.tags)).toBe(true);
      expect(launchBodies[0].tags).toEqual(lambdaTags('d-1', 'user-1'));
      expect(
        launchBodies.every(
          (body) => body.image?.family === 'lambda-stack-24-04',
        ),
      ).toBe(true);
    });

    it('keeps max-length user and workload metadata within Lambda name limits', async () => {
      const instanceId = '77777777-7777-7777-7777-777777777777';
      const userId = 'u'.repeat(39);
      const workloadId = 'd'.repeat(28);
      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url.endsWith('/ssh-keys') && method === 'GET') {
          return jsonResponse({
            data: [{ id: 'k1', name: 'anycloud-api' }],
          });
        }
        if (url.endsWith('/instances') && method === 'GET') {
          return emptyInstancesResponse();
        }
        if (url.endsWith('/instance-operations/launch') && method === 'POST') {
          return jsonResponse({ data: { instance_ids: [instanceId] } });
        }
        if (url.includes(`/instances/${instanceId}`)) {
          return jsonResponse({ data: activeInstance(instanceId) });
        }
        return jsonResponse({ data: {} });
      });

      vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);

      await makeLambda()
        .compute()
        .newVM(
          makeNewVMProps({
            startupScript: '#!/bin/bash\ntrue',
            ipWhitelist: [],
            vmId: 'vm-1',
            workloadId,
            version: '0.0.0-test',
            userId,
          }),
        );

      const launchBody = JSON.parse(
        String(
          fetchMock.mock.calls.find(([input]) =>
            String(input).endsWith('/instance-operations/launch'),
          )?.[1]?.body ?? '{}',
        ),
      );
      expect(launchBody.name).toHaveLength(60);
      expect(launchBody.name).not.toContain('|d=');
      expect(launchBody.tags).toEqual(lambdaTags(workloadId, userId));
    });
  });

  describe('ensurePlaceholderSSHKey (concurrency)', () => {
    it('tolerates a racing POST that returns "already exists"', async () => {
      let postCount = 0;
      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url.endsWith('/ssh-keys') && method === 'GET') {
          return jsonResponse({ data: [] });
        }
        if (url.endsWith('/instances') && method === 'GET') {
          return emptyInstancesResponse();
        }
        if (url.endsWith('/ssh-keys') && method === 'POST') {
          // Second POST sees the key already there.
          if (postCount++ > 0) {
            return jsonResponse(
              {
                error: {
                  code: 'global/duplicate',
                  message: 'SSH key name already exists',
                },
              },
              { ok: false, status: 409 },
            );
          }
          return jsonResponse({
            data: { id: 'k1', name: 'anycloud-api' },
          });
        }
        if (url.endsWith('/instance-operations/launch') && method === 'POST') {
          return jsonResponse({
            data: { instance_ids: ['vm-' + Math.random().toString(36)] },
          });
        }
        if (url.includes('/instances/')) {
          return jsonResponse({ data: activeInstance('vm-x') });
        }
        return jsonResponse({ data: {} });
      });

      const params = (vmId: string) =>
        makeNewVMProps({ vmId, workloadId: 'd-1', userId: 'u-1' });

      const a = makeLambda();
      const b = makeLambda();
      await expect(
        Promise.all([
          a.compute().newVM(params('a')),
          b.compute().newVM(params('b')),
        ]),
      ).resolves.toBeDefined();
    });
  });

  describe('newVM boot-wait', () => {
    it('adopts the tagged provisioning attempt after an API restart', async () => {
      const instanceId = '10101010-1010-1010-1010-101010101010';
      let launchCalls = 0;
      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url.endsWith('/ssh-keys') && method === 'GET') {
          return jsonResponse({
            data: [{ id: 'k1', name: 'anycloud-api' }],
          });
        }
        if (url.endsWith('/instances') && method === 'GET') {
          return jsonResponse({
            data: [
              activeInstance(instanceId, {
                name: 'ac|u-1|1700000000|restart',
                tags: lambdaTags('d-1', 'u-1'),
              }),
            ],
          });
        }
        if (url.endsWith('/instance-operations/launch') && method === 'POST') {
          launchCalls += 1;
        }
        if (url.includes(`/instances/${instanceId}`)) {
          return jsonResponse({
            data: activeInstance(instanceId, {
              name: 'ac|u-1|1700000000|restart',
              tags: lambdaTags('d-1', 'u-1'),
            }),
          });
        }
        return jsonResponse({ data: {} });
      });

      const vm = await makeLambda()
        .compute()
        .newVM(
          makeNewVMProps({
            startupScript: '#!/bin/bash\ntrue',
            ipWhitelist: [],
            vmId: 'vm-1',
            workloadId: 'd-1',
            version: '0.0.0-test',
            userId: 'u-1',
            adoptExistingAttempt: true,
          }),
        );

      expect(vm.cloudId).toBe(instanceId);
      expect(launchCalls).toBe(0);
    });

    it('returns the launch timestamp encoded in the provider instance name', async () => {
      const instanceId = '99999999-aaaa-bbbb-cccc-dddddddddddd';
      const launchedAtSeconds = 1_700_000_000;
      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url.endsWith('/ssh-keys') && method === 'GET') {
          return jsonResponse({
            data: [{ id: 'k1', name: 'anycloud-api' }],
          });
        }
        if (url.endsWith('/instances') && method === 'GET') {
          return emptyInstancesResponse();
        }
        if (url.endsWith('/instance-operations/launch') && method === 'POST') {
          return jsonResponse({ data: { instance_ids: [instanceId] } });
        }
        if (url.includes(`/instances/${instanceId}`)) {
          return jsonResponse({
            data: activeInstance(instanceId, {
              name: `ac|u-1|${launchedAtSeconds}|abc123`,
            }),
          });
        }
        return jsonResponse({ data: {} });
      });

      const vm = await makeLambda()
        .compute()
        .newVM(
          makeNewVMProps({
            startupScript: '#!/bin/bash\ntrue',
            ipWhitelist: [],
            vmId: 'vm-1',
            workloadId: 'd-1',
            version: '0.0.0-test',
            userId: 'u-1',
          }),
        );

      expect(vm.createdAt).toBe(launchedAtSeconds * 1000);
    });

    it('attaches prepared firewall rulesets at launch', async () => {
      const instanceId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url.endsWith('/ssh-keys') && method === 'GET') {
          return jsonResponse({
            data: [{ id: 'k1', name: 'anycloud-api' }],
          });
        }
        if (url.endsWith('/instances') && method === 'GET') {
          return emptyInstancesResponse();
        }
        if (url.endsWith('/instance-operations/launch') && method === 'POST') {
          return jsonResponse({ data: { instance_ids: [instanceId] } });
        }
        if (url.includes(`/instances/${instanceId}`)) {
          return jsonResponse({ data: activeInstance(instanceId) });
        }
        return jsonResponse({ data: {} });
      });

      await makeLambda()
        .compute()
        .newVM(
          makeNewVMProps({
            startupScript: '#!/bin/bash\ntrue',
            ipWhitelist: [],
            vmId: 'vm-1',
            workloadId: 'serve-1',
            version: '0.0.0-test',
            userId: 'u-1',
            network: { firewallRulesetIds: ['fw-1'] },
          }),
        );

      const launchCall = fetchMock.mock.calls.find(([input, init]) => {
        return (
          String(input).endsWith('/instance-operations/launch') &&
          (init?.method ?? 'GET') === 'POST'
        );
      });
      expect(launchCall).toBeDefined();
      expect(JSON.parse(String(launchCall?.[1]?.body ?? '{}'))).toMatchObject({
        firewall_rulesets: [{ id: 'fw-1' }],
      });
    });

    it('sweeps an existing same-workload Lambda instance before launching', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const staleId = '11111111-1111-1111-1111-111111111111';
      const instanceId = '22222222-2222-2222-2222-222222222222';
      const terminated: string[] = [];
      let listCalls = 0;

      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url.endsWith('/ssh-keys') && method === 'GET') {
          return jsonResponse({
            data: [{ id: 'k1', name: 'anycloud-api' }],
          });
        }
        if (url.endsWith('/instances') && method === 'GET') {
          listCalls += 1;
          return jsonResponse({
            data:
              listCalls === 1
                ? [
                    activeInstance(staleId, {
                      name: 'ac|u-1|1700000000|old111',
                      tags: lambdaTags('d-1'),
                    }),
                  ]
                : [],
          });
        }
        if (
          url.endsWith('/instance-operations/terminate') &&
          method === 'POST'
        ) {
          const body = JSON.parse(String(init?.body ?? '{}'));
          terminated.push(...(body.instance_ids ?? []));
          return jsonResponse({
            data: { terminated_instances: [{ id: staleId }] },
          });
        }
        if (url.includes(`/instances/${staleId}`)) {
          return jsonResponse({
            data: activeInstance(staleId, { status: 'terminated' }),
          });
        }
        if (url.endsWith('/instance-operations/launch') && method === 'POST') {
          return jsonResponse({ data: { instance_ids: [instanceId] } });
        }
        if (url.includes(`/instances/${instanceId}`)) {
          return jsonResponse({
            data: activeInstance(instanceId, {
              name: 'ac|u-1|1700000001|new222',
              tags: lambdaTags('d-1'),
            }),
          });
        }
        return jsonResponse({ data: {} });
      });

      await makeLambda()
        .compute()
        .newVM(
          makeNewVMProps({
            startupScript: '#!/bin/bash\ntrue',
            ipWhitelist: [],
            vmId: 'vm-1',
            workloadId: 'd-1',
            version: '0.0.0-test',
            userId: 'u-1',
          }),
        );

      const terminateIndex = fetchMock.mock.calls.findIndex(([input]) =>
        String(input).endsWith('/instance-operations/terminate'),
      );
      const launchIndex = fetchMock.mock.calls.findIndex(([input]) =>
        String(input).endsWith('/instance-operations/launch'),
      );
      expect(terminated).toEqual([staleId]);
      expect(terminateIndex).toBeGreaterThanOrEqual(0);
      expect(terminateIndex).toBeLessThan(launchIndex);
    });

    it('keeps a terminating duplicate in the sweep until Lambda confirms it is gone', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const staleId = '11111111-1111-1111-1111-111111111111';
      const instanceId = '22222222-2222-2222-2222-222222222222';
      const terminated: string[] = [];
      let listCalls = 0;
      let staleStatusChecks = 0;

      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url.endsWith('/ssh-keys') && method === 'GET') {
          return jsonResponse({
            data: [{ id: 'k1', name: 'anycloud-api' }],
          });
        }
        if (url.endsWith('/instances') && method === 'GET') {
          listCalls += 1;
          return jsonResponse({
            data:
              listCalls === 1
                ? [
                    activeInstance(staleId, {
                      name: 'ac|u-1|1700000000|old111',
                      status: 'terminating',
                      tags: lambdaTags('d-1'),
                    }),
                  ]
                : [],
          });
        }
        if (
          url.endsWith('/instance-operations/terminate') &&
          method === 'POST'
        ) {
          const body = JSON.parse(String(init?.body ?? '{}'));
          terminated.push(...(body.instance_ids ?? []));
          return jsonResponse({
            data: { terminated_instances: [{ id: staleId }] },
          });
        }
        if (url.includes(`/instances/${staleId}`)) {
          staleStatusChecks += 1;
          return jsonResponse({
            data: activeInstance(staleId, {
              status: staleStatusChecks === 1 ? 'terminating' : 'terminated',
            }),
          });
        }
        if (url.endsWith('/instance-operations/launch') && method === 'POST') {
          return jsonResponse({ data: { instance_ids: [instanceId] } });
        }
        if (url.includes(`/instances/${instanceId}`)) {
          return jsonResponse({ data: activeInstance(instanceId) });
        }
        return jsonResponse({ data: {} });
      });

      await makeLambda()
        .compute()
        .newVM(
          makeNewVMProps({
            startupScript: '#!/bin/bash\ntrue',
            ipWhitelist: [],
            vmId: 'vm-1',
            workloadId: 'd-1',
            version: '0.0.0-test',
            userId: 'u-1',
          }),
        );

      expect(terminated).toEqual([staleId]);
      expect(staleStatusChecks).toBe(3);
    });

    it('bounds the stale-instance confirmation fan-out', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      // Issuing every confirmation poll at once creates a burst against one
      // credential and delays unrelated work behind reactive retries.
      const staleIds = Array.from(
        { length: 12 },
        (_, i) =>
          `${String(i + 1).padStart(8, '0')}-1111-1111-1111-111111111111`,
      );
      const instanceId = '99999999-9999-9999-9999-999999999999';
      let listCalls = 0;
      let inFlightStatusChecks = 0;
      let peakInFlightStatusChecks = 0;

      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url.endsWith('/ssh-keys') && method === 'GET') {
          return jsonResponse({ data: [{ id: 'k1', name: 'anycloud-api' }] });
        }
        if (url.endsWith('/instances') && method === 'GET') {
          listCalls += 1;
          return jsonResponse({
            data:
              listCalls === 1
                ? staleIds.map((id, i) =>
                    activeInstance(id, {
                      name: `ac|u-1|17000000${String(i).padStart(2, '0')}|old${i}`,
                      tags: lambdaTags('d-1'),
                    }),
                  )
                : [],
          });
        }
        if (
          url.endsWith('/instance-operations/terminate') &&
          method === 'POST'
        ) {
          return jsonResponse({
            data: { terminated_instances: staleIds.map((id) => ({ id })) },
          });
        }
        if (url.endsWith('/instance-operations/launch') && method === 'POST') {
          return jsonResponse({ data: { instance_ids: [instanceId] } });
        }
        if (url.includes(`/instances/${instanceId}`)) {
          return jsonResponse({ data: activeInstance(instanceId) });
        }
        const stale = staleIds.find((id) => url.includes(`/instances/${id}`));
        if (stale) {
          inFlightStatusChecks += 1;
          peakInFlightStatusChecks = Math.max(
            peakInFlightStatusChecks,
            inFlightStatusChecks,
          );
          // Yield so siblings admitted in the same batch overlap here.
          await Promise.resolve();
          inFlightStatusChecks -= 1;
          return jsonResponse({
            data: activeInstance(stale, { status: 'terminated' }),
          });
        }
        return jsonResponse({ data: {} });
      });

      await makeLambda()
        .compute()
        .newVM(
          makeNewVMProps({ vmId: 'vm-1', workloadId: 'd-1', userId: 'u-1' }),
        );

      expect(peakInFlightStatusChecks).toBeGreaterThan(0);
      expect(peakInFlightStatusChecks).toBeLessThanOrEqual(
        LAMBDA_TERMINATE_CONCURRENCY,
      );
    });

    it('does not sweep names that lack workload tag attribution', async () => {
      const oldFormatId = '33333333-3333-3333-3333-333333333333';
      const instanceId = '44444444-4444-4444-4444-444444444444';
      const terminated: string[] = [];
      let listCalls = 0;

      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url.endsWith('/ssh-keys') && method === 'GET') {
          return jsonResponse({
            data: [{ id: 'k1', name: 'anycloud-api' }],
          });
        }
        if (url.endsWith('/instances') && method === 'GET') {
          listCalls += 1;
          return jsonResponse({
            data:
              listCalls === 1
                ? [
                    activeInstance(oldFormatId, {
                      name: 'ac|u-1|1700000000|old111',
                    }),
                  ]
                : [],
          });
        }
        if (
          url.endsWith('/instance-operations/terminate') &&
          method === 'POST'
        ) {
          const body = JSON.parse(String(init?.body ?? '{}'));
          terminated.push(...(body.instance_ids ?? []));
          return jsonResponse({ data: { terminated_instances: [] } });
        }
        if (url.endsWith('/instance-operations/launch') && method === 'POST') {
          return jsonResponse({ data: { instance_ids: [instanceId] } });
        }
        if (url.includes(`/instances/${instanceId}`)) {
          return jsonResponse({
            data: activeInstance(instanceId, {
              name: 'ac|u-1|1700000001|new222',
              tags: lambdaTags('d-1'),
            }),
          });
        }
        return jsonResponse({ data: {} });
      });

      await makeLambda()
        .compute()
        .newVM(
          makeNewVMProps({
            startupScript: '#!/bin/bash\ntrue',
            ipWhitelist: [],
            vmId: 'vm-1',
            workloadId: 'd-1',
            version: '0.0.0-test',
            userId: 'u-1',
          }),
        );

      expect(terminated).toEqual([]);
    });

    it('requires an authoritative list read before an unresolved attempt is absent', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(
          { error: { code: 'HTTP 500', message: 'Internal Server Error' } },
          { ok: false, status: 500 },
        ),
      );
      const compute = makeLambda().compute();

      await expect(
        compute.adoptProvisioningAttempt!({
          workloadId: 'd-1',
          vmId: 'vm-1',
          userId: 'u-1',
        }),
      ).rejects.toThrow(ResourceStateIndeterminateError);

      expect(
        fetchMock.mock.calls.some(([input]) =>
          String(input).endsWith('/instances'),
        ),
      ).toBe(true);
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            String(input).endsWith('/instance-operations/launch') &&
            (init?.method ?? 'GET') === 'POST',
        ),
      ).toBe(false);
    });

    it('bounds unresolved-attempt 429 retries by the settle window', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      useTimedSleepMock();
      vi.spyOn(Math, 'random').mockReturnValue(0);
      fetchMock.mockResolvedValue(unparseableResponse({ status: 429 }));
      const compute = makeLambda().compute();
      let settledAt: number | undefined;

      const result = compute.adoptProvisioningAttempt!({
        workloadId: 'd-1',
        vmId: 'vm-1',
        userId: 'u-1',
      })
        .catch((error: unknown) => error)
        .finally(() => {
          settledAt = Date.now();
        });

      await vi.advanceTimersByTimeAsync(12_001);
      const settledWithinWindow = settledAt;
      if (settledAt === undefined) await vi.runAllTimersAsync();
      const error = await result;
      vi.mocked(sleep).mockResolvedValue(undefined);

      expect(error).toBeInstanceOf(ResourceStateIndeterminateError);
      expect((error as Error).message).toContain('HTTP 429');
      expect(settledWithinWindow).toBeDefined();
      expect(settledWithinWindow).toBeLessThanOrEqual(12_001);
      // The outer reconcile poll shares the same deadline; it must not start a
      // fresh 429 retry owner after the second backoff no longer fits.
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('preserves the last provider error when the reconcile deadline interrupts polling', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      useTimedSleepMock();
      fetchMock.mockResolvedValue(
        jsonResponse(
          { error: { code: 'HTTP 500', message: 'Internal Server Error' } },
          { ok: false, status: 500 },
        ),
      );

      const result = makeLambda().compute().adoptProvisioningAttempt!({
        workloadId: 'd-1',
        vmId: 'vm-1',
        userId: 'u-1',
      }).catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(12_001);
      const error = await result;
      vi.mocked(sleep).mockResolvedValue(undefined);

      expect(error).toBeInstanceOf(ResourceStateIndeterminateError);
      expect((error as Error).message).toContain(
        'Lambda API GET /instances: [HTTP 500] Internal Server Error',
      );
    });

    it('accepts one successful empty list read as authoritative absence', async () => {
      fetchMock.mockResolvedValue(emptyInstancesResponse());
      const compute = makeLambda().compute();

      await expect(
        compute.adoptProvisioningAttempt!({
          workloadId: 'd-1',
          vmId: 'vm-1',
          userId: 'u-1',
        }),
      ).resolves.toBeNull();
    });

    it('adopts an instance a prior transient attempt already created, without launching again', async () => {
      // Lambda has no launch idempotency key (confirmed against its OpenAPI
      // spec), so an accepted-but-lost launch would otherwise be re-POSTed into
      // a duplicate. When the prior attempt's instance is already listable, the
      // retry reconciles it by workload tag and adopts it instead of
      // launching a second one.
      const acceptedId = '55555555-5555-5555-5555-555555555555';
      const terminated: string[] = [];
      let launchCalls = 0;
      let listCalls = 0;

      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url.endsWith('/ssh-keys') && method === 'GET') {
          return jsonResponse({
            data: [{ id: 'k1', name: 'anycloud-api' }],
          });
        }
        if (url.endsWith('/instances') && method === 'GET') {
          listCalls += 1;
          // Not listable for the pre-launch sweep (call #1); visible from the
          // retry reconcile (call #2) onward.
          return jsonResponse({
            data:
              listCalls >= 2
                ? [
                    activeInstance(acceptedId, {
                      name: 'ac|u-1|1700000000|acc555',
                      tags: lambdaTags('d-1'),
                    }),
                  ]
                : [],
          });
        }
        if (url.endsWith('/instance-operations/launch') && method === 'POST') {
          launchCalls += 1;
          // The one and only launch is accepted by Lambda but its response is
          // lost — surfaced to us as a transient 502.
          return jsonResponse(
            {
              error: {
                code: 'HTTP 502',
                message: 'Bad Gateway',
              },
            },
            { ok: false, status: 502 },
          );
        }
        if (
          url.endsWith('/instance-operations/terminate') &&
          method === 'POST'
        ) {
          const body = JSON.parse(String(init?.body ?? '{}'));
          terminated.push(...(body.instance_ids ?? []));
          return jsonResponse({ data: { terminated_instances: [] } });
        }
        if (url.includes(`/instances/${acceptedId}`)) {
          return jsonResponse({
            data: activeInstance(acceptedId, {
              name: 'ac|u-1|1700000000|acc555',
              tags: lambdaTags('d-1'),
            }),
          });
        }
        return jsonResponse({ data: {} });
      });

      const vm = await makeLambda()
        .compute()
        .newVM(
          makeNewVMProps({
            startupScript: '#!/bin/bash\ntrue',
            ipWhitelist: [],
            vmId: 'vm-1',
            workloadId: 'd-1',
            version: '0.0.0-test',
            userId: 'u-1',
          }),
        );

      // Adopted the prior instance; no second launch, nothing terminated.
      expect(vm.cloudId).toBe(acceptedId);
      expect(launchCalls).toBe(1);
      expect(terminated).toEqual([]);
    });

    it('keeps polling and adopts an instance that only becomes listable partway through the settle poll', async () => {
      // The prior attempt's instance is invisible when the retry first checks;
      // Lambda's list lag makes it appear a couple of polls later. Because the
      // retry polls across the whole launch-slot wait rather than checking once,
      // it still adopts it — no duplicate launch. This is the window a single
      // pre-launch check would miss.
      const acceptedId = '99999999-9999-9999-9999-999999999999';
      const terminated: string[] = [];
      let launchCalls = 0;
      let listGets = 0;

      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url.endsWith('/ssh-keys') && method === 'GET') {
          return jsonResponse({ data: [{ id: 'k1', name: 'anycloud-api' }] });
        }
        if (url.endsWith('/instances') && method === 'GET') {
          listGets += 1;
          // Invisible for the pre-launch sweep and the first couple of polls;
          // becomes listable only from the third poll on.
          return jsonResponse({
            data:
              listGets >= 4
                ? [
                    activeInstance(acceptedId, {
                      name: 'ac|u-1|1700000000|late999',
                      tags: lambdaTags('d-1'),
                    }),
                  ]
                : [],
          });
        }
        if (url.endsWith('/instance-operations/launch') && method === 'POST') {
          launchCalls += 1;
          return jsonResponse(
            { error: { code: 'HTTP 502', message: 'Bad Gateway' } },
            { ok: false, status: 502 },
          );
        }
        if (
          url.endsWith('/instance-operations/terminate') &&
          method === 'POST'
        ) {
          const body = JSON.parse(String(init?.body ?? '{}'));
          terminated.push(...(body.instance_ids ?? []));
          return jsonResponse({ data: { terminated_instances: [] } });
        }
        if (url.includes(`/instances/${acceptedId}`)) {
          return jsonResponse({
            data: activeInstance(acceptedId, {
              name: 'ac|u-1|1700000000|late999',
              tags: lambdaTags('d-1'),
            }),
          });
        }
        return jsonResponse({ data: {} });
      });

      const vm = await makeLambda()
        .compute()
        .newVM(
          makeNewVMProps({
            startupScript: '#!/bin/bash\ntrue',
            ipWhitelist: [],
            vmId: 'vm-1',
            workloadId: 'd-1',
            version: '0.0.0-test',
            userId: 'u-1',
          }),
        );

      // Adopted the late-appearing instance without a second launch.
      expect(vm.cloudId).toBe(acceptedId);
      expect(launchCalls).toBe(1);
      expect(terminated).toEqual([]);
    });

    it('does not re-launch when an uncertain instance stays unlistable through the poll', async () => {
      // A successful empty list cannot prove that an accepted launch will not
      // appear later. Preserve the durable attempt for later reconciliation
      // instead of risking a duplicate create.
      const terminated: string[] = [];
      let launchCalls = 0;

      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url.endsWith('/ssh-keys') && method === 'GET') {
          return jsonResponse({ data: [{ id: 'k1', name: 'anycloud-api' }] });
        }
        if (url.endsWith('/instances') && method === 'GET') {
          return emptyInstancesResponse();
        }
        if (url.endsWith('/instance-operations/launch') && method === 'POST') {
          launchCalls += 1;
          return jsonResponse(
            { error: { code: 'HTTP 502', message: 'Bad Gateway' } },
            { ok: false, status: 502 },
          );
        }
        if (
          url.endsWith('/instance-operations/terminate') &&
          method === 'POST'
        ) {
          const body = JSON.parse(String(init?.body ?? '{}'));
          terminated.push(...(body.instance_ids ?? []));
          return jsonResponse({
            data: { terminated_instances: [] },
          });
        }
        return jsonResponse({ data: {} });
      });

      await expect(
        makeLambda()
          .compute()
          .newVM(
            makeNewVMProps({
              startupScript: '#!/bin/bash\ntrue',
              ipWhitelist: [],
              vmId: 'vm-1',
              workloadId: 'd-1',
              version: '0.0.0-test',
              userId: 'u-1',
            }),
          ),
      ).rejects.toThrow(ResourceStateIndeterminateError);

      expect(launchCalls).toBe(1);
      expect(terminated).toEqual([]);
    });

    it('adopts an active instance over an unhealthy one and sweeps the unhealthy leftover', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      // If a prior attempt left both an unhealthy and an active instance for
      // the workload, adopt the recoverable (active) one, never the unhealthy
      // one — otherwise the keep-one sweep would terminate the healthy VM and
      // boot polling would fail on the unhealthy adoptee. Unhealthy is listed
      // first to prove API ordering does not decide adoption.
      const unhealthyId = 'aaaaaaaa-0000-0000-0000-000000000000';
      const activeId = 'bbbbbbbb-0000-0000-0000-000000000000';
      const terminated: string[] = [];
      let launchCalls = 0;
      let listCalls = 0;

      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url.endsWith('/ssh-keys') && method === 'GET') {
          return jsonResponse({ data: [{ id: 'k1', name: 'anycloud-api' }] });
        }
        if (url.endsWith('/instances') && method === 'GET') {
          listCalls += 1;
          return jsonResponse({
            data:
              listCalls >= 2
                ? [
                    activeInstance(unhealthyId, {
                      name: 'ac|u-1|1700000000|unh000',
                      status: terminated.includes(unhealthyId)
                        ? 'terminated'
                        : 'unhealthy',
                      tags: lambdaTags('d-1'),
                    }),
                    activeInstance(activeId, {
                      name: 'ac|u-1|1700000001|act000',
                      tags: lambdaTags('d-1'),
                    }),
                  ]
                : [],
          });
        }
        if (url.endsWith('/instance-operations/launch') && method === 'POST') {
          launchCalls += 1;
          return jsonResponse(
            { error: { code: 'HTTP 502', message: 'Bad Gateway' } },
            { ok: false, status: 502 },
          );
        }
        if (
          url.endsWith('/instance-operations/terminate') &&
          method === 'POST'
        ) {
          const body = JSON.parse(String(init?.body ?? '{}'));
          terminated.push(...(body.instance_ids ?? []));
          return jsonResponse({
            data: { terminated_instances: [{ id: unhealthyId }] },
          });
        }
        if (url.includes(`/instances/${unhealthyId}`)) {
          return jsonResponse({
            data: activeInstance(unhealthyId, { status: 'terminated' }),
          });
        }
        if (url.includes(`/instances/${activeId}`)) {
          return jsonResponse({
            data: activeInstance(activeId, {
              name: 'ac|u-1|1700000001|act000',
              tags: lambdaTags('d-1'),
            }),
          });
        }
        return jsonResponse({ data: {} });
      });

      const vm = await makeLambda()
        .compute()
        .newVM(
          makeNewVMProps({
            startupScript: '#!/bin/bash\ntrue',
            ipWhitelist: [],
            vmId: 'vm-1',
            workloadId: 'd-1',
            version: '0.0.0-test',
            userId: 'u-1',
          }),
        );

      expect(vm.cloudId).toBe(activeId);
      expect(launchCalls).toBe(1);
      expect(terminated).toEqual([unhealthyId]);
    });

    it('does not adopt or re-launch after observing a mismatched same-workload instance', async () => {
      // A leftover from an earlier region/type attempt for the same workload
      // must not be adopted — the provisioning layer would then record it under
      // the current (wrong) region/type/price. It also cannot prove whether the
      // uncertain matching launch will appear later, so defer without resending.
      const mismatchId = 'cccccccc-0000-0000-0000-000000000000';
      const instanceId = 'dddddddd-0000-0000-0000-000000000000';
      const terminated: string[] = [];
      let launchCalls = 0;
      let mismatchListable = false; // surfaces only after the pre-launch sweep
      let instanceLaunched = false;

      const mismatchInstance = () =>
        activeInstance(mismatchId, {
          name: 'ac|u-1|1700000000|mis000',
          region: { name: 'us-west-1', description: '' },
          tags: lambdaTags('d-1'),
        });

      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url.endsWith('/ssh-keys') && method === 'GET') {
          return jsonResponse({ data: [{ id: 'k1', name: 'anycloud-api' }] });
        }
        if (url.endsWith('/instances') && method === 'GET') {
          return jsonResponse({
            data: [
              ...(mismatchListable ? [mismatchInstance()] : []),
              ...(instanceLaunched
                ? [
                    activeInstance(instanceId, {
                      name: 'ac|u-1|1700000001|new000',
                      tags: lambdaTags('d-1'),
                    }),
                  ]
                : []),
            ],
          });
        }
        if (url.endsWith('/instance-operations/launch') && method === 'POST') {
          launchCalls += 1;
          if (launchCalls === 1) {
            mismatchListable = true; // wrong-region leftover appears post-sweep
            return jsonResponse(
              { error: { code: 'HTTP 502', message: 'Bad Gateway' } },
              { ok: false, status: 502 },
            );
          }
          instanceLaunched = true;
          return jsonResponse({ data: { instance_ids: [instanceId] } });
        }
        if (
          url.endsWith('/instance-operations/terminate') &&
          method === 'POST'
        ) {
          const body = JSON.parse(String(init?.body ?? '{}'));
          terminated.push(...(body.instance_ids ?? []));
          return jsonResponse({
            data: { terminated_instances: [{ id: mismatchId }] },
          });
        }
        if (url.includes(`/instances/${mismatchId}`)) {
          return jsonResponse({
            data: activeInstance(mismatchId, { status: 'terminated' }),
          });
        }
        if (url.includes(`/instances/${instanceId}`)) {
          return jsonResponse({
            data: activeInstance(instanceId, {
              name: 'ac|u-1|1700000001|new000',
              tags: lambdaTags('d-1'),
            }),
          });
        }
        return jsonResponse({ data: {} });
      });

      await expect(
        makeLambda()
          .compute()
          .newVM(
            makeNewVMProps({
              startupScript: '#!/bin/bash\ntrue',
              ipWhitelist: [],
              vmId: 'vm-1',
              workloadId: 'd-1',
              version: '0.0.0-test',
              userId: 'u-1',
            }),
          ),
      ).rejects.toThrow(ResourceStateIndeterminateError);

      expect(launchCalls).toBe(1);
      expect(terminated).toEqual([]);
    });

    it('stops launch retries when no reconciliation read succeeds', async () => {
      // Lambda has no idempotency token. Once a launch response is uncertain,
      // failed observation cannot be treated as proof that no instance exists.
      let launchCalls = 0;
      let listCalls = 0;

      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url.endsWith('/ssh-keys') && method === 'GET') {
          return jsonResponse({ data: [{ id: 'k1', name: 'anycloud-api' }] });
        }
        if (url.endsWith('/instances') && method === 'GET') {
          listCalls += 1;
          // The initial pre-launch sweep is authoritative. Every observation
          // after the uncertain POST fails, so no retry POST is safe.
          if (listCalls > 1) {
            return jsonResponse(
              { error: { code: 'HTTP 500', message: 'Internal Server Error' } },
              { ok: false, status: 500 },
            );
          }
          return jsonResponse({ data: [] });
        }
        if (url.endsWith('/instance-operations/launch') && method === 'POST') {
          launchCalls += 1;
          return jsonResponse(
            { error: { code: 'HTTP 502', message: 'Bad Gateway' } },
            { ok: false, status: 502 },
          );
        }
        return jsonResponse({ data: {} });
      });

      await expect(
        makeLambda()
          .compute()
          .newVM(
            makeNewVMProps({
              startupScript: '#!/bin/bash\ntrue',
              ipWhitelist: [],
              vmId: 'vm-1',
              workloadId: 'd-1',
              version: '0.0.0-test',
              userId: 'u-1',
            }),
          ),
      ).rejects.toThrow(ResourceStateIndeterminateError);

      expect(launchCalls).toBe(1);
      expect(listCalls).toBeGreaterThan(1);
    });

    it('defers an uncertain unhealthy instance without re-launching or sweeping', async () => {
      // The prior attempt's instance became listable but is unhealthy, so the
      // settle poll cannot adopt it. Preserve the attempt for durable recovery
      // rather than mutating provider state while the launch is uncertain.
      const acceptedId = '77777777-7777-7777-7777-777777777777';
      const terminated: string[] = [];
      let launchCalls = 0;
      let acceptedListable = false;

      vi.useFakeTimers();
      vi.setSystemTime(1_000_000);
      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url.endsWith('/ssh-keys') && method === 'GET') {
          return jsonResponse({ data: [{ id: 'k1', name: 'anycloud-api' }] });
        }
        if (url.endsWith('/instances') && method === 'GET') {
          // The production poll sleeps between reads. Advance the mocked clock
          // so the settle-window deadline sees that same passage of time.
          vi.advanceTimersByTime(2_000);
          return jsonResponse({
            data: acceptedListable
              ? [
                  activeInstance(acceptedId, {
                    name: 'ac|u-1|1700000000|acc777',
                    status: 'unhealthy',
                    tags: lambdaTags('d-1'),
                  }),
                ]
              : [],
          });
        }
        if (url.endsWith('/instance-operations/launch') && method === 'POST') {
          launchCalls += 1;
          acceptedListable = true; // accepted-but-unhealthy after the first try
          return jsonResponse(
            { error: { code: 'HTTP 502', message: 'Bad Gateway' } },
            { ok: false, status: 502 },
          );
        }
        if (
          url.endsWith('/instance-operations/terminate') &&
          method === 'POST'
        ) {
          const body = JSON.parse(String(init?.body ?? '{}'));
          terminated.push(...(body.instance_ids ?? []));
          return jsonResponse({
            data: { terminated_instances: [{ id: acceptedId }] },
          });
        }
        if (url.includes(`/instances/${acceptedId}`)) {
          return jsonResponse({
            data: activeInstance(acceptedId, { status: 'terminated' }),
          });
        }
        return jsonResponse({ data: {} });
      });

      await expect(
        makeLambda()
          .compute()
          .newVM(
            makeNewVMProps({
              startupScript: '#!/bin/bash\ntrue',
              ipWhitelist: [],
              vmId: 'vm-1',
              workloadId: 'd-1',
              version: '0.0.0-test',
              userId: 'u-1',
            }),
          ),
      ).rejects.toThrow(ResourceStateIndeterminateError);

      expect(launchCalls).toBe(1);
      expect(terminated).toEqual([]);
    });

    it('does not let a later quota response relabel an uncertain launch', async () => {
      // The prior attempt's instance is listable but unhealthy, so the poll does
      // not adopt it. A second POST could return a definitive quota error and
      // hide the first request's unknown outcome, so it must never be issued.
      const acceptedId = '88888888-8888-8888-8888-888888888888';
      const terminated: string[] = [];
      let launchCalls = 0;
      let acceptedListable = false;

      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url.endsWith('/ssh-keys') && method === 'GET') {
          return jsonResponse({ data: [{ id: 'k1', name: 'anycloud-api' }] });
        }
        if (url.endsWith('/instances') && method === 'GET') {
          return jsonResponse({
            data: acceptedListable
              ? [
                  activeInstance(acceptedId, {
                    name: 'ac|u-1|1700000000|acc888',
                    status: 'unhealthy',
                    tags: lambdaTags('d-1'),
                  }),
                ]
              : [],
          });
        }
        if (url.endsWith('/instance-operations/launch') && method === 'POST') {
          launchCalls += 1;
          if (launchCalls === 1) {
            acceptedListable = true;
            return jsonResponse(
              {
                error: {
                  code: 'HTTP 502',
                  message: 'Bad Gateway',
                },
              },
              { ok: false, status: 502 },
            );
          }
          return jsonResponse(
            {
              error: {
                code: 'global/quota-exceeded',
                message: 'Too many instances',
              },
            },
            { ok: false, status: 429 },
          );
        }
        if (
          url.endsWith('/instance-operations/terminate') &&
          method === 'POST'
        ) {
          const body = JSON.parse(String(init?.body ?? '{}'));
          terminated.push(...(body.instance_ids ?? []));
          return jsonResponse({
            data: { terminated_instances: [{ id: acceptedId }] },
          });
        }
        if (url.includes(`/instances/${acceptedId}`)) {
          return jsonResponse({
            data: activeInstance(acceptedId, { status: 'terminated' }),
          });
        }
        return jsonResponse({ data: {} });
      });

      await expect(
        makeLambda()
          .compute()
          .newVM(
            makeNewVMProps({
              startupScript: '#!/bin/bash\ntrue',
              ipWhitelist: [],
              vmId: 'vm-1',
              workloadId: 'd-1',
              version: '0.0.0-test',
              userId: 'u-1',
            }),
          ),
      ).rejects.toThrow(ResourceStateIndeterminateError);

      expect(launchCalls).toBe(1);
      expect(terminated).toEqual([]);
    });

    it('terminates the launched instance if it never gets an IP', async () => {
      // terminateVMs filters by UUID format, so tests must use real UUIDs.
      const instanceId = '11111111-2222-3333-4444-555555555555';
      const terminated: string[] = [];

      // The mocked retryUntil loops all 60 boot-wait attempts without the real
      // 5s wait. Advance fake time on every response so date-based lifecycle
      // checks observe the same spacing production does.
      vi.useFakeTimers();
      try {
        vi.setSystemTime(1_000_000);
        fetchMock.mockImplementation(async (input, init) => {
          const url = String(input);
          const method = init?.method ?? 'GET';
          if (url.endsWith('/ssh-keys') && method === 'GET') {
            return jsonResponse({
              data: [{ id: 'k1', name: 'anycloud-api' }],
            });
          }
          if (url.endsWith('/instances') && method === 'GET') {
            return emptyInstancesResponse();
          }
          if (
            url.endsWith('/instance-operations/launch') &&
            method === 'POST'
          ) {
            return jsonResponse({ data: { instance_ids: [instanceId] } });
          }
          if (
            url.endsWith('/instance-operations/terminate') &&
            method === 'POST'
          ) {
            const body = JSON.parse(String(init?.body ?? '{}'));
            terminated.push(...(body.instance_ids ?? []));
            return jsonResponse({
              data: { terminated_instances: [{ id: instanceId }] },
            });
          }
          if (url.includes(`/instances/${instanceId}`)) {
            // Stuck in "booting" forever — no IP.
            vi.advanceTimersByTime(5_000);
            return jsonResponse({
              data: activeInstance(instanceId, {
                ip: null,
                status: 'booting',
              }),
            });
          }
          return jsonResponse({ data: {} });
        });

        await expect(
          makeLambda()
            .compute()
            .newVM(
              makeNewVMProps({
                startupScript: '#!/bin/bash\ntrue',
                ipWhitelist: [],
                vmId: 'vm-1',
                workloadId: 'd-1',
                version: '0.0.0-test',
                userId: 'u-1',
              }),
            ),
        ).rejects.toThrow(/did not get IP/);

        expect(terminated).toContain(instanceId);
      } finally {
        vi.useRealTimers();
      }
    });

    it('aborts the boot wait when the instance goes unhealthy', async () => {
      const instanceId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      const terminated: string[] = [];

      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url.endsWith('/ssh-keys') && method === 'GET') {
          return jsonResponse({
            data: [{ id: 'k1', name: 'anycloud-api' }],
          });
        }
        if (url.endsWith('/instances') && method === 'GET') {
          return emptyInstancesResponse();
        }
        if (url.endsWith('/instance-operations/launch') && method === 'POST') {
          return jsonResponse({ data: { instance_ids: [instanceId] } });
        }
        if (
          url.endsWith('/instance-operations/terminate') &&
          method === 'POST'
        ) {
          const body = JSON.parse(String(init?.body ?? '{}'));
          terminated.push(...(body.instance_ids ?? []));
          return jsonResponse({
            data: { terminated_instances: [{ id: instanceId }] },
          });
        }
        if (url.includes(`/instances/${instanceId}`)) {
          return jsonResponse({
            data: activeInstance(instanceId, {
              ip: null,
              status: 'unhealthy',
            }),
          });
        }
        return jsonResponse({ data: {} });
      });

      await expect(
        makeLambda()
          .compute()
          .newVM(
            makeNewVMProps({
              startupScript: '#!/bin/bash\ntrue',
              ipWhitelist: [],
              vmId: 'vm-1',
              workloadId: 'd-1',
              version: '0.0.0-test',
              userId: 'u-1',
            }),
          ),
      ).rejects.toThrow(/unhealthy/);

      // Orphan must be cleaned up on abort too, not just on IP timeout.
      expect(terminated).toContain(instanceId);
    });

    it('preserves the provider ID when boot-failure cleanup also fails', async () => {
      const instanceId = 'aaaaaaaa11111111bbbbbbbb22222222';
      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url.endsWith('/ssh-keys') && method === 'GET') {
          return jsonResponse({
            data: [{ id: 'k1', name: 'anycloud-api' }],
          });
        }
        if (url.endsWith('/instances') && method === 'GET') {
          return emptyInstancesResponse();
        }
        if (url.endsWith('/instance-operations/launch') && method === 'POST') {
          return jsonResponse({ data: { instance_ids: [instanceId] } });
        }
        if (
          url.endsWith('/instance-operations/terminate') &&
          method === 'POST'
        ) {
          return jsonResponse(
            {
              error: {
                code: 'provider/internal-unavailable',
                message: 'Terminate temporarily unavailable',
              },
            },
            { ok: false, status: 503 },
          );
        }
        if (url.includes(`/instances/${instanceId}`)) {
          return jsonResponse({
            data: activeInstance(instanceId, {
              ip: null,
              status: 'unhealthy',
            }),
          });
        }
        return jsonResponse({ data: {} });
      });

      const error = await makeLambda()
        .compute()
        .newVM(
          makeNewVMProps({
            startupScript: '#!/bin/bash\ntrue',
            ipWhitelist: [],
            vmId: 'd-1-0',
            workloadId: 'd-1',
            version: '0.0.0-test',
            userId: 'u-1',
          }),
        )
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(VMCreationError);
      expect((error as VMCreationError).attemptedVmIds).toEqual([instanceId]);
      expect((error as VMCreationError).originalError.message).toMatch(
        /entered unhealthy during boot/,
      );
    });

    it('aborts the boot wait when the instance goes preempted', async () => {
      const instanceId = 'ffffffff-0000-1111-2222-333333333333';
      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url.endsWith('/ssh-keys') && method === 'GET') {
          return jsonResponse({
            data: [{ id: 'k1', name: 'anycloud-api' }],
          });
        }
        if (url.endsWith('/instances') && method === 'GET') {
          return emptyInstancesResponse();
        }
        if (url.endsWith('/instance-operations/launch') && method === 'POST') {
          return jsonResponse({ data: { instance_ids: [instanceId] } });
        }
        if (
          url.endsWith('/instance-operations/terminate') &&
          method === 'POST'
        ) {
          return jsonResponse({
            data: { terminated_instances: [{ id: instanceId }] },
          });
        }
        if (url.includes(`/instances/${instanceId}`)) {
          return jsonResponse({
            data: activeInstance(instanceId, {
              ip: null,
              status: 'preempted',
            }),
          });
        }
        return jsonResponse({ data: {} });
      });

      await expect(
        makeLambda()
          .compute()
          .newVM(
            makeNewVMProps({
              startupScript: '#!/bin/bash\ntrue',
              ipWhitelist: [],
              vmId: 'vm-1',
              workloadId: 'd-1',
              version: '0.0.0-test',
              userId: 'u-1',
            }),
          ),
      ).rejects.toThrow(/preempted/);
    });
  });

  describe('instance list pagination', () => {
    // Lambda pages GET /instances (50 per page by default) and returns
    // `page_token: null` on the last page. Each test puts the instance that
    // matters on page 2.
    function pagedList(
      url: string,
      page1: unknown[],
      page2: unknown[],
      page2Token: string | null = null,
    ): Response {
      return url.endsWith('/instances')
        ? jsonResponse({ data: page1, page_token: 'p2' })
        : jsonResponse({ data: page2, page_token: page2Token });
    }
    const isList = (url: string, method: string) =>
      method === 'GET' && /\/instances(\?page_token=p2)?$/.test(url);

    it('sweeps an orphan that is only on page 2', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const oldSec = Math.floor(Date.now() / 1000) - 4 * 60 * 60;
      const orphanId = '11111111222233334444555555555555';
      const terminated: string[] = [];

      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (isList(url, method)) {
          return pagedList(
            url,
            [],
            [
              activeInstance(orphanId, {
                name: `ac||${oldSec}|987654`,
                status: terminated.includes(orphanId) ? 'terminated' : 'active',
              }),
            ],
          );
        }
        if (url.endsWith('/instance-operations/terminate')) {
          const body = JSON.parse(String(init?.body ?? '{}'));
          terminated.push(...(body.instance_ids ?? []));
          return jsonResponse({
            data: { terminated_instances: [{ id: orphanId }] },
          });
        }
        if (url.includes(`/instances/${orphanId}`)) {
          return jsonResponse({
            data: activeInstance(orphanId, { status: 'terminated' }),
          });
        }
        return jsonResponse({ data: {} });
      });

      const result = await sweepLambda();
      expect(result.vmIds).toContain(orphanId);
      expect(terminated).toContain(orphanId);
    });

    it('adopts a tagged instance that is only on page 2', async () => {
      const acceptedId = '55555555-5555-5555-5555-555555555555';
      const accepted = activeInstance(acceptedId, {
        name: 'ac|u-1|1700000000|acc555',
        tags: lambdaTags('d-1'),
      });
      let launchCalls = 0;
      let firstPageReads = 0;

      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url.endsWith('/ssh-keys')) {
          return jsonResponse({ data: [{ id: 'k1', name: 'anycloud-api' }] });
        }
        if (isList(url, method)) {
          if (url.endsWith('/instances')) firstPageReads += 1;
          // Absent for the pre-launch sweep, then listed on page 2.
          return pagedList(url, [], firstPageReads >= 2 ? [accepted] : []);
        }
        if (url.endsWith('/instance-operations/launch')) {
          launchCalls += 1;
          return jsonResponse(
            { error: { code: 'HTTP 502', message: 'Bad Gateway' } },
            { ok: false, status: 502 },
          );
        }
        if (url.includes(`/instances/${acceptedId}`)) {
          return jsonResponse({ data: accepted });
        }
        return jsonResponse({ data: {} });
      });

      const vm = await makeLambda()
        .compute()
        .newVM(
          makeNewVMProps({
            startupScript: '#!/bin/bash\ntrue',
            ipWhitelist: [],
            vmId: 'vm-1',
            workloadId: 'd-1',
            version: '0.0.0-test',
            userId: 'u-1',
          }),
        );

      expect(vm.cloudId).toBe(acceptedId);
      expect(launchCalls).toBe(1);
    });

    it('keeps a VM present when only page 2 still lists it', async () => {
      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input);
        if (isList(url, init?.method ?? 'GET')) {
          return pagedList(
            url,
            [],
            [activeInstance('vm-1', { status: 'terminating' })],
          );
        }
        return jsonResponse({
          data: activeInstance('vm-1', { status: 'terminated' }),
        });
      });

      await expect(
        makeLambda().compute().observeVMReleaseOnce('vm-1'),
      ).resolves.toBe(VM_PRESENT);
    });

    it('fails when Lambda repeats a page token', async () => {
      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input);
        if (isList(url, init?.method ?? 'GET')) {
          return pagedList(url, [], [], 'p2');
        }
        return jsonResponse({ data: [] });
      });

      await expect(sweepLambda()).rejects.toThrow(
        /GET \/instances repeated a page token/,
      );
    });
  });

  describe('parseName (via resource sweep)', () => {
    // Name format: ac|{userId}|{timestamp}|{random}. The random suffix is
    // base36, so ~1 in 2,175 names end with 6 digits — parseName must not
    // confuse that suffix with the timestamp, or a fresh VM gets a 1970
    // createdAt and the sweeper tears it down as a 56-year-old orphan.
    it('uses the real timestamp when the random suffix is all digits', async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const terminated: string[] = [];

      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url.endsWith('/instances') && method === 'GET') {
          return jsonResponse({
            data: [
              // Orphan-eligible userId ('') + all-digit random suffix.
              // Real timestamp is "now", so VM must NOT be cleaned up.
              activeInstance('vm-fresh', {
                name: `ac||${nowSec}|123456`,
                status: 'active',
              }),
            ],
          });
        }
        if (
          url.endsWith('/instance-operations/terminate') &&
          method === 'POST'
        ) {
          const body = JSON.parse(String(init?.body ?? '{}'));
          terminated.push(...(body.instance_ids ?? []));
          return jsonResponse({ data: { terminated_instances: [] } });
        }
        return jsonResponse({ data: {} });
      });

      const result = await sweepLambda();
      expect(result.vmIds).toEqual([]);
      expect(terminated).toEqual([]);
    });

    it('still cleans up a genuinely old orphan with an all-digit suffix', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      // Sanity: the fix must not break the real orphan-cleanup path. Same
      // name shape, but with a timestamp well beyond the sweep minimum age.
      const oldSec = Math.floor(Date.now() / 1000) - 4 * 60 * 60; // 4h ago
      const orphanId = '11111111222233334444555555555555';
      const terminated: string[] = [];

      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url.endsWith('/instances') && method === 'GET') {
          return jsonResponse({
            data: [
              activeInstance(orphanId, {
                name: `ac||${oldSec}|987654`,
                status: terminated.includes(orphanId) ? 'terminated' : 'active',
              }),
            ],
          });
        }
        if (
          url.endsWith('/instance-operations/terminate') &&
          method === 'POST'
        ) {
          const body = JSON.parse(String(init?.body ?? '{}'));
          terminated.push(...(body.instance_ids ?? []));
          return jsonResponse({
            data: { terminated_instances: [{ id: orphanId }] },
          });
        }
        if (url.includes(`/instances/${orphanId}`) && method === 'GET') {
          return jsonResponse({
            data: activeInstance(orphanId, { status: 'terminated' }),
          });
        }
        return jsonResponse({ data: {} });
      });

      const result = await sweepLambda();
      expect(result.vmIds).toContain(orphanId);
      expect(terminated).toContain(orphanId);
    });
  });

  describe('resource sweep firewall rulesets', () => {
    it('deletes old unattached anycloud firewall rulesets', async () => {
      const oldCreated = new Date(
        Date.now() - 4 * 60 * 60 * 1000,
      ).toISOString();
      const deleted: string[] = [];

      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url.endsWith('/instances') && method === 'GET') {
          return jsonResponse({
            data: [activeInstance('vm-live', { name: null })],
          });
        }
        if (url.endsWith('/firewall-rulesets') && method === 'GET') {
          return jsonResponse({
            data: [
              {
                id: 'fw-old',
                name: 'anycloud-serve-old',
                region: { name: 'us-east-1', description: '' },
                rules: [],
                created: oldCreated,
                instance_ids: [],
              },
              {
                id: 'fw-attached',
                name: 'anycloud-serve-live',
                region: { name: 'us-east-1', description: '' },
                rules: [],
                created: oldCreated,
                instance_ids: ['vm-live'],
              },
              {
                id: 'fw-other',
                name: 'manual-ruleset',
                region: { name: 'us-east-1', description: '' },
                rules: [],
                created: oldCreated,
                instance_ids: [],
              },
            ],
          });
        }
        if (url.includes('/firewall-rulesets/') && method === 'DELETE') {
          deleted.push(url.split('/').pop()!);
          return jsonResponse({ data: {} });
        }
        return jsonResponse({ data: {} });
      });

      const result = await sweepLambda();

      expect(deleted).toEqual(['fw-old']);
      expect(result.otherResources).toEqual([
        { type: 'firewallRuleset', id: 'fw-old' },
      ]);
    });

    it('reports only confirmed orphan deletions and retains pending firewalls', async () => {
      // The pending instance burns the full termination-confirm budget here, so
      // fake timers advance across those simulated waits without a real delay.
      vi.useFakeTimers();
      const oldSec = Math.floor(Date.now() / 1000) - 4 * 60 * 60;
      const oldCreated = new Date(
        Date.now() - 4 * 60 * 60 * 1000,
      ).toISOString();
      const confirmedId = '11111111222233334444555555555555';
      const pendingId = 'aaaaaaaa222233334444555555555555';
      const deletedRulesets: string[] = [];
      const terminationRequested = new Set<string>();

      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url.endsWith('/instances') && method === 'GET') {
          return jsonResponse({
            data: [
              activeInstance(confirmedId, {
                name: `ac||${oldSec}|old111`,
                status: terminationRequested.has(confirmedId)
                  ? 'terminated'
                  : 'active',
              }),
              activeInstance(pendingId, {
                name: `ac||${oldSec}|old222`,
                status: 'terminating',
              }),
            ],
          });
        }
        if (
          url.endsWith('/instance-operations/terminate') &&
          method === 'POST'
        ) {
          const body = JSON.parse(String(init?.body ?? '{}'));
          const [id] = body.instance_ids ?? [];
          if (id) terminationRequested.add(id);
          return jsonResponse({
            data: { terminated_instances: id ? [{ id }] : [] },
          });
        }
        if (url.includes(`/instances/${confirmedId}`) && method === 'GET') {
          return jsonResponse({
            data: activeInstance(confirmedId, { status: 'terminated' }),
          });
        }
        if (url.includes(`/instances/${pendingId}`) && method === 'GET') {
          return jsonResponse({
            data: activeInstance(pendingId, { status: 'terminating' }),
          });
        }
        if (url.endsWith('/firewall-rulesets') && method === 'GET') {
          return jsonResponse({
            data: [
              {
                id: 'fw-confirmed',
                name: 'anycloud-confirmed',
                region: { name: 'us-east-1', description: '' },
                rules: [],
                created: oldCreated,
                instance_ids: [confirmedId],
              },
              {
                id: 'fw-pending',
                name: 'anycloud-pending',
                region: { name: 'us-east-1', description: '' },
                rules: [],
                created: oldCreated,
                instance_ids: [pendingId],
              },
            ],
          });
        }
        if (url.includes('/firewall-rulesets/') && method === 'DELETE') {
          deletedRulesets.push(url.split('/').pop()!);
          return jsonResponse({ data: {} });
        }
        return jsonResponse({ data: {} });
      });

      const result = await sweepLambda();

      expect(result.vmIds).toEqual([confirmedId]);
      expect(result.errors).toContainEqual({
        resourceType: 'vm',
        resourceId: pendingId,
        error: 'Lambda did not confirm instance termination',
      });
      expect(deletedRulesets).toEqual(['fw-confirmed']);
      expect(result.otherResources).toEqual([
        { type: 'firewallRuleset', id: 'fw-confirmed' },
      ]);
    });
  });

  describe('terminateVMs return contract', () => {
    // Lambda's API returns compact 32-hex IDs (rather than hyphenated UUIDs).
    // These must reach the terminate endpoint instead of being mistaken for
    // Anycloud's internal attempted VM names and silently marked as deleted.
    const realId = '11111111222233334444555555555555';
    const placeholder = 'deploy-x-0';

    it('returns real IDs and placeholders together on a successful batch', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse({
            data: { terminated_instances: [{ id: realId }] },
          }),
        )
        // Termination-status confirmation poll (cloud.ts) after the terminate call.
        .mockResolvedValueOnce(
          jsonResponse({
            data: activeInstance(realId, { status: 'terminated' }),
          }),
        )
        .mockResolvedValueOnce(jsonResponse({ data: [] }))
        .mockResolvedValueOnce(
          jsonResponse({
            data: activeInstance(realId, { status: 'terminated' }),
          }),
        )
        .mockResolvedValueOnce(jsonResponse({ data: [] }));
      const deleted = await makeLambda()
        .compute()
        .terminateVMs([realId, placeholder]);
      expect(deleted).toEqual([realId, placeholder]);
      expect(fetchMock).toHaveBeenCalledTimes(5);
      const [, init] = fetchMock.mock.calls[0]!;
      expect(JSON.parse(String(init?.body))).toEqual({
        instance_ids: [realId],
      });
    });

    it('keeps accepting hyphenated IDs from older persisted workloads', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const legacyId = '11111111-2222-3333-4444-555555555555';
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse({
            data: { terminated_instances: [{ id: legacyId }] },
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            data: activeInstance(legacyId, { status: 'terminated' }),
          }),
        )
        .mockResolvedValueOnce(jsonResponse({ data: [] }))
        .mockResolvedValueOnce(
          jsonResponse({
            data: activeInstance(legacyId, { status: 'terminated' }),
          }),
        )
        .mockResolvedValueOnce(jsonResponse({ data: [] }));

      await expect(
        makeLambda().compute().terminateVMs([legacyId]),
      ).resolves.toEqual([legacyId]);
      const [, init] = fetchMock.mock.calls[0]!;
      expect(JSON.parse(String(init?.body))).toEqual({
        instance_ids: [legacyId],
      });
    });

    it('treats object-does-not-exist as a successful delete', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const notFound = () =>
        jsonResponse(
          {
            error: {
              code: 'global/object-does-not-exist',
              message: 'Instance already terminated',
            },
          },
          { ok: false, status: 404 },
        );
      fetchMock
        .mockResolvedValueOnce(notFound())
        .mockResolvedValueOnce(notFound())
        .mockResolvedValueOnce(jsonResponse({ data: [] }))
        .mockResolvedValueOnce(notFound())
        .mockResolvedValueOnce(jsonResponse({ data: [] }));
      const deleted = await makeLambda()
        .compute()
        .terminateVMs([realId, placeholder]);
      expect(deleted).toEqual([realId, placeholder]);
    });

    it('does not treat a 200 response missing the requested ID as a successful delete', async () => {
      // Lambda can return ok:200 with an empty/partial terminated_instances
      // list (e.g. the instance was busy/locked) without raising an HTTP
      // error. Regression guard: a prior version of terminateVM() awaited
      // the API call but never inspected the body, so this response was
      // indistinguishable from a real success — the VM was marked deleted
      // and dropped from cleanup retries while still running in Lambda.
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          data: { terminated_instances: [] },
        }),
      );
      const deleted = await makeLambda()
        .compute()
        .terminateVMs([realId, placeholder]);
      expect(deleted).toEqual([placeholder]);
    });

    it('does not retire an instance while Lambda still reports terminating', async () => {
      // Fake timers let the mocked retryUntil advance through its confirmation
      // window without a real delay.
      vi.useFakeTimers();
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse({
            data: { terminated_instances: [{ id: realId }] },
          }),
        )
        .mockResolvedValue(
          jsonResponse({
            data: activeInstance(realId, { status: 'terminating' }),
          }),
        );

      const deleted = await makeLambda().compute().terminateVMs([realId]);

      expect(deleted).toEqual([]);
      // 1 terminate POST + 30 confirmation GETs. Lambda's terminate returns on
      // acknowledgement with no operation to poll, so this budget — not the
      // provider call — is what decides whether teardown finishes here or falls
      // to the cleanup lane, where the wait is billed as live VM time.
      expect(fetchMock).toHaveBeenCalledTimes(31);
    });

    it('returns only placeholders when a real-ID API call fails for another reason', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(
          {
            error: { code: 'global/transient', message: 'upstream blew up' },
          },
          { ok: false, status: 503 },
        ),
      );
      const deleted = await makeLambda()
        .compute()
        .terminateVMs([realId, placeholder]);
      expect(deleted).toEqual([placeholder]);
    });

    it('returns placeholders alone without calling the API when no real IDs are passed', async () => {
      const deleted = await makeLambda().compute().terminateVMs([placeholder]);
      expect(deleted).toEqual([placeholder]);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('Lambda candidate region filter', () => {
    const candidates: CandidateRegion[] = [
      { vmType: 'gpu_1x_a10', region: 'us-east-1' },
      { vmType: 'gpu_1x_a100', region: 'us-west-1' },
      { vmType: 'gpu_1x_h100', region: 'europe-central-1' },
    ];

    beforeEach(() => {
      resetLambdaCandidatePreflightCache();
      vi.mocked(sleep).mockClear();
    });

    it('exposes the candidate filter capability', () => {
      expect(canFilterCandidateRegions(makeLambda().compute())).toBe(true);
    });

    it('reorders confirmed-live candidates first, even when an unknown-ranked one starts earlier', async () => {
      // gpu_1x_a100 (index 1) is confirmed-live; gpu_1x_a10 (index 0,
      // earlier in input order) is unknown (absent from the live response)
      // and must NOT outrank it; gpu_1x_h100 (index 2) is
      // confirmed-unavailable (present, but not in this region).
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          data: {
            gpu_1x_a100: {
              instance_type: { name: 'gpu_1x_a100' },
              regions_with_capacity_available: [{ name: 'us-west-1' }],
            },
            gpu_1x_h100: {
              instance_type: { name: 'gpu_1x_h100' },
              regions_with_capacity_available: [{ name: 'us-east-1' }],
            },
          },
        }),
      );

      const filtered = await filterCandidateRegions(
        makeLambda(),
        candidates,
        false,
        'deploy-1',
      );

      expect(filtered).toEqual([
        { vmType: 'gpu_1x_a100', region: 'us-west-1' },
        { vmType: 'gpu_1x_a10', region: 'us-east-1' },
        { vmType: 'gpu_1x_h100', region: 'europe-central-1' },
      ]);
    });

    it('never reorders when no candidate is confirmed live, even with a mix of unknown and unavailable', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          data: {
            // gpu_1x_a10 and gpu_1x_a100 both absent from the response -> unknown.
            gpu_1x_h100: {
              instance_type: { name: 'gpu_1x_h100' },
              regions_with_capacity_available: [{ name: 'us-east-1' }], // not europe-central-1
            },
          },
        }),
      );

      const filtered = await filterCandidateRegions(
        makeLambda(),
        candidates,
        false,
        'deploy-2',
      );

      expect(filtered).toEqual(candidates);
    });

    it('never reorders when every candidate is confirmed unavailable', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          data: {
            gpu_1x_a10: {
              instance_type: { name: 'gpu_1x_a10' },
              regions_with_capacity_available: [],
            },
            gpu_1x_a100: {
              instance_type: { name: 'gpu_1x_a100' },
              regions_with_capacity_available: [],
            },
            gpu_1x_h100: {
              instance_type: { name: 'gpu_1x_h100' },
              regions_with_capacity_available: [],
            },
          },
        }),
      );

      const filtered = await filterCandidateRegions(
        makeLambda(),
        candidates,
        false,
        'deploy-3',
      );

      expect(filtered).toEqual(candidates);
    });

    it('ranks a malformed or missing regions_with_capacity_available as unknown, never throwing', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          data: {
            gpu_1x_a10: { instance_type: { name: 'gpu_1x_a10' } }, // field entirely absent
            gpu_1x_a100: {
              instance_type: { name: 'gpu_1x_a100' },
              regions_with_capacity_available: null,
            },
            gpu_1x_h100: {
              instance_type: { name: 'gpu_1x_h100' },
              regions_with_capacity_available: { not: 'an array' },
            },
          },
        }),
      );

      const filtered = await filterCandidateRegions(
        makeLambda(),
        candidates,
        false,
        'deploy-4',
      );

      // No confirmed-live candidate exists here, so order stays unchanged;
      // the point of this test is that none of the three malformed shapes
      // throw inside filterPreflight.
      expect(filtered).toEqual(candidates);
    });

    it('fails open on a preflight fetch failure, and is not sticky on the next attempt', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({}, { ok: false, status: 500 }),
      );

      const failedOpen = await filterCandidateRegions(
        makeLambda(),
        candidates,
        false,
        'deploy-5',
      );
      expect(failedOpen).toEqual(candidates);
      expect(logMock.warn).toHaveBeenCalledWith(
        expect.stringMatching(/candidate availability snapshot failed/i),
        expect.anything(),
      );

      // Next resolution attempt is a fresh call, not a cached failure —
      // memoizeAsyncTtl deletes a rejected sweep's cache entry immediately
      // rather than caching it for the 60s TTL.
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          data: {
            gpu_1x_a100: {
              instance_type: { name: 'gpu_1x_a100' },
              regions_with_capacity_available: [{ name: 'us-west-1' }],
            },
          },
        }),
      );
      const succeeded = await filterCandidateRegions(
        makeLambda(),
        candidates,
        false,
        'deploy-6',
      );
      expect(succeeded[0]).toEqual({
        vmType: 'gpu_1x_a100',
        region: 'us-west-1',
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('shares the account-wide inventory across different candidate shapes', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          data: {
            gpu_1x_a10: {
              instance_type: { name: 'gpu_1x_a10' },
              regions_with_capacity_available: [{ name: 'us-east-1' }],
            },
            gpu_1x_h100: {
              instance_type: { name: 'gpu_1x_h100' },
              regions_with_capacity_available: [{ name: 'europe-central-1' }],
            },
          },
        }),
      );

      const firstCandidates = [{ vmType: 'gpu_1x_a10', region: 'us-east-1' }];
      await expect(
        filterCandidateRegions(
          makeLambda(),
          firstCandidates,
          false,
          'deploy-shape-a',
        ),
      ).resolves.toEqual(firstCandidates);

      const secondCandidates = [
        { vmType: 'gpu_1x_a100', region: 'us-west-1' },
        { vmType: 'gpu_1x_h100', region: 'europe-central-1' },
      ];
      await expect(
        filterCandidateRegions(
          makeLambda(),
          secondCandidates,
          false,
          'deploy-shape-b',
        ),
      ).resolves.toEqual([
        { vmType: 'gpu_1x_h100', region: 'europe-central-1' },
        { vmType: 'gpu_1x_a100', region: 'us-west-1' },
      ]);

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('does not extend inventory freshness when a new shape is assessed near expiry', async () => {
      vi.useFakeTimers();
      fetchMock.mockResolvedValue(
        jsonResponse({
          data: {
            gpu_1x_a10: {
              instance_type: { name: 'gpu_1x_a10' },
              regions_with_capacity_available: [{ name: 'us-east-1' }],
            },
            gpu_1x_h100: {
              instance_type: { name: 'gpu_1x_h100' },
              regions_with_capacity_available: [{ name: 'europe-central-1' }],
            },
          },
        }),
      );

      await filterCandidateRegions(
        makeLambda(),
        [{ vmType: 'gpu_1x_a10', region: 'us-east-1' }],
        false,
        'deploy-inventory-start',
      );

      await vi.advanceTimersByTimeAsync(59_999);

      const laterShape = [
        { vmType: 'gpu_1x_h100', region: 'europe-central-1' },
      ];
      await filterCandidateRegions(
        makeLambda(),
        laterShape,
        false,
        'deploy-inventory-near-expiry',
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(2);

      await filterCandidateRegions(
        makeLambda(),
        laterShape,
        false,
        'deploy-inventory-after-expiry',
      );
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('keeps shared inventory alive when one shape probe expires', async () => {
      vi.useFakeTimers();
      let releaseInventory!: () => void;
      const inventoryResponse = new Promise<Response>((resolve) => {
        releaseInventory = () =>
          resolve(
            jsonResponse({
              data: {
                gpu_1x_a10: {
                  instance_type: { name: 'gpu_1x_a10' },
                  regions_with_capacity_available: [{ name: 'us-east-1' }],
                },
                gpu_1x_h100: {
                  instance_type: { name: 'gpu_1x_h100' },
                  regions_with_capacity_available: [
                    { name: 'europe-central-1' },
                  ],
                },
              },
            }),
          );
      });
      fetchMock.mockReturnValue(inventoryResponse);

      const firstCandidates = [{ vmType: 'gpu_1x_a10', region: 'us-east-1' }];
      const first = filterCandidateRegions(
        makeLambda(),
        firstCandidates,
        false,
        'deploy-expiring-shape',
        { deadlineAt: Date.now() + 30_000 },
      );
      await vi.advanceTimersByTimeAsync(20_000);

      const secondCandidates = [
        { vmType: 'gpu_1x_h100', region: 'europe-central-1' },
      ];
      const second = filterCandidateRegions(
        makeLambda(),
        secondCandidates,
        false,
        'deploy-surviving-shape',
        { deadlineAt: Date.now() + 30_000 },
      );
      let secondSettled = false;
      void second.then(() => {
        secondSettled = true;
      });

      await vi.advanceTimersByTimeAsync(8_001);

      await expect(first).resolves.toEqual(firstCandidates);
      expect(secondSettled).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const rawFetchSignal = fetchMock.mock.calls[0]?.[1]?.signal;
      expect(rawFetchSignal?.aborted).toBe(false);

      releaseInventory();
      await vi.advanceTimersByTimeAsync(0);

      await expect(second).resolves.toEqual(secondCandidates);
    });

    it('scopes the preflight cache by credential', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ data: {} }));
      const lambdaA = makeLambda({ credentials: { apiKey: 'key-a' } });
      await filterCandidateRegions(lambdaA, candidates, false, 'deploy-a1');
      await filterCandidateRegions(lambdaA, candidates, false, 'deploy-a2');
      expect(fetchMock).toHaveBeenCalledTimes(1); // shared cache, same credential

      fetchMock.mockResolvedValueOnce(jsonResponse({ data: {} }));
      const lambdaB = makeLambda({ credentials: { apiKey: 'key-b' } });
      await filterCandidateRegions(lambdaB, candidates, false, 'deploy-b1');
      expect(fetchMock).toHaveBeenCalledTimes(2); // separate cache entry
    });
  });

  describe('Lambda HTTP 429 retry', () => {
    beforeEach(() => {
      vi.mocked(sleep).mockClear();
    });

    it('retries non-JSON 429s with bounded exponential jitter and one recovery summary', async () => {
      const random = vi
        .spyOn(Math, 'random')
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(1);
      fetchMock
        .mockResolvedValueOnce(unparseableResponse({ status: 429 }))
        .mockResolvedValueOnce(unparseableResponse({ status: 429 }))
        .mockResolvedValueOnce(jsonResponse({ data: {} }));

      await expect(
        makeLambda().compute().validateCredentials(),
      ).resolves.toBeUndefined();

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(vi.mocked(sleep).mock.calls.map(([waitMs]) => waitMs)).toEqual([
        LAMBDA_429_RETRY_BASE_MS * 0.5,
        LAMBDA_429_RETRY_BASE_MS * 2,
      ]);
      expect(logMock.warn).not.toHaveBeenCalled();
      expect(logMock.info).toHaveBeenCalledWith(
        'Lambda request recovered after HTTP 429',
        expect.objectContaining({
          path: '/ssh-keys',
          retryCount: 2,
          providerCode: 'HTTP 429',
        }),
      );
      expect(logMock.debug).toHaveBeenCalledTimes(2);
      random.mockRestore();
    });

    it('retries a provider JSON 429 regardless of its provider code', async () => {
      const random = vi.spyOn(Math, 'random').mockReturnValue(0);
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse(
            {
              error: {
                code: 'global/quota-exceeded',
                message: 'Quota exceeded',
              },
            },
            { ok: false, status: 429 },
          ),
        )
        .mockResolvedValueOnce(jsonResponse({ data: {} }));

      await expect(
        makeLambda().compute().validateCredentials(),
      ).resolves.toBeUndefined();

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(vi.mocked(sleep).mock.calls.map(([waitMs]) => waitMs)).toEqual([
        LAMBDA_429_RETRY_BASE_MS * 0.5,
      ]);
      expect(logMock.info).toHaveBeenCalledWith(
        'Lambda request recovered after HTTP 429',
        expect.objectContaining({
          retryCount: 1,
          providerCode: 'global/quota-exceeded',
        }),
      );
      random.mockRestore();
    });

    it('does not retry a quota response whose HTTP status is 400', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              code: 'global/quota-exceeded',
              message: 'Quota exceeded',
            },
          },
          { ok: false, status: 400 },
        ),
      );
      const lambda = makeLambda();
      const error = await lambda
        .compute()
        .validateCredentials()
        .catch((caught: unknown) => caught);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
      expect(lambda.compute().classifyError(error)).toBe(
        CloudFailureDiagnosis.QuotaExhaustedAccount,
      );
    });

    it('preserves a structured provider code after exhausting all 429 attempts', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(
          {
            error: {
              code: 'global/quota-exceeded',
              message: 'Quota exceeded',
            },
          },
          { ok: false, status: 429 },
        ),
      );
      const lambda = makeLambda();
      const error = await lambda
        .compute()
        .validateCredentials()
        .catch((caught: unknown) => caught);

      expect(fetchMock).toHaveBeenCalledTimes(LAMBDA_429_RETRY_MAX_ATTEMPTS);
      expect(error).toMatchObject({ statusCode: 429 });
      expect(lambda.compute().classifyError(error)).toBe(
        CloudFailureDiagnosis.QuotaExhaustedAccount,
      );
      expect(logMock.warn).toHaveBeenCalledTimes(1);
      expect(logMock.warn).toHaveBeenCalledWith(
        'Lambda HTTP 429 retry budget exhausted',
        expect.objectContaining({
          attempts: LAMBDA_429_RETRY_MAX_ATTEMPTS,
          providerCode: 'global/quota-exceeded',
        }),
      );
    });

    it('does not multiply an exhausted launch 429 through the launch retry loop', async () => {
      let launchCalls = 0;
      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url.endsWith('/ssh-keys') && method === 'GET') {
          return jsonResponse({
            data: [{ id: 'k1', name: 'anycloud-api' }],
          });
        }
        if (url.endsWith('/instances') && method === 'GET') {
          return emptyInstancesResponse();
        }
        if (url.endsWith('/instance-operations/launch') && method === 'POST') {
          launchCalls += 1;
          return unparseableResponse({ status: 429 });
        }
        throw new Error(`Unexpected Lambda request: ${method} ${url}`);
      });

      await expect(
        makeLambda()
          .compute()
          .newVM(
            makeNewVMProps({
              vmId: 'vm-1',
              workloadId: 'd-1',
              userId: 'u-1',
            }),
          ),
      ).rejects.toThrow(/HTTP 429/);

      expect(launchCalls).toBe(LAMBDA_429_RETRY_MAX_ATTEMPTS);
      expect(logMock.warn).toHaveBeenCalledTimes(1);
    });

    it('bounds the complete 429 retry owner to one provisioning window', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      useTimedSleepMock();
      vi.spyOn(Math, 'random').mockReturnValue(1);
      let launchCalls = 0;
      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url.endsWith('/ssh-keys') && method === 'GET') {
          return jsonResponse({ data: [{ id: 'k1', name: 'anycloud-api' }] });
        }
        if (url.endsWith('/instances') && method === 'GET') {
          return emptyInstancesResponse();
        }
        if (url.endsWith('/instance-operations/launch') && method === 'POST') {
          launchCalls += 1;
          await new Promise((resolve) => setTimeout(resolve, 29_000));
          return unparseableResponse({ status: 429 });
        }
        throw new Error(`Unexpected Lambda request: ${method} ${url}`);
      });
      let settledAt: number | undefined;
      const result = makeLambda()
        .compute()
        .newVM(
          makeNewVMProps({
            vmId: 'vm-1',
            workloadId: 'd-1',
            userId: 'u-1',
          }),
        )
        .catch((error: unknown) => error)
        .finally(() => {
          settledAt = Date.now();
        });

      await vi.advanceTimersByTimeAsync(PROVISIONING_TIMEOUT_MS + 1);
      const settledWithinBudget = settledAt;
      if (settledAt === undefined) await vi.runAllTimersAsync();
      const error = await result;
      vi.mocked(sleep).mockResolvedValue(undefined);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/HTTP 429/);
      expect(settledWithinBudget).toBeDefined();
      expect(settledWithinBudget).toBeLessThanOrEqual(
        PROVISIONING_TIMEOUT_MS + 1,
      );
      expect(launchCalls).toBeLessThan(LAMBDA_429_RETRY_MAX_ATTEMPTS);
    });

    it('reconciles an in-flight launch abort instead of relabeling it as a prior 429', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      useTimedSleepMock();
      vi.spyOn(Math, 'random').mockReturnValue(1);
      const acceptedId = '99999999-8888-7777-6666-555555555555';
      const terminated: string[] = [];
      let launchCalls = 0;

      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url.endsWith('/ssh-keys') && method === 'GET') {
          return jsonResponse({ data: [{ id: 'k1', name: 'anycloud-api' }] });
        }
        if (url.endsWith('/instances') && method === 'GET') {
          return jsonResponse({
            data:
              launchCalls >= 10 && !terminated.includes(acceptedId)
                ? [
                    activeInstance(acceptedId, {
                      name: 'ac|u-1|1700000000|accepted',
                      tags: lambdaTags('d-1'),
                    }),
                  ]
                : [],
          });
        }
        if (url.endsWith('/instance-operations/launch') && method === 'POST') {
          launchCalls += 1;
          // Put the retry-budget boundary inside attempt ten: eight slow 429s,
          // one immediate 429, then an accepted request whose response is lost.
          if (launchCalls <= 8) {
            await new Promise((resolve) => setTimeout(resolve, 29_000));
            return unparseableResponse({ status: 429 });
          }
          if (launchCalls === 9) {
            return unparseableResponse({ status: 429 });
          }
          await new Promise<never>((_resolve, reject) => {
            const signal = init?.signal;
            const abort = () =>
              reject(
                signal?.reason instanceof Error
                  ? signal.reason
                  : new DOMException('The operation was aborted', 'AbortError'),
              );
            if (signal?.aborted) abort();
            else signal?.addEventListener('abort', abort, { once: true });
          });
        }
        if (
          url.endsWith('/instance-operations/terminate') &&
          method === 'POST'
        ) {
          const body = JSON.parse(String(init?.body ?? '{}'));
          terminated.push(...(body.instance_ids ?? []));
          return jsonResponse({
            data: { terminated_instances: [{ id: acceptedId }] },
          });
        }
        if (url.endsWith(`/instances/${acceptedId}`)) {
          return jsonResponse({
            data: activeInstance(acceptedId, {
              status: terminated.includes(acceptedId) ? 'terminated' : 'active',
              tags: lambdaTags('d-1'),
            }),
          });
        }
        throw new Error(`Unexpected Lambda request: ${method} ${url}`);
      });

      const result = makeLambda()
        .compute()
        .newVM(
          makeNewVMProps({
            vmId: 'vm-1',
            workloadId: 'd-1',
            userId: 'u-1',
          }),
        )
        .catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(PROVISIONING_TIMEOUT_MS + 1);
      const outcome = await result;
      vi.mocked(sleep).mockResolvedValue(undefined);

      expect(outcome).not.toBeInstanceOf(Error);
      expect((outcome as { cloudId: string }).cloudId).toBe(acceptedId);
      expect(launchCalls).toBe(10);
      expect(terminated).toEqual([]);
    });

    it('does not delay successful consecutive requests', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ data: {} }))
        .mockResolvedValueOnce(jsonResponse({ data: {} }));

      const lambda = makeLambda();
      await lambda.compute().validateCredentials();
      await lambda.compute().validateCredentials();

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(sleep).not.toHaveBeenCalled();
    });
  });
});

import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, onTestFinished, test, vi } from 'vitest';
import { parse } from 'yaml';

import {
  auditServiceScope,
  assertServiceAuditProfile,
  parseServiceAuditSelection,
  runServiceResourcesAudit,
} from '../../../ci/cleanup/service-resources-audit.js';
import { CloudType } from '../../../src/shared/cloud.js';
import {
  ArtifactStore,
  Redactor,
} from '../../integration/e2e/internal/artifacts.js';
import { Environment } from '../../integration/e2e/internal/environment.js';
import { FixtureFiles } from '../../integration/e2e/internal/files.js';
import { ProcessRunner } from '../../integration/e2e/internal/process.js';
import {
  ProviderProfiles,
  type VmProfile,
} from '../../integration/e2e/internal/profiles.js';
import { TargetHttpClient } from '../../integration/e2e/internal/transports/http.js';
import {
  PublicCloudVmHostPresenceProbe,
  type VmReservationPresenceObservation,
} from '../../integration/e2e/internal/transports/public-cloud-vm-host-presence.js';
import { ServiceDnsProbe } from '../../integration/e2e/internal/transports/service-dns.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const scope = {
  provider: 'aws',
  workloadId: 'd-gpu-owned',
  originalDnsRecordId: 'a'.repeat(32),
  originalProfileRowId: 'original-profile-row',
  hosts: [
    {
      cloudId: 'i-0123456789abcdef0',
      region: 'us-east-2',
      availabilityZone: '2c',
    },
  ],
  reservations: [
    { cloudId: 'd-gpu-owned-0', region: 'us-east-1', availabilityZone: null },
  ],
};
const manifest = {
  version: 1,
  originalSourceSha: 'b'.repeat(40),
  originalRunId: '35556076947',
  scopes: [scope],
};
const LAMBDA_KEY = 'lambda-audit-synthetic-key';
const LAMBDA_PROFILE_ROW =
  'c920c2a71f277a041b4cd915f05942a052686822450758f58cab11acec328d9f';
const lambdaScope = {
  ...scope,
  provider: 'lambda',
  originalProfileRowId: LAMBDA_PROFILE_ROW,
  hosts: [
    { cloudId: '1'.repeat(32), region: 'us-east-1', availabilityZone: null },
  ],
  reservations: [],
};

function harness() {
  let now = 1_000;
  const controller = new AbortController();
  const snapshots: unknown[] = [];
  const native = {
    observe: vi
      .fn<Parameters<typeof auditServiceScope>[1]['native']['observe']>()
      .mockImplementation(async (location) => ({
        cloudId: location.cloudId,
        provider: CloudType.AWS,
        presence: 'absent',
        diagnostic: 'exact native identity absent',
      })),
    observeReservations: vi
      .fn<
        Parameters<typeof auditServiceScope>[1]['native']['observeReservations']
      >()
      .mockImplementation(async (attempts) => ({
        kind: 'exact-attempt-current-presence',
        credentialName: 'aws-test',
        observedAt: now,
        provider: CloudType.AWS,
        diagnostic: 'complete token inventory',
        inventory: { pages: 1, instances: 0, complete: true },
        attempts: attempts.map((attempt) => ({
          attemptId: attempt.cloudId,
          region: attempt.region,
          availabilityZone: attempt.availabilityZone,
          instanceIds: [],
          presence: now >= 11_000 ? 'absent' : 'unknown',
        })),
      })),
  };
  const dns = {
    observe: vi
      .fn<Parameters<typeof auditServiceScope>[1]['dns']['observe']>()
      .mockImplementation(async (hostname) => ({
        hostname,
        authorities: ['one.authority', 'two.authority'],
        answers: [
          {
            authority: 'one.authority',
            address: '192.0.2.1',
            presence: 'absent',
            diagnostic: 'ENOTFOUND',
          },
          {
            authority: 'two.authority',
            address: '192.0.2.2',
            presence: 'absent',
            diagnostic: 'ENOTFOUND',
          },
        ],
      })),
  };
  const ports: Parameters<typeof auditServiceScope>[1] = {
    native,
    dns,
    signal: controller.signal,
    now: () => now,
    wait: vi.fn(async (milliseconds) => {
      now += milliseconds;
    }),
    retain: vi.fn(async (record) => {
      snapshots.push(structuredClone(record));
    }),
  };
  return {
    native,
    dns,
    ports,
    controller,
    snapshots,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

async function lambdaHarness(key = LAMBDA_KEY) {
  const h = harness();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(h.ports.now());
  const directory = await mkdtemp(path.join(tmpdir(), 'lambda-service-audit-'));
  onTestFinished(() => rm(directory, { force: true, recursive: true }));
  const redactor = new Redactor();
  const profile = new ProviderProfiles(
    new Environment({ LAMBDA_API_KEY: key }, redactor),
  ).gpuServe('lambda');
  const artifacts = new ArtifactStore(directory, redactor);
  const http = new TargetHttpClient(artifacts, redactor, h.controller.signal);
  const httpGet = vi.spyOn(http, 'get');
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(async (url) =>
      String(url).endsWith('/instances')
        ? Response.json({ data: [] })
        : Response.json(
            {
              error: {
                code: 'global/object-does-not-exist',
                message: 'Instance does not exist',
              },
            },
            { status: 404 },
          ),
    );
  vi.stubGlobal('fetch', fetch);
  const commands = {
    run: vi
      .fn<ProcessRunner['run']>()
      .mockRejectedValue(new Error('Unexpected provider CLI')),
  };
  const native = new PublicCloudVmHostPresenceProbe(
    profile,
    commands,
    new FixtureFiles(directory),
    http,
  );
  let snapshot = 0;
  const ports: Parameters<typeof auditServiceScope>[1] = {
    ...h.ports,
    profile,
    native,
    wait: async (milliseconds) => {
      await h.ports.wait(milliseconds);
      vi.setSystemTime(h.ports.now());
    },
    retain: async (record) => {
      await h.ports.retain(record);
      await artifacts.json(`scope-${++snapshot}`, record);
    },
  };
  return {
    ...h,
    ports,
    profile,
    fetch,
    httpGet,
    http,
    commands,
    directory,
    artifactsText: async () =>
      (
        await Promise.all(
          (await readdir(directory)).map((name) =>
            readFile(path.join(directory, name), 'utf8'),
          ),
        )
      ).join('\n'),
  };
}

describe('scoped read-only Service resource reconciliation', () => {
  test('binds both passes to the historical coordinates and retains uncertainty before current absence', async () => {
    const h = harness();
    const record = await auditServiceScope(scope, h.ports);
    expect(record.externalResourcesAbsent).toBe(true);
    expect(record.historicalOutcome).toBe('unchanged');
    expect(record.persistedWorkloadState).toContain('not observed');
    expect(h.native.observe.mock.calls.map(([location]) => location)).toEqual([
      scope.hosts[0],
      scope.hosts[0],
    ]);
    expect(
      h.native.observeReservations.mock.calls.map(([locations]) => locations),
    ).toEqual([scope.reservations, scope.reservations]);
    expect(h.native.observe.mock.calls[0]?.[1]).toMatchObject({
      signal: h.controller.signal,
      deadlineAt: 121_000,
    });
    expect(h.ports.wait).toHaveBeenCalledExactlyOnceWith(10_000);
    expect(
      record.reservations.map(
        ({ observation }) => observation.attempts[0]?.presence,
      ),
    ).toEqual(['unknown', 'absent']);
    expect(h.dns.observe).toHaveBeenCalledTimes(2);
    expect(h.dns.observe.mock.calls[0]?.[0]).toBe('d-gpu-owned.anycloud.sh');
    expect(h.snapshots[0]).toMatchObject({
      native: [],
      reservations: [],
      dns: [],
      externalResourcesAbsent: false,
    });
    expect(h.snapshots.at(-1)).toMatchObject({ externalResourcesAbsent: true });
  });

  test('validates every manifest scope before provider selection and rejects provisioning combinations', () => {
    expect(parseServiceAuditSelection(manifest, 'aws').scopes).toHaveLength(1);
    for (const provider of ['all', 'azure', 'aws; echo unsafe'])
      expect(() => parseServiceAuditSelection(manifest, provider)).toThrow();
    expect(() => parseServiceAuditSelection(manifest, 'aws', 'true')).toThrow(
      'provisioning modes',
    );
    expect(() =>
      parseServiceAuditSelection(manifest, 'aws', 'false', 'true'),
    ).toThrow('provisioning modes');
    expect(() =>
      parseServiceAuditSelection(
        {
          ...manifest,
          scopes: [scope, { provider: 'gcp', command: 'create' }],
        },
        'aws',
      ),
    ).toThrow();
    expect(() =>
      parseServiceAuditSelection(
        { ...manifest, scopes: Array(6).fill(scope) },
        'aws',
      ),
    ).toThrow();
    expect(() =>
      parseServiceAuditSelection(
        { ...manifest, scopes: [scope, scope] },
        'aws',
      ),
    ).toThrow('distinct Workloads');
  });

  test.each([
    {
      ...scope,
      reservations: [
        { ...scope.reservations[0], cloudId: 'another-workload-0' },
      ],
    },
    { ...scope, hosts: [{ ...scope.hosts[0], cloudId: '*' }] },
    { ...scope, hosts: [{ ...scope.hosts[0], region: 'us-east-1' }] },
    { ...scope, workloadId: 'trailing-' },
    { ...scope, provider: 'gcp' },
  ])(
    'rejects an invalid exact scope before native or DNS reads: %j',
    async (invalid) => {
      const h = harness();
      await expect(auditServiceScope(invalid, h.ports)).rejects.toThrow();
      expect(h.native.observe).not.toHaveBeenCalled();
      expect(h.native.observeReservations).not.toHaveBeenCalled();
      expect(h.dns.observe).not.toHaveBeenCalled();
    },
  );

  test.each([
    'native present',
    'native unknown',
    'DNS present',
    'reservation unknown',
  ] as const)('does not certify external cleanup with %s', async (failure) => {
    const h = harness();
    if (failure.startsWith('native'))
      h.native.observe.mockResolvedValue({
        cloudId: scope.hosts[0]!.cloudId,
        provider: CloudType.AWS,
        presence: failure === 'native present' ? 'present' : 'unknown',
        diagnostic: failure,
      });
    if (failure === 'DNS present')
      h.dns.observe.mockResolvedValue({
        hostname: 'd-gpu-owned.anycloud.sh',
        authorities: ['one.authority'],
        answers: [
          {
            authority: 'one.authority',
            address: '192.0.2.1',
            presence: 'present',
            diagnostic: 'A 203.0.113.2',
          },
        ],
      });
    if (failure === 'reservation unknown')
      h.native.observeReservations.mockImplementation(async () => ({
        kind: 'exact-attempt-current-presence',
        credentialName: 'aws-test',
        observedAt: h.ports.now(),
        provider: CloudType.AWS,
        diagnostic: 'incomplete',
        inventory: null,
        attempts: [
          {
            attemptId: 'd-gpu-owned-0',
            region: 'us-east-1',
            availabilityZone: null,
            presence: 'unknown',
            instanceIds: [],
          },
        ],
      }));
    expect(
      (await auditServiceScope(scope, h.ports)).externalResourcesAbsent,
    ).toBe(false);
    expect(h.snapshots.at(-1)).toMatchObject({
      externalResourcesAbsent: false,
    });
  });

  test('keeps validated partial discoveries when a later token page fails', async () => {
    const h = harness();
    h.native.observeReservations.mockImplementation(
      async (_attempts, options) => {
        const observation: VmReservationPresenceObservation = {
          kind: 'exact-attempt-current-presence',
          credentialName: 'aws-test',
          observedAt: h.ports.now(),
          provider: CloudType.AWS,
          diagnostic: 'partial validated page',
          inventory: { pages: 1, instances: 1, complete: false },
          attempts: [
            {
              attemptId: 'd-gpu-owned-0',
              region: 'us-east-1',
              availabilityZone: null,
              presence: 'present',
              instanceIds: ['i-fedcba98765432100'],
            },
          ],
        };
        options?.onPartialObservation?.(observation);
        throw new Error('later page unavailable');
      },
    );
    const record = await auditServiceScope(scope, h.ports);
    expect(record.externalResourcesAbsent).toBe(false);
    expect(record.reservations).toHaveLength(2);
    expect(
      record.reservations[1]?.observation.attempts[0]?.instanceIds,
    ).toEqual(['i-fedcba98765432100']);
    expect(record.failures).toEqual([
      { round: 1, operation: 'reservation', message: 'later page unavailable' },
      { round: 2, operation: 'reservation', message: 'later page unavailable' },
    ]);
  });

  test('does not extend the declared deadline for its stability wait', async () => {
    const h = harness();
    h.dns.observe.mockImplementation(async (hostname) => {
      h.advance(115_000);
      return {
        hostname,
        authorities: ['one.authority'],
        answers: [
          {
            authority: 'one.authority',
            address: '192.0.2.1',
            presence: 'absent',
            diagnostic: 'ENOTFOUND',
          },
        ],
      };
    });
    const record = await auditServiceScope(scope, h.ports);
    expect(record.failures).toEqual([
      {
        round: 2,
        operation: 'budget',
        message: 'Service audit has no remaining stability window',
      },
    ]);
    expect(record.completedAt).toBe(116_000);
    expect(h.ports.wait).not.toHaveBeenCalled();
    expect(h.snapshots.at(-1)).toMatchObject({
      externalResourcesAbsent: false,
    });
  });

  test('failed artifact retention stops observation before any provider request', async () => {
    const h = harness();
    const ports = {
      ...h.ports,
      retain: vi.fn().mockRejectedValue(new Error('artifact disk unavailable')),
    };
    await expect(auditServiceScope(scope, ports)).rejects.toThrow(
      'artifact disk unavailable',
    );
    expect(h.native.observe).not.toHaveBeenCalled();
    expect(h.dns.observe).not.toHaveBeenCalled();
  });

  test('observes the exact GCP host and its authorities without AWS reservations', async () => {
    const h = harness();
    const gcpScope = {
      ...scope,
      provider: 'gcp',
      hosts: [
        { cloudId: 'd-gpu-owned-0', region: 'us-east4', availabilityZone: 'a' },
      ],
      reservations: [],
    };
    h.native.observe.mockImplementation(async (location) => ({
      cloudId: location.cloudId,
      provider: CloudType.GCP,
      presence: 'absent',
      diagnostic: 'exact instance NOT_FOUND',
    }));
    const record = await auditServiceScope(gcpScope, h.ports);
    expect(record.externalResourcesAbsent).toBe(true);
    expect(h.native.observe.mock.calls.map(([location]) => location)).toEqual([
      gcpScope.hosts[0],
      gcpScope.hosts[0],
    ]);
    expect(h.native.observeReservations).not.toHaveBeenCalled();
  });

  test.each([
    'missing authority',
    'foreign hostname',
    'duplicate authority',
    'unknown answer',
  ] as const)('cannot accept DNS absence with %s', async (failure) => {
    const h = harness();
    const observe = h.dns.observe.getMockImplementation()!;
    h.dns.observe.mockImplementation(async (hostname, deadlineAt) => {
      const observation = await observe(hostname, deadlineAt);
      if (failure === 'foreign hostname')
        return { ...observation, hostname: 'foreign.anycloud.sh' };
      if (failure === 'missing authority')
        return { ...observation, answers: observation.answers.slice(1) };
      if (failure === 'duplicate authority')
        return {
          ...observation,
          authorities: ['one.authority', 'one.authority'],
        };
      return {
        ...observation,
        answers: observation.answers.map((answer) => ({
          ...answer,
          presence: 'unknown' as const,
        })),
      };
    });
    const record = await auditServiceScope(scope, h.ports);
    expect(record.externalResourcesAbsent).toBe(false);
    expect(h.snapshots.at(-1)).toMatchObject({
      externalResourcesAbsent: false,
    });
  });

  test('retains cancellation and performs no native or DNS calls after it', async () => {
    const h = harness();
    h.controller.abort(new Error('audit cancelled'));
    const record = await auditServiceScope(scope, h.ports);
    expect(record.externalResourcesAbsent).toBe(false);
    expect(record.failures).toEqual([
      { round: 1, operation: 'budget', message: 'audit cancelled' },
    ]);
    expect(h.native.observe).not.toHaveBeenCalled();
    expect(h.native.observeReservations).not.toHaveBeenCalled();
    expect(h.dns.observe).not.toHaveBeenCalled();
    expect(h.snapshots.at(-1)).toMatchObject({ failures: record.failures });
  });

  test('late final DNS answers do not certify absence after the original deadline', async () => {
    const h = harness();
    const observe = h.dns.observe.getMockImplementation()!;
    h.dns.observe.mockImplementation(async (hostname, deadlineAt) => {
      const observation = await observe(hostname, deadlineAt);
      if (h.ports.now() >= 11_000) h.advance(120_000);
      return observation;
    });
    const record = await auditServiceScope(scope, h.ports);
    expect(record.dns).toHaveLength(2);
    expect(record.externalResourcesAbsent).toBe(false);
    expect(record.failures).toEqual([
      { round: 2, operation: 'dns', message: 'Service audit deadline expired' },
    ]);
  });

  test('a later artifact failure preserves earlier snapshots and rejects the audit', async () => {
    const h = harness();
    const retain = h.ports.retain;
    let writes = 0;
    const ports = {
      ...h.ports,
      retain: async (record: unknown) => {
        writes++;
        if (writes === 3) throw new Error('artifact disk failed');
        await retain(record);
      },
    };
    await expect(auditServiceScope(scope, ports)).rejects.toThrow(
      'artifact disk failed',
    );
    expect(h.snapshots).toHaveLength(2);
    expect(h.snapshots.at(-1)).toMatchObject({
      native: [{ observation: { presence: 'absent' } }],
      externalResourcesAbsent: false,
    });
    expect(h.dns.observe).not.toHaveBeenCalled();
  });

  test('the exclusive workflow path cannot start a provisioning or sweep job', async () => {
    const workflow = parse(
      await readFile('.github/workflows/e2e-gpu.yml', 'utf8'),
    ) as {
      jobs: Record<
        string,
        {
          if: string;
          needs?: string[];
          concurrency?: Record<string, unknown>;
          env?: Record<string, unknown>;
          'timeout-minutes'?: number;
          steps: {
            run?: string;
            uses?: string;
            with?: Record<string, unknown>;
          }[];
        }
      >;
    };
    for (const name of [
      'e2e-gpu-serve-vitest',
      'e2e-mace-vitest',
      'e2e-disk-tier-vitest',
      'post-cleanup-aws',
      'post-cleanup-azure',
      'post-cleanup-gcp',
      'post-cleanup-lambda',
    ])
      expect(workflow.jobs[name]?.if).toContain(
        '!inputs.service_cleanup_audit',
      );
    const audit = workflow.jobs['service-native-audit']!;
    expect(audit.needs).toBeUndefined();
    expect(audit['timeout-minutes']).toBe(10);
    expect(audit.env?.LAMBDA_API_KEY).toBe(
      "${{ inputs.provider == 'lambda' && secrets.LAMBDA_API_KEY || '' }}",
    );
    expect(audit.concurrency).toEqual({
      group: 'e2e-gpu-qualification-${{ inputs.provider }}',
      queue: 'max',
      'cancel-in-progress': false,
    });
    expect(
      audit.steps.some((step) => step.run === 'yarn audit:service-cleanup'),
    ).toBe(true);
    expect(
      audit.steps.some((step) => step.uses?.includes('serve-e2e-setup')),
    ).toBe(false);
    expect(
      audit.steps.find((step) => step.uses?.includes('upload-artifact'))?.with,
    ).toMatchObject({ 'retention-days': 30, 'if-no-files-found': 'error' });
  });
});

describe('original-credential Lambda Service readback', () => {
  test('uses the typed credential hash and original coordinates with two complete authenticated inventories', async () => {
    const h = await lambdaHarness();
    const selected = parseServiceAuditSelection(
      { ...manifest, scopes: [lambdaScope] },
      'lambda',
    );
    expect(() =>
      assertServiceAuditProfile(selected.scopes, h.profile),
    ).not.toThrow();
    const record = await auditServiceScope(selected.scopes[0], h.ports);
    expect(record.originalProfileRowMatches).toBe(true);
    expect(record.externalResourcesAbsent).toBe(true);
    expect(record.historicalOutcome).toBe('unchanged');
    expect(record.native.map((entry) => entry.observation.presence)).toEqual([
      'unknown',
      'absent',
    ]);
    expect(record.native.map((entry) => entry.location)).toEqual([
      lambdaScope.hosts[0],
      lambdaScope.hosts[0],
    ]);
    expect(record.native.map((entry) => entry.observedAt)).toEqual([
      1_000, 11_000,
    ]);
    expect(h.fetch.mock.calls.map(([url]) => String(url))).toEqual([
      `https://cloud.lambda.ai/api/v1/instances/${'1'.repeat(32)}`,
      'https://cloud.lambda.ai/api/v1/instances',
      `https://cloud.lambda.ai/api/v1/instances/${'1'.repeat(32)}`,
      'https://cloud.lambda.ai/api/v1/instances',
    ]);
    for (const [, options] of h.fetch.mock.calls)
      expect(options).toMatchObject({
        method: 'GET',
        headers: { Authorization: `Bearer ${LAMBDA_KEY}` },
        redirect: 'manual',
      });
    expect(
      h.httpGet.mock.calls.map(([, , options]) => options?.deadlineAt),
    ).toEqual([31_000, 31_000, 41_000, 41_000]);
    expect(h.commands.run).not.toHaveBeenCalled();
    expect(h.dns.observe).toHaveBeenCalledTimes(2);
    expect(h.dns.observe.mock.calls[0]).toEqual([
      'd-gpu-owned.anycloud.sh',
      121_000,
    ]);
    const retained = await h.artifactsText();
    expect(retained).toContain(LAMBDA_PROFILE_ROW);
    expect(retained).not.toContain(LAMBDA_KEY);
    expect(retained).not.toContain('Authorization');
  });

  test.each([
    { ...lambdaScope, originalProfileRowId: null },
    { ...lambdaScope, originalProfileRowId: 'original-profile-row' },
    {
      ...lambdaScope,
      hosts: [{ ...lambdaScope.hosts[0], cloudId: '1'.repeat(31) }],
    },
    {
      ...lambdaScope,
      hosts: [{ ...lambdaScope.hosts[0], cloudId: 'A'.repeat(32) }],
    },
    {
      ...lambdaScope,
      hosts: [{ ...lambdaScope.hosts[0], region: 'us-east-1/foreign' }],
    },
    {
      ...lambdaScope,
      hosts: [{ ...lambdaScope.hosts[0], availabilityZone: 'a' }],
    },
    { ...lambdaScope, reservations: scope.reservations },
    { ...lambdaScope, hosts: [lambdaScope.hosts[0], lambdaScope.hosts[0]] },
    {
      ...lambdaScope,
      hosts: [
        lambdaScope.hosts[0],
        { ...lambdaScope.hosts[0], region: 'us-west-1' },
      ],
    },
  ])(
    'rejects malformed or duplicate original Lambda scope before requests: %j',
    async (invalid) => {
      const h = await lambdaHarness();
      await expect(auditServiceScope(invalid, h.ports)).rejects.toThrow();
      expect(h.fetch).not.toHaveBeenCalled();
      expect(h.commands.run).not.toHaveBeenCalled();
      expect(h.dns.observe).not.toHaveBeenCalled();
    },
  );

  test('rejects a native identity shared across declared Workloads', () => {
    expect(() =>
      parseServiceAuditSelection(
        {
          ...manifest,
          scopes: [
            lambdaScope,
            { ...lambdaScope, workloadId: 'd-another-service' },
          ],
        },
        'lambda',
      ),
    ).toThrow('distinct native identities');
  });

  test.each(['missing', 'rotated', 'foreign provider'] as const)(
    'retains an unresolved %s credential without native or DNS requests',
    async (failure) => {
      const h = await lambdaHarness();
      const profile: VmProfile | undefined =
        failure === 'missing'
          ? undefined
          : failure === 'rotated'
            ? {
                ...h.profile,
                credential: {
                  cloudProvider: CloudType.Lambda,
                  apiKey: 'different-synthetic-key',
                },
              }
            : { ...h.profile, provider: CloudType.AWS };
      const record = await auditServiceScope(lambdaScope, {
        ...h.ports,
        profile,
      });
      expect(record.originalProfileRowMatches).toBe(false);
      expect(record.externalResourcesAbsent).toBe(false);
      expect(record.native).toEqual([]);
      expect(record.dns).toEqual([]);
      expect(record.failures).toEqual([
        {
          round: 0,
          operation: 'original credential',
          message: expect.stringContaining('Lambda'),
        },
      ]);
      expect(h.fetch).not.toHaveBeenCalled();
      expect(h.dns.observe).not.toHaveBeenCalled();
      expect(h.commands.run).not.toHaveBeenCalled();
      expect(h.snapshots.at(-1)).toMatchObject({
        externalResourcesAbsent: false,
      });
      expect(await h.artifactsText()).not.toContain('different-synthetic-key');
    },
  );

  test.each(['missing credential', 'later scope mismatch'] as const)(
    'the real command preflights every scope and retains %s before any request',
    async (failure) => {
      const directory = await mkdtemp(
        path.join(tmpdir(), 'lambda-service-command-'),
      );
      onTestFinished(() => rm(directory, { force: true, recursive: true }));
      const selected = {
        ...manifest,
        scopes: [
          lambdaScope,
          {
            ...lambdaScope,
            workloadId: 'd-another-service',
            hosts: [{ ...lambdaScope.hosts[0], cloudId: '2'.repeat(32) }],
            originalProfileRowId: 'e'.repeat(64),
          },
        ],
      };
      vi.stubEnv('SERVICE_CLEANUP_AUDIT', JSON.stringify(selected));
      vi.stubEnv('SERVICE_CLEANUP_AUDIT_PROVIDER', 'lambda');
      vi.stubEnv('SERVICE_CLEANUP_AUDIT_FORCE', 'false');
      vi.stubEnv('SERVICE_CLEANUP_AUDIT_MACE_ONLY', 'false');
      vi.stubEnv('SERVICE_CLEANUP_AUDIT_OUTPUT', directory);
      vi.stubEnv('GITHUB_SHA', 'c'.repeat(40));
      vi.stubEnv('GITHUB_RUN_ID', '123456');
      vi.stubEnv('GITHUB_RUN_ATTEMPT', '1');
      vi.stubEnv('VM_SMOKE_REGION', '');
      vi.stubEnv('VM_SMOKE_DISK_SIZE_GB', '');
      vi.stubEnv(
        'LAMBDA_API_KEY',
        failure === 'missing credential' ? undefined : LAMBDA_KEY,
      );
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockRejectedValue(new Error('Unexpected native request'));
      vi.stubGlobal('fetch', fetch);
      const dns = vi
        .spyOn(ServiceDnsProbe.prototype, 'observe')
        .mockRejectedValue(new Error('Unexpected DNS request'));
      const commands = vi
        .spyOn(ProcessRunner.prototype, 'run')
        .mockRejectedValue(new Error('Unexpected provider CLI'));
      await expect(runServiceResourcesAudit()).rejects.toThrow(
        'Service audit failed',
      );
      expect(fetch).not.toHaveBeenCalled();
      expect(dns).not.toHaveBeenCalled();
      expect(commands).not.toHaveBeenCalled();
      const metadata: unknown = JSON.parse(
        await readFile(path.join(directory, 'metadata.json'), 'utf8'),
      );
      expect(metadata).toMatchObject({
        sourceSha: 'c'.repeat(40),
        originalSourceSha: manifest.originalSourceSha,
        originalRunId: manifest.originalRunId,
        scopes: selected.scopes,
      });
      const outcome: unknown = JSON.parse(
        await readFile(path.join(directory, 'outcome.json'), 'utf8'),
      );
      expect(outcome).toMatchObject({
        externalResourcesAbsent: false,
        privateFilesRemoved: true,
        failures: [
          {
            operation: 'observation or retention',
            message: expect.stringContaining(
              failure === 'missing credential'
                ? 'LAMBDA_API_KEY'
                : 'd-another-service',
            ),
          },
        ],
      });
      expect(JSON.stringify([metadata, outcome])).not.toContain(LAMBDA_KEY);
    },
  );

  test.each([
    'malformed',
    'duplicate',
    'foreign identity',
    'foreign region',
    'partial inventory',
  ] as const)(
    'the existing HTTP/native owners keep %s responses unresolved and private',
    async (failure) => {
      const h = await lambdaHarness();
      const row = {
        id: '1'.repeat(32),
        status: 'terminated',
        region: { name: 'us-east-1' },
        jupyter_token: 'UNVALIDATED-NOTEBOOK-TOKEN',
      };
      const original = h.fetch.getMockImplementation()!;
      h.fetch.mockImplementation(async (url, options) => {
        if (failure === 'malformed')
          return Response.json({ data: [{ ...row, id: 1 }] });
        if (failure === 'foreign identity')
          return Response.json({ data: { ...row, id: 'f'.repeat(32) } });
        if (failure === 'foreign region')
          return Response.json({
            data: { ...row, region: { name: 'us-west-1' } },
          });
        if (String(url).endsWith('/instances'))
          return Response.json(
            failure === 'duplicate'
              ? { data: [row, row] }
              : { data: [], page_token: 'UNVALIDATED-CURSOR' },
          );
        return original(url, options);
      });
      const record = await auditServiceScope(lambdaScope, h.ports);
      expect(record.externalResourcesAbsent).toBe(false);
      expect(record.failures.map((entry) => entry.operation)).toEqual([
        'native',
        'native',
      ]);
      expect(record.native).toEqual([]);
      expect(h.fetch.mock.calls.length).toBeLessThanOrEqual(4);
      const retained = await h.artifactsText();
      expect(retained).not.toContain('UNVALIDATED-NOTEBOOK-TOKEN');
      expect(retained).not.toContain('UNVALIDATED-CURSOR');
      expect(retained).not.toContain(LAMBDA_KEY);
    },
  );

  test('retains the earlier native observation when the second inventory is incomplete', async () => {
    const h = await lambdaHarness();
    const original = h.fetch.getMockImplementation()!;
    h.fetch.mockImplementation(async (url, options) =>
      Date.now() >= 11_000 && String(url).endsWith('/instances')
        ? Response.json({ data: [], next: 'unvalidated-next-page' })
        : original(url, options),
    );
    const record = await auditServiceScope(lambdaScope, h.ports);
    expect(record.externalResourcesAbsent).toBe(false);
    expect(record.native).toMatchObject([
      {
        round: 1,
        observation: { cloudId: '1'.repeat(32), presence: 'unknown' },
      },
    ]);
    expect(record.failures).toEqual([
      {
        round: 2,
        operation: 'native',
        message: expect.stringContaining('not a complete instance inventory'),
      },
    ]);
    expect(h.snapshots.at(-1)).toMatchObject({
      native: record.native,
      externalResourcesAbsent: false,
    });
    expect(await h.artifactsText()).not.toContain('unvalidated-next-page');
  });

  test('cancellation of the real native read stops later HTTP and DNS requests', async () => {
    const h = await lambdaHarness();
    h.fetch.mockImplementation(async () => {
      h.controller.abort(new Error('Lambda audit cancelled'));
      return Response.json({ data: [] });
    });
    const record = await auditServiceScope(lambdaScope, h.ports);
    expect(record.externalResourcesAbsent).toBe(false);
    expect(record.native).toEqual([]);
    expect(record.failures[0]).toMatchObject({
      operation: 'native',
      message: 'Lambda audit cancelled',
    });
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.dns.observe).not.toHaveBeenCalled();
    expect(h.commands.run).not.toHaveBeenCalled();
    expect(h.snapshots.at(-1)).toMatchObject({
      externalResourcesAbsent: false,
    });
  });
});

import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, onTestFinished, test, vi } from 'vitest';

import { CloudType } from '../../src/shared/cloud.js';
import { createBucketRmCommand } from '../../src/cli/commands/bucket/rm.js';
import { createSubmitCommand } from '../../src/cli/commands/submit.js';
import { cloudCredentialSchema } from '../../src/shared/api-contract/credentials-schemas.js';
import { ApiClient } from '../integration/e2e/internal/api.js';
import {
  ArtifactStore,
  Redactor,
} from '../integration/e2e/internal/artifacts.js';
import { CleanupStack } from '../integration/e2e/internal/cleanup.js';
import { CliClient } from '../integration/e2e/internal/cli.js';
import { ControllerEndpoint } from '../integration/e2e/internal/controller-session.js';
import { CliDatabase } from '../integration/e2e/internal/database.js';
import { FixtureFiles } from '../integration/e2e/internal/files.js';
import { JobAttemptLedger } from '../integration/e2e/internal/job-attempt-ledger.js';
import { JobCloudStorage } from '../integration/e2e/internal/job-cloud-storage.js';
import { JobNativeCleanup } from '../integration/e2e/internal/job-native-cleanup.js';
import { PersistentVmCleanup } from '../integration/e2e/internal/persistent-vm-cleanup.js';
import type { VmProfile } from '../integration/e2e/internal/profiles.js';
import { ProcessRunner } from '../integration/e2e/internal/process.js';
import { SecretManager } from '../integration/e2e/internal/secrets.js';
import {
  JOB_MEMBERS,
  jobMemberProfile,
  jobStageBudget,
} from '../integration/e2e/internal/contracts/job-policy.js';
import { PublicCloudJobAdapter } from '../integration/e2e/internal/targets/public-cloud-job.js';
import {
  jobGroupSize,
  type CloudJobFixture,
  type JobMemberProfile,
} from '../integration/e2e/internal/targets/job-types.js';
import { JobPrivateCommands } from '../integration/e2e/internal/transports/job-command.js';
import * as transfers from '../integration/e2e/internal/transports/job-transfers.js';
import {
  jobHostProbeProfile,
  PublicCloudJobTransport,
  type PublicCloudJobDependencies,
} from '../integration/e2e/internal/transports/public-cloud-job.js';
import { PublicCloudVmHostPresenceProbeFactory } from '../integration/e2e/internal/transports/public-cloud-vm-host-presence.js';
import type {
  CommandOptions,
  WorkloadCreateBody,
} from '../integration/e2e/internal/types.js';
import { VmLedgerProbe } from '../integration/e2e/internal/vm-ledger.js';
import { Waiter } from '../integration/e2e/internal/wait.js';
import { WorkloadMutationTransport } from '../integration/e2e/internal/workload-mutations.js';
import { TrackedWorkloadKernel } from '../integration/e2e/internal/workloads.js';
import {
  commandResultForTest,
  trackedWorkloadRefForTest,
} from './helpers/e2e.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const GITHUB_TOKEN = 'ghs_private-git-token-for-test';
const ids = [
  'job-controller-one',
  'job-controller-two',
  'job-controller-three',
];
const ownerApi = 'a'.repeat(32);
const material = {
  cloudProvider: CloudType.AWS,
  accessKeyId: 'test-original-access',
  secretAccessKey: 'test-original-secret',
} as const;
const recordId = createHash('sha256')
  .update(JSON.stringify(cloudCredentialSchema.parse(material)))
  .digest('hex');
const profile = jobMemberProfile(
  { kind: 'concurrent-output', target: 'aws' },
  {
    optional: (_name, fallback = '') => fallback,
    milliseconds: (_name, seconds) => seconds * 1000,
  },
);
const runtimeSecretProfile = jobMemberProfile(
  { kind: 'runtime-secrets', target: 'aws' },
  {
    optional: (_name, fallback = '') => fallback,
    milliseconds: (_name, seconds) => seconds * 1000,
  },
);
const admissionProfile = jobMemberProfile(
  { kind: 'invalid-admission', target: 'aws' },
  {
    optional: (_name, fallback = '') => fallback,
    milliseconds: (_name, seconds) => seconds * 1000,
  },
);

function barrier() {
  let entered!: () => void;
  let resume!: () => void;
  return {
    used: false,
    entered: new Promise<void>((resolve) => {
      entered = resolve;
    }),
    wait: new Promise<void>((resolve) => {
      resume = resolve;
    }),
    notify: () => entered(),
    release: () => resume(),
  };
}

/** Real owners, ledger, kernel and mutation transport; only external replies are controlled. */
async function harness(
  memberProfile: JobMemberProfile = profile,
  options: { deferPreparation?: boolean; computeProfile?: VmProfile } = {},
) {
  const computeProfile: VmProfile = options.computeProfile ?? {
    slug: 'aws',
    provider: CloudType.AWS,
    credentialName: 'aws-test',
    credential: material,
    vmTypes: ['t3.large'],
  };
  const selectedRecordId = createHash('sha256')
    .update(
      JSON.stringify(cloudCredentialSchema.parse(computeProfile.credential)),
    )
    .digest('hex');
  const profileReads: string[] = [];
  const directory = await mkdtemp(path.join(tmpdir(), 'job-controller-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const unexpected = async (): Promise<never> => {
    throw new Error('Unexpected external operation');
  };
  vi.stubGlobal('fetch', unexpected);
  const endpoint = new ControllerEndpoint();
  const original = endpoint.attach('http://job-controller.invalid');
  const foreground = new AbortController();
  const signal = foreground.signal;
  const cleanupSignal = new AbortController().signal;
  const redactor = new Redactor();
  const artifacts = new ArtifactStore(directory, redactor);
  const recordJson = artifacts.json.bind(artifacts);
  const records: Array<{ label: string; body: unknown }> = [];
  vi.spyOn(artifacts, 'json').mockImplementation(async (label, body) => {
    records.push({ label, body });
    return memberProfile.requiredExtensions.includes('runtime-secrets')
      ? recordJson(label, body)
      : label;
  });
  const api = new ApiClient(
    endpoint,
    'test-token',
    artifacts,
    redactor,
    signal,
  );
  const secretCleanupApi = new ApiClient(
    endpoint,
    'test-token',
    artifacts,
    redactor,
    cleanupSignal,
  );
  const state = {
    credential: false,
    bucket: false,
    bucketCreatedAt: 0,
    gate: undefined as ReturnType<typeof barrier> | undefined,
    attempts: new Map<string, Record<string, unknown>>(),
    replaceAfterSend: false,
    reserveOnSend: false,
    reservationIds: [] as string[],
    failReservationSuffix: false,
    leakedVolume: false,
    spotRequestState: 'active',
    secrets: new Map<string, Readonly<Record<string, string>>>(),
    secretRequests: [] as Array<{
      method: string;
      path: string;
      registered: boolean;
      aborted: boolean;
      generation: number;
    }>,
    lostSecretReply: undefined as string | undefined,
    retainSecret: false,
    replaceOnSecretDelete: false,
    replaceOnSecretRead: false,
    replaceOnSecretSave: false,
    admissionReply: 'rejected' as
      | 'rejected'
      | 'lost'
      | 'foreign'
      | 'authentication'
      | 'schema'
      | 'redirect',
    admissionRequests: [] as Array<{
      body: WorkloadCreateBody;
      registered: boolean;
      credentialPresent: boolean;
      baselineReads: number;
    }>,
    admissionInventoryTruncated: false,
    admissionInventoryCount: 0,
    admissionHistoryIncomplete: false,
    replaceOnAdmissionReply: false,
  };
  const replace = () => {
    endpoint.detach();
    endpoint.attach(original.url);
  };
  vi.spyOn(api, 'readCredential').mockImplementation(async (name) =>
    state.credential ? { name, ...computeProfile.credential } : undefined,
  );
  vi.spyOn(api, 'saveCredential').mockImplementation(async () => {
    state.credential = true;
  });
  vi.spyOn(api, 'listCredentials').mockImplementation(async () =>
    state.credential
      ? [
          {
            name: computeProfile.credentialName,
            cloudProvider: computeProfile.provider,
          },
        ]
      : [],
  );
  vi.spyOn(api, 'deleteCredential').mockImplementation(async () => {
    state.credential = false;
  });
  vi.spyOn(api, 'bucketPresence').mockImplementation(
    async (name, credentialName, region) => ({
      name,
      credentialName,
      region,
      presence: state.bucket ? 'present' : 'absent',
      controller: api.controller,
    }),
  );
  vi.spyOn(api, 'lookupStatus').mockResolvedValue({ kind: 'absent' });
  vi.spyOn(secretCleanupApi, 'lookupStatus').mockResolvedValue({
    kind: 'absent',
  });
  const calls: Array<{
    args: readonly string[];
    generation: number;
    apiUrl?: string;
    signalAborted?: boolean;
  }> = [];
  const runner = new ProcessRunner(artifacts, signal, directory);
  vi.spyOn(runner, 'run').mockImplementation(
    async (_exe, args, options?: CommandOptions) => {
      calls.push({
        args: [...args],
        generation: api.controller.generation,
        apiUrl: options?.env?.API_URL,
        signalAborted: options?.signal?.aborted,
      });
      if (args[0] === 'db') {
        const sql = args.at(-1)!;
        let rows: readonly Record<string, unknown>[];
        if (sql.includes('_metadata')) rows = [{ value: ownerApi }];
        else if (sql.includes('AS workloads')) {
          const id = /'([^']+)' AS workload_id/u.exec(sql)![1];
          rows = [
            {
              workload_id: id,
              workloads: state.admissionInventoryCount,
              vms: state.attempts.has(id) ? 1 : 0,
              ...(sql.includes('AS credential_id')
                ? {
                    credential_id: selectedRecordId,
                    credential_name: computeProfile.credentialName,
                    cloud_provider: computeProfile.provider,
                  }
                : {}),
            },
          ];
        } else if (sql.includes('FROM vms v')) {
          const id = /WHERE v.workload_id = '([^']+)'/u.exec(sql)![1];
          rows = state.attempts.has(id) ? [{ ...state.attempts.get(id)! }] : [];
          if (state.gate && !state.gate.used) {
            state.gate.used = true;
            state.gate.notify();
            await state.gate.wait;
          }
        } else if (
          sql.includes('s.image') ||
          sql.includes('FROM workload_events')
        )
          rows = [];
        else if (sql.includes('FROM workloads w'))
          rows = [
            { id: selectedRecordId, name: computeProfile.credentialName },
          ];
        else if (sql.includes('FROM credentials'))
          rows = state.credential
            ? [
                {
                  id: selectedRecordId,
                  name: computeProfile.credentialName,
                  cloud_provider: computeProfile.provider,
                },
              ]
            : [];
        else throw new Error('Unexpected controlled database query');
        return commandResultForTest({
          args: [...args],
          stdout: JSON.stringify({
            rows,
            rowCount: rows.length,
            truncated:
              (sql.includes('AS workloads') &&
                state.admissionInventoryTruncated) ||
              (sql.includes('FROM workload_events') &&
                state.admissionHistoryIncomplete),
          }),
        });
      }
      if (args[0] === 'job') {
        const id = args[args.indexOf('--id') + 1];
        const createdAt = Date.now();
        state.attempts.set(id, {
          id: ids.indexOf(id) + 1,
          workload_id: id,
          created_at: createdAt,
          ended_at: null,
          cloud_id: state.reserveOnSend
            ? `${id}-0`
            : `i-${String(ids.indexOf(id) + 1).repeat(17)}`,
          ip: state.reserveOnSend ? null : '192.0.2.1',
          region: 'us-west-2',
          availability_zone: 'a',
          vm_type: memberProfile.vmTypes[0],
          credential_id: selectedRecordId,
          cloud_provider: computeProfile.provider,
        });
        if (args.includes('--output-bucket')) {
          state.bucket = true;
          state.bucketCreatedAt ||= createdAt;
        }
        if (state.replaceAfterSend) replace();
        return commandResultForTest();
      }
      if (args[0] === 'terminate') {
        const row = state.attempts.get(args[1]);
        if (row) row.ended_at = Date.now();
        return commandResultForTest();
      }
      if (args[0] === 'bucket' && args[1] === 'delete') {
        state.bucket = false;
        return commandResultForTest();
      }
      throw new Error('Unexpected controlled CLI operation');
    },
  );
  const cli = new CliClient(
    runner,
    directory,
    directory,
    endpoint,
    'test-token',
    signal,
    '/unused/anycloud',
  );
  const database = new CliDatabase(cli);
  const cleanupCli = new CliClient(
    runner,
    directory,
    directory,
    endpoint,
    'test-token',
    cleanupSignal,
    '/unused/anycloud',
  );
  const cleanupDatabase = new CliDatabase(cleanupCli);
  const cleanup = new CleanupStack();
  vi.stubGlobal(
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (
        url.origin === original.url &&
        url.pathname === '/v1/workloads' &&
        request.method === 'POST'
      ) {
        request.signal.throwIfAborted();
        const body = (await request.json()) as WorkloadCreateBody;
        state.admissionRequests.push({
          body,
          registered: cleanup
            .observations()
            .some(
              (entry) =>
                entry.label === `workload ${body.id}` && !entry.completed,
            ),
          credentialPresent: state.credential,
          baselineReads: calls.filter((call) =>
            call.args.at(-1)?.includes('AS credential_id'),
          ).length,
        });
        if (state.replaceOnAdmissionReply) replace();
        if (state.admissionReply === 'lost')
          throw new TypeError('Controlled lost admission reply');
        if (state.admissionReply === 'foreign')
          return Response.json({ id: 'foreign-workload' }, { status: 202 });
        if (state.admissionReply === 'schema')
          return Response.json({ id: 17 }, { status: 202 });
        if (state.admissionReply === 'redirect')
          return new Response(null, {
            status: 302,
            headers: { Location: 'http://foreign.invalid/workloads' },
          });
        if (state.admissionReply === 'authentication')
          return Response.json(
            {
              defined: true,
              code: 'UNAUTHORIZED',
              status: 401,
              message: 'Authentication failed',
            },
            { status: 401 },
          );
        return Response.json(
          {
            defined: true,
            code: 'WORKLOAD_ADMISSION_REJECTED',
            status: 400,
            message: body.cloudConfig.inputBucket
              ? `Input bucket "${body.cloudConfig.inputBucket}" not found`
              : 'VM type "totally_fake_nonexistent_vm" is not available on AWS',
          },
          { status: 400 },
        );
      }
      if (
        url.origin !== original.url ||
        !url.pathname.startsWith('/v1/secrets')
      )
        return unexpected();
      request.signal.throwIfAborted();
      const name = decodeURIComponent(
        url.pathname.slice('/v1/secrets/'.length),
      );
      state.secretRequests.push({
        method: request.method,
        path: url.pathname + url.search,
        registered: cleanup
          .observations()
          .some(
            (entry) => entry.label === `secret ${name}` && !entry.completed,
          ),
        aborted: request.signal.aborted,
        generation: api.controller.generation,
      });
      if (request.method === 'PUT') {
        const body = (await request.json()) as {
          values: Record<string, string>;
        };
        state.secrets.set(name, body.values);
        if (state.replaceOnSecretSave) replace();
        if (state.lostSecretReply === name)
          throw new TypeError('Controlled lost secret save reply');
        return new Response(null, { status: 204 });
      }
      if (request.method === 'DELETE' && url.search === '?force=true') {
        if (!state.retainSecret) state.secrets.delete(name);
        if (state.replaceOnSecretDelete) replace();
        return new Response(null, { status: 204 });
      }
      if (request.method === 'GET' && url.pathname === '/v1/secrets') {
        if (state.replaceOnSecretRead) replace();
        return Response.json(
          [...state.secrets.keys()].map((secretName) => ({
            name: secretName,
            createdAt: 1,
            updatedAt: 1,
          })),
        );
      }
      return unexpected();
    },
  );
  const secrets = new SecretManager(api, cleanup, secretCleanupApi);
  const wait = new Waiter(signal);
  const cleanupWait = new Waiter(cleanupSignal);
  const kernel = new TrackedWorkloadKernel(
    api,
    cli,
    cleanup,
    wait,
    directory,
    memberProfile.member.kind === 'invalid-admission'
      ? { api: secretCleanupApi, cli: cleanupCli, wait: cleanupWait }
      : undefined,
  );
  const ledger = new JobAttemptLedger({ api, database, kernel });
  const native = new JobNativeCleanup({
    kernel,
    ledger,
    wait: cleanupWait,
    artifacts,
  });
  const nativeCalls: Array<{
    args: readonly string[];
    signalAborted: boolean | undefined;
    accessKeyId: string | undefined;
    recordArtifact: boolean | undefined;
  }> = [];
  const nativeRunner = {
    run: async (
      _exe: string,
      args: readonly string[],
      options?: CommandOptions,
    ) => {
      nativeCalls.push({
        args,
        signalAborted: options?.signal?.aborted,
        accessKeyId: options?.env?.AWS_ACCESS_KEY_ID,
        recordArtifact: options?.recordArtifact,
      });
      let stdout: string;
      if (args[0] === 'sts')
        stdout = JSON.stringify({
          Account: '123456789012',
          Arn: 'arn:aws:iam::123456789012:user/test',
          UserId: 'AIDATEST',
        });
      else if (
        memberProfile.requiredExtensions.includes('spot-request-cleanup') &&
        args[1] === 'describe-spot-instance-requests'
      ) {
        const row = state.attempts.get(ids[0]);
        stdout = JSON.stringify({
          SpotInstanceRequests: row
            ? [
                {
                  SpotInstanceRequestId: 'sir-original',
                  InstanceId: row.cloud_id,
                  State: state.spotRequestState,
                  Type: 'persistent',
                  LaunchSpecification: { InstanceType: 't3.large' },
                  Tags: [
                    { Key: 'anycloud_deployment', Value: ids[0] },
                    { Key: 'anycloud_owner_api', Value: ownerApi },
                  ],
                },
              ]
            : [],
        });
      } else if (args[1] === 'cancel-spot-instance-requests') {
        state.spotRequestState = 'cancelled';
        stdout = JSON.stringify({
          CancelledSpotInstanceRequests: [
            { SpotInstanceRequestId: 'sir-original', State: 'cancelled' },
          ],
        });
      } else if (
        memberProfile.requiredExtensions.includes('spot-request-cleanup') &&
        args[1] === 'describe-instances' &&
        (!args.includes('--filters') ||
          args[args.indexOf('--filters') + 1].startsWith('Name='))
      ) {
        const row = state.attempts.get(ids[0]);
        stdout = JSON.stringify({
          Reservations: [
            {
              OwnerId: '123456789012',
              Instances: row
                ? [
                    {
                      InstanceId: row.cloud_id,
                      InstanceType: 't3.large',
                      SpotInstanceRequestId: 'sir-original',
                      Placement: { AvailabilityZone: 'us-west-2a' },
                      State: {
                        Name: row.ended_at === null ? 'running' : 'terminated',
                      },
                      Tags: [
                        { Key: 'anycloud_deployment', Value: ids[0] },
                        { Key: 'anycloud_owner_api', Value: ownerApi },
                      ],
                    },
                  ]
                : [],
            },
          ],
        });
      } else if (args[1] === 'describe-instances') {
        if (args.includes('--filters')) {
          if (state.failReservationSuffix && args.includes('--next-token'))
            return commandResultForTest({
              executable: _exe,
              args: [...args],
              exitCode: 255,
              stderr: 'AuthFailure: original credential rejected',
            });
          const filters = JSON.parse(
            args[args.indexOf('--filters') + 1],
          ) as Array<{
            Name: string;
            Values: string[];
          }>;
          stdout = JSON.stringify({
            Reservations: [
              {
                Instances: state.reservationIds.map((InstanceId) => ({
                  InstanceId,
                  ClientToken: filters[0].Values[0],
                  State: { Name: 'terminated' },
                  Placement: { AvailabilityZone: 'us-west-2a' },
                })),
              },
            ],
            ...(state.failReservationSuffix ? { NextToken: 'next-page' } : {}),
          });
        } else stdout = '{"Reservations":[]}';
      } else if (args[1] === 'describe-volumes') {
        stdout = JSON.stringify({
          Volumes: state.leakedVolume
            ? [
                {
                  VolumeId: 'vol-0123456789abcdef0',
                  State: 'available',
                  Tags: [{ Key: 'anycloud_deployment', Value: ids[0] }],
                },
              ]
            : [],
        });
      } else if (args[1] === 'get-bucket-location') {
        if (!state.bucket)
          return commandResultForTest({
            executable: _exe,
            args: [...args],
            exitCode: 255,
            stderr:
              'An error occurred (NoSuchBucket) when calling the GetBucketLocation operation: missing',
          });
        stdout = '{"LocationConstraint":"us-west-2"}';
      } else if (args[1] === 'get-bucket-tagging')
        stdout = JSON.stringify({
          TagSet: Object.entries({
            anycloud_created_at: String(state.bucketCreatedAt),
            anycloud_owner_api: ownerApi,
            anycloud_user: 'test-user',
            anycloud_deployment: ids[0],
          }).map(([Key, Value]) => ({ Key, Value })),
        });
      else throw new Error('Unexpected controlled native command');
      return commandResultForTest({
        executable: _exe,
        args: [...args],
        stdout,
        combined: stdout,
      });
    },
  };
  const commands = new JobPrivateCommands(nativeRunner, signal);
  const files = new FixtureFiles(directory);
  const dependencies: PublicCloudJobDependencies = {
    api,
    cleanupApi: api,
    database,
    cleanupDatabase: database,
    cli,
    cleanupCli: cli,
    cleanup,
    files,
    wait,
    cleanupWait,
    commands,
    cleanupCommands: commands,
    kernel,
    native,
    mutations: new WorkloadMutationTransport(kernel, api, cli),
    artifacts,
    redactor,
    cleanupSignal,
    privateRepoToken: GITHUB_TOKEN,
    maceObserver: { runner: nativeRunner, bearer: () => 'test-token' },
    profiles: {
      vm: (target) => {
        profileReads.push(target);
        if (target !== computeProfile.slug)
          throw new Error('Unexpected storage credential dependency');
        return computeProfile;
      },
    },
    hosts: new PublicCloudVmHostPresenceProbeFactory(
      nativeRunner,
      files,
      { get: unexpected },
      artifacts,
    ),
    remote: { run: unexpected },
    secrets,
    vmLedger: new VmLedgerProbe(cli, kernel),
    http: { get: unexpected },
  };
  const admissionNative = new PersistentVmCleanup({
    kernel,
    database: cleanupDatabase,
    endpoint,
    profiles: dependencies.profiles,
    hosts: dependencies.hosts,
    http: dependencies.http,
    wait: cleanupWait,
    artifacts,
    signal: cleanupSignal,
  });
  const transport = new PublicCloudJobTransport({
    ...dependencies,
    admission: {
      native: admissionNative,
      mutations: new WorkloadMutationTransport(kernel, api, cli),
      kernel,
    },
  });
  const adapter = new PublicCloudJobAdapter(transport);
  const prepare = () =>
    adapter.prepare(
      memberProfile.member.kind === 'concurrent-output'
        ? ids
        : ids.slice(0, jobGroupSize(memberProfile)),
      memberProfile,
      {
        runningMs: 1000,
        cleanupMs: 10000,
        storageMs: 1000,
        completionMs: 1000,
      },
    );
  const fixtures = options.deferPreparation ? [] : await prepare();
  return {
    api,
    adapter,
    transport,
    profileReads,
    remote: dependencies.remote,
    commands,
    fixtures,
    prepare,
    native,
    admissionNative,
    kernel,
    ledger,
    endpoint,
    original,
    replace,
    cleanup,
    state,
    calls,
    records,
    directory,
    foreground,
    nativeCalls,
  };
}

test('real SDK admission rejects both AWS cases after registration and complete inventory, then releases without inventing cleanedAt', async () => {
  const w = await harness(admissionProfile);
  expect(w.fixtures).toHaveLength(2);
  for (const fixture of w.fixtures) {
    await expect(w.adapter.submitAdmission(fixture)).resolves.toBe('rejected');
    await expect(w.adapter.admissionOutcome(fixture)).resolves.toMatchObject({
      ref: fixture.ref,
      kind: 'rejected',
    });
  }
  expect(w.state.admissionRequests).toEqual([
    {
      registered: true,
      credentialPresent: true,
      baselineReads: 1,
      body: {
        id: ids[0],
        workloadType: 'job',
        credentialName: 'aws-test',
        image: 'nginx:alpine',
        cloudConfig: {
          vmType: 't3.small',
          inputBucket: `sthree-reserved-test-${ids[0]}`,
        },
      },
    },
    {
      registered: true,
      credentialPresent: true,
      baselineReads: 2,
      body: {
        id: ids[1],
        workloadType: 'job',
        credentialName: 'aws-test',
        image: 'nginx:alpine',
        cloudConfig: {
          vmType: 'totally_fake_nonexistent_vm',
          region: 'us-east-1',
        },
      },
    },
  ]);
  for (const [index, fixture] of w.fixtures.entries()) {
    const proof = await w.adapter.nativeAbsence(fixture, 1000);
    await expect(
      w.adapter.releaseUncreated(fixture, { ...proof }),
    ).rejects.toThrow('original verification');
    await w.adapter.releaseUncreated(fixture, proof);
    await w.adapter.releaseResources(fixture);
    expect(w.state.credential).toBe(index === 0);
  }
  expect(w.kernel.trackedWorkloadIds()).toEqual([]);
  expect(w.cleanup.observations().every((entry) => entry.completed)).toBe(true);
  expect(w.nativeCalls).toEqual([]);
  expect(w.calls.filter((call) => call.args[0] !== 'db')).toEqual([]);
  expect(
    w.records
      .filter((record) => record.label.endsWith('-native-cleanup'))
      .map((record) => record.body),
  ).toEqual(
    w.fixtures.map((fixture) =>
      expect.objectContaining({
        workloadId: fixture.ref.id,
        completed: true,
        nonCreationVerifiedAt: expect.any(Number),
        attemptHistory: [],
        statusIdentities: [],
        admissionRejection: expect.objectContaining({
          code: 'WORKLOAD_ADMISSION_REJECTED',
          workloads: 0,
          vms: 0,
        }),
      }),
    ),
  );
});

test('admission waits for the real original inventory fence before sending and cannot send twice', async () => {
  const w = await harness(admissionProfile);
  const gate = barrier();
  w.state.gate = gate;
  const submission = w.adapter.submitAdmission(w.fixtures[0]);
  await gate.entered;
  expect(w.state.admissionRequests).toEqual([]);
  expect(
    w.cleanup
      .observations()
      .filter((entry) => entry.label.startsWith('workload ')),
  ).toHaveLength(2);
  gate.release();
  await expect(submission).resolves.toBe('rejected');
  await expect(w.adapter.submitAdmission(w.fixtures[0])).rejects.toThrow(
    'single use',
  );
  expect(w.state.admissionRequests).toHaveLength(1);
});

test.each(['truncated', 'nonempty'] as const)(
  'an %s pre-send inventory prevents the actual SDK request',
  async (failure) => {
    const w = await harness(admissionProfile);
    w.state.admissionInventoryTruncated = failure === 'truncated';
    w.state.admissionInventoryCount = failure === 'nonempty' ? 1 : 0;
    await expect(w.adapter.submitAdmission(w.fixtures[0])).rejects.toThrow();
    expect(w.state.admissionRequests).toEqual([]);
    expect(w.kernel.activeReference(ids[0])).toBe(w.fixtures[0].ref);
    expect(w.state.credential).toBe(true);
  },
);

test.each(['lost', 'foreign', 'authentication', 'schema', 'redirect'] as const)(
  'the actual SDK %s response stays unresolved and is never treated as no-creation',
  async (reply) => {
    const w = await harness(admissionProfile);
    w.state.admissionReply = reply;
    await expect(w.adapter.submitAdmission(w.fixtures[0])).rejects.toThrow();
    expect(w.state.admissionRequests).toHaveLength(1);
    await expect(w.adapter.admissionOutcome(w.fixtures[0])).rejects.toThrow();
    await expect(w.adapter.nativeAbsence(w.fixtures[0], 1000)).rejects.toThrow(
      'no complete native identity',
    );
    expect(w.kernel.activeReference(ids[0])).toBe(w.fixtures[0].ref);
    expect(w.state.credential).toBe(true);
    expect(w.cleanup.observations().filter((entry) => entry.completed)).toEqual(
      [],
    );
  },
);

test('keeps an initially incomplete real admission history after the database becomes readable', async () => {
  const w = await harness(admissionProfile);
  w.state.admissionHistoryIncomplete = true;
  await expect(w.adapter.submitAdmission(w.fixtures[0])).rejects.toThrow(
    'rejection',
  );
  w.state.admissionHistoryIncomplete = false;
  await expect(w.adapter.nativeAbsence(w.fixtures[0], 1000)).rejects.toThrow();
  await w.admissionNative.recordObservations();
  expect(
    w.records.find(
      (record) => record.label === `vm-${ids[0]}-native-identities`,
    )?.body,
  ).toMatchObject({
    creationStarted: true,
    preProvisionAdmission: { historyIncomplete: true },
  });
  expect(w.kernel.activeReference(ids[0])).toBe(w.fixtures[0].ref);
  expect(w.state.credential).toBe(true);
});

test('a changed controller cannot turn a real declared rejection into finalizer authority', async () => {
  const w = await harness(admissionProfile);
  w.state.replaceOnAdmissionReply = true;
  await expect(w.adapter.submitAdmission(w.fixtures[0])).rejects.toThrow();
  expect(w.state.admissionRequests).toHaveLength(1);
  await expect(w.adapter.admissionOutcome(w.fixtures[0])).rejects.toThrow(
    'controller',
  );
  expect(w.kernel.activeReference(ids[0])).toBe(w.fixtures[0].ref);
  expect(w.cleanup.observations().filter((entry) => entry.completed)).toEqual(
    [],
  );
});

test('real Lambda MACE preparation owns only its original Lambda credential and reuses the shared payload without AWS storage', async () => {
  const selected = jobMemberProfile(
    { kind: 'mace-full-pull', target: 'lambda' },
    {
      optional: (_name, fallback = '') => fallback,
      milliseconds: (_name, seconds) => seconds * 1000,
    },
  );
  const w = await harness(selected, {
    computeProfile: {
      slug: 'lambda',
      provider: CloudType.Lambda,
      credentialName: 'lambda-test',
      credential: {
        cloudProvider: CloudType.Lambda,
        apiKey: 'original-lambda-key',
      },
      vmTypes: ['gpu_1x_a10'],
    },
  });
  expect(w.profileReads).toEqual(['lambda']);
  expect(w.fixtures).toHaveLength(1);
  expect(w.fixtures[0]).toMatchObject({
    credentialName: 'lambda-test',
    inputBucket: undefined,
    outputBucket: undefined,
    checkpointBucket: undefined,
  });
  expect(w.fixtures[0].maceCommand).toBe(
    await readFile('test/docker/mace-first-inference.py', 'utf8'),
  );
  expect(w.nativeCalls).toHaveLength(0);
  expect(
    w.cleanup
      .observations()
      .some(
        (entry) => entry.label === `workload ${ids[0]}` && !entry.completed,
      ),
  ).toBe(true);
  expect(() => w.adapter.mace({ ...w.fixtures[0] })).toThrow();
  await w.cleanup.run();
  expect(w.cleanup.observations().every((entry) => entry.completed)).toBe(true);
  expect(w.state.credential).toBe(false);
});

test.each(['aws', 'azure', 'gcp', 'lambda'] as const)(
  '%s MACE passes the shared inference payload and original GPU/timing flags through real CLI parsing',
  async (target) => {
    const w = await harness(profile, { deferPreparation: true });
    const submit = vi.spyOn(w.transport, 'submit').mockResolvedValue(undefined);
    const selected = jobMemberProfile(
      { kind: 'mace-full-pull', target },
      {
        optional: (_name, fallback = '') => fallback,
        milliseconds: (_name, seconds) => seconds * 1000,
      },
    );
    const payload = await readFile(
      'test/docker/mace-first-inference.py',
      'utf8',
    );
    const fixture: CloudJobFixture = {
      ref: trackedWorkloadRefForTest('mace-parser'),
      profile: selected,
      credentialName: `${target}-test`,
      storageCredentialName: `${target}-test`,
      runLabel: 'mace-parser',
      concurrentIndex: 0,
      concurrentWrites: [],
      maceCommand: payload,
    };
    await w.adapter.submit(fixture);
    const args = submit.mock.calls[0][1];
    const action = vi.fn();
    const command = createSubmitCommand().exitOverride().action(action);
    await command.parseAsync(args.slice(1), { from: 'user' });
    expect(action).toHaveBeenCalledOnce();
    expect(command.args).toEqual([selected.image, 'python3', '-c', payload]);
    expect(command.opts()).toMatchObject({
      id: 'mace-parser',
      credentials: `${target}-test`,
      vmType: selected.vmTypes,
      gpus: 'all',
      env: ['AC_TIMING_RUN_ID=mace-parser-run', 'AC_TIMING_HOLD_SECONDS=0'],
    });
    expect(command.opts().region).toBe(selected.computeRegion);
    expect(command.opts().diskSize).toBe(selected.diskSizeGb);
    expect(command.opts().diskTier).toBe(selected.diskTier);
    expect(args.includes('--spot')).toBe(false);
    expect(args.includes('--input-storage-credentials')).toBe(false);
  },
);

test.each([
  ['spot-eviction', 'aws', 1, undefined],
  ['concurrent-output', 'gcp', 0, false],
  ['host-docker', 'aws', 0, undefined],
] as const)(
  "this week's %s %s child (index %i) submits its feature flags through real CLI parsing",
  async (kind, target, concurrentIndex, armed) => {
    const w = await harness(profile, { deferPreparation: true });
    const submit = vi.spyOn(w.transport, 'submit').mockResolvedValue(undefined);
    const selected = jobMemberProfile(
      { kind, target },
      {
        optional: (_name, fallback = '') => fallback,
        milliseconds: (_name, seconds) => seconds * 1000,
      },
    );
    const fixture: CloudJobFixture = {
      ref: trackedWorkloadRefForTest(`${kind}-parser`),
      profile: selected,
      credentialName: `${target}-test`,
      storageCredentialName: `${target}-test`,
      runLabel: `${kind}-parser`,
      concurrentIndex,
      concurrentWrites: [],
      ...(armed === undefined
        ? {}
        : { launchFailover: { quotas: { 'us-east1': { A100: 1 } }, armed } }),
    };
    await w.adapter.submit(fixture);
    const args = submit.mock.calls[0][1];
    const action = vi.fn();
    const command = createSubmitCommand().exitOverride().action(action);
    await command.parseAsync(args.slice(1), { from: 'user' });
    const options = command.opts();
    if (kind === 'spot-eviction') {
      // The clean-exit sibling has no retries and no checkpoint.
      expect(options).toMatchObject({ maxRetries: 0, checkpoint: false });
      expect(command.args.slice(1)).toEqual(['sleep', '600']);
    }
    if (kind === 'concurrent-output') {
      // Unarmed: the refused A100 head type is left out; regions fail over too.
      expect(options.vmType).toEqual(['e2-standard-2']);
      expect(options.regions).toEqual(['us-east1', 'us-west1']);
    }
    if (kind === 'host-docker')
      // The listener's own gp3 performance.
      expect(options).toMatchObject({ diskIops: 4000, diskThroughput: 500 });
  },
);

test.each(['false', 'true'])(
  'GHCR keeps its real CLI GPU, placement and spot=%s options',
  async (spot) => {
    const w = await harness(profile, { deferPreparation: true });
    const submit = vi.spyOn(w.transport, 'submit').mockResolvedValue(undefined);
    const selected = jobMemberProfile(
      { kind: 'ghcr-probe', target: 'azure' },
      {
        optional: (name, fallback = '') =>
          name === 'PROBE_SPOT' ? spot : fallback,
        milliseconds: (_name, seconds) => seconds * 1000,
      },
    );
    const fixture: CloudJobFixture = {
      ref: trackedWorkloadRefForTest('ghcr-parser'),
      profile: selected,
      credentialName: 'azure-test',
      storageCredentialName: 'azure-test',
      runLabel: 'ghcr-parser',
      concurrentIndex: 0,
      concurrentWrites: [],
      ...(spot === 'true' ? { checkpointBucket: 'ghcr-parser' } : {}),
    };
    await w.adapter.submit(fixture);
    const args = submit.mock.calls[0][1];
    const action = vi.fn();
    const command = createSubmitCommand().exitOverride().action(action);
    await command.parseAsync(args.slice(1), { from: 'user' });
    expect(action).toHaveBeenCalledOnce();
    expect(command.args).toEqual(['ubuntu:24.04', 'sleep', '7200']);
    expect(command.opts()).toMatchObject({
      id: 'ghcr-parser',
      credentials: 'azure-test',
      vmType: ['Standard_NC4as_T4_v3'],
      gpus: 'all',
      region: 'westus2',
      diskSize: 100,
      diskTier: 'high',
    });
    expect(args.includes('--spot')).toBe(spot === 'true');
    expect(command.opts().checkpointBucket).toBeUndefined();
  },
);

test('the gpu-probe-rerun Job outlasts the Starting step before it reports no GPU, so its exit reaches the probe (run 40825826952)', async () => {
  const w = await harness(profile, { deferPreparation: true });
  const submit = vi.spyOn(w.transport, 'submit').mockResolvedValue(undefined);
  await w.adapter.submit({
    ref: trackedWorkloadRefForTest('gpu-probe'),
    profile: jobMemberProfile(
      { kind: 'gpu-probe-rerun', target: 'aws' },
      {
        optional: (_name, fallback = '') => fallback,
        milliseconds: (_name, seconds) => seconds * 1000,
      },
    ),
    credentialName: 'aws-test',
    storageCredentialName: 'aws-test',
    runLabel: 'gpu-probe',
    concurrentIndex: 0,
    concurrentWrites: [],
  });
  const action = vi.fn();
  const command = createSubmitCommand().exitOverride().action(action);
  await command.parseAsync(submit.mock.calls[0][1].slice(1), { from: 'user' });
  const [, shell, flag, script] = command.args;
  expect([shell, flag]).toEqual(['sh', '-c']);
  // Startup health polls every 5 s; a Job alive for 30 s is read Running first.
  const [, seconds, rest] = /^sleep (\d+); (.*)$/u.exec(script!) ?? [];
  expect(Number(seconds)).toBeGreaterThanOrEqual(30);
  expect(rest).toBe('echo "No CUDA GPUs are available"; exit 1');
});

test('all six disk-tier selections survive the actual CLI parser with one VM and the original held command', async () => {
  const w = await harness(profile, { deferPreparation: true });
  const submit = vi.spyOn(w.transport, 'submit').mockResolvedValue(undefined);
  const diskProfile = jobMemberProfile(
    { kind: 'disk-tier', target: 'gcp' },
    {
      optional: (_name, fallback = '') => fallback,
      milliseconds: (_name, seconds) => seconds * 1000,
    },
  );
  for (const [index, diskCase] of diskProfile.diskTierCases!.entries()) {
    const fixture: CloudJobFixture = {
      ref: trackedWorkloadRefForTest(`disk-${diskCase.key}`),
      profile: diskProfile,
      diskTierCase: diskCase,
      credentialName: 'gcp-test',
      storageCredentialName: 'gcp-test',
      runLabel: 'disk-u',
      concurrentIndex: index,
      concurrentWrites: [],
    };
    await w.adapter.submit(fixture);
    const args = submit.mock.calls[index][1];
    const action = vi.fn();
    const command = createSubmitCommand().exitOverride().action(action);
    await command.parseAsync(args.slice(1), { from: 'user' });
    expect(action).toHaveBeenCalledOnce();
    expect(command.args).toEqual(['ubuntu:24.04', 'sleep', '7200']);
    expect(command.opts()).toMatchObject({
      id: fixture.ref.id,
      credentials: 'gcp-test',
      vmType: [diskCase.vmType],
      region: 'us-east4',
      zone: 'c',
    });
    expect(command.opts().diskTier).toBe(diskCase.tier);
    expect(command.opts().diskSize).toBeUndefined();
    expect(args.includes('--spot')).toBe(false);
  }
  expect(submit).toHaveBeenCalledTimes(6);
});

test('real runtime-secret owners preserve CLI parsing, private observations and both children before resource release', async () => {
  const w = await harness(runtimeSecretProfile);
  expect(w.fixtures).toHaveLength(2);
  expect(
    w.state.secretRequests.filter((request) => request.method === 'PUT'),
  ).toHaveLength(4);
  expect(w.state.secretRequests.every((request) => request.registered)).toBe(
    true,
  );
  expect(
    w.fixtures.every(
      (fixture) =>
        !fixture.inputBucket &&
        !fixture.outputBucket &&
        !fixture.checkpointBucket,
    ),
  ).toBe(true);
  for (const fixture of w.fixtures) await w.adapter.submit(fixture);
  const submissions = w.calls.filter(({ args }) => args[0] === 'job');
  expect(submissions).toHaveLength(2);
  for (const [index, { args }] of submissions.entries()) {
    const action = vi.fn();
    const command = createSubmitCommand().exitOverride().action(action);
    await command.parseAsync(args.slice(1), { from: 'user' });
    expect(action).toHaveBeenCalledOnce();
    expect(command.args).toEqual(['nginx:alpine']);
    expect(command.opts()).toMatchObject({
      id: ids[index],
      vmType: ['t3.small'],
      credentials: 'aws-test',
      secret:
        index === 0
          ? [`job-hf-${ids[0]}`, `job-wandb-${ids[0]}`, `job-gh-${ids[0]}`]
          : [`job-dup-${ids[0]}`],
    });
    expect(command.opts().region).toBeUndefined();
    expect(command.opts().diskSize).toBeUndefined();
    expect(command.opts().env).toEqual(index === 0 ? [] : ['K=from-env']);
  }
  const values = [
    `xyz-original-${ids[0]}`,
    `wandb-${ids[0]}`,
    `team-${ids[0]}`,
  ];
  const remote = vi
    .spyOn(w.remote, 'run')
    .mockImplementation(async (id, _mode, command) => {
      let stdout: string;
      if (command.includes('PRIVATE_GIT'))
        stdout =
          id === ids[0]
            ? 'PRIVATE_GIT_TOKEN=present\nPRIVATE_GIT_LS_REMOTE=0\nPRIVATE_GIT_CLONE=0\nPRIVATE_GIT_FILE=AGENTS.md\n'
            : 'PRIVATE_GIT_TOKEN=absent\nPRIVATE_GIT_LS_REMOTE=128\nPRIVATE_GIT_AUTH=refused\nPRIVATE_GIT_CLONE=128\n';
      else if (command.startsWith('docker exec'))
        stdout = (id === ids[0] ? values : ['from-env'])
          .map((value) => createHash('sha256').update(value).digest('hex'))
          .join('\n');
      else if (command.startsWith('docker inspect'))
        stdout = `${(id === ids[0] ? 'a' : 'b').repeat(64)} 2026-09-22T01:00:00Z true`;
      else if (command.includes('sudo stat')) stdout = '600 0\ntmpfs\n';
      else throw new Error('Unexpected runtime-secret observation');
      return commandResultForTest({ stdout });
    });
  const before = await w.adapter.runtimeSecretFacts(w.fixtures[0]);
  expect(before).toMatchObject({
    environment: true,
    mode: '600',
    uid: 0,
    fileSystem: 'tmpfs',
    privateGit: true,
  });
  await expect(
    w.adapter.runtimeSecretFacts(w.fixtures[1]),
  ).resolves.toMatchObject({ environment: true, privateGit: true });
  await w.adapter.forceDeleteRuntimeSecret(w.fixtures[0]);
  await expect(w.adapter.runtimeSecretFacts(w.fixtures[0])).resolves.toEqual({
    ...before,
    privateGit: undefined,
  });
  expect(w.state.secrets.size).toBe(3);
  expect(
    w.state.secretRequests
      .slice(-2)
      .map(({ method, path: requestPath }) => `${method} ${requestPath}`),
  ).toEqual([
    `DELETE /v1/secrets/job-hf-${ids[0]}?force=true`,
    'GET /v1/secrets',
  ]);
  await expect(
    w.adapter.forceDeleteRuntimeSecret(w.fixtures[0]),
  ).rejects.toThrow('repeated');
  expect(
    remote.mock.calls.every((call) => call[3]?.recordArtifact === false),
  ).toBe(true);
  for (const value of [values[0], GITHUB_TOKEN])
    expect(JSON.stringify(remote.mock.calls)).not.toContain(value);
  for (const fixture of w.fixtures)
    w.state.attempts.get(fixture.ref.id)!.ended_at = Date.now();
  await w.adapter.nativeAbsence(w.fixtures[0], 1_000);
  await w.adapter.releaseResources(w.fixtures[0]);
  expect(w.state.credential).toBe(true);
  expect(w.state.secrets.size).toBe(3);
  await w.adapter.nativeAbsence(w.fixtures[1], 1_000);
  await w.adapter.releaseResources(w.fixtures[1]);
  expect(w.state.credential).toBe(false);
  expect(w.state.secrets.size).toBe(0);
  const recorded = (
    await Promise.all(
      (await readdir(w.directory))
        .filter((name) => name.endsWith('.json'))
        .map((name) => readFile(path.join(w.directory, name), 'utf8')),
    )
  ).join('\n');
  for (const value of [...values, 'from-secret', GITHUB_TOKEN])
    expect(recorded).not.toContain(value);
  expect(recorded).toContain('"environment": true');
});

test('a lost second runtime-secret save reply preserves intent and cleanup uses its independent signal', async () => {
  const w = await harness(runtimeSecretProfile, { deferPreparation: true });
  w.state.lostSecretReply = `job-wandb-${ids[0]}`;
  await expect(w.prepare()).rejects.toThrow();
  expect(w.state.secrets.size).toBe(2);
  expect(
    w.state.secretRequests
      .filter((request) => request.method === 'PUT')
      .every((request) => request.registered),
  ).toBe(true);
  expect(w.calls.some(({ args }) => args[0] === 'job')).toBe(false);
  w.foreground.abort();
  await w.cleanup.run();
  expect(w.state.secrets.size).toBe(0);
  expect(
    w.state.secretRequests
      .filter((request) => request.method !== 'PUT')
      .every((request) => !request.aborted),
  ).toBe(true);
  expect(w.cleanup.observations().every((entry) => entry.completed)).toBe(true);
});

test('runtime-secret observations reject copied fixtures and controller replacement before a second SSH request', async () => {
  const w = await harness(runtimeSecretProfile);
  const remote = vi.spyOn(w.remote, 'run').mockImplementation(async () => {
    w.replace();
    return commandResultForTest({
      stdout: `${'a'.repeat(64)}\n${'b'.repeat(64)}\n${'c'.repeat(64)}`,
    });
  });
  await expect(
    w.adapter.runtimeSecretFacts({ ...w.fixtures[0] }),
  ).rejects.toThrow('copied');
  expect(remote).not.toHaveBeenCalled();
  await expect(w.adapter.runtimeSecretFacts(w.fixtures[0])).rejects.toThrow(
    'controller',
  );
  expect(remote).toHaveBeenCalledOnce();
  expect(
    w.cleanup
      .observations()
      .filter((entry) => entry.label.startsWith('secret '))
      .every((entry) => !entry.completed),
  ).toBe(true);
});

test('runtime-secret force deletion cannot accept a still-present bundle or release its registration', async () => {
  const w = await harness(runtimeSecretProfile);
  w.state.retainSecret = true;
  await expect(
    w.adapter.forceDeleteRuntimeSecret(w.fixtures[0]),
  ).rejects.toThrow('remains after deletion');
  expect(
    w.cleanup
      .observations()
      .find((entry) => entry.label === `secret job-hf-${ids[0]}`)?.completed,
  ).toBe(false);
  expect(w.state.credential).toBe(true);
  expect(
    w.records.some(({ label }) => label.endsWith('-runtime-secret-deleted')),
  ).toBe(false);
});

test('runtime-secret deletion retains intent when its controller changes before absence readback', async () => {
  const w = await harness(runtimeSecretProfile);
  w.state.replaceOnSecretDelete = true;
  await expect(
    w.adapter.forceDeleteRuntimeSecret(w.fixtures[0]),
  ).rejects.toThrow('controller');
  expect(
    w.cleanup
      .observations()
      .find((entry) => entry.label === `secret job-hf-${ids[0]}`)?.completed,
  ).toBe(false);
  expect(
    w.state.secretRequests.filter((request) => request.method === 'GET'),
  ).toEqual([]);
});

test('runtime-secret fallback refuses a replacement controller and retains every original bundle registration', async () => {
  const w = await harness(runtimeSecretProfile);
  const callsBefore = w.state.secretRequests.length;
  w.replace();
  await expect(w.cleanup.run()).rejects.toThrow();
  expect(w.state.secretRequests).toHaveLength(callsBefore);
  expect(
    w.cleanup
      .observations()
      .filter((entry) => entry.label.startsWith('secret '))
      .every((entry) => !entry.completed),
  ).toBe(true);
});

test('runtime-secret save cannot continue preparation on a replacement controller', async () => {
  const w = await harness(runtimeSecretProfile, { deferPreparation: true });
  w.state.replaceOnSecretSave = true;
  await expect(w.prepare()).rejects.toThrow('controller');
  expect(w.state.secretRequests).toHaveLength(1);
  expect(
    w.cleanup
      .observations()
      .find((entry) => entry.label === `secret job-hf-${ids[0]}`)?.completed,
  ).toBe(false);
  await expect(w.cleanup.run()).rejects.toThrow('controller');
  expect(w.state.secretRequests).toHaveLength(1);
});

test('runtime-secret absence cannot complete against a replacement during list readback', async () => {
  const w = await harness(runtimeSecretProfile);
  w.state.replaceOnSecretRead = true;
  await expect(
    w.adapter.forceDeleteRuntimeSecret(w.fixtures[0]),
  ).rejects.toThrow('controller');
  expect(w.state.secretRequests.slice(-2).map(({ method }) => method)).toEqual([
    'DELETE',
    'GET',
  ]);
  expect(
    w.cleanup
      .observations()
      .find((entry) => entry.label === `secret job-hf-${ids[0]}`)?.completed,
  ).toBe(false);
});

test('0047/S2 a restricted Job is observed with the account credential, which can read every region it tried', () => {
  // The unpinned case's first attempt is in a region the restricted key may
  // not call EC2 in, so only the account's own key can prove it left nothing.
  const account: VmProfile = {
    slug: 'aws',
    provider: CloudType.AWS,
    credentialName: 'aws-test',
    credential: {
      cloudProvider: CloudType.AWS,
      accessKeyId: 'AKIAACCOUNT',
      secretAccessKey: 'account-secret',
    },
    vmTypes: ['t3.large'],
  };
  const restricted: VmProfile = {
    ...account,
    credentialName: 'bkt-1',
    credential: {
      cloudProvider: CloudType.AWS,
      accessKeyId: 'AKIARESTRICTED',
      secretAccessKey: 'restricted-secret',
    },
    vmTypes: ['t3.small', 'c6i.xlarge'],
  };

  expect(
    jobHostProbeProfile(account, restricted, undefined, {
      key: 'unpinned',
      scenario: 'S2',
      vmType: 'c6i.xlarge',
    }),
  ).toEqual({
    ...restricted,
    credential: account.credential,
    vmTypes: ['c6i.xlarge'],
    region: undefined,
  });
  expect(jobHostProbeProfile(account, restricted)).toBe(restricted);
});

test('real AWS host Job preparation sends no unrelated storage intent or placement override', async () => {
  const hostProfile = jobMemberProfile(
    { kind: 'host-recovery', target: 'aws' },
    {
      optional: (_name, fallback = '') => fallback,
      milliseconds: (_name, seconds) => seconds * 1000,
    },
  );
  const w = await harness(hostProfile);
  expect(w.fixtures).toHaveLength(1);
  expect(w.fixtures[0].inputBucket).toBeUndefined();
  expect(w.fixtures[0].outputBucket).toBeUndefined();
  expect(w.fixtures[0].checkpointBucket).toBeUndefined();
  expect(w.records.some(({ label }) => label.startsWith('job-bucket-'))).toBe(
    false,
  );
  expect(w.nativeCalls).toEqual([]);
  await w.adapter.submit(w.fixtures[0]);
  const sent = w.calls.find(({ args }) => args[0] === 'job')!.args;
  expect(sent).toEqual([
    'job',
    '--id',
    ids[0],
    '--credentials',
    'aws-test',
    '--vm-type',
    't3.large',
    'nginx:alpine',
  ]);
  expect(w.state.bucket).toBe(false);
  w.state.attempts.get(ids[0])!.ended_at = Date.now();
  await w.native.verify(w.fixtures[0].ref, 1_000);
  expect(
    w.records.find(({ label }) => label === `job-${ids[0]}-native-cleanup`)
      ?.body,
  ).toMatchObject({ completed: true, authorizedCreates: 1 });
});

test('a boot volume left after its VM keeps real Job native cleanup from completing', async () => {
  const w = await harness(
    jobMemberProfile(
      { kind: 'host-recovery', target: 'aws' },
      {
        optional: (_name, fallback = '') => fallback,
        milliseconds: (_name, seconds) => seconds * 1000,
      },
    ),
  );
  await w.adapter.submit(w.fixtures[0]);
  w.state.attempts.get(ids[0])!.ended_at = Date.now();
  w.state.leakedVolume = true;
  await expect(w.native.verify(w.fixtures[0].ref, 1_000)).rejects.toThrow();
  expect(
    w.records.find(({ label }) => label === `job-${ids[0]}-native-cleanup`)
      ?.body,
  ).toMatchObject({
    completed: false,
    observations: expect.arrayContaining([
      expect.objectContaining({ presence: 'present' }),
    ]),
  });
});

test('real Spot preparation retains its checkpoint intent and cleanup completes after the kernel releases its reference', async () => {
  const spotProfile = jobMemberProfile(
    { kind: 'spot-request-cleanup', target: 'aws' },
    {
      optional: (_name, fallback = '') => fallback,
      milliseconds: (_name, seconds) => seconds * 1000,
    },
  );
  const w = await harness(spotProfile);
  const fixture = w.fixtures[0];
  expect(fixture.inputBucket).toBeUndefined();
  expect(fixture.outputBucket).toBeUndefined();
  expect(fixture.checkpointBucket).toBe(fixture.ref.id);
  await w.adapter.submit(fixture);
  const submitted = w.calls.find(({ args }) => args[0] === 'job')?.args ?? [];
  expect(submitted).toEqual([
    'job',
    '--id',
    fixture.ref.id,
    '--credentials',
    'aws-test',
    '--vm-type',
    't3.large',
    '--spot',
    'nginx:alpine',
  ]);
  const action = vi.fn();
  const command = createSubmitCommand().exitOverride().action(action);
  await command.parseAsync(submitted.slice(1), { from: 'user' });
  expect(action).toHaveBeenCalledOnce();
  expect(command.args).toEqual(['nginx:alpine']);
  expect(command.opts()).toMatchObject({
    id: fixture.ref.id,
    credentials: 'aws-test',
    vmType: ['t3.large'],
    spot: true,
  });
  expect(command.opts().region).toBeUndefined();
  expect(command.opts().checkpointBucket).toBeUndefined();
  const [attempt] = await w.adapter.attempts(fixture);
  await expect(
    w.adapter.spot(fixture).active(attempt, Date.now() + 60_000),
  ).resolves.toMatchObject({ state: 'active', type: 'persistent' });
  await w.cleanup.run();
  expect(w.cleanup.observations().every((entry) => entry.completed)).toBe(true);
  expect(w.state.spotRequestState).toBe('cancelled');
  expect(w.state.credential).toBe(false);
  expect(
    w.records.find(
      ({ label }) => label === `job-${fixture.ref.id}-native-cleanup`,
    )?.body,
  ).toMatchObject({ completed: true, authorizedCreates: 1 });
  expect(
    w.records.some(({ body }) =>
      JSON.stringify(body).includes('rescue-result'),
    ),
  ).toBe(true);
});

test('Lambda bucket-sync passes its explicit checkpoint with the cross-cloud storage credential', async () => {
  const w = await harness();
  const sent = vi.spyOn(w.transport, 'submit').mockResolvedValue();
  const profile = jobMemberProfile(
    { kind: 'bucket-sync', target: 'lambda' },
    {
      optional: (_name, fallback = '') => fallback,
      milliseconds: (_name, seconds) => seconds * 1000,
    },
  );
  await w.adapter.submit({
    ref: trackedWorkloadRefForTest('lambda-bucket'),
    profile,
    credentialName: 'lambda-test',
    storageCredentialName: 'aws-storage',
    inputBucket: 'j-input-lambda-bucket',
    outputBucket: 'j-output-lambda-bucket',
    checkpointBucket: 'ckpt-lambda-bucket-host',
    runLabel: 'lambda-bucket',
    concurrentIndex: 0,
    concurrentWrites: [],
  });
  const args = sent.mock.calls[0][1];
  const flag = (name: string) => args[args.indexOf(name) + 1];
  expect(flag('--checkpoint-bucket')).toBe('ckpt-lambda-bucket-host');
  expect(flag('--checkpoint-storage-credentials')).toBe('aws-storage');
  expect(flag('--checkpoint-storage-region')).toBe(profile.storageRegion);
});

test('Azure host Job keeps its explicit checkpoint on the selected compute identity managed-identity path', async () => {
  const w = await harness();
  const sent = vi.spyOn(w.transport, 'submit').mockResolvedValue();
  const hostProfile = jobMemberProfile(
    { kind: 'host-recovery', target: 'azure' },
    {
      optional: (_name, fallback = '') => fallback,
      milliseconds: (_name, seconds) => seconds * 1000,
    },
  );
  const fixture = {
    ref: trackedWorkloadRefForTest('azure-host'),
    profile: hostProfile,
    credentialName: 'azure-test',
    storageCredentialName: 'azure-test',
    checkpointBucket: 'ckpt-azure-host',
    runLabel: 'azure-host',
    concurrentIndex: 0,
    concurrentWrites: [],
  };
  await w.adapter.submit(fixture);
  expect(sent.mock.calls[0][1]).toEqual([
    'job',
    '--id',
    'azure-host',
    '--credentials',
    'azure-test',
    '--vm-type',
    'Standard_D2s_v5',
    '--checkpoint-bucket',
    'ckpt-azure-host',
    '--checkpoint-storage-region',
    'eastus',
    'nginx:alpine',
  ]);
  expect(() =>
    w.adapter.submit({ ...fixture, checkpointBucket: undefined }),
  ).toThrow('original explicit checkpoint');
  expect(sent).toHaveBeenCalledTimes(1);
});

test('the runtime late-input probe removes only its uploaded object through the single-object CLI path', async () => {
  vi.spyOn(JobCloudStorage.prototype, 'create').mockResolvedValue();
  vi.spyOn(transfers, 'prepareJobTransfers').mockResolvedValue({
    listedBucket: true,
    rootObject: true,
    nestedPrefix: true,
    literalPrefix: true,
    recursiveObjects: true,
  });
  const transfer = vi
    .spyOn(JobCloudStorage.prototype, 'transfer')
    .mockResolvedValue();
  const w = await harness({
    ...profile,
    member: { kind: 'bucket-sync', target: 'aws' },
  });
  vi.spyOn(w.commands, 'wait').mockResolvedValue();
  vi.spyOn(w.remote, 'run').mockImplementation(
    async (_id, _runtime, command) => {
      const stdout = command.includes('READ_ONLY')
        ? 'READ_ONLY'
        : command.includes('ABSENT')
          ? 'ABSENT'
          : command.includes('ANYCLOUD_TEST_ENV')
            ? ids[0]
            : command.includes('nvidia-smi')
              ? 'NVIDIA A10\n'
              : 'active';
      return commandResultForTest({ stdout });
    },
  );
  await expect(w.transport.runtime(w.fixtures[0])).resolves.toEqual({
    gpus: ['NVIDIA A10'],
    inputReadOnly: true,
    lateInputAbsent: true,
    environment: true,
    logsFollower: true,
  });
  const key = `no-sync-${ids[0]}.txt`;
  const [bucket, operation, args] = transfer.mock.calls[1];
  expect(operation).toBe('rm');
  const requests: Request[] = [];
  // A remote API takes its own token, here from the environment.
  vi.stubEnv('API_URL', 'http://job-cli.invalid');
  vi.stubEnv('ANYCLOUD_API_TOKEN', 'acapi_test-cli-token');
  vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('Real bucket CLI command rejected the transport arguments');
  });
  vi.stubGlobal('fetch', async (request: unknown) => {
    if (!(request instanceof Request))
      throw new Error('Unexpected CLI request');
    requests.push(request);
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/v1/credentials')
      return Response.json([
        { name: 'aws-test', cloudProvider: CloudType.AWS },
      ]);
    if (
      request.method === 'DELETE' &&
      url.pathname === `/v1/credentials/aws-test/buckets/${bucket.name}/objects`
    )
      return new Response(null, { status: 204 });
    throw new Error('Unexpected CLI API operation');
  });
  // Execute the real parser, option constraints and SDK request. Only its
  // authentication and HTTP boundary are controlled; --yes alone must fail.
  await createBucketRmCommand().parseAsync([
    'node',
    'test',
    bucket.name,
    ...args,
    '--credentials',
    'aws-test',
    '--region',
    profile.storageRegion,
  ]);
  expect(requests.map((request) => request.method)).toEqual(['GET', 'DELETE']);
  expect(Object.fromEntries(new URL(requests[1].url).searchParams)).toEqual({
    region: profile.storageRegion,
    remotePath: key,
  });
  expect(requests[1].headers.get('authorization')).toBe(
    'Bearer acapi_test-cli-token',
  );
  expect(
    transfer.mock.calls.map(([, operation, args]) => [operation, args]),
  ).toEqual([
    ['upload', [expect.any(String), key]],
    ['rm', [key]],
  ]);
  expect(await readFile(transfer.mock.calls[0][2][0], 'utf8')).toBe(
    `late-${ids[0]}`,
  );
});

test('real Job composition resolves a lost AWS launch reply with the original native account after foreground cancellation', async () => {
  const w = await harness();
  w.state.reserveOnSend = true;
  w.state.reservationIds = ['i-77777777777777777'];
  await w.adapter.submit(w.fixtures[0]);
  w.state.attempts.get(ids[0])!.ended_at = Date.now();
  w.foreground.abort();
  await w.native.verify(w.fixtures[0].ref, 1_000);
  const calls = w.nativeCalls.filter(
    ({ args }) => args[1] === 'describe-instances',
  );
  expect(calls).toHaveLength(2);
  expect(
    calls.every(
      (call) =>
        call.signalAborted === false &&
        call.accessKeyId === material.accessKeyId &&
        call.recordArtifact === false &&
        call.args[call.args.indexOf('--region') + 1] === 'us-west-2',
    ),
  ).toBe(true);
  expect(calls[0].args).toContain('--filters');
  expect(calls[1].args).toContain('i-77777777777777777');
  expect(
    w.records.find(({ label }) => label === `job-${ids[0]}-native-cleanup`)
      ?.body,
  ).toMatchObject({
    completed: true,
    authorizedCreates: 1,
    attemptHistory: [
      expect.objectContaining({ cloudId: `${ids[0]}-0`, ip: null }),
      expect.objectContaining({ cloudId: `${ids[0]}-0`, ip: null }),
    ],
    reservationMatches: [
      { location: { cloudId: 'i-77777777777777777', region: 'us-west-2' } },
    ],
  });
  // The native owner proves absence; only the existing family/kernel may release.
  expect(
    await readFile(path.join(w.directory, 'workloads-to-clean'), 'utf8'),
  ).toContain(ids[0]);
  expect(w.state.credential).toBe(true);
});

test('real Job composition retains a first-page match and original cleanup registrations after a later AWS authentication failure', async () => {
  const w = await harness();
  w.state.reserveOnSend = true;
  w.state.reservationIds = ['i-77777777777777777'];
  w.state.failReservationSuffix = true;
  await w.adapter.submit(w.fixtures[0]);
  w.state.attempts.get(ids[0])!.ended_at = Date.now();
  await expect(w.native.verify(w.fixtures[0].ref, 1_000)).rejects.toThrow(
    /authorization|credential|authentication/iu,
  );
  expect(
    w.records.find(({ label }) => label === `job-${ids[0]}-native-cleanup`)
      ?.body,
  ).toMatchObject({
    completed: false,
    reservationObservations: [
      { inventory: { complete: false, pages: 1, instances: 1 } },
    ],
    reservationMatches: [{ location: { cloudId: 'i-77777777777777777' } }],
  });
  await expect(w.cleanup.run()).rejects.toThrow();
  expect(w.state.credential).toBe(true);
  expect(
    await readFile(path.join(w.directory, 'workloads-to-clean'), 'utf8'),
  ).toContain(ids[0]);
  expect(w.cleanup.observations().some((entry) => !entry.completed)).toBe(true);
});

test('a replacement during the first inventory cannot authorize a Workload send', async () => {
  const w = await harness();
  const gate = barrier();
  w.state.gate = gate;
  const pending = w.adapter.submit(w.fixtures[0]);
  await gate.entered;
  w.replace();
  gate.release();
  await expect(pending).rejects.toThrow('original controller');
  expect(w.calls.filter(({ args }) => args[0] === 'job')).toEqual([]);
  expect(w.ledger.observations(w.fixtures[0].ref)).toEqual([]);
  await w.native.recordObservations();
  expect(
    w.records.find(({ label }) => label === `job-${ids[0]}-attempt-history`)
      ?.body,
  ).toMatchObject({
    originalIdentity: { controller: { url: w.original.url, generation: 1 } },
    creations: [],
  });
  await expect(w.cleanup.run()).rejects.toThrow();
  expect(w.calls.filter(({ args }) => args[0] === 'terminate')).toEqual([]);
  expect(w.state.credential).toBe(true);
  expect(w.cleanup.observations().some((entry) => !entry.completed)).toBe(true);
  expect(
    await readFile(path.join(w.directory, 'workloads-to-clean'), 'utf8'),
  ).toContain(ids[0]);
});

test('a final send guard rejects replacement after the successful inventory fence', async () => {
  const w = await harness();
  const creationStarted = w.native.creationStarted.bind(w.native);
  vi.spyOn(w.native, 'creationStarted').mockImplementation(async (...args) => {
    await creationStarted(...args);
    w.replace();
  });
  await expect(w.adapter.submit(w.fixtures[0])).rejects.toThrow(
    'identity capture failed',
  );
  expect(w.calls.filter(({ args }) => args[0] === 'job')).toEqual([]);
  await w.native.recordObservations();
  expect(
    w.records.find(({ label }) => label === `job-${ids[0]}-attempt-history`)
      ?.body,
  ).toMatchObject({
    originalIdentity: { controller: { generation: 1 } },
    creations: [{ ordinal: 1, resolvedRowIds: [] }],
  });
  await expect(w.cleanup.run()).rejects.toThrow();
  expect(w.calls.filter(({ args }) => args[0] === 'terminate')).toEqual([]);
  expect(w.state.credential).toBe(true);
});

test('a later sibling cannot reuse group arming on a replacement controller', async () => {
  const w = await harness();
  await w.adapter.submit(w.fixtures[0]);
  w.replace();
  await expect(w.adapter.submit(w.fixtures[1])).rejects.toThrow(
    'original controller',
  );
  expect(
    w.calls
      .filter(({ args }) => args[0] === 'job')
      .map(({ generation }) => generation),
  ).toEqual([1]);
  expect(
    w.records.find(({ label }) => label === `job-${ids[0]}-credential-binding`)
      ?.body,
  ).toMatchObject({
    controller: { generation: 1 },
    generation: 1,
    credential: { recordId },
  });
  await expect(w.cleanup.run()).rejects.toThrow();
  expect(w.calls.filter(({ args }) => args[0] === 'terminate')).toEqual([]);
  expect(w.state.credential).toBe(true);
  expect(w.state.bucket).toBe(true);
});

test('post-send capture does not adopt replacement-controller rows and retains the unresolved original send', async () => {
  const w = await harness();
  w.state.replaceAfterSend = true;
  await expect(w.adapter.submit(w.fixtures[0])).rejects.toThrow(
    'original controller',
  );
  expect(
    w.calls
      .filter(({ args }) => args[0] === 'job')
      .map(({ generation }) => generation),
  ).toEqual([1]);
  expect(
    w.calls.filter(
      ({ args, generation }) => args[0] === 'db' && generation === 2,
    ),
  ).toEqual([]);
  expect(w.ledger.observations(w.fixtures[0].ref)).toEqual([]);
  await w.native.recordObservations();
  expect(
    w.records.find(({ label }) => label === `job-${ids[0]}-attempt-history`)
      ?.body,
  ).toMatchObject({
    originalIdentity: { controller: { generation: 1 } },
    attemptHistory: [],
    creations: [{ ordinal: 1, resolvedRowIds: [] }],
  });
  await expect(w.cleanup.run()).rejects.toThrow();
  expect(w.calls.filter(({ args }) => args[0] === 'terminate')).toEqual([]);
  expect(w.state.credential).toBe(true);
  expect(w.state.bucket).toBe(true);
});

test('ordinary cleanup during inventory still prevents later sends and completes known-unsent resources', async () => {
  const w = await harness();
  const gate = barrier();
  w.state.gate = gate;
  const pending = w.adapter.submit(w.fixtures[0]).then(
    () => undefined,
    (error: unknown) => error,
  );
  await gate.entered;
  await w.cleanup.run();
  gate.release();
  expect(await pending).toBeInstanceOf(Error);
  expect(w.calls.filter(({ args }) => args[0] === 'job')).toEqual([]);
  expect(w.state.credential).toBe(false);
  expect(w.cleanup.observations().every((entry) => entry.completed)).toBe(true);
});

test('both spot-request-cleanup Jobs share one group and one imported credential, each with its own Spot request owner', async () => {
  const spotProfile = jobMemberProfile(
    { kind: 'spot-request-cleanup', target: 'aws' },
    {
      optional: (_name, fallback = '') => fallback,
      milliseconds: (_name, seconds) => seconds * 1000,
    },
  );
  const w = await harness(spotProfile, { deferPreparation: true });
  const save = vi.mocked(w.api.saveCredential);
  save.mockClear();
  const fixtures = await w.transport.prepare(ids.slice(0, 2), spotProfile, {
    runningMs: 1000,
    cleanupMs: 10000,
    storageMs: 1000,
    completionMs: 1000,
  });
  // A second group would import the same name again and be refused.
  expect(save).toHaveBeenCalledOnce();
  expect(fixtures.map(({ ref }) => ref.id)).toEqual(ids.slice(0, 2));
  // Each Job's Spot owner is its own: binding the first Job's request
  // leaves the unsent early Job's owner without one.
  await w.adapter.submit(fixtures[0]);
  const [attempt] = await w.adapter.attempts(fixtures[0]);
  await w.transport.spot(fixtures[0]).active(attempt, Date.now() + 60_000);
  await expect(
    w.transport.spot(fixtures[0]).request(Date.now() + 60_000),
  ).resolves.toMatchObject({ state: 'active' });
  await expect(
    w.transport.spot(fixtures[1]).request(Date.now() + 60_000),
  ).rejects.toThrow('Job Spot has no original active request');
  // What paid run 42693764072 hit: a one-Job second group is refused,
  // first by the group guard, and its import would find the name owned.
  await expect(
    w.transport.prepare([ids[2]], spotProfile, {
      runningMs: 1000,
      cleanupMs: 10000,
      storageMs: 1000,
      completionMs: 1000,
    }),
  ).rejects.toThrow('Cloud Job group has an invalid member or identity');
});

const GROUP_GUARD = 'Cloud Job group has an invalid member or identity';
test.each(
  Object.entries(JOB_MEMBERS).flatMap(([kind, targets]) =>
    targets
      .filter((target) => target !== 'local-smolvm')
      .map((target) => {
        const member = { kind, target };
        return member as JobMemberProfile['member'];
      }),
  ),
)(
  'the real preparation guard admits exactly the group the %j member finalizes',
  async (member) => {
    const environment = {
      optional: (_name: string, fallback = '') => fallback,
      milliseconds: (_name: string, seconds: number) => seconds * 1000,
    };
    const selected = jobMemberProfile(member, environment);
    const size = jobGroupSize(selected)!;
    const w = await harness(selected, { deferPreparation: true });
    const group = (count: number) =>
      w.transport
        .prepare(
          Array.from({ length: count }, (_, index) => `guard-child-${index}`),
          selected,
          jobStageBudget(member, environment),
        )
        .then(
          () => undefined,
          (error: unknown) => (error instanceof Error ? error.message : ''),
        );
    // Past the guard, preparation stops at the harness's first external call.
    expect(await group(size)).not.toBe(GROUP_GUARD);
    expect(await group(size + 1)).toBe(GROUP_GUARD);
  },
);

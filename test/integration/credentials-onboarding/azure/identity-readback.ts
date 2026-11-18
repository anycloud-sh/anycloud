import { createHash } from 'node:crypto';
import { z } from 'zod';

import { cloudCredentialSchema } from '../../../../src/shared/api-contract/credentials-schemas.js';
import { CloudType } from '../../../../src/shared/cloud.js';
import type { Redactor } from '../../e2e/internal/artifacts.js';
import type { FixtureFiles } from '../../e2e/internal/files.js';
import type { ProcessRunner } from '../../e2e/internal/process.js';
import { JobCloudSession } from '../../e2e/internal/transports/job-cloud-session.js';
import {
  JobPrivateCommands,
  privateJobJson,
} from '../../e2e/internal/transports/job-command.js';
import { isRecord } from '../../e2e/internal/types.js';

const sha = z.string().regex(/^[a-f0-9]{40}$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const guid = z.string().regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u);
const observerSchema = z
  .object({
    source: sha,
    runId: z.number().int().positive().safe(),
    attempt: z.number().int().positive().safe(),
  })
  .strict();
const requestSchema = observerSchema
  .extend({
    member: z.literal('azure-bucket-sync'),
    base: sha,
    fixtureRunId: z.string().regex(/^[a-f0-9]{10}$/u),
    recordId: digest,
    subscriptionIdSha256: digest,
    applicationId: guid,
    applicationObjectId: guid,
    displayName: z.string().regex(/^anycloud-bkt-[0-9]{1,20}$/u),
  })
  .strict();

interface ProcessReceipt {
  readonly operation: 'login' | 'scope' | 'app' | 'sp';
  readonly startedAt: number;
  readonly timeoutMs: number;
  readonly forceKillGraceMs: 1000;
  reaped: boolean;
  completedAt?: number;
  durationMs?: number;
  exitCode?: number | null;
  signal?: string | null;
  timedOut?: boolean;
  aborted?: boolean;
  outputTruncated?: boolean;
  spawnErrorPresent?: boolean;
}

interface DirectoryObservation {
  readonly kind: 'app' | 'sp';
  readonly observedAt: number;
  complete: boolean;
  readonly identities: Array<{
    id: string;
    appId: string;
    displayName: string;
  }>;
}

export interface AzureIdentityReadback {
  readonly version: 1;
  readonly kind: 'read-only-failed-resource-diagnostic';
  readonly startedAt: number;
  completedAt: number;
  readonly maximumCommands: 4;
  readonly perCommandTimeoutMs: 30000;
  readonly totalTimeoutMs: 120000;
  readonly mutations: 0;
  request?: z.infer<typeof requestSchema>;
  observer?: z.infer<typeof observerSchema>;
  authorizationBindings?: { expected: string; actual?: string };
  scopeMatched: boolean;
  readonly processes: ProcessReceipt[];
  readonly observations: DirectoryObservation[];
  complete: boolean;
  absent: boolean;
  failureStage?: string;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Temporary Job comparison diagnostic; it observes identity and never owns cleanup. */
export async function inspectAzureJobIdentity(
  requestInput: unknown,
  credentialInput: unknown,
  observerInput: unknown,
  dependencies: {
    readonly runner: Pick<ProcessRunner, 'run'>;
    readonly files: Pick<FixtureFiles, 'directory' | 'privateText'>;
    readonly redactor: Pick<Redactor, 'add'>;
    readonly signal: AbortSignal;
    readonly originalRun?: unknown;
  },
): Promise<AzureIdentityReadback> {
  const startedAt = Date.now();
  const deadlineAt = startedAt + 120_000;
  const receipt: AzureIdentityReadback = {
    version: 1,
    kind: 'read-only-failed-resource-diagnostic',
    startedAt,
    completedAt: startedAt,
    maximumCommands: 4,
    perCommandTimeoutMs: 30_000,
    totalTimeoutMs: 120_000,
    mutations: 0,
    scopeMatched: false,
    processes: [],
    observations: [],
    complete: false,
    absent: false,
  };
  let stage = 'request';
  try {
    const request = requestSchema.parse(requestInput);
    receipt.request = request;
    stage = 'observer';
    receipt.observer = observerSchema.parse(observerInput);
    if (dependencies.originalRun !== undefined) {
      stage = 'original-run';
      const original = observerSchema
        .pick({ runId: true, attempt: true })
        .parse(dependencies.originalRun);
      if (
        original.runId !== request.runId ||
        original.attempt !== request.attempt
      )
        throw new Error('Original Azure Job run or attempt does not match');
    }
    stage = 'original-authorization';
    const credential = cloudCredentialSchema.parse(credentialInput);
    receipt.authorizationBindings = { expected: request.recordId };
    if (credential.cloudProvider !== CloudType.Azure)
      throw new Error('Azure authorization is required');
    // Match the API's canonical parsed material, including its original tenant.
    const recordId = hash(JSON.stringify(credential));
    receipt.authorizationBindings.actual = recordId;
    if (
      recordId !== request.recordId ||
      hash(credential.subscriptionId) !== request.subscriptionIdSha256 ||
      request.applicationId === credential.applicationId
    )
      throw new Error('Original Azure authorization or scope does not match');
    const commands = new JobPrivateCommands(
      {
        run: async (executable, args, options) => {
          const operation = (['login', 'scope', 'app', 'sp'] as const)[
            receipt.processes.length
          ];
          const expected = [
            ['login'],
            ['account', 'show'],
            ['ad', 'app', 'list'],
            ['ad', 'sp', 'list'],
          ][receipt.processes.length];
          if (
            !operation ||
            !expected ||
            executable !== 'az' ||
            expected.some((value, index) => args[index] !== value) ||
            options?.recordArtifact !== false
          )
            throw new Error('Unexpected Azure readback command');
          // ProcessRunner awaits drainage/reaping and has a one-second kill grace.
          const timeoutMs = Math.min(29_000, deadlineAt - Date.now() - 1_000);
          if (timeoutMs <= 0) throw new Error('Readback deadline exhausted');
          const process: ProcessReceipt = {
            operation,
            startedAt: Date.now(),
            timeoutMs,
            forceKillGraceMs: 1_000,
            reaped: false,
          };
          receipt.processes.push(process);
          const result = await dependencies.runner.run(executable, args, {
            ...options,
            timeoutMs,
          });
          Object.assign(process, {
            reaped: result.spawnError === undefined,
            completedAt: Date.now(),
            durationMs: result.durationMs,
            exitCode: result.exitCode,
            signal: result.signal,
            timedOut: result.timedOut,
            aborted: result.aborted,
            outputTruncated: result.outputTruncated,
            spawnErrorPresent: result.spawnError !== undefined,
          });
          if (result.durationMs > 30_000 || Date.now() > deadlineAt)
            throw new Error('Readback command exceeded its declared budget');
          return result;
        },
      },
      AbortSignal.any([dependencies.signal, AbortSignal.timeout(119_000)]),
    );
    const session = new JobCloudSession({
      name: 'azure-job-identity-readback',
      credential,
      commands,
      cleanupCommands: commands,
      files: dependencies.files,
      redactor: dependencies.redactor,
    });
    stage = 'login-and-scope';
    await session.initialize(deadlineAt);
    receipt.scopeMatched = true;
    for (const kind of ['app', 'sp'] as const) {
      stage = kind;
      const observation: DirectoryObservation = {
        kind,
        observedAt: Date.now(),
        complete: false,
        identities: [],
      };
      receipt.observations.push(observation);
      const body = privateJobJson(
        await session.azure(
          [
            'ad',
            kind,
            'list',
            '--all',
            '--filter',
            `appId eq '${request.applicationId}'`,
            '--output',
            'json',
          ],
          deadlineAt,
        ),
      );
      if (!Array.isArray(body)) throw new Error('Incomplete directory array');
      for (const row of body) {
        if (
          !isRecord(row) ||
          !guid.safeParse(row.id).success ||
          row.appId !== request.applicationId ||
          row.displayName !== request.displayName ||
          (kind === 'app' && row.id !== request.applicationObjectId) ||
          (kind === 'sp' && row.id === request.applicationObjectId) ||
          observation.identities.length !== 0
        )
          throw new Error('Foreign, malformed or ambiguous directory identity');
        observation.identities.push({
          id: String(row.id),
          appId: request.applicationId,
          displayName: request.displayName,
        });
      }
      observation.complete = true;
    }
    receipt.complete = true;
    receipt.absent = receipt.observations.every(
      (value) => value.identities.length === 0,
    );
  } catch {
    // Keep validated prefixes and process receipts; never serialize raw CLI/schema errors.
    receipt.failureStage = stage;
  }
  receipt.completedAt = Date.now();
  return receipt;
}

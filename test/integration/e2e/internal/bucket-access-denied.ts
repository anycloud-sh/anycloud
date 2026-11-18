import assert from 'node:assert/strict';
import { createSign } from 'node:crypto';
import path from 'node:path';

import { CloudType } from '../../../../src/shared/cloud.js';
import type { CloudCredential } from '../../../../src/shared/api-contract/credentials-schemas.js';
import {
  cleanupAWSOnboardingUser,
  createAWSImportFixture,
  createBootstrapAWSContext,
  disposeBootstrapAWSContext,
  runAdminAWS,
} from '../../credentials-onboarding/aws/admin.js';
import {
  AzureTestPrincipal,
  readAzureOnboardingSecrets,
} from '../../credentials-onboarding/azure/admin.js';
import {
  retryUntilDeadline,
  type DeadlineRetryOptions,
} from '../../credentials-onboarding/common/deadline-retry.js';
import {
  cleanupGCPOnboardingAccount,
  createBootstrapGcloudContext,
  createGCPImportFixture,
  disposeBootstrapGcloudContext,
} from '../../credentials-onboarding/gcp/admin.js';
import { createApiClient } from '../../../../src/shared/services/api-client/rpc.js';
import { completedCommand } from './api-assertions.js';
import { declaredApiError, type ApiClient } from './api.js';
import type { CleanupStack } from './cleanup.js';
import { cliArgs } from './cli-surface.js';
import type { CliClient } from './cli.js';
import type { FixtureFiles } from './files.js';
import type { ProcessRunner } from './process.js';
import type { ProviderProfiles } from './profiles.js';
import { isRecord, type CommandResult } from './types.js';

export type DeniedBucketProvider = 'aws' | 'azure' | 'gcp';

export interface BucketAccessDeniedResult {
  readonly scenario: 'bucket-access-denied';
  readonly provider: DeniedBucketProvider;
  readonly satisfied: true;
}

/** The storage regions the bucket-sync members use. */
const REGION: Record<DeniedBucketProvider, string> = {
  aws: 'us-east-1',
  azure: 'eastus',
  gcp: 'us-central1',
};
/** A new key or principal may not authenticate yet; a missing grant needs no wait. */
const DENIAL_READY_MS = 5 * 60_000;
/** Azure retries ARM AuthorizationFailed for about 40 s before it reports denial. */
const DENIED_COMMAND_MS = 3 * 60_000;
const OBJECT = 'denied.txt';

interface Dependencies {
  readonly api: Pick<
    ApiClient,
    'saveCredential' | 'deleteCredential' | 'controller'
  >;
  /** The bearer for a controller URL, read when used (an upgrade replaces it). */
  readonly bearer: (url: string) => string;
  readonly cli: Pick<CliClient, 'run'>;
  readonly runner: Pick<ProcessRunner, 'run'>;
  readonly cleanup: Pick<CleanupStack, 'defer'>;
  readonly files: Pick<FixtureFiles, 'directory' | 'text'>;
  readonly profiles: Pick<ProviderProfiles, 'vm'>;
  readonly runId: string;
}

/** A credential the cloud authenticates but grants nothing, and how to tell it is ready. */
interface DeniedPrincipal {
  // E2E profiles hold keys.
  readonly credential: CloudCredential;
  /** Resolves once the cloud answers this exact identity with a denial. */
  readonly denied: (bucket: string) => Promise<void>;
}

export class Granted extends Error {}

/**
 * Retry until the cloud refuses `attempt` with `denial`; authentication may lag
 * creation. With `holdMs`, every attempt must be refused for that long without
 * a break: any other answer restarts the window.
 */
export function untilDenied(
  attempt: () => Promise<unknown>,
  denial: RegExp,
  {
    readyMs = DENIAL_READY_MS,
    holdMs = 0,
    ...ports
  }: Pick<DeadlineRetryOptions, 'now' | 'wait' | 'random'> & {
    readonly readyMs?: number;
    readonly holdMs?: number;
  } = {},
): Promise<void> {
  const now = ports.now ?? Date.now;
  let deniedSince: number | undefined;
  return retryUntilDeadline(
    async () => {
      try {
        await attempt();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!denial.test(message)) {
          deniedSince = undefined;
          throw error;
        }
        deniedSince ??= now();
        const heldMs = now() - deniedSince;
        if (heldMs >= holdMs) return;
        throw new Error(`${message}, held ${Math.round(heldMs / 1_000)}s`);
      }
      throw new Granted('The no-grant principal was allowed the bucket read');
    },
    {
      ...ports,
      deadline: now() + readyMs,
      initialDelayMs: 1_000,
      maxDelayMs: 15_000,
      shouldRetry: (error) => !(error instanceof Granted),
    },
  );
}

const AZURE_DENIED = 'ARM 403 AuthorizationFailed';
/**
 * A new Azure secret or GCP key is not accepted everywhere at once: runs
 * 37762370054 and 37776021622 saw sign-ins fail after earlier ones worked.
 */
const FRESH_KEY_HOLD_MS = 3 * 60_000;
const FRESH_KEY_READY_MS = 15 * 60_000;

/** One fresh client-credentials sign-in and one ARM read; neither secret nor token is returned. */
async function azureDenial(
  principal: {
    readonly applicationId: string;
    readonly secret: string;
    readonly tenantId: string;
    readonly subscriptionId: string;
  },
  name: string,
): Promise<string> {
  const grant = await fetch(
    `https://login.microsoftonline.com/${principal.tenantId}/oauth2/v2.0/token`,
    {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: principal.applicationId,
        client_secret: principal.secret,
        scope: 'https://management.azure.com/.default',
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  const issued: unknown = await grant.json().catch(() => undefined);
  if (!isRecord(issued) || typeof issued.access_token !== 'string')
    return `Entra ${grant.status} ${isRecord(issued) ? String(issued.error_codes) : ''}`;
  const response = await fetch(
    `https://management.azure.com/subscriptions/${principal.subscriptionId}/resourcegroups/anycloud-${name}?api-version=2021-04-01`,
    {
      headers: { Authorization: `Bearer ${issued.access_token}` },
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (response.ok) return 'granted';
  const body: unknown = await response.json().catch(() => undefined);
  const code =
    isRecord(body) && isRecord(body.error) ? body.error.code : undefined;
  return `ARM ${response.status} ${String(code)}`;
}

const GCP_DENIED = 'GCS 403';
/** The endpoint and audience gtoken uses for the product's Storage client. */
const GCP_TOKEN_URL = 'https://www.googleapis.com/oauth2/v4/token';

/** One fresh JWT-bearer token mint and one GCS bucket read; neither key nor token is returned. */
async function gcpDenial(
  key: { readonly clientEmail: string; readonly privateKey: string },
  bucket: string,
): Promise<string> {
  const issuedAt = Math.floor(Date.now() / 1_000);
  const part = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({
    iss: key.clientEmail,
    scope: 'https://www.googleapis.com/auth/devstorage.read_only',
    aud: GCP_TOKEN_URL,
    iat: issuedAt,
    exp: issuedAt + 600,
  })}`;
  const signature = createSign('RSA-SHA256')
    .update(unsigned)
    .sign(key.privateKey, 'base64url');
  const grant = await fetch(GCP_TOKEN_URL, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${signature}`,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const issued: unknown = await grant.json().catch(() => undefined);
  if (!isRecord(issued) || typeof issued.access_token !== 'string')
    return `OAuth ${grant.status} ${isRecord(issued) ? `${String(issued.error)}: ${String(issued.error_description)}` : ''}`;
  const response = await fetch(
    `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}`,
    {
      headers: { Authorization: `Bearer ${issued.access_token}` },
      signal: AbortSignal.timeout(30_000),
    },
  );
  await response.body?.cancel();
  return response.ok ? 'granted' : `GCS ${response.status}`;
}

function refused(result: CommandResult, label: string): void {
  assert.notEqual(result.exitCode, 0, `${label} unexpectedly succeeded`);
  assert.notEqual(result.exitCode, null, `${label} did not exit normally`);
  assert.equal(result.timedOut, false, `${label} timed out`);
  assert.equal(result.aborted, false, `${label} was aborted`);
  assert.equal(result.spawnError, undefined, `${label} failed to start`);
}

/**
 * A credential the cloud authenticates but never granted storage is refused by
 * the real CLI, and the API declares 403 BUCKET_ACCESS_DENIED after one
 * provider call, logged at WARN, never ERROR.
 */
export class BucketAccessDeniedScenario {
  readonly #dependencies: Dependencies;

  constructor(dependencies: Dependencies) {
    this.#dependencies = dependencies;
  }

  async run(provider: DeniedBucketProvider): Promise<BucketAccessDeniedResult> {
    const { api, cli, cleanup, files, profiles, runId } = this.#dependencies;
    const region = REGION[provider];
    const owner = profiles.vm(provider);
    const bucket = `anycloud-deny-${runId}`;
    // The sweeps own `bkt-<digits>` names; GCP account IDs allow 17 digits.
    const deniedName = `bkt-${BigInt(`0x${runId}`).toString().slice(0, 17)}`;

    cleanup.defer(`bucket-access-owner-${owner.credentialName}`, () =>
      api.deleteCredential(owner.credentialName, Date.now() + 120_000),
    );
    await api.saveCredential(owner.credentialName, owner.credential);
    const scope = { credentials: owner.credentialName, region };
    completedCommand(
      await cli.run(cliArgs('bucket create', scope, [bucket])),
      'bucket create',
    );
    // A create whose reply was lost is left to the post-run storage sweep.
    cleanup.defer(`bucket-access-bucket-${bucket}`, async () => {
      await cli.run(cliArgs('bucket rm', scope, [bucket, OBJECT]));
      completedCommand(
        await cli.run(cliArgs('bucket delete', scope, [bucket])),
        'bucket delete',
      );
    });
    completedCommand(
      await cli.run(
        cliArgs('bucket upload', scope, [
          bucket,
          await files.text('bucket-access-object.txt', runId),
          OBJECT,
        ]),
      ),
      'bucket upload',
    );

    const principal = await this.#principal(provider, deniedName);
    cleanup.defer(`bucket-access-denied-${deniedName}`, () =>
      api.deleteCredential(deniedName, Date.now() + 120_000),
    );
    await api.saveCredential(deniedName, principal.credential);
    await principal.denied(bucket);

    const since = new Date().toISOString();
    const denied = { credentials: deniedName, region };
    const download = await files.directory('bucket-access-download');
    const commands = [
      cliArgs('bucket download', denied, [
        bucket,
        OBJECT,
        path.join(download, OBJECT),
      ]),
      cliArgs('bucket list', denied, [bucket]),
      cliArgs('bucket upload', denied, [
        bucket,
        await files.text('bucket-access-upload.txt', runId),
        'refused.txt',
      ]),
    ];
    for (const args of commands)
      refused(
        await cli.run(args, { timeoutMs: DENIED_COMMAND_MS }),
        `${args[0]} ${args[1]}`,
      );
    // The CLI prints only the message; read the declared error from the API.
    const declared = await createApiClient(
      this.#dependencies.bearer(api.controller.url),
      { apiUrl: api.controller.url },
    )
      .bucket.exists({
        params: { bucketName: bucket, credentialName: deniedName },
        query: { region },
      })
      .then(
        () => assert.fail('The no-grant credential was allowed bucket.exists'),
        declaredApiError,
      );
    assert.equal(declared?.code, 'BUCKET_ACCESS_DENIED');
    assert.equal(declared.status, 403);

    const lines = await this.#apiLog(since);
    assert.deepEqual(
      lines.filter((line) => line.level === 'ERROR'),
      [],
      'A denied bucket call was logged at ERROR',
    );
    // One classified failure per request, and no client retry of the 403. The
    // provider call count itself is not observable: Azure retries ARM about 9
    // times inside one request before it reports denial.
    assert.equal(
      lines.filter(
        (line) => line.level === 'WARN' && line.code === 'BUCKET_ACCESS_DENIED',
      ).length,
      commands.length + 1,
      'Each denied request should be classified once and never retried',
    );
    return { scenario: 'bucket-access-denied', provider, satisfied: true };
  }

  async #apiLog(since: string): Promise<readonly Record<string, unknown>[]> {
    const result = await this.#dependencies.runner.run(
      'docker',
      ['logs', '--since', since, 'anycloud-api'],
      { label: 'bucket-access-api-log' },
    );
    completedCommand(result, 'docker logs anycloud-api');
    // Parse each stream alone: interleaved chunks could split a JSON line.
    const parse = (text: string) =>
      text
        .split('\n')
        .filter(Boolean)
        .map((line): Record<string, unknown> => {
          try {
            const parsed: unknown = JSON.parse(line);
            if (isRecord(parsed)) return parsed;
          } catch {
            // An unstructured line, such as a crash trace, counts as an error.
          }
          return { level: 'ERROR', message: line };
        });
    return [...parse(result.stdout), ...parse(result.stderr)];
  }

  /** Creates the no-grant principal and registers its cleanup through the suite sweeps' owner. */
  async #principal(
    provider: DeniedBucketProvider,
    name: string,
  ): Promise<DeniedPrincipal> {
    const { cleanup } = this.#dependencies;
    if (provider === 'aws') {
      const context = await createBootstrapAWSContext();
      // Dispose even when cleanup fails: the root holds bootstrap secrets.
      cleanup.defer(`bucket-access-aws-${name}`, () =>
        cleanupAWSOnboardingUser(context, `anycloud-${name}`, 'bucket').finally(
          () => disposeBootstrapAWSContext(context),
        ),
      );
      const key = await createAWSImportFixture(context, name, 'bucket', {
        grants: false,
      });
      const environment: NodeJS.ProcessEnv = {
        ...context.environment,
        AWS_ACCESS_KEY_ID: key.accessKeyId,
        AWS_SECRET_ACCESS_KEY: key.secretAccessKey,
      };
      delete environment.AWS_SESSION_TOKEN;
      return {
        credential: {
          cloudProvider: CloudType.AWS,
          accessKeyId: key.accessKeyId,
          secretAccessKey: key.secretAccessKey,
        },
        // InvalidAccessKeyId is also a 403, so wait for the permission denial.
        denied: (bucket) =>
          untilDenied(
            () =>
              runAdminAWS({ environment }, [
                's3api',
                'get-bucket-location',
                '--bucket',
                bucket,
                '--region',
                REGION.aws,
              ]),
            /\(AccessDenied\)/u,
          ),
      };
    }
    if (provider === 'gcp') {
      const context = await createBootstrapGcloudContext();
      const email = `anycloud-${name}@${context.projectId}.iam.gserviceaccount.com`;
      cleanup.defer(`bucket-access-gcp-${name}`, () =>
        cleanupGCPOnboardingAccount(context, email, 'bucket').finally(() =>
          disposeBootstrapGcloudContext(context),
        ),
      );
      const key = await createGCPImportFixture(
        context,
        name,
        path.join(context.rootDir, 'denied.json'),
        'bucket',
        { grants: false },
      );
      return {
        credential: {
          cloudProvider: CloudType.GCP,
          projectId: key.projectId,
          clientEmail: key.clientEmail,
          privateKey: key.privateKey,
        },
        // A new key signs some token requests before Google accepts it
        // everywhere (run 37776021622: "invalid_grant: Invalid JWT Signature."
        // after GCS had already refused it), so hold fresh mints, as for Azure.
        denied: (bucket) =>
          untilDenied(
            async () => {
              const outcome = await gcpDenial(key, bucket);
              if (outcome !== 'granted') throw new Error(outcome);
            },
            new RegExp(`^${GCP_DENIED}$`, 'u'),
            { holdMs: FRESH_KEY_HOLD_MS, readyMs: FRESH_KEY_READY_MS },
          ),
      };
    }
    // With the created objects bound, cleanup takes the strict path:
    // `az rest` deletes, re-issued once, then confirmed absent.
    const owner = new AzureTestPrincipal(readAzureOnboardingSecrets(), name, {
      grants: false,
    });
    cleanup.defer(`bucket-access-azure-${name}`, () => owner.remove());
    const principal = await owner.create();
    return {
      credential: {
        cloudProvider: CloudType.Azure,
        applicationId: principal.applicationId,
        secret: principal.secret,
        directoryId: principal.tenantId,
        subscriptionId: principal.subscriptionId,
      },
      // A new secret replicates across Entra unevenly: run 37762370054 saw
      // AADSTS7000215 interleaved with ARM denials for minutes after a first
      // good sign-in, and the gateway judges a request by its last attempt.
      // Require every fresh, uncached sign-in to be refused for a continuous
      // window; any other answer restarts it.
      denied: () =>
        untilDenied(
          async () => {
            const outcome = await azureDenial(principal, name);
            if (outcome !== 'granted') throw new Error(outcome);
          },
          new RegExp(`^${AZURE_DENIED}$`, 'u'),
          { holdMs: FRESH_KEY_HOLD_MS, readyMs: FRESH_KEY_READY_MS },
        ),
    };
  }
}

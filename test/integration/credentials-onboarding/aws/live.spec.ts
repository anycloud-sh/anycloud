/** Real AWS terminal onboarding; invoked only by the trusted-PR workflow. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import {
  spawnCliInPty,
  startCredentialApi,
  type CredentialApiFixture,
  type CredentialBucketListTarget,
  type PtyRun,
  WizardDriver,
} from '../harness.js';
import { journeyTitle } from '../journeys.js';
import anycloudAccess from '../../../../src/shared/cloud-policies/aws-anycloud-access.json' with { type: 'json' };
import {
  probeAWSLoginCache,
  probeAWSMutationRetry,
  probeAWSReadRetry,
  probeAWSRejectingProxy,
} from './cli-retry.js';
import { runAWSCLI } from '../../../../src/cli/services/credential-bootstrap/aws-cli-runner.js';
import { describeAWSGeneration } from '../../../../src/cli/services/credential-bootstrap/aws.js';
import {
  cleanupAWSGenerationFixture,
  prepareAWSGenerationFixture,
  readAWSGeneratedUser,
  readAWSGenerationOwnership,
} from './generation-fixture.js';
import {
  cleanupAWSOnboardingBucket,
  cleanupAWSOnboardingUser,
  createBootstrapAWSContext,
  createAWSImportFixture,
  disposeBootstrapAWSContext,
  managedCredentialName,
  readAWSOnboardingSecrets,
  type BootstrapAWSContext,
  type AWSImportFixture,
} from './admin.js';
import { writeLocalApiToken } from '../../helpers/local-api-token.js';

const API_TOKEN = 'aws-onboarding-live-token';
const AWS_SMOKE_REGION = 'us-east-1';
// HeadBucket is strongly consistent; S3's account-wide bucket index is not, so
// only the list reads need a propagation budget.
const BUCKET_LIST_WAITS = [500, 1_000, 2_000, 4_000];

let suiteRoot = '';
let api: CredentialApiFixture;

function numericRunToken(): string {
  const run = (process.env.GITHUB_RUN_ID ?? String(Date.now())).replace(
    /\D/g,
    '',
  );
  const attempt = (process.env.GITHUB_RUN_ATTEMPT ?? '1')
    .replace(/\D/g, '')
    .padStart(2, '0')
    .slice(-2);
  const token = `${run.slice(-13)}${attempt}`.slice(-16);
  if (!token) throw new Error('Could not derive a numeric AWS run token.');
  return token;
}

async function childEnvironment(
  childRoot: string,
  bootstrap: BootstrapAWSContext,
  fixture: AWSImportFixture,
): Promise<Record<string, string>> {
  const environment = Object.fromEntries(
    Object.entries(bootstrap.environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const credentialsPath = join(childRoot, 'aws-credentials');
  const configPath = join(childRoot, 'aws-config');
  await writeFile(
    credentialsPath,
    `[import]
aws_access_key_id = ${fixture.accessKeyId}
aws_secret_access_key = ${fixture.secretAccessKey}
`,
    { mode: 0o600 },
  );
  await writeFile(configPath, '[profile import]\nregion = us-east-1\n', {
    mode: 0o600,
  });
  for (const name of [
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'ANYCLOUD_CLOUD_PROVIDER',
  ]) {
    delete environment[name];
  }
  writeLocalApiToken(childRoot);
  environment.CI = 'false';
  environment.HOME = childRoot;
  environment.ANYCLOUD_DIR = childRoot;
  environment.AWS_SHARED_CREDENTIALS_FILE = credentialsPath;
  environment.AWS_CONFIG_FILE = configPath;
  environment.AWS_PROFILE = 'import';
  environment.GITHUB_TOKEN = API_TOKEN;
  environment.API_URL = api.url;
  return environment;
}

async function bucketNamesOnceSettled(
  target: CredentialBucketListTarget,
  bucketName: string,
  expected: boolean,
): Promise<string[]> {
  let names = await api.listBuckets(target);
  // eslint-disable-next-line local/no-hand-written-retry-loops -- returns the last listing for the caller's assertion instead of failing
  for (const wait of BUCKET_LIST_WAITS) {
    if (names.includes(bucketName) === expected) break;
    await new Promise((done) => setTimeout(done, wait));
    names = await api.listBuckets(target);
  }
  return names;
}

describe('AWS live credentials onboarding terminal', () => {
  beforeAll(async () => {
    readAWSOnboardingSecrets();
    suiteRoot = await mkdtemp(join(tmpdir(), 'anycloud-aws-live-api-'));
    vi.stubEnv('SQLITE_PATH', join(suiteRoot, 'api.db'));
    vi.stubEnv('IS_TEST', 'true');
    vi.stubEnv('CIPHER_KEY', process.env.CIPHER_KEY ?? 'a'.repeat(64));
    api = await startCredentialApi(API_TOKEN);
  }, 60_000);

  afterAll(async () => {
    await api?.close();
    if (suiteRoot) await rm(suiteRoot, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it(
    `0038/S2 ${journeyTitle('aws.live-generation')}`,
    async () => {
      const credentialName = `onb-gen-${randomUUID()}`;
      const root = await mkdtemp(join(tmpdir(), 'anycloud-aws-generation-'));
      let bootstrap: BootstrapAWSContext | undefined;
      let fixture:
        | Awaited<ReturnType<typeof prepareAWSGenerationFixture>>
        | undefined;
      let cli: PtyRun | undefined;
      const failures: unknown[] = [];
      try {
        bootstrap = await createBootstrapAWSContext();
        fixture = await prepareAWSGenerationFixture(
          root,
          bootstrap,
          credentialName,
        );
        cli = spawnCliInPty(
          [
            'credentials',
            'new',
            credentialName,
            '--provider',
            'aws',
            '--generate',
            '--profile',
            'operator',
            '--account-id',
            fixture.accountId,
          ],
          {
            cwd: root,
            env: {
              ...fixture.environment,
              GITHUB_TOKEN: API_TOKEN,
              API_URL: api.url,
            },
          },
        );
        const wizard = new WizardDriver(cli);
        for (const value of [
          bootstrap.environment.AWS_SECRET_ACCESS_KEY,
          bootstrap.environment.AWS_SESSION_TOKEN,
        ]) {
          if (value) cli.registerSecret(value);
        }
        await wizard.expectSuccess(credentialName, 5 * 60_000);

        // First workload operation: no fixture readiness probe or repair. The
        // selected API must use the key that the product just created and saved.
        expect(
          Array.isArray(
            await api.listBuckets({ credentialName, region: AWS_SMOKE_REGION }),
          ),
        ).toBe(true);
        const saved = await api.storedCredential(credentialName);
        const owned = await readAWSGenerationOwnership(
          fixture.recordPath,
          fixture,
        );
        cli.registerSecret(String(saved.secretAccessKey));
        expect(saved.cloudProvider).toBe('AWS');
        expect(saved.accessKeyId).toBe(owned.accessKeyIds[0]);
        expect(owned.accessKeyIds).toHaveLength(1);
        expect(
          typeof saved.secretAccessKey === 'string' &&
            saved.secretAccessKey.length > 0,
        ).toBe(true);
        wizard.assertSecretNotPresent(String(saved.secretAccessKey));
        for (const value of [
          bootstrap.environment.AWS_SECRET_ACCESS_KEY,
          bootstrap.environment.AWS_SESSION_TOKEN,
        ]) {
          if (value) wizard.assertSecretNotPresent(value);
        }
        // RFC 0047: the generated user gets only the published policy.
        const { operator } = fixture;
        const iamList = async <T>(command: string): Promise<T> =>
          JSON.parse(
            await readAWSGeneratedUser(() =>
              runAWSCLI(operator, [
                'iam',
                command,
                '--user-name',
                owned.userName,
              ]),
            ),
          ) as T;
        expect(
          (
            await iamList<{ AttachedPolicies: unknown[] }>(
              'list-attached-user-policies',
            )
          ).AttachedPolicies,
        ).toEqual([]);
        expect(
          (await iamList<{ PolicyNames: string[] }>('list-user-policies'))
            .PolicyNames,
        ).toEqual(['AnycloudAccess']);
        const inline = JSON.parse(
          await readAWSGeneratedUser(() =>
            runAWSCLI(operator, [
              'iam',
              'get-user-policy',
              '--user-name',
              owned.userName,
              '--policy-name',
              'AnycloudAccess',
            ]),
          ),
        ) as { PolicyDocument: unknown };
        expect(inline.PolicyDocument).toEqual(anycloudAccess);
        console.info(
          `AWS generation CI proof: ${describeAWSGeneration(owned)}; exact saved key listed S3 buckets (s3:ListAllMyBuckets); commit ${process.env.GITHUB_SHA ?? 'local working tree'}. Operator used the CI bootstrap profile, not login_session qualification.`,
        );
      } catch (error) {
        failures.push(error);
      } finally {
        try {
          cli?.pty.kill();
        } catch {
          /* Already exited. */
        }
        if (fixture) {
          try {
            await cleanupAWSGenerationFixture(fixture, () =>
              api.deleteCredential(credentialName),
            );
          } catch (error) {
            failures.push(error);
          }
        }
        if (bootstrap) await disposeBootstrapAWSContext(bootstrap);
        await rm(root, { recursive: true, force: true });
      }
      if (failures.length)
        throw new AggregateError(
          failures,
          'AWS generation or owned teardown failed; inspect the reported target for manual reconciliation.',
        );
    },
    10 * 60_000,
  );

  it(
    journeyTitle('aws.live-import'),
    async () => {
      const runToken = numericRunToken();
      const credentialName = managedCredentialName('onboarding', runToken);
      const userName = `anycloud-${credentialName}`;
      const smokeBucketName =
        `anycloud-onb-smoke-${runToken}-` +
        randomUUID().replace(/-/g, '').slice(0, 16);
      const smokeBucket = {
        credentialName,
        bucketName: smokeBucketName,
        region: AWS_SMOKE_REGION,
      };
      const childRoot = await mkdtemp(join(tmpdir(), 'anycloud-aws-live-cli-'));
      let bootstrap: BootstrapAWSContext | undefined;
      let fixture: AWSImportFixture | undefined;
      let cli: PtyRun | undefined;
      let primaryError: Error | undefined;
      let smokeBucketMayExist = false;

      try {
        bootstrap = await createBootstrapAWSContext();
        fixture = await createAWSImportFixture(
          bootstrap,
          credentialName,
          'onboarding',
        );
        cli = spawnCliInPty(
          [
            'credentials',
            'new',
            credentialName,
            '--provider',
            'aws',
            '--profile',
            'import',
          ],
          {
            cwd: childRoot,
            env: await childEnvironment(childRoot, bootstrap, fixture),
          },
        );
        const wizard = new WizardDriver(cli);
        for (const value of [
          fixture.accessKeyId,
          fixture.secretAccessKey,
          bootstrap.environment.AWS_ACCESS_KEY_ID,
          bootstrap.environment.AWS_SECRET_ACCESS_KEY,
          bootstrap.environment.AWS_SESSION_TOKEN,
        ]) {
          if (value) cli.registerSecret(value);
        }
        await wizard.expectSuccess(
          credentialName,
          5 * 60_000,
          /AWS credentials could not be authenticated/,
        );

        const saved = await api.storedCredential(credentialName);
        expect(saved).toMatchObject({
          name: credentialName,
          cloudProvider: 'AWS',
        });
        expect(saved.accessKeyId).toBe(fixture.accessKeyId);
        expect(saved.secretAccessKey).toBe(fixture.secretAccessKey);
        wizard.assertSecretNotPresent(String(saved.secretAccessKey));
        for (const value of [
          bootstrap.environment.AWS_ACCESS_KEY_ID,
          bootstrap.environment.AWS_SECRET_ACCESS_KEY,
          bootstrap.environment.AWS_SESSION_TOKEN,
        ]) {
          if (value) wizard.assertSecretNotPresent(value);
        }

        // The product imports the test-owned static profile, then the API uses
        // that exact stored credential for real bucket operations.
        smokeBucketMayExist = true;
        await api.createBucket(smokeBucket);
        expect(await api.bucketExists(smokeBucket, { uncached: true })).toBe(
          true,
        );
        expect(
          await bucketNamesOnceSettled(smokeBucket, smokeBucketName, true),
        ).toContain(smokeBucketName);
        await api.deleteBucket(smokeBucket);
        expect(await api.bucketExists(smokeBucket, { uncached: true })).toBe(
          false,
        );
        expect(
          await bucketNamesOnceSettled(smokeBucket, smokeBucketName, false),
        ).not.toContain(smokeBucketName);
        smokeBucketMayExist = false;
      } catch (error) {
        primaryError =
          error instanceof Error
            ? error
            : new Error('AWS onboarding failed with a non-Error value.', {
                cause: error,
              });
      }

      const cleanupErrors: Error[] = [];
      const cleanup = async (operation: () => Promise<void>) => {
        try {
          await operation();
          return true;
        } catch (error) {
          cleanupErrors.push(
            error instanceof Error ? error : new Error(String(error)),
          );
          return false;
        }
      };

      let smokeBucketRemoved = !smokeBucketMayExist;
      if (!smokeBucketRemoved) {
        smokeBucketRemoved = await cleanup(async () => {
          await api.deleteBucket(smokeBucket);
          if (await api.bucketExists(smokeBucket, { uncached: true })) {
            throw new Error(
              `AWS smoke bucket ${smokeBucketName} still exists.`,
            );
          }
        });
        if (!smokeBucketRemoved && bootstrap) {
          smokeBucketRemoved = await cleanup(() =>
            cleanupAWSOnboardingBucket(bootstrap, smokeBucketName),
          );
        }
      }

      if (smokeBucketRemoved) {
        await cleanup(() => api.deleteCredential(credentialName));
        if (bootstrap) {
          await cleanup(() =>
            cleanupAWSOnboardingUser(bootstrap, userName, 'onboarding'),
          );
        }
      } else {
        cleanupErrors.push(
          new Error(
            `Retained AWS credential ${credentialName} and identity ${userName} because smoke bucket cleanup could not be confirmed.`,
          ),
        );
      }
      if (bootstrap) {
        await cleanup(() => disposeBootstrapAWSContext(bootstrap));
      }
      if (cli) {
        try {
          cli.pty.kill();
        } catch {
          // It already exited.
        }
      }
      await cleanup(() => rm(childRoot, { recursive: true, force: true }));

      if (primaryError !== undefined) {
        if (cleanupErrors.length > 0) {
          console.error(
            `AWS onboarding cleanup also failed: ${cleanupErrors.map((error) => error.message).join('; ')}`,
          );
        }
        throw primaryError;
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          cleanupErrors,
          'AWS onboarding cleanup failed.',
        );
      }
    },
    10 * 60_000,
  );
});

describe('AWS CLI mutation dispatch with the installed binary', () => {
  it.each([
    ['create-user', 'CreateUser', 'server-error'],
    ['create-access-key', 'CreateAccessKey', 'server-error'],
    ['create-user', 'CreateUser', 'lost-response'],
    ['create-access-key', 'CreateAccessKey', 'lost-response'],
  ])(
    '0038/S2 sends %s once after %s / %s',
    async (command, action, failure) => {
      const result = await probeAWSMutationRetry(command, failure);
      expect(result.error).toBeInstanceOf(Error);
      expect(result.requests).toEqual([action]);
    },
    30_000,
  );

  it.each(['server-error', 'lost-response'])(
    'replays the idempotent DeleteUser after %s without inherited CLI retries',
    async (failure) => {
      const result = await probeAWSMutationRetry('delete-user', failure);
      expect(String(result.error)).toMatch(
        /IAM DeleteUser failed after 3 attempts .* The request may have succeeded\.$/,
      );
      expect(result.requests).toEqual([
        'DeleteUser',
        'DeleteUser',
        'DeleteUser',
      ]);
    },
    90_000,
  );
});

describe('AWS CLI read recovery with the installed binary', () => {
  it.each(['server-error', 'lost-response'])(
    'recovers GetUser after %s without inherited CLI retries',
    async (failure) => {
      const result = await probeAWSReadRetry(failure);
      expect(result.error).toBeUndefined();
      expect(result.requests).toEqual(['GetUser', 'GetUser']);
      expect(JSON.parse(result.output!)).toMatchObject({
        User: { UserId: 'AIDALOOPBACKONLY' },
      });
    },
    30_000,
  );
});

// This sibling suite needs an installed CLI, but no live credentials or browser
// login. Run it with the retry cases using test:aws-onboarding-e2e -t 'AWS CLI'.
describe('AWS CLI login cache with the installed binary', () => {
  it('uses the preserved cache across HOME isolation and ambient credential overrides', async () => {
    const result = await probeAWSLoginCache('valid');
    expect(result.error).toBeUndefined();
    expect(result.credentialSource).toBe('login');
    expect(result.requests).toEqual([
      {
        action: 'GetCallerIdentity',
        accessKeyId: 'ASIALOGINCACHE0000000',
        sessionToken: 'synthetic-login-session-token',
      },
    ]);
    expect(result.unexpectedRequests).toEqual({ http: 0, connect: 0 });
  }, 100_000);

  it.each(['missing-directory', 'omitted-override'] as const)(
    'fails before STS dispatch when the login cache is unavailable: %s',
    async (mode) => {
      const result = await probeAWSLoginCache(mode);
      expect(result.error).toBeInstanceOf(Error);
      expect(result.requests).toEqual([]);
      expect(result.unexpectedRequests).toEqual({ http: 0, connect: 0 });
    },
    100_000,
  );

  it('detects shared-file static credentials shadowing a valid login cache', async () => {
    const result = await probeAWSLoginCache('static-shadow');
    expect(result.error).toBeUndefined();
    expect(result.credentialSource).toBe('shared-credentials-file');
    expect(result.requests).toEqual([
      {
        action: 'GetCallerIdentity',
        accessKeyId: 'AKIASTATICCACHE00000',
        sessionToken: undefined,
      },
    ]);
    expect(result.unexpectedRequests).toEqual({ http: 0, connect: 0 });
  }, 100_000);

  it('counts and rejects both HTTP and HTTPS CONNECT attempts', async () => {
    const result = await probeAWSRejectingProxy();
    expect(result.statuses).toEqual([502, 502]);
    expect(result.attempts).toEqual({ http: 1, connect: 1 });
  });
});

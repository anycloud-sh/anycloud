/** Real GCP generation and import; invoked by the existing trusted-PR workflow. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash, randomUUID } from 'crypto';
import { JWT } from 'google-auth-library';
import anycloudRole from '../../../../src/shared/cloud-policies/gcp-anycloud-role.json' with { type: 'json' };
import { withRetry } from '../../../../src/shared/utils.js';
import {
  spawnCliInPty,
  startCredentialApi,
  type CredentialApiFixture,
  type CredentialBucketListTarget,
  type PtyRun,
  WizardDriver,
} from '../harness.js';
import { journeyTitle } from '../journeys.js';
import {
  cleanupGCPOnboardingAccount,
  cleanupGCPOnboardingBucket,
  createBootstrapGcloudContext,
  createGCPImportFixture,
  disposeBootstrapGcloudContext,
  managedCredentialName,
  readGCPOnboardingSecrets,
  type BootstrapGcloudContext,
  type GCPImportFixture,
} from './admin.js';
import { gcpOperator } from '../../../../src/cli/services/credential-bootstrap/gcp-cli-runner.js';
import {
  prepareGCPGenerationFixture,
  readGCPGenerationOwnership,
  cleanupGCPGenerationFixture,
  type GCPGenerationFixture,
} from './generation-fixture.js';
import { writeLocalApiToken } from '../../helpers/local-api-token.js';

const API_TOKEN = 'gcp-onboarding-live-token';
const GCP_SMOKE_REGION = 'us-central1';
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
  if (!token) throw new Error('Could not derive a numeric GCP run token.');
  return token;
}

function childEnvironment(
  childRoot: string,
  fixture: GCPImportFixture,
): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  for (const name of [
    'GCP_PROJECT_ID',
    'GCP_CLIENT_EMAIL',
    'GCP_PRIVATE_KEY',
    'GOOGLE_GHA_CREDS_PATH',
    'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE',
    'ANYCLOUD_CLOUD_PROVIDER',
  ]) {
    delete env[name];
  }
  writeLocalApiToken(childRoot);
  env.CI = 'false';
  env.HOME = childRoot;
  env.ANYCLOUD_DIR = childRoot;
  env.GOOGLE_APPLICATION_CREDENTIALS = fixture.keyPath;
  env.GITHUB_TOKEN = API_TOKEN;
  env.API_URL = api.url;
  return env;
}

/**
 * The published role's permissions the key is missing. This checks every
 * right, including making the VM Jobs network (RFC 0053), which a VM Job in
 * this project, whose network already exists, would never exercise.
 */
async function missingPermissions(
  projectId: string,
  email: string,
  key: string,
): Promise<string[]> {
  const client = new JWT({
    email,
    key,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  const { data } = await client.request<{ permissions?: string[] }>({
    url: `https://cloudresourcemanager.googleapis.com/v1/projects/${projectId}:testIamPermissions`,
    method: 'POST',
    data: { permissions: anycloudRole.includedPermissions },
  });
  return anycloudRole.includedPermissions.filter(
    (permission) => !data.permissions?.includes(permission),
  );
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

beforeAll(async () => {
  readGCPOnboardingSecrets();
  suiteRoot = await mkdtemp(join(tmpdir(), 'anycloud-gcp-live-api-'));
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

describe('GCP live credentials onboarding terminal', () => {
  it(
    journeyTitle('gcp.live-generation'),
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'anycloud-gcp-generation-'));
      const credentialName = `onb-gen-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const secrets = readGCPOnboardingSecrets();
      let bootstrap: BootstrapGcloudContext | undefined;
      let fixture: GCPGenerationFixture | undefined;
      let cli: PtyRun | undefined;
      const failures: unknown[] = [];
      try {
        bootstrap = await createBootstrapGcloudContext(secrets);
        const operator = gcpOperator(
          bootstrap.bootstrapEmail,
          bootstrap.projectId,
          { ...process.env, CLOUDSDK_CONFIG: bootstrap.configDir },
        );
        fixture = prepareGCPGenerationFixture(root, operator, credentialName);
        cli = spawnCliInPty(
          [
            'credentials',
            'new',
            credentialName,
            '--provider',
            'gcp',
            '--generate',
            '--gcloud-account',
            operator.account,
            '--project-id',
            operator.projectId,
          ],
          {
            cwd: root,
            env: {
              ...fixture.environment,
              // The product must select the cached operator despite inherited identities.
              CLOUDSDK_CORE_ACCOUNT: 'unselected@example.com',
              CLOUDSDK_CORE_PROJECT: 'unselected-project',
              CLOUDSDK_AUTH_ACCESS_TOKEN: 'unselected-operator-token',
              CLOUDSDK_AUTH_ACCESS_TOKEN_FILE: join(root, 'unselected-token'),
              CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: join(
                root,
                'unselected-key.json',
              ),
              CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT:
                'unselected@unselected-project.iam.gserviceaccount.com',
              GOOGLE_APPLICATION_CREDENTIALS: join(root, 'unselected-adc.json'),
              GCP_CLIENT_EMAIL:
                'unselected@unselected-project.iam.gserviceaccount.com',
              GCP_PRIVATE_KEY: 'unselected-private-key',
              API_URL: api.url,
              GITHUB_TOKEN: API_TOKEN,
            },
          },
        );
        cli.registerSecret(secrets.privateKey);
        const wizard = new WizardDriver(cli);
        await wizard.expectSuccess(credentialName, 4 * 60_000);
        // First use is an ordinary API request. No key readiness probe or delay.
        expect(
          Array.isArray(
            await api.listBuckets({ credentialName, region: GCP_SMOKE_REGION }),
          ),
        ).toBe(true);
        const saved = await api.storedCredential(credentialName);
        const owned = await readGCPGenerationOwnership(fixture);
        expect(saved.cloudProvider).toBe('GCP');
        expect(saved.clientEmail).toBe(owned.email);
        expect(saved.projectId).toBe(owned.projectId);
        expect(typeof saved.privateKey).toBe('string');
        const privateKey = String(saved.privateKey);
        cli.registerSecret(privateKey);
        // A new grant takes a few minutes to reach every IAM check.
        const notYetGranted = new Error('Grant not yet visible');
        let missing: string[] = [];
        await withRetry(
          async () => {
            missing = await missingPermissions(
              owned.projectId,
              owned.email,
              privateKey,
            );
            if (missing.length) throw notYetGranted;
          },
          'GCP generated key permissions',
          {
            maxAttempts: 30,
            waitMs: 10_000,
            exponentialBackoff: false,
            jitter: false,
            shouldRetry: (error) => error === notYetGranted,
          },
        ).catch((error: unknown) => {
          if (error !== notYetGranted) throw error;
        });
        expect(missing).toEqual([]);
        expect(owned.keyIds).toHaveLength(1);
        expect(createHash('sha256').update(privateKey).digest('hex')).toBe(
          owned.privateKeyFingerprint,
        );
        wizard.assertSecretNotPresent(privateKey);
        wizard.assertSecretNotPresent(secrets.privateKey);
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
            await cleanupGCPGenerationFixture(fixture, () =>
              api.deleteCredential(credentialName),
            );
          } catch (error) {
            failures.push(error);
          }
        }
        if (bootstrap) {
          try {
            await disposeBootstrapGcloudContext(bootstrap);
          } catch (error) {
            failures.push(error);
          }
        }
        await rm(root, { recursive: true, force: true });
      }
      if (failures.length)
        throw new AggregateError(
          failures,
          'GCP generation/save/first-use/cleanup failed.',
        );
    },
    15 * 60_000,
  );

  it(
    journeyTitle('gcp.live-import'),
    async () => {
      const secrets = readGCPOnboardingSecrets();
      const runToken = numericRunToken();
      const credentialName = managedCredentialName('onboarding', runToken);
      const accountEmail = `anycloud-${credentialName}@${secrets.projectId}.iam.gserviceaccount.com`;
      const smokeBucketName =
        `anycloud-onb-smoke-${runToken}-` +
        randomUUID().replace(/-/g, '').slice(0, 16);
      const smokeBucket = {
        credentialName,
        bucketName: smokeBucketName,
        region: GCP_SMOKE_REGION,
      };
      const childRoot = await mkdtemp(join(tmpdir(), 'anycloud-gcp-live-cli-'));
      const keyPath = join(childRoot, 'import-key.json');
      let bootstrap: BootstrapGcloudContext | undefined;
      let fixture: GCPImportFixture | undefined;
      let cli: PtyRun | undefined;
      let primaryError: Error | undefined;
      let smokeBucketMayExist = false;

      try {
        bootstrap = await createBootstrapGcloudContext(secrets);
        fixture = await createGCPImportFixture(
          bootstrap,
          credentialName,
          keyPath,
          'onboarding',
        );
        cli = spawnCliInPty(['credentials', 'new'], {
          cwd: childRoot,
          env: childEnvironment(childRoot, fixture),
        });
        const wizard = new WizardDriver(cli);
        cli.registerSecret(fixture.privateKey);
        cli.registerSecret(secrets.privateKey);
        await wizard.enterText('Name for this credential set:', credentialName);
        await wizard.selectChoice('Select cloud provider:', 'GCP', [
          'AWS',
          'Azure',
          'GCP',
          'Lambda',
        ]);
        await wizard.selectChoice(
          'How would you like to add GCP credentials?',
          fixture.keyPath,
          [fixture.keyPath, 'Upload existing service account key file'],
          { timeoutMs: 60_000 },
        );
        await wizard.confirm(
          `Save these GCP credentials as "${credentialName}"?`,
        );
        await wizard.expectSuccess(credentialName, 2 * 60_000);

        const saved = await api.storedCredential(credentialName);
        expect(saved).toMatchObject({
          name: credentialName,
          cloudProvider: 'GCP',
          projectId: fixture.projectId,
          clientEmail: fixture.clientEmail,
          privateKey: fixture.privateKey,
        });
        wizard.assertSecretNotPresent(fixture.privateKey);
        wizard.assertSecretNotPresent(secrets.privateKey);

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
            : new Error('GCP onboarding failed with a non-Error value.', {
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
              `GCP smoke bucket ${smokeBucketName} still exists.`,
            );
          }
        });
        if (!smokeBucketRemoved && bootstrap) {
          smokeBucketRemoved = await cleanup(() =>
            cleanupGCPOnboardingBucket(bootstrap, smokeBucketName),
          );
        }
      }

      if (smokeBucketRemoved) {
        await cleanup(() => api.deleteCredential(credentialName));
        if (bootstrap) {
          await cleanup(() =>
            cleanupGCPOnboardingAccount(bootstrap, accountEmail, 'onboarding'),
          );
        }
      } else {
        cleanupErrors.push(
          new Error(
            `Retained GCP credential ${credentialName} and account ${accountEmail} because smoke bucket cleanup could not be confirmed.`,
          ),
        );
      }
      if (bootstrap) {
        await cleanup(() => disposeBootstrapGcloudContext(bootstrap));
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
            `GCP onboarding cleanup also failed: ${cleanupErrors.map((error) => error.message).join('; ')}`,
          );
        }
        throw primaryError;
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          cleanupErrors,
          'GCP onboarding cleanup failed.',
        );
      }
    },
    12 * 60_000,
  );
});

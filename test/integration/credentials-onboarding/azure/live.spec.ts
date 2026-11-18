/** Real Azure terminal onboarding; invoked only by the trusted-PR workflow. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import {
  spawnCliInPty,
  startCredentialApi,
  type CredentialApiFixture,
  type PtyRun,
  WizardDriver,
} from '../harness.js';
import { journeyTitle } from '../journeys.js';
import {
  MAX_WAIT_MS,
  rethrowLastAttempt,
  Waiter,
} from '../../e2e/internal/wait.js';
import {
  isRecord,
  parseJsonArray,
  parseJsonRecord,
} from '../../helpers/json.js';
import {
  cleanupAzureOnboardingContainer,
  cleanupAzureOnboardingIdentity,
  azureCliPasswordArgument,
  createBootstrapAzureContext,
  createAzureManualCredentialFixture,
  disposeBootstrapAzureContext,
  managedCredentialName,
  readAzureOnboardingSecrets,
  runAdminAzure,
  type BootstrapAzureContext,
  type AzureManualCredentialFixture,
} from './admin.js';
import { writeLocalApiToken } from '../../helpers/local-api-token.js';

const API_TOKEN = 'azure-onboarding-live-token';
const PROPAGATION_WAITS = [500, 1_000, 2_000, 4_000, 8_000, 15_000];
const AZURE_SMOKE_REGION = 'eastus';

let suiteRoot = '';
let api: CredentialApiFixture;

interface AzureSubscription {
  id: string;
  name?: string;
  isDefault?: boolean;
}

function isAzureSubscription(value: unknown): value is AzureSubscription {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    (value.name === undefined || typeof value.name === 'string') &&
    (value.isDefault === undefined || typeof value.isDefault === 'boolean')
  );
}

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
  if (!token) throw new Error('Could not derive a numeric Azure run token.');
  return token;
}

function childEnvironment(
  childRoot: string,
  bootstrap: BootstrapAzureContext,
): Record<string, string> {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  for (const name of [
    'AZURE_APPLICATION_ID',
    'AZURE_SECRET',
    'AZURE_DIRECTORY_ID',
    'AZURE_CLIENT_ID',
    'AZURE_CLIENT_SECRET',
    'AZURE_TENANT_ID',
    'AZURE_SUBSCRIPTION_ID',
    'ANYCLOUD_CLOUD_PROVIDER',
  ]) {
    delete environment[name];
  }
  writeLocalApiToken(childRoot);
  environment.CI = 'false';
  environment.HOME = childRoot;
  environment.ANYCLOUD_DIR = childRoot;
  environment.AZURE_CONFIG_DIR = bootstrap.configDir;
  environment.AZURE_CORE_ONLY_SHOW_ERRORS = 'true';
  environment.GITHUB_TOKEN = API_TOKEN;
  environment.API_URL = api.url;
  return environment;
}

function retryUntil<T>(operation: () => Promise<T>): Promise<T> {
  return new Waiter(new AbortController().signal)
    .for('Azure propagation', () => operation(), {
      timeoutMs: MAX_WAIT_MS,
      intervalMs: PROPAGATION_WAITS,
      probeError: { retry: () => true },
      unmet: () => undefined,
    })
    .catch(rethrowLastAttempt);
}

beforeAll(async () => {
  readAzureOnboardingSecrets();
  suiteRoot = await mkdtemp(join(tmpdir(), 'anycloud-azure-live-api-'));
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

describe('Azure live credentials onboarding terminal', () => {
  it(
    journeyTitle('azure.live-generation'),
    async () => {
      const secrets = readAzureOnboardingSecrets();
      const runToken = numericRunToken();
      const credentialName = managedCredentialName('onboarding', runToken);
      const displayName = `anycloud-${credentialName}`;
      const smokeContainerName =
        `anycloud-onb-smoke-${runToken}-` +
        randomUUID().replace(/-/g, '').slice(0, 16);
      const smokeContainer = {
        credentialName,
        bucketName: smokeContainerName,
        region: AZURE_SMOKE_REGION,
      };
      const childRoot = await mkdtemp(
        join(tmpdir(), 'anycloud-azure-live-cli-'),
      );
      let bootstrap: BootstrapAzureContext | undefined;
      let cli: PtyRun | undefined;
      let primaryError: Error | undefined;
      let smokeContainerMayExist = false;

      try {
        bootstrap = await createBootstrapAzureContext(secrets);
        const subscriptions = parseJsonArray(
          await runAdminAzure(bootstrap, [
            'account',
            'list',
            '--output',
            'json',
          ]),
          'Azure subscription list',
        ).filter(isAzureSubscription);
        const targetSubscription = subscriptions.find(
          (subscription) => subscription.id === secrets.subscriptionId,
        );
        if (!targetSubscription) {
          throw new Error(
            `Bootstrap Azure login cannot see subscription ${secrets.subscriptionId}.`,
          );
        }
        cli = spawnCliInPty(['credentials', 'new'], {
          cwd: childRoot,
          env: childEnvironment(childRoot, bootstrap),
        });
        const wizard = new WizardDriver(cli);
        cli.registerSecret(secrets.secret);
        await wizard.enterText('Name for this credential set:', credentialName);
        await wizard.selectChoice('Select cloud provider:', 'Azure', [
          'AWS',
          'Azure',
          'GCP',
          'Lambda',
        ]);
        await wizard.selectChoice(
          'How would you like to add Azure credentials?',
          'Create a service principal with Azure CLI',
          [
            'Enter existing service principal credentials',
            'Create a service principal with Azure CLI',
          ],
        );
        if (subscriptions.length > 1) {
          const labels = subscriptions.map((subscription) =>
            subscription.name
              ? `${subscription.name} (${subscription.id})`
              : subscription.id,
          );
          const targetLabel = targetSubscription.name
            ? `${targetSubscription.name} (${targetSubscription.id})`
            : targetSubscription.id;
          const initialSubscription =
            subscriptions.find((subscription) => subscription.isDefault) ??
            subscriptions[0];
          const initialLabel = initialSubscription.name
            ? `${initialSubscription.name} (${initialSubscription.id})`
            : initialSubscription.id;
          await wizard.selectChoice(
            'Select Azure subscription:',
            targetLabel,
            labels,
            { initial: initialLabel, timeoutMs: 60_000 },
          );
        }
        await cli.waitFor(`Tenant: ${secrets.tenantId}`);
        await cli.waitFor(`Subscription: ${secrets.subscriptionId}`);
        await cli.waitFor(`Scope: /subscriptions/${secrets.subscriptionId}`);
        await cli.waitFor('Roles: Contributor');
        await wizard.confirm('Create these Azure credentials?');
        await wizard.expectSuccess(
          credentialName,
          11 * 60_000,
          /Failed to create service principal:/,
        );
        expect(cli.output()).toMatch(/Secret expires: \S+/);

        const saved = await api.storedCredential(credentialName);
        expect(saved).toMatchObject({
          name: credentialName,
          cloudProvider: 'Azure',
          subscriptionId: secrets.subscriptionId,
          directoryId: secrets.tenantId,
        });
        expect(saved.applicationId).toEqual(expect.any(String));
        expect(saved.secret).toEqual(expect.any(String));
        wizard.assertSecretNotPresent(String(saved.secret));
        wizard.assertSecretNotPresent(secrets.secret);
        const applicationId = String(saved.applicationId);

        // This intentionally precedes every test-owned propagation retry. It
        // proves the saved two-role controller can immediately drive real Blob
        // CRUD through the API's Shared Key path.
        smokeContainerMayExist = true;
        await api.createBucket(smokeContainer);
        expect(await api.bucketExists(smokeContainer, { uncached: true })).toBe(
          true,
        );
        expect(await api.listBuckets(smokeContainer)).toContain(
          smokeContainerName,
        );
        await api.deleteBucket(smokeContainer);
        expect(await api.bucketExists(smokeContainer, { uncached: true })).toBe(
          false,
        );
        expect(await api.listBuckets(smokeContainer)).not.toContain(
          smokeContainerName,
        );
        smokeContainerMayExist = false;

        const principal = await retryUntil(async () =>
          parseJsonRecord(
            await runAdminAzure(bootstrap!, [
              'ad',
              'sp',
              'show',
              '--id',
              applicationId,
              '--output',
              'json',
            ]),
            'Azure service principal',
          ),
        );
        expect(principal).toMatchObject({
          appId: applicationId,
          displayName,
        });
        expect(principal.tags).toEqual(
          expect.arrayContaining([
            'AnycloudManaged',
            `AnycloudCredentialName:${credentialName}`,
          ]),
        );

        const application = await retryUntil(async () =>
          parseJsonRecord(
            await runAdminAzure(bootstrap!, [
              'ad',
              'app',
              'show',
              '--id',
              applicationId,
              '--output',
              'json',
            ]),
            'Azure application',
          ),
        );
        expect(application.tags).toEqual(
          expect.arrayContaining([
            'AnycloudManaged',
            `AnycloudCredentialName:${credentialName}`,
          ]),
        );

        const assignments = await retryUntil(async () => {
          const result = parseJsonArray(
            await runAdminAzure(bootstrap!, [
              'role',
              'assignment',
              'list',
              '--assignee',
              applicationId,
              '--scope',
              `/subscriptions/${secrets.subscriptionId}`,
              '--output',
              'json',
            ]),
            'Azure role assignment list',
          );
          const names = result.map((assignment) =>
            isRecord(assignment) &&
            typeof assignment.roleDefinitionName === 'string'
              ? assignment.roleDefinitionName
              : undefined,
          );
          expect(names).toEqual(['Contributor']);
          return result;
        });
        expect(assignments).toHaveLength(1);

        const generatedConfigDir = join(childRoot, 'generated-azure');
        await mkdir(generatedConfigDir, { recursive: true, mode: 0o700 });
        const generatedContext = { configDir: generatedConfigDir };
        // This phase proves the generated secret authenticates as the expected
        // tenant identity. The Azure bucket E2E separately proves that the
        // assigned subscription roles can provision resources.
        await retryUntil(() =>
          runAdminAzure(generatedContext, [
            'login',
            '--service-principal',
            '--username',
            applicationId,
            azureCliPasswordArgument(String(saved.secret)),
            '--tenant',
            secrets.tenantId,
            '--allow-no-subscriptions',
            '--output',
            'none',
          ]),
        );
        const generatedPrincipal = await retryUntil(async () =>
          parseJsonRecord(
            await runAdminAzure(generatedContext, [
              'rest',
              '--method',
              'GET',
              '--url',
              `https://graph.microsoft.com/v1.0/servicePrincipals(appId='${applicationId}')?$select=appId,displayName`,
              '--output',
              'json',
            ]),
            'Generated Azure service principal',
          ),
        );
        expect(generatedPrincipal).toMatchObject({
          appId: applicationId,
          displayName,
        });
      } catch (error) {
        primaryError =
          error instanceof Error
            ? error
            : new Error('Azure onboarding failed with a non-Error value.', {
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

      let smokeContainerRemoved = !smokeContainerMayExist;
      if (!smokeContainerRemoved) {
        smokeContainerRemoved = await cleanup(async () => {
          await api.deleteBucket(smokeContainer);
          if (await api.bucketExists(smokeContainer, { uncached: true })) {
            throw new Error(
              `Azure smoke container ${smokeContainerName} still exists.`,
            );
          }
        });
        if (!smokeContainerRemoved && bootstrap) {
          smokeContainerRemoved = await cleanup(() =>
            cleanupAzureOnboardingContainer(bootstrap, smokeContainerName),
          );
        }
      }

      if (smokeContainerRemoved) {
        await cleanup(() => api.deleteCredential(credentialName));
        if (bootstrap) {
          await cleanup(() =>
            cleanupAzureOnboardingIdentity(
              bootstrap,
              displayName,
              'onboarding',
            ),
          );
        }
      } else {
        cleanupErrors.push(
          new Error(
            `Retained Azure credential ${credentialName} and identity ${displayName} because smoke container cleanup could not be confirmed.`,
          ),
        );
      }
      if (bootstrap) {
        await cleanup(() => disposeBootstrapAzureContext(bootstrap));
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
          throw new AggregateError(
            [primaryError, ...cleanupErrors],
            'Azure onboarding and cleanup failed.',
            { cause: primaryError },
          );
        }
        throw primaryError;
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          cleanupErrors,
          'Azure onboarding cleanup failed.',
        );
      }
    },
    20 * 60_000,
  );

  it(
    journeyTitle('azure.live-manual'),
    async () => {
      const secrets = readAzureOnboardingSecrets();
      const runToken = `${numericRunToken()}7`;
      const credentialName = managedCredentialName('onboarding', runToken);
      const displayName = `anycloud-${credentialName}`;
      const smokeContainerName =
        `anycloud-onb-smoke-${runToken}-` +
        randomUUID().replace(/-/g, '').slice(0, 16);
      const smokeContainer = {
        credentialName,
        bucketName: smokeContainerName,
        region: AZURE_SMOKE_REGION,
      };
      const childRoot = await mkdtemp(
        join(tmpdir(), 'anycloud-azure-manual-live-cli-'),
      );
      let bootstrap: BootstrapAzureContext | undefined;
      let fixture: AzureManualCredentialFixture | undefined;
      let cli: PtyRun | undefined;
      let primaryError: Error | undefined;
      let smokeContainerMayExist = false;

      try {
        bootstrap = await createBootstrapAzureContext(secrets);
        fixture = await createAzureManualCredentialFixture(
          bootstrap,
          secrets.tenantId,
          credentialName,
          'onboarding',
        );
        cli = spawnCliInPty(['credentials', 'new'], {
          cwd: childRoot,
          env: childEnvironment(childRoot, bootstrap),
        });
        const wizard = new WizardDriver(cli);
        cli.registerSecret(fixture.secret);
        cli.registerSecret(secrets.secret);
        await wizard.enterText('Name for this credential set:', credentialName);
        await wizard.selectChoice('Select cloud provider:', 'Azure', [
          'AWS',
          'Azure',
          'GCP',
          'Lambda',
        ]);
        await wizard.selectChoice(
          'How would you like to add Azure credentials?',
          'Enter existing service principal credentials',
          [
            'Enter existing service principal credentials',
            'Create a service principal with Azure CLI',
          ],
        );
        await wizard.enterText(
          'Service Principal Application ID (appId):',
          fixture.applicationId,
        );
        await wizard.enterSecret(
          'Service Principal Secret (password):',
          fixture.secret,
        );
        await wizard.enterText('Subscription ID:', fixture.subscriptionId);
        await wizard.enterText('Directory ID (Tenant ID):', fixture.tenantId);
        await wizard.confirm(
          `Save these Azure credentials as "${credentialName}"?`,
        );
        await wizard.expectSuccess(credentialName);

        const saved = await api.storedCredential(credentialName);
        expect(saved).toMatchObject({
          name: credentialName,
          cloudProvider: 'Azure',
          applicationId: fixture.applicationId,
          secret: fixture.secret,
          subscriptionId: fixture.subscriptionId,
          directoryId: fixture.tenantId,
        });
        wizard.assertSecretNotPresent(fixture.secret);
        wizard.assertSecretNotPresent(secrets.secret);

        smokeContainerMayExist = true;
        await api.createBucket(smokeContainer);
        expect(await api.bucketExists(smokeContainer, { uncached: true })).toBe(
          true,
        );
        expect(await api.listBuckets(smokeContainer)).toContain(
          smokeContainerName,
        );
        await api.deleteBucket(smokeContainer);
        expect(await api.bucketExists(smokeContainer, { uncached: true })).toBe(
          false,
        );
        smokeContainerMayExist = false;
      } catch (error) {
        primaryError =
          error instanceof Error
            ? error
            : new Error('Azure manual onboarding failed.', { cause: error });
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
      let smokeContainerRemoved = !smokeContainerMayExist;
      if (!smokeContainerRemoved) {
        smokeContainerRemoved = await cleanup(async () => {
          await api.deleteBucket(smokeContainer);
          if (await api.bucketExists(smokeContainer, { uncached: true })) {
            throw new Error(
              `Azure smoke container ${smokeContainerName} still exists.`,
            );
          }
        });
        if (!smokeContainerRemoved && bootstrap) {
          smokeContainerRemoved = await cleanup(() =>
            cleanupAzureOnboardingContainer(bootstrap, smokeContainerName),
          );
        }
      }
      if (smokeContainerRemoved) {
        await cleanup(() => api.deleteCredential(credentialName));
        if (bootstrap) {
          await cleanup(() =>
            cleanupAzureOnboardingIdentity(
              bootstrap,
              displayName,
              'onboarding',
            ),
          );
        }
      } else {
        cleanupErrors.push(
          new Error(
            `Retained Azure credential ${credentialName} and identity ${displayName} because smoke container cleanup could not be confirmed.`,
          ),
        );
      }
      if (bootstrap) {
        await cleanup(() => disposeBootstrapAzureContext(bootstrap));
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
            `Azure manual onboarding cleanup also failed: ${cleanupErrors.map((error) => error.message).join('; ')}`,
          );
        }
        throw primaryError;
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          cleanupErrors,
          'Azure manual onboarding cleanup failed.',
        );
      }
    },
    20 * 60_000,
  );
});

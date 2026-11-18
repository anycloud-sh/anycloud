import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { isRecord, parseJsonArray } from '../../helpers/json.js';
import {
  MAX_WAIT_MS,
  Waiter,
  WaitTimeoutError,
} from '../../e2e/internal/wait.js';
import { retryUntilDeadline } from '../common/deadline-retry.js';
import { withTimeout } from '../../../../src/shared/utils.js';
import anycloudRole from '../../../../src/shared/cloud-policies/azure-anycloud-role.json' with { type: 'json' };
import {
  azureOnboardingRunLocator,
  type AzureOnboardingRunLocator,
} from './run-authority.js';

const execFileAsync = promisify(execFile);

export type AzureOnboardingIdentitySuite = 'onboarding' | 'bucket';

export interface AzureOnboardingSecrets {
  subscriptionId: string;
  tenantId: string;
  applicationId: string;
  secret: string;
}

export interface BootstrapAzureContext {
  bootstrapAppId: string;
  subscriptionId: string;
  configDir: string;
  rootDir: string;
  run?: (args: string[], environment?: NodeJS.ProcessEnv) => Promise<string>;
  cleanupDiscoveryWaits?: number[];
  wait?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

export interface AzureManualCredentialFixture {
  applicationId: string;
  secret: string;
  subscriptionId: string;
  tenantId: string;
  displayName: string;
  /** The created directory objects, for strict (`az rest`) cleanup. */
  binding: AzureOnboardingIdentityBinding;
}

export interface ListedAzureDirectoryObject {
  id?: string;
  appId: string;
  displayName: string;
  tags?: string[];
}

function isListedAzureDirectoryObject(
  value: unknown,
): value is ListedAzureDirectoryObject {
  return (
    isRecord(value) &&
    typeof value.appId === 'string' &&
    typeof value.displayName === 'string'
  );
}

export interface ManagedAzureIdentity {
  appId: string;
  displayName: string;
}

export interface AzureOnboardingIdentityBinding {
  readonly application: ListedAzureDirectoryObject & { readonly id: string };
  readonly servicePrincipal: ListedAzureDirectoryObject & {
    readonly id: string;
  };
}

const MANAGED_IDENTITY_PREFIX: Record<AzureOnboardingIdentitySuite, string> = {
  onboarding: 'onb',
  bucket: 'bkt',
};
const MANAGED_TAG = 'AnycloudManaged';
const CREDENTIAL_TAG_KEY = 'AnycloudCredentialName';
const CREDENTIAL_TAG_PREFIX = `${CREDENTIAL_TAG_KEY}:`;
const ONBOARDING_SMOKE_CONTAINER_PATTERN =
  /^anycloud-onb-smoke-[0-9]+-[a-f0-9]{16}$/;
const DEFAULT_CLEANUP_WAITS = [500, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000];
// A strict directory delete's absence gets its own ≈5 min window rather than
// the ≈60 s cleanup schedule: Entra answered a still-listed application's
// DELETE with not-found for over a minute (run 38064531855).
const ABSENCE_CONFIRMATION_WAITS = [
  ...DEFAULT_CLEANUP_WAITS,
  ...Array<number>(8).fill(30_000),
];
const AZURE_MANUAL_READINESS_TIMEOUT_MS = 10 * 60_000;
const CONTRIBUTOR_ROLE_ID = 'b24988ac-6180-42a0-ab88-20f7382dd24c';
const AZURE_READINESS_RESOURCE_GROUP_LOCATION = 'eastus';
const AZURE_STORAGE_RESOURCE_GROUP = 'anycloud-storage';

function managedAzureStorageAccountName(subscriptionId: string): string {
  return `anycloud${subscriptionId.replace(/-/g, '').slice(0, 8)}`;
}

function requiredEnvironmentValue(
  canonicalName: string,
  compatibilityName?: string,
): string {
  const value =
    process.env[canonicalName] ??
    (compatibilityName ? process.env[compatibilityName] : undefined);
  if (!value?.trim()) {
    const names = compatibilityName
      ? `${canonicalName} or ${compatibilityName}`
      : canonicalName;
    throw new Error(`${names} is required for real Azure onboarding tests.`);
  }
  return value;
}

export function readAzureOnboardingSecrets(): AzureOnboardingSecrets {
  return {
    subscriptionId: requiredEnvironmentValue('AZURE_SUBSCRIPTION_ID'),
    tenantId: requiredEnvironmentValue('AZURE_TENANT_ID', 'AZURE_DIRECTORY_ID'),
    applicationId: requiredEnvironmentValue(
      'AZURE_CLIENT_ID',
      'AZURE_APPLICATION_ID',
    ),
    secret: requiredEnvironmentValue('AZURE_CLIENT_SECRET', 'AZURE_SECRET'),
  };
}

export function managedCredentialName(
  suite: AzureOnboardingIdentitySuite,
  numericToken: string,
): string {
  if (!/^[0-9]+$/.test(numericToken)) {
    throw new Error('Managed Azure credential tokens must be numeric.');
  }
  return `${MANAGED_IDENTITY_PREFIX[suite]}-${numericToken}`;
}

function managedDisplayNamePattern(
  suite: AzureOnboardingIdentitySuite,
): RegExp {
  return new RegExp(`^anycloud-${MANAGED_IDENTITY_PREFIX[suite]}-([0-9]+)$`);
}

function isMarked(
  object: ListedAzureDirectoryObject,
  run?: AzureOnboardingRunLocator,
): boolean {
  const credentialName = object.displayName.replace(/^anycloud-/, '');
  const tags = object.tags;
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string'))
    return false;
  const expected = [MANAGED_TAG, `${CREDENTIAL_TAG_PREFIX}${credentialName}`];
  if (run) expected.push(`AnycloudOperation:${run.operationId}`);
  return (
    expected.every(
      (tag) => tags.filter((value) => value === tag).length === 1,
    ) &&
    (!run ||
      tags.filter((tag) => /^Anycloud(CredentialName|Operation):/i.test(tag))
        .length === 2)
  );
}

export function selectManagedAzureIdentities(
  servicePrincipals: ListedAzureDirectoryObject[],
  applications: ListedAzureDirectoryObject[],
  bootstrapAppId: string,
  suite: AzureOnboardingIdentitySuite,
  run?: AzureOnboardingRunLocator,
): ManagedAzureIdentity[] {
  const pattern = run
    ? new RegExp(`^${run.displayName}$`)
    : managedDisplayNamePattern(suite);
  const guid =
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if (
    run &&
    (servicePrincipals.length > 1 ||
      applications.length > 1 ||
      new Set(
        [...servicePrincipals, ...applications].map((object) => object.appId),
      ).size > 1 ||
      [...servicePrincipals, ...applications].some(
        (object) =>
          !guid.test(object.id ?? '') ||
          !guid.test(object.appId) ||
          object.appId.toLowerCase() === bootstrapAppId.toLowerCase(),
      ))
  )
    return [];
  const all = [...servicePrincipals, ...applications].filter(
    (object) =>
      object.appId !== bootstrapAppId && pattern.test(object.displayName),
  );
  const appIds = [...new Set(all.map((object) => object.appId))];
  return appIds.flatMap((appId) => {
    const objects = all.filter((object) => object.appId === appId);
    if (
      objects.length === 0 ||
      objects.some((object) => !isMarked(object, run))
    ) {
      return [];
    }
    const [first] = objects;
    if (objects.some((object) => object.displayName !== first.displayName)) {
      return [];
    }
    return [{ appId, displayName: first.displayName }];
  });
}

function azureEnvironment(configDir: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    AZURE_CONFIG_DIR: configDir,
    AZURE_CORE_ONLY_SHOW_ERRORS: 'true',
  };
  for (const name of [
    'AZURE_CLIENT_SECRET',
    'AZURE_CLIENT_ID',
    'AZURE_TENANT_ID',
    'AZURE_SECRET',
    'AZURE_APPLICATION_ID',
    'AZURE_DIRECTORY_ID',
    'AZURE_STORAGE_CONNECTION_STRING',
    'AZURE_STORAGE_SAS_TOKEN',
    'AZURE_STORAGE_KEY',
    'AZURE_STORAGE_ACCOUNT',
    'AZURE_STORAGE_SERVICE_ENDPOINT',
  ]) {
    delete environment[name];
  }
  return environment;
}

function isRetryableAzureApplicationPasswordError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /Request_ResourceNotFound|\bnot found\b/i.test(message) ||
    (/\bForbidden\b/i.test(message) &&
      /\bAuthorization_RequestDenied\b/i.test(message) &&
      /Insufficient privileges to complete the operation/i.test(message))
  );
}

export function azureCliPasswordArgument(secret: string): string {
  return `--password=${secret}`;
}

function redactAzureCliPasswordError(error: unknown, args: string[]): Error {
  const secrets = args.flatMap((argument, index) => {
    if (argument === '--password') return [args[index + 1]];
    if (argument.startsWith('--password=')) {
      return [argument.slice('--password='.length)];
    }
    return [];
  });
  const sensitiveValues = secrets.filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  const source = error instanceof Error ? error : new Error(String(error));
  if (sensitiveValues.length === 0) return source;
  const redact = (value: string): string => {
    let redacted = value;
    for (const secret of sensitiveValues.sort((a, b) => b.length - a.length)) {
      redacted = redacted.split(secret).join('[REDACTED]');
    }
    return redacted;
  };
  const sanitized = new Error(redact(source.message)) as Error & {
    code?: unknown;
  };
  sanitized.name = source.name;
  const code = (source as Error & { code?: unknown }).code;
  if (code !== undefined) {
    sanitized.code = typeof code === 'string' ? redact(code) : code;
  }
  return sanitized;
}

export async function runAdminAzure(
  context: Pick<BootstrapAzureContext, 'configDir' | 'run'>,
  args: string[],
  environment?: NodeJS.ProcessEnv,
): Promise<string> {
  try {
    if (context.run) return await context.run(args, environment);
    const { stdout } = await execFileAsync('az', args, {
      env: { ...azureEnvironment(context.configDir), ...environment },
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    throw redactAzureCliPasswordError(error, args);
  }
}

export async function createBootstrapAzureContext(
  secrets = readAzureOnboardingSecrets(),
): Promise<BootstrapAzureContext> {
  const rootDir = await mkdtemp(join(tmpdir(), 'anycloud-azure-bootstrap-'));
  const context: BootstrapAzureContext = {
    bootstrapAppId: secrets.applicationId,
    subscriptionId: secrets.subscriptionId,
    configDir: join(rootDir, 'azure'),
    rootDir,
  };
  try {
    await runAdminAzure(context, [
      'login',
      '--service-principal',
      '--username',
      secrets.applicationId,
      azureCliPasswordArgument(secrets.secret),
      '--tenant',
      secrets.tenantId,
      '--output',
      'none',
    ]);
    await runAdminAzure(context, [
      'account',
      'set',
      '--subscription',
      secrets.subscriptionId,
    ]);
    return context;
  } catch (error) {
    await rm(rootDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
    throw error;
  }
}

export async function disposeBootstrapAzureContext(
  context: BootstrapAzureContext,
): Promise<void> {
  await rm(context.rootDir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}

/**
 * A per-run test principal (RFC 0047): created once and removable before,
 * during or after creation, each step in its own bootstrap CLI session.
 * Removal waits for an in-flight creation and is bounded by its deadline.
 */
export class AzureTestPrincipal {
  readonly #open: () => Promise<BootstrapAzureContext>;
  readonly #tenantId: string;
  readonly #name: string;
  readonly #options: Parameters<typeof createAzureManualCredentialFixture>[4];
  #creation: Promise<AzureManualCredentialFixture> | undefined;
  #binding: AzureOnboardingIdentityBinding | undefined;

  constructor(
    secrets: AzureOnboardingSecrets,
    name: string,
    options: Parameters<typeof createAzureManualCredentialFixture>[4],
    open = () => createBootstrapAzureContext(secrets),
  ) {
    this.#open = open;
    this.#tenantId = secrets.tenantId;
    this.#name = name;
    this.#options = options;
  }

  create(): Promise<AzureManualCredentialFixture> {
    if (this.#creation)
      return Promise.reject(new Error('Azure test principal is single use'));
    this.#creation = (async () => {
      const context = await this.#open();
      try {
        const fixture = await createAzureManualCredentialFixture(
          context,
          this.#tenantId,
          this.#name,
          'bucket',
          this.#options,
        );
        this.#binding = fixture.binding;
        return fixture;
      } finally {
        await disposeBootstrapAzureContext(context);
      }
    })();
    return this.#creation;
  }

  async remove(deadlineAt = Number.POSITIVE_INFINITY): Promise<void> {
    if (!this.#creation) return;
    await this.#creation.catch(() => undefined);
    const context = await this.#open();
    try {
      const cleanup = cleanupAzureOnboardingIdentity(
        context,
        `anycloud-${this.#name}`,
        'bucket',
        undefined,
        this.#binding,
      );
      await (Number.isFinite(deadlineAt)
        ? withTimeout(
            cleanup,
            Math.max(0, deadlineAt - Date.now()),
            'Azure test principal cleanup',
          )
        : cleanup);
    } finally {
      await disposeBootstrapAzureContext(context);
    }
  }
}

export async function createAzureManualCredentialFixture(
  context: BootstrapAzureContext,
  tenantId: string,
  credentialName: string,
  suite: AzureOnboardingIdentitySuite,
  /** Without grants the principal holds no role, so the caller owns its readiness. */
  {
    grants = true,
    publishedRole = false,
  }: {
    readonly grants?: boolean;
    /** RFC 0047: hold only the published Anycloud role, not Contributor. */
    readonly publishedRole?: boolean;
  } = {},
): Promise<AzureManualCredentialFixture> {
  const displayName = `anycloud-${credentialName}`;
  if (!managedDisplayNamePattern(suite).test(displayName)) {
    throw new Error(
      `Refusing to create unmanaged Azure identity ${displayName}.`,
    );
  }
  const tags = [MANAGED_TAG, `${CREDENTIAL_TAG_PREFIX}${credentialName}`];
  const scope = `/subscriptions/${context.subscriptionId}`;
  try {
    const application = JSON.parse(
      await runAdminAzure(context, [
        'rest',
        '--method',
        'POST',
        '--url',
        'https://graph.microsoft.com/v1.0/applications',
        '--body',
        JSON.stringify({ displayName, signInAudience: 'AzureADMyOrg', tags }),
        '--output',
        'json',
      ]),
    ) as { id?: string; appId?: string };
    if (!application.id || !application.appId) {
      throw new Error('Azure did not return test application identifiers.');
    }

    const principalFailure = 'Azure did not create the test service principal.';
    const principal = await retryAzureCreation(
      context,
      principalFailure,
      async () =>
        JSON.parse(
          await runAdminAzure(context, [
            'rest',
            '--method',
            'POST',
            '--url',
            'https://graph.microsoft.com/v1.0/servicePrincipals',
            '--body',
            JSON.stringify({ appId: application.appId, tags }),
            '--output',
            'json',
          ]),
        ) as { id?: string; appId?: string },
    );
    if (!principal.id || principal.appId !== application.appId) {
      throw new Error(principalFailure);
    }

    const passwordFailure = 'Azure did not return the test principal secret.';
    const password = await retryAzureCreation(
      context,
      passwordFailure,
      async () =>
        JSON.parse(
          await runAdminAzure(context, [
            'rest',
            '--method',
            'POST',
            '--url',
            `https://graph.microsoft.com/v1.0/applications/${application.id}/addPassword`,
            '--body',
            JSON.stringify({
              passwordCredential: {
                displayName: `Anycloud test import ${credentialName}`,
              },
            }),
            '--output',
            'json',
          ]),
        ) as { secretText?: string },
      isRetryableAzureApplicationPasswordError,
    );
    if (!password.secretText) throw new Error(passwordFailure);
    const applicationId = application.appId;
    const principalId = principal.id;
    const principalSecret = password.secretText;
    const fixture = {
      applicationId,
      secret: principalSecret,
      subscriptionId: context.subscriptionId,
      tenantId,
      displayName,
      binding: {
        application: {
          id: application.id,
          appId: applicationId,
          displayName,
          tags,
        },
        servicePrincipal: {
          id: principalId,
          appId: applicationId,
          displayName,
          tags,
        },
      },
    };
    if (!grants) return fixture;

    const roleId = publishedRole
      ? await putPublishedRole(context)
      : CONTRIBUTOR_ROLE_ID;
    // The deterministic assignment name is what strict cleanup accepts.
    await retryAzureCreation(
      context,
      `Azure did not grant the test role ${roleId}.`,
      () =>
        runAdminAzure(context, [
          'role',
          'assignment',
          'create',
          '--name',
          deterministicAzureGuid(scope, principalId, roleId),
          '--assignee-object-id',
          principalId,
          '--assignee-principal-type',
          'ServicePrincipal',
          '--role',
          roleId,
          '--scope',
          scope,
          '--output',
          'none',
        ]),
    );

    const validationConfigDir = join(context.rootDir, 'manual-validation');
    await mkdir(validationConfigDir, { recursive: true, mode: 0o700 });
    const validationContext = { ...context, configDir: validationConfigDir };
    // The published role is probed with the gateway's own credential check.
    // Contributor is probed with Provider validation, which checks RBAC write
    // permission for a tagged empty group without creating it, so it cannot
    // depend on a storage account left behind by another journey.
    let probe = ['group', 'list', '--subscription', context.subscriptionId];
    if (!publishedRole) {
      const readinessResourceGroupName = `${displayName}-readiness`;
      const readinessTemplatePath = join(
        validationConfigDir,
        `${credentialName}-contributor-readiness.json`,
      );
      // The schema and CLI command use Azure Resource Manager's native
      // deployment terminology.
      await writeFile(
        readinessTemplatePath,
        JSON.stringify({
          $schema:
            'https://schema.management.azure.com/schemas/2018-05-01/subscriptionDeploymentTemplate.json#',
          contentVersion: '1.0.0.0',
          resources: [
            {
              type: 'Microsoft.Resources/resourceGroups',
              apiVersion: '2022-09-01',
              name: readinessResourceGroupName,
              location: AZURE_READINESS_RESOURCE_GROUP_LOCATION,
              tags: {
                [MANAGED_TAG]: 'true',
                [CREDENTIAL_TAG_KEY]: credentialName,
              },
            },
          ],
        }),
        { mode: 0o600 },
      );
      probe = [
        'deployment',
        'sub',
        'validate',
        '--name',
        readinessResourceGroupName,
        '--location',
        AZURE_READINESS_RESOURCE_GROUP_LOCATION,
        '--template-file',
        readinessTemplatePath,
        '--validation-level',
        'Provider',
        '--subscription',
        context.subscriptionId,
        '--no-prompt',
        'true',
      ];
    }
    const now = context.now ?? Date.now;
    try {
      await retryUntilDeadline(
        async () => {
          await runAdminAzure(
            validationContext,
            [
              'login',
              '--service-principal',
              '--username',
              applicationId,
              azureCliPasswordArgument(principalSecret),
              '--tenant',
              tenantId,
              '--output',
              'none',
            ],
            { AZURE_CONFIG_DIR: validationConfigDir },
          );
          await runAdminAzure(validationContext, [
            'account',
            'set',
            '--subscription',
            context.subscriptionId,
          ]);
          await runAdminAzure(validationContext, [
            ...probe,
            '--output',
            'none',
          ]);
          // The API's first bucket call reads storage accounts, which can
          // stay AuthorizationFailed after the probe above passes.
          await runAdminAzure(validationContext, [
            'storage',
            'account',
            'list',
            '--subscription',
            context.subscriptionId,
            '--output',
            'none',
          ]);
        },
        {
          deadline: now() + AZURE_MANUAL_READINESS_TIMEOUT_MS,
          initialDelayMs: 500,
          maxDelayMs: 30_000,
          now,
          random: context.random,
          wait: context.wait,
        },
      );
    } catch (cause) {
      throw new Error(
        'The test-owned Azure principal did not acquire its required ARM capabilities.',
        { cause },
      );
    }
    return fixture;
  } catch (error) {
    await cleanupAzureOnboardingIdentity(context, displayName, suite).catch(
      () => undefined,
    );
    throw error;
  }
}

function deterministicAzureGuid(...parts: string[]): string {
  const bytes = createHash('sha256')
    .update(parts.join('\0'))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The only Graph URLs the strict cleanup may DELETE through `az rest`. */
export function azureGraphObjectUrl(kind: 'sp' | 'app', id: string): string {
  return `https://graph.microsoft.com/v1.0/${kind === 'app' ? 'applications' : 'servicePrincipals'}/${id}`;
}

function quoteOData(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function cleanupWaits(context: BootstrapAzureContext): number[] {
  return context.cleanupDiscoveryWaits ?? DEFAULT_CLEANUP_WAITS;
}

// Azure can accept a role assignment before the new principal sees the
// subscription, so match the production generator's readiness budget.
const CREATION_WAITS = [500, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000];

/** Retries a creation step through `CREATION_WAITS`, then fails as `failure`, caused by the last error. */
async function retryAzureCreation<T>(
  context: BootstrapAzureContext,
  failure: string,
  create: () => Promise<T>,
  retry: (error: unknown) => boolean = () => true,
): Promise<T> {
  try {
    return await azureWaiter(context).for(failure, create, {
      timeoutMs: MAX_WAIT_MS,
      intervalMs: CREATION_WAITS,
      probeError: { retry },
      unmet: () => undefined,
    });
  } catch (error) {
    if (!(error instanceof WaitTimeoutError)) throw error;
    throw new Error(failure, { cause: error.cause });
  }
}

function azureWaiter(context: BootstrapAzureContext): Waiter {
  // A Job transport rejects a zero-length wait as an expired deadline.
  return new Waiter(new AbortController().signal, async (milliseconds) => {
    if (milliseconds > 0) await waitForAzureOperation(context, milliseconds);
  });
}

async function waitForAzureOperation(
  context: BootstrapAzureContext,
  milliseconds: number,
): Promise<void> {
  if (context.wait) {
    await context.wait(milliseconds);
    return;
  }
  await new Promise<void>((done) => setTimeout(done, milliseconds));
}

async function listDirectoryObjects(
  context: BootstrapAzureContext,
  kind: 'sp' | 'app',
  filter: string,
): Promise<ListedAzureDirectoryObject[]> {
  const output = await runAdminAzure(context, [
    'ad',
    kind,
    'list',
    '--all',
    '--filter',
    filter,
    '--output',
    'json',
  ]);
  return parseJsonArray(output, 'Azure directory object list').map((object) => {
    if (!isListedAzureDirectoryObject(object)) {
      throw new Error('Azure returned an invalid directory object.');
    }
    return object;
  });
}

async function listExactIdentityObjects(
  context: BootstrapAzureContext,
  displayName: string,
): Promise<{
  servicePrincipals: ListedAzureDirectoryObject[];
  applications: ListedAzureDirectoryObject[];
}> {
  const filter = `displayName eq ${quoteOData(displayName)}`;
  const servicePrincipals = await listDirectoryObjects(context, 'sp', filter);
  const applications = await listDirectoryObjects(context, 'app', filter);
  return {
    servicePrincipals: servicePrincipals.filter(
      (object) => object.displayName === displayName,
    ),
    applications: applications.filter(
      (object) => object.displayName === displayName,
    ),
  };
}

function mergeDirectoryObjects(
  existing: ListedAzureDirectoryObject[],
  discovered: ListedAzureDirectoryObject[],
): ListedAzureDirectoryObject[] {
  const objects = new Map<string, ListedAzureDirectoryObject>();
  for (const object of [...existing, ...discovered]) {
    objects.set(`${object.id ?? ''}\0${object.appId}`, object);
  }
  return [...objects.values()];
}

async function discoverExactIdentityObjects(
  context: BootstrapAzureContext,
  displayName: string,
): Promise<{
  servicePrincipals: ListedAzureDirectoryObject[];
  applications: ListedAzureDirectoryObject[];
}> {
  let inventory = await listExactIdentityObjects(context, displayName);
  if (
    inventory.servicePrincipals.length === 0 &&
    inventory.applications.length === 0
  ) {
    return inventory;
  }
  // eslint-disable-next-line local/no-hand-written-retry-loops -- accumulates listings across reads until both kinds are found, then returns what it found
  for (const milliseconds of cleanupWaits(context)) {
    if (
      inventory.servicePrincipals.length > 0 &&
      inventory.applications.length > 0
    ) {
      break;
    }
    await waitForAzureOperation(context, milliseconds);
    const discovered = await listExactIdentityObjects(context, displayName);
    inventory = {
      servicePrincipals: mergeDirectoryObjects(
        inventory.servicePrincipals,
        discovered.servicePrincipals,
      ),
      applications: mergeDirectoryObjects(
        inventory.applications,
        discovered.applications,
      ),
    };
  }
  return inventory;
}

function isDirectoryDeleteDenialError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Insufficient privileges to complete the operation|Authorization_RequestDenied/i.test(
    message,
  );
}

async function confirmDirectoryObjectAbsent(
  context: BootstrapAzureContext,
  kind: 'sp' | 'app',
  displayName: string,
  appId: string,
): Promise<boolean> {
  try {
    await confirmRunAbsence(context, async () => {
      try {
        return !(
          await listDirectoryObjects(
            context,
            kind,
            `displayName eq ${quoteOData(displayName)}`,
          )
        ).some((object) => object.appId === appId);
      } catch {
        // An unavailable listing resets absence evidence and uses the retry budget.
        return false;
      }
    });
    return true;
  } catch {
    // Preserve the original delete denial when absence cannot be established.
    return false;
  }
}

async function deleteManagedAzureIdentity(
  context: BootstrapAzureContext,
  identity: ManagedAzureIdentity,
  servicePrincipal: ListedAzureDirectoryObject | undefined,
  application: ListedAzureDirectoryObject | undefined,
  strict = false,
): Promise<void> {
  const scope = `/subscriptions/${context.subscriptionId}`;
  const failures: string[] = [];
  const runCleanup = async (args: string[]): Promise<string | undefined> => {
    try {
      return await runAdminAzure(context, args);
    } catch (error) {
      if (strict) throw error;
      const message = (error as Error).message;
      if (
        !/could not be found|does not exist|not found|ResourceNotFound|RoleAssignmentNotFound|Request_ResourceNotFound/i.test(
          message,
        )
      ) {
        failures.push(`${args.slice(0, 3).join(' ')}: ${message}`);
      }
      return undefined;
    }
  };
  const runDirectoryCleanup = async (
    kind: 'sp' | 'app',
    target: ListedAzureDirectoryObject,
  ): Promise<void> => {
    const args = [
      'ad',
      kind,
      'delete',
      '--id',
      target.id ?? identity.appId,
      '--output',
      'none',
    ];
    if (strict) {
      if (!target.id) throw new Error('Azure directory object ID is missing.');
      // `az ad` keeps only Graph's error message (azure-cli
      // role/_msgrpah/_graph_client.py raises GraphError(error['message'])),
      // while `az rest` prints the response body, so its code can be classified.
      const graphArgs = [
        'rest',
        '--method',
        'DELETE',
        '--url',
        azureGraphObjectUrl(kind, target.id),
        '--output',
        'none',
      ];
      await deleteAndConfirmRunResource(
        context,
        () => runAdminAzure(context, graphArgs),
        async () =>
          (
            await listDirectoryObjects(
              context,
              kind,
              `appId eq ${quoteOData(target.appId)}`,
            )
          ).length === 0,
        context.cleanupDiscoveryWaits ?? ABSENCE_CONFIRMATION_WAITS,
      );
      return;
    }
    try {
      await azureWaiter(context).for(
        `Azure ${kind} delete`,
        () => runAdminAzure(context, args),
        {
          timeoutMs: MAX_WAIT_MS,
          intervalMs: cleanupWaits(context),
          probeError: {
            retry: (error) =>
              /could not be found|does not exist|not found|DirectoryObjectNotFound|ResourceNotFound|Request_ResourceNotFound/i.test(
                (error as Error).message,
              ),
          },
          unmet: () => undefined,
        },
      );
    } catch (error) {
      // Azure's directory list index can outlive the object returned by the
      // delete endpoint. After bounded retries, a persistent not-found is the
      // idempotent result of an object that was already deleted.
      if (error instanceof WaitTimeoutError) return;
      const message = (error as Error).message;
      // Entra deletes an orphaned service principal by asynchronous cascade
      // once its application is gone, and the app-only bootstrap principal
      // is denied a direct delete on the dying object. The denial is the
      // idempotent result only once the directory listing no longer returns
      // the object; while it remains listed it is a leak to report.
      if (
        isDirectoryDeleteDenialError(error) &&
        (await confirmDirectoryObjectAbsent(
          context,
          kind,
          identity.displayName,
          target.appId,
        ))
      ) {
        return;
      }
      failures.push(`${args.slice(0, 3).join(' ')}: ${message}`);
    }
  };

  // Inventory assignments before removing the principal so every deletion is
  // by an exact resource ID and remains retryable after partial cleanup.
  if (servicePrincipal) {
    const assignmentArgs = [
      'role',
      'assignment',
      'list',
      '--assignee-object-id',
      servicePrincipal.id ?? identity.appId,
      ...(strict
        ? ['--all', '--subscription', context.subscriptionId]
        : ['--scope', scope]),
      '--fill-principal-name',
      'false',
      '--fill-role-definition-name',
      'false',
      '--output',
      'json',
    ];
    const assignmentOutput = await runCleanup(assignmentArgs);
    if (assignmentOutput !== undefined) {
      const assignments = parseJsonArray(
        assignmentOutput,
        'Azure role assignment list',
      );
      if (strict)
        assertGeneratedAssignments(assignments, scope, servicePrincipal.id!);
      for (const assignment of assignments) {
        if (!isRecord(assignment) || typeof assignment.id !== 'string') {
          throw new Error(
            'Invalid Azure role assignment ID; identity retained.',
          );
        }
        await runCleanup([
          'role',
          'assignment',
          'delete',
          '--ids',
          assignment.id,
          '--output',
          'none',
        ]);
      }
      if (strict) {
        await confirmRunAbsence(
          context,
          async () =>
            parseJsonArray(
              await runAdminAzure(context, assignmentArgs),
              'Azure role assignment list',
            ).length === 0,
        );
      }
    }
  }

  // Keep the directory objects when role cleanup was denied or could not be
  // inventoried. That preserves the principal object ID for a safe retry.
  if (failures.length > 0) {
    throw new Error(
      `Azure role cleanup for ${identity.displayName} had ${failures.length} failure(s): ${failures.join('; ')}`,
    );
  }

  if (servicePrincipal) {
    await runDirectoryCleanup('sp', servicePrincipal);
  }
  if (application && failures.length === 0) {
    await runDirectoryCleanup('app', application);
  }
  if (failures.length > 0) {
    throw new Error(
      `Azure directory cleanup for ${identity.displayName} had ${failures.length} failure(s): ${failures.join('; ')}`,
    );
  }
}

export async function cleanupAzureOnboardingIdentity(
  context: BootstrapAzureContext,
  displayName: string,
  suite: AzureOnboardingIdentitySuite,
  run?: AzureOnboardingRunLocator,
  captured?: AzureOnboardingIdentityBinding,
): Promise<void> {
  if (run) assertRunLocator(run);
  if (
    run
      ? displayName !== run.displayName
      : !managedDisplayNamePattern(suite).test(displayName)
  ) {
    throw new Error(
      `Refusing to clean unmanaged Azure identity ${displayName}.`,
    );
  }
  let inventory = await discoverExactIdentityObjects(context, displayName);
  if (captured) {
    const originals = [captured.application, captured.servicePrincipal];
    if (
      originals.some(
        (object) =>
          object.displayName !== displayName ||
          !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(
            object.id,
          ),
      ) ||
      selectManagedAzureIdentities(
        [captured.servicePrincipal],
        [captured.application],
        context.bootstrapAppId,
        suite,
        run,
      ).length !== 1
    )
      throw new Error(
        'Azure cleanup binding is not an original managed identity',
      );
    for (const kind of ['applications', 'servicePrincipals'] as const) {
      const original =
        kind === 'applications'
          ? captured.application
          : captured.servicePrincipal;
      if (
        inventory[kind].some(
          (object) =>
            object.id !== original.id || object.appId !== original.appId,
        )
      )
        throw new Error(
          'Azure cleanup observed a replacement directory identity',
        );
      // A vanished directory index must not erase its original role-assignee ID.
      inventory[kind] = mergeDirectoryObjects([original], inventory[kind]);
    }
  }
  const select = () => {
    const managed = selectManagedAzureIdentities(
      inventory.servicePrincipals,
      inventory.applications,
      context.bootstrapAppId,
      suite,
      run,
    );
    if (
      managed.length !== 1 &&
      (inventory.servicePrincipals.length || inventory.applications.length)
    ) {
      throw new Error(
        `Refusing to delete ${displayName}: its directory objects are ambiguous or not owned by the Azure onboarding E2E.`,
      );
    }
    return managed[0];
  };
  let identity = select();
  if (run) {
    await cleanupAzureOnboardingContainer(context, run.containerName, run);
    // Pin observed object IDs across temporary directory-list disappearance.
    const discovered = await discoverExactIdentityObjects(context, displayName);
    inventory = {
      servicePrincipals: mergeDirectoryObjects(
        inventory.servicePrincipals,
        discovered.servicePrincipals,
      ),
      applications: mergeDirectoryObjects(
        inventory.applications,
        discovered.applications,
      ),
    };
    identity = select();
    if (
      Boolean(inventory.servicePrincipals.length) !==
      Boolean(inventory.applications.length)
    ) {
      throw new Error(
        'Azure directory identity is incomplete; retaining its object IDs for reconciliation.',
      );
    }
  }
  if (identity)
    await deleteManagedAzureIdentity(
      context,
      identity,
      inventory.servicePrincipals.find(
        (object) => object.appId === identity.appId,
      ),
      inventory.applications.find((object) => object.appId === identity.appId),
      Boolean(run || captured),
    );
  if (run || captured)
    await confirmRunAbsence(context, async () => {
      const remaining = await listExactIdentityObjects(context, displayName);
      return (
        remaining.servicePrincipals.length === 0 &&
        remaining.applications.length === 0
      );
    });
}

export async function requireAzureOnboardingStorage(
  context: BootstrapAzureContext,
) {
  const accountName = managedAzureStorageAccountName(context.subscriptionId);
  const key = (
    await runAdminAzure(context, [
      'storage',
      'account',
      'keys',
      'list',
      '--resource-group',
      AZURE_STORAGE_RESOURCE_GROUP,
      '--account-name',
      accountName,
      '--subscription',
      context.subscriptionId,
      '--query',
      '[0].value',
      '--output',
      'tsv',
    ])
  ).trim();
  if (!key)
    throw new Error(`Azure returned no account key for ${accountName}.`);
  return {
    args: ['--account-name', accountName, '--auth-mode', 'key'],
    environment: { AZURE_STORAGE_KEY: key },
  };
}

export async function cleanupAzureOnboardingContainer(
  context: BootstrapAzureContext,
  containerName: string,
  run?: AzureOnboardingRunLocator,
): Promise<void> {
  if (run) assertRunLocator(run);
  if (
    run
      ? containerName !== run.containerName
      : !ONBOARDING_SMOKE_CONTAINER_PATTERN.test(containerName)
  ) {
    throw new Error(
      `Refusing to clean unmanaged Azure container ${containerName}.`,
    );
  }
  let storage: Awaited<ReturnType<typeof requireAzureOnboardingStorage>>;
  try {
    storage = await requireAzureOnboardingStorage(context);
  } catch (error) {
    if (
      !run &&
      /ResourceGroupNotFound|StorageAccountNotFound/.test(
        (error as Error).message,
      )
    )
      return;
    throw error;
  }
  const args = [...storage.args, '--name', containerName];
  const command = (verb: string, options: string[]) =>
    runAdminAzure(
      context,
      ['storage', 'container', verb, ...args, ...options],
      storage.environment,
    );
  const absent = async () => {
    const exists = (
      await command('exists', ['--query', 'exists', '--output', 'tsv'])
    ).trim();
    if (exists !== 'true' && exists !== 'false')
      throw new Error('Azure did not confirm container absence.');
    return exists === 'false';
  };
  if (run) {
    if (await absent()) {
      await confirmRunAbsence(context, absent);
      return;
    }
    const container: unknown = JSON.parse(
      await command('show', ['--output', 'json']),
    );
    if (!isRecord(container) || container.name !== containerName)
      throw new Error('Unexpected Azure container.');
    assertRunMarkers(container.metadata, run);
    await deleteAndConfirmRunResource(
      context,
      () => command('delete', ['--output', 'none']),
      absent,
    );
  } else {
    await command('delete', ['--output', 'none']);
    if (!(await absent()))
      throw new Error(
        `Azure onboarding container ${containerName} still exists.`,
      );
  }
}

export async function sweepAzureOnboardingIdentities(
  context: BootstrapAzureContext,
  suite: AzureOnboardingIdentitySuite,
): Promise<number> {
  const prefix = `anycloud-${MANAGED_IDENTITY_PREFIX[suite]}-`;
  const filter = `startswith(displayName,${quoteOData(prefix)})`;
  const servicePrincipals = await listDirectoryObjects(context, 'sp', filter);
  const applications = await listDirectoryObjects(context, 'app', filter);
  const managed = selectManagedAzureIdentities(
    servicePrincipals,
    applications,
    context.bootstrapAppId,
    suite,
  );
  const failures: string[] = [];
  for (const identity of managed) {
    try {
      await deleteManagedAzureIdentity(
        context,
        identity,
        servicePrincipals.find((object) => object.appId === identity.appId),
        applications.find((object) => object.appId === identity.appId),
      );
    } catch (error) {
      failures.push((error as Error).message);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `Azure ${suite} sweep had ${failures.length} failure(s): ${failures.join('; ')}`,
    );
  }
  return managed.length;
}

/**
 * The custom role built from the published JSON: one shared definition per
 * version of the file, named by its hash, so runs never create or delete one.
 */
export function publishedRoleId(
  scope: string,
  document: typeof anycloudRole,
): string {
  return deterministicAzureGuid(
    scope,
    'published-role',
    createHash('sha256').update(JSON.stringify(document)).digest('hex'),
  );
}

/** Create or refresh the shared published role; PUT is idempotent. */
async function putPublishedRole(
  context: BootstrapAzureContext,
): Promise<string> {
  const scope = `/subscriptions/${context.subscriptionId}`;
  const roleId = publishedRoleId(scope, anycloudRole);
  // Idempotent, so a transient refusal (concurrent runs, ARM throttling) retries.
  await retryAzureCreation(
    context,
    'Azure did not create the published role.',
    () =>
      runAdminAzure(context, [
        'rest',
        '--method',
        'PUT',
        '--url',
        `https://management.azure.com${scope}/providers/Microsoft.Authorization/roleDefinitions/${roleId}?api-version=2022-04-01`,
        '--body',
        JSON.stringify({
          properties: {
            roleName: `Anycloud e2e ${roleId.slice(0, 8)}`,
            description: anycloudRole.Description,
            type: 'CustomRole',
            permissions: [
              {
                actions: anycloudRole.Actions,
                notActions: anycloudRole.NotActions,
                dataActions: anycloudRole.DataActions,
                notDataActions: anycloudRole.NotDataActions,
              },
            ],
            assignableScopes: [scope],
          },
        }),
        '--output',
        'none',
      ]),
  );
  return roleId;
}

async function confirmRunAbsence(
  context: BootstrapAzureContext,
  absent: () => Promise<boolean>,
  {
    schedule = cleanupWaits(context),
    reissue = (): Promise<unknown> => Promise.resolve(),
  } = {},
): Promise<void> {
  let consecutive = 0;
  let listed = false;
  try {
    await azureWaiter(context).for(
      'Azure dependent absence',
      async () => {
        if (listed) await reissue();
        listed = !(await absent());
        consecutive = listed ? 0 : consecutive + 1;
        return consecutive;
      },
      {
        timeoutMs: MAX_WAIT_MS,
        // Even an empty injected retry schedule requires two confirmations.
        intervalMs: [...schedule, 0],
        probeError: 'fail',
        unmet: (absentReads) =>
          absentReads < 2 ? 'two consecutive absent reads' : undefined,
      },
    );
  } catch (error) {
    if (!(error instanceof WaitTimeoutError)) throw error;
    throw new Error(
      'Azure dependent absence could not be confirmed; identity retained.',
    );
  }
}

async function deleteAndConfirmRunResource(
  context: BootstrapAzureContext,
  remove: () => Promise<unknown>,
  absent: () => Promise<boolean>,
  schedule = cleanupWaits(context),
): Promise<void> {
  const startedAt = Date.now();
  const attempt = () =>
    remove().then(
      () => undefined,
      (error: unknown) => error,
    );
  // The report keeps the first failure; re-issues only retry the delete.
  const deletionError = await attempt();
  // Entra can reject a delete that a later identical request accepts (run
  // 37730658284: the app delete failed and the post-run sweep removed it).
  // Re-issue it once, inside the caller's deadline, while the object is listed.
  if (deletionError !== undefined && !(await absent().catch(() => false))) {
    // An expired deadline skips the re-issue.
    await waitForAzureOperation(context, cleanupWaits(context)[0] ?? 0).then(
      attempt,
      () => undefined,
    );
  }
  try {
    // A delete's not-found is not absence: Entra has answered one for an
    // application that stayed listed until a later delete removed it.
    await confirmRunAbsence(context, absent, { schedule, reissue: attempt });
  } catch (error) {
    if (deletionError !== undefined) {
      throw new AggregateError(
        [deletionError, error],
        `Azure deletion and absence confirmation failed after ${Date.now() - startedAt}ms: deletion: ${(deletionError as Error).message}; confirmation: ${(error as Error).message}`,
        { cause: deletionError },
      );
    }
    throw error;
  }
}

// This qualification owns exactly one container in the existing shared account.
// The caller independently authorizes abandonment before invoking these helpers.
function assertRunLocator(locator: AzureOnboardingRunLocator): void {
  const expected = azureOnboardingRunLocator(
    locator.repository,
    locator.runId,
    locator.runAttempt,
  );
  if (
    Object.entries(expected).some(
      ([key, value]) =>
        locator[key as keyof AzureOnboardingRunLocator] !== value,
    )
  ) {
    throw new Error('Invalid Azure onboarding run locator.');
  }
}

function runMarkers(
  locator: AzureOnboardingRunLocator,
): Record<string, string> {
  return {
    AnycloudManaged: 'true',
    AnycloudCredentialName: locator.credentialName,
    AnycloudOperation: locator.operationId,
  };
}

function assertRunMarkers(
  value: unknown,
  locator: AzureOnboardingRunLocator,
): void {
  if (!isRecord(value)) throw new Error('Missing Azure run ownership markers.');
  for (const [key, expected] of Object.entries(runMarkers(locator))) {
    const matches = Object.entries(value).filter(
      ([name]) => name.toLowerCase() === key.toLowerCase(),
    );
    if (matches.length !== 1 || matches[0][1] !== expected)
      throw new Error('Conflicting or missing Azure run ownership markers.');
  }
}

export async function createAzureOnboardingRunContainer(
  context: BootstrapAzureContext,
  locator: AzureOnboardingRunLocator,
): Promise<void> {
  assertRunLocator(locator);
  const storage = await requireAzureOnboardingStorage(context);
  await runAdminAzure(
    context,
    [
      'storage',
      'container',
      'create',
      ...storage.args,
      '--name',
      locator.containerName,
      '--fail-on-exist',
      '--metadata',
      ...Object.entries(runMarkers(locator)).map(
        ([key, value]) => `${key}=${value}`,
      ),
      '--output',
      'none',
    ],
    storage.environment,
  );
}

function assertGeneratedAssignments(
  assignments: unknown[],
  scope: string,
  principalId: string,
): void {
  const roles = [CONTRIBUTOR_ROLE_ID, publishedRoleId(scope, anycloudRole)];
  const seen = new Set<string>();
  for (const assignment of assignments) {
    const role =
      isRecord(assignment) && typeof assignment.roleDefinitionId === 'string'
        ? assignment.roleDefinitionId.split('/').at(-1)!
        : '';
    if (
      !isRecord(assignment) ||
      !roles.includes(role) ||
      seen.has(role) ||
      assignment.roleDefinitionId !==
        `${scope}/providers/Microsoft.Authorization/roleDefinitions/${role}` ||
      assignment.scope !== scope ||
      assignment.principalId !== principalId ||
      assignment.id !==
        `${scope}/providers/Microsoft.Authorization/roleAssignments/${deterministicAzureGuid(scope, principalId, role)}`
    ) {
      throw new Error(
        'Unexpected Azure run role assignment; identity retained.',
      );
    }
    seen.add(role);
  }
}

export async function cleanupAzureOnboardingRun(
  context: BootstrapAzureContext,
  locator: AzureOnboardingRunLocator,
): Promise<void> {
  await cleanupAzureOnboardingIdentity(
    context,
    locator.displayName,
    'onboarding',
    locator,
  );
}

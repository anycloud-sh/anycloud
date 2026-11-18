import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

import {
  MAX_WAIT_MS,
  Waiter,
  WaitTimeoutError,
} from '../../e2e/internal/wait.js';
import { retryUntilDeadline } from '../common/deadline-retry.js';
import anycloudRole from '../../../../src/shared/cloud-policies/gcp-anycloud-role.json' with { type: 'json' };

const execFileAsync = promisify(execFile);

export interface GCPOnboardingSecrets {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

export interface BootstrapGcloudContext {
  projectId: string;
  bootstrapEmail: string;
  configDir: string;
  keyPath: string;
  rootDir: string;
  run?: (args: string[], environment: NodeJS.ProcessEnv) => Promise<string>;
  wait?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

export interface GCPImportFixture {
  projectId: string;
  clientEmail: string;
  privateKey: string;
  privateKeyId: string;
  keyPath: string;
}

export interface ListedServiceAccount {
  email: string;
  displayName?: string;
  description?: string;
}

export type GCPOnboardingAccountSuite = 'onboarding' | 'bucket';

export interface GCPAccountCleanupIdentity {
  readonly email: string;
  readonly uniqueId: string;
}

const MANAGED_ACCOUNT_PREFIX: Record<GCPOnboardingAccountSuite, string> = {
  onboarding: 'onb',
  bucket: 'bkt',
};
const ONBOARDING_SMOKE_BUCKET_PATTERN =
  /^anycloud-onb-smoke-[0-9]+-[a-f0-9]{16}$/;
const GCP_IMPORT_READINESS_TIMEOUT_MS = 90_000;
const GCP_SERVICE_ACCOUNT_PROPAGATION_TIMEOUT_MS = 60_000;
const GCP_IAM_CONFLICT_TIMEOUT_MS = 8_000;
const GCP_ROLE_VISIBILITY_TIMEOUT_MS = 30_000;
const GCLOUD_IDENTITY_ENVIRONMENT_VARIABLES = [
  'CLOUDSDK_AUTH_ACCESS_TOKEN',
  'CLOUDSDK_AUTH_ACCESS_TOKEN_FILE',
  'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE',
  'CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT',
  'CLOUDSDK_AUTH_LOGIN_CONFIG_FILE',
  'CLOUDSDK_CORE_ACCOUNT',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_GHA_CREDS_PATH',
] as const;

interface GCPRetryOptions {
  deadline?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  now?: () => number;
  random?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
}

interface IamPolicy {
  bindings?: Array<{
    role: string;
    members?: string[];
    condition?: Record<string, unknown>;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function managedAccountPattern(
  projectId: string,
  suite: GCPOnboardingAccountSuite,
): RegExp {
  const prefix = MANAGED_ACCOUNT_PREFIX[suite];
  return new RegExp(
    `^anycloud-${prefix}-([0-9]+)@${escapeRegExp(projectId)}\\.iam\\.gserviceaccount\\.com$`,
  );
}

export function managedCredentialName(
  suite: GCPOnboardingAccountSuite,
  numericToken: string,
): string {
  if (!/^[0-9]+$/.test(numericToken)) {
    throw new Error('Managed GCP credential tokens must be numeric.');
  }
  return `${MANAGED_ACCOUNT_PREFIX[suite]}-${numericToken}`;
}

export function selectManagedServiceAccounts(
  accounts: ListedServiceAccount[],
  projectId: string,
  bootstrapEmail: string,
  suite: GCPOnboardingAccountSuite,
): ListedServiceAccount[] {
  const pattern = managedAccountPattern(projectId, suite);
  const prefix = MANAGED_ACCOUNT_PREFIX[suite];
  return accounts.filter((account) => {
    if (account.email === bootstrapEmail) return false;
    // Generation has a creation-response record and its own guarded teardown.
    if (account.description?.startsWith('AnyCloud credential generation '))
      return false;
    const match = pattern.exec(account.email);
    return (
      match !== null &&
      account.displayName === `Anycloud Service Account - ${prefix}-${match[1]}`
    );
  });
}

function isManagedTombstone(
  member: string,
  projectId: string,
  suite: GCPOnboardingAccountSuite,
): boolean {
  const prefix = 'deleted:serviceAccount:';
  if (!member.startsWith(prefix)) return false;
  const email = member.slice(prefix.length).split('?uid=', 1)[0];
  return managedAccountPattern(projectId, suite).test(email);
}

export function stripManagedIamMembers(
  policy: IamPolicy,
  projectId: string,
  activeEmails: Set<string>,
  suite: GCPOnboardingAccountSuite,
  exactAccount?: GCPAccountCleanupIdentity,
): { policy: IamPolicy; changed: boolean } {
  let changed = false;
  const accountPattern = managedAccountPattern(projectId, suite);
  const bindings = (policy.bindings ?? []).flatMap((binding) => {
    const members = binding.members ?? [];
    const retained = members.filter((member) => {
      const activeEmail = member.startsWith('serviceAccount:')
        ? member.slice('serviceAccount:'.length)
        : undefined;
      const remove =
        (activeEmail !== undefined &&
          accountPattern.test(activeEmail) &&
          activeEmails.has(activeEmail)) ||
        (exactAccount
          ? member ===
            `deleted:serviceAccount:${exactAccount.email}?uid=${exactAccount.uniqueId}`
          : isManagedTombstone(member, projectId, suite));
      if (remove) changed = true;
      return !remove;
    });
    if (members.length > 0 && retained.length === 0) return [];
    return retained.length === members.length
      ? [binding]
      : [{ ...binding, members: retained }];
  });
  return { policy: { ...policy, bindings }, changed };
}

function requireEnvironmentValue(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) {
    throw new Error(`${name} is required for real GCP onboarding tests.`);
  }
  return value;
}

export function readGCPOnboardingSecrets(): GCPOnboardingSecrets {
  const projectId = requireEnvironmentValue('GCP_PROJECT_ID');
  const clientEmail = requireEnvironmentValue('GCP_CLIENT_EMAIL');
  const privateKey = requireEnvironmentValue('GCP_PRIVATE_KEY').replace(
    /\\n/g,
    '\n',
  );
  if (!clientEmail.endsWith(`@${projectId}.iam.gserviceaccount.com`)) {
    throw new Error('GCP_CLIENT_EMAIL must belong to GCP_PROJECT_ID.');
  }
  if (!privateKey.includes('BEGIN PRIVATE KEY')) {
    throw new Error('GCP_PRIVATE_KEY must contain a service-account PEM key.');
  }
  return { projectId, clientEmail, privateKey };
}

function gcloudEnvironment(configDir: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    CLOUDSDK_CONFIG: configDir,
    CLOUDSDK_CORE_DISABLE_PROMPTS: '1',
  };
  delete environment.GCP_PRIVATE_KEY;
  for (const name of GCLOUD_IDENTITY_ENVIRONMENT_VARIABLES) {
    delete environment[name];
  }
  return environment;
}

export async function runAdminGcloud(
  context: Pick<BootstrapGcloudContext, 'configDir' | 'run'>,
  args: string[],
): Promise<string> {
  const environment = gcloudEnvironment(context.configDir);
  if (context.run) return context.run(args, environment);
  const { stdout } = await execFileAsync('gcloud', args, {
    env: environment,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

export async function createBootstrapGcloudContext(
  secrets = readGCPOnboardingSecrets(),
): Promise<BootstrapGcloudContext> {
  const rootDir = await mkdtemp(join(tmpdir(), 'anycloud-gcp-bootstrap-'));
  const context: BootstrapGcloudContext = {
    projectId: secrets.projectId,
    bootstrapEmail: secrets.clientEmail,
    configDir: join(rootDir, 'gcloud'),
    keyPath: join(rootDir, 'bootstrap-key.json'),
    rootDir,
  };
  try {
    await mkdir(context.configDir, { recursive: true, mode: 0o700 });
    await writeFile(
      context.keyPath,
      JSON.stringify({
        type: 'service_account',
        project_id: secrets.projectId,
        private_key: secrets.privateKey,
        client_email: secrets.clientEmail,
        token_uri: 'https://oauth2.googleapis.com/token',
      }),
      { mode: 0o600 },
    );
    await runAdminGcloud(context, [
      'auth',
      'activate-service-account',
      secrets.clientEmail,
      `--key-file=${context.keyPath}`,
      `--project=${secrets.projectId}`,
      '--quiet',
    ]);
    await runAdminGcloud(context, [
      'config',
      'set',
      'project',
      secrets.projectId,
      '--quiet',
    ]);
    return context;
  } catch (error) {
    await rm(rootDir, { recursive: true, force: true });
    throw error;
  }
}

export async function disposeBootstrapGcloudContext(
  context: BootstrapGcloudContext,
): Promise<void> {
  await rm(context.rootDir, { recursive: true, force: true });
}

export async function createGCPImportFixture(
  context: BootstrapGcloudContext,
  credentialName: string,
  keyPath: string,
  suite: GCPOnboardingAccountSuite,
  /** Without grants the account holds no role, so the caller owns its readiness. */
  { grants = true }: { readonly grants?: boolean } = {},
): Promise<GCPImportFixture> {
  const accountId = `anycloud-${credentialName}`;
  const clientEmail = `${accountId}@${context.projectId}.iam.gserviceaccount.com`;
  if (!managedAccountPattern(context.projectId, suite).test(clientEmail)) {
    throw new Error(`Refusing to create unmanaged GCP account ${clientEmail}.`);
  }
  const retryOptions: GCPRetryOptions = {
    now: context.now,
    random: context.random,
    wait: context.wait,
  };
  const retryCreatedAccountPropagation = <T>(operation: () => Promise<T>) =>
    retryServiceAccountPropagation(operation, retryOptions);
  const retryCreatedAccountIamMutation = <T>(operation: () => Promise<T>) =>
    retryServiceAccountIamMutation(operation, retryOptions);
  try {
    await runAdminGcloud(context, [
      'iam',
      'service-accounts',
      'create',
      accountId,
      `--project=${context.projectId}`,
      `--display-name=Anycloud Service Account - ${credentialName}`,
      `--description=Anycloud test-owned import fixture for ${credentialName}`,
      '--quiet',
    ]);
    if (grants) {
      // RFC 0047 S8/S11: the credential holds only the published role.
      const roleId = await ensurePublishedRole(context);
      await retryCreatedAccountIamMutation(() =>
        runAdminGcloud(context, [
          'projects',
          'add-iam-policy-binding',
          context.projectId,
          `--member=serviceAccount:${clientEmail}`,
          `--role=projects/${context.projectId}/roles/${roleId}`,
          '--condition=None',
          '--quiet',
        ]),
      );
    }
    await retryCreatedAccountPropagation(() =>
      runAdminGcloud(context, [
        'iam',
        'service-accounts',
        'keys',
        'create',
        keyPath,
        `--iam-account=${clientEmail}`,
        `--project=${context.projectId}`,
        '--quiet',
      ]),
    );
    const key = JSON.parse(await readFile(keyPath, 'utf8')) as {
      project_id?: string;
      client_email?: string;
      private_key?: string;
      private_key_id?: string;
    };
    if (
      key.project_id !== context.projectId ||
      key.client_email !== clientEmail ||
      !key.private_key ||
      !key.private_key_id
    ) {
      throw new Error('GCP did not return a complete test import key.');
    }

    if (grants) {
      const validationConfigDir = join(context.rootDir, 'import-validation');
      await mkdir(validationConfigDir, { recursive: true, mode: 0o700 });
      await waitForGCPImportFixtureReadiness(
        context,
        validationConfigDir,
        clientEmail,
        keyPath,
      );
    }
    return {
      projectId: context.projectId,
      clientEmail,
      privateKey: key.private_key,
      privateKeyId: key.private_key_id,
      keyPath,
    };
  } catch (error) {
    try {
      await cleanupGCPOnboardingAccount(context, clientEmail, suite);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'GCP import fixture creation and automatic cleanup both failed',
      );
    }
    throw error;
  }
}

export async function waitForGCPImportFixtureReadiness(
  context: BootstrapGcloudContext,
  validationConfigDir: string,
  clientEmail: string,
  keyPath: string,
): Promise<void> {
  const now = context.now ?? Date.now;
  const deadline = now() + GCP_IMPORT_READINESS_TIMEOUT_MS;
  const validationContext = { ...context, configDir: validationConfigDir };

  try {
    await retryUntilDeadline(
      async () => {
        await runAdminGcloud(validationContext, [
          'auth',
          'activate-service-account',
          clientEmail,
          `--key-file=${keyPath}`,
          `--project=${context.projectId}`,
          '--quiet',
        ]);
        const activeAccount = (
          await runAdminGcloud(validationContext, [
            'auth',
            'list',
            '--filter=status:ACTIVE',
            '--format=value(account)',
          ])
        ).trim();
        if (activeAccount !== clientEmail) {
          throw new UnexpectedGCPReadinessPrincipalError(
            clientEmail,
            activeAccount,
          );
        }
        // Prove the published role attached above has propagated; authentication
        // alone says nothing about whether the fixture can perform onboarding.
        await runAdminGcloud(validationContext, [
          'compute',
          'instances',
          'list',
          `--project=${context.projectId}`,
          `--account=${clientEmail}`,
          '--limit=1',
          '--format=value(name)',
        ]);
        await runAdminGcloud(validationContext, [
          'compute',
          'firewall-rules',
          'list',
          `--project=${context.projectId}`,
          `--account=${clientEmail}`,
          '--limit=1',
          '--format=value(name)',
        ]);
        await runAdminGcloud(validationContext, [
          'storage',
          'buckets',
          'list',
          `--project=${context.projectId}`,
          `--account=${clientEmail}`,
          '--limit=1',
          '--format=value(name)',
        ]);
      },
      {
        // A new key may fail on immediate use. Retry those exact-identity
        // probes within a bounded window, but return as soon as they succeed.
        deadline,
        initialDelayMs: 1_000,
        maxDelayMs: 15_000,
        now,
        random: context.random,
        wait: context.wait,
        shouldRetry: (error) =>
          !(error instanceof UnexpectedGCPReadinessPrincipalError),
      },
    );
  } catch (cause) {
    throw new Error('The test-owned GCP import key did not become usable.', {
      cause,
    });
  }
}

class UnexpectedGCPReadinessPrincipalError extends Error {
  constructor(expected: string, actual: string) {
    super(
      `Expected the active GCP fixture principal to be ${expected}, but found ${actual || 'none'}.`,
    );
    this.name = 'UnexpectedGCPReadinessPrincipalError';
  }
}

function isServiceAccountPropagationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /service account[\s\S]*(?:does not exist|not found)/i.test(message) ||
    // IAM also denies a just-created account's keys before it is visible.
    (/permission_denied/i.test(message) && /may not exist/i.test(message))
  );
}

export async function retryServiceAccountPropagation<T>(
  operation: () => Promise<T>,
  options: GCPRetryOptions = {},
): Promise<T> {
  return retryGCPOperation(
    operation,
    isServiceAccountPropagationError,
    GCP_SERVICE_ACCOUNT_PROPAGATION_TIMEOUT_MS,
    { initialDelayMs: 500, maxDelayMs: 15_000, ...options },
  );
}

async function listServiceAccounts(
  context: BootstrapGcloudContext,
): Promise<ListedServiceAccount[]> {
  return JSON.parse(
    await runAdminGcloud(context, [
      'iam',
      'service-accounts',
      'list',
      `--project=${context.projectId}`,
      '--format=json',
    ]),
  ) as ListedServiceAccount[];
}

function isIamPolicyConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /\bABORTED\b/i.test(message) ||
    /concurrent policy (?:change|update)/i.test(message) ||
    (/etag/i.test(message) &&
      /conflict|mismatch|changed|invalid/i.test(message))
  );
}

export async function retryIamPolicyMutation<T>(
  operation: () => Promise<T>,
  options: GCPRetryOptions = {},
): Promise<T> {
  return retryGCPOperation(
    operation,
    isIamPolicyConflict,
    GCP_IAM_CONFLICT_TIMEOUT_MS,
    { initialDelayMs: 250, maxDelayMs: 2_000, ...options },
  );
}

export async function retryServiceAccountIamMutation<T>(
  operation: () => Promise<T>,
  options: GCPRetryOptions = {},
): Promise<T> {
  return retryGCPOperation(
    operation,
    (error) =>
      isServiceAccountPropagationError(error) || isIamPolicyConflict(error),
    GCP_SERVICE_ACCOUNT_PROPAGATION_TIMEOUT_MS,
    { initialDelayMs: 500, maxDelayMs: 15_000, ...options },
  );
}

function retryGCPOperation<T>(
  operation: () => Promise<T>,
  shouldRetry: (error: unknown) => boolean,
  timeoutMs: number,
  options: GCPRetryOptions,
): Promise<T> {
  const now = options.now ?? Date.now;
  return retryUntilDeadline(operation, {
    deadline: options.deadline ?? now() + timeoutMs,
    initialDelayMs: options.initialDelayMs ?? 500,
    maxDelayMs: options.maxDelayMs ?? 15_000,
    now,
    random: options.random,
    wait: options.wait,
    shouldRetry,
  });
}

async function removeManagedPolicyMembers(
  context: BootstrapGcloudContext,
  activeEmails: Set<string>,
  suite: GCPOnboardingAccountSuite,
  exactAccount?: GCPAccountCleanupIdentity,
): Promise<number> {
  return retryIamPolicyMutation(
    async () => {
      const policy = JSON.parse(
        await runAdminGcloud(context, [
          'projects',
          'get-iam-policy',
          context.projectId,
          '--format=json',
        ]),
      ) as IamPolicy;
      const result = stripManagedIamMembers(
        policy,
        context.projectId,
        activeEmails,
        suite,
        exactAccount,
      );
      if (!result.changed) return 0;

      const policyPath = join(context.rootDir, 'cleanup-policy.json');
      await writeFile(policyPath, JSON.stringify(result.policy), {
        mode: 0o600,
      });
      try {
        await runAdminGcloud(context, [
          'projects',
          'set-iam-policy',
          context.projectId,
          policyPath,
          '--quiet',
        ]);
      } finally {
        await rm(policyPath, { force: true });
      }
      return 1;
    },
    { now: context.now, random: context.random, wait: context.wait },
  );
}

async function defaultComputeServiceAccountEmail(
  context: BootstrapGcloudContext,
): Promise<string> {
  const projectNumber = (
    await runAdminGcloud(context, [
      'projects',
      'describe',
      context.projectId,
      '--format=value(projectNumber)',
    ])
  ).trim();
  if (!/^\d+$/.test(projectNumber)) {
    throw new Error(
      `GCP returned an invalid project number for ${context.projectId}: ${projectNumber || '(empty)'}`,
    );
  }
  return `${projectNumber}-compute@developer.gserviceaccount.com`;
}

async function removeManagedVmServiceAccountPolicyMembers(
  context: BootstrapGcloudContext,
  activeEmails: Set<string>,
  suite: GCPOnboardingAccountSuite,
  exactAccount?: GCPAccountCleanupIdentity,
): Promise<number> {
  const vmServiceAccount = await defaultComputeServiceAccountEmail(context);
  return retryIamPolicyMutation(
    async () => {
      const policy = JSON.parse(
        await runAdminGcloud(context, [
          'iam',
          'service-accounts',
          'get-iam-policy',
          vmServiceAccount,
          `--project=${context.projectId}`,
          '--format=json',
        ]),
      ) as IamPolicy;
      const result = stripManagedIamMembers(
        policy,
        context.projectId,
        activeEmails,
        suite,
        exactAccount,
      );
      if (!result.changed) return 0;

      const policyPath = join(context.rootDir, 'cleanup-vm-sa-policy.json');
      await writeFile(policyPath, JSON.stringify(result.policy), {
        mode: 0o600,
      });
      try {
        await runAdminGcloud(context, [
          'iam',
          'service-accounts',
          'set-iam-policy',
          vmServiceAccount,
          policyPath,
          `--project=${context.projectId}`,
          '--quiet',
        ]);
      } finally {
        await rm(policyPath, { force: true });
      }
      return 1;
    },
    { now: context.now, random: context.random, wait: context.wait },
  );
}

async function removeAllManagedPolicyMembers(
  context: BootstrapGcloudContext,
  activeEmails: Set<string>,
  suite: GCPOnboardingAccountSuite,
  exactAccount?: GCPAccountCleanupIdentity,
): Promise<void> {
  await removeManagedPolicyMembers(context, activeEmails, suite, exactAccount);
  await removeManagedVmServiceAccountPolicyMembers(
    context,
    activeEmails,
    suite,
    exactAccount,
  );
}

function isPotentiallyStaleDeleteError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /not[_ ]found|not found|does not exist/i.test(message) ||
    (/permission_denied/i.test(message) && /may not exist/i.test(message))
  );
}

export async function deleteServiceAccountWithStaleListRecovery(
  email: string,
  deleteAccount: () => Promise<void>,
  listAccounts: () => Promise<ListedServiceAccount[]>,
  options: {
    waits?: number[];
    wait?: (milliseconds: number) => Promise<void>;
  } = {},
): Promise<void> {
  let deleteError: unknown;
  try {
    await deleteAccount();
    return;
  } catch (error) {
    if (!isPotentiallyStaleDeleteError(error)) throw error;
    deleteError = error;
  }

  await new Waiter(new AbortController().signal, options.wait)
    .for(`GCP service account ${email} absence`, () => listAccounts(), {
      timeoutMs: MAX_WAIT_MS,
      intervalMs: options.waits ?? [
        1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000, 15_000,
      ],
      // Preserve the original delete error if listing is temporarily unavailable.
      probeError: { retry: () => true },
      unmet: (accounts) =>
        accounts.some((account) => account.email === email)
          ? 'still listed'
          : undefined,
    })
    .catch((error: unknown) => {
      throw error instanceof WaitTimeoutError ? deleteError : error;
    });
}

async function deleteManagedServiceAccount(
  context: BootstrapGcloudContext,
  email: string,
): Promise<void> {
  await deleteServiceAccountWithStaleListRecovery(
    email,
    () =>
      runAdminGcloud(context, [
        'iam',
        'service-accounts',
        'delete',
        email,
        `--project=${context.projectId}`,
        '--quiet',
      ]).then(() => undefined),
    () => listServiceAccounts(context),
    { wait: context.wait },
  );
}

export async function cleanupGCPOnboardingAccount(
  context: BootstrapGcloudContext,
  email: string,
  suite: GCPOnboardingAccountSuite,
  exactAccount?: GCPAccountCleanupIdentity,
): Promise<void> {
  if (
    email === context.bootstrapEmail ||
    !managedAccountPattern(context.projectId, suite).test(email)
  ) {
    throw new Error(`Refusing to clean unmanaged GCP account ${email}.`);
  }
  if (
    exactAccount &&
    (exactAccount.email !== email ||
      !/^[1-9][0-9]+$/u.test(exactAccount.uniqueId))
  )
    throw new Error('GCP cleanup identity differs from its original account');

  const account = (await listServiceAccounts(context)).find(
    (candidate) => candidate.email === email,
  );
  if (
    account &&
    selectManagedServiceAccounts(
      [account],
      context.projectId,
      context.bootstrapEmail,
      suite,
    ).length !== 1
  ) {
    throw new Error(
      `Refusing to delete ${email}: its display name is not managed by the onboarding E2E.`,
    );
  }

  const activeEmails = new Set(account ? [email] : []);
  await removeAllManagedPolicyMembers(
    context,
    activeEmails,
    suite,
    exactAccount,
  );
  if (account) await deleteManagedServiceAccount(context, email);
  await removeAllManagedPolicyMembers(
    context,
    activeEmails,
    suite,
    exactAccount,
  );
}

/** The shared role for one version of the published JSON. */
export function publishedRoleId(document: typeof anycloudRole): string {
  const hash = createHash('sha256')
    .update(JSON.stringify(document))
    .digest('hex');
  return `anycloud_e2e_${hash.slice(0, 8)}`;
}

/**
 * Create the shared published role if it is missing, and check that an
 * existing one matches. A deleted custom role keeps its ID reserved and counts
 * toward the project's limit, so no run deletes it; cleanup removes only the
 * binding with the account.
 */
const isNotFound = (error: unknown) =>
  /NOT_FOUND|not found/i.test(String(error));

async function ensurePublishedRole(
  context: BootstrapGcloudContext,
): Promise<string> {
  const roleId = publishedRoleId(anycloudRole);
  const role = [roleId, `--project=${context.projectId}`];
  const rolePath = join(context.rootDir, `${roleId}.json`);
  await writeFile(
    rolePath,
    JSON.stringify({ ...anycloudRole, title: `Anycloud e2e ${roleId}` }),
    { mode: 0o600 },
  );
  let existing: { includedPermissions?: string[]; deleted?: boolean };
  try {
    await runAdminGcloud(context, [
      'iam',
      'roles',
      'create',
      ...role,
      `--file=${rolePath}`,
      '--quiet',
    ]);
    return roleId;
  } catch (createError) {
    // Parallel members create the role at once: a run that loses the race is
    // refused (not always as ALREADY_EXISTS) while the winner's role becomes
    // visible. Read it back; without a role, report the create's refusal.
    const now = context.now ?? Date.now;
    const described = await retryUntilDeadline(
      () =>
        runAdminGcloud(context, [
          'iam',
          'roles',
          'describe',
          ...role,
          '--format=json',
        ]),
      {
        deadline: now() + GCP_ROLE_VISIBILITY_TIMEOUT_MS,
        initialDelayMs: 1_000,
        maxDelayMs: 8_000,
        now,
        random: context.random,
        wait: context.wait,
        shouldRetry: isNotFound,
      },
    ).catch((describeError: unknown) => {
      // Still absent: the create's refusal says why. Anything else (a
      // deadline, PERMISSION_DENIED) is its own diagnosis.
      throw isNotFound(describeError) ? createError : describeError;
    });
    existing = JSON.parse(described) as {
      includedPermissions?: string[];
      deleted?: boolean;
    };
  }
  const sorted = (permissions: readonly string[]) =>
    JSON.stringify([...permissions].sort());
  if (
    existing.deleted ||
    sorted(existing.includedPermissions ?? []) !==
      sorted(anycloudRole.includedPermissions)
  )
    throw new Error(
      `GCP role ${roleId} differs from src/shared/cloud-policies/gcp-anycloud-role.json or is deleted; reconcile it manually.`,
    );
  return roleId;
}

export async function cleanupGCPOnboardingBucket(
  context: BootstrapGcloudContext,
  bucketName: string,
): Promise<void> {
  if (!ONBOARDING_SMOKE_BUCKET_PATTERN.test(bucketName)) {
    throw new Error(`Refusing to clean unmanaged GCP bucket ${bucketName}.`);
  }
  try {
    await runAdminGcloud(context, [
      'storage',
      'buckets',
      'delete',
      `gs://${bucketName}`,
      '--quiet',
    ]);
  } catch (error) {
    if (!/not found|does not exist|\b404\b/i.test((error as Error).message)) {
      throw error;
    }
  }
}

export async function sweepGCPOnboardingAccounts(
  context: BootstrapGcloudContext,
  suite: GCPOnboardingAccountSuite,
): Promise<number> {
  const managed = selectManagedServiceAccounts(
    await listServiceAccounts(context),
    context.projectId,
    context.bootstrapEmail,
    suite,
  );
  const activeEmails = new Set(managed.map((account) => account.email));
  await removeAllManagedPolicyMembers(context, activeEmails, suite);
  for (const account of managed) {
    await deleteManagedServiceAccount(context, account.email);
  }
  await removeAllManagedPolicyMembers(context, activeEmails, suite);
  return managed.length;
}

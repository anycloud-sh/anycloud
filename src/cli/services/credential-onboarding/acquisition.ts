import { type CloudCredentials, CloudType } from '../../../shared/cloud.js';
import { errorMessage } from '../../../shared/log-diagnostics.js';
import {
  printSuccess,
  printInfo,
  printError,
  printWarning,
  createSpinner,
  exitWithError,
} from '../../utils/output.js';
import { safePrompts, shouldAllowPrompts } from '../../utils/safe-prompts.js';
import { normalizeCredentialProvider } from '../../utils/providers.js';
import {
  isAWSCLIInstalled,
  getCurrentAWSProfile,
  getAWSCLIInstallCommand,
  listAWSProfileNames,
} from '../../services/slurp/aws.js';
import { validateGeneratedAzureCredentialName } from './generated-credential-name.js';
import {
  isAzureCLIInstalled,
  isAzureCLILoggedIn,
  loginToAzure,
  getAzureCLIInstallCommand,
  getCurrentAzureSubscription,
  listAzureSubscriptions,
  type AzureSubscription,
} from '../../services/slurp/azure.js';
import {
  getGCloudInstallCommand,
  isGCloudInstalled,
  prepareGCPServiceAccountKeyImport,
} from '../../services/slurp/gcp.js';
import {
  AzurePermissionError,
  generateAzureServicePrincipal,
  getAzureGenerationPreview,
  type AzureGenerationPreview,
} from '../credential-bootstrap/azure.js';
import {
  AWSCliError,
  awsOperator,
} from '../credential-bootstrap/aws-cli-runner.js';
import {
  describeAWSGeneration,
  generateAWSCredentials,
  getAWSGenerationPreview,
  validateAWSGenerationName,
} from '../credential-bootstrap/aws.js';
import {
  gcpOperator,
  getGCPOperatorDefaults,
} from '../credential-bootstrap/gcp-cli-runner.js';
import {
  GCP_ANYCLOUD_ROLE_ID,
  describeGCPGeneration,
  generateGCPCredentials,
  getGCPGenerationPreview,
  isGCPPermissionDenied,
  validateGCPGenerationName,
} from '../credential-bootstrap/gcp.js';
import {
  acquiredCredential,
  generatedCredential,
  type AcquiredCredential,
} from './acquired-credential.js';
import { buildCredentialFromFields } from './credential-builders.js';
import {
  ADMIN_REQUEST_URL,
  AWS_GENERATION_POLICY_NAME,
  AWS_POLICY_URL,
} from '../../../shared/permission-denied.js';
import { discoverCredentialSources } from './discovery.js';
import {
  materializeAWSProfile,
  materializeCredential,
} from './materialization.js';
import type {
  AWSCredentialCandidate,
  CredentialCandidate,
  GCPCredentialCandidate,
} from './types.js';

export interface NewCredentialsOptions {
  provider?: string;
  profile?: string;
  accountId?: string;
  generate?: boolean;
  accessKeyId?: string;
  secretAccessKey?: string;
  applicationId?: string;
  secret?: string;
  subscriptionId?: string;
  directoryId?: string;
  projectId?: string;
  gcloudAccount?: string;
  clientEmail?: string;
  privateKey?: string;
  apiKey?: string;
  apiToken?: string;
  jurisdiction?: string;
  overwrite?: boolean;
}

type CredentialAcquisitionResult = CloudCredentials | AcquiredCredential;

function asAcquiredCredential(
  result: CredentialAcquisitionResult,
): AcquiredCredential {
  return 'credential' in result ? result : acquiredCredential(result);
}

function rejectGeneratedCredentialMaterial(
  options: NewCredentialsOptions,
  provider: CloudType,
): void {
  const credentialFlags: Array<[string, string | undefined]> = [
    ['access-key-id', options.accessKeyId],
    ['secret-access-key', options.secretAccessKey],
    ['application-id', options.applicationId],
    ['secret', options.secret],
    ['directory-id', options.directoryId],
    ['client-email', options.clientEmail],
    ['private-key', options.privateKey],
    ['api-key', options.apiKey],
    ['api-token', options.apiToken],
    ...(provider === CloudType.Azure
      ? []
      : ([['subscription-id', options.subscriptionId]] as Array<
          [string, string | undefined]
        >)),
    ...(provider === CloudType.GCP
      ? []
      : ([['project-id', options.projectId]] as Array<
          [string, string | undefined]
        >)),
  ];
  const supplied = credentialFlags.find(([, value]) => value !== undefined);
  if (supplied) {
    exitWithError(
      `Cannot use --generate with --${supplied[0]}; generated credentials must come from the authenticated provider CLI.`,
    );
  }
}

function validateProfileOption(
  options: NewCredentialsOptions,
  provider: CloudType,
): void {
  if (options.gcloudAccount !== undefined && provider !== CloudType.GCP) {
    exitWithError('--gcloud-account is only supported with GCP generation.');
  }
  if (
    options.accountId !== undefined &&
    provider !== CloudType.AWS &&
    provider !== CloudType.Cloudflare
  ) {
    exitWithError(
      '--account-id is only supported with --provider aws --generate or --provider cloudflare.',
    );
  }
  if (options.jurisdiction !== undefined && provider !== CloudType.Cloudflare) {
    exitWithError(
      '--jurisdiction is only supported with --provider cloudflare.',
    );
  }
  if (!options.profile) return;
  if (provider !== CloudType.AWS) {
    exitWithError('--profile is only supported with --provider aws.');
  }
  if (
    options.accessKeyId !== undefined ||
    options.secretAccessKey !== undefined
  ) {
    exitWithError(
      'Cannot combine --profile with --access-key-id or --secret-access-key.',
    );
  }
}

function requireValue(
  flagValue: string | undefined,
  envName: string,
  flagName: string,
): string {
  const value = flagValue ?? process.env[envName];
  if (!value) {
    exitWithError(`Missing ${flagName}. Pass --${flagName} or set ${envName}.`);
  }
  return value;
}

function rejectAWSImportAccountId(options: NewCredentialsOptions): void {
  if (options.accountId !== undefined) {
    exitWithError(
      '--account-id only applies to AWS generation. Add --generate to create a credential, or omit --account-id to import existing credentials.',
    );
  }
}

async function buildAWSCredentialsFromFlags(
  options: NewCredentialsOptions,
): Promise<CredentialAcquisitionResult> {
  rejectAWSImportAccountId(options);
  if (options.profile) return importAWSProfile(options.profile);
  if (
    process.env.AWS_SESSION_TOKEN &&
    (options.accessKeyId === undefined || options.secretAccessKey === undefined)
  ) {
    exitWithError(
      'Temporary AWS session credentials cannot be saved because they expire. Use a durable static profile or enter long-lived access keys.',
    );
  }
  return buildCredentialFromFields(CloudType.AWS, {
    accessKeyId: requireValue(
      options.accessKeyId,
      'AWS_ACCESS_KEY_ID',
      'access-key-id',
    ),
    secretAccessKey: requireValue(
      options.secretAccessKey,
      'AWS_SECRET_ACCESS_KEY',
      'secret-access-key',
    ),
  });
}

async function buildAzureCredentialsFromFlags(
  options: NewCredentialsOptions,
): Promise<CloudCredentials> {
  return buildCredentialFromFields(CloudType.Azure, {
    applicationId: requireValue(
      options.applicationId,
      'AZURE_APPLICATION_ID',
      'application-id',
    ),
    secret: requireValue(options.secret, 'AZURE_SECRET', 'secret'),
    subscriptionId: requireValue(
      options.subscriptionId,
      'AZURE_SUBSCRIPTION_ID',
      'subscription-id',
    ),
    directoryId: requireValue(
      options.directoryId,
      'AZURE_DIRECTORY_ID',
      'directory-id',
    ),
  });
}

function rejectGCPOperatorForImport(options: NewCredentialsOptions): void {
  if (options.gcloudAccount !== undefined) {
    exitWithError(
      '--gcloud-account selects a generation operator. Add --generate or omit it to import credentials.',
    );
  }
}

async function buildGCPCredentialsFromFlags(
  options: NewCredentialsOptions,
): Promise<CloudCredentials> {
  rejectGCPOperatorForImport(options);
  return buildCredentialFromFields(CloudType.GCP, {
    projectId: requireValue(options.projectId, 'GCP_PROJECT_ID', 'project-id'),
    clientEmail: requireValue(
      options.clientEmail,
      'GCP_CLIENT_EMAIL',
      'client-email',
    ),
    privateKey: requireValue(
      options.privateKey,
      'GCP_PRIVATE_KEY',
      'private-key',
    ),
  });
}

async function buildLambdaCredentialsFromFlags(
  options: NewCredentialsOptions,
): Promise<CloudCredentials> {
  return buildCredentialFromFields(CloudType.Lambda, {
    apiKey: requireValue(options.apiKey, 'LAMBDA_API_KEY', 'api-key'),
  });
}

function cloudflareFields(
  options: NewCredentialsOptions,
  accountId: string,
  apiToken: string,
): CloudCredentials {
  return buildCredentialFromFields(CloudType.Cloudflare, {
    accountId,
    apiToken,
    ...(options.jurisdiction !== undefined
      ? { jurisdiction: options.jurisdiction }
      : {}),
  });
}

async function buildCloudflareCredentialsFromFlags(
  options: NewCredentialsOptions,
): Promise<CloudCredentials> {
  return cloudflareFields(
    options,
    requireValue(options.accountId, 'CLOUDFLARE_ACCOUNT_ID', 'account-id'),
    requireValue(options.apiToken, 'CLOUDFLARE_API_TOKEN', 'api-token'),
  );
}

export async function acquireCredentialsFromOptions(
  options: NewCredentialsOptions,
): Promise<AcquiredCredential> {
  const providerRaw = options.provider ?? process.env.ANYCLOUD_CLOUD_PROVIDER;
  if (!providerRaw) {
    exitWithError(
      'Missing --provider. Pass --provider aws|azure|gcp|lambda|cloudflare or set ANYCLOUD_CLOUD_PROVIDER.',
    );
  }
  const provider = normalizeCredentialProvider(providerRaw);
  validateProfileOption(options, provider);

  switch (provider) {
    case CloudType.AWS:
      return asAcquiredCredential(await buildAWSCredentialsFromFlags(options));
    case CloudType.Azure:
      return acquiredCredential(await buildAzureCredentialsFromFlags(options));
    case CloudType.GCP:
      return acquiredCredential(await buildGCPCredentialsFromFlags(options));
    case CloudType.Lambda:
      return acquiredCredential(await buildLambdaCredentialsFromFlags(options));
    case CloudType.Cloudflare:
      return acquiredCredential(
        await buildCloudflareCredentialsFromFlags(options),
      );
    case CloudType.Local:
      exitWithError(`Unsupported provider: ${provider}`);
  }
}

export async function buildCredentialsFromOptions(
  options: NewCredentialsOptions,
): Promise<CloudCredentials> {
  return (await acquireCredentialsFromOptions(options)).credential;
}

/**
 * Resolve the cloud provider — from --provider flag, ANYCLOUD_CLOUD_PROVIDER
 * env, or interactive picker on a TTY.
 */
async function resolveProvider(
  options: NewCredentialsOptions,
): Promise<CloudType> {
  const raw = options.provider ?? process.env.ANYCLOUD_CLOUD_PROVIDER;
  if (raw) return normalizeCredentialProvider(raw);

  const choice = await safePrompts<'value'>({
    type: 'select',
    name: 'value',
    message: 'Select cloud provider:',
    choices: [
      { title: 'AWS', value: 'aws', description: 'Amazon Web Services' },
      { title: 'Azure', value: 'azure', description: 'Microsoft Azure' },
      { title: 'GCP', value: 'gcp', description: 'Google Cloud Platform' },
      {
        title: 'Lambda',
        value: 'lambda',
        description: 'Lambda Labs (GPU cloud)',
      },
      {
        title: 'Cloudflare',
        value: 'cloudflare',
        description: 'Cloudflare R2 (storage only)',
      },
    ],
  });
  if (!choice.value) process.exit(0);
  return normalizeCredentialProvider(choice.value as string);
}

/**
 * Resolve the credential set name — from the positional argument, or an
 * interactive prompt on a TTY. In non-interactive mode a missing name is a
 * hard error: the wizard can't run, so there is nothing to attach it to.
 */
export async function resolveCredentialName(
  name: string | undefined,
): Promise<string> {
  if (name) return name;

  if (!shouldAllowPrompts()) {
    exitWithError(
      'Missing credential name. Pass it as: anycloud credentials new <name>',
    );
  }

  const answer = await safePrompts<'value'>({
    type: 'text',
    name: 'value',
    message: 'Name for this credential set:',
    validate: (value) => (value.length > 0 ? true : 'Name required'),
  });
  if (!answer.value) process.exit(0);
  return answer.value as string;
}

async function importAWSProfile(
  profileName: string,
): Promise<AcquiredCredential> {
  const acquired = await materializeAWSProfile(profileName);

  printImportedAWSProfile(profileName, acquired);
  return acquired;
}

function printImportedAWSProfile(
  profileName: string,
  acquired: AcquiredCredential,
): void {
  printSuccess(`Using profile: ${profileName}`);
  if (acquired.metadata?.awsRegion) {
    printInfo(`Region: ${acquired.metadata.awsRegion}`);
  }
}

function withImportConfirmation(
  result: CredentialAcquisitionResult,
  source: string,
): AcquiredCredential {
  const acquired = asAcquiredCredential(result);
  return {
    ...acquired,
    metadata: {
      ...acquired.metadata,
      importConfirmationSource:
        acquired.metadata?.importConfirmationSource ?? source,
    },
  };
}

type AdminProvider = 'AWS' | 'Azure' | 'GCP';

const REQUESTS: Record<AdminProvider, { credential: string; create: string }> =
  {
    AWS: {
      credential: `Access keys for a dedicated Anycloud IAM user with the ${AWS_GENERATION_POLICY_NAME} policy (${AWS_POLICY_URL})`,
      create: 'create IAM users, add inline policies, and create access keys',
    },
    Azure: {
      credential:
        'A dedicated Anycloud service principal: application ID, secret, subscription ID, and tenant ID',
      create: 'create Entra applications and assign roles on the subscription',
    },
    GCP: {
      credential: 'A JSON key for a dedicated Anycloud service account',
      create: 'create service accounts and keys, and grant project IAM roles',
    },
  };

/** A request the user can forward to whoever administers the cloud account. */
function adminRequest(provider: AdminProvider, identity?: string): string {
  const { credential, create } = REQUESTS[provider];
  return [
    `Ask your ${provider} administrator for one of these:`,
    `  - ${credential}`,
    `  - Permission for ${identity ?? 'you'} to create one: ${create}`,
    `Details: ${ADMIN_REQUEST_URL}`,
  ].join('\n');
}

function isPermissionDenied(error: unknown): boolean {
  for (
    let current = error;
    current instanceof Error;
    current = (current as Error & { cause?: unknown }).cause
  ) {
    if (
      (current instanceof AWSCliError &&
        current.category === 'permission denied') ||
      isGCPPermissionDenied(current) ||
      current instanceof AzurePermissionError
    )
      return true;
  }
  return false;
}

/** Append the administrator request to a generation permission failure. */
function withAdminRequest(
  provider: AdminProvider,
  error: unknown,
  identity?: string,
): unknown {
  if (!isPermissionDenied(error)) return error;
  return Object.assign(
    new Error(
      `${(error as Error).message}\n\n${adminRequest(provider, identity)}`,
    ),
    { cause: error, code: 'CLOUD_ADMIN_REQUIRED' },
  );
}

type CredentialSourceChoice = {
  title: string;
  value: string;
  acquire: () => Promise<CredentialAcquisitionResult>;
} & (
  | { kind: 'import' | 'manual'; source: string }
  | { kind: 'generate' | 'handoff' }
);

/** For users who can neither paste nor create credentials themselves. */
function adminHandoffChoice(
  provider: AdminProvider,
  title: string,
): CredentialSourceChoice {
  return {
    title,
    value: 'admin',
    kind: 'handoff',
    acquire: async () => {
      console.log('');
      console.log(adminRequest(provider));
      console.log('');
      printInfo(
        'Nothing was saved. Run "anycloud credentials new" again once you have access.',
      );
      process.exit(0);
    },
  };
}

async function selectCredentialSource(
  provider: string,
  choices: CredentialSourceChoice[],
  preferredValue?: string,
): Promise<AcquiredCredential> {
  let selected = choices[0];
  if (choices.length !== 1 || selected.kind !== 'manual') {
    const selection = await safePrompts<'value'>({
      type: 'select',
      name: 'value',
      message: `How would you like to add ${provider} credentials?`,
      choices: choices.map(({ title, value }) => ({ title, value })),
      initial: Math.max(
        choices.findIndex((choice) => choice.value === preferredValue),
        0,
      ),
    });
    if (!selection.value) process.exit(0);
    const choice = choices.find((choice) => choice.value === selection.value);
    if (!choice) {
      throw new Error(
        `Selected ${provider} credential source is no longer available.`,
      );
    }
    selected = choice;
  }

  const acquired = await selected.acquire();
  return selected.kind === 'import' || selected.kind === 'manual'
    ? withImportConfirmation(acquired, selected.source)
    : asAcquiredCredential(acquired);
}

/** Explicit imports never fall through to IAM generation. */
async function buildAWSInteractive(
  options: NewCredentialsOptions,
  credentialName: string,
): Promise<CredentialAcquisitionResult> {
  if (options.profile || (options.accessKeyId && options.secretAccessKey)) {
    return buildAWSCredentialsFromFlags(options);
  }
  if (options.accessKeyId || options.secretAccessKey) {
    return withImportConfirmation(
      await promptManualAWSCredentials(options),
      'Provided access keys',
    );
  }

  const [candidates, cliInstalled] = await Promise.all([
    discoverCredentialSources({ provider: CloudType.AWS }).catch(
      (error): CredentialCandidate[] => {
        printWarning(`Could not discover AWS profiles: ${errorMessage(error)}`);
        return [];
      },
    ),
    isAWSCLIInstalled(),
  ]);
  const profiles = candidates.filter(
    (candidate): candidate is AWSCredentialCandidate =>
      candidate.kind === 'aws-profile',
  );
  const hasEnvironmentKeys = Boolean(
    process.env.AWS_ACCESS_KEY_ID &&
      process.env.AWS_SECRET_ACCESS_KEY &&
      !process.env.AWS_SESSION_TOKEN,
  );
  if (!cliInstalled) {
    printWarning('AWS CLI not found');
    printInfo(
      'To create an IAM user from here, install AWS CLI 2.32 or later:',
    );
    printInfo(`  ${getAWSCLIInstallCommand()}`);
    console.log('');
  } else if (profiles.length === 0 && !hasEnvironmentKeys) {
    printWarning('No durable AWS access-key profile was found.');
  }

  const currentProfile = getCurrentAWSProfile();
  const choices: CredentialSourceChoice[] = [];
  if (hasEnvironmentKeys) {
    choices.push({
      title: 'Use access keys from environment',
      value: 'environment',
      kind: 'import',
      source: 'AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY',
      acquire: () => buildAWSCredentialsFromFlags(options),
    });
  }
  choices.push(
    ...profiles.map(
      (candidate): CredentialSourceChoice => ({
        title: `AWS profile: ${candidate.profileName}${candidate.profileName === currentProfile ? ' (current)' : ''}`,
        value: candidate.id,
        kind: 'import',
        source: `AWS profile "${candidate.profileName}"`,
        acquire: async () => {
          rejectAWSImportAccountId(options);
          return materializeCredential(candidate);
        },
      }),
    ),
    {
      title: 'Enter existing access keys',
      value: 'enter',
      kind: 'manual',
      source: 'Manually entered access keys',
      acquire: () =>
        promptManualAWSCredentials(options, {
          useEnvironmentDefaults: false,
        }),
    },
  );
  if (cliInstalled) {
    choices.push({
      title: 'Create an IAM user with AWS CLI',
      value: 'create',
      kind: 'generate',
      acquire: () =>
        acquireAWSGeneratedCredentials(credentialName, options, true),
    });
  }
  choices.push(adminHandoffChoice('AWS', "I don't have AWS access keys"));

  return selectCredentialSource(
    'AWS',
    choices,
    hasEnvironmentKeys
      ? 'environment'
      : profiles.find((candidate) => candidate.profileName === currentProfile)
          ?.id,
  );
}

function validateAWSGenerationSelection(
  credentialName: string,
  options: NewCredentialsOptions,
  interactive = false,
): void {
  rejectGeneratedCredentialMaterial(options, CloudType.AWS);
  if (options.overwrite) {
    exitWithError(
      'Cannot use generation with --overwrite; select a new credential name.',
    );
  }
  validateAWSGenerationName(credentialName);
  if (!interactive && (!options.profile || !options.accountId)) {
    exitWithError(
      'AWS --generate requires --profile and --account-id to select the operator and target account.',
    );
  }
  if (options.accountId !== undefined && !/^\d{12}$/.test(options.accountId)) {
    exitWithError('AWS --account-id must contain exactly 12 digits.');
  }
}

/** Operators only run the AWS CLI, so SSO and session profiles qualify. */
async function promptAWSOperatorProfile(): Promise<string | undefined> {
  const profiles = await listAWSProfileNames();
  if (profiles.length === 0) {
    exitWithError(
      'No AWS profiles found. Run "aws configure --profile <name>" or "aws configure sso", then try again.',
    );
  }
  const currentProfile = getCurrentAWSProfile();
  const selection = await safePrompts<'value'>({
    type: 'select',
    name: 'value',
    message: 'AWS operator profile:',
    choices: profiles.map((name) => ({
      title: name === currentProfile ? `${name} (current)` : name,
      value: name,
    })),
    initial: Math.max(profiles.indexOf(currentProfile), 0),
  });
  return profiles.find((name) => name === selection.value);
}

async function acquireAWSGeneratedCredentials(
  credentialName: string,
  options: NewCredentialsOptions,
  interactive = false,
): Promise<AcquiredCredential> {
  validateAWSGenerationSelection(credentialName, options, interactive);
  const profile = options.profile ?? (await promptAWSOperatorProfile());
  if (!profile) process.exit(0);
  const preview = await getAWSGenerationPreview(
    awsOperator(profile),
    credentialName,
    options.accountId,
  ).catch((error: unknown) => {
    throw withAdminRequest('AWS', error, `AWS profile ${profile}`);
  });
  printInfo(`AWS operator: ${preview.caller.Arn} (profile ${profile})`);
  printInfo(`Account ID: ${preview.caller.Account}`);
  printInfo(`IAM user to create: ${preview.userName}`);
  printInfo(`Policy: ${AWS_GENERATION_POLICY_NAME} (${AWS_POLICY_URL})`);
  printInfo(
    'Required operator access: create and tag IAM users, inspect user identity and tags, add inline policies, and create access keys. Cleanup also requires deleting those resources.',
  );
  if (interactive) {
    const answer = await safePrompts<'confirmed'>({
      type: 'confirm',
      name: 'confirmed',
      message: 'Create these AWS credentials?',
      initial: true,
    });
    if (!answer.confirmed) process.exit(0);
  }
  const spinner = createSpinner(
    `Creating IAM user "${preview.userName}"...`,
  ).start();
  const generated = await generateAWSCredentials(preview)
    .catch((error: unknown) => {
      throw withAdminRequest(
        'AWS',
        error,
        `${preview.caller.Arn} (account ${preview.caller.Account})`,
      );
    })
    .finally(() => spinner.stop());
  const identityDescription = describeAWSGeneration(generated.ownership);
  printInfo(`Created ${identityDescription}`);
  return generatedCredential(
    buildCredentialFromFields(CloudType.AWS, {
      accessKeyId: generated.accessKeyId,
      secretAccessKey: generated.secretAccessKey,
    }),
    generated.cleanup,
    { identityDescription },
  );
}

export function validateGenerationSelection(
  credentialName: string,
  options: NewCredentialsOptions,
): void {
  const raw = options.provider ?? process.env.ANYCLOUD_CLOUD_PROVIDER;
  if (!raw)
    exitWithError(
      'Missing --provider. Pass --provider aws, azure, or gcp when using --generate.',
    );
  validateProfileOption(options, normalizeCredentialProvider(raw));
  if (raw && normalizeCredentialProvider(raw) === CloudType.AWS) {
    validateAWSGenerationSelection(credentialName, options);
    return;
  }
  if (normalizeCredentialProvider(raw) === CloudType.GCP) {
    validateGCPGenerationSelection(credentialName, options);
    return;
  }
  if (normalizeCredentialProvider(raw) !== CloudType.Azure) {
    exitWithError(
      `--generate is supported only with --provider aws, azure, or gcp. ${unsupportedGenerationGuidance(normalizeCredentialProvider(raw))}`,
    );
  }
  validateAzureGenerationSelection(credentialName, options);
}

export function acquireGeneratedCredentials(
  credentialName: string,
  options: NewCredentialsOptions,
): Promise<AcquiredCredential> {
  validateGenerationSelection(credentialName, options);
  const raw = options.provider ?? process.env.ANYCLOUD_CLOUD_PROVIDER;
  if (raw && normalizeCredentialProvider(raw) === CloudType.GCP) {
    return acquireGCPGeneratedCredentials(credentialName, options);
  }
  return raw && normalizeCredentialProvider(raw) === CloudType.AWS
    ? acquireAWSGeneratedCredentials(credentialName, options)
    : acquireAzureGeneratedCredentials(credentialName, options);
}

async function promptManualAWSCredentials(
  options: NewCredentialsOptions,
  { useEnvironmentDefaults = true }: { useEnvironmentDefaults?: boolean } = {},
): Promise<CloudCredentials> {
  rejectAWSImportAccountId(options);
  if (
    useEnvironmentDefaults &&
    process.env.AWS_SESSION_TOKEN &&
    (!options.accessKeyId || !options.secretAccessKey)
  ) {
    throw new Error(
      'Temporary AWS session credentials cannot be saved because they expire. Use a durable static profile or enter long-lived access keys.',
    );
  }
  const accessKeyId =
    options.accessKeyId ??
    (useEnvironmentDefaults ? process.env.AWS_ACCESS_KEY_ID : undefined) ??
    (
      await safePrompts<'value'>({
        type: 'text',
        name: 'value',
        message: 'AWS Access Key ID:',
        validate: (value) => (value.length > 0 ? true : 'Required'),
      })
    ).value;
  if (!accessKeyId) process.exit(0);

  const secretAccessKey =
    options.secretAccessKey ??
    (useEnvironmentDefaults ? process.env.AWS_SECRET_ACCESS_KEY : undefined) ??
    (
      await safePrompts<'value'>({
        type: 'password',
        name: 'value',
        message: 'AWS Secret Access Key:',
        validate: (value) => (value.length > 0 ? true : 'Required'),
      })
    ).value;
  if (!secretAccessKey) process.exit(0);

  return buildCredentialFromFields(CloudType.AWS, {
    accessKeyId: accessKeyId as string,
    secretAccessKey: secretAccessKey as string,
  });
}

function hasAzureCredentialMaterial(options: NewCredentialsOptions): boolean {
  return Boolean(
    options.applicationId || options.secret || options.directoryId,
  );
}

function printAzureGenerationPreview(preview: AzureGenerationPreview): void {
  printInfo('Azure CLI will create a new service principal with:');
  printInfo(`Tenant: ${preview.tenantId}`);
  printInfo(`Subscription: ${preview.subscriptionId}`);
  printInfo(`Scope: ${preview.scope}`);
  printInfo(`Roles: ${preview.roles.join(', ')}`);
  printInfo(
    'Required operator access: create Entra applications and service principals, add application passwords, and assign that role at this scope.',
  );
}

async function confirmAzureGeneration(
  preview: AzureGenerationPreview,
): Promise<void> {
  printAzureGenerationPreview(preview);
  const answer = await safePrompts<'confirmed'>({
    type: 'confirm',
    name: 'confirmed',
    message: 'Create these Azure credentials?',
    initial: true,
  });
  if (!answer.confirmed) process.exit(0);
}

/** Azure generation is a distinct, explicit action in the interactive flow. */
async function buildAzureInteractive(
  options: NewCredentialsOptions,
  credentialName: string,
): Promise<CredentialAcquisitionResult> {
  if (
    options.applicationId &&
    options.secret &&
    options.subscriptionId &&
    options.directoryId
  ) {
    return buildAzureCredentialsFromFlags(options);
  }

  if (hasAzureCredentialMaterial(options)) {
    return withImportConfirmation(
      await promptManualAzureCredentials(options),
      'Provided service principal credentials',
    );
  }

  const choices: CredentialSourceChoice[] = [];
  if (
    process.env.AZURE_APPLICATION_ID &&
    process.env.AZURE_SECRET &&
    (options.subscriptionId ?? process.env.AZURE_SUBSCRIPTION_ID) &&
    process.env.AZURE_DIRECTORY_ID
  ) {
    choices.push({
      title: 'Use service principal credentials from environment',
      value: 'environment',
      kind: 'import',
      source: 'Azure environment variables',
      acquire: () => buildAzureCredentialsFromFlags(options),
    });
  }
  choices.push(
    {
      title: 'Enter existing service principal credentials',
      value: 'enter',
      kind: 'manual',
      source: 'Manually entered service principal credentials',
      acquire: () =>
        promptManualAzureCredentials(options, {
          useEnvironmentDefaults: false,
        }),
    },
    {
      title: 'Create a service principal with Azure CLI',
      value: 'create',
      kind: 'generate',
      acquire: () =>
        acquireAzureInteractiveGeneratedCredentials(options, credentialName),
    },
    adminHandoffChoice(
      'Azure',
      "I don't have Azure service principal credentials",
    ),
  );
  return selectCredentialSource('Azure', choices, 'environment');
}

async function acquireAzureInteractiveGeneratedCredentials(
  options: NewCredentialsOptions,
  credentialName: string,
): Promise<AcquiredCredential> {
  const cliInstalled = await isAzureCLIInstalled();
  if (!cliInstalled) {
    printWarning('Azure CLI is not installed');
    printInfo(`Install it: ${getAzureCLIInstallCommand()}`);
    exitWithError(
      'Azure credential generation requires the Azure CLI. Install it, or rerun and choose another option.',
    );
  }

  let cliLoggedIn = await isAzureCLILoggedIn();
  if (!cliLoggedIn) {
    printInfo('Opening browser for Azure login...');
    try {
      await loginToAzure();
      cliLoggedIn = await isAzureCLILoggedIn();
      if (!cliLoggedIn) {
        throw new Error('Azure CLI login did not produce an active account');
      }
      printSuccess('Logged in successfully!');
    } catch (error) {
      exitWithError(`Azure login failed: ${(error as Error).message}`);
    }
  }

  const subscriptionId = await resolveAzureSubscriptionId(options);
  const preview = await getAzureGenerationPreview(subscriptionId);
  await confirmAzureGeneration(preview);

  const spinner = createSpinner(
    `Creating service principal "anycloud-${credentialName}"...`,
  ).start();
  try {
    const generated = await generateAzureServicePrincipal(
      subscriptionId,
      credentialName,
    );
    spinner.succeed('Service principal created successfully!');
    printInfo(`Application ID: ${generated.applicationId}`);
    if (generated.secretExpiresAt) {
      printInfo(`Secret expires: ${generated.secretExpiresAt}`);
    }
    console.log('');
    return generatedCredential(
      buildCredentialFromFields(CloudType.Azure, {
        applicationId: generated.applicationId,
        secret: generated.secret,
        subscriptionId,
        directoryId: generated.tenantId,
      }),
      generated.cleanup,
    );
  } catch (error) {
    spinner.fail(
      `Failed to create service principal: ${(error as Error).message}`,
    );
    throw withAdminRequest(
      'Azure',
      error,
      `you in subscription ${subscriptionId}`,
    );
  }
}

function formatAzureSubscription(subscription: AzureSubscription): string {
  return subscription.name
    ? `${subscription.name} (${subscription.id})`
    : subscription.id;
}

async function resolveAzureSubscriptionId(
  options: NewCredentialsOptions,
): Promise<string> {
  const provided = options.subscriptionId ?? process.env.AZURE_SUBSCRIPTION_ID;
  if (provided) return provided;

  let subscriptions: AzureSubscription[] = [];
  try {
    subscriptions = await listAzureSubscriptions();
  } catch (error) {
    printWarning(
      `Could not list Azure subscriptions: ${(error as Error).message}`,
    );
    console.log('');
    const current = await getCurrentAzureSubscription();
    if (current?.id) {
      printInfo(
        `Using Azure subscription: ${formatAzureSubscription(current)}`,
      );
      return current.id;
    }
    return promptAzureSubscriptionId();
  }

  if (subscriptions.length === 1) {
    printInfo(
      `Using Azure subscription: ${formatAzureSubscription(subscriptions[0])}`,
    );
    return subscriptions[0].id;
  }

  if (subscriptions.length > 1) {
    const defaultIndex = Math.max(
      subscriptions.findIndex((s) => s.isDefault),
      0,
    );
    const choice = await safePrompts<'value'>({
      type: 'select',
      name: 'value',
      message: 'Select Azure subscription:',
      choices: subscriptions.map((s) => ({
        title: formatAzureSubscription(s),
        value: s.id,
        description: s.tenantId ? `Tenant: ${s.tenantId}` : '',
      })),
      initial: defaultIndex,
    });
    if (!choice.value) process.exit(0);
    return choice.value as string;
  }

  const current = await getCurrentAzureSubscription();
  if (current?.id) {
    printInfo(`Using Azure subscription: ${formatAzureSubscription(current)}`);
    return current.id;
  }

  return promptAzureSubscriptionId();
}

async function promptAzureSubscriptionId(): Promise<string> {
  const manual = await safePrompts<'value'>({
    type: 'text',
    name: 'value',
    message: 'Azure subscription ID to scope the service principal to:',
    validate: (value) => (value.length > 0 ? true : 'Subscription ID required'),
  });
  if (!manual.value) process.exit(0);
  return manual.value as string;
}

async function promptManualAzureCredentials(
  options: NewCredentialsOptions,
  { useEnvironmentDefaults = true }: { useEnvironmentDefaults?: boolean } = {},
): Promise<CloudCredentials> {
  const applicationId =
    options.applicationId ??
    (useEnvironmentDefaults ? process.env.AZURE_APPLICATION_ID : undefined) ??
    (
      await safePrompts<'value'>({
        type: 'text',
        name: 'value',
        message: 'Service Principal Application ID (appId):',
        validate: (value) =>
          value.length > 0 ? true : 'Application ID required',
      })
    ).value;
  if (!applicationId) process.exit(0);

  const secret =
    options.secret ??
    (useEnvironmentDefaults ? process.env.AZURE_SECRET : undefined) ??
    (
      await safePrompts<'value'>({
        type: 'password',
        name: 'value',
        message: 'Service Principal Secret (password):',
        validate: (value) => (value.length > 0 ? true : 'Secret required'),
      })
    ).value;
  if (!secret) process.exit(0);

  const subscriptionId =
    options.subscriptionId ??
    (useEnvironmentDefaults ? process.env.AZURE_SUBSCRIPTION_ID : undefined) ??
    (
      await safePrompts<'value'>({
        type: 'text',
        name: 'value',
        message: 'Subscription ID:',
        validate: (value) =>
          value.length > 0 ? true : 'Subscription ID required',
      })
    ).value;
  if (!subscriptionId) process.exit(0);

  const directoryId =
    options.directoryId ??
    (useEnvironmentDefaults ? process.env.AZURE_DIRECTORY_ID : undefined) ??
    (
      await safePrompts<'value'>({
        type: 'text',
        name: 'value',
        message: 'Directory ID (Tenant ID):',
        validate: (value) =>
          value.length > 0 ? true : 'Directory ID required',
      })
    ).value;
  if (!directoryId) process.exit(0);

  return buildCredentialFromFields(CloudType.Azure, {
    applicationId: applicationId as string,
    secret: secret as string,
    subscriptionId: subscriptionId as string,
    directoryId: directoryId as string,
  });
}

async function buildGCPInteractive(
  options: NewCredentialsOptions,
  credentialName: string,
): Promise<CredentialAcquisitionResult> {
  if (options.projectId && options.clientEmail && options.privateKey) {
    return buildGCPCredentialsFromFlags(options);
  }

  const spinner = createSpinner('Checking for GCP credentials...').start();
  const candidates = (
    await discoverCredentialSources({ provider: CloudType.GCP })
  ).filter(
    (candidate): candidate is GCPCredentialCandidate =>
      candidate.kind === 'gcp-key-file',
  );

  if (candidates.length > 0) {
    spinner.succeed(`Found ${candidates.length} GCP service account key(s)`);
    console.log('');
  } else {
    spinner.warn('No GCP service account keys found');
    console.log('');
  }

  const choices: CredentialSourceChoice[] = [];
  if (
    process.env.GCP_PROJECT_ID &&
    process.env.GCP_CLIENT_EMAIL &&
    process.env.GCP_PRIVATE_KEY
  ) {
    choices.push({
      title: 'Use service account credentials from environment',
      value: 'environment',
      kind: 'import',
      source: 'GCP_PROJECT_ID, GCP_CLIENT_EMAIL, and GCP_PRIVATE_KEY',
      acquire: () => buildGCPCredentialsFromFlags(options),
    });
  }
  choices.push(
    ...candidates.map(
      (candidate, index): CredentialSourceChoice => ({
        title:
          index === 0 && candidates.length > 1
            ? `${candidate.keyPath} (most recent)`
            : candidate.keyPath,
        value: candidate.id,
        kind: 'import',
        source: `${candidate.source}: ${candidate.keyPath}`,
        acquire: async () => {
          rejectGCPOperatorForImport(options);
          return materializeCredential(candidate);
        },
      }),
    ),
    {
      title: 'Upload existing service account key file',
      value: 'upload',
      kind: 'manual',
      source: 'Service-account key file',
      acquire: () => {
        rejectGCPOperatorForImport(options);
        return uploadGCPKeyFlow();
      },
    },
    {
      title: 'Create a service account with gcloud',
      value: 'create',
      kind: 'generate',
      acquire: () =>
        acquireGCPGeneratedCredentials(credentialName, options, true),
    },
    adminHandoffChoice('GCP', "I don't have a GCP service account key"),
  );
  return selectCredentialSource('GCP', choices, 'environment');
}

function validateGCPGenerationSelection(
  credentialName: string,
  options: NewCredentialsOptions,
  interactive = false,
): void {
  validateProfileOption(options, CloudType.GCP);
  rejectGeneratedCredentialMaterial(options, CloudType.GCP);
  if (options.overwrite)
    exitWithError(
      'Cannot use generation with --overwrite; select a new credential name.',
    );
  validateGCPGenerationName(credentialName);
  if (!interactive && (!options.gcloudAccount || !options.projectId)) {
    exitWithError(
      'GCP --generate requires --gcloud-account and --project-id to select the operator and target project.',
    );
  }
  if (options.gcloudAccount && options.projectId)
    gcpOperator(options.gcloudAccount, options.projectId);
}

async function acquireGCPGeneratedCredentials(
  credentialName: string,
  options: NewCredentialsOptions,
  interactive = false,
): Promise<AcquiredCredential> {
  validateGCPGenerationSelection(credentialName, options, interactive);
  if (!(await isGCloudInstalled())) {
    exitWithError(
      `GCP credential generation requires the Google Cloud CLI. Install it: ${getGCloudInstallCommand()}`,
    );
  }
  const defaults =
    options.gcloudAccount && options.projectId
      ? {}
      : await getGCPOperatorDefaults();
  const account =
    options.gcloudAccount ??
    ((
      await safePrompts<'value'>({
        type: 'text',
        name: 'value',
        message: 'GCP operator account:',
        initial: defaults.account,
        validate: (value) => (value.trim() ? true : 'Account required'),
      })
    ).value as string | undefined);
  if (!account) process.exit(0);
  const projectId =
    options.projectId ??
    ((
      await safePrompts<'value'>({
        type: 'text',
        name: 'value',
        message: 'GCP project ID:',
        initial: defaults.projectId,
        validate: (value) => (value.trim() ? true : 'Project required'),
      })
    ).value as string | undefined);
  if (!projectId) process.exit(0);
  const operatorIdentity = `${account} in project ${projectId}`;
  const preview = await getGCPGenerationPreview(
    gcpOperator(account, projectId),
    credentialName,
  ).catch((error: unknown) => {
    throw withAdminRequest('GCP', error, operatorIdentity);
  });
  printInfo(`GCP operator: ${account}`);
  printInfo(
    `Project ID: ${projectId} (project number ${preview.projectNumber})`,
  );
  printInfo(`Service account to create: ${preview.email}`);
  printInfo(
    `Project role: ${GCP_ANYCLOUD_ROLE_ID} (created or updated from Anycloud's published role)`,
  );
  printInfo(
    'Required operator access: create and update project custom roles, create and inspect service accounts and keys, update project IAM, and delete the generated resources for cleanup.',
  );
  if (interactive) {
    const answer = await safePrompts<'confirmed'>({
      type: 'confirm',
      name: 'confirmed',
      message: 'Create these GCP credentials?',
      initial: true,
    });
    if (!answer.confirmed) process.exit(0);
  }
  const spinner = createSpinner(
    `Creating service account ${preview.email}...`,
  ).start();
  const generated = await generateGCPCredentials(preview)
    .catch((error: unknown) => {
      throw withAdminRequest('GCP', error, operatorIdentity);
    })
    .finally(() => spinner.stop());
  const identityDescription = describeGCPGeneration(generated.ownership);
  printInfo(`Created ${identityDescription}`);
  printInfo(`Service-account key ID: ${generated.ownership.keyIds[0]}`);
  return generatedCredential(
    buildCredentialFromFields(CloudType.GCP, {
      projectId: generated.projectId,
      clientEmail: generated.clientEmail,
      privateKey: generated.privateKey,
    }),
    generated.cleanup,
    { identityDescription },
  );
}

function unsupportedGenerationGuidance(provider: CloudType): string {
  if (provider === CloudType.AWS) {
    return 'Import a durable static profile with --profile, or enter long-lived access keys.';
  }
  if (provider === CloudType.GCP) {
    return 'Import a service-account JSON key, or enter its durable fields.';
  }
  return 'Enter existing durable credential fields instead.';
}

export function validateAzureGenerationSelection(
  credentialName: string,
  options: NewCredentialsOptions,
): void {
  const providerRaw = options.provider ?? process.env.ANYCLOUD_CLOUD_PROVIDER;
  if (!providerRaw) {
    exitWithError(
      'Missing --provider. Pass --provider azure when using --generate.',
    );
  }
  const provider = normalizeCredentialProvider(providerRaw);
  if (provider !== CloudType.Azure) {
    exitWithError(
      `--generate is only supported with --provider azure. ${unsupportedGenerationGuidance(provider)}`,
    );
  }
  validateProfileOption(options, provider);
  rejectGeneratedCredentialMaterial(options, provider);
  if (options.overwrite) {
    exitWithError(
      'Cannot use --generate with --overwrite; generated identities must use a new credential name.',
    );
  }
  validateGeneratedAzureCredentialName(credentialName);
}

export async function acquireAzureGeneratedCredentials(
  credentialName: string,
  options: NewCredentialsOptions,
): Promise<AcquiredCredential> {
  validateAzureGenerationSelection(credentialName, options);
  if (!(await isAzureCLIInstalled())) {
    exitWithError(
      `--generate requires the Azure CLI. Install it: ${getAzureCLIInstallCommand()}`,
    );
  }
  if (!(await isAzureCLILoggedIn())) {
    exitWithError(
      '--generate requires an authenticated Azure CLI. Run: az login',
    );
  }
  const subscriptionId =
    options.subscriptionId ??
    process.env.AZURE_SUBSCRIPTION_ID ??
    (await getCurrentAzureSubscription())?.id;
  if (!subscriptionId) {
    exitWithError(
      '--generate could not determine an Azure subscription. Pass --subscription-id or select one with az account set.',
    );
  }
  printInfo(`Using Azure subscription: ${subscriptionId}`);
  printInfo(`Using service principal name: anycloud-${credentialName}`);
  printAzureGenerationPreview(await getAzureGenerationPreview(subscriptionId));
  const generated = await generateAzureServicePrincipal(
    subscriptionId,
    credentialName,
  ).catch((error: unknown) => {
    throw withAdminRequest(
      'Azure',
      error,
      `you in subscription ${subscriptionId}`,
    );
  });
  if (generated.secretExpiresAt) {
    printInfo(`Secret expires: ${generated.secretExpiresAt}`);
  }
  return generatedCredential(
    buildCredentialFromFields(CloudType.Azure, {
      applicationId: generated.applicationId,
      secret: generated.secret,
      subscriptionId,
      directoryId: generated.tenantId,
    }),
    generated.cleanup,
  );
}

export async function buildAzureGeneratedCredentials(
  credentialName: string,
  options: NewCredentialsOptions,
): Promise<CloudCredentials> {
  return (await acquireAzureGeneratedCredentials(credentialName, options))
    .credential;
}

async function uploadGCPKeyFlow(): Promise<AcquiredCredential> {
  const keyPath = await safePrompts<'value'>({
    type: 'text',
    name: 'value',
    message: 'Enter path to service account key JSON file:',
    initial: '~/Downloads/',
    validate: (value) => (value.length > 0 ? true : 'Path required'),
  });
  if (!keyPath.value) process.exit(0);
  const spinner = createSpinner('Validating service account key...').start();
  try {
    const prepared = await prepareGCPServiceAccountKeyImport(
      keyPath.value as string,
    );
    spinner.succeed('Service account key validated');
    console.log('');
    return {
      ...acquiredCredential(
        buildCredentialFromFields(CloudType.GCP, {
          projectId: prepared.projectId,
          clientEmail: prepared.clientEmail,
          privateKey: prepared.privateKey,
        }),
        {
          importConfirmationSource: `Service-account key file: ${keyPath.value}`,
        },
      ),
      afterImportApproval: async () => {
        await prepared.persist();
        printInfo(`Key saved to: ${prepared.keyFilePath}`);
      },
    };
  } catch (error) {
    spinner.fail('Failed to validate key file');
    printError((error as Error).message);
    process.exit(1);
  }
}

async function buildAPIKeyInteractive(
  options: NewCredentialsOptions,
  config: {
    provider: CloudType.Lambda;
    label: string;
    environmentVariable: string;
    environmentKey: string | undefined;
    keyUrl: string;
  },
): Promise<CredentialAcquisitionResult> {
  if (options.apiKey) {
    return buildCredentialFromFields(config.provider, {
      apiKey: options.apiKey,
    });
  }
  printInfo(`${config.label} uses an API key for authentication.`);
  printInfo(`Get your API key at: ${config.keyUrl}`);
  console.log('');
  const choices: CredentialSourceChoice[] = [];
  if (config.environmentKey) {
    choices.push({
      title: 'Use API key from environment',
      value: 'environment',
      kind: 'import',
      source: config.environmentVariable,
      acquire: async () =>
        buildCredentialFromFields(config.provider, {
          apiKey: config.environmentKey,
        }),
    });
  }
  choices.push({
    title: 'Enter an API key',
    value: 'enter',
    kind: 'manual',
    source: 'Manually entered API key',
    acquire: async () => {
      const answer = await safePrompts<'value'>({
        type: 'password',
        name: 'value',
        message: `${config.label} API Key:`,
        validate: (value) => (value.length > 0 ? true : 'API key required'),
      });
      if (!answer.value) process.exit(0);
      return buildCredentialFromFields(config.provider, {
        apiKey: answer.value as string,
      });
    },
  });
  return selectCredentialSource(config.label, choices, 'environment');
}

async function buildLambdaInteractive(
  options: NewCredentialsOptions,
): Promise<CredentialAcquisitionResult> {
  return buildAPIKeyInteractive(options, {
    provider: CloudType.Lambda,
    label: 'Lambda Labs',
    environmentVariable: 'LAMBDA_API_KEY',
    environmentKey: process.env.LAMBDA_API_KEY,
    keyUrl: 'https://cloud.lambda.ai/api-keys',
  });
}

async function buildCloudflareInteractive(
  options: NewCredentialsOptions,
): Promise<CredentialAcquisitionResult> {
  printInfo(
    'Cloudflare credentials hold R2 storage only. The API token needs account-level R2 read and write, because anycloud creates buckets and mints temporary credentials with it.',
  );
  printInfo(
    'Create a token at: https://dash.cloudflare.com/profile/api-tokens',
  );
  console.log('');
  const answers = await safePrompts<'accountId' | 'apiToken'>([
    {
      type: options.accountId ? null : 'text',
      name: 'accountId',
      message: 'Cloudflare Account ID:',
      initial: process.env.CLOUDFLARE_ACCOUNT_ID ?? '',
      validate: (value: string) =>
        value.length > 0 ? true : 'Account ID required',
    },
    {
      type: options.apiToken ? null : 'password',
      name: 'apiToken',
      message: 'Cloudflare API Token:',
      validate: (value: string) =>
        value.length > 0 ? true : 'API token required',
    },
  ]);
  const accountId = options.accountId ?? (answers.accountId as string);
  const apiToken = options.apiToken ?? (answers.apiToken as string);
  if (!accountId || !apiToken) process.exit(0);
  return cloudflareFields(options, accountId, apiToken);
}

export async function acquireCredentialsInteractive(
  credentialName: string,
  options: NewCredentialsOptions,
): Promise<AcquiredCredential> {
  const provider = await resolveProvider(options);
  validateProfileOption(options, provider);
  switch (provider) {
    case CloudType.AWS:
      return asAcquiredCredential(
        await buildAWSInteractive(options, credentialName),
      );
    case CloudType.Azure:
      return asAcquiredCredential(
        await buildAzureInteractive(options, credentialName),
      );
    case CloudType.GCP:
      return asAcquiredCredential(
        await buildGCPInteractive(options, credentialName),
      );
    case CloudType.Lambda:
      return asAcquiredCredential(await buildLambdaInteractive(options));
    case CloudType.Cloudflare:
      return asAcquiredCredential(await buildCloudflareInteractive(options));
    case CloudType.Local:
      exitWithError(`Unsupported provider: ${provider}`);
  }
}

export async function buildCredentialsInteractive(
  credentialName: string,
  options: NewCredentialsOptions,
): Promise<CloudCredentials> {
  return (await acquireCredentialsInteractive(credentialName, options))
    .credential;
}

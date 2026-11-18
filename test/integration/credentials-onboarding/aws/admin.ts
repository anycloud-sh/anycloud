import { execFile } from 'child_process';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

import { retryUntilDeadline } from '../common/deadline-retry.js';
import { AWS_INVOCATION_TAG } from '../../../../src/cli/services/credential-bootstrap/aws.js';
import { AWS_GENERATION_POLICY_NAME } from '../../../../src/shared/permission-denied.js';
import anycloudAccess from '../../../../src/shared/cloud-policies/aws-anycloud-access.json' with { type: 'json' };

const execFileAsync = promisify(execFile);

export type AWSOnboardingUserSuite = 'onboarding' | 'bucket';

export interface AWSOnboardingSecrets {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface BootstrapAWSContext {
  bootstrapArn: string;
  environment: NodeJS.ProcessEnv;
  rootDir: string;
  run?: (args: string[], environment: NodeJS.ProcessEnv) => Promise<string>;
  wait?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  /** Runs each user-cleanup call, for example retrying it within a deadline. */
  cleanupCall?: (run: () => Promise<string>) => Promise<string>;
}

export interface AWSImportFixture {
  userName: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface ListedAWSUser {
  UserName: string;
  Arn: string;
}

export interface AWSUserTag {
  Key: string;
  Value: string;
}

const MANAGED_USER_PREFIX: Record<AWSOnboardingUserSuite, string> = {
  onboarding: 'onb',
  bucket: 'bkt',
};
const MANAGED_TAG_KEY = 'anycloud:managed';
const MANAGED_TAG_VALUE = 'true';
const CREDENTIAL_NAME_TAG_KEY = 'anycloud:credential-name';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
// The live `--generate` case names its users from a random UUID.
const GENERATED_USER_PATTERN = new RegExp(`^anycloud-onb-gen-${UUID}$`);
const INVOCATION_ID_PATTERN = new RegExp(`^${UUID}$`);
const ONBOARDING_SMOKE_BUCKET_PATTERN =
  /^anycloud-onb-smoke-[0-9]+-[a-f0-9]{16}$/;
// IAM distributes new users, keys, and policy attachments independently;
// keep the live fixture bounded while tolerating multi-minute outliers.
export const AWS_IMPORT_READINESS_TIMEOUT_MS = 5 * 60_000;

type AWSImportReadinessOperation = 'STS' | 'S3' | 'EC2';

/** The regions RFC 0047's pilot credential may use EC2 in. */
const RESTRICTED_PILOT_REGIONS = ['us-east-1', 'us-east-2', 'us-west-2'];
const RESTRICTED_PILOT_POLICY_NAME = 'anycloud-restricted-pilot';

/**
 * The 0.1.66 AWS pilot's admin-approved policy (experiments/aws-restricted-iam):
 * EC2 in three regions and the Spot service-linked role, no other IAM action,
 * plus S3 on the named buckets and the federation token that scopes them.
 */
export function restrictedPilotPolicy(buckets: readonly string[]): object {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: 'ec2:*',
        Resource: '*',
        Condition: {
          StringEquals: { 'aws:RequestedRegion': RESTRICTED_PILOT_REGIONS },
        },
      },
      {
        Effect: 'Allow',
        Action: 'iam:CreateServiceLinkedRole',
        Resource:
          'arn:aws:iam::*:role/aws-service-role/spot.amazonaws.com/AWSServiceRoleForEC2Spot',
        Condition: {
          StringLike: { 'iam:AWSServiceName': 'spot.amazonaws.com' },
        },
      },
      {
        Effect: 'Allow',
        Action: 's3:*',
        Resource: buckets.flatMap((bucket) => [
          `arn:aws:s3:::${bucket}`,
          `arn:aws:s3:::${bucket}/*`,
        ]),
      },
      { Effect: 'Allow', Action: 'sts:GetFederationToken', Resource: '*' },
    ],
  };
}

class AWSFixtureReadinessError extends Error {
  constructor(
    readonly operation: AWSImportReadinessOperation,
    readonly retryable: boolean,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'AWSFixtureReadinessError';
  }
}

function awsFailureDiagnostic(error: unknown): string {
  const candidate = error as {
    message?: unknown;
    stderr?: unknown;
  };
  const raw =
    typeof candidate?.stderr === 'string' && candidate.stderr.trim()
      ? candidate.stderr
      : typeof candidate?.message === 'string'
        ? candidate.message
        : String(error);
  return raw.replace(/\s+/g, ' ').trim().slice(0, 1_000);
}

function isRetryableAWSReadinessFailure(
  operation: AWSImportReadinessOperation,
  error: unknown,
): boolean {
  const candidate = error as {
    name?: unknown;
    code?: unknown;
    message?: unknown;
    stderr?: unknown;
  };
  const diagnostic = [
    candidate?.name,
    candidate?.code,
    candidate?.message,
    candidate?.stderr,
  ]
    .filter((value): value is string => typeof value === 'string')
    .join(' ');

  if (
    /InvalidClientTokenId|InvalidClientToken|UnrecognizedClientException|InvalidAccessKeyId|AuthFailure|invalid security token|security token.*invalid|invalid access key|access key.*does not exist|Throttl|TooManyRequests|SlowDown|RequestTimeout|Internal(?:Error|Failure)|ServiceFailure|ServiceUnavailable|temporarily unavailable|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|(?:Read|Connect)TimeoutError|ConnectionClosedError|connection (?:was )?(?:closed|reset)|(?:Read|Connect) timeout on endpoint URL|(?:Could not|Failed to) connect to (?:the )?(?:endpoint|proxy) URL|timed? out/i.test(
      diagnostic,
    )
  ) {
    return true;
  }
  if (operation === 'S3') {
    return /AccessDenied|not authorized|Forbidden/i.test(diagnostic);
  }
  if (operation === 'EC2') {
    return /UnauthorizedOperation|AccessDenied|not authorized/i.test(
      diagnostic,
    );
  }
  return false;
}

async function runAWSReadinessOperation(
  context: Pick<BootstrapAWSContext, 'environment' | 'run'>,
  operation: AWSImportReadinessOperation,
  args: string[],
): Promise<string> {
  try {
    return await runAdminAWS(context, args);
  } catch (cause) {
    throw new AWSFixtureReadinessError(
      operation,
      isRetryableAWSReadinessFailure(operation, cause),
      awsFailureDiagnostic(cause),
      { cause },
    );
  }
}

function nonRetryableReadinessFailure(
  operation: AWSImportReadinessOperation,
  message: string,
  cause?: unknown,
): AWSFixtureReadinessError {
  return new AWSFixtureReadinessError(operation, false, message, { cause });
}

function requiredEnvironmentValue(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) {
    throw new Error(`${name} is required for real AWS onboarding tests.`);
  }
  return value;
}

export function readAWSOnboardingSecrets(): AWSOnboardingSecrets {
  return {
    accessKeyId: requiredEnvironmentValue('AWS_ACCESS_KEY_ID'),
    secretAccessKey: requiredEnvironmentValue('AWS_SECRET_ACCESS_KEY'),
    ...(process.env.AWS_SESSION_TOKEN
      ? { sessionToken: process.env.AWS_SESSION_TOKEN }
      : {}),
  };
}

export function managedCredentialName(
  suite: AWSOnboardingUserSuite,
  numericToken: string,
): string {
  if (!/^[0-9]+$/.test(numericToken)) {
    throw new Error('Managed AWS credential tokens must be numeric.');
  }
  return `${MANAGED_USER_PREFIX[suite]}-${numericToken}`;
}

function managedUserPattern(suite: AWSOnboardingUserSuite): RegExp {
  return new RegExp(`^anycloud-${MANAGED_USER_PREFIX[suite]}-([0-9]+)$`);
}

function hasExpectedTags(
  userName: string,
  tags: AWSUserTag[] | undefined,
): boolean {
  const credentialName = userName.replace(/^anycloud-/, '');
  return (
    !tags?.some((tag) => tag.Key === AWS_INVOCATION_TAG) &&
    tags?.some(
      (tag) => tag.Key === MANAGED_TAG_KEY && tag.Value === MANAGED_TAG_VALUE,
    ) === true &&
    tags.some(
      (tag) =>
        tag.Key === CREDENTIAL_NAME_TAG_KEY && tag.Value === credentialName,
    )
  );
}

export function selectManagedAWSUsers(
  users: ListedAWSUser[],
  tagsByUserName: ReadonlyMap<string, AWSUserTag[]>,
  bootstrapArn: string,
  suite: AWSOnboardingUserSuite,
): ListedAWSUser[] {
  const pattern = managedUserPattern(suite);
  return users.filter(
    (user) =>
      user.Arn !== bootstrapArn &&
      pattern.test(user.UserName) &&
      hasExpectedTags(user.UserName, tagsByUserName.get(user.UserName)),
  );
}

export async function runAdminAWS(
  context: Pick<BootstrapAWSContext, 'environment' | 'run'>,
  args: string[],
): Promise<string> {
  if (context.run) return context.run(args, context.environment);
  const { stdout } = await execFileAsync('aws', args, {
    env: context.environment,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

export async function createBootstrapAWSContext(
  secrets = readAWSOnboardingSecrets(),
): Promise<BootstrapAWSContext> {
  const rootDir = await mkdtemp(join(tmpdir(), 'anycloud-aws-bootstrap-'));
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    AWS_ACCESS_KEY_ID: secrets.accessKeyId,
    AWS_SECRET_ACCESS_KEY: secrets.secretAccessKey,
    AWS_CONFIG_FILE: join(rootDir, 'config'),
    AWS_SHARED_CREDENTIALS_FILE: join(rootDir, 'credentials'),
    AWS_EC2_METADATA_DISABLED: 'true',
    AWS_PAGER: '',
  };
  if (secrets.sessionToken) {
    environment.AWS_SESSION_TOKEN = secrets.sessionToken;
  } else {
    delete environment.AWS_SESSION_TOKEN;
  }
  const context: BootstrapAWSContext = {
    bootstrapArn: '',
    environment,
    rootDir,
  };
  try {
    const caller = JSON.parse(
      await runAdminAWS(context, [
        'sts',
        'get-caller-identity',
        '--output',
        'json',
      ]),
    ) as { Arn?: string };
    if (!caller.Arn) throw new Error('AWS did not return the bootstrap ARN.');
    context.bootstrapArn = caller.Arn;
    return context;
  } catch (error) {
    await rm(rootDir, { recursive: true, force: true });
    throw error;
  }
}

export async function disposeBootstrapAWSContext(
  context: BootstrapAWSContext,
): Promise<void> {
  await rm(context.rootDir, { recursive: true, force: true });
}

export async function createAWSImportFixture(
  context: BootstrapAWSContext,
  credentialName: string,
  suite: AWSOnboardingUserSuite,
  /**
   * The user gets the published AnycloudAccess policy, as `--generate`
   * grants it. `grants: false` creates a user with no policy, so the caller
   * owns its readiness. `restrictedBuckets` grants the restricted pilot
   * policy scoped to those buckets instead.
   */
  {
    grants = true,
    restrictedBuckets,
  }: {
    readonly grants?: boolean;
    readonly restrictedBuckets?: readonly string[];
  } = {},
): Promise<AWSImportFixture> {
  const userName = `anycloud-${credentialName}`;
  if (!managedUserPattern(suite).test(userName)) {
    throw new Error(`Refusing to create unmanaged AWS user ${userName}.`);
  }
  try {
    const createUserResult = JSON.parse(
      await runAdminAWS(context, [
        'iam',
        'create-user',
        '--user-name',
        userName,
        '--tags',
        `Key=${MANAGED_TAG_KEY},Value=${MANAGED_TAG_VALUE}`,
        `Key=${CREDENTIAL_NAME_TAG_KEY},Value=${credentialName}`,
        '--output',
        'json',
      ]),
    ) as { User?: Partial<ListedAWSUser> };
    const createdUser = createUserResult.User;
    if (createdUser?.UserName !== userName || !createdUser.Arn) {
      throw new Error('AWS did not return the test user identity.');
    }
    const expectedUser: ListedAWSUser = {
      UserName: createdUser.UserName,
      Arn: createdUser.Arn,
    };
    if (grants)
      await runAdminAWS(context, [
        'iam',
        'put-user-policy',
        '--user-name',
        userName,
        '--policy-name',
        restrictedBuckets
          ? RESTRICTED_PILOT_POLICY_NAME
          : AWS_GENERATION_POLICY_NAME,
        '--policy-document',
        JSON.stringify(
          restrictedBuckets
            ? restrictedPilotPolicy(restrictedBuckets)
            : anycloudAccess,
        ),
      ]);
    const result = JSON.parse(
      await runAdminAWS(context, [
        'iam',
        'create-access-key',
        '--user-name',
        userName,
        '--output',
        'json',
      ]),
    ) as {
      AccessKey?: { AccessKeyId?: string; SecretAccessKey?: string };
    };
    const accessKeyId = result.AccessKey?.AccessKeyId;
    const secretAccessKey = result.AccessKey?.SecretAccessKey;
    if (!accessKeyId || !secretAccessKey) {
      throw new Error('AWS did not return a complete test import key.');
    }

    const environment: NodeJS.ProcessEnv = {
      ...context.environment,
      AWS_ACCESS_KEY_ID: accessKeyId,
      AWS_SECRET_ACCESS_KEY: secretAccessKey,
      AWS_EC2_METADATA_DISABLED: 'true',
    };
    delete environment.AWS_SESSION_TOKEN;
    if (grants)
      await waitForAWSImportFixtureReadiness(
        context,
        environment,
        expectedUser,
        Boolean(restrictedBuckets),
      );
    return { userName, accessKeyId, secretAccessKey };
  } catch (error) {
    try {
      await cleanupAWSOnboardingUser(context, userName, suite);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'AWS import fixture creation and automatic cleanup both failed',
      );
    }
    throw error;
  }
}

export async function waitForAWSImportFixtureReadiness(
  context: BootstrapAWSContext,
  environment: NodeJS.ProcessEnv,
  expectedUser: ListedAWSUser,
  restricted = false,
): Promise<void> {
  const now = context.now ?? Date.now;
  const startedAt = now();
  const validationContext = { ...context, environment };
  let attempts = 0;
  let lastFailure: AWSFixtureReadinessError | undefined;

  try {
    await retryUntilDeadline(
      async () => {
        try {
          attempts += 1;
          const callerOutput = await runAWSReadinessOperation(
            validationContext,
            'STS',
            ['sts', 'get-caller-identity', '--output', 'json'],
          );
          let caller: { Arn?: string };
          try {
            caller = JSON.parse(callerOutput) as { Arn?: string };
          } catch (cause) {
            throw nonRetryableReadinessFailure(
              'STS',
              'AWS returned malformed caller identity JSON.',
              cause,
            );
          }
          if (caller.Arn !== expectedUser.Arn) {
            throw nonRetryableReadinessFailure(
              'STS',
              `AWS import fixture resolved ${caller.Arn ?? '(no ARN)'} instead of ${expectedUser.Arn}.`,
            );
          }

          // STS GetCallerIdentity requires no permissions, so readiness is
          // proven with EC2 in a region both policies allow, plus S3 for
          // AnycloudAccess. The restricted pilot key cannot list buckets.
          await runAWSReadinessOperation(
            {
              ...validationContext,
              environment: {
                ...environment,
                AWS_DEFAULT_REGION: RESTRICTED_PILOT_REGIONS[0],
              },
            },
            'EC2',
            ['ec2', 'describe-vpcs', '--max-results', '5', '--output', 'json'],
          );
          if (!restricted)
            await runAWSReadinessOperation(validationContext, 'S3', [
              's3api',
              'list-buckets',
              '--max-items',
              '1',
              '--output',
              'json',
            ]);
        } catch (error) {
          if (error instanceof AWSFixtureReadinessError) {
            lastFailure = error;
          }
          throw error;
        }
      },
      {
        deadline: startedAt + AWS_IMPORT_READINESS_TIMEOUT_MS,
        initialDelayMs: 500,
        maxDelayMs: 15_000,
        now,
        random: context.random,
        wait: context.wait,
        shouldRetry: (error) =>
          error instanceof AWSFixtureReadinessError && error.retryable,
      },
    );
  } catch (cause) {
    const elapsedMs = Math.max(0, now() - startedAt);
    const attemptLabel = attempts === 1 ? 'attempt' : 'attempts';
    const failure =
      cause instanceof AWSFixtureReadinessError ? cause : lastFailure;
    const finalFailure = failure
      ? ` Final ${failure.operation} error: ${failure.message}`
      : ` Final error: ${awsFailureDiagnostic(cause)}`;
    throw new Error(
      `The test-owned AWS import key did not become usable after ${attempts} readiness ${attemptLabel} over ${elapsedMs}ms.${finalFailure}`,
      { cause },
    );
  }
}

async function listUsers(
  context: BootstrapAWSContext,
): Promise<ListedAWSUser[]> {
  const result = JSON.parse(
    await runAdminAWS(context, ['iam', 'list-users', '--output', 'json']),
  ) as { Users?: ListedAWSUser[] };
  return result.Users ?? [];
}

async function listUserTags(
  context: BootstrapAWSContext,
  userName: string,
): Promise<AWSUserTag[]> {
  const result = JSON.parse(
    await runAdminAWS(context, [
      'iam',
      'list-user-tags',
      '--user-name',
      userName,
      '--output',
      'json',
    ]),
  ) as { Tags?: AWSUserTag[] };
  return result.Tags ?? [];
}

async function deleteManagedAWSUser(
  context: BootstrapAWSContext,
  user: ListedAWSUser,
  generated = false,
): Promise<void> {
  // Only the onboarding sweep deletes a generated user, after its run's guarded
  // teardown; a numeric fixture name never carries the invocation marker.
  if (
    (await listUserTags(context, user.UserName)).some(
      (tag) => tag.Key === AWS_INVOCATION_TAG,
    ) !== generated
  ) {
    throw new Error(
      `Refusing to delete ${user.UserName}: its generation invocation marker changed.`,
    );
  }
  const failures: string[] = [];
  const runCleanup = async (args: string[]): Promise<string | undefined> => {
    const run = () => runAdminAWS(context, args);
    try {
      return await (context.cleanupCall?.(run) ?? run());
    } catch (error) {
      const message = (error as Error).message;
      if (!/NoSuchEntity|not found|does not exist/i.test(message)) {
        failures.push(`${args.slice(0, 2).join(' ')}: ${message}`);
      }
      return undefined;
    }
  };

  const accessKeyOutput = await runCleanup([
    'iam',
    'list-access-keys',
    '--user-name',
    user.UserName,
    '--output',
    'json',
  ]);
  const accessKeys = accessKeyOutput
    ? (JSON.parse(accessKeyOutput) as {
        AccessKeyMetadata?: Array<{ AccessKeyId?: string }>;
      })
    : {};
  for (const key of accessKeys.AccessKeyMetadata ?? []) {
    if (!key.AccessKeyId) continue;
    await runCleanup([
      'iam',
      'delete-access-key',
      '--user-name',
      user.UserName,
      '--access-key-id',
      key.AccessKeyId,
    ]);
  }

  const inlinePolicyOutput = await runCleanup([
    'iam',
    'list-user-policies',
    '--user-name',
    user.UserName,
    '--output',
    'json',
  ]);
  const inlinePolicies = inlinePolicyOutput
    ? (JSON.parse(inlinePolicyOutput) as { PolicyNames?: string[] })
    : {};
  for (const policyName of inlinePolicies.PolicyNames ?? []) {
    await runCleanup([
      'iam',
      'delete-user-policy',
      '--user-name',
      user.UserName,
      '--policy-name',
      policyName,
    ]);
  }

  const managedPolicyOutput = await runCleanup([
    'iam',
    'list-attached-user-policies',
    '--user-name',
    user.UserName,
    '--output',
    'json',
  ]);
  const managedPolicies = managedPolicyOutput
    ? (JSON.parse(managedPolicyOutput) as {
        AttachedPolicies?: Array<{ PolicyArn?: string }>;
      })
    : {};
  for (const policy of managedPolicies.AttachedPolicies ?? []) {
    if (!policy.PolicyArn) continue;
    await runCleanup([
      'iam',
      'detach-user-policy',
      '--user-name',
      user.UserName,
      '--policy-arn',
      policy.PolicyArn,
    ]);
  }

  await runCleanup(['iam', 'delete-user', '--user-name', user.UserName]);
  if (failures.length > 0) {
    throw new Error(
      `AWS cleanup for ${user.UserName} had ${failures.length} failure(s): ${failures.join('; ')}`,
    );
  }
}

export async function cleanupAWSOnboardingUser(
  context: BootstrapAWSContext,
  userName: string,
  suite: AWSOnboardingUserSuite,
): Promise<void> {
  if (!managedUserPattern(suite).test(userName)) {
    throw new Error(`Refusing to clean unmanaged AWS user ${userName}.`);
  }
  const user = (await listUsers(context)).find(
    (candidate) => candidate.UserName === userName,
  );
  if (!user) return;
  let userTags: AWSUserTag[];
  try {
    userTags = await listUserTags(context, userName);
  } catch (error) {
    if (
      /NoSuchEntity|not found|does not exist/i.test((error as Error).message)
    ) {
      return;
    }
    throw error;
  }
  const tags = new Map([[userName, userTags]]);
  if (
    selectManagedAWSUsers([user], tags, context.bootstrapArn, suite).length !==
    1
  ) {
    throw new Error(
      `Refusing to delete ${userName}: it is not owned by the AWS onboarding E2E.`,
    );
  }
  await deleteManagedAWSUser(context, user);
}

export async function cleanupAWSOnboardingBucket(
  context: BootstrapAWSContext,
  bucketName: string,
): Promise<void> {
  if (!ONBOARDING_SMOKE_BUCKET_PATTERN.test(bucketName)) {
    throw new Error(`Refusing to clean unmanaged AWS bucket ${bucketName}.`);
  }
  try {
    await runAdminAWS(context, [
      's3api',
      'delete-bucket',
      '--bucket',
      bucketName,
      '--region',
      'us-east-1',
    ]);
  } catch (error) {
    if (!/NoSuchBucket|Not Found|\b404\b/i.test((error as Error).message)) {
      throw error;
    }
  }
  try {
    await runAdminAWS(context, [
      's3api',
      'head-bucket',
      '--bucket',
      bucketName,
      '--region',
      'us-east-1',
    ]);
  } catch (error) {
    if (/NoSuchBucket|Not Found|\b404\b/i.test((error as Error).message)) {
      return;
    }
    throw error;
  }
  throw new Error(`AWS onboarding bucket ${bucketName} still exists.`);
}

export async function sweepAWSOnboardingUsers(
  context: BootstrapAWSContext,
  suite: AWSOnboardingUserSuite,
): Promise<number> {
  // Both onboarding jobs share one concurrency group, so no run is mid-generation.
  const candidates = (await listUsers(context)).filter(
    (user) =>
      managedUserPattern(suite).test(user.UserName) ||
      (suite === 'onboarding' && GENERATED_USER_PATTERN.test(user.UserName)),
  );
  const tags = new Map<string, AWSUserTag[]>();
  const failures: string[] = [];
  for (const user of candidates) {
    try {
      tags.set(user.UserName, await listUserTags(context, user.UserName));
    } catch (error) {
      const message = (error as Error).message;
      if (!/NoSuchEntity|not found|does not exist/i.test(message)) {
        failures.push(`tag check for ${user.UserName}: ${message}`);
      }
    }
  }
  const managed = selectManagedAWSUsers(
    candidates,
    tags,
    context.bootstrapArn,
    suite,
  );
  const generated = candidates.filter(
    (user) =>
      user.Arn !== context.bootstrapArn &&
      GENERATED_USER_PATTERN.test(user.UserName) &&
      tags
        .get(user.UserName)
        ?.some(
          (tag) =>
            tag.Key === AWS_INVOCATION_TAG &&
            INVOCATION_ID_PATTERN.test(tag.Value),
        ),
  );
  for (const user of [...managed, ...generated]) {
    try {
      await deleteManagedAWSUser(context, user, generated.includes(user));
    } catch (error) {
      failures.push((error as Error).message);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `AWS ${suite} sweep had ${failures.length} failure(s): ${failures.join('; ')}`,
    );
  }
  return managed.length + generated.length;
}

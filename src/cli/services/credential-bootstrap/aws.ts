import { randomUUID } from 'crypto';
import { z } from 'zod';
import { errorMessage } from '../../../shared/log-diagnostics.js';
import { AWS_GENERATION_POLICY_NAME } from '../../../shared/permission-denied.js';
import { AWSCliError, runAWSCLI, type AWSOperator } from './aws-cli-runner.js';
import anycloudAccess from '../../../shared/cloud-policies/aws-anycloud-access.json' with { type: 'json' };

const callerSchema = z.object({
  Account: z.string().regex(/^\d{12}$/),
  Arn: z.string().min(1),
  UserId: z.string().min(1),
});
const userSchema = z.object({
  UserName: z.string().min(1),
  UserId: z.string().min(1),
  Arn: z.string().min(1),
});
const tagsSchema = z.object({
  Tags: z.array(z.object({ Key: z.string(), Value: z.string() })),
});
const keySchema = z.object({
  AccessKey: z.object({
    UserName: z.string().min(1),
    AccessKeyId: z.string().min(1),
    SecretAccessKey: z.string().min(1),
  }),
});

export const AWS_INVOCATION_TAG = 'anycloud:generation-id';

export interface AWSGenerationPreview {
  operator: AWSOperator;
  caller: z.infer<typeof callerSchema>;
  userName: string;
}

/** Non-secret, invocation-local evidence; a later name lookup cannot recreate it. */
export interface AWSGenerationOwnership {
  accountId: string;
  userName: string;
  userId: string;
  invocationId: string;
  accessKeyIds: string[];
  inlinePolicyNames: string[];
}

async function decode<T>(
  operator: AWSOperator,
  args: string[],
  schema: z.ZodType<T>,
): Promise<T> {
  const output = await runAWSCLI(operator, args);
  try {
    return schema.parse(JSON.parse(output));
  } catch {
    // Zod errors and malformed JSON may include the secret response.
    throw new AWSCliError(
      'AWS CLI returned invalid output; the request may have succeeded.',
    );
  }
}

export function validateAWSGenerationName(credentialName: string): string {
  const userName = `anycloud-${credentialName}`;
  if (!credentialName || !/^[A-Za-z0-9_+=,.@-]{1,64}$/.test(userName)) {
    throw new Error(
      'AWS generation requires a credential name of 1–55 letters, digits, or _+=,.@- characters.',
    );
  }
  return userName;
}

export async function getAWSGenerationPreview(
  operator: AWSOperator,
  credentialName: string,
  expectedAccountId?: string,
): Promise<AWSGenerationPreview> {
  const userName = validateAWSGenerationName(credentialName);
  if (expectedAccountId !== undefined && !/^\d{12}$/.test(expectedAccountId)) {
    throw new Error('AWS account ID must contain exactly 12 digits.');
  }
  const caller = await decode(
    operator,
    ['sts', 'get-caller-identity'],
    callerSchema,
  );
  if (expectedAccountId && caller.Account !== expectedAccountId) {
    throw new Error(
      `AWS profile ${operator.profile} belongs to account ${caller.Account}, not selected account ${expectedAccountId}.`,
    );
  }
  if (
    !['aws', 'aws-us-gov', 'aws-cn'].includes(caller.Arn.split(':')[1]) ||
    caller.Arn.split(':')[4] !== caller.Account
  ) {
    throw new Error('AWS returned an inconsistent operator identity.');
  }
  return { operator, caller, userName };
}

async function getUser(operator: AWSOperator, userName: string) {
  try {
    return (
      await decode(
        operator,
        ['iam', 'get-user', '--user-name', userName],
        z.object({ User: userSchema }),
      )
    ).User;
  } catch (error) {
    if (error instanceof AWSCliError && error.code === 'NoSuchEntity')
      return undefined;
    throw error;
  }
}

export function describeAWSGeneration(owned: AWSGenerationOwnership): string {
  return `AWS account ${owned.accountId}, user ${owned.userName} (UserId ${owned.userId}, invocation ${owned.invocationId})`;
}

async function assertOwnedUser(
  operator: AWSOperator,
  owned: AWSGenerationOwnership,
): Promise<void> {
  if (
    !owned.userId ||
    !owned.invocationId ||
    !/^\d{12}$/.test(owned.accountId)
  ) {
    throw new Error(
      'Missing AWS creation-time ownership record; manual reconciliation is required.',
    );
  }
  const caller = await decode(
    operator,
    ['sts', 'get-caller-identity'],
    callerSchema,
  );
  if (caller.Account !== owned.accountId) {
    throw new Error(
      'AWS account changed; refusing to mutate the generated identity.',
    );
  }
  const user = await getUser(operator, owned.userName);
  if (
    !user ||
    user.UserId !== owned.userId ||
    user.Arn.split(':')[4] !== owned.accountId
  ) {
    throw new Error(
      'AWS user ownership changed or could not be verified; manual reconciliation is required.',
    );
  }
  const { Tags } = await decode(
    operator,
    ['iam', 'list-user-tags', '--user-name', owned.userName],
    tagsSchema,
  );
  if (
    !Tags.some(
      (tag) =>
        tag.Key === AWS_INVOCATION_TAG && tag.Value === owned.invocationId,
    )
  ) {
    throw new Error(
      'AWS invocation marker does not match; refusing to mutate the generated identity.',
    );
  }
}

/** Delete only resources returned to this invocation, checking ownership before each mutation. */
export async function cleanupAWSGeneration(
  operator: AWSOperator,
  owned: AWSGenerationOwnership,
): Promise<void> {
  const mutate = async (args: string[]) => {
    try {
      await assertOwnedUser(operator, owned);
      await runAWSCLI(operator, [
        'iam',
        ...args,
        '--user-name',
        owned.userName,
      ]).catch((error: unknown) => {
        // Each delete is idempotent, so an absent resource is already removed.
        if (!(error instanceof AWSCliError && error.code === 'NoSuchEntity'))
          throw error;
      });
    } catch (error) {
      throw new Error(
        `${errorMessage(error)} Inspect ${describeAWSGeneration(owned)}, known keys ${owned.accessKeyIds.join(', ') || 'none'} for manual reconciliation.`,
      );
    }
  };
  for (const key of owned.accessKeyIds)
    await mutate(['delete-access-key', '--access-key-id', key]);
  for (const policy of owned.inlinePolicyNames)
    await mutate(['delete-user-policy', '--policy-name', policy]);
  // IAM does not offer conditional deletion by UserId. The guard detects observed
  // replacement; it is not a lock against concurrent administrator mutation.
  await mutate(['delete-user']);
}

export async function generateAWSCredentials(
  preview: AWSGenerationPreview,
): Promise<{
  accessKeyId: string;
  secretAccessKey: string;
  ownership: AWSGenerationOwnership;
  cleanup: () => Promise<void>;
}> {
  const { operator, caller, userName } = preview;
  const current = await decode(
    operator,
    ['sts', 'get-caller-identity'],
    callerSchema,
  );
  if (
    current.Account !== caller.Account ||
    current.Arn !== caller.Arn ||
    current.UserId !== caller.UserId
  ) {
    throw new Error(
      'AWS operator changed since the preview; run generation again to confirm the target.',
    );
  }
  if (await getUser(operator, userName)) {
    throw new Error(
      `AWS user ${userName} already exists; select a new credential name.`,
    );
  }
  const invocationId = randomUUID();
  let owned: AWSGenerationOwnership | undefined;
  try {
    const { User } = await decode(
      operator,
      [
        'iam',
        'create-user',
        '--user-name',
        userName,
        '--tags',
        JSON.stringify([{ Key: AWS_INVOCATION_TAG, Value: invocationId }]),
      ],
      z.object({ User: userSchema }),
    );
    if (
      User.UserName !== userName ||
      User.Arn.split(':')[4] !== caller.Account
    ) {
      throw new Error('AWS returned an unexpected created identity.');
    }
    owned = {
      accountId: caller.Account,
      userName,
      userId: User.UserId,
      invocationId,
      accessKeyIds: [],
      inlinePolicyNames: [],
    };
    await assertOwnedUser(operator, owned);
    await runAWSCLI(operator, [
      'iam',
      'put-user-policy',
      '--user-name',
      userName,
      '--policy-name',
      AWS_GENERATION_POLICY_NAME,
      '--policy-document',
      JSON.stringify(anycloudAccess),
    ]);
    owned.inlinePolicyNames.push(AWS_GENERATION_POLICY_NAME);
    await assertOwnedUser(operator, owned);
    const { AccessKey } = await decode(
      operator,
      ['iam', 'create-access-key', '--user-name', userName],
      keySchema,
    );
    if (AccessKey.UserName !== userName)
      throw new Error('AWS returned a key for an unexpected user.');
    owned.accessKeyIds.push(AccessKey.AccessKeyId);
    const ownership = owned;
    return {
      accessKeyId: AccessKey.AccessKeyId,
      secretAccessKey: AccessKey.SecretAccessKey,
      ownership,
      cleanup: () => cleanupAWSGeneration(operator, ownership),
    };
  } catch (error) {
    // Failed IAM writes may have succeeded. Preserve the target rather than
    // replaying a request or guessing key IDs from a later list response.
    const target = owned
      ? describeAWSGeneration(owned)
      : `AWS account ${caller.Account}, user ${userName}, invocation ${invocationId} (UserId unknown)`;
    const detail = errorMessage(error);
    throw Object.assign(
      new Error(
        `${detail} Inspect ${target} for manual reconciliation; resources were retained and no mutation was retried.`,
      ),
      { cause: error },
    );
  }
}

import { execFile } from 'child_process';
import {
  copyFile,
  mkdir,
  readFile,
  writeFile,
  chmod,
  symlink,
} from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import { z } from 'zod';
import {
  awsOperator,
  isTransientAWSCliFailure,
  type AWSOperator,
} from '../../../../src/cli/services/credential-bootstrap/aws-cli-runner.js';
import { retryUntilDeadline } from '../common/deadline-retry.js';
import {
  cleanupAWSGeneration,
  describeAWSGeneration,
  type AWSGenerationOwnership,
} from '../../../../src/cli/services/credential-bootstrap/aws.js';
import type { BootstrapAWSContext } from './admin.js';
import { writeLocalApiToken } from '../../helpers/local-api-token.js';

const ownershipSchema = z.object({
  accountId: z.string().regex(/^\d{12}$/),
  userName: z.string().regex(/^anycloud-onb-gen-[a-f0-9-]+$/),
  userId: z.string().min(1),
  invocationId: z.string().uuid(),
  accessKeyIds: z.array(z.string().min(1)),
  inlinePolicyNames: z.array(z.string().min(1)),
});

/** A read-only IAM check of the generated user; the runner retries none of these. */
export function readAWSGeneratedUser(
  read: () => Promise<string>,
  wait?: (milliseconds: number) => Promise<void>,
): Promise<string> {
  return retryUntilDeadline(read, {
    deadline: Date.now() + 60_000,
    initialDelayMs: 1_000,
    maxDelayMs: 10_000,
    wait,
    shouldRetry: isTransientAWSCliFailure,
  });
}

export async function readAWSGenerationOwnership(
  recordPath: string,
  expected: { accountId: string; userName: string },
): Promise<AWSGenerationOwnership> {
  let owned: AWSGenerationOwnership;
  try {
    owned = ownershipSchema.parse(
      JSON.parse(await readFile(recordPath, 'utf8')),
    );
  } catch {
    throw new Error(
      `Missing valid creation record for AWS account ${expected.accountId}, user ${expected.userName}; reconcile manually. No name-based cleanup is allowed.`,
    );
  }
  if (
    owned.accountId !== expected.accountId ||
    owned.userName !== expected.userName
  ) {
    throw new Error(
      'AWS generation cleanup record belongs to a different invocation target.',
    );
  }
  return owned;
}

/** The test owns the temporary API and must dispose of both sides independently. */
export async function cleanupAWSGenerationFixture(
  fixture: {
    operator: AWSOperator;
    recordPath: string;
    accountId: string;
    userName: string;
  },
  deleteAPICredential: () => Promise<void>,
): Promise<void> {
  // Report non-secret creation evidence before the caller removes its files.
  // A missing record still forbids name-based IAM cleanup.
  const owned = await readAWSGenerationOwnership(fixture.recordPath, fixture);
  const description = describeAWSGeneration(owned);
  console.info(`AWS generation teardown: ${description}`);
  const failures: unknown[] = [];
  try {
    await deleteAPICredential();
  } catch (error) {
    failures.push(error);
  }
  try {
    await cleanupAWSGeneration(fixture.operator, owned);
  } catch (error) {
    failures.push(error);
  }
  if (failures.length) {
    throw new AggregateError(
      failures,
      `AWS generation teardown failed: ${description}`,
    );
  }
}

export async function prepareAWSGenerationFixture(
  root: string,
  bootstrap: BootstrapAWSContext,
  credentialName: string,
): Promise<{
  environment: Record<string, string>;
  operator: AWSOperator;
  recordPath: string;
  accountId: string;
  userName: string;
}> {
  const { stdout } = await promisify(execFile)('which', ['aws']);
  const realAWS = stdout.trim();
  if (!realAWS) throw new Error('AWS CLI is required.');
  const accountId = bootstrap.bootstrapArn.split(':')[4];
  const userName = `anycloud-${credentialName}`;
  if (
    !/^\d{12}$/.test(accountId) ||
    !/^anycloud-onb-gen-[a-f0-9-]+$/.test(userName)
  ) {
    throw new Error('Invalid AWS generation fixture target.');
  }
  const configPath = join(root, 'aws-config');
  const credentialsPath = join(root, 'aws-credentials');
  const recordPath = join(root, 'aws-ownership.json');
  const fakeBin = join(root, 'bin');
  await mkdir(fakeBin);
  const recordingCLI = join(fakeBin, 'recording-cli.mjs');
  await copyFile(
    fileURLToPath(new URL('./recording-cli.mjs', import.meta.url)),
    recordingCLI,
  );
  await chmod(recordingCLI, 0o755);
  await symlink(recordingCLI, join(fakeBin, 'aws'));
  await writeFile(configPath, '[profile operator]\nregion = us-east-1\n', {
    mode: 0o600,
  });
  const env = bootstrap.environment;
  await writeFile(
    credentialsPath,
    `[operator]\naws_access_key_id = ${env.AWS_ACCESS_KEY_ID}\naws_secret_access_key = ${env.AWS_SECRET_ACCESS_KEY}\n${env.AWS_SESSION_TOKEN ? `aws_session_token = ${env.AWS_SESSION_TOKEN}\n` : ''}`,
    { mode: 0o600 },
  );
  const operator = awsOperator('operator', {
    ...env,
    AWS_CONFIG_FILE: configPath,
    AWS_SHARED_CREDENTIALS_FILE: credentialsPath,
  });
  writeLocalApiToken(root);
  const environment: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(operator.environment).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    CI: 'false',
    HOME: root,
    ANYCLOUD_DIR: root,
    PATH: `${fakeBin}:${dirname(process.execPath)}:${operator.environment.PATH ?? ''}`,
    ANYCLOUD_TEST_REAL_AWS: realAWS,
    ANYCLOUD_TEST_AWS_OWNERSHIP: recordPath,
    ANYCLOUD_TEST_AWS_ACCOUNT: accountId,
    ANYCLOUD_TEST_AWS_USER: userName,
  };
  return { environment, operator, recordPath, accountId, userName };
}

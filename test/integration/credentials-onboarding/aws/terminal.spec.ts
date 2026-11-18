import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import {
  expectCleanExit,
  installUnavailableCliShim,
  readRequestBody,
  spawnCliInPty,
  startCredentialApi,
  type CredentialApiFixture,
  WizardDriver,
} from '../harness.js';
import { journeyTitle } from '../journeys.js';
import { AWS_REJECTED_KEY, type AWSStsPersona } from '../personas.js';
import { AWS_GENERATION_POLICY_NAME } from '../../../../src/shared/permission-denied.js';
import anycloudAccess from '../../../../src/shared/cloud-policies/aws-anycloud-access.json' with { type: 'json' };
import { writeLocalApiToken } from '../../helpers/local-api-token.js';
import { childEnv } from '../../helpers/child-env.js';

const API_TOKEN = 'fake-aws-terminal-token';

interface FakeAWSState {
  calls: string[][];
  createdUserName?: string;
  existingUserName?: string;
  lostResponseOn?: string;
  createdUserTags?: Array<{ Key: string; Value: string }>;
  createUserError?: string;
  deletedUserNames?: string[];
  defaultLoggedIn?: boolean;
  ssoLoggedIn?: boolean;
  configured?: boolean;
  readinessIamInvalidClientTokenFailures?: number;
  stsPersona?: AWSStsPersona;
  importedIdentity?: { account: string; arn: string; userId: string };
}

const FAKE_AWS = String.raw`#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const statePath = process.env.FAKE_AWS_STATE;
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
state.calls.push(args);

function finish(value) {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  if (value !== undefined) process.stdout.write(JSON.stringify(value));
  process.exit(0);
}

function fail(message) {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  process.stderr.write(message + '\n');
  process.exit(1);
}

function after(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

if (args.includes('--version')) finish();
if (args[0] === 'configure' && args[1] === 'sso') {
  const awsDir = require('path').join(process.env.HOME, '.aws');
  fs.mkdirSync(awsDir, { recursive: true });
  fs.writeFileSync(
    require('path').join(awsDir, 'config'),
    '[profile sso-dev]\n' +
      'sso_session = terminal\n' +
      'sso_account_id = 123456789012\n' +
      'sso_role_name = Admin\n' +
      'region = us-east-1\n' +
      '\n[sso-session terminal]\n' +
      'sso_start_url = https://example.awsapps.com/start\n' +
      'sso_region = us-east-1\n'
  );
  state.configured = true;
  finish();
}
if (args[0] === 'sso' && args[1] === 'login') {
  state.ssoLoggedIn = true;
  finish();
}
if (args[0] === 'sts' && args[1] === 'get-caller-identity') {
  if (after('--profile')) {
    if (!state.ssoLoggedIn) fail('SSO session expired');
  } else if (state.defaultLoggedIn === false) {
    fail('Unable to locate credentials');
  }
  finish({
    UserId: 'AIDA-BOOTSTRAP',
    Account: '123456789012',
    Arn: 'arn:aws:iam::123456789012:role/Bootstrap',
  });
}
if (args[0] === 'iam' && args[1] === 'create-user') {
  if (state.createUserError) fail(state.createUserError);
  state.createdUserName = after('--user-name');
  state.createdUserTags = JSON.parse(after('--tags'));
  if (state.lostResponseOn === 'create-user') fail('Connection closed after creation SECRET-PTY-GENERATED');
  finish({ User: { UserName: state.createdUserName, UserId: 'AIDA-GENERATED', Arn: 'arn:aws:iam::123456789012:user/' + state.createdUserName } });
}
if (args[0] === 'iam' && args[1] === 'get-user') {
  const userName = state.createdUserName || state.existingUserName;
  if (!userName) fail('An error occurred (NoSuchEntity) when calling the GetUser operation: no user');
  finish({ User: { UserName: userName, UserId: 'AIDA-GENERATED', Arn: 'arn:aws:iam::123456789012:user/' + userName } });
}
if (
  args[0] === 'iam' &&
  (args[1] === 'attach-user-policy' || args[1] === 'put-user-policy')
) finish({});
if (args[0] === 'iam' && args[1] === 'create-access-key') {
  if (state.lostResponseOn === 'create-access-key') fail('Connection closed after key creation SECRET-PTY-GENERATED');
  finish({
    AccessKey: {
      UserName: state.createdUserName,
      AccessKeyId: 'AKIA-PTY-GENERATED',
      SecretAccessKey: 'SECRET-PTY-GENERATED',
    },
  });
}
if (args[0] === 'iam' && args[1] === 'list-user-tags') {
  finish({ Tags: state.createdUserTags || [] });
}
if (args[0] === 'iam' && args[1] === 'list-access-keys') {
  finish(['AKIA-PTY-GENERATED']);
}
if (
  args[0] === 'iam' &&
  [
    'delete-access-key',
    'delete-user-policy',
    'detach-user-policy',
  ].includes(args[1])
) finish({});
if (args[0] === 'iam' && args[1] === 'delete-user') {
  state.deletedUserNames = state.deletedUserNames || [];
  state.deletedUserNames.push(after('--user-name'));
  finish({});
}
process.stderr.write('Unhandled fake aws command: ' + args.join(' ') + '\n');
fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
process.exit(1);
`;

let suiteRoot = '';
let api: CredentialApiFixture;
let readinessServer: ReturnType<typeof createServer>;
let readinessEndpoint = '';
let activeAWSStatePath: string | undefined;
let activeReadinessCalls: string[] | undefined;

function sendXml(response: ServerResponse, body: string): void {
  response.writeHead(200, { 'content-type': 'application/xml' });
  response.end(body);
}

async function handleReadinessRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    const authorization = request.headers.authorization ?? '';
    const accessKeyId = authorization.match(/Credential=([^/]+)\//)?.[1];
    if (!activeAWSStatePath || !activeReadinessCalls) {
      throw new Error('No active fake AWS terminal run');
    }
    const state = JSON.parse(
      await readFile(activeAWSStatePath, 'utf8'),
    ) as FakeAWSState;
    const body = (await readRequestBody(request)).toString('utf8');
    const action = new URLSearchParams(body).get('Action');
    const persona = state.stsPersona;
    if (persona && accessKeyId === persona.accessKeyId) {
      if (request.method !== 'POST' || action !== persona.action) {
        throw new Error(
          `Persona key used for an operation it was not captured from: ${request.method} ${action ?? body}`,
        );
      }
      activeReadinessCalls.push('sts:GetCallerIdentity');
      response.writeHead(persona.httpStatus, {
        'content-type': 'text/xml',
        'x-amzn-requestid': 'terminal-persona',
      });
      response.end(
        `<ErrorResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><Error><Type>Sender</Type><Code>${persona.errorCode}</Code><Message>${persona.errorMessage}</Message></Error><RequestId>terminal-persona</RequestId></ErrorResponse>`,
      );
      return;
    }
    const acceptedAccessKeys = new Set([
      'AKIA-PTY-GENERATED',
      'AKIA-MANUAL-TERMINAL',
      'AKIA-ALPHA-PROFILE',
      'AKIA-BETA-PROFILE',
    ]);
    if (!accessKeyId || !acceptedAccessKeys.has(accessKeyId)) {
      response.writeHead(403, { 'content-type': 'application/xml' });
      response.end(
        '<ErrorResponse><Error><Code>InvalidClientTokenId</Code><Message>Unexpected access key</Message></Error></ErrorResponse>',
      );
      return;
    }
    const generated = accessKeyId === 'AKIA-PTY-GENERATED';
    if (generated && !state.createdUserName) {
      throw new Error('No generated IAM user');
    }

    if (action === 'GetCallerIdentity') {
      activeReadinessCalls.push('sts:GetCallerIdentity');
      const identityName = generated ? state.createdUserName : 'imported';
      const identity = (!generated && state.importedIdentity) || {
        userId: `AIDA-${generated ? 'GENERATED' : 'IMPORTED'}`,
        account: '123456789012',
        arn: `arn:aws:iam::123456789012:user/${identityName}`,
      };
      sendXml(
        response,
        `<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetCallerIdentityResult><UserId>${identity.userId}</UserId><Account>${identity.account}</Account><Arn>${identity.arn}</Arn></GetCallerIdentityResult><ResponseMetadata><RequestId>terminal-sts</RequestId></ResponseMetadata></GetCallerIdentityResponse>`,
      );
      return;
    }
    if (action === 'GetUser') {
      if (!generated)
        throw new Error('Imported keys must only be checked by STS');
      const requestedUser = new URLSearchParams(body).get('UserName');
      if (requestedUser !== state.createdUserName) {
        throw new Error(`Unexpected IAM user ${requestedUser}`);
      }
      activeReadinessCalls.push('iam:GetUser');
      if ((state.readinessIamInvalidClientTokenFailures ?? 0) > 0) {
        state.readinessIamInvalidClientTokenFailures =
          (state.readinessIamInvalidClientTokenFailures ?? 0) - 1;
        await writeFile(activeAWSStatePath, JSON.stringify(state, null, 2));
        response.writeHead(403, {
          'content-type': 'application/xml',
          'x-amzn-requestid': 'terminal-iam-propagation',
        });
        response.end(
          '<ErrorResponse xmlns="https://iam.amazonaws.com/doc/2010-05-08/">' +
            '<Error><Type>Sender</Type><Code>InvalidClientTokenId</Code>' +
            '<Message>The security token included in the request is invalid.</Message></Error>' +
            '<RequestId>terminal-iam-propagation</RequestId></ErrorResponse>',
        );
        return;
      }
      sendXml(
        response,
        `<GetUserResponse xmlns="https://iam.amazonaws.com/doc/2010-05-08/"><GetUserResult><User><Path>/</Path><UserName>${state.createdUserName}</UserName><UserId>AIDA-GENERATED</UserId><Arn>arn:aws:iam::123456789012:user/${state.createdUserName}</Arn><CreateDate>2026-01-01T00:00:00Z</CreateDate></User></GetUserResult><ResponseMetadata><RequestId>terminal-iam</RequestId></ResponseMetadata></GetUserResponse>`,
      );
      return;
    }
    if (request.method === 'GET') {
      activeReadinessCalls.push('s3:ListBuckets');
      sendXml(
        response,
        '<ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Owner><ID>terminal-owner</ID><DisplayName>terminal</DisplayName></Owner><Buckets></Buckets></ListAllMyBucketsResult>',
      );
      return;
    }
    throw new Error(
      `Unhandled SDK readiness request: ${request.method} ${body}`,
    );
  } catch (error) {
    response.writeHead(500, { 'content-type': 'text/plain' });
    response.end(error instanceof Error ? error.message : String(error));
  }
}

const PROVIDERS = ['AWS', 'Azure', 'GCP', 'Lambda'] as const;
const PROFILE_KEYS = {
  accessKeyId: 'AKIA-ALPHA-PROFILE',
  secretAccessKey: 'AWS-ALPHA-PROFILE-SECRET',
};
const ENVIRONMENT_KEYS = {
  AWS_ACCESS_KEY_ID: 'AKIA-BETA-PROFILE',
  AWS_SECRET_ACCESS_KEY: 'AWS-BETA-PROFILE-SECRET',
};
const AWS_SOURCE_PROMPT = 'How would you like to add AWS credentials?';
const DEFAULT_PROFILE_CHOICE = 'AWS profile: default (current)';
const NO_CLI_CHOICES = [
  'Enter existing access keys',
  "I don't have AWS access keys",
] as const;

beforeAll(async () => {
  suiteRoot = await mkdtemp(join(tmpdir(), 'anycloud-aws-terminal-api-'));
  vi.stubEnv('SQLITE_PATH', join(suiteRoot, 'api.db'));
  vi.stubEnv('IS_TEST', 'true');
  vi.stubEnv('CIPHER_KEY', process.env.CIPHER_KEY ?? 'a'.repeat(64));
  readinessServer = createServer((request, response) => {
    void handleReadinessRequest(request, response);
  });
  await new Promise<void>((resolve, reject) => {
    readinessServer.once('error', reject);
    readinessServer.listen(0, '127.0.0.1', () => {
      readinessServer.off('error', reject);
      resolve();
    });
  });
  const readinessAddress = readinessServer.address() as AddressInfo;
  readinessEndpoint = `http://127.0.0.1:${readinessAddress.port}`;
  api = await startCredentialApi(API_TOKEN);
}, 60_000);

afterAll(async () => {
  await api?.close();
  await new Promise<void>((resolve, reject) => {
    readinessServer?.close((error) => (error ? reject(error) : resolve()));
  });
  if (suiteRoot) await rm(suiteRoot, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function createAWSRun(
  initialState: Omit<FakeAWSState, 'calls'> = {},
  options: {
    withCli?: boolean;
    setup?: (childRoot: string) => Promise<void>;
    commandArgs?: string[];
    env?: Record<string, string>;
  } = {},
): Promise<{
  childRoot: string;
  statePath: string;
  run: ReturnType<typeof spawnCliInPty>;
  wizard: WizardDriver;
  readinessCalls: string[];
}> {
  const childRoot = await mkdtemp(join(tmpdir(), 'anycloud-aws-terminal-'));
  const fakeBin = join(childRoot, 'bin');
  const awsPath = join(fakeBin, 'aws');
  const statePath = join(childRoot, 'state.json');
  await mkdir(fakeBin, { recursive: true });
  await writeFile(statePath, JSON.stringify({ calls: [], ...initialState }));
  if (options.withCli !== false) {
    await writeFile(awsPath, FAKE_AWS, { mode: 0o755 });
    await chmod(awsPath, 0o755);
  } else {
    await installUnavailableCliShim(fakeBin, 'aws');
  }
  await options.setup?.(childRoot);
  const readinessCalls: string[] = [];
  activeAWSStatePath = statePath;
  activeReadinessCalls = readinessCalls;

  const env = childEnv();
  for (const name of [
    'ANYCLOUD_CLOUD_PROVIDER',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_PROFILE',
    'AWS_ENDPOINT_URL',
    'AWS_ENDPOINT_URL_STS',
    'AWS_ENDPOINT_URL_IAM',
    'AWS_ENDPOINT_URL_S3',
  ]) {
    delete env[name];
  }
  writeLocalApiToken(childRoot);
  Object.assign(env, {
    CI: 'false',
    HOME: childRoot,
    ANYCLOUD_DIR: childRoot,
    API_URL: api.url,
    GITHUB_TOKEN: API_TOKEN,
    PATH: `${fakeBin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    FAKE_AWS_STATE: statePath,
    AWS_ENDPOINT_URL: readinessEndpoint,
    AWS_REGION: 'us-east-1',
    ...options.env,
  });

  const run = spawnCliInPty(options.commandArgs ?? ['credentials', 'new'], {
    cwd: childRoot,
    env,
  });
  return {
    childRoot,
    statePath,
    run,
    wizard: new WizardDriver(run),
    readinessCalls,
  };
}

function generateCommand(credentialName: string, profile?: string): string[] {
  return [
    'credentials',
    'new',
    credentialName,
    '--provider',
    'aws',
    '--generate',
    ...(profile ? ['--profile', profile, '--account-id', '123456789012'] : []),
  ];
}

async function disposeAWSRun(
  childRoot: string,
  run: ReturnType<typeof spawnCliInPty>,
  credentialName?: string,
): Promise<void> {
  try {
    run.pty.kill();
  } catch {
    // It already exited.
  }
  if (credentialName) {
    await api.deleteCredential(credentialName).catch(() => undefined);
  }
  await rm(childRoot, { recursive: true, force: true });
}

async function seedSSOProfiles(
  childRoot: string,
  profiles: string[],
): Promise<void> {
  const awsDir = join(childRoot, '.aws');
  await mkdir(awsDir, { recursive: true });
  await writeFile(
    join(awsDir, 'config'),
    profiles
      .map(
        (profile, index) => `[profile ${profile}]
sso_session = terminal-${index}
sso_account_id = 12345678901${index}
sso_role_name = Admin
region = us-east-1

[sso-session terminal-${index}]
sso_start_url = https://example.awsapps.com/start
sso_region = us-east-1
`,
      )
      .join('\n'),
  );
}

async function seedStaticAWSProfile(childRoot: string): Promise<void> {
  const awsDir = join(childRoot, '.aws');
  await mkdir(awsDir, { recursive: true });
  await writeFile(
    join(awsDir, 'credentials'),
    `[default]\naws_access_key_id = ${PROFILE_KEYS.accessKeyId}\naws_secret_access_key = ${PROFILE_KEYS.secretAccessKey}\n`,
    { mode: 0o600 },
  );
}

describe('AWS credentials onboarding terminal', () => {
  it.each([
    { kind: 'http', status: 422, retained: false },
    { kind: 'malformed-before-commit', retained: true },
    { kind: 'disconnect-after-commit', retained: true },
  ] as const)(
    '0038/S1 0038/S2 keeps AWS lease semantics after $kind',
    async (fault) => {
      const credentialName = `save-${Date.now()}`;
      api.queueSaveFault(fault);
      const { childRoot, statePath, run, wizard } = await createAWSRun(
        { ssoLoggedIn: true },
        { commandArgs: generateCommand(credentialName, 'operator') },
      );
      try {
        expect((await expectCleanExit(run.exit)).exitCode).toBe(
          fault.kind === 'disconnect-after-commit' ? 0 : 1,
        );
        const state = JSON.parse(
          await readFile(statePath, 'utf8'),
        ) as FakeAWSState;
        expect(state.deletedUserNames ?? []).toEqual(
          fault.retained ? [] : [`anycloud-${credentialName}`],
        );
        expect(await api.credentialExists(credentialName)).toBe(
          fault.kind === 'disconnect-after-commit',
        );
        if (fault.kind === 'malformed-before-commit')
          expect(run.output()).toContain(
            'retained for safe manual reconciliation',
          );
        wizard.assertSecretNotPresent('SECRET-PTY-GENERATED');
      } finally {
        await disposeAWSRun(childRoot, run, credentialName);
      }
    },
  );

  it(journeyTitle('aws.generation-target-required'), async () => {
    const credentialName = `rejected-${Date.now()}`;
    const { childRoot, statePath, run } = await createAWSRun(
      {},
      { commandArgs: generateCommand(credentialName) },
    );
    try {
      expect((await expectCleanExit(run.exit)).exitCode).toBe(1);
      expect(run.output()).toContain(
        'AWS --generate requires --profile and --account-id',
      );
      expect(await api.credentialExists(credentialName)).toBe(false);
      const state = JSON.parse(
        await readFile(statePath, 'utf8'),
      ) as FakeAWSState;
      expect(state.calls).toEqual([]);
    } finally {
      await disposeAWSRun(childRoot, run, credentialName);
    }
  });

  it('0038/S2 previews the selected operator and grants, then saves only after interactive consent', async () => {
    const credentialName = `generated-${Date.now()}`;
    const { childRoot, statePath, run, wizard, readinessCalls } =
      await createAWSRun(
        { ssoLoggedIn: true },
        {
          commandArgs: ['credentials', 'new', '--account-id', '123456789012'],
          setup: async (root) => {
            await seedStaticAWSProfile(root);
            await seedSSOProfiles(root, ['operator']);
          },
          env: ENVIRONMENT_KEYS,
        },
      );
    run.registerSecret('SECRET-PTY-GENERATED');
    try {
      await wizard.enterText('Name for this credential set:', credentialName);
      await wizard.selectChoice('Select cloud provider:', 'AWS', PROVIDERS);
      await wizard.selectChoice(
        'How would you like to add AWS credentials?',
        'Create an IAM user with AWS CLI',
        [
          'Use access keys from environment',
          DEFAULT_PROFILE_CHOICE,
          'Enter existing access keys',
          'Create an IAM user with AWS CLI',
        ],
      );
      // SSO profiles cannot be imported but can run the operator AWS CLI.
      await wizard.selectChoice('AWS operator profile:', 'operator', [
        'default (current)',
        'operator',
      ]);
      await run.waitFor('Create these AWS credentials?');
      const before = JSON.parse(
        await readFile(statePath, 'utf8'),
      ) as FakeAWSState;
      expect(before.calls.some((args) => args[0] === 'iam')).toBe(false);
      expect(run.output()).toContain('(profile operator)');
      expect(run.output()).toContain('123456789012');
      // Enter accepts the default Yes after the preview.
      run.pty.write('\r');
      await wizard.expectSuccess(credentialName);
      const generatedOutput = run.output();
      const creating = generatedOutput.indexOf(
        `Creating IAM user "anycloud-${credentialName}"...`,
      );
      expect(creating).toBeGreaterThan(-1);
      expect(creating).toBeLessThan(
        generatedOutput.indexOf(`user anycloud-${credentialName} (UserId`),
      );
      expect(generatedOutput).toContain(
        `Saving credentials "${credentialName}"...`,
      );
      expect(await api.storedCredential(credentialName)).toMatchObject({
        cloudProvider: 'AWS',
        accessKeyId: 'AKIA-PTY-GENERATED',
        secretAccessKey: 'SECRET-PTY-GENERATED',
      });
      expect(readinessCalls).toEqual([]);
      expect(run.output()).not.toContain('Save these AWS credentials');
      wizard.assertSecretNotPresent('SECRET-PTY-GENERATED');
      // RFC 0047: the generated user gets only the published policy.
      const after = JSON.parse(
        await readFile(statePath, 'utf8'),
      ) as FakeAWSState;
      const grants = after.calls.filter(
        (args) =>
          args[0] === 'iam' &&
          ['attach-user-policy', 'put-user-policy'].includes(args[1]),
      );
      expect(grants).toHaveLength(1);
      const grant = grants[0];
      expect(grant[1]).toBe('put-user-policy');
      expect(grant[grant.indexOf('--policy-name') + 1]).toBe('AnycloudAccess');
      expect(JSON.parse(grant[grant.indexOf('--policy-document') + 1])).toEqual(
        anycloudAccess,
      );
      // The preview printed the policy it grants.
      expect(run.output()).toContain(`Policy: ${AWS_GENERATION_POLICY_NAME}`);
    } finally {
      await disposeAWSRun(childRoot, run, credentialName);
    }
  });

  it('0038/S2 declining consent leaves IAM and saving untouched', async () => {
    const credentialName = `canceled-${Date.now()}`;
    const { childRoot, statePath, run, wizard } = await createAWSRun(
      { ssoLoggedIn: true },
      { setup: (root) => seedSSOProfiles(root, ['operator']) },
    );
    try {
      await wizard.enterText('Name for this credential set:', credentialName);
      await wizard.selectChoice('Select cloud provider:', 'AWS', PROVIDERS);
      await wizard.selectChoice(
        'How would you like to add AWS credentials?',
        'Create an IAM user with AWS CLI',
        ['Enter existing access keys', 'Create an IAM user with AWS CLI'],
      );
      await wizard.selectChoice('AWS operator profile:', 'operator', [
        'operator',
      ]);
      await run.waitFor('Create these AWS credentials?');
      run.pty.write('n\r');
      expect((await expectCleanExit(run.exit)).exitCode).toBe(0);
      expect(await api.credentialExists(credentialName)).toBe(false);
      const state = JSON.parse(
        await readFile(statePath, 'utf8'),
      ) as FakeAWSState;
      expect(state.calls.every((args) => args[0] !== 'iam')).toBe(true);
    } finally {
      await disposeAWSRun(childRoot, run, credentialName);
    }
  });

  it('0038/S2 interactive generation without AWS profiles explains how to add one', async () => {
    const credentialName = `no-operator-${Date.now()}`;
    const { childRoot, statePath, run, wizard } = await createAWSRun({
      ssoLoggedIn: true,
    });
    try {
      await wizard.enterText('Name for this credential set:', credentialName);
      await wizard.selectChoice('Select cloud provider:', 'AWS', PROVIDERS);
      await wizard.selectChoice(
        'How would you like to add AWS credentials?',
        'Create an IAM user with AWS CLI',
        ['Enter existing access keys', 'Create an IAM user with AWS CLI'],
      );
      expect((await expectCleanExit(run.exit)).exitCode).toBe(1);
      expect(run.output()).toContain('No AWS profiles found');
      expect(run.output()).toContain('aws configure --profile <name>');
      expect(run.output()).toContain('aws configure sso');
      expect(run.output()).not.toContain('AWS operator profile:');
      expect(await api.credentialExists(credentialName)).toBe(false);
      const state = JSON.parse(
        await readFile(statePath, 'utf8'),
      ) as FakeAWSState;
      expect(state.calls).toEqual([['--version']]);
    } finally {
      await disposeAWSRun(childRoot, run, credentialName);
    }
  });

  it.each(['create-user', 'create-access-key'])(
    '0038/S2 a lost %s response is retained without replay or secret exposure',
    async (lostResponseOn) => {
      const credentialName = `lost-${Date.now()}`;
      const { childRoot, statePath, run, wizard } = await createAWSRun(
        { ssoLoggedIn: true, lostResponseOn },
        { commandArgs: generateCommand(credentialName, 'operator') },
      );
      try {
        expect((await expectCleanExit(run.exit)).exitCode).toBe(1);
        expect(run.output()).toContain('manual reconciliation');
        expect(await api.credentialExists(credentialName)).toBe(false);
        wizard.assertSecretNotPresent('SECRET-PTY-GENERATED');
        const state = JSON.parse(
          await readFile(statePath, 'utf8'),
        ) as FakeAWSState;
        expect(
          state.calls.filter((args) => args[1] === lostResponseOn),
        ).toHaveLength(1);
        expect(state.deletedUserNames ?? []).toEqual([]);
      } finally {
        await disposeAWSRun(childRoot, run, credentialName);
      }
    },
  );

  it('0038/S2 a name collision cannot adopt or delete another identity', async () => {
    const credentialName = `collision-${Date.now()}`;
    const { childRoot, statePath, run } = await createAWSRun(
      { ssoLoggedIn: true, existingUserName: `anycloud-${credentialName}` },
      { commandArgs: generateCommand(credentialName, 'operator') },
    );
    try {
      expect((await expectCleanExit(run.exit)).exitCode).toBe(1);
      expect(run.output()).toContain('already exists');
      const state = JSON.parse(
        await readFile(statePath, 'utf8'),
      ) as FakeAWSState;
      expect(
        state.calls.some(
          (args) =>
            args[1].startsWith('create') || args[1].startsWith('delete'),
        ),
      ).toBe(false);
      expect(await api.credentialExists(credentialName)).toBe(false);
    } finally {
      await disposeAWSRun(childRoot, run, credentialName);
    }
  });

  it.each([
    { profile: false, choices: NO_CLI_CHOICES },
    { profile: true, choices: [DEFAULT_PROFILE_CHOICE, ...NO_CLI_CHOICES] },
  ])(
    `${journeyTitle('aws.missing-cli-hint')} (static profile: $profile)`,
    async ({ profile, choices }) => {
      const credentialName = `no-cli-${Date.now()}`;
      const { childRoot, run, wizard } = await createAWSRun(
        {},
        { withCli: false, ...(profile ? { setup: seedStaticAWSProfile } : {}) },
      );
      try {
        await wizard.enterText('Name for this credential set:', credentialName);
        await wizard.selectChoice('Select cloud provider:', 'AWS', PROVIDERS);
        await run.waitFor(choices.at(-1)!);
        await wizard.cancelAt(AWS_SOURCE_PROMPT);
        const output = run.output();
        expect(output).toContain('AWS CLI not found');
        expect(output).toContain(
          'curl -fsSL https://awscli.amazonaws.com/v2/install.sh | bash',
        );
        expect(output).not.toContain('sudo');
        expect(output).not.toContain('Create an IAM user with AWS CLI');
        const menu = output.slice(output.indexOf(AWS_SOURCE_PROMPT));
        for (const choice of choices) expect(menu).toContain(choice);
        expect(await api.credentialExists(credentialName)).toBe(false);
      } finally {
        await disposeAWSRun(childRoot, run, credentialName);
      }
    },
  );

  it(journeyTitle('aws.generation-permission-denied'), async () => {
    const credentialName = `denied-${Date.now()}`;
    const { childRoot, statePath, run } = await createAWSRun(
      {
        ssoLoggedIn: true,
        createUserError:
          'An error occurred (AccessDenied) when calling the CreateUser operation: User: arn:aws:iam::123456789012:role/Bootstrap is not authorized to perform: iam:CreateUser',
      },
      { commandArgs: generateCommand(credentialName, 'operator') },
    );
    try {
      expect((await expectCleanExit(run.exit)).exitCode).toBe(1);
      const output = run.output();
      expect(output).toContain('permission denied (AccessDenied)');
      expect(output).toContain('Ask your AWS administrator');
      expect(output).toContain(
        'arn:aws:iam::123456789012:role/Bootstrap (account 123456789012)',
      );
      expect(output).toContain(
        'https://anycloud.sh/reference/cli/credentials#ask-an-administrator',
      );
      expect(await api.credentialExists(credentialName)).toBe(false);
      const state = JSON.parse(
        await readFile(statePath, 'utf8'),
      ) as FakeAWSState;
      expect(state.createdUserName).toBeUndefined();
    } finally {
      await disposeAWSRun(childRoot, run, credentialName);
    }
  });

  it('relays the administrator request as actionRequired when an agent generates', async () => {
    const credentialName = `denied-agent-${Date.now()}`;
    const { childRoot, run } = await createAWSRun(
      {
        ssoLoggedIn: true,
        createUserError:
          'An error occurred (AccessDenied) when calling the CreateUser operation: User: arn:aws:iam::123456789012:role/Bootstrap is not authorized to perform: iam:CreateUser',
      },
      {
        commandArgs: generateCommand(credentialName, 'operator'),
        env: { CLAUDECODE: '1' },
      },
    );
    try {
      expect((await expectCleanExit(run.exit)).exitCode).toBe(1);
      const line = run
        .output()
        .split(/\r?\n/)
        .find((l) => l.includes('actionRequired'));
      expect(JSON.parse(line ?? '')).toMatchObject({
        actionRequired: { code: 'CLOUD_ADMIN_REQUIRED' },
      });
      expect(line).toContain('Ask your AWS administrator');
      expect(await api.credentialExists(credentialName)).toBe(false);
    } finally {
      await disposeAWSRun(childRoot, run, credentialName);
    }
  });

  it(journeyTitle('aws.manual-keys'), async () => {
    const credentialName = `manual-${Date.now()}`;
    const secret = 'AWS-MANUAL-SECRET-TERMINAL';
    const { childRoot, run, wizard, readinessCalls } = await createAWSRun(
      {},
      { withCli: false },
    );
    try {
      await wizard.enterText('Name for this credential set:', credentialName);
      await wizard.selectChoice('Select cloud provider:', 'AWS', PROVIDERS);
      await wizard.selectChoice(
        AWS_SOURCE_PROMPT,
        'Enter existing access keys',
        NO_CLI_CHOICES,
      );
      await wizard.enterText('AWS Access Key ID:', 'AKIA-MANUAL-TERMINAL');
      await wizard.enterSecret('AWS Secret Access Key:', secret);
      await wizard.confirm(
        `Save these AWS credentials as "${credentialName}"?`,
      );
      await wizard.expectSuccess(credentialName);
      expect(readinessCalls).toEqual(['sts:GetCallerIdentity']);
      wizard.assertSecretNotPresent(secret);
      expect(await api.storedCredential(credentialName)).toMatchObject({
        cloudProvider: 'AWS',
        accessKeyId: 'AKIA-MANUAL-TERMINAL',
        secretAccessKey: secret,
      });
    } finally {
      await disposeAWSRun(childRoot, run, credentialName);
    }
  });

  it(journeyTitle('aws.rejected-import'), async () => {
    const credentialName = `rejected-import-${Date.now()}`;
    const secret = AWS_REJECTED_KEY.secretAccessKey;
    const { childRoot, run, wizard, readinessCalls } = await createAWSRun(
      { stsPersona: AWS_REJECTED_KEY },
      { withCli: false },
    );
    try {
      await wizard.enterText('Name for this credential set:', credentialName);
      await wizard.selectChoice('Select cloud provider:', 'AWS', PROVIDERS);
      await wizard.selectChoice(
        AWS_SOURCE_PROMPT,
        'Enter existing access keys',
        NO_CLI_CHOICES,
      );
      await wizard.enterText(
        'AWS Access Key ID:',
        AWS_REJECTED_KEY.accessKeyId,
      );
      await wizard.enterSecret('AWS Secret Access Key:', secret);
      expect((await expectCleanExit(run.exit)).exitCode).toBe(1);
      expect(run.output()).toContain('Failed to add credentials');
      expect(run.output()).toContain(
        'AWS credentials could not be authenticated',
      );
      expect(run.output()).toContain('InvalidClientTokenId');
      expect(run.output()).not.toContain('Save these AWS credentials');
      expect(readinessCalls).toEqual(['sts:GetCallerIdentity']);
      expect(await api.credentialExists(credentialName)).toBe(false);
      wizard.assertSecretNotPresent(secret);
    } finally {
      await disposeAWSRun(childRoot, run, credentialName);
    }
  });

  it(journeyTitle('aws.non-importable-profile'), async () => {
    const credentialName = `non-importable-${Date.now()}`;
    const { childRoot, statePath, run } = await createAWSRun(
      { defaultLoggedIn: false },
      {
        setup: (root) => seedSSOProfiles(root, ['sso-dev']),
        commandArgs: [
          'credentials',
          'new',
          credentialName,
          '--provider',
          'aws',
          '--profile',
          'sso-dev',
        ],
      },
    );
    try {
      expect((await expectCleanExit(run.exit)).exitCode).toBe(1);
      expect(run.output()).toContain(
        'does not contain durable access keys and cannot be imported',
      );
      expect(run.output()).toContain('Use a durable static profile');
      expect(run.output()).not.toContain('--generate --profile');
      expect(await api.credentialExists(credentialName)).toBe(false);
      const state = JSON.parse(
        await readFile(statePath, 'utf8'),
      ) as FakeAWSState;
      expect(state.calls).toEqual([]);
    } finally {
      await disposeAWSRun(childRoot, run, credentialName);
    }
  });

  it(journeyTitle('aws.static-profile-import'), async () => {
    const credentialName = `profiles-${Date.now()}`;
    const betaSecret = 'AWS-BETA-PROFILE-SECRET';
    const { childRoot, statePath, run, wizard, readinessCalls } =
      await createAWSRun(
        { defaultLoggedIn: false },
        {
          env: { AWS_PROFILE: 'beta' },
          setup: async (root) => {
            const awsDir = join(root, '.aws');
            await mkdir(awsDir, { recursive: true });
            await writeFile(
              join(awsDir, 'credentials'),
              `[alpha]
aws_access_key_id = AKIA-ALPHA-PROFILE
aws_secret_access_key = AWS-ALPHA-PROFILE-SECRET

[beta]
aws_access_key_id = AKIA-BETA-PROFILE
aws_secret_access_key = ${betaSecret}
`,
              { mode: 0o600 },
            );
          },
        },
      );
    run.registerSecret(betaSecret);
    try {
      await wizard.enterText('Name for this credential set:', credentialName);
      await wizard.selectChoice('Select cloud provider:', 'AWS', PROVIDERS);
      await wizard.selectChoice(
        AWS_SOURCE_PROMPT,
        'AWS profile: beta (current)',
        [
          'AWS profile: alpha',
          'AWS profile: beta (current)',
          'Enter existing access keys',
          'Create an IAM user with AWS CLI',
        ],
        { initial: 'AWS profile: beta (current)' },
      );
      await run.waitFor(`Save these AWS credentials as "${credentialName}"?`);
      expect(await api.credentialExists(credentialName)).toBe(false);
      await wizard.confirm(
        `Save these AWS credentials as "${credentialName}"?`,
      );
      await wizard.expectSuccess(credentialName);
      expect(readinessCalls).toEqual(['sts:GetCallerIdentity']);
      expect(await api.storedCredential(credentialName)).toMatchObject({
        accessKeyId: 'AKIA-BETA-PROFILE',
        secretAccessKey: betaSecret,
      });
      const state = JSON.parse(
        await readFile(statePath, 'utf8'),
      ) as FakeAWSState;
      expect(state.calls).toEqual([['--version']]);
      wizard.assertSecretNotPresent(betaSecret);
    } finally {
      await disposeAWSRun(childRoot, run, credentialName);
    }
  });

  it(journeyTitle('aws.import-review'), async () => {
    const credentialName = `root-review-${Date.now()}`;
    // Root identity shape reported by a user; account and keys are test values.
    const identity = {
      account: '123456789012',
      arn: 'arn:aws:iam::123456789012:root',
      userId: '123456789012',
    };
    const { childRoot, run, wizard, readinessCalls } = await createAWSRun(
      { importedIdentity: identity },
      { withCli: false, setup: seedStaticAWSProfile },
    );
    run.registerSecret(PROFILE_KEYS.secretAccessKey);
    try {
      await wizard.enterText('Name for this credential set:', credentialName);
      await wizard.selectChoice('Select cloud provider:', 'AWS', PROVIDERS);
      await run.waitFor(AWS_SOURCE_PROMPT);
      expect(readinessCalls).toEqual([]);
      expect(await api.credentialExists(credentialName)).toBe(false);
      await wizard.selectChoice(AWS_SOURCE_PROMPT, DEFAULT_PROFILE_CHOICE, [
        DEFAULT_PROFILE_CHOICE,
        'Enter existing access keys',
      ]);
      const confirmation = `Save these AWS credentials as "${credentialName}"?`;
      await run.waitFor(confirmation);
      expect(readinessCalls).toEqual(['sts:GetCallerIdentity']);
      expect(await api.credentialExists(credentialName)).toBe(false);
      const output = run.output();
      for (const detail of [
        'Source: AWS profile "default"',
        `Account ID: ${identity.account}`,
        `Identity: ${identity.arn}`,
      ]) {
        expect(output).toContain(detail);
        expect(output.indexOf(detail)).toBeLessThan(
          output.indexOf(confirmation),
        );
      }
      // Enter accepts the default Yes after the review.
      run.pty.write('\r');
      await wizard.expectSuccess(credentialName);
      expect(run.output()).toContain(
        `Saving credentials "${credentialName}"...`,
      );
      expect(await api.storedCredential(credentialName)).toMatchObject(
        PROFILE_KEYS,
      );
      wizard.assertSecretNotPresent(PROFILE_KEYS.secretAccessKey);
    } finally {
      await disposeAWSRun(childRoot, run, credentialName);
    }
  });

  it.each([
    { action: 'No', input: 'n\r' },
    { action: 'Ctrl-C', input: '\x03' },
  ])(`${journeyTitle('aws.cancel-import')} ($action)`, async ({ input }) => {
    const credentialName = `cancel-import-${Date.now()}`;
    const { childRoot, run, wizard, readinessCalls } = await createAWSRun(
      {},
      { withCli: false, setup: seedStaticAWSProfile },
    );
    run.registerSecret(PROFILE_KEYS.secretAccessKey);
    try {
      await wizard.enterText('Name for this credential set:', credentialName);
      await wizard.selectChoice('Select cloud provider:', 'AWS', PROVIDERS);
      await wizard.selectChoice(AWS_SOURCE_PROMPT, DEFAULT_PROFILE_CHOICE, [
        DEFAULT_PROFILE_CHOICE,
        'Enter existing access keys',
      ]);
      await run.waitFor(`Save these AWS credentials as "${credentialName}"?`);
      run.pty.write(input);
      expect((await expectCleanExit(run.exit)).exitCode).toBe(0);
      expect(readinessCalls).toEqual(['sts:GetCallerIdentity']);
      expect(await api.credentialExists(credentialName)).toBe(false);
      wizard.assertSecretNotPresent(PROFILE_KEYS.secretAccessKey);
    } finally {
      await disposeAWSRun(childRoot, run, credentialName);
    }
  });

  it('canceling the source picker leaves detected credentials unused', async () => {
    const credentialName = `cancel-source-${Date.now()}`;
    const { childRoot, run, wizard, readinessCalls } = await createAWSRun(
      {},
      { setup: seedStaticAWSProfile, env: ENVIRONMENT_KEYS },
    );
    try {
      await wizard.enterText('Name for this credential set:', credentialName);
      await wizard.selectChoice('Select cloud provider:', 'AWS', PROVIDERS);
      await wizard.cancelAt(AWS_SOURCE_PROMPT);
      expect(readinessCalls).toEqual([]);
      expect(await api.credentialExists(credentialName)).toBe(false);
      wizard.assertSecretNotPresent(PROFILE_KEYS.secretAccessKey);
      wizard.assertSecretNotPresent(ENVIRONMENT_KEYS.AWS_SECRET_ACCESS_KEY);
    } finally {
      await disposeAWSRun(childRoot, run, credentialName);
    }
  });

  it.each([
    {
      choice: 'Use access keys from environment',
      expected: {
        accessKeyId: ENVIRONMENT_KEYS.AWS_ACCESS_KEY_ID,
        secretAccessKey: ENVIRONMENT_KEYS.AWS_SECRET_ACCESS_KEY,
      },
    },
    { choice: DEFAULT_PROFILE_CHOICE, expected: PROFILE_KEYS },
  ])(
    `${journeyTitle('aws.environment-selection')} ($choice)`,
    async ({ choice, expected }) => {
      const credentialName = `environment-${Date.now()}`;
      const { childRoot, run, wizard, readinessCalls } = await createAWSRun(
        {},
        {
          setup: seedStaticAWSProfile,
          env: { ...ENVIRONMENT_KEYS, AWS_PROFILE: 'default' },
        },
      );
      run.registerSecret(PROFILE_KEYS.secretAccessKey);
      run.registerSecret(ENVIRONMENT_KEYS.AWS_SECRET_ACCESS_KEY);
      try {
        await wizard.enterText('Name for this credential set:', credentialName);
        await wizard.selectChoice('Select cloud provider:', 'AWS', PROVIDERS);
        await run.waitFor(AWS_SOURCE_PROMPT);
        expect(readinessCalls).toEqual([]);
        await wizard.selectChoice(AWS_SOURCE_PROMPT, choice, [
          'Use access keys from environment',
          DEFAULT_PROFILE_CHOICE,
          'Enter existing access keys',
          'Create an IAM user with AWS CLI',
        ]);
        await run.waitFor(`Save these AWS credentials as "${credentialName}"?`);
        expect(await api.credentialExists(credentialName)).toBe(false);
        await wizard.confirm(
          `Save these AWS credentials as "${credentialName}"?`,
        );
        await wizard.expectSuccess(credentialName);
        expect(readinessCalls).toEqual(['sts:GetCallerIdentity']);
        expect(await api.storedCredential(credentialName)).toMatchObject(
          expected,
        );
        wizard.assertSecretNotPresent(PROFILE_KEYS.secretAccessKey);
        wizard.assertSecretNotPresent(ENVIRONMENT_KEYS.AWS_SECRET_ACCESS_KEY);
      } finally {
        await disposeAWSRun(childRoot, run, credentialName);
      }
    },
  );

  it('manual entry from the source picker uses fresh keys and requires confirmation', async () => {
    const credentialName = `fresh-manual-${Date.now()}`;
    const secret = 'FRESH-MANUAL-SECRET';
    const { childRoot, run, wizard } = await createAWSRun(
      {},
      { setup: seedStaticAWSProfile, env: ENVIRONMENT_KEYS },
    );
    try {
      await wizard.enterText('Name for this credential set:', credentialName);
      await wizard.selectChoice('Select cloud provider:', 'AWS', PROVIDERS);
      await wizard.selectChoice(
        AWS_SOURCE_PROMPT,
        'Enter existing access keys',
        [
          'Use access keys from environment',
          DEFAULT_PROFILE_CHOICE,
          'Enter existing access keys',
          'Create an IAM user with AWS CLI',
        ],
      );
      await wizard.enterText('AWS Access Key ID:', 'AKIA-MANUAL-TERMINAL');
      await wizard.enterSecret('AWS Secret Access Key:', secret);
      await run.waitFor(`Save these AWS credentials as "${credentialName}"?`);
      expect(run.output()).toContain('Source: Manually entered access keys');
      expect(await api.credentialExists(credentialName)).toBe(false);
      await wizard.confirm(
        `Save these AWS credentials as "${credentialName}"?`,
      );
      await wizard.expectSuccess(credentialName);
      expect(await api.storedCredential(credentialName)).toMatchObject({
        accessKeyId: 'AKIA-MANUAL-TERMINAL',
        secretAccessKey: secret,
      });
      wizard.assertSecretNotPresent(secret);
      wizard.assertSecretNotPresent(ENVIRONMENT_KEYS.AWS_SECRET_ACCESS_KEY);
    } finally {
      await disposeAWSRun(childRoot, run, credentialName);
    }
  });

  it('non-interactive environment imports remain prompt-free', async () => {
    const credentialName = `ci-environment-${Date.now()}`;
    const { childRoot, run, wizard } = await createAWSRun(
      {},
      {
        env: { ...ENVIRONMENT_KEYS, CI: 'true' },
        commandArgs: [
          'credentials',
          'new',
          credentialName,
          '--provider',
          'aws',
        ],
      },
    );
    try {
      await wizard.expectSuccess(credentialName);
      expect((await expectCleanExit(run.exit)).exitCode).toBe(0);
      expect(run.output()).not.toContain(AWS_SOURCE_PROMPT);
      expect(run.output()).not.toContain('Save these AWS credentials');
      expect(await api.storedCredential(credentialName)).toMatchObject({
        accessKeyId: ENVIRONMENT_KEYS.AWS_ACCESS_KEY_ID,
        secretAccessKey: ENVIRONMENT_KEYS.AWS_SECRET_ACCESS_KEY,
      });
      wizard.assertSecretNotPresent(ENVIRONMENT_KEYS.AWS_SECRET_ACCESS_KEY);
    } finally {
      await disposeAWSRun(childRoot, run, credentialName);
    }
  });
});

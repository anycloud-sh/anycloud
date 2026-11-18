import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import {
  expectCleanExit,
  installUnavailableCliShim,
  spawnCliInPty,
  startCredentialApi,
  type CredentialApiFixture,
  WizardDriver,
} from '../harness.js';
import { journeyTitle } from '../journeys.js';
import { writeLocalApiToken } from '../../helpers/local-api-token.js';
import { childEnv } from '../../helpers/child-env.js';

const API_TOKEN = 'fake-gcp-terminal-token';
const PROVIDERS = ['AWS', 'Azure', 'GCP', 'Lambda'] as const;

interface FakeGcloudState {
  loggedIn: boolean;
  activeAccount: string;
  projectId: string;
  projectNumber: string;
  iamBindingFailuresRemaining: number;
  userManagedKeyIds: string[];
  calls: string[][];
  projects?: Array<{
    projectId: string;
    name: string;
    projectNumber: string;
  }>;
  serviceAccountCreateError?: string;
  serviceAccountDescription?: string;
  servicesEnableError?: string;
  createdServiceAccountName?: string;
  createdProjectId?: string;
  createdKeyPath?: string;
}

const FAKE_GCLOUD = String.raw`#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const statePath = process.env.FAKE_GCLOUD_STATE;
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));

function save(code = 0) {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  process.exit(code);
}

function fail(message) {
  process.stderr.write(message + '\n');
  save(1);
}

function prefixed(prefix) {
  const value = args.find((argument) => argument.startsWith(prefix));
  return value ? value.slice(prefix.length) : undefined;
}

state.calls.push(args);

if (args.includes('--version')) {
  process.stdout.write('Google Cloud SDK 999.0.0\n');
  save();
}
if (args[0] === 'auth' && args[1] === 'login') {
  state.loggedIn = true;
  process.stdout.write('gcloud login complete\n');
  save();
}
if (args[0] === 'auth' && args[1] === 'list') {
  if (state.loggedIn) process.stdout.write(state.activeAccount + '\n');
  save();
}
if (args[0] === 'auth' && args[1] === 'activate-service-account') save();
if (args[0] === 'config' && args[1] === 'get-value') {
  process.stdout.write(state.projectId + '\n');
  save();
}
if (args[0] === 'projects' && args[1] === 'list') {
  process.stdout.write(JSON.stringify(state.projects || []));
  save();
}
if (args[0] === 'projects' && args[1] === 'describe') {
  process.stdout.write(
    (args.some((argument) => argument.includes('value(projectNumber)'))
      ? state.projectNumber
      : state.projectId) + '\n'
  );
  save();
}
if (args[0] === 'services' && args[1] === 'enable') {
  if (state.servicesEnableError) fail(state.servicesEnableError);
  save();
}
if (
  args[0] === 'iam' &&
  args[1] === 'service-accounts' &&
  args[2] === 'create'
) {
  if (state.serviceAccountCreateError) fail(state.serviceAccountCreateError);
  state.createdServiceAccountName = args[3];
  state.createdProjectId = prefixed('--project=');
  state.serviceAccountDescription = prefixed('--description=');
  save();
}
if (
  args[0] === 'iam' &&
  args[1] === 'service-accounts' &&
  args[2] === 'describe'
) {
  process.stdout.write((state.serviceAccountDescription || '') + '\n');
  save();
}
if (args[0] === 'projects' && args[1] === 'add-iam-policy-binding') {
  if (state.iamBindingFailuresRemaining > 0) {
    state.iamBindingFailuresRemaining -= 1;
    const email = (prefixed('--member=') || '').replace(/^serviceAccount:/, '');
    fail(
      'ERROR: (gcloud.projects.add-iam-policy-binding) INVALID_ARGUMENT: ' +
        'Service account ' + email + ' does not exist.'
    );
  }
  save();
}
if (args[0] === 'projects' && args[1] === 'remove-iam-policy-binding') save();
if (
  args[0] === 'iam' &&
  args[1] === 'service-accounts' &&
  args[2] === 'add-iam-policy-binding'
) save();
if (
  args[0] === 'iam' &&
  args[1] === 'service-accounts' &&
  args[2] === 'keys' &&
  args[3] === 'list'
) {
  const email = prefixed('--iam-account=');
  for (const keyId of state.userManagedKeyIds) {
    process.stdout.write(
      'projects/' + state.projectId + '/serviceAccounts/' + email +
        '/keys/' + keyId + '\n'
    );
  }
  save();
}
if (
  args[0] === 'iam' &&
  args[1] === 'service-accounts' &&
  args[2] === 'keys' &&
  args[3] === 'create'
) {
  const keyPath = args[4];
  const email = prefixed('--iam-account=');
  const projectId = email.split('@')[1].replace('.iam.gserviceaccount.com', '');
  state.userManagedKeyIds.push('fake-generated-key-id');
  state.createdKeyPath = keyPath;
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  fs.writeFileSync(
    keyPath,
    JSON.stringify({
      type: 'service_account',
      project_id: projectId,
      private_key_id: 'fake-generated-key-id',
      private_key: '-----BEGIN PRIVATE KEY-----\nFAKE-GCP-PRIVATE-KEY\n-----END PRIVATE KEY-----\n',
      client_email: email,
      client_id: 'fake-client-id',
      auth_uri: 'https://accounts.google.com/o/oauth2/auth',
      token_uri: 'https://oauth2.googleapis.com/token',
      auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
      client_x509_cert_url: 'https://www.googleapis.com/robot/v1/metadata/x509/fake'
    })
  );
  save();
}

fail('Unhandled fake gcloud command: ' + args.join(' '));
`;

let suiteRoot = '';
let api: CredentialApiFixture;

beforeAll(async () => {
  suiteRoot = await mkdtemp(join(tmpdir(), 'anycloud-gcp-terminal-'));
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

async function createFakeEnvironment(
  root: string,
  initial: Partial<FakeGcloudState> = {},
  discoverExistingKey = false,
  withCli = true,
): Promise<{ env: Record<string, string>; statePath: string }> {
  const fakeBin = join(root, 'bin');
  const anycloudDir = join(root, '.anycloud');
  await mkdir(fakeBin, { recursive: true });
  await mkdir(anycloudDir, { recursive: true });
  if (withCli) {
    await writeFile(join(fakeBin, 'gcloud'), FAKE_GCLOUD, { mode: 0o755 });
  } else {
    await installUnavailableCliShim(fakeBin, 'gcloud');
  }

  const statePath = join(root, 'gcloud-state.json');
  const state: FakeGcloudState = {
    loggedIn: true,
    activeAccount: 'bootstrap@proj-pty.iam.gserviceaccount.com',
    projectId: 'proj-pty',
    projectNumber: '123456789012',
    iamBindingFailuresRemaining: 0,
    userManagedKeyIds: [],
    calls: [],
    ...initial,
  };
  await writeFile(statePath, JSON.stringify(state, null, 2));

  const env = childEnv();
  for (const name of [
    'GCP_PROJECT_ID',
    'GCP_CLIENT_EMAIL',
    'GCP_PRIVATE_KEY',
    'ANYCLOUD_CLOUD_PROVIDER',
  ]) {
    delete env[name];
  }
  writeLocalApiToken(anycloudDir);
  env.CI = 'false';
  env.HOME = root;
  env.ANYCLOUD_DIR = anycloudDir;
  env.API_URL = api.url;
  env.GITHUB_TOKEN = API_TOKEN;
  env.FAKE_GCLOUD_STATE = statePath;
  env.PATH = `${fakeBin}:${dirname(process.execPath)}:/usr/bin:/bin`;

  if (discoverExistingKey) {
    const existingKeyPath = join(root, 'bootstrap-key.json');
    await writeFile(
      existingKeyPath,
      JSON.stringify({
        type: 'service_account',
        project_id: state.projectId,
        private_key_id: 'bootstrap-key-id',
        private_key:
          '-----BEGIN PRIVATE KEY-----\nBOOTSTRAP\n-----END PRIVATE KEY-----\n',
        client_email: state.activeAccount,
      }),
      { mode: 0o600 },
    );
    env.GOOGLE_APPLICATION_CREDENTIALS = existingKeyPath;
  } else {
    delete env.GOOGLE_APPLICATION_CREDENTIALS;
  }

  return { env, statePath };
}

async function readState(path: string): Promise<FakeGcloudState> {
  return JSON.parse(await readFile(path, 'utf8')) as FakeGcloudState;
}

vi.setConfig({ testTimeout: 120_000 });

describe('GCP credentials onboarding terminal', () => {
  it(journeyTitle('gcp.generation-target-required'), async () => {
    const credentialName = `rejected-${Date.now().toString().slice(-10)}`;
    const root = await mkdtemp(join(suiteRoot, 'rejected-'));
    const { env, statePath } = await createFakeEnvironment(root);
    const run = spawnCliInPty(
      [
        'credentials',
        'new',
        credentialName,
        '--provider',
        'gcp',
        '--generate',
        '--project-id',
        'proj-pty',
      ],
      { cwd: root, env },
    );

    try {
      expect((await expectCleanExit(run.exit)).exitCode).toBe(1);
      expect(run.output()).toContain(
        'GCP --generate requires --gcloud-account and --project-id',
      );
      expect(await api.credentialExists(credentialName)).toBe(false);
      expect((await readState(statePath)).calls).toEqual([]);
    } finally {
      try {
        run.pty.kill();
      } catch {
        // It already exited.
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it(journeyTitle('gcp.discovered-key'), async () => {
    const credentialName = `import-${Date.now().toString().slice(-10)}`;
    const root = await mkdtemp(join(suiteRoot, 'import-'));
    const { env, statePath } = await createFakeEnvironment(root, {}, true);
    const existingKeyPath = join(root, 'bootstrap-key.json');
    const run = spawnCliInPty(['credentials', 'new'], { cwd: root, env });
    const wizard = new WizardDriver(run);
    run.registerSecret('BOOTSTRAP');
    try {
      await wizard.enterText('Name for this credential set:', credentialName);
      await wizard.selectChoice('Select cloud provider:', 'GCP', PROVIDERS);
      await wizard.selectChoice(
        'How would you like to add GCP credentials?',
        existingKeyPath,
        [existingKeyPath, 'Upload existing service account key file'],
      );
      await wizard.confirm(
        `Save these GCP credentials as "${credentialName}"?`,
      );
      await wizard.expectSuccess(credentialName);
      expect(await api.storedCredential(credentialName)).toMatchObject({
        projectId: 'proj-pty',
        clientEmail: 'bootstrap@proj-pty.iam.gserviceaccount.com',
      });
      expect(
        (await readState(statePath)).createdServiceAccountName,
      ).toBeUndefined();
      wizard.assertSecretNotPresent('BOOTSTRAP');
    } finally {
      try {
        run.pty.kill();
      } catch {
        // It already exited.
      }
      await api.deleteCredential(credentialName).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it(journeyTitle('gcp.malformed-key'), async () => {
    const credentialName = `malformed-${Date.now().toString().slice(-10)}`;
    const root = await mkdtemp(join(suiteRoot, 'malformed-'));
    const { env } = await createFakeEnvironment(root, {}, false, false);
    const uploadPath = join(root, 'truncated-key.json');
    await writeFile(
      uploadPath,
      '{"type":"service_account","project_id":"upload-project","private_key":"-----BEGIN',
      { mode: 0o600 },
    );
    const run = spawnCliInPty(['credentials', 'new'], { cwd: root, env });
    const wizard = new WizardDriver(run);
    try {
      await wizard.enterText('Name for this credential set:', credentialName);
      await wizard.selectChoice('Select cloud provider:', 'GCP', PROVIDERS);
      await wizard.selectChoice(
        'How would you like to add GCP credentials?',
        'Upload existing service account key file',
        [
          'Upload existing service account key file',
          'Create a service account with gcloud',
        ],
      );
      await wizard.enterText(
        'Enter path to service account key JSON file:',
        uploadPath,
        { clearInitial: true },
      );
      expect((await expectCleanExit(run.exit)).exitCode).toBe(1);
      expect(run.output()).toContain('Failed to validate key file');
      expect(run.output()).toContain('invalid JSON');
      expect(run.output()).not.toContain('Save these GCP credentials');
      expect(await api.credentialExists(credentialName)).toBe(false);
    } finally {
      try {
        run.pty.kill();
      } catch {
        // It already exited.
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it(journeyTitle('gcp.upload-key'), async () => {
    const credentialName = `upload-${Date.now().toString().slice(-10)}`;
    const root = await mkdtemp(join(suiteRoot, 'upload-'));
    const { env } = await createFakeEnvironment(root, {}, true, false);
    Object.assign(env, {
      GCP_PROJECT_ID: 'environment-project',
      GCP_CLIENT_EMAIL:
        'environment@environment-project.iam.gserviceaccount.com',
      GCP_PRIVATE_KEY: 'UNSELECTED-ENVIRONMENT-KEY',
    });
    const uploadPath = join(root, 'uploaded-key.json');
    const privateKey =
      '-----BEGIN PRIVATE KEY-----\nUPLOAD-GCP-PRIVATE-KEY\n-----END PRIVATE KEY-----\n';
    const uploadedKey = {
      type: 'service_account',
      project_id: 'upload-project',
      private_key_id: 'upload-key-id',
      private_key: privateKey,
      client_email: 'uploaded@upload-project.iam.gserviceaccount.com',
    };
    await writeFile(uploadPath, JSON.stringify(uploadedKey), { mode: 0o600 });
    const run = spawnCliInPty(['credentials', 'new'], { cwd: root, env });
    const wizard = new WizardDriver(run);
    run.registerSecret('UPLOAD-GCP-PRIVATE-KEY');
    run.registerSecret('UNSELECTED-ENVIRONMENT-KEY');
    try {
      await wizard.enterText('Name for this credential set:', credentialName);
      await wizard.selectChoice('Select cloud provider:', 'GCP', PROVIDERS);
      await wizard.selectChoice(
        'How would you like to add GCP credentials?',
        'Upload existing service account key file',
        [
          'Use service account credentials from environment',
          join(root, 'bootstrap-key.json'),
          'Upload existing service account key file',
          'Create a service account with gcloud',
        ],
      );
      await wizard.enterText(
        'Enter path to service account key JSON file:',
        uploadPath,
        { clearInitial: true },
      );
      const confirmation = `Save these GCP credentials as "${credentialName}"?`;
      await run.waitFor(confirmation);
      const destination = join(env.ANYCLOUD_DIR, 'anycloud-uploaded-key.json');
      expect(await api.credentialExists(credentialName)).toBe(false);
      await expect(access(destination)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(run.output()).toContain('Project ID: upload-project');
      expect(run.output()).toContain(
        'Service account: uploaded@upload-project.iam.gserviceaccount.com',
      );
      await writeFile(
        uploadPath,
        JSON.stringify({
          ...uploadedKey,
          project_id: 'changed-project',
          private_key: 'CHANGED-AFTER-REVIEW',
        }),
      );
      await wizard.confirm(confirmation);
      await wizard.expectSuccess(credentialName);
      expect(await api.storedCredential(credentialName)).toMatchObject({
        projectId: 'upload-project',
        clientEmail: 'uploaded@upload-project.iam.gserviceaccount.com',
        privateKey,
      });
      expect(JSON.parse(await readFile(destination, 'utf8'))).toEqual(
        uploadedKey,
      );
      expect((await stat(destination)).mode & 0o777).toBe(0o600);
      wizard.assertSecretNotPresent('UPLOAD-GCP-PRIVATE-KEY');
      wizard.assertSecretNotPresent('UNSELECTED-ENVIRONMENT-KEY');
    } finally {
      try {
        run.pty.kill();
      } catch {
        // It already exited.
      }
      await api.deleteCredential(credentialName).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    { action: 'No', input: 'n\r' },
    { action: 'Ctrl-C', input: '\x03' },
  ])(`${journeyTitle('gcp.cancel-upload')} ($action)`, async ({ input }) => {
    const credentialName = `cancel-upload-${Date.now()}`;
    const root = await mkdtemp(join(suiteRoot, 'cancel-upload-'));
    const { env } = await createFakeEnvironment(root, {}, false, false);
    const source = join(root, 'declined-key.json');
    await writeFile(
      source,
      JSON.stringify({
        type: 'service_account',
        project_id: 'declined-project',
        client_email: 'declined@declined-project.iam.gserviceaccount.com',
        private_key:
          '-----BEGIN PRIVATE KEY-----\nDECLINED-UPLOAD-KEY\n-----END PRIVATE KEY-----',
      }),
      { mode: 0o600 },
    );
    const destination = join(env.ANYCLOUD_DIR, 'anycloud-declined-key.json');
    const run = spawnCliInPty(['credentials', 'new'], { cwd: root, env });
    const wizard = new WizardDriver(run);
    run.registerSecret('DECLINED-UPLOAD-KEY');
    try {
      await wizard.enterText('Name for this credential set:', credentialName);
      await wizard.selectChoice('Select cloud provider:', 'GCP', PROVIDERS);
      await wizard.selectChoice(
        'How would you like to add GCP credentials?',
        'Upload existing service account key file',
        [
          'Upload existing service account key file',
          'Create a service account with gcloud',
        ],
      );
      await wizard.enterText(
        'Enter path to service account key JSON file:',
        source,
        { clearInitial: true },
      );
      await run.waitFor(`Save these GCP credentials as "${credentialName}"?`);
      await expect(access(destination)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      run.pty.write(input);
      expect((await expectCleanExit(run.exit)).exitCode).toBe(0);
      expect(await api.credentialExists(credentialName)).toBe(false);
      await expect(access(destination)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      wizard.assertSecretNotPresent('DECLINED-UPLOAD-KEY');
    } finally {
      try {
        run.pty.kill();
      } catch {
        // It already exited.
      }
      await api.deleteCredential(credentialName).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });
});

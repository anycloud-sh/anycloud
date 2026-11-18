import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import {
  installUnavailableCliShim,
  spawnCliInPty,
  startCredentialApi,
  type CredentialApiFixture,
  WizardDriver,
} from '../harness.js';
import { journeyTitle } from '../journeys.js';
import {
  AZURE_ORPHANED_SERVICE_PRINCIPAL,
  type AzureDirectoryListPersona,
} from '../personas.js';
import { writeLocalApiToken } from '../../helpers/local-api-token.js';
import { childEnv } from '../../helpers/child-env.js';

const API_TOKEN = 'fake-azure-terminal-token';
const PROVIDERS = ['AWS', 'Azure', 'GCP', 'Lambda'] as const;
const AZURE_METHODS = [
  'Enter existing service principal credentials',
  'Create a service principal with Azure CLI',
] as const;

interface FakeAzureState {
  calls: string[][];
  createdDisplayName?: string;
  loggedIn?: boolean;
  applicationCreateError?: string;
  directoryListPersona?: AzureDirectoryListPersona;
  subscriptions?: Array<{
    id: string;
    name: string;
    tenantId: string;
    isDefault: boolean;
  }>;
}

const FAKE_AZURE = String.raw`#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const statePath = process.env.FAKE_AZURE_STATE;
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
state.calls.push(args);
const subscriptions = state.subscriptions || [
  {
    id: 'sub-dev',
    name: 'Development',
    tenantId: 'tenant-dev',
    isDefault: false,
  },
  {
    id: 'sub-pty',
    name: 'PTY Subscription',
    tenantId: 'tenant-pty',
    isDefault: true,
  },
];

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
if (args[0] === 'login') {
  state.loggedIn = true;
  finish([{ name: 'browser-user@example.com' }]);
}
if (args[0] === 'account' && args[1] === 'show') {
  if (state.loggedIn === false) fail('Please run az login');
  const requestedSubscriptionId = after('--subscription');
  const subscription =
    subscriptions.find(({ id }) => id === requestedSubscriptionId) ||
    subscriptions.find(({ isDefault }) => isDefault) ||
    subscriptions[0];
  if (!subscription) fail('No Azure subscriptions found');
  if (after('--query') === 'tenantId') {
    if (after('--output') !== 'json') fail('Expected JSON tenant output');
    finish(subscription.tenantId);
  }
  finish({
    ...subscription,
    user: { type: 'servicePrincipal', name: 'bootstrap-app' },
  });
}
if (args[0] === 'account' && args[1] === 'list') {
  if (state.loggedIn === false) fail('Please run az login');
  finish(subscriptions);
}
if (
  args[0] === 'rest' &&
  after('--method') === 'GET' &&
  (after('--url').includes('/applications?') ||
    after('--url').includes('/servicePrincipals?'))
) {
  if (state.applicationCreateError) fail(state.applicationCreateError);
  const collection = after('--url').includes('/servicePrincipals?')
    ? 'servicePrincipals'
    : 'applications';
  if (state.directoryListPersona) {
    const personaResponse = state.directoryListPersona.responses.find(
      (response) =>
        response.method === after('--method') &&
        response.collection === collection
    );
    if (!personaResponse) {
      fail(
        'Persona used for an operation it was not captured from: ' +
          after('--method') +
          ' ' +
          collection
      );
    }
    finish(personaResponse.objects);
  }
  finish([]);
}
if (
  args[0] === 'rest' &&
  after('--method') === 'POST' &&
  after('--url').endsWith('/applications')
) {
  const body = JSON.parse(after('--body'));
  state.createdDisplayName = body.displayName;
  finish({
    id: 'app-object-pty',
    appId: 'app-pty-generated',
    displayName: body.displayName,
    tags: body.tags,
  });
}
if (
  args[0] === 'rest' &&
  after('--method') === 'POST' &&
  after('--url').endsWith('/servicePrincipals')
) {
  const body = JSON.parse(after('--body'));
  finish({ id: 'sp-object-pty', appId: body.appId, tags: body.tags });
}
if (args[0] === 'rest' && after('--url').endsWith('/addPassword')) {
  finish({
    keyId: 'key-pty',
    secretText: 'secret-pty-generated',
    endDateTime: '2028-08-13T15:00:00Z',
  });
}
if (args[0] === 'role' && args[1] === 'assignment' && args[2] === 'create') {
  finish({});
}
process.stderr.write('Unhandled fake az command: ' + args.join(' ') + '\n');
fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
process.exit(1);
`;

let suiteRoot = '';
let api: CredentialApiFixture;

beforeAll(async () => {
  suiteRoot = await mkdtemp(join(tmpdir(), 'anycloud-azure-terminal-api-'));
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

async function createAzureRun(
  initialState: Omit<FakeAzureState, 'calls'> = {},
  withCli = true,
): Promise<{
  childRoot: string;
  statePath: string;
  run: ReturnType<typeof spawnCliInPty>;
  wizard: WizardDriver;
}> {
  const childRoot = await mkdtemp(join(tmpdir(), 'anycloud-azure-terminal-'));
  const fakeBin = join(childRoot, 'bin');
  const azPath = join(fakeBin, 'az');
  const statePath = join(childRoot, 'state.json');
  await mkdir(fakeBin, { recursive: true });
  await writeFile(statePath, JSON.stringify({ calls: [], ...initialState }));
  if (withCli) {
    await writeFile(azPath, FAKE_AZURE, { mode: 0o755 });
    await chmod(azPath, 0o755);
  } else {
    await installUnavailableCliShim(fakeBin, 'az');
  }

  const env = childEnv();
  for (const name of [
    'ANYCLOUD_CLOUD_PROVIDER',
    'AZURE_APPLICATION_ID',
    'AZURE_SECRET',
    'AZURE_SUBSCRIPTION_ID',
    'AZURE_DIRECTORY_ID',
    'AZURE_AUTHORITY_HOST',
    'AZURE_RESOURCE_MANAGER_ENDPOINT',
    'NODE_EXTRA_CA_CERTS',
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
    FAKE_AZURE_STATE: statePath,
  });
  const run = spawnCliInPty(['credentials', 'new'], {
    cwd: childRoot,
    env,
  });
  return { childRoot, statePath, run, wizard: new WizardDriver(run) };
}

async function disposeAzureRun(
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

describe('Azure credentials onboarding terminal', () => {
  it(journeyTitle('azure.multiple-subscriptions'), async () => {
    const credentialName = `terminal-${Date.now()}`;
    const { childRoot, statePath, run, wizard } = await createAzureRun();
    run.registerSecret('secret-pty-generated');

    try {
      await wizard.enterText('Name for this credential set:', credentialName);
      await wizard.selectChoice('Select cloud provider:', 'Azure', PROVIDERS);
      await wizard.selectChoice(
        'How would you like to add Azure credentials?',
        'Create a service principal with Azure CLI',
        AZURE_METHODS,
      );
      await wizard.selectChoice(
        'Select Azure subscription:',
        'Development (sub-dev)',
        ['Development (sub-dev)', 'PTY Subscription (sub-pty)'],
        { initial: 'PTY Subscription (sub-pty)' },
      );
      await run.waitFor('Tenant: tenant-dev');
      await run.waitFor('Scope: /subscriptions/sub-dev');
      await run.waitFor('Roles: Contributor');
      await run.waitFor('Required operator access: create Entra applications');
      // Enter accepts the default Yes after the preview.
      await run.waitFor('Create these Azure credentials?');
      run.pty.write('\r');
      await wizard.expectSuccess(credentialName);
      wizard.assertSecretNotPresent('secret-pty-generated');
      expect(run.output()).toContain('Secret expires: 2028-08-13T15:00:00Z');
      expect(await api.storedCredential(credentialName)).toMatchObject({
        name: credentialName,
        cloudProvider: 'Azure',
        applicationId: 'app-pty-generated',
        secret: 'secret-pty-generated',
        subscriptionId: 'sub-dev',
        directoryId: 'tenant-dev',
      });
      const state = JSON.parse(
        await readFile(statePath, 'utf8'),
      ) as FakeAzureState;
      expect(state.createdDisplayName).toBe(`anycloud-${credentialName}`);
      expect(
        state.calls.some(
          (args) =>
            args[0] === 'rest' &&
            String(args[args.indexOf('--url') + 1]).endsWith(
              '/servicePrincipals',
            ),
        ),
      ).toBe(true);
      const scopedCalls = state.calls.filter(
        (args) =>
          args[0] === 'rest' ||
          (args[0] === 'role' && args[1] === 'assignment'),
      );
      expect(scopedCalls.length).toBeGreaterThan(0);
      for (const args of scopedCalls) {
        expect(args).toContain('--subscription');
        expect(args[args.indexOf('--subscription') + 1]).toBe('sub-dev');
      }
      expect(
        state.calls.some((args) => args[0] === 'account' && args[1] === 'set'),
      ).toBe(false);
      expect(state.calls.some((args) => args[0] === 'login')).toBe(false);
    } finally {
      await disposeAzureRun(childRoot, run, credentialName);
    }
  });

  it(journeyTitle('azure.explicit-generation'), async () => {
    const credentialName = `active-${Date.now()}`;
    const { childRoot, statePath, run, wizard } = await createAzureRun({
      subscriptions: [
        {
          id: 'sub-pty',
          name: 'PTY Subscription',
          tenantId: 'tenant-pty',
          isDefault: true,
        },
      ],
    });
    run.registerSecret('secret-pty-generated');
    try {
      await wizard.enterText('Name for this credential set:', credentialName);
      await wizard.selectChoice('Select cloud provider:', 'Azure', PROVIDERS);
      await wizard.selectChoice(
        'How would you like to add Azure credentials?',
        'Create a service principal with Azure CLI',
        AZURE_METHODS,
      );
      await wizard.confirm('Create these Azure credentials?');
      await wizard.expectSuccess(credentialName);
      expect(run.output()).toContain(
        'Using Azure subscription: PTY Subscription (sub-pty)',
      );
      const state = JSON.parse(
        await readFile(statePath, 'utf8'),
      ) as FakeAzureState;
      expect(state.calls.some((args) => args[0] === 'login')).toBe(false);
    } finally {
      await disposeAzureRun(childRoot, run, credentialName);
    }
  });

  it(journeyTitle('azure.identity-collision'), async () => {
    const credentialName = AZURE_ORPHANED_SERVICE_PRINCIPAL.credentialName;
    const { childRoot, statePath, run, wizard } = await createAzureRun({
      directoryListPersona: AZURE_ORPHANED_SERVICE_PRINCIPAL,
      subscriptions: [
        {
          id: 'sub-collision',
          name: 'Collision Subscription',
          tenantId: 'tenant-collision',
          isDefault: true,
        },
      ],
    });
    try {
      await wizard.enterText('Name for this credential set:', credentialName);
      await wizard.selectChoice('Select cloud provider:', 'Azure', PROVIDERS);
      await wizard.selectChoice(
        'How would you like to add Azure credentials?',
        'Create a service principal with Azure CLI',
        AZURE_METHODS,
      );
      await wizard.confirm('Create these Azure credentials?');
      expect((await run.exit).exitCode).toBe(1);
      const state = JSON.parse(
        await readFile(statePath, 'utf8'),
      ) as FakeAzureState;
      expect(run.output()).toContain('Failed to add credentials');
      expect(run.output()).toContain(
        `Azure identity "anycloud-${credentialName}" already exists`,
      );
      expect(await api.credentialExists(credentialName)).toBe(false);
      const restCalls = state.calls.filter((args) => args[0] === 'rest');
      expect(restCalls).toHaveLength(2);
      for (const args of restCalls) {
        expect(args[args.indexOf('--method') + 1]).toBe('GET');
      }
      expect(
        state.calls.some(
          (args) =>
            args[0] === 'rest' &&
            args.includes('GET') &&
            args.some((arg) => arg.includes('/servicePrincipals?')),
        ),
      ).toBe(true);
      expect(
        state.calls.some(
          (args) =>
            args[0] === 'rest' &&
            args.includes('GET') &&
            args.some((arg) => arg.includes('/applications?')),
        ),
      ).toBe(true);
      expect(state.calls.some((args) => args[0] === 'role')).toBe(false);
    } finally {
      await disposeAzureRun(childRoot, run, credentialName);
    }
  });

  it(journeyTitle('azure.permission-preview'), async () => {
    const credentialName = `preview-${Date.now()}`;
    const { childRoot, run, wizard } = await createAzureRun({
      subscriptions: [
        {
          id: 'sub-preview',
          name: 'Preview Subscription',
          tenantId: 'tenant-preview',
          isDefault: true,
        },
      ],
    });
    try {
      await wizard.enterText('Name for this credential set:', credentialName);
      await wizard.selectChoice('Select cloud provider:', 'Azure', PROVIDERS);
      await wizard.selectChoice(
        'How would you like to add Azure credentials?',
        'Create a service principal with Azure CLI',
        AZURE_METHODS,
      );
      await run.waitFor('Tenant: tenant-preview');
      await run.waitFor('Subscription: sub-preview');
      await run.waitFor('Scope: /subscriptions/sub-preview');
      await run.waitFor('Roles: Contributor');
      await run.waitFor('Required operator access: create Entra applications');
      await wizard.confirm('Create these Azure credentials?');
      await expect(
        wizard.expectSuccess(credentialName),
      ).resolves.toBeUndefined();
    } finally {
      await disposeAzureRun(childRoot, run, credentialName);
    }
  });

  it(journeyTitle('azure.cancel-generation'), async () => {
    const credentialName = `cancel-${Date.now()}`;
    const { childRoot, statePath, run, wizard } = await createAzureRun({
      subscriptions: [
        {
          id: 'sub-cancel',
          name: 'Cancel Subscription',
          tenantId: 'tenant-cancel',
          isDefault: true,
        },
      ],
    });
    try {
      await wizard.enterText('Name for this credential set:', credentialName);
      await wizard.selectChoice('Select cloud provider:', 'Azure', PROVIDERS);
      await wizard.selectChoice(
        'How would you like to add Azure credentials?',
        'Create a service principal with Azure CLI',
        AZURE_METHODS,
      );
      await wizard.confirm('Create these Azure credentials?', false);
      expect((await run.exit).exitCode).toBe(0);
      expect(await api.credentialExists(credentialName)).toBe(false);
      const state = JSON.parse(
        await readFile(statePath, 'utf8'),
      ) as FakeAzureState;
      expect(
        state.calls.some(
          (args) =>
            (args[0] === 'rest' && args.includes('POST')) ||
            (args[0] === 'role' &&
              args[1] === 'assignment' &&
              args[2] === 'create'),
        ),
      ).toBe(false);
    } finally {
      await disposeAzureRun(childRoot, run, credentialName);
    }
  });

  it(journeyTitle('azure.browser-login'), async () => {
    const credentialName = `browser-${Date.now()}`;
    const { childRoot, statePath, run, wizard } = await createAzureRun({
      loggedIn: false,
      subscriptions: [
        {
          id: 'sub-pty',
          name: 'PTY Subscription',
          tenantId: 'tenant-pty',
          isDefault: true,
        },
      ],
    });
    try {
      await wizard.enterText('Name for this credential set:', credentialName);
      await wizard.selectChoice('Select cloud provider:', 'Azure', PROVIDERS);
      await wizard.selectChoice(
        'How would you like to add Azure credentials?',
        'Create a service principal with Azure CLI',
        AZURE_METHODS,
      );
      await run.waitFor('Opening browser for Azure login');
      await wizard.confirm('Create these Azure credentials?');
      await wizard.expectSuccess(credentialName);
      const state = JSON.parse(
        await readFile(statePath, 'utf8'),
      ) as FakeAzureState;
      expect(state.loggedIn).toBe(true);
      expect(state.calls.some((args) => args[0] === 'login')).toBe(true);
    } finally {
      await disposeAzureRun(childRoot, run, credentialName);
    }
  });

  it(journeyTitle('azure.enter-existing'), async () => {
    const credentialName = `manual-${Date.now()}`;
    const secret = 'AZURE-MANUAL-SECRET-TERMINAL';
    const { childRoot, run, wizard } = await createAzureRun({}, false);
    try {
      await wizard.enterText('Name for this credential set:', credentialName);
      await wizard.selectChoice('Select cloud provider:', 'Azure', PROVIDERS);
      await wizard.selectChoice(
        'How would you like to add Azure credentials?',
        'Enter existing service principal credentials',
        AZURE_METHODS,
      );
      await wizard.enterText(
        'Service Principal Application ID (appId):',
        'manual-app-id',
      );
      await wizard.enterSecret('Service Principal Secret (password):', secret);
      await wizard.enterText('Subscription ID:', 'manual-subscription');
      await wizard.enterText('Directory ID (Tenant ID):', 'manual-tenant');
      await wizard.confirm(
        `Save these Azure credentials as "${credentialName}"?`,
      );
      await wizard.expectSuccess(credentialName);
      wizard.assertSecretNotPresent(secret);
      expect(await api.storedCredential(credentialName)).toMatchObject({
        cloudProvider: 'Azure',
        applicationId: 'manual-app-id',
        secret,
        subscriptionId: 'manual-subscription',
        directoryId: 'manual-tenant',
      });
    } finally {
      await disposeAzureRun(childRoot, run, credentialName);
    }
  });

  it(journeyTitle('azure.permission-failure'), async () => {
    const credentialName = `permission-${Date.now()}`;
    const { childRoot, run, wizard } = await createAzureRun({
      applicationCreateError:
        'ERROR: Authorization_RequestDenied: Insufficient privileges',
      subscriptions: [
        {
          id: 'sub-pty',
          name: 'PTY Subscription',
          tenantId: 'tenant-pty',
          isDefault: true,
        },
      ],
    });
    try {
      await wizard.enterText('Name for this credential set:', credentialName);
      await wizard.selectChoice('Select cloud provider:', 'Azure', PROVIDERS);
      await wizard.selectChoice(
        'How would you like to add Azure credentials?',
        'Create a service principal with Azure CLI',
        AZURE_METHODS,
      );
      await wizard.confirm('Create these Azure credentials?');
      await run.waitFor(
        'Azure permission denied while checking for existing directory objects',
      );
      expect((await run.exit).exitCode).toBe(1);
      expect(await api.credentialExists(credentialName)).toBe(false);
      expect(run.output()).toContain('Ask your Azure administrator');
      expect(run.output()).toContain('subscription sub-pty');
      expect(run.output()).toContain(
        'https://anycloud.sh/reference/cli/credentials#ask-an-administrator',
      );
      expect(run.output()).not.toContain(
        'Service Principal Application ID (appId):',
      );
    } finally {
      await disposeAzureRun(childRoot, run, credentialName);
    }
  });

  it(journeyTitle('common.save-response-lost'), async () => {
    const credentialName = `reconcile-${Date.now()}`;
    api.queueSaveFault({ kind: 'disconnect-after-commit' });
    const { childRoot, statePath, run, wizard } = await createAzureRun({
      subscriptions: [
        {
          id: 'sub-reconcile',
          name: 'Reconcile Subscription',
          tenantId: 'tenant-pty',
          isDefault: true,
        },
      ],
    });
    try {
      await wizard.enterText('Name for this credential set:', credentialName);
      await wizard.selectChoice('Select cloud provider:', 'Azure', PROVIDERS);
      await wizard.selectChoice(
        'How would you like to add Azure credentials?',
        'Create a service principal with Azure CLI',
        AZURE_METHODS,
      );
      await wizard.confirm('Create these Azure credentials?');
      await wizard.expectSuccess(credentialName);
      expect(await api.storedCredential(credentialName)).toMatchObject({
        applicationId: 'app-pty-generated',
        subscriptionId: 'sub-reconcile',
      });
      const state = JSON.parse(
        await readFile(statePath, 'utf8'),
      ) as FakeAzureState;
      expect(
        state.calls.some(
          (args) =>
            (args[0] === 'rest' && args.includes('DELETE')) ||
            (args[0] === 'role' &&
              args[1] === 'assignment' &&
              args[2] === 'delete'),
        ),
      ).toBe(false);
    } finally {
      await disposeAzureRun(childRoot, run, credentialName);
    }
  });
});

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import packageJson from '../../../../package.json' with { type: 'json' };
import { ANYCLOUD_CLIENT_VERSION_HEADER } from '../../../../src/shared/api-version.js';
import {
  expectCleanExit,
  installUnavailableCliShim,
  spawnCliInPty,
  startCredentialApi,
  type CredentialApiFixture,
  type PtyRun,
  WizardDriver,
} from '../harness.js';
import { journeyTitle } from '../journeys.js';
import { writeLocalApiToken } from '../../helpers/local-api-token.js';
import { childEnv } from '../../helpers/child-env.js';

const API_TOKEN = 'fake-common-terminal-token';
const PROVIDERS = ['AWS', 'Azure', 'GCP', 'Lambda'] as const;
const ADMIN_REQUEST_LINK =
  'https://anycloud.sh/reference/cli/credentials#ask-an-administrator';

// Every provider CLI is unavailable in these runs, so each picker shows only
// the paths that need no CLI, plus Azure and GCP's explicit create action.
const NO_CLI_SOURCES = [
  {
    provider: 'AWS',
    choices: ['Enter existing access keys', "I don't have AWS access keys"],
    // AWS hints appear before its picker; aws.missing-cli-hint covers them.
    hint: 'curl -fsSL https://awscli.amazonaws.com/v2/install.sh | bash',
  },
  {
    provider: 'Azure',
    choices: [
      'Enter existing service principal credentials',
      'Create a service principal with Azure CLI',
      "I don't have Azure service principal credentials",
    ],
    hint:
      process.platform === 'darwin'
        ? 'brew install azure-cli'
        : 'https://learn.microsoft.com/cli/azure/install-azure-cli-linux',
  },
  {
    provider: 'GCP',
    choices: [
      'Upload existing service account key file',
      'Create a service account with gcloud',
      "I don't have a GCP service account key",
    ],
    hint: 'curl https://sdk.cloud.google.com | bash',
  },
] as const;

const ENVIRONMENT_IMPORTS: Array<{
  provider: (typeof PROVIDERS)[number];
  label: string;
  environment: Record<string, string>;
  choices: string[];
  review: string[];
  credential: Record<string, string>;
  secret: string;
}> = [
  {
    provider: 'Azure',
    label: 'Azure',
    environment: {
      AZURE_APPLICATION_ID: 'environment-app',
      AZURE_SECRET: 'COMMON-AZURE-ENV-SECRET',
      AZURE_SUBSCRIPTION_ID: 'environment-subscription',
      AZURE_DIRECTORY_ID: 'environment-tenant',
    },
    choices: [
      'Use service principal credentials from environment',
      'Enter existing service principal credentials',
      'Create a service principal with Azure CLI',
    ],
    review: [
      'Source: Azure environment variables',
      'Tenant ID: environment-tenant',
      'Subscription ID: environment-subscription',
      'Application ID: environment-app',
    ],
    credential: {
      cloudProvider: 'Azure',
      applicationId: 'environment-app',
      secret: 'COMMON-AZURE-ENV-SECRET',
      subscriptionId: 'environment-subscription',
      directoryId: 'environment-tenant',
    },
    secret: 'COMMON-AZURE-ENV-SECRET',
  },
  {
    provider: 'GCP',
    label: 'GCP',
    environment: {
      GCP_PROJECT_ID: 'environment-project',
      GCP_CLIENT_EMAIL:
        'environment@environment-project.iam.gserviceaccount.com',
      GCP_PRIVATE_KEY:
        '-----BEGIN PRIVATE KEY-----\nCOMMON-GCP-ENV-SECRET\n-----END PRIVATE KEY-----',
    },
    choices: [
      'Use service account credentials from environment',
      'Upload existing service account key file',
      'Create a service account with gcloud',
    ],
    review: [
      'Source: GCP_PROJECT_ID, GCP_CLIENT_EMAIL, and GCP_PRIVATE_KEY',
      'Project ID: environment-project',
      'Service account: environment@environment-project.iam.gserviceaccount.com',
    ],
    credential: {
      cloudProvider: 'GCP',
      projectId: 'environment-project',
      clientEmail: 'environment@environment-project.iam.gserviceaccount.com',
      privateKey:
        '-----BEGIN PRIVATE KEY-----\nCOMMON-GCP-ENV-SECRET\n-----END PRIVATE KEY-----',
    },
    secret: 'COMMON-GCP-ENV-SECRET',
  },
  {
    provider: 'Lambda',
    label: 'Lambda Labs',
    environment: { LAMBDA_API_KEY: 'COMMON-LAMBDA-ENV-SECRET' },
    choices: ['Use API key from environment', 'Enter an API key'],
    review: ['Source: LAMBDA_API_KEY'],
    credential: { cloudProvider: 'Lambda', apiKey: 'COMMON-LAMBDA-ENV-SECRET' },
    secret: 'COMMON-LAMBDA-ENV-SECRET',
  },
];

interface PromptInput {
  prompt: string;
  value: string;
  secret?: boolean;
}

const FRESH_MANUAL_IMPORTS: Array<{
  provider: (typeof PROVIDERS)[number];
  inputs: PromptInput[];
  credential: Record<string, string>;
}> = [
  {
    provider: 'Azure',
    inputs: [
      {
        prompt: 'Service Principal Application ID (appId):',
        value: 'fresh-app',
      },
      {
        prompt: 'Service Principal Secret (password):',
        value: 'FRESH-AZURE-SECRET',
        secret: true,
      },
      { prompt: 'Subscription ID:', value: 'fresh-subscription' },
      { prompt: 'Directory ID (Tenant ID):', value: 'fresh-tenant' },
    ],
    credential: {
      cloudProvider: 'Azure',
      applicationId: 'fresh-app',
      secret: 'FRESH-AZURE-SECRET',
      subscriptionId: 'fresh-subscription',
      directoryId: 'fresh-tenant',
    },
  },
  {
    provider: 'Lambda',
    inputs: [
      {
        prompt: 'Lambda Labs API Key:',
        value: 'FRESH-LAMBDA-KEY',
        secret: true,
      },
    ],
    credential: { cloudProvider: 'Lambda', apiKey: 'FRESH-LAMBDA-KEY' },
  },
];

const MANUAL_PROMPT_CANCELLATIONS: Array<{
  label: string;
  provider: (typeof PROVIDERS)[number];
  inputs: PromptInput[];
  cancelPrompt: string;
}> = [
  {
    label: 'AWS access key',
    provider: 'AWS',
    inputs: [],
    cancelPrompt: 'AWS Access Key ID:',
  },
  {
    label: 'AWS secret key',
    provider: 'AWS',
    inputs: [{ prompt: 'AWS Access Key ID:', value: 'AKIA-CANCEL' }],
    cancelPrompt: 'AWS Secret Access Key:',
  },
  {
    label: 'Azure application ID',
    provider: 'Azure',
    inputs: [],
    cancelPrompt: 'Service Principal Application ID (appId):',
  },
  {
    label: 'Azure secret',
    provider: 'Azure',
    inputs: [
      {
        prompt: 'Service Principal Application ID (appId):',
        value: 'cancel-app',
      },
    ],
    cancelPrompt: 'Service Principal Secret (password):',
  },
  {
    label: 'Azure subscription',
    provider: 'Azure',
    inputs: [
      {
        prompt: 'Service Principal Application ID (appId):',
        value: 'cancel-app',
      },
      {
        prompt: 'Service Principal Secret (password):',
        value: 'cancel-azure-secret',
        secret: true,
      },
    ],
    cancelPrompt: 'Subscription ID:',
  },
  {
    label: 'Azure directory',
    provider: 'Azure',
    inputs: [
      {
        prompt: 'Service Principal Application ID (appId):',
        value: 'cancel-app',
      },
      {
        prompt: 'Service Principal Secret (password):',
        value: 'cancel-azure-secret',
        secret: true,
      },
      { prompt: 'Subscription ID:', value: 'cancel-subscription' },
    ],
    cancelPrompt: 'Directory ID (Tenant ID):',
  },
  {
    label: 'GCP key upload',
    provider: 'GCP',
    inputs: [],
    cancelPrompt: 'Enter path to service account key JSON file:',
  },
  {
    label: 'Lambda API key',
    provider: 'Lambda',
    inputs: [],
    cancelPrompt: 'Lambda Labs API Key:',
  },
];

let suiteRoot = '';
let api: CredentialApiFixture;

beforeAll(async () => {
  suiteRoot = await mkdtemp(join(tmpdir(), 'anycloud-common-terminal-api-'));
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

async function createRun(
  options: { env?: Record<string, string>; args?: string[] } = {},
): Promise<{
  root: string;
  run: PtyRun;
  wizard: WizardDriver;
}> {
  const root = await mkdtemp(join(suiteRoot, 'journey-'));
  const fakeBin = join(root, 'bin');
  await mkdir(fakeBin, { recursive: true });
  await Promise.all(
    ['aws', 'az', 'gcloud'].map((command) =>
      installUnavailableCliShim(fakeBin, command),
    ),
  );
  const env = childEnv();
  for (const name of [
    'ANYCLOUD_CLOUD_PROVIDER',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_PROFILE',
    'AWS_DEFAULT_PROFILE',
    'AWS_SHARED_CREDENTIALS_FILE',
    'AWS_CONFIG_FILE',
    'AZURE_APPLICATION_ID',
    'AZURE_SECRET',
    'AZURE_SUBSCRIPTION_ID',
    'AZURE_DIRECTORY_ID',
    'GCP_PROJECT_ID',
    'GCP_CLIENT_EMAIL',
    'GCP_PRIVATE_KEY',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'LAMBDA_API_KEY',
  ]) {
    delete env[name];
  }
  writeLocalApiToken(root);
  Object.assign(env, {
    CI: 'false',
    HOME: root,
    ANYCLOUD_DIR: root,
    API_URL: api.url,
    GITHUB_TOKEN: API_TOKEN,
    PATH: `${fakeBin}:/usr/bin:/bin`,
    ...options.env,
  });
  const run = spawnCliInPty(options.args ?? ['credentials', 'new'], {
    cwd: root,
    env,
  });
  return { root, run, wizard: new WizardDriver(run) };
}

async function disposeRun(root: string, run: PtyRun): Promise<void> {
  try {
    run.pty.kill();
  } catch {
    // It already exited.
  }
  await rm(root, { recursive: true, force: true });
}

describe('common credential wizard terminal contracts', () => {
  it('interactive CLI runner preserves inherited terminals and Ctrl+C', async () => {
    const moduleUrl = new URL(
      '../../../../src/cli/services/slurp/cli-exec.ts',
      import.meta.url,
    ).href;
    const child =
      'const interval=setInterval(()=>{},1000);process.on("SIGINT",()=>{console.log("child-interrupted");clearInterval(interval)});console.log("tty-ready:"+[process.stdin.isTTY,process.stdout.isTTY,process.stderr.isTTY].join(","))';
    const program = `import {spawnInteractive} from ${JSON.stringify(moduleUrl)};process.on('SIGINT',()=>{});await spawnInteractive(process.execPath,['-e',${JSON.stringify(child)}]);console.log('interactive-parent-done')`;
    const run = spawnCliInPty(
      ['--import', 'tsx', '--input-type=module', '-e', program],
      {
        cwd: process.cwd(),
        env: process.env as Record<string, string>,
        launcher: { executable: process.execPath },
      },
    );
    try {
      await run.waitFor('tty-ready:true,true,true');
      run.pty.write('\x03');
      expect((await expectCleanExit(run.exit)).exitCode).toBe(0);
      expect(run.output()).toContain('child-interrupted');
      expect(run.output()).toContain('interactive-parent-done');
    } finally {
      run.pty.kill();
    }
  });

  it.each(FRESH_MANUAL_IMPORTS)(
    `${journeyTitle('common.fresh-manual-import')} ($provider)`,
    async ({ provider, inputs, credential }) => {
      const testCase = ENVIRONMENT_IMPORTS.find(
        (candidate) => candidate.provider === provider,
      )!;
      const credentialName = `fresh-${provider.toLowerCase()}-${Date.now()}`;
      const { root, run, wizard } = await createRun({
        env: testCase.environment,
      });
      run.registerSecret(testCase.secret);
      try {
        await wizard.enterText('Name for this credential set:', credentialName);
        await wizard.selectChoice(
          'Select cloud provider:',
          provider,
          PROVIDERS,
        );
        await wizard.selectChoice(
          `How would you like to add ${testCase.label} credentials?`,
          testCase.choices[1],
          testCase.choices,
        );
        for (const input of inputs) {
          if (input.secret) await wizard.enterSecret(input.prompt, input.value);
          else await wizard.enterText(input.prompt, input.value);
        }
        const confirmation = `Save these ${testCase.label} credentials as "${credentialName}"?`;
        await run.waitFor(confirmation);
        expect(run.output()).toContain('Source: Manually entered');
        expect(await api.credentialExists(credentialName)).toBe(false);
        await wizard.confirm(confirmation);
        await wizard.expectSuccess(credentialName);
        expect(await api.storedCredential(credentialName)).toMatchObject(
          credential,
        );
        wizard.assertSecretNotPresent(testCase.secret);
        for (const input of inputs)
          if (input.secret) wizard.assertSecretNotPresent(input.value);
      } finally {
        await api.deleteCredential(credentialName).catch(() => undefined);
        await disposeRun(root, run);
      }
    },
  );

  describe.each(ENVIRONMENT_IMPORTS)('$label imports', (testCase) => {
    it.each([
      { action: 'approve', input: 'y\r', approved: true },
      { action: 'No', input: 'n\r', approved: false },
      { action: 'default Yes', input: '\r', approved: true },
      { action: 'Ctrl-C', input: '\x03', approved: false },
    ])(
      `${journeyTitle('common.import-consent')} ($action)`,
      async ({ input, approved }) => {
        const credentialName = `review-${testCase.provider.toLowerCase()}-${Date.now()}`;
        const { root, run, wizard } = await createRun({
          env: testCase.environment,
        });
        run.registerSecret(testCase.secret);
        try {
          await wizard.enterText(
            'Name for this credential set:',
            credentialName,
          );
          await wizard.selectChoice(
            'Select cloud provider:',
            testCase.provider,
            PROVIDERS,
          );
          const sourcePrompt = `How would you like to add ${testCase.label} credentials?`;
          await run.waitFor(sourcePrompt);
          expect(await api.credentialExists(credentialName)).toBe(false);
          await wizard.selectChoice(
            sourcePrompt,
            testCase.choices[0],
            testCase.choices,
          );

          const confirmation = `Save these ${testCase.label} credentials as "${credentialName}"?`;
          await run.waitFor(confirmation);
          expect(await api.credentialExists(credentialName)).toBe(false);
          const output = run.output();
          for (const detail of [
            `Provider: ${testCase.label}`,
            `Credential name: ${credentialName}`,
            ...testCase.review,
          ]) {
            expect(output).toContain(detail);
            expect(output.indexOf(detail)).toBeLessThan(
              output.indexOf(confirmation),
            );
          }
          run.pty.write(input);
          expect((await expectCleanExit(run.exit)).exitCode).toBe(0);
          if (approved) {
            expect(await api.storedCredential(credentialName)).toMatchObject(
              testCase.credential,
            );
            expect(run.output()).toContain(
              `Credentials "${credentialName}" saved successfully`,
            );
          } else {
            expect(await api.credentialExists(credentialName)).toBe(false);
          }
          wizard.assertSecretNotPresent(testCase.secret);
        } finally {
          await api.deleteCredential(credentialName).catch(() => undefined);
          await disposeRun(root, run);
        }
      },
    );

    it(journeyTitle('common.cancel-import-source'), async () => {
      const credentialName = `source-cancel-${testCase.provider.toLowerCase()}-${Date.now()}`;
      const { root, run, wizard } = await createRun({
        env: testCase.environment,
      });
      run.registerSecret(testCase.secret);
      try {
        await wizard.enterText('Name for this credential set:', credentialName);
        await wizard.selectChoice(
          'Select cloud provider:',
          testCase.provider,
          PROVIDERS,
        );
        await wizard.cancelAt(
          `How would you like to add ${testCase.label} credentials?`,
        );
        expect(await api.credentialExists(credentialName)).toBe(false);
        wizard.assertSecretNotPresent(testCase.secret);
      } finally {
        await disposeRun(root, run);
      }
    });

    it(journeyTitle('common.noninteractive-import'), async () => {
      const credentialName = `ci-${testCase.provider.toLowerCase()}-${Date.now()}`;
      const { root, run, wizard } = await createRun({
        env: { ...testCase.environment, CI: 'true' },
        args: [
          'credentials',
          'new',
          credentialName,
          '--provider',
          testCase.provider.toLowerCase(),
        ],
      });
      run.registerSecret(testCase.secret);
      try {
        await wizard.expectSuccess(credentialName);
        expect(await api.storedCredential(credentialName)).toMatchObject(
          testCase.credential,
        );
        expect(run.output()).not.toContain('How would you like');
        expect(run.output()).not.toContain('Save these');
        wizard.assertSecretNotPresent(testCase.secret);
      } finally {
        await api.deleteCredential(credentialName).catch(() => undefined);
        await disposeRun(root, run);
      }
    });
  });

  it(journeyTitle('common.name-validation'), async () => {
    const { root, run, wizard } = await createRun();
    try {
      await wizard.enterText('Name for this credential set:', '');
      await run.waitFor('Name required');
      run.pty.write('\x03');
      expect((await expectCleanExit(run.exit)).exitCode).toBe(0);
    } finally {
      await disposeRun(root, run);
    }
  });

  it(journeyTitle('common.cancel-name'), async () => {
    const { root, run, wizard } = await createRun();
    try {
      expect(
        (await wizard.cancelAt('Name for this credential set:')).exitCode,
      ).toBe(0);
    } finally {
      await disposeRun(root, run);
    }
  });

  it(journeyTitle('common.cancel-provider'), async () => {
    const credentialName = `cancel-provider-${Date.now()}`;
    const { root, run, wizard } = await createRun();
    try {
      await wizard.enterText('Name for this credential set:', credentialName);
      await wizard.cancelAt('Select cloud provider:');
      expect(await api.credentialExists(credentialName)).toBe(false);
    } finally {
      await disposeRun(root, run);
    }
  });

  it(journeyTitle('common.prompt-order'), async () => {
    const credentialName = `prompt-order-${Date.now()}`;
    const { root, run, wizard } = await createRun();
    try {
      await wizard.enterText('Name for this credential set:', credentialName);
      await wizard.selectChoice('Select cloud provider:', 'Lambda', PROVIDERS);
      await wizard.cancelAt('Lambda Labs API Key:');
      expect(await api.credentialExists(credentialName)).toBe(false);
    } finally {
      await disposeRun(root, run);
    }
  });

  describe(journeyTitle('common.cancel-manual-entry'), () => {
    it.each(MANUAL_PROMPT_CANCELLATIONS)(
      'cancels cleanly at $label entry',
      async ({ label, provider, inputs, cancelPrompt }) => {
        const credentialName = `cancel-${label.replace(/\W+/g, '-').toLowerCase()}-${Date.now()}`;
        const { root, run, wizard } = await createRun();
        try {
          await wizard.enterText(
            'Name for this credential set:',
            credentialName,
          );
          await wizard.selectChoice(
            'Select cloud provider:',
            provider,
            PROVIDERS,
          );
          if (provider === 'AWS') {
            await wizard.selectChoice(
              'How would you like to add AWS credentials?',
              'Enter existing access keys',
              NO_CLI_SOURCES[0].choices,
            );
          }
          if (provider === 'Azure') {
            await wizard.selectChoice(
              'How would you like to add Azure credentials?',
              'Enter existing service principal credentials',
              [
                'Enter existing service principal credentials',
                'Create a service principal with Azure CLI',
              ],
            );
          }
          if (provider === 'GCP') {
            await wizard.selectChoice(
              'How would you like to add GCP credentials?',
              'Upload existing service account key file',
              [
                'Upload existing service account key file',
                'Create a service account with gcloud',
              ],
            );
          }
          for (const input of inputs) {
            if (input.secret) {
              await wizard.enterSecret(input.prompt, input.value);
            } else {
              await wizard.enterText(input.prompt, input.value);
            }
          }
          await wizard.cancelAt(cancelPrompt);
          expect(await api.credentialExists(credentialName)).toBe(false);
        } finally {
          await disposeRun(root, run);
        }
      },
    );
  });

  it.each(NO_CLI_SOURCES)(
    `${journeyTitle('common.admin-handoff')} ($provider)`,
    async ({ provider, choices }) => {
      const credentialName = `handoff-${provider.toLowerCase()}-${Date.now()}`;
      const { root, run, wizard } = await createRun();
      try {
        await wizard.enterText('Name for this credential set:', credentialName);
        await wizard.selectChoice(
          'Select cloud provider:',
          provider,
          PROVIDERS,
        );
        await wizard.selectChoice(
          `How would you like to add ${provider} credentials?`,
          choices.at(-1)!,
          choices,
        );
        expect((await expectCleanExit(run.exit)).exitCode).toBe(0);
        const output = run.output();
        expect(output).toContain(`Ask your ${provider} administrator`);
        expect(output).toContain(ADMIN_REQUEST_LINK);
        expect(output).toContain('Nothing was saved.');
        expect(output).not.toContain('sudo');
        expect(output).not.toContain('Save these');
        expect(await api.credentialExists(credentialName)).toBe(false);
      } finally {
        await disposeRun(root, run);
      }
    },
  );

  it.each(NO_CLI_SOURCES.filter(({ provider }) => provider !== 'AWS'))(
    `${journeyTitle('common.missing-cli-hint')} ($provider)`,
    async ({ provider, choices, hint }) => {
      // GCP generation names allow at most 21 characters.
      const credentialName = `no-cli-${Date.now().toString().slice(-10)}`;
      const { root, run, wizard } = await createRun();
      try {
        await wizard.enterText('Name for this credential set:', credentialName);
        await wizard.selectChoice(
          'Select cloud provider:',
          provider,
          PROVIDERS,
        );
        await wizard.selectChoice(
          `How would you like to add ${provider} credentials?`,
          choices[1],
          choices,
        );
        expect((await expectCleanExit(run.exit)).exitCode).toBe(1);
        const output = run.output();
        expect(output).toContain(hint);
        expect(output).not.toContain('sudo');
        expect(await api.credentialExists(credentialName)).toBe(false);
      } finally {
        await disposeRun(root, run);
      }
    },
  );

  it(journeyTitle('lambda.manual-key'), async () => {
    const credentialName = `lambda-${Date.now()}`;
    const secret = 'lambda-secret-terminal-value';
    const { root, run, wizard } = await createRun();
    try {
      await wizard.enterText('Name for this credential set:', credentialName);
      await wizard.selectChoice('Select cloud provider:', 'Lambda', PROVIDERS);
      await wizard.enterSecret('Lambda Labs API Key:', secret);
      await wizard.confirm(
        `Save these Lambda Labs credentials as "${credentialName}"?`,
      );
      await wizard.expectSuccess(credentialName);
      wizard.assertSecretNotPresent(secret);
      expect(await api.storedCredential(credentialName)).toMatchObject({
        name: credentialName,
        cloudProvider: 'Lambda',
        apiKey: secret,
      });
    } finally {
      await api.deleteCredential(credentialName).catch(() => undefined);
      await disposeRun(root, run);
    }
  });

  it(journeyTitle('common.duplicate-name'), async () => {
    const credentialName = `duplicate-${Date.now()}`;
    const response = await fetch(
      `${api.url}/v1/credentials/${encodeURIComponent(credentialName)}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${API_TOKEN}`,
          [ANYCLOUD_CLIENT_VERSION_HEADER]: packageJson.version,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          cloudProvider: 'Lambda',
          apiKey: 'seed-secret',
        }),
      },
    );
    expect(response.ok).toBe(true);

    const { root, run, wizard } = await createRun();
    try {
      await wizard.enterText('Name for this credential set:', credentialName);
      await run.waitFor(`Credentials "${credentialName}" already exist`);
      expect((await expectCleanExit(run.exit)).exitCode).toBe(1);
      expect(run.output()).not.toContain('Select cloud provider:');
    } finally {
      await api.deleteCredential(credentialName).catch(() => undefined);
      await disposeRun(root, run);
    }
  });

  it(journeyTitle('common.save-rejected'), async () => {
    const credentialName = `save-rejected-${Date.now()}`;
    const secret = 'rejected-secret-terminal-value';
    api.queueSaveFault({
      kind: 'http',
      status: 422,
      message: 'Injected rejected save',
    });
    const { root, run, wizard } = await createRun();
    try {
      await wizard.enterText('Name for this credential set:', credentialName);
      await wizard.selectChoice('Select cloud provider:', 'Lambda', PROVIDERS);
      await wizard.enterSecret('Lambda Labs API Key:', secret);
      await wizard.confirm(
        `Save these Lambda Labs credentials as "${credentialName}"?`,
      );
      await run.waitFor('Injected rejected save', 30_000);
      expect((await expectCleanExit(run.exit)).exitCode).toBe(1);
      wizard.assertSecretNotPresent(secret);
      expect(await api.credentialExists(credentialName)).toBe(false);
    } finally {
      await disposeRun(root, run);
    }
  });
});

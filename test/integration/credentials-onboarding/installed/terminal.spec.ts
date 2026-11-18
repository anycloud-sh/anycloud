import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import {
  installedCliLauncher,
  spawnCliInPty,
  startCredentialApi,
  type CredentialApiFixture,
  WizardDriver,
} from '../harness.js';
import { journeyTitle } from '../journeys.js';
import { writeLocalApiToken } from '../../helpers/local-api-token.js';
import { childEnv } from '../../helpers/child-env.js';

const API_TOKEN = 'installed-wizard-token';
const binaryPath = process.env.ANYCLOUD_TEST_INSTALLED_BINARY;

let suiteRoot = '';
let api: CredentialApiFixture;

function installedEnvironment(root: string): Record<string, string> {
  const env = childEnv();
  for (const name of [
    'ANYCLOUD_CLOUD_PROVIDER',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_PROFILE',
    'AZURE_APPLICATION_ID',
    'AZURE_SECRET',
    'AZURE_SUBSCRIPTION_ID',
    'AZURE_DIRECTORY_ID',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GCP_PROJECT_ID',
    'GCP_CLIENT_EMAIL',
    'GCP_PRIVATE_KEY',
    'LAMBDA_API_KEY',
  ]) {
    delete env[name];
  }
  writeLocalApiToken(root);
  return {
    ...env,
    CI: 'false',
    HOME: root,
    ANYCLOUD_DIR: root,
    API_URL: api.url,
    GITHUB_TOKEN: API_TOKEN,
  };
}

beforeAll(async () => {
  if (!binaryPath) {
    throw new Error(
      'ANYCLOUD_TEST_INSTALLED_BINARY must point to an installer-produced binary.',
    );
  }
  if (resolve(binaryPath).startsWith(`${resolve('.')}/`)) {
    throw new Error(
      'Installed wizard test must run a binary outside the repo.',
    );
  }
  suiteRoot = await mkdtemp(join(tmpdir(), 'anycloud-installed-wizard-api-'));
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

describe('installer-produced credential wizard', () => {
  it(journeyTitle('common.installed-artifact'), async () => {
    const root = await mkdtemp(join(tmpdir(), 'anycloud-installed-wizard-'));
    const credentialName = `installed-${Date.now()}`;
    const secret = 'installed-artifact-secret-value';
    const env = installedEnvironment(root);
    const run = spawnCliInPty(['credentials', 'new'], {
      cwd: root,
      env,
      launcher: installedCliLauncher(binaryPath!),
    });
    const wizard = new WizardDriver(run);
    try {
      await wizard.enterText('Name for this credential set:', credentialName);
      await wizard.selectChoice('Select cloud provider:', 'Lambda', [
        'AWS',
        'Azure',
        'GCP',
        'Lambda',
      ]);
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
    {
      title: journeyTitle('aws.installed-generation-target-required'),
      provider: 'aws',
      guidance: 'AWS --generate requires --profile and --account-id',
    },
    {
      title: journeyTitle('gcp.installed-generation-target-required'),
      provider: 'gcp',
      guidance: 'GCP --generate requires --gcloud-account and --project-id',
    },
  ])('$title', async ({ provider, guidance }) => {
    const root = await mkdtemp(
      join(tmpdir(), `anycloud-installed-${provider}-`),
    );
    const credentialName = `installed-${provider}-${String(Date.now()).slice(-6)}`;
    const env = installedEnvironment(root);
    env.AWS_ACCESS_KEY_ID = 'POISONED-AMBIENT-AWS-KEY';
    env.GOOGLE_APPLICATION_CREDENTIALS = join(root, 'missing-gcp-key.json');
    const run = spawnCliInPty(
      [
        'credentials',
        'new',
        credentialName,
        '--provider',
        provider,
        '--generate',
      ],
      {
        cwd: root,
        env,
        launcher: installedCliLauncher(binaryPath!),
      },
    );
    run.registerSecret('POISONED-AMBIENT-AWS-KEY');
    try {
      expect((await run.exit).exitCode).toBe(1);
      expect(run.output()).toContain(
        provider === 'aws'
          ? 'AWS --generate requires --profile and --account-id'
          : 'GCP --generate requires --gcloud-account and --project-id',
      );
      expect(run.output()).toContain(guidance);
      expect(run.containsRaw('POISONED-AMBIENT-AWS-KEY')).toBe(false);
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
});

#!/usr/bin/env node

import assert from 'assert/strict';
import { fork } from 'child_process';
import { once } from 'events';
import { lstat, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { generateAzureServicePrincipal } from '../../../../src/cli/services/credential-bootstrap/azure.js';
import { isRecord, parseJsonRecord } from '../../helpers/json.js';
import { retryUntilDeadline } from '../common/deadline-retry.js';
import {
  createAzureOnboardingRunContainer,
  createBootstrapAzureContext,
  readAzureOnboardingSecrets,
  requireAzureOnboardingStorage,
  runAdminAzure,
} from './admin.js';
import { readAzureOnboardingRunLocator } from './run-authority.js';

const READY = 'azure-onboarding-runner-loss-ready';
const secretsToRedact: string[] = [];

async function creator(): Promise<void> {
  if (!process.send) throw new Error('Azure creator requires controller IPC.');
  const locator = readAzureOnboardingRunLocator();
  const secrets = readAzureOnboardingSecrets();
  secretsToRedact.push(secrets.secret);
  const bootstrap = await createBootstrapAzureContext(secrets);
  await requireAzureOnboardingStorage(bootstrap);
  process.env.AZURE_CONFIG_DIR = bootstrap.configDir;
  const generated = await generateAzureServicePrincipal(
    secrets.subscriptionId,
    locator.credentialName,
    { operationId: locator.operationId },
  );
  secretsToRedact.push(generated.secret);
  const context = await retryUntilDeadline(
    async () => {
      const generatedContext = await createBootstrapAzureContext({
        ...secrets,
        ...generated,
      });
      await requireAzureOnboardingStorage(generatedContext);
      return generatedContext;
    },
    {
      deadline: Date.now() + 10 * 60_000,
      initialDelayMs: 500,
      maxDelayMs: 15_000,
    },
  );
  const account = parseJsonRecord(
    await runAdminAzure(context, ['account', 'show', '--output', 'json']),
    'Generated Azure account',
  );
  assert.equal(account.id, secrets.subscriptionId);
  assert.equal(account.tenantId, generated.tenantId);
  assert.ok(isRecord(account.user));
  assert.equal(account.user.name, generated.applicationId);
  assert.equal(account.user.type, 'servicePrincipal');
  await createAzureOnboardingRunContainer(context, locator);
  // No generated secret or file locator leaves this process.
  process.send(READY);
  setInterval(() => {}, 60_000);
}

async function createAndDestroyRunner(): Promise<void> {
  const locator = readAzureOnboardingRunLocator();
  const root = await mkdtemp(join(tmpdir(), 'anycloud-azure-lost-runner-'));
  // Keep only bootstrap credentials, executable lookup, and the workflow run key.
  const retained =
    'PATH LANG LC_ALL LC_CTYPE TZ RUNNER_TRACKING_ID HTTP_PROXY HTTPS_PROXY NO_PROXY AZURE_SUBSCRIPTION_ID AZURE_TENANT_ID AZURE_DIRECTORY_ID AZURE_CLIENT_ID AZURE_APPLICATION_ID AZURE_CLIENT_SECRET AZURE_SECRET GITHUB_ACTIONS GITHUB_REPOSITORY GITHUB_RUN_ID GITHUB_RUN_ATTEMPT';
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    retained
      .split(' ')
      .flatMap((name) =>
        process.env[name] === undefined ? [] : [[name, process.env[name]]],
      ),
  );
  for (const name of [
    'HOME',
    'TMPDIR',
    'TMP',
    'TEMP',
    'AZURE_CONFIG_DIR',
    'ANYCLOUD_DIR',
    'XDG_CONFIG_HOME',
    'XDG_CACHE_HOME',
    'XDG_DATA_HOME',
  ])
    env[name] = root;
  env.SQLITE_PATH = join(root, 'api.db');
  env.AZURE_CORE_ONLY_SHOW_ERRORS = 'true';
  env.PYTHONDONTWRITEBYTECODE = '1';
  const child = fork(fileURLToPath(import.meta.url), ['creator'], {
    execArgv: ['--import', import.meta.resolve('tsx')],
    cwd: root,
    env,
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const exited = once(child, 'exit').catch(() => {});
  let diagnostics = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    diagnostics = (diagnostics + chunk.toString()).slice(-16_000);
  });
  const failures: unknown[] = [];
  let timeout: NodeJS.Timeout | undefined;
  try {
    await new Promise<void>((done, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) =>
        reject(
          new Error(
            `Azure creator exited before readiness (${code ?? signal}): ${diagnostics}`,
          ),
        ),
      );
      child.once('message', (message: unknown) =>
        message === READY
          ? done()
          : reject(new Error('Azure creator sent an unexpected handoff.')),
      );
      timeout = setTimeout(
        () => reject(new Error('Azure creator exceeded 15 minutes.')),
        15 * 60_000,
      );
    });
  } catch (error) {
    failures.push(error);
  } finally {
    clearTimeout(timeout);
  }
  try {
    if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
    await exited;
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
    await assert.rejects(lstat(root), { code: 'ENOENT' });
  } catch (error) {
    failures.push(error);
  }
  if (failures.length)
    throw new AggregateError(failures, 'Azure runner-loss creation failed.', {
      cause: failures[0],
    });
  console.log(
    `Azure creator killed and every creator file removed for ${locator.operationId}; awaiting independent recovery job.`,
  );
}

function failureMessage(error: unknown): string {
  const message =
    error instanceof AggregateError
      ? `${error.message} ${error.errors.map(failureMessage).join('; ')}`
      : error instanceof Error
        ? error.message
        : String(error);
  return secretsToRedact.reduce(
    (value, secret) => value.split(secret).join('[REDACTED]'),
    message,
  );
}

async function main(): Promise<void> {
  if (process.env.GITHUB_ACTIONS !== 'true')
    throw new Error(
      'Run this qualification through the controlled GitHub workflow.',
    );
  if (process.argv[2] === 'creator') await creator();
  else if (process.argv[2] === 'create') await createAndDestroyRunner();
  else throw new Error('Pass create to run the Azure creator job.');
}

main().catch((error: unknown) => {
  console.error(failureMessage(error));
  process.exitCode = 1;
});

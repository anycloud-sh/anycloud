#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { join } from 'node:path';

import {
  createBootstrapGcloudContext,
  createGCPImportFixture,
  disposeBootstrapGcloudContext,
} from './admin.js';

function requiredFlag(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`${name} requires a value.`);
  return value;
}

async function runCredentialImport(
  credentialName: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        join(process.cwd(), 'dist/cli/index.js'),
        'credentials',
        'new',
        credentialName,
        '--provider',
        'gcp',
      ],
      { env: environment, stdio: 'inherit' },
    );
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else {
        reject(
          new Error(
            `GCP credential import exited with ${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}.`,
          ),
        );
      }
    });
  });
}

async function main(): Promise<void> {
  const credentialName = requiredFlag('--credential-name');
  const context = await createBootstrapGcloudContext();
  try {
    const fixture = await createGCPImportFixture(
      context,
      credentialName,
      join(context.rootDir, 'import-key.json'),
      'bucket',
    );
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      CI: 'true',
      GCP_CLIENT_EMAIL: fixture.clientEmail,
      GCP_PRIVATE_KEY: fixture.privateKey,
      GCP_PROJECT_ID: fixture.projectId,
    };
    for (const name of [
      'GOOGLE_APPLICATION_CREDENTIALS',
      'GOOGLE_GHA_CREDS_PATH',
      'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE',
    ]) {
      delete environment[name];
    }
    await runCredentialImport(credentialName, environment);
  } finally {
    await disposeBootstrapGcloudContext(context);
  }
}

main().catch((error) => {
  console.error(
    `GCP bucket credential fixture failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});

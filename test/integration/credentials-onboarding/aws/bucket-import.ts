#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  createAWSImportFixture,
  createBootstrapAWSContext,
  disposeBootstrapAWSContext,
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
        'aws',
        '--profile',
        'import',
      ],
      { env: environment, stdio: 'inherit' },
    );
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else {
        reject(
          new Error(
            `AWS credential import exited with ${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}.`,
          ),
        );
      }
    });
  });
}

async function main(): Promise<void> {
  const credentialName = requiredFlag('--credential-name');
  const context = await createBootstrapAWSContext();
  try {
    const fixture = await createAWSImportFixture(
      context,
      credentialName,
      'bucket',
    );
    const credentialsPath = join(context.rootDir, 'import-credentials');
    const configPath = join(context.rootDir, 'import-config');
    await writeFile(
      credentialsPath,
      `[import]\naws_access_key_id = ${fixture.accessKeyId}\naws_secret_access_key = ${fixture.secretAccessKey}\n`,
      { mode: 0o600 },
    );
    await writeFile(configPath, '[profile import]\nregion = us-east-1\n', {
      mode: 0o600,
    });

    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      CI: 'true',
      AWS_CONFIG_FILE: configPath,
      AWS_EC2_METADATA_DISABLED: 'true',
      AWS_PROFILE: 'import',
      AWS_SHARED_CREDENTIALS_FILE: credentialsPath,
    };
    for (const name of [
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
      'AWS_WEB_IDENTITY_TOKEN_FILE',
      'AWS_ROLE_ARN',
      'AWS_ROLE_SESSION_NAME',
      'AWS_CONTAINER_CREDENTIALS_FULL_URI',
      'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
      'AWS_CONTAINER_AUTHORIZATION_TOKEN',
    ]) {
      delete environment[name];
    }
    await runCredentialImport(credentialName, environment);
  } finally {
    await disposeBootstrapAWSContext(context);
  }
}

main().catch((error) => {
  console.error(
    `AWS bucket credential fixture failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});

#!/usr/bin/env tsx
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOCAL_SMOLVM_CONTRACT } from '../../src/api/services/gateways/local-smolvm-contract.js';
import { buildLocalSmolvmRuntimeSetupScript } from './local-smolvm-runtime.js';

const tempDir = mkdtempSync(join(tmpdir(), 'anycloud-local-smolvm-'));
const scriptPath = join(tempDir, 'setup.sh');

try {
  writeFileSync(scriptPath, buildLocalSmolvmRuntimeSetupScript(), {
    mode: 0o700,
  });
  console.log(
    `Setting up smolvm ${LOCAL_SMOLVM_CONTRACT.supportedVersion} test runtime on ${LOCAL_SMOLVM_CONTRACT.host}:${LOCAL_SMOLVM_CONTRACT.port}`,
  );

  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  if (isRoot) {
    throw new Error(
      'Local smolvm test setup must run as an unprivileged user, not root.',
    );
  }
  if (!hasSudo()) {
    throw new Error(
      'Local smolvm test setup needs sudo only to prepare its host directories and service.',
    );
  }

  const result = spawnSync('/bin/sh', [scriptPath], {
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
} finally {
  rmSync(tempDir, { force: true, recursive: true });
}

function hasSudo(): boolean {
  return existsSync('/usr/bin/sudo') || existsSync('/bin/sudo');
}

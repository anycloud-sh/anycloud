import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

import { errorMessage } from '../shared/log-diagnostics.js';

import {
  HOST_STEP_ENV,
  HOST_STEP_RUNNER,
} from './services/system-release/host-step.js';
import { managementKubernetesReconfigureScript } from './services/system-release/management-host.js';

/**
 * The host-step Job's Pod program (`services/system-release/host-step.ts`).
 * It renders the step's script, so a K3s step applies the configuration of
 * this image's release, then runs it as root on the host through the runner
 * and leaves the runner's report as the Pod's termination message.
 */
function required(name: string, value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${name} is required`);
  return trimmed;
}

function script(): string {
  const kind = required(HOST_STEP_ENV.kind, process.env.ANYCLOUD_HOST_STEP);
  if (kind !== 'kubernetes') throw new Error(`Unknown host step ${kind}`);
  return managementKubernetesReconfigureScript({
    publicIp: required(
      HOST_STEP_ENV.publicIp,
      process.env.ANYCLOUD_MANAGEMENT_PUBLIC_IP,
    ),
    issuerUrl: required(
      HOST_STEP_ENV.issuerUrl,
      process.env.ANYCLOUD_ISSUER_URL,
    ),
  });
}

function main(): number {
  const run = spawnSync(
    'nsenter',
    [
      '-t',
      '1',
      '-m',
      '--',
      '/bin/bash',
      '-c',
      HOST_STEP_RUNNER,
      'host-step-runner',
      required(HOST_STEP_ENV.unit, process.env.ANYCLOUD_HOST_STEP_UNIT),
    ],
    { input: script(), encoding: 'utf8' },
  );
  if (run.error) throw run.error;
  if (run.status !== 0) {
    throw new Error(
      `the host step runner exited ${run.status ?? run.signal}: ${run.stderr.trim()}`,
    );
  }
  writeFileSync('/dev/termination-log', run.stdout);
  process.stdout.write(run.stdout);
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  const message = errorMessage(error);
  writeFileSync('/dev/termination-log', message.slice(0, 1_000));
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, renameSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import {
  SSHManager,
  sshRuntimeDirectory,
} from '/app/dist/api/services/gateways/ssh.js';
import { channelBoundCommand } from '/app/dist/api/services/gateways/channel-bound-command.js';
import { runSshProcess } from '/app/dist/api/services/gateways/ssh-process.js';

const host = process.env.SSH_REAPING_HOST ?? 'ssh-reaping-server';
const cycles = Number(process.env.SSH_REAPING_CYCLES ?? 20);
const privateKey = readFileSync('/fixture/id_ed25519', 'utf8');

if (!Number.isInteger(cycles) || cycles < 1) {
  throw new Error(`SSH_REAPING_CYCLES must be a positive integer: ${cycles}`);
}

function controlSockets() {
  return readdirSync(sshRuntimeDirectory()).filter((name) =>
    name.startsWith('cm-'),
  );
}

async function waitFor(check, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error(`${label} did not finish within ${timeoutMs}ms`);
}

/**
 * The socket check is deliberately synchronous. Awaiting the close is supposed
 * to be enough on its own, so polling here would pass just as well against a
 * promise that resolves while OpenSSH is still tearing the master down.
 */
async function closeMasters(label) {
  await SSHManager.closeConnection(host, 22);
  const leaked = controlSockets();
  if (leaked.length > 0) {
    throw new Error(
      `${label} left control sockets behind: ${leaked.join(', ')}`,
    );
  }
}

async function main() {
  // This runs only in the disposable API-image fixture. A launch failure must
  // retain its error code without including private command arguments.
  renameSync('/usr/bin/ssh', '/usr/bin/ssh-unavailable');
  try {
    await assert.rejects(
      runSshProcess(['private-command-argument'], { ignoreStdin: true }),
      (error) =>
        error.code === 'ENOENT' &&
        !error.message.includes('private-command-argument'),
    );
  } finally {
    renameSync('/usr/bin/ssh-unavailable', '/usr/bin/ssh');
  }

  const ssh = new SSHManager(host, privateKey, 22);
  await waitFor(() => ssh.ping(), 'real sshd readiness', 30_000);
  await closeMasters('initial master close');

  for (let index = 0; index < cycles; index += 1) {
    const result = await ssh.exec(`printf reaping-cycle-${index}`, 1);
    if (result.stdout !== `reaping-cycle-${index}`) {
      throw new Error(`Unexpected SSH output in cycle ${index}`);
    }
    await closeMasters(`master close ${index + 1}`);
  }

  let readyOutput = '';
  const interrupted = ssh
    .execStream(channelBoundCommand('printf helper-crash-ready; sleep 600'), {
      onStdout: (chunk) => {
        readyOutput += chunk.toString();
      },
    })
    .catch((error) => error);
  await waitFor(
    () => readyOutput.includes('helper-crash-ready'),
    'helper crash command startup',
  );
  const helpers = readdirSync('/proc').filter((name) => {
    if (!/^\d+$/.test(name)) return false;
    try {
      const status = readFileSync(`/proc/${name}/status`, 'utf8');
      const args = readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0');
      return (
        Number(status.match(/^PPid:\s+(\d+)/m)?.[1]) === process.pid &&
        args.some((arg) => arg.endsWith('/ssh-process-helper.js'))
      );
    } catch {
      return false;
    }
  });
  if (helpers.length !== 1)
    throw new Error(`Expected one owned SSH helper, found ${helpers.length}`);
  process.kill(Number(helpers[0]), 'SIGKILL');
  const outcome = await interrupted;
  if (
    !(outcome instanceof Error) ||
    !outcome.message.includes('SSH process helper')
  ) {
    throw new Error('Helper crash did not fail its active SSH stream');
  }
  await waitFor(() => ssh.ping(), 'replacement helper readiness');
  await closeMasters('master close after helper crash');

  // Give orphaned clients and the last master time to become observable to Tini.
  await delay(500);
  console.log(
    JSON.stringify({
      event: 'ssh-reaping-ready',
      cycles,
      helperCrashes: 1,
      privateLaunchErrors: 1,
    }),
  );
  setInterval(() => undefined, 60_000);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});

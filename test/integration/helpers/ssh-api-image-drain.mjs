import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { SSHManager } from '/app/dist/api/services/gateways/ssh.js';

const host = process.env.SSH_DRAIN_HOST ?? 'ssh-drain-server';
const privateKey = readFileSync('/fixture/id_ed25519', 'utf8');
const TOKEN = 'drain-survived';
/** Long enough that the shutdown signal always lands while the commands run. */
const COMMAND_SECONDS = 8;

function emit(event, fields = {}) {
  console.log(JSON.stringify({ event, ...fields }));
}

function failure(error) {
  return {
    status: 'failed',
    detail: String(error?.message ?? error).slice(0, 200),
  };
}

async function main() {
  const ssh = new SSHManager(host, privateKey, 22);

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !(await ssh.ping())) await delay(200);

  // The path every monitor takes. A client the shutdown kills exits 255 with
  // its control master still alive, which resolves as an ordinary nonzero exit
  // — indistinguishable from the remote command itself failing, so a caller
  // would fail a workload over a command that was merely interrupted.
  const execPath = ssh
    .exec(`printf running-exec; sleep ${COMMAND_SECONDS}; printf ${TOKEN}`)
    .then((result) => ({
      status: result.stdout.endsWith(TOKEN) ? 'completed' : 'unexpected',
      code: result.code,
      stdout: result.stdout,
    }))
    .catch(failure);

  let streamed = '';
  let markRunning;
  const running = new Promise((resolve) => {
    markRunning = resolve;
  });

  // `execStream` carries no retry budget, so an aborted command stays aborted
  // rather than being run a second time by the transport.
  const streamPath = ssh
    .execStream(`printf running; sleep ${COMMAND_SECONDS}; printf ${TOKEN}`, {
      onStdout: (chunk) => {
        streamed += chunk.toString();
        if (streamed.includes('running')) markRunning();
      },
    })
    .then((code) => ({
      status:
        code === 0 && streamed.endsWith(TOKEN) ? 'completed' : 'unexpected',
      code,
      stdout: streamed,
    }))
    .catch(failure);

  const both = Promise.all([execPath, streamPath]);

  // Announce readiness only once the VM has produced output. Commands that had
  // not started yet would survive the signal for the wrong reason, and the test
  // would pass without ever putting anything at risk.
  const reached = await Promise.race([
    running.then(() => 'running'),
    both.then(() => 'settled'),
  ]);
  if (reached === 'settled') {
    const [exec, stream] = await both;
    emit('ssh-drain-result', { exec, stream });
    process.exit(1);
  }
  emit('ssh-drain-in-flight');

  process.on('SIGTERM', async () => {
    emit('ssh-drain-signalled');
    const [exec, stream] = await both;
    emit('ssh-drain-result', { exec, stream });
    process.exit(0);
  });

  // Nothing signalled the probe: report it rather than timing out silently.
  await delay(60_000);
  emit('ssh-drain-result', { status: 'never-signalled' });
  process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});

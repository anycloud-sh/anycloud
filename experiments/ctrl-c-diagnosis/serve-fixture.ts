import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startFixture } from './fixture.js';

const captureDirectory = process.argv[2];
if (!captureDirectory)
  throw new Error(
    'A capture directory is required. Run capture.sh to start a capture.',
  );
const fixture = await startFixture();
const session = {
  pid: process.pid,
  id: fixture.id,
  env: fixture.env,
  directory: fixture.directory,
  startedAt: new Date().toISOString(),
};
writeFileSync(
  join(captureDirectory, 'ready.json'),
  JSON.stringify(session, null, 2) + '\n',
);
console.log(`Diagnostic fixture ready at ${fixture.url}`);
let closing = false;
async function close(reason = 'observer stopped') {
  if (closing) return;
  closing = true;
  const state = await fixture.checkState();
  console.log(JSON.stringify(state));
  await fixture.close();
  writeFileSync(
    join(captureDirectory, 'complete.json'),
    JSON.stringify(
      { at: Date.now(), reason, state, fixtureDirectory: fixture.directory },
      null,
      2,
    ) + '\n',
  );
  process.exit(0);
}
process.on('SIGTERM', () => {
  void close();
});
process.on('SIGINT', () => {
  void close();
});

const request = JSON.parse(
  readFileSync(join(captureDirectory, 'request.json'), 'utf8'),
) as { tty: string; executable: string; args: string[] };
const observations = join(captureDirectory, 'terminal.jsonl');
const started = Date.now();
const pidFile = join(captureDirectory, 'cli.pid');
let identity: string | undefined;
let previous = '';
let heartbeat = 0;
while (!closing) {
  if (Date.now() - started > 10 * 60 * 1000)
    await close('capture time limit reached; fixture closed');
  if (!existsSync(pidFile)) {
    if (Date.now() - started > 60000) await close('CLI did not start');
    await delay(200);
    continue;
  }
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  if (!Number.isSafeInteger(pid) || pid <= 1)
    throw new Error('Invalid capture PID');
  let currentIdentity: string;
  try {
    currentIdentity = execFileSync(
      '/bin/ps',
      ['-p', String(pid), '-o', 'lstart=,command='],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 1000,
      },
    ).trim();
  } catch {
    await close('CLI exited; record exit status in the launching shell');
    break;
  }
  if (!identity && !currentIdentity.includes(request.executable)) {
    // The shell writes its PID immediately before exec; wait for the CLI.
    await delay(50);
    continue;
  }
  if (identity && currentIdentity !== identity) {
    await close('captured PID changed identity');
    break;
  }
  if (!identity) {
    identity = currentIdentity;
    writeFileSync(
      join(captureDirectory, 'identity.json'),
      JSON.stringify({ pid, identity }, null, 2) + '\n',
    );
    try {
      const descriptors = execFileSync(
        '/usr/sbin/lsof',
        ['-a', '-p', String(pid), '-d', '0,1,2', '-F', 'fnt'],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 1500,
        },
      );
      writeFileSync(join(captureDirectory, 'descriptors.txt'), descriptors);
    } catch (error) {
      writeFileSync(join(captureDirectory, 'descriptors.txt'), String(error));
    }
  }
  const read = (command: string, args: string[]) => {
    try {
      return execFileSync(command, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 1000,
      }).trim();
    } catch (error) {
      return String(error);
    }
  };
  const snapshot = {
    process: read('/bin/ps', [
      '-p',
      String(pid),
      '-o',
      'pid=,ppid=,pgid=,tpgid=,stat=,tty=,comm=',
    ]),
    mode: read('/bin/stty', ['-f', request.tty, '-a']),
  };
  const encoded = JSON.stringify(snapshot);
  if (encoded !== previous || Date.now() - heartbeat > 1000) {
    appendFileSync(
      observations,
      JSON.stringify({ at: Date.now(), ...snapshot }) + '\n',
    );
    previous = encoded;
    heartbeat = Date.now();
  }
  await delay(200);
}

import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import {
  createWriteStream,
  copyFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHealthSampler, summarizeHealth } from './metrics.mjs';

export async function runChild({
  runDir,
  copyFrom,
  healthTimeoutMs = 1000,
  timeoutMs = 600_000,
  expectedExitCode = 0,
  cipherKey = 'a'.repeat(64),
  childEntry = new URL('./child.mjs', import.meta.url),
  registerEntry = new URL('./register.mjs', import.meta.url),
  ...options
}) {
  mkdirSync(runDir, { recursive: false });
  const databasePath = path.join(runDir, 'api.db');
  if (copyFrom) {
    copyFileSync(copyFrom, databasePath);
    // A killed SQLite owner may leave a hot journal or WAL. Preserve it so
    // reopening exercises recovery instead of manufacturing a clean database.
    for (const suffix of ['-journal', '-wal', '-shm']) {
      if (existsSync(copyFrom + suffix)) {
        copyFileSync(copyFrom + suffix, databasePath + suffix);
      }
    }
  }
  const log = createWriteStream(path.join(runDir, 'child.log'));
  const child = fork(fileURLToPath(childEntry), [JSON.stringify(options)], {
    cwd: options.buildDir,
    execArgv: registerEntry ? ['--import', fileURLToPath(registerEntry)] : [],
    env: {
      PATH: process.env.PATH,
      IS_TEST: 'true',
      ANYCLOUD_DIR: runDir,
      SQLITE_PATH: databasePath,
      CIPHER_KEY: cipherKey,
      ANYCLOUD_DB_SLOW_QUERY_MS: '60000',
      ANYCLOUD_BENCH_BUILD_DIR: options.buildDir,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  let sampler;
  let warmup;
  let result;
  let failure;
  const interrupt = () => {
    failure = 'Benchmark driver interrupted';
    child.kill('SIGKILL');
  };
  const stopChild = () => child.kill('SIGKILL');
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  process.once('exit', stopChild);
  const deadline = setTimeout(() => {
    failure = 'Child exceeded ' + timeoutMs + 'ms';
    child.kill('SIGKILL');
  }, timeoutMs);
  const send = (message) => {
    if (!child.connected) return;
    child.send(message, (error) => {
      if (error) {
        failure = error.message;
        child.kill('SIGKILL');
      }
    });
  };
  child.on('message', (message) => {
    if (message.kind === 'ready') {
      sampler = startHealthSampler(
        'http://127.0.0.1:' + message.port + '/health',
        { timeoutMs: healthTimeoutMs },
      );
      warmup = setTimeout(() => send({ kind: 'start' }), 500);
    } else if (message.kind === 'started') {
      sampler.setPhase('work');
      send({ kind: 'go' });
    } else if (message.kind === 'work-finished') {
      sampler.setPhase('recovery');
      // Keep the API alive, without validation work competing with requests
      // already offered. Shutdown must not manufacture connection failures.
      sampler.stop().then(
        () => send({ kind: 'health-drained' }),
        (error) => {
          failure = error.stack ?? String(error);
          child.kill('SIGKILL');
        },
      );
    } else if (message.kind === 'result') {
      result = message.result;
    } else if (message.kind === 'failure') {
      failure = message.error;
    }
  });
  let code;
  try {
    // `close` also waits for stdout/stderr, preserving the final log records.
    [code] = await once(child, 'close');
  } catch (error) {
    failure = error.stack ?? String(error);
    child.kill('SIGKILL');
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    process.removeListener('exit', stopChild);
    clearTimeout(deadline);
    clearTimeout(warmup);
    const healthSamples = (await sampler?.stop()) ?? [];
    writeFileSync(
      path.join(runDir, 'health.json'),
      JSON.stringify(healthSamples, null, 2) + '\n',
    );
    if (result && options.action === 'measure') {
      result.health = summarizeHealth(healthSamples);
      result.healthCoarse = summarizeHealth(healthSamples, healthTimeoutMs);
      // Transport failures in warmup/recovery are separate from work latency.
      result.healthPhases = Object.fromEntries(
        ['warmup', 'work', 'recovery'].map((phase) => [
          phase,
          healthSamples.filter((sample) => sample.phase === phase).length,
        ]),
      );
    }
    log.end();
    await once(log, 'finish');
    writeFileSync(
      path.join(runDir, 'result.json'),
      JSON.stringify({ ...result, exitCode: code, failure }, null, 2) + '\n',
    );
  }
  assert.equal(
    code,
    expectedExitCode,
    failure ?? 'Child failed; see ' + runDir,
  );
  assert(!failure, failure);
  if (expectedExitCode !== 0) return { databasePath, exitCode: code };
  assert(result, 'Child exited without a result: ' + runDir);
  return { ...result, databasePath };
}

import { spawn } from 'node-pty';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { stripVTControlCharacters as strip } from 'node:util';
import { startFixture } from './fixture.ts';

const root = resolve(import.meta.dirname, '../..');
const evidence = join(root, '.context/ctrl-c-diagnosis');
const traced = process.argv.includes('--traced');
const manifest = JSON.parse(
  readFileSync(
    join(evidence, traced ? 'manifest-traced.json' : 'manifest.json'),
    'utf8',
  ),
);
const option = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};
const variantFilter = option('variant', 'all');
const caseFilter = option('case', 'all');
const repeats = Number(option('repeat', '1'));
const label = option('label', `baseline-${Date.now()}`);
const resultsDirectory = mkdtempSync(join(evidence, `${label}-`));
process.stderr.write(`Results: ${resultsDirectory}\n`);
writeFileSync(
  join(resultsDirectory, 'manifest.json'),
  JSON.stringify(manifest, null, 2) + '\n',
);
const quote = (s) => "'" + String(s).replaceAll("'", "'\\''") + "'";
const variants = manifest.artifacts.flatMap((artifact) =>
  artifact.entry
    ? [
        {
          name: `${artifact.variant}-node`,
          executable: process.execPath,
          args: [artifact.entry],
        },
        {
          name: `${artifact.variant}-bun`,
          executable: artifact.binary,
          args: [],
        },
      ]
    : [{ name: artifact.variant, executable: artifact.binary, args: [] }],
);
const fixture = await startFixture();
const cases = [
  'status-id',
  'status-external',
  'status-picker-watch',
  'status-picker-abort',
  'list-picker-abort',
  'status-request',
  'logs-id',
];
const results = [];
function terminalSnapshot(term, pid) {
  const read = (executable, args) => {
    try {
      return execFileSync(executable, args, {
        encoding: 'utf8',
        timeout: 1500,
      }).trim();
    } catch (error) {
      return String(error);
    }
  };
  return {
    at: Date.now(),
    tty: term.ptsName,
    mode: read('/bin/stty', ['-f', term.ptsName, '-a']),
    process: read('/bin/ps', [
      '-o',
      'pid=,ppid=,pgid=,tpgid=,stat=,comm=',
      '-p',
      String(pid),
    ]),
    ttyProcesses: read('/bin/ps', [
      '-o',
      'pid=,ppid=,pgid=,tpgid=,stat=,comm=',
      '-t',
      basename(term.ptsName),
    ]),
  };
}
try {
  for (const variant of variants.filter(
    (v) => variantFilter === 'all' || variantFilter === v.name,
  )) {
    for (const scenario of cases.filter(
      (c) => caseFilter === 'all' || caseFilter.split(',').includes(c),
    )) {
      for (let repeat = 1; repeat <= repeats; repeat++) {
        const name = `${variant.name}-${scenario}-${repeat}`;
        const pidFile = join(resultsDirectory, `${name}.pid`);
        const result = {
          name,
          variant: variant.name,
          scenario,
          repeat,
          snapshots: [],
          start: Date.now(),
        };
        const term = spawn('/bin/zsh', ['-f', '-i'], {
          cwd: fixture.directory,
          name: 'xterm-256color',
          cols: 150,
          rows: 35,
          env: {
            PATH: process.env.PATH,
            TERM: 'xterm-256color',
            LANG: 'en_US.UTF-8',
            SHELL: '/bin/zsh',
            PS1: 'DIAG_PROMPT_EXIT:%?> ',
            HISTFILE: '/dev/null',
          },
        });
        let output = '';
        let pid;
        term.onData((data) => {
          output += data;
        });
        const until = async (predicate, description, timeout = 15000) => {
          const deadline = Date.now() + timeout;
          while (!predicate()) {
            if (Date.now() > deadline)
              throw new Error(`Timeout: ${description}`);
            await delay(20);
          }
        };
        const waitFor = (text, from = 0) =>
          until(() => strip(output.slice(from)).includes(text), text);
        fixture.setMode({});
        try {
          await waitFor('DIAG_PROMPT_EXIT:');
          const args =
            scenario === 'list-picker-abort'
              ? ['list']
              : scenario.startsWith('logs')
                ? ['logs', fixture.id, '--follow']
                : [
                    'status',
                    ...(scenario.includes('picker') ? [] : [fixture.id]),
                    '--watch',
                    '--interval',
                    '1',
                  ];
          const command = [
            '/bin/sh',
            join(root, 'experiments/ctrl-c-diagnosis/launch.sh'),
            pidFile,
            '/usr/bin/env',
            ...Object.entries({
              ...fixture.env,
              ...(traced
                ? {
                    CTRL_C_DIAG_TRACE: join(
                      resultsDirectory,
                      `${name}.trace.jsonl`,
                    ),
                  }
                : {}),
            }).map(([key, value]) => `${key}=${value}`),
            variant.executable,
            ...variant.args,
            ...args,
          ]
            .map(quote)
            .join(' ');
          const commandAt = output.length;
          term.write(`${command}\r`);
          await until(() => existsSync(pidFile), 'CLI pid file');
          pid = Number(readFileSync(pidFile, 'utf8').trim());
          result.pid = pid;
          if (scenario === 'list-picker-abort') {
            await waitFor('Select view');
          } else if (scenario.includes('picker')) {
            await waitFor('Select workload');
            result.snapshots.push({
              checkpoint: 'picker',
              ...terminalSnapshot(term, pid),
            });
            if (scenario === 'status-picker-watch') {
              const at = output.length;
              term.write('\r');
              await waitFor('Disk Size', at);
            }
          } else if (scenario.startsWith('logs')) {
            await waitFor('DIAG_LOG 1');
          } else {
            await waitFor('Disk Size');
          }
          if (scenario === 'status-request') {
            fixture.setMode({ holdStatus: true });
            const since = fixture.events.length;
            await until(
              () =>
                fixture.events
                  .slice(since)
                  .some(
                    (e) =>
                      e.event === 'request' &&
                      e.pathname === `/v1/workloads/${fixture.id}`,
                  ),
              'pending status request',
            );
          }
          result.snapshots.push({
            checkpoint: 'before-interrupt',
            ...terminalSnapshot(term, pid),
          });
          result.interruptAt = Date.now();
          if (scenario === 'status-external') process.kill(pid, 'SIGINT');
          else term.write('\x03');
          await until(
            () => /DIAG_PROMPT_EXIT:\d+>/.test(strip(output.slice(commandAt))),
            'CLI exit',
            5000,
          );
          result.exitAt = Date.now();
          result.latencyMs = result.exitAt - result.interruptAt;
          result.exitCode = Number(
            strip(output.slice(commandAt)).match(/DIAG_PROMPT_EXIT:(\d+)>/)[1],
          );
          result.expected = scenario.endsWith('abort') ? 0 : 130;
          result.pass =
            result.exitCode === result.expected &&
            !/Failed to fetch status|No local API is running|Failed to fetch logs/.test(
              output,
            );
        } catch (error) {
          result.pass = false;
          result.error = String(error);
          if (pid) {
            result.snapshots.push({
              checkpoint: 'failure',
              ...terminalSnapshot(term, pid),
            });
          }
        } finally {
          if (pid) {
            try {
              process.kill(pid, 'SIGKILL');
            } catch {
              /* already exited */
            }
          }
          try {
            term.kill();
          } catch {
            /* already exited */
          }
          result.state = await fixture.checkState();
          if (!result.state.unchanged) result.pass = false;
          writeFileSync(join(resultsDirectory, `${name}.terminal.txt`), output);
          results.push(result);
          writeFileSync(
            join(resultsDirectory, 'results.json'),
            JSON.stringify(results, null, 2) + '\n',
          );
          console.log(
            JSON.stringify({
              name,
              pass: result.pass,
              exitCode: result.exitCode,
              latencyMs: result.latencyMs,
              error: result.error,
              stateUnchanged: result.state.unchanged,
            }),
          );
          await delay(50);
        }
      }
    }
  }
} finally {
  await fixture.close();
}
process.exit(results.every((result) => result.pass) ? 0 : 1);

/**
 * The compiled CLI writes all of its output into a slow pipe.
 *
 * Runs the release-built binary, since Bun's console drops piped output past
 * 64 KiB (oven-sh/bun#36419) and Node never shows it. Set
 * ANYCLOUD_CLI_BINARY to test another binary, such as a published release.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { WorkloadState } from '../../src/shared/workload.js';
import {
  makeStatusWorkloadMetadata,
  makeWorkloadEvent,
  makeWorkloadListRow,
} from '../unit/helpers/fixtures.js';
import {
  at,
  orpcError,
  pagedObjects,
  runPiped,
  startFakeApi,
  type FakeApi,
} from './helpers/piped-cli.js';
import { writeLocalApiToken } from './helpers/local-api-token.js';

const binary = process.env.ANYCLOUD_CLI_BINARY ?? 'binaries/anycloud-linux-x64';

const workloads = Array.from({ length: 1000 }, (_, i) =>
  makeWorkloadListRow({ id: `job-${String(i).padStart(4, '0')}` }),
);
const objects = Array.from({ length: 1000 }, (_, i) => ({
  kind: 'object',
  key: `run/checkpoints/step_${String(i).padStart(8, '0')}.h5`,
  sizeBytes: 123456789,
  lastModifiedAt: 1790000000000 + i,
}));
// More than the default limit of 1,000, so a plain listing is capped.
const fifteenHundred = Array.from({ length: 1500 }, (_, i) => ({
  kind: 'object',
  key: `capped/step_${String(i).padStart(8, '0')}.h5`,
  sizeBytes: 1,
  lastModifiedAt: 1790000000000 + i,
}));
const cappedPage = pagedObjects(fifteenHundred);
const agentCost = { jobs: 1, services: 0, vms: 0, cost: 1.5, durationMs: 1 };
const costReport = {
  periodMs: 1,
  totalCost: 1,
  totalDurationMs: 1,
  totalJobs: 1,
  totalServices: 0,
  totalVms: 0,
  workloadsWithoutPrice: 0,
  byProvider: {},
  byAgent: Object.fromEntries(
    Array.from({ length: 2000 }, (_, i) => [`agent-${i}`, agentCost]),
  ),
  byUser: {},
  includesOtherUsers: false,
};
// A Job's status with a long event history, as `status --json` returns it.
const statusResponse = {
  workload: makeStatusWorkloadMetadata({ id: 'job-big' }),
  events: Array.from({ length: 1000 }, (_, i) =>
    makeWorkloadEvent({
      id: i,
      workloadId: 'job-big',
      metadata: { message: `Attempt ${i}: container restarted` },
      createdAt: 1790000000000 + i,
    }),
  ),
  eventsTotal: 1000,
  status: 'up',
};
const errorMessage = `${'e'.repeat(200_000)} END`;

let api: FakeApi;

beforeAll(async () => {
  api = await startFakeApi([
    at('/v1/credentials', {
      body: [{ name: 'azure', cloudProvider: 'Azure' }],
    }),
    (url) =>
      url.pathname.includes('/buckets/b1500/') ? cappedPage(url) : undefined,
    pagedObjects(objects),
    at('/v1/workloads', { body: workloads }),
    at('/v1/workload-costs', { body: costReport }),
    at('/v1/workloads/job-big', { body: statusResponse }),
    ...(['stdout', 'stderr'] as const).map((type) =>
      at(`/v1/workloads/job-${type}/logs`, {
        body: null,
        // One stdout line, then endless output on `type`.
        stream: (res) => {
          res.writeHead(200, { 'content-type': 'application/x-ndjson' });
          let line = 0;
          const event = (stream: string) => {
            const data = Buffer.from(`line ${line++}\n`).toString('base64');
            res.write(`${JSON.stringify({ type: stream, data })}\n`);
          };
          event('stdout');
          const timer = setInterval(() => event(type), 50);
          res.on('close', () => clearInterval(timer));
        },
      }),
    ),
    at('/v1/workloads/job-quiet/logs', {
      body: null,
      // A marker, then a quiet spell between later lines, as a Job logs.
      stream: (res) => {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        const event = (text: string) => {
          const data = Buffer.from(`${text}\n`).toString('base64');
          res.write(`${JSON.stringify({ type: 'stdout', data })}\n`);
        };
        event('marker');
        const timer = setInterval(() => event('later'), 250);
        res.on('close', () => clearInterval(timer));
      },
    }),
    ...[WorkloadState.Completed, WorkloadState.Errored].map((state) =>
      at(`/v1/workloads/job-${state}`, {
        body: {
          workload: makeStatusWorkloadMetadata({ id: `job-${state}`, state }),
          events: [],
          status: '-',
        },
      }),
    ),
    (url) =>
      url.pathname.startsWith('/v1/workloads/')
        ? orpcError(400, errorMessage)
        : undefined,
  ]);
});

afterAll(() => api.close());

describe('compiled CLI output into a slow pipe', () => {
  it.concurrent.for([
    [['list', '-n', '1000', '--json'], workloads.length],
    [['bucket', 'list', 'b', 'run/', '--recursive', '--json'], objects.length],
  ] as const)(
    '%j writes all of its JSON',
    async ([args, count], { expect }) => {
      const { output, exitCode } = await runPiped(api, binary, args);
      expect(exitCode).toBe(0);
      expect(output.length).toBeGreaterThan(64 * 1024);
      // `list` prints an array; `bucket list` wraps its entries.
      const json = JSON.parse(output) as unknown[] | { entries: unknown[] };
      expect(Array.isArray(json) ? json : json.entries).toHaveLength(count);
    },
  );

  it.concurrent('writes all of a large status', async ({ expect }) => {
    const run = await runPiped(api, binary, ['status', 'job-big', '--json']);
    expect(run.exitCode).toBe(0);
    expect(run.output.length).toBeGreaterThan(64 * 1024);
    const status = JSON.parse(run.output) as typeof statusResponse;
    expect(status.events).toHaveLength(1000);
    expect(status.events.at(-1)?.id).toBe(999);
  });

  it.concurrent(
    'wait prints one line per Workload change and exits by its outcome',
    async ({ expect }) => {
      const done = await runPiped(api, binary, ['wait', 'job-completed']);
      expect(done.exitCode).toBe(0);
      expect(done.output).toMatch(
        /^\[\d\d:\d\d:\d\d\] job-completed completed\n\[\d\d:\d\d:\d\d\] succeeded: job-completed\n$/,
      );
      const failed = await runPiped(api, binary, [
        'wait',
        'job-errored',
        '--json',
      ]);
      expect(failed.exitCode).toBe(1);
      expect(
        failed.output
          .trim()
          .split('\n')
          .map((line) => (JSON.parse(line) as { type: string }).type),
      ).toEqual(['state', 'result']);
    },
  );

  it.concurrent.for(['stdout', 'stderr'] as const)(
    'logs --follow stops once its reader exits, with endless %s output',
    async (stream, { expect }) => {
      const { stdout } = await promisify(execFile)(
        'bash',
        [
          '-c',
          '"$@" 2>&1 | head -1; echo "exit:${PIPESTATUS[0]}"',
          'bash',
          binary,
          'logs',
          `job-${stream}`,
          '--follow',
        ],
        {
          env: {
            ...process.env,
            HOME: api.home,
            ANYCLOUD_DIR: `${api.home}/.anycloud`,
            API_URL: api.url,
            GITHUB_TOKEN: 'piped-test-token',
            IS_TEST: 'true',
          },
          timeout: 20_000,
        },
      );
      expect(stdout).toBe('line 0\nexit:0\n');
    },
  );

  it.concurrent(
    'logs --follow stops at its next line after its reader exits',
    async ({ expect }) => {
      const { stdout } = await promisify(execFile)(
        'bash',
        [
          '-c',
          '"$@" 2>&1 | grep -m1 marker; echo "exit:${PIPESTATUS[0]}"',
          'bash',
          binary,
          'logs',
          'job-quiet',
          '--follow',
        ],
        {
          env: {
            ...process.env,
            HOME: api.home,
            ANYCLOUD_DIR: `${api.home}/.anycloud`,
            API_URL: api.url,
            GITHUB_TOKEN: 'piped-test-token',
            IS_TEST: 'true',
          },
          timeout: 20_000,
        },
      );
      expect(stdout).toBe('marker\nexit:0\n');
    },
  );

  it.concurrent(
    'writes all of its JSON before process.exit',
    async ({ expect }) => {
      const { output, exitCode } = await runPiped(api, binary, [
        'cost',
        '--json',
      ]);
      expect(exitCode).toBe(0);
      expect(output.length).toBeGreaterThan(64 * 1024);
      const report = JSON.parse(output) as typeof costReport;
      expect(Object.keys(report.byAgent)).toHaveLength(2000);
    },
  );

  it.concurrent(
    'writes all of an error before process.exit',
    async ({ expect }) => {
      const run = await runPiped(api, binary, ['status', 'job-x'], 'stderr');
      expect(run.exitCode).toBe(1);
      // Compare sizes and the tail, so a failure doesn't print 200 KB.
      expect(run.output.length).toBeGreaterThan(errorMessage.length);
      expect(run.output.slice(-40)).toContain(' END\n');
    },
  );

  describe('a capped bucket listing', () => {
    const list = [
      'bucket',
      'list',
      'b1500',
      'capped/',
      '--recursive',
      '--json',
    ];
    // A bare array has no listing fields (and its `entries` is a method).
    const listing = (output: string) => {
      const json = JSON.parse(output) as unknown;
      return (Array.isArray(json) ? {} : json) as {
        entries?: { key: string }[];
        truncated?: boolean;
        nextCursor?: string | null;
      };
    };
    const summary = ({
      output,
      exitCode,
    }: {
      output: string;
      exitCode: number;
    }) => {
      const { entries, truncated, nextCursor } = listing(output);
      return { exitCode, count: entries?.length, truncated, nextCursor };
    };

    it.concurrent(
      'exits 3 with truncated and a nextCursor that resumes the rest exactly once',
      async ({ expect }) => {
        const first = await runPiped(api, binary, list);
        expect(summary(first)).toMatchObject({
          exitCode: 3,
          count: 1000,
          truncated: true,
        });
        const { nextCursor } = listing(first.output);
        expect(nextCursor).toBeTypeOf('string');
        const rest = await runPiped(api, binary, [
          ...list,
          '--cursor',
          nextCursor!,
        ]);
        expect(summary(rest)).toEqual({
          exitCode: 0,
          count: 500,
          truncated: false,
          nextCursor: null,
        });
        const keys = [first, rest].flatMap(
          ({ output }) => listing(output).entries?.map(({ key }) => key) ?? [],
        );
        expect(keys).toEqual(fifteenHundred.map(({ key }) => key));
      },
    );

    it.concurrent(
      '--all lists every object and exits 0',
      async ({ expect }) => {
        expect(
          summary(await runPiped(api, binary, [...list, '--all'])),
        ).toEqual({
          exitCode: 0,
          count: 1500,
          truncated: false,
          nextCursor: null,
        });
      },
    );
  });
});

// A user's shell: cli-table3's colour library stays off under CI and only
// colours a colour-capable TERM, so CI alone would hide the codes.
const shell = { CI: undefined, TERM: 'xterm-256color' };
const bucketTable = ['bucket', 'list', 'b', 'run/', '--recursive'];

describe('compiled CLI tables in a pipe', () => {
  it.concurrent.for([[{}], [{ NO_COLOR: '1' }]] as const)(
    'with %j print no colour codes',
    async ([env], { expect }) => {
      const run = await runPiped(api, binary, bucketTable, 'stdout', {
        ...shell,
        ...env,
      });
      expect(run.exitCode).toBe(0);
      expect(run.output).toContain('step_00000999.h5');
      expect(run.output).not.toContain('\x1b[');
    },
  );

  it.concurrent('keep colour when FORCE_COLOR is set', async ({ expect }) => {
    const run = await runPiped(api, binary, bucketTable, 'stdout', {
      ...shell,
      FORCE_COLOR: '1',
    });
    expect(run.exitCode).toBe(0);
    expect(run.output).toContain('\x1b[');
  });
});

describe('compiled CLI sign-in token precedence', () => {
  // The fake API leaves a marker named by each UUID GitHub sign-in it receives.
  it.concurrent.for([
    ['nothing from ANYCLOUD_TOKEN', ['ANYCLOUD_TOKEN'], null],
    [
      'GITHUB_TOKEN, ignoring ANYCLOUD_TOKEN',
      ['ANYCLOUD_TOKEN', 'GITHUB_TOKEN'],
      'GITHUB_TOKEN',
    ],
    ['the saved token over GITHUB_TOKEN', ['file', 'GITHUB_TOKEN'], 'file'],
  ] as const)('uses %s', async ([, sources, winner], { expect }) => {
    const directory = await mkdtemp(join(tmpdir(), 'anycloud-token-'));
    writeLocalApiToken(directory, 'piped-local-api');
    const tokens = Object.fromEntries(sources.map((s) => [s, randomUUID()]));
    if (tokens.file) await writeFile(join(directory, '.token'), tokens.file);
    const failure = await promisify(execFile)(
      binary,
      ['credentials', 'list', '--json'],
      {
        env: {
          PATH: process.env.PATH,
          HOME: directory,
          ANYCLOUD_DIR: directory,
          API_URL: api.url,
          IS_TEST: 'true',
          ANYCLOUD_TOKEN: tokens.ANYCLOUD_TOKEN,
          GITHUB_TOKEN: tokens.GITHUB_TOKEN,
        },
      },
    ).then(
      () => undefined,
      (error: unknown) => error as { code?: number },
    );
    // The local API's own token opens it; the GitHub sign-in rides beside it.
    expect(failure).toBeUndefined();
    for (const source of sources) {
      expect(existsSync(join(api.home, tokens[source]))).toBe(
        source === winner,
      );
    }
  });

  it.concurrent(
    'continues signed out when the saved token cannot be read, never using another',
    async ({ expect }) => {
      const directory = await mkdtemp(join(tmpdir(), 'anycloud-token-'));
      writeLocalApiToken(directory, 'piped-local-api');
      // A directory can't be read as a file, even by root.
      await mkdir(join(directory, '.token'));
      const token = randomUUID();
      const { stderr } = await promisify(execFile)(
        binary,
        ['credentials', 'list'],
        {
          env: {
            PATH: process.env.PATH,
            HOME: directory,
            ANYCLOUD_DIR: directory,
            API_URL: api.url,
            IS_TEST: 'true',
            GITHUB_TOKEN: token,
          },
        },
      );
      expect(stderr).toContain(
        `Warning: continuing without a GitHub sign-in. Could not read the saved token ${join(directory, '.token')}`,
      );
      expect(existsSync(join(api.home, token))).toBe(false);
    },
  );
});

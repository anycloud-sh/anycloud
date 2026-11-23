import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  bootMark,
  parseBootMarks,
  readBootMarks,
} from '../../../../src/api/services/host-runtime/boot-marks.js';

const uptime = () => Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0]);

/**
 * Runs host commands under bash with /run/anycloud in a scratch directory and
 * a stub `docker inspect` that prints `inspect`, or fails without it.
 */
function onHost(marks: string | null, inspect?: string) {
  const root = mkdtempSync(join(tmpdir(), 'boot-marks-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  if (marks !== null) writeFileSync(join(root, 'boot-marks'), marks);
  writeFileSync(
    join(bin, 'docker'),
    inspect === undefined
      ? '#!/bin/sh\nexit 1\n'
      : `#!/bin/sh\necho '${inspect}'\n`,
    { mode: 0o755 },
  );
  const run = (command: string) =>
    execFileSync('bash', ['-c', command.replaceAll('/run/anycloud', root)], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
  return {
    run,
    exec: async (command: string) => ({ stdout: run(command) }),
    marks: () => readFileSync(join(root, 'boot-marks'), 'utf8'),
  };
}

describe('bootMark', () => {
  it("appends the name at the host's uptime", () => {
    const host = onHost('prepare-start 5.00\n');
    const before = uptime();
    host.run(bootMark('container-run'));
    const at = parseBootMarks(host.marks())['container-run']!;
    expect(host.marks()).toMatch(/^prepare-start 5\.00\ncontainer-run \S+\n$/);
    expect(at).toBeGreaterThanOrEqual(Math.floor(before));
    expect(at).toBeLessThanOrEqual(uptime() + 0.01);
  });
});

describe('parseBootMarks', () => {
  it('reads `<name> <number>` lines, the latest of a name winning', () => {
    expect(
      parseBootMarks(
        'api-ssh 9.10\npull-bytes 123456\nnoise\napi-ssh 30.5\nbad 1e3\n',
      ),
    ).toEqual({ 'api-ssh': 30.5, 'pull-bytes': 123456 });
  });
});

describe('readBootMarks', () => {
  it("adds the container's creation and start on the uptime clock", async () => {
    const created = new Date(Date.now() - 12_000).toISOString();
    const started = new Date(Date.now() - 10_000).toISOString();
    const host = onHost('prepare-start 5.00\n', `${created} ${started}`);
    const now = uptime();
    const marks = await readBootMarks(host.exec, 'job-a');
    expect(marks!['prepare-start']).toBe(5);
    expect(marks!['container-created']).toBeCloseTo(now - 12, 0);
    expect(marks!['container-started']).toBeCloseTo(now - 10, 0);
  });

  it('keeps the marks without a container, and is undefined with neither', async () => {
    await expect(
      readBootMarks(onHost('api-ssh 9.10\n').exec, 'job-a'),
    ).resolves.toEqual({ 'api-ssh': 9.1 });
    await expect(
      readBootMarks(onHost(null).exec, 'job-a'),
    ).resolves.toBeUndefined();
    await expect(
      readBootMarks(async () => {
        throw new Error('ssh down');
      }, 'job-a'),
    ).resolves.toBeUndefined();
  });
});

import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  symlinkSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertSpikeRevision,
  executeSpike,
  parseSpikeArguments,
  spikeEntrypoint,
} from '../../../ci/spike.js';

const clusterRecords: string[] = [];
afterEach(() => {
  for (const root of clusterRecords.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture(): { root: string; directory: string } {
  const root = mkdtempSync(join(tmpdir(), 'spike-dispatch-'));
  clusterRecords.push(root);
  const directory = join(root, 'experiments', 'example');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'README.md'), '# Example');
  writeFileSync(join(directory, 'run.ts'), 'console.log("example");');
  return { root, directory };
}

describe('shared spike dispatch', () => {
  it('preserves literal argument boundaries, including shell syntax', () => {
    const args = [
      '--name',
      'contains spaces',
      '$(touch /tmp/spike)',
      '; exit 0',
      '*',
      '',
    ];
    expect(parseSpikeArguments(JSON.stringify(args))).toEqual(args);
  });

  it('executes literal arguments and preserves the child failure status', async () => {
    const { root } = fixture();
    const output = join(root, 'arguments.json');
    const unwanted = join(root, 'shell-expanded');
    const args = ['two words', `$(touch ${unwanted})`, '; exit 0', '*'];
    const code = await executeSpike({
      root: process.cwd(),
      entrypoint: resolve('test/fixtures/spike-child.ts'),
      args,
      environment: { SPIKE_CHILD_OUTPUT: output, SPIKE_CHILD_EXIT_CODE: '23' },
    });
    expect(code).toBe(23);
    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual(args);
    expect(() => readFileSync(unwanted)).toThrow();
  });

  it.each(['{}', '"preflight"', '[1]', '[null]', '["a\\u0000b"]', '['])(
    'rejects malformed argument arrays: %s',
    (value) => {
      expect(() => parseSpikeArguments(value)).toThrow();
    },
  );

  it('bounds argument array and input size', () => {
    expect(() =>
      parseSpikeArguments(JSON.stringify(Array(129).fill('a'))),
    ).toThrow('at most 128');
    expect(() =>
      parseSpikeArguments(JSON.stringify(['a'.repeat(32_768)])),
    ).toThrow('32 KiB');
  });

  it.each([
    '../ci',
    '/tmp/probe',
    'example/run.ts',
    'example;id',
    'Example',
    '',
  ])('rejects names outside one experiment directory: %s', (name) => {
    const { root } = fixture();
    expect(() => spikeEntrypoint(root, name)).toThrow('directory name');
  });

  it('rejects symlinked entrypoints and experiment directories', () => {
    const { root, directory } = fixture();
    symlinkSync(directory, join(root, 'experiments', 'alias'));
    expect(() => spikeEntrypoint(root, 'alias')).toThrow('regular directory');
    rmSync(join(directory, 'run.ts'));
    symlinkSync(join(directory, 'README.md'), join(directory, 'run.ts'));
    expect(() => spikeEntrypoint(root, 'example')).toThrow('regular run.ts');
  });

  it('selects a documented regular experiment entrypoint', () => {
    const { root, directory } = fixture();
    expect(spikeEntrypoint(root, 'example')).toBe(
      realpathSync(join(directory, 'run.ts')),
    );
  });

  it('rejects mutable and mismatched source revisions', () => {
    const sha = 'a'.repeat(40);
    expect(() => assertSpikeRevision('main', sha)).toThrow('full commit SHA');
    expect(() => assertSpikeRevision(sha, 'b'.repeat(40))).toThrow(
      'full commit SHA',
    );
    expect(() => assertSpikeRevision(sha, sha)).not.toThrow();
  });
});

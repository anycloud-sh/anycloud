import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DockerManager } from '../../../src/api/services/docker';
import {
  readSecretFileRevisions,
  serializeRuntimeSecretsEnv,
  writeSecretFiles,
} from '../../../src/api/services/runtime-secrets';

describe('runtime secrets', () => {
  it('serializes UTF-8 values without altering them', () => {
    const serialized = serializeRuntimeSecretsEnv({ K: 'é' });
    expect(serialized).toBe('K=é');
    expect(Buffer.byteLength(serialized, 'utf8')).toBe(4);
  });

  it('rejects env-file control characters', () => {
    expect(() => serializeRuntimeSecretsEnv({ TOKEN: 'line1\nline2' })).toThrow(
      'disallowed control character',
    );
  });
});

describe('Secret files on the host', () => {
  let root: string;
  const host = new DockerManager('127.0.0.1', 'unused');
  const files = () => join(root, 'files');
  const mode = (path: string) => (statSync(path).mode & 0o777).toString(8);
  const secret = (revision: string, values: Record<string, string>) => ({
    name: 'hf',
    revision,
    values,
  });

  beforeEach(() => {
    root = join(mkdtempSync(join(tmpdir(), 'secret-files-')), 'secrets');
  });
  afterEach(() => rmSync(dirname(root), { recursive: true, force: true }));

  it('writes read-only files under a swapped symlink and removes old revisions', async () => {
    expect(await readSecretFileRevisions(host, ['hf'], root)).toEqual(
      new Map([['hf', null]]),
    );
    await writeSecretFiles(
      host,
      secret('aaaa', { HF_TOKEN: 'old', DROPPED: 'x' }),
      root,
    );
    expect(mode(root)).toBe('700');
    expect(mode(files())).toBe('755');
    expect(mode(join(files(), '.hf.aaaa'))).toBe('755');
    expect(mode(join(files(), 'hf', 'HF_TOKEN'))).toBe('444');
    expect(readlinkSync(join(files(), 'hf'))).toBe('.hf.aaaa');

    await writeSecretFiles(host, secret('bbbb', { HF_TOKEN: 'new' }), root);
    expect(readFileSync(join(files(), 'hf', 'HF_TOKEN'), 'utf8')).toBe('new');
    // A key removed in the update disappears with the swap.
    expect(readdirSync(files()).sort()).toEqual(['.hf.bbbb', 'hf']);
    expect(readdirSync(join(files(), 'hf'))).toEqual(['HF_TOKEN']);
    expect(await readSecretFileRevisions(host, ['hf', 'gone'], root)).toEqual(
      new Map([
        ['hf', 'bbbb'],
        ['gone', null],
      ]),
    );
  });

  it('leaves the previous revision in place when a write fails', async () => {
    await writeSecretFiles(host, secret('aaaa', { K: 'old' }), root);
    const failing = {
      exec: (command: string) => host.exec(command),
      writeFile: vi.fn().mockRejectedValue(new Error('unreachable')),
    };
    await expect(
      writeSecretFiles(failing, secret('bbbb', { K: 'new' }), root),
    ).rejects.toThrow('unreachable');
    expect(readlinkSync(join(files(), 'hf'))).toBe('.hf.aaaa');
    expect(readFileSync(join(files(), 'hf', 'K'), 'utf8')).toBe('old');
  });

  it('probes a host once, leaving the retry to the next poll', async () => {
    const remote = new DockerManager('10.0.0.5', 'unused');
    remote.exec = vi.fn().mockRejectedValue(new Error('unreachable'));
    await expect(remote.readSecretFileRevisions(['hf'])).rejects.toThrow(
      'unreachable',
    );
    expect(remote.exec).toHaveBeenCalledWith(expect.any(String), undefined, 1);
  });

  it('wraps a failed write without transport output or the value', async () => {
    const remote = new DockerManager('10.0.0.5', 'unused');
    remote.exec = vi
      .fn()
      .mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    remote.writeFile = vi
      .fn()
      .mockRejectedValue(new Error('stderr: super-secret-value'));
    await expect(
      remote.writeSecretFiles(secret('aaaa', { K: 'super-secret-value' })),
    ).rejects.toThrow(
      /^Failed to write files for Secret "hf" on 10\.0\.0\.5$/u,
    );
  });
});

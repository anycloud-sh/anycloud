import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  execExitCode,
  podExec,
} from '../../../../src/api/services/kubernetes/pod-exec.js';
import { localExec } from '../../helpers/local-pod-exec.js';

const target = { namespace: 'anycloud-pool-a', pod: 'r-1', container: 'w' };

async function run(
  command: string,
  fence?: () => Promise<string | undefined>,
  signal = new AbortController().signal,
) {
  const { cluster, exec } = localExec();
  const out: string[] = [];
  const err: string[] = [];
  const result = podExec(
    cluster,
    target,
    command,
    {
      signal,
      onStdout: (chunk) => void out.push(chunk.toString()),
      onStderr: (chunk) => void err.push(chunk.toString()),
    },
    fence,
  );
  return { result, out, err, exec };
}

describe('pod exec', () => {
  it('runs the command in the named container and returns its exit code and output', async () => {
    const { result, out, err, exec } = await run(
      'echo out; echo err >&2; exit 3',
    );

    await expect(result).resolves.toBe(3);
    expect(out.join('')).toBe('out\n');
    expect(err.join('')).toBe('err\n');
    expect(exec.mock.calls[0]!.slice(0, 3)).toEqual([
      'anycloud-pool-a',
      'r-1',
      'w',
    ]);
  });

  it('starts a fenced command only after the fence passes, with the handshake hidden', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-exec-'));
    const flag = join(dir, 'fence-ran');
    const { result, out } = await run(`test -e ${flag} && echo ran`, () => {
      writeFileSync(flag, '');
      return Promise.resolve(undefined);
    });

    await expect(result).resolves.toBe(0);
    expect(out.join('')).toBe('ran\n');
  });

  it('never runs a command the fence refuses', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-exec-'));
    const ran = join(dir, 'ran');
    const { result } = await run(`touch ${ran}`, async () => 'Job j ended');

    await expect(result).rejects.toThrow('Job j ended');
    expect(existsSync(ran)).toBe(false);
  });

  it('refuses the command when the fence cannot be checked', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-exec-'));
    const ran = join(dir, 'ran');
    const { result } = await run(`touch ${ran}`, async () => {
      throw new Error('database is locked');
    });

    await expect(result).rejects.toThrow('database is locked');
    expect(existsSync(ran)).toBe(false);
  });

  it('stops the command when the client goes away', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-exec-'));
    const stopped = join(dir, 'stopped');
    const client = new AbortController();
    const { result, out } = await run(
      `trap 'touch ${stopped}; exit 0' TERM; echo started; sleep 30 & wait`,
      undefined,
      client.signal,
    );
    await vi.waitFor(() => expect(out.join('')).toBe('started\n'));

    client.abort();

    await expect(result).rejects.toThrow('exec cancelled');
    await vi.waitFor(() => expect(existsSync(stopped)).toBe(true));
  });

  it("names a refused upgrade, which rejects with the WebSocket's ErrorEvent", async () => {
    const { cluster, exec } = localExec();
    exec.mockRejectedValueOnce({ message: 'Unexpected server response: 403' });

    await expect(
      podExec(cluster, target, 'true', {
        signal: new AbortController().signal,
        onStdout: () => undefined,
        onStderr: () => undefined,
      }),
    ).rejects.toThrow('exec failed: Unexpected server response: 403');
  });

  it('reads the exit code from the status, and fails on any other failure', () => {
    expect(execExitCode({ status: 'Success' })).toBe(0);
    expect(
      execExitCode({
        status: 'Failure',
        details: { causes: [{ reason: 'ExitCode', message: '137' }] },
      }),
    ).toBe(137);
    expect(() =>
      execExitCode({ status: 'Failure', message: 'container not found' }),
    ).toThrow('container not found');
  });
});

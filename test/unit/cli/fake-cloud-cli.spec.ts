import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CommandFailedError,
  runArgv,
} from '../../../src/cli/services/slurp/cli-exec.js';
import {
  installFakeCloudClis,
  type FakeCloudClis,
} from '../../helpers/fake-cloud-cli.js';

describe('the fake cloud CLI kit', () => {
  let clis: FakeCloudClis;

  beforeEach(() => {
    clis = installFakeCloudClis({
      aws: [
        {
          match: ['sts', 'get-caller-identity'],
          stdout: { Account: '123456789012' },
        },
        { match: /^cloudformation deploy .*--stack-name s1/, stdout: 'ok' },
      ],
      gcloud: [
        { match: ['config', 'get', 'project'], stdout: 'p-1\n', times: 1 },
        { match: ['config', 'get', 'project'], stdout: 'p-2\n' },
      ],
      az: [
        {
          match: ['account', 'show'],
          stderr: 'Please run az login',
          exitCode: 1,
        },
      ],
    });
    vi.stubEnv('PATH', clis.env.PATH);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    clis.cleanup();
  });

  it('answers a matching prefix or pattern and records argv and stdin', async () => {
    expect(
      JSON.parse(await runArgv('aws', ['sts', 'get-caller-identity'])),
    ).toEqual({ Account: '123456789012' });
    await expect(
      runArgv('aws', ['cloudformation', 'deploy', '--stack-name', 's1'], {
        input: 'template',
      }),
    ).resolves.toBe('ok');
    expect(clis.calls()).toEqual([
      { cli: 'aws', args: ['sts', 'get-caller-identity'], stdin: '' },
      {
        cli: 'aws',
        args: ['cloudformation', 'deploy', '--stack-name', 's1'],
        stdin: 'template',
      },
    ]);
  });

  it('spends a counted responder, then falls through to the next', async () => {
    expect(await runArgv('gcloud', ['config', 'get', 'project'])).toBe('p-1\n');
    expect(await runArgv('gcloud', ['config', 'get', 'project'])).toBe('p-2\n');
    expect(await runArgv('gcloud', ['config', 'get', 'project'])).toBe('p-2\n');
  });

  it('surfaces a non-zero exit with its stderr, and fails a call nothing answers', async () => {
    const failure = await runArgv('az', ['account', 'show']).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(CommandFailedError);
    expect(failure).toMatchObject({
      exitCode: 1,
      stderr: 'Please run az login',
    });
    await expect(runArgv('aws', ['s3', 'ls'])).rejects.toMatchObject({
      exitCode: 2,
      stderr: expect.stringContaining('unexpected fake aws call: s3 ls'),
    });
  });

  it('takes responders added between calls', async () => {
    clis.respond('aws', { match: ['s3', 'ls'], stdout: 'bucket-1' });
    await expect(runArgv('aws', ['s3', 'ls'])).resolves.toBe('bucket-1');
  });

  it('puts nothing but the fakes and Node on PATH, so no real CLI is reached', () => {
    const entries = clis.env.PATH!.split(':');
    expect(entries[0]).toBe(clis.dir);
    expect(entries).toHaveLength(2);
  });
});

describe('runArgv with showStderr', () => {
  it('still captures stderr for the error while showing it', async () => {
    const failing = runArgv(
      process.execPath,
      ['-e', "process.stderr.write('PERMISSION_DENIED'); process.exit(1)"],
      { showStderr: true },
    );
    await expect(failing).rejects.toBeInstanceOf(CommandFailedError);
    await expect(failing).rejects.toMatchObject({
      stderr: expect.stringContaining('PERMISSION_DENIED'),
    });
  });
});

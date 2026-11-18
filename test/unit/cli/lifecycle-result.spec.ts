import { ORPCError } from '@orpc/client';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalApiStillStartingError } from '../../../src/cli/services/local-api-update.js';
import {
  UsageError,
  lifecycleError,
  withLifecycleUsageExit,
} from '../../../src/cli/utils/lifecycle-result.js';
import { LocalApiUnavailableError } from '../../../src/shared/services/api-client/runtime.js';

describe('lifecycle --json results', () => {
  it.each([
    [
      "the API's declared code",
      new ORPCError('CLUSTER_EXISTS', { defined: true, status: 409 }),
      'CLUSTER_EXISTS',
      1,
    ],
    [
      'a restarting API',
      new ORPCError('API_RESTARTING', { defined: true, status: 503 }),
      'API_UNREACHABLE',
      2,
    ],
    [
      'an edge with no API behind it',
      new ORPCError('BAD_GATEWAY', { status: 502 }),
      'API_UNREACHABLE',
      2,
    ],
    [
      'a refused connection',
      Object.assign(new TypeError('fetch failed'), {
        cause: { code: 'ECONNREFUSED' },
      }),
      'API_UNREACHABLE',
      2,
    ],
    [
      'no local API',
      new LocalApiUnavailableError('No local API is running.'),
      'API_UNREACHABLE',
      2,
    ],
    ['a usage error', new UsageError('pass --region'), 'INVALID_ARGUMENT', 2],
    [
      'a local API still starting',
      new LocalApiStillStartingError(),
      'LOCAL_API_STILL_STARTING',
      4,
    ],
    [
      "Bun's refused connection",
      Object.assign(new Error('Unable to connect'), {
        code: 'ConnectionRefused',
      }),
      'API_UNREACHABLE',
      2,
    ],
    [
      'a TypeError from our own code',
      new TypeError("Cannot read properties of undefined (reading 'id')"),
      'UNEXPECTED',
      1,
    ],
    [
      'an undeclared API error',
      new ORPCError('INTERNAL_SERVER_ERROR', { status: 500 }),
      'UNEXPECTED',
      1,
    ],
    ['anything else', new Error('boom'), 'UNEXPECTED', 1],
  ])('reports %s', (_name, error, code, exitCode) => {
    expect(lifecycleError(error)).toMatchObject({ code, exitCode });
  });

  describe('a usage error Commander finds', () => {
    let exit: ReturnType<typeof vi.spyOn>;
    let log: ReturnType<typeof vi.spyOn>;
    let argv: string[];
    beforeEach(() => {
      argv = process.argv;
      exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
        throw new Error(`process.exit:${code ?? 0}`);
      });
      log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });
    afterEach(() => {
      process.argv = argv;
      vi.restoreAllMocks();
    });

    it('exits 2, with the error document under --json', async () => {
      const command = () =>
        withLifecycleUsageExit(
          new Command('create')
            .requiredOption('--vm-type <type>', 'VM type')
            .option('--json', 'JSON')
            .action(() => undefined),
        ).configureOutput({ writeErr: () => undefined });
      process.argv = ['node', 'anycloud', 'create', '--json'];
      await expect(
        command().parseAsync(['--json'], { from: 'user' }),
      ).rejects.toThrow('process.exit:2');
      expect(JSON.parse(String(log.mock.calls[0]![0]))).toEqual({
        error: {
          code: 'INVALID_ARGUMENT',
          message: "error: required option '--vm-type <type>' not specified",
        },
      });

      log.mockClear();
      process.argv = ['node', 'anycloud', 'create'];
      await expect(command().parseAsync([], { from: 'user' })).rejects.toThrow(
        'process.exit:2',
      );
      expect(log).not.toHaveBeenCalled();
      expect(exit).toHaveBeenCalledTimes(2);
    });
  });
});

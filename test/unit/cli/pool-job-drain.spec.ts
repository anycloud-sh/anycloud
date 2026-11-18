import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn(async () => {}) }));

import { drainPoolJobs } from '../../../src/cli/use-cases/pool-job-drain.js';
import {
  createApiClient,
  type ApiClient,
} from '../../../src/shared/services/api-client/rpc.js';

const running = {
  id: 'train-1',
  state: 'running',
  nodePool: 'gpu',
  runnerRelease: '0.1.69',
};
// The new release's window: its own runner and the previous release's.
const keep = ['0.1.71', '0.1.70'];
const continuing = { ...running, id: 'etl-1', runnerRelease: '0.1.70' };

function release(...answers: (typeof running)[][]) {
  const drain = vi.fn<ApiClient['systemRelease']['drain']>();
  for (const jobs of answers) drain.mockResolvedValueOnce({ jobs });
  return { drain };
}

describe("api upgrade's pool Job drain (decision 30)", () => {
  const printInfo = vi.fn();
  beforeEach(() => vi.clearAllMocks());

  it('polls until no pool Job runs, listing them only when they change', async () => {
    const api = release([running], [running], []);

    await drainPoolJobs(api, false, printInfo);

    expect(api.drain.mock.calls).toEqual([
      [{ force: false }],
      [{ force: false }],
      [{ force: false }],
    ]);
    expect(printInfo).toHaveBeenCalledExactlyOnceWith(
      'Waiting for 1 pool Job(s) to finish before the upgrade (--force stops them to retry): train-1 (running on gpu)',
    );
  });

  it('with --force lists first, then stops them on every later poll, and checks the release image on the first only', async () => {
    const api = release([running], [running], []);

    await drainPoolJobs(api, true, printInfo, {
      image: 'ghcr.io/anycloud-sh/api:1.0.0',
    });

    expect(api.drain.mock.calls).toEqual([
      [{ force: false, image: 'ghcr.io/anycloud-sh/api:1.0.0' }],
      [{ force: true }],
      [{ force: true }],
    ]);
    expect(printInfo).toHaveBeenCalledWith(
      'Stopping 1 pool Job(s) so they retry after the upgrade: train-1 (running on gpu)',
    );
  });

  it('lets Jobs on a runner the new release accepts keep running, and waits only for older ones (RFC 0049 C27)', async () => {
    const api = release([continuing, running], [continuing]);

    await drainPoolJobs(api, false, printInfo, { keep });

    expect(api.drain).toHaveBeenCalledTimes(2);
    expect(printInfo.mock.calls).toEqual([
      [
        '1 pool Job(s) keep running through the upgrade: etl-1 (running on gpu)',
      ],
      [
        'Waiting for 1 pool Job(s) to finish before the upgrade (--force stops them to retry): train-1 (running on gpu)',
      ],
    ]);
  });

  it('with --force stops only the Jobs outside the window, naming the window', async () => {
    const api = release([continuing, running], [continuing]);

    await drainPoolJobs(api, true, printInfo, { keep });

    expect(api.drain.mock.calls).toEqual([
      [{ force: false }],
      [{ force: true, keep }],
    ]);
  });

  it('with --force names the window even when the listing had no kept Job, so one claimed since is spared', async () => {
    const api = release([running], [continuing]);

    await drainPoolJobs(api, true, printInfo, { keep });

    expect(api.drain.mock.calls).toEqual([
      [{ force: false }],
      [{ force: true, keep }],
    ]);
  });

  /** The native error body a `/v1` API sends, as before any procedure. */
  const apiError =
    (code: string, status = 400) =>
    () =>
      Response.json({ defined: true, code, status, message: code }, { status });

  it.each([
    ['the local', undefined],
    ['a hosted', 'ghcr.io/anycloud-sh/api:1.0.0'],
  ])(
    'drains nothing on %s API from before the drain, and surfaces other errors',
    async (_api, image) => {
      const answer = vi.fn<() => Response>();
      const api = createApiClient('token', {
        apiUrl: 'http://old-api.test',
        fetch: async () => answer(),
      }).systemRelease;
      // A 0.1.70 API's version check answers the unknown path first.
      for (const [code, status] of [
        ['CLIENT_VERSION_MISMATCH', 400],
        ['NOT_FOUND', 404],
      ] as const) {
        answer.mockImplementationOnce(apiError(code, status));
        await expect(
          drainPoolJobs(api, false, printInfo, { image }),
        ).resolves.toBeUndefined();
      }
      answer.mockImplementationOnce(apiError('BAD_REQUEST'));
      await expect(
        drainPoolJobs(api, false, printInfo, { image }),
      ).rejects.toThrow('BAD_REQUEST');
    },
  );
});

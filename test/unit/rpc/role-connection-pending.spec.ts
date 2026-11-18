import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../../../src/shared/services/api-client/rpc.js';
import { CloudType } from '../../../src/shared/cloud.js';

const PENDING_MESSAGE =
  'Waiting for GCP IAM to let anycloud@p.iam.gserviceaccount.com be impersonated';

const pending = () =>
  Response.json(
    {
      defined: true,
      code: 'ROLE_CONNECTION_PENDING',
      status: 503,
      message: PENDING_MESSAGE,
      data: { name: 'gcp-role' },
    },
    { status: 503 },
  );
const saved = () => new Response(null, { status: 204 });

describe('ROLE_CONNECTION_PENDING retries', () => {
  let stderr: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.useFakeTimers({ now: 0 });
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function save(responses: (() => Response)[]) {
    const sentAt: number[] = [];
    const api = createApiClient('token', {
      apiUrl: 'http://api.example.test',
      fetch: async () => {
        sentAt.push(Date.now());
        return responses[Math.min(sentAt.length, responses.length) - 1]!();
      },
    });
    const outcome = api.credentials
      .save({
        params: { name: 'gcp-role' },
        query: { overwrite: 'true' },
        body: {
          cloudProvider: CloudType.GCP,
          kind: 'role',
          workloadIdentityProvider:
            'projects/1/locations/global/workloadIdentityPools/a/providers/b',
          serviceAccountEmail: 'anycloud@p.iam.gserviceaccount.com',
        },
      })
      .catch((error: unknown) => error);
    const waits = () => sentAt.slice(1).map((at, index) => at - sentAt[index]!);
    return { outcome, waits };
  }

  it('repeats the save every 15 s while GCP IAM propagates, saying so once', async () => {
    const { outcome, waits } = save([
      pending,
      pending,
      pending,
      pending,
      saved,
    ]);
    await vi.runAllTimersAsync();

    await expect(outcome).resolves.toBeUndefined();
    expect(waits()).toEqual([15_000, 15_000, 15_000, 15_000]);
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(stderr).toHaveBeenCalledWith(`${PENDING_MESSAGE}\n`);
  });

  it('gives up 150 s after the first answer with its message', async () => {
    const { outcome, waits } = save([pending]);
    await vi.runAllTimersAsync();

    await expect(outcome).resolves.toMatchObject({
      code: 'ROLE_CONNECTION_PENDING',
      message: PENDING_MESSAGE,
    });
    expect(waits()).toHaveLength(10);
  });
});

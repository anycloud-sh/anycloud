import { describe, expect, it, vi } from 'vitest';
import { createSecretsDomain } from '../../../src/api/services/secrets-domain.js';

describe('secrets domain save', () => {
  it('wakes the poll of each Running Workload that references the Secret', async () => {
    const requestPoll = vi.fn().mockResolvedValue(undefined);
    const store = {
      listSecrets: vi.fn(),
      saveSecret: vi.fn().mockResolvedValue(undefined),
      listRunningVmHostWorkloadIds: vi.fn().mockResolvedValue(['a', 'b']),
      deleteSecretIfNotReferenced: vi.fn(),
    };
    await createSecretsDomain({ store, requestPoll }).save({
      name: 'hf',
      values: { HF_TOKEN: 'new' },
    });
    expect(store.saveSecret).toHaveBeenCalledWith('hf', { HF_TOKEN: 'new' });
    await vi.waitFor(() => expect(requestPoll).toHaveBeenCalledTimes(2));
    expect(store.listRunningVmHostWorkloadIds).toHaveBeenCalledWith('hf');
    expect(requestPoll.mock.calls.map(([id]) => id)).toEqual(['a', 'b']);
  });

  it('saves even when waking a poll fails', async () => {
    const store = {
      listSecrets: vi.fn(),
      saveSecret: vi.fn().mockResolvedValue(undefined),
      listRunningVmHostWorkloadIds: vi.fn().mockResolvedValue(['a']),
      deleteSecretIfNotReferenced: vi.fn(),
    };
    await expect(
      createSecretsDomain({
        store,
        requestPoll: vi.fn().mockRejectedValue(new Error('down')),
      }).save({ name: 'hf', values: { K: 'v' } }),
    ).resolves.toBeUndefined();
  });
});

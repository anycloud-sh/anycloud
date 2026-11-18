import { describe, expect, it } from 'vitest';
import {
  hasCheckpointTarget,
  resolveCheckpointTarget,
} from '../../../src/shared/checkpoint';

describe('checkpoint target resolution', () => {
  it('keeps the implicit workload-named spot bucket managed', () => {
    expect(resolveCheckpointTarget('job-1', { spot: true })).toEqual({
      name: 'job-1',
      managed: true,
    });
  });

  it('gives a --no-checkpoint spot Job no bucket', () => {
    const config = { spot: true, noCheckpoint: true };
    expect(resolveCheckpointTarget('job-1', config)).toBeUndefined();
    expect(hasCheckpointTarget(config)).toBe(false);
  });

  it('treats an explicit bucket as user-owned, including on spot', () => {
    expect(
      resolveCheckpointTarget('job-1', {
        spot: true,
        checkpointBucket: 'shared-state',
      }),
    ).toEqual({
      name: 'shared-state',
      managed: false,
    });
  });

  it('recognizes explicit non-spot checkpoint storage', () => {
    const config = { spot: false, checkpointBucket: 'server-state' };
    expect(hasCheckpointTarget(config)).toBe(true);
    expect(resolveCheckpointTarget('server-1', config)).toEqual({
      name: 'server-state',
      managed: false,
    });
  });
});

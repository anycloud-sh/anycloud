import { describe, expect, it } from 'vitest';
import {
  InterruptedError,
  runUntilInterrupted,
} from '../../../src/cli/utils/interrupt.js';

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), {
      once: true,
    });
  });
}

describe('runUntilInterrupted', () => {
  it('returns successful work and restores the process listener', async () => {
    const originalListeners = process.listenerCount('SIGINT');

    await expect(
      runUntilInterrupted('Test work', async () => 'finished'),
    ).resolves.toBe('finished');
    expect(process.listenerCount('SIGINT')).toBe(originalListeners);
  });

  it('preserves unrelated failures and restores the process listener', async () => {
    const originalListeners = process.listenerCount('SIGINT');
    const failure = new Error('Work failed');

    await expect(
      runUntilInterrupted('Test work', async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(process.listenerCount('SIGINT')).toBe(originalListeners);
  });

  it('aborts on SIGINT and restores the process listener', async () => {
    const originalListeners = process.listenerCount('SIGINT');
    let workSignal: AbortSignal | undefined;
    const run = runUntilInterrupted('Test work', (signal) => {
      workSignal = signal;
      return waitForAbort(signal);
    });

    process.emit('SIGINT', 'SIGINT');

    await expect(run).rejects.toBeInstanceOf(InterruptedError);
    expect(workSignal?.aborted).toBe(true);
    expect(process.listenerCount('SIGINT')).toBe(originalListeners);
  });

  it('reports interruption when work resolves after SIGINT', async () => {
    const originalListeners = process.listenerCount('SIGINT');
    const run = runUntilInterrupted(
      'Test work',
      (signal) =>
        new Promise<string>((resolve) => {
          signal.addEventListener(
            'abort',
            () => resolve('finished after abort'),
            {
              once: true,
            },
          );
        }),
    );

    process.emit('SIGINT', 'SIGINT');

    await expect(run).rejects.toBeInstanceOf(InterruptedError);
    expect(process.listenerCount('SIGINT')).toBe(originalListeners);
  });
});

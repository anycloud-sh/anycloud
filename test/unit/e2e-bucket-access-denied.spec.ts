import { describe, expect, it } from 'vitest';

import {
  Granted,
  untilDenied,
} from '../integration/e2e/internal/bucket-access-denied.js';

/** A fake clock that advances only when the poller waits. */
function ports() {
  let clock = 0;
  return {
    now: () => clock,
    random: () => 1,
    wait: async (milliseconds: number) => {
      clock += milliseconds;
    },
  };
}

function attempts(...outcomes: (Error | 'ok')[]) {
  let calls = 0;
  const attempt = async () => {
    const outcome = outcomes[Math.min(calls++, outcomes.length - 1)];
    if (outcome !== 'ok') throw outcome;
  };
  return { attempt, calls: () => calls };
}

describe('untilDenied', () => {
  it('returns on the first denial', async () => {
    const run = attempts(new Error('An error occurred (AccessDenied)'));
    await untilDenied(run.attempt, /AccessDenied/u, ports());
    expect(run.calls()).toBe(1);
  });

  it('retries an identity that does not authenticate yet, then accepts the denial', async () => {
    const run = attempts(
      new Error('An error occurred (InvalidAccessKeyId)'),
      new Error('An error occurred (AccessDenied)'),
    );
    await untilDenied(run.attempt, /AccessDenied/u, ports());
    expect(run.calls()).toBe(2);
  });

  it('fails at once when the principal is allowed', async () => {
    const run = attempts('ok');
    await expect(
      untilDenied(run.attempt, /AccessDenied/u, ports()),
    ).rejects.toBeInstanceOf(Granted);
    expect(run.calls()).toBe(1);
  });

  it('with a hold, resolves only after denials span the whole window', async () => {
    const run = attempts(new Error('ARM 403 AuthorizationFailed'));
    await untilDenied(run.attempt, /^ARM 403 AuthorizationFailed$/u, {
      ...ports(),
      holdMs: 30_000,
    });
    // Denied at 0, 1, 3, 7, 15 and 30 s: the sixth call completes the window.
    expect(run.calls()).toBe(6);
  });

  it('restarts the hold window on any other answer', async () => {
    const denied = new Error('ARM 403 AuthorizationFailed');
    const run = attempts(
      denied,
      denied,
      new Error('Entra 401 7000215'),
      denied,
    );
    await untilDenied(run.attempt, /^ARM 403 AuthorizationFailed$/u, {
      ...ports(),
      holdMs: 10_000,
    });
    // Without the restart at 3 s, the denial at 15 s would already be held 15 s
    // (5 calls); restarted at 7 s, it completes at 30 s (6 calls).
    expect(run.calls()).toBe(6);
  });

  it('makes a last attempt at the deadline and surfaces its error', async () => {
    const run = attempts(new Error('AADSTS700016: application not found'));
    await expect(
      untilDenied(run.attempt, /AuthorizationFailed/u, ports()),
    ).rejects.toThrow('AADSTS700016');
    // 1 s doubling to 15 s caps, with no jitter, inside the 5 min window.
    expect(run.calls()).toBe(24);
  });
});

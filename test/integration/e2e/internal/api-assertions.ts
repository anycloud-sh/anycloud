import assert from 'node:assert/strict';

import type { CommandResult } from './types.js';

/** Reject interrupted/truncated output before any observation consumes it. */
export function completedCommand(result: CommandResult, label: string): string {
  // A killed or unstarted command has no exit code; name why first.
  assert.equal(result.timedOut, false, `${label} timed out`);
  assert.equal(result.aborted, false, `${label} was aborted`);
  assert.equal(result.signal, null, `${label} was signalled`);
  assert.equal(result.spawnError, undefined, `${label} failed to start`);
  assert.equal(result.exitCode, 0, `${label}: ${result.combined}`);
  assert.equal(result.outputTruncated, false, `${label} output was truncated`);
  return result.stdout.trim();
}

export function rejectedCommand(result: CommandResult, message: string): void {
  assert.notEqual(result.exitCode, 0, 'Command unexpectedly succeeded');
  assert.notEqual(result.exitCode, null, 'Command did not exit normally');
  assert.equal(result.timedOut, false, 'A timeout is not a rejection');
  assert.equal(result.aborted, false, 'Cancellation is not a rejection');
  assert.equal(result.signal, null, 'A signal is not a rejection');
  assert.equal(
    result.spawnError,
    undefined,
    'A spawn failure is not a rejection',
  );
  assert.equal(result.outputTruncated, false, 'Rejection output was truncated');
  assert.ok(result.combined.includes(message), `Missing rejection: ${message}`);
}

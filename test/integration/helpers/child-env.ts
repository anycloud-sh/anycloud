import { UNATTENDED_MARKERS } from '../../../src/cli/session/detect.js';

/**
 * The test runner's environment for a child CLI, without undefined values
 * (node-pty would pass them as "undefined") or agent markers: a test run
 * inside an agent must not make the child an agent run.
 */
export function childEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !UNATTENDED_MARKERS.includes(entry[0]),
    ),
  );
}

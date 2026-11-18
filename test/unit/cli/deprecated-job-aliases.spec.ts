import { describe, expect, it } from 'vitest';
import { rewriteDeprecatedJobAlias } from '../../../src/cli/deprecated-job-aliases.js';

describe('rewriteDeprecatedJobAlias', () => {
  it.each(['run', 'submit'])('runs `anycloud %s` as `anycloud job`', (name) => {
    const argv = ['node', 'anycloud', name, 'list', '--json'];
    const warnings: string[] = [];

    rewriteDeprecatedJobAlias(argv, (message) => warnings.push(message));

    expect(argv).toEqual(['node', 'anycloud', 'job', 'list', '--json']);
    expect(warnings).toEqual([
      `\`anycloud ${name}\` is deprecated; use \`anycloud job\`. It will be removed in a future release.`,
    ]);
  });

  it.each([['serve'], ['job'], ['status', 'run']])(
    'leaves other commands unchanged: %s',
    (...args) => {
      const argv = ['node', 'anycloud', ...args];
      const warnings: string[] = [];

      rewriteDeprecatedJobAlias(argv, (message) => warnings.push(message));

      expect(argv).toEqual(['node', 'anycloud', ...args]);
      expect(warnings).toEqual([]);
    },
  );
});

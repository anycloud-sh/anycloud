import { describe, expect, it } from 'vitest';
import { workloadIdProblem } from '../../../src/shared/workload-id.js';

// The 28/29-character boundary is covered through `validateId` in
// workload-admission-checks.spec.ts.
describe('workloadIdProblem', () => {
  it('reports the length before the character rules', () => {
    expect(workloadIdProblem('A'.repeat(30))).toBe(
      'is 30 characters; the limit is 28.',
    );
  });

  it.each(['My-Job', 'my_job', '-job', 'job-', 'job.1'])(
    'refuses %s with the character rules',
    (id) => {
      expect(workloadIdProblem(id)).toBe(
        'must contain only lowercase letters, numbers and hyphens, and must start and end with a letter or number.',
      );
    },
  );

  it.each(['a', '7', 'a-b', 'my--job'])('accepts %s', (id) => {
    expect(workloadIdProblem(id)).toBeUndefined();
  });

  it('refuses an empty ID', () => {
    expect(workloadIdProblem('')).toBe('cannot be empty.');
  });
});

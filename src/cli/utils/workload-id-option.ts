import { InvalidArgumentError } from 'commander';
import { workloadIdProblem } from '../../shared/workload-id.js';

/** Commander parser for `--id`: refuses an invalid workload ID before any API call. */
export function parseWorkloadIdOption(raw: string): string {
  const id = raw.trim();
  const problem = workloadIdProblem(id);
  // Commander's message already names the ID.
  if (problem) throw new InvalidArgumentError(`It ${problem}`);
  return id;
}

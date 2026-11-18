import type { JobSpecInput } from '../../shared/api-contract/workload-admission-schemas.js';
import { InvalidAnycloudConfigError } from '../../shared/errors.js';

/**
 * Refuse every neutral Job spec value the substrate can't run yet (RFC 0046
 * § The neutral Job spec), naming the field and its flag. `subject` names the
 * workload and its substrate, such as "A Job on a VM host". `gpusPerNode` is
 * admitted only when it equals `gpuCount`, the one GPU count the workload
 * already asks for; without one, every `gpusPerNode` is refused.
 */
export function assertDefaultJobSpec(
  spec: JobSpecInput,
  subject: string,
  gpuCount?: number,
): void {
  const { gpusPerNode } = spec;
  const refused: Array<[boolean, string]> = [
    [
      spec.nodes !== undefined && spec.nodes !== 1,
      `nodes ${spec.nodes} (--nodes)`,
    ],
    [spec.launch === 'distributed', 'launch distributed (--launch)'],
    [(spec.mounts?.length ?? 0) > 0, 'mounts (--mount)'],
    [spec.timeLimit !== undefined, 'timeLimit (--time-limit)'],
    [spec.resumable === true, 'resumable (--resumable)'],
    [
      gpusPerNode !== undefined && gpusPerNode !== gpuCount,
      `gpusPerNode ${gpusPerNode} (--gpus-per-node)${gpuCount ? ` other than ${gpuCount}` : ''}`,
    ],
  ];
  const offending = refused.find(([present]) => present);
  if (offending) {
    throw new InvalidAnycloudConfigError(
      `${subject} does not accept ${offending[1]} yet.`,
    );
  }
}

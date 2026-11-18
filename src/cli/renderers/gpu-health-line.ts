import type { WorkloadStatusResponse } from '../../shared/api-contract/workload-management-schemas.js';
import { componentLine } from './component-line.js';

type StatusVm = NonNullable<WorkloadStatusResponse['vms']>[number];

/** A GPU VM's GPU health, one line per GPU that needs attention. */
export function gpuLines(gpu: StatusVm['gpu'], isPending: boolean): string[] {
  if (!gpu) return [];
  const label = 'gpu'.padEnd(11);
  if (gpu.state === 'healthy') {
    const count = gpu.gpus.length;
    return [
      `    ${componentLine(label, true, isPending, `healthy (${count} GPU${count === 1 ? '' : 's'})`)}`,
    ];
  }
  if (gpu.state === 'unknown') {
    return [
      `    ${componentLine(label, false, true, `unknown${gpu.detail ? ` (${gpu.detail})` : ''}`)}`,
    ];
  }
  // The latest Xid that needs a reset, the one to name.
  const latest = (xids: (typeof gpu.gpus)[number]['xids']) => {
    const xid = xids.filter((entry) => entry.resetNeeded).at(-1);
    return xid ? `Xid ${xid.code}${xid.at ? ` at ${xid.at}` : ''}` : null;
  };
  const faults = gpu.gpus.flatMap((entry) => {
    const name =
      entry.index === null ? `GPU at ${entry.pci}` : `GPU ${entry.index}`;
    const xid = latest(entry.xids);
    if (entry.resetRequired || entry.recoveryAction || xid) {
      const why = [entry.recoveryAction, xid].filter(Boolean).join(', ');
      return [`${name} needs a reset${why ? ` (${why})` : ''}`];
    }
    return [];
  });
  return [...faults, ...(gpu.detail ? [gpu.detail] : [])]
    .concat(faults.length === 0 && !gpu.detail ? ['unhealthy'] : [])
    .map((text) => `    ${componentLine(label, false, false, text)}`);
}

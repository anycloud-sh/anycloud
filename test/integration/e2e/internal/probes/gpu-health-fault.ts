/**
 * #2332's unhealthy path, live: one externally injected `NVRM: Xid` line, in
 * the driver's own words, that `src/api/services/host-runtime/gpu-health.ts`'s
 * own journal read turns into an unhealthy GPU. A plain Job's container has no
 * `/dev/kmsg` and the product only reads health, so the fault is written from
 * outside it, over the product's own SSH route (`RemoteExecutor`), as root or
 * `sudo -n`, the same branch `GPU_HEALTH_COMMAND` reads the journal with.
 *
 * Xid 79 ("GPU has fallen off the bus") is one of `UNHEALTHY_XIDS`, so the
 * same line both turns the read unhealthy and marks that Xid `resetNeeded`.
 */
import { gpuLines } from '../../../../../src/cli/renderers/gpu-health-line.js';
import type { GpuHealth } from '../../../../../src/shared/api-contract/workload-management-schemas.js';

/** #2332's injected fault: Xid 79, GPU has fallen off the bus. */
export const GPU_HEALTH_FAULT_XID = 79;

/** Only this spike/harness ever names itself in an injected Xid line. */
const FAULT_LABEL = 'gpu-health-fault-e2e';

/**
 * nvidia-smi's PCI address (`00000000:00:1E.0`: domain:bus:device.function)
 * as the driver names it in its own `NVRM: Xid (PCI:<addr>):` lines
 * (`0000:00:1e`: the domain's last four hex digits, the bus, the device).
 */
export function driverPci(pci: string): string {
  const [domain, bus, device] = pci.split(':');
  if (!domain || !bus || !device)
    throw new Error(`not an nvidia-smi PCI address: ${pci}`);
  return `${domain.slice(-4)}:${bus}:${device.split('.')[0]}`.toLowerCase();
}

/** The kernel message this fault writes to `/dev/kmsg`, in the driver's own words. */
export function gpuHealthFaultLine(
  pci: string,
  code = GPU_HEALTH_FAULT_XID,
): string {
  return `<3>NVRM: Xid (PCI:${driverPci(pci)}): ${code}, pid=0, name=${FAULT_LABEL}, GPU has fallen off the bus.`;
}

/**
 * The substring the kernel journal carries once the line above lands dropped
 * its syslog priority (`<3>`), which `journalctl` never prints back.
 */
export function gpuHealthFaultNeedle(
  pci: string,
  code = GPU_HEALTH_FAULT_XID,
): string {
  return `NVRM: Xid (PCI:${driverPci(pci)}): ${code}, pid=0`;
}

/**
 * A POSIX sh script writing the line to `/dev/kmsg`, then reading it straight
 * back from this boot's kernel journal, so the harness confirms the fault
 * landed before it waits on the product's own, slower read of the same
 * journal. `sleep 2` gives the journal a moment to pick up the kmsg line.
 */
export function gpuHealthFaultScript(
  pci: string,
  code = GPU_HEALTH_FAULT_XID,
): string {
  const line = gpuHealthFaultLine(pci, code);
  const quoted = `'${line.replaceAll("'", "'\\''")}'`;
  return [
    `printf '%s\\n' ${quoted} > /dev/kmsg`,
    'sleep 2',
    "journalctl -k -b --no-pager -o short-iso | grep -F 'NVRM: Xid'",
  ].join('; ');
}

/** The same root/`sudo -n` branch `GPU_HEALTH_COMMAND` reads the journal with. */
export function gpuHealthFaultCommand(
  pci: string,
  code = GPU_HEALTH_FAULT_XID,
): string {
  const script = gpuHealthFaultScript(pci, code);
  const quoted = `'${script.replaceAll("'", "'\\''")}'`;
  return `if [ "$(id -u)" = 0 ]; then sh -c ${quoted}; else sudo -n sh -c ${quoted}; fi`;
}

/**
 * The human `anycloud status` line naming the reset a faulted GPU needs, the
 * same renderer the CLI uses (`src/cli/renderers/gpu-health-line.js`), so the
 * harness proves the production wording rather than reimplementing it.
 */
export function gpuHealthFaultHumanLine(gpu: GpuHealth): string | undefined {
  return gpuLines(gpu, false).find((line) => line.includes('needs a reset'));
}

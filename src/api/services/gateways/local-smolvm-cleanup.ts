import { isOlderThan, type ResourceSweepResult } from './resource-sweeper.js';
import {
  isSmolvmNotFound,
  smolvmCreatedAtMs,
  type SmolvmMachineInfo,
} from './smolvm-serve-client.js';
import { errorMessage } from '../../../shared/log-diagnostics.js';

export interface LocalSmolvmCleanupConfig {
  machinePrefix: string;
}

export interface LocalSmolvmCleanupClient {
  listMachines(): Promise<SmolvmMachineInfo[]>;
  stopMachine(name: string): Promise<unknown>;
  deleteMachine(name: string, force?: boolean): Promise<unknown>;
}

export interface LocalSmolvmCleanupRuntime {
  config: LocalSmolvmCleanupConfig;
  client: LocalSmolvmCleanupClient;
}

export interface CleanupLocalSmolvmMachinesOptions {
  dryRun?: boolean;
  /** Pass null during CI teardown to remove every owned Local VM. */
  minAgeMs: number | null;
}

export async function cleanupLocalSmolvmMachines(
  runtime: LocalSmolvmCleanupRuntime,
  options: CleanupLocalSmolvmMachinesOptions,
): Promise<ResourceSweepResult> {
  const dryRun = options.dryRun ?? false;
  const minAgeMs = options.minAgeMs;
  const candidates = (await runtime.client.listMachines()).filter((machine) =>
    isLocalSmolvmCleanupCandidate(machine, runtime.config, minAgeMs),
  );
  const result: ResourceSweepResult = {
    vmIds: [],
    otherResources: [],
    errors: [],
  };

  for (const machine of candidates) {
    if (dryRun) {
      result.vmIds.push(machine.name);
      continue;
    }
    try {
      await deleteLocalSmolvmMachine(runtime.client, machine.name);
      result.vmIds.push(machine.name);
    } catch (error) {
      result.errors.push({
        resourceType: 'vm',
        resourceId: machine.name,
        error: errorMessage(error),
      });
    }
  }

  return result;
}

export function isLocalSmolvmCleanupCandidate(
  machine: SmolvmMachineInfo,
  config: LocalSmolvmCleanupConfig,
  minAgeMs: number | null,
): boolean {
  if (!machine.name?.startsWith(config.machinePrefix)) return false;
  if (minAgeMs === null) return true;
  return isOlderThan(normalizeMachineCreatedAt(machine.createdAt), minAgeMs);
}

async function deleteLocalSmolvmMachine(
  client: LocalSmolvmCleanupClient,
  machineName: string,
): Promise<void> {
  try {
    await client.stopMachine(machineName);
  } catch (error) {
    if (isSmolvmNotFound(error)) return;
    // Force-delete remains the authoritative cleanup step.
  }
  try {
    await client.deleteMachine(machineName, true);
  } catch (error) {
    if (!isSmolvmNotFound(error)) throw error;
  }
}

// Resolve to a Date here rather than handing isOlderThan the raw value: it
// reads a bare digit string as milliseconds, which would date an
// epoch-seconds machine to 1970 and make this guard delete a live VM.
function normalizeMachineCreatedAt(
  value: number | string | undefined,
): Date | undefined {
  const milliseconds = smolvmCreatedAtMs(value);
  return milliseconds === undefined ? undefined : new Date(milliseconds);
}

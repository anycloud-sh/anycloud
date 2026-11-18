import { LOCAL_SMOLVM_CONTRACT } from '../../../../../src/api/services/gateways/local-smolvm-contract.js';

import type { ArtifactStore } from '../artifacts.js';
import type {
  LocalSmolvmRunningObservation,
  LocalSmolvmTerminatedObservation,
  PersistentVmRunningContext,
  PersistentVmRunningObservationAttempt,
  PersistentVmTargetTransport,
  PersistentVmTerminatedObservationAttempt,
} from '../targets/persistent-vm-types.js';
import { isRecord } from '../types.js';
import type { TargetHttpClient } from './http.js';
import type {
  VmHostObservationOptions,
  VmHostPresenceObservation,
} from './public-cloud-vm-host-presence.js';
import { CloudType } from '../../../../../src/shared/cloud.js';

export interface SmolvmPort {
  readonly guest: number;
  readonly host: number;
}

export interface SmolvmMachine {
  readonly name: string;
  readonly ports: readonly SmolvmPort[];
  readonly state: string;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`smolvm ${field} was not a nonempty string`);
  }
  return value;
}

function requiredPort(value: unknown, field: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > 65_535
  ) {
    throw new Error(`smolvm ${field} was not a valid TCP port`);
  }
  return value;
}

export function parseSmolvmMachines(value: unknown): readonly SmolvmMachine[] {
  const candidates = Array.isArray(value)
    ? value
    : isRecord(value) &&
        Object.keys(value).length === 1 &&
        Array.isArray(value.machines)
      ? value.machines
      : undefined;
  if (!candidates) throw new Error('smolvm machine response was not a list');

  const names = new Set<string>();
  return candidates.map((candidate, machineIndex) => {
    if (!isRecord(candidate)) {
      throw new Error(
        `smolvm machine ${String(machineIndex)} was not an object`,
      );
    }
    if (!Array.isArray(candidate.ports)) {
      throw new Error(
        `smolvm machine ${String(machineIndex)} ports was not a list`,
      );
    }
    const name = requiredString(
      candidate.name,
      `machine ${String(machineIndex)} name`,
    );
    if (names.has(name)) throw new Error('smolvm inventory repeats a machine');
    names.add(name);
    return {
      name,
      state: requiredString(
        candidate.state,
        `machine ${String(machineIndex)} state`,
      ),
      ports: candidate.ports.map((port, portIndex) => {
        if (!isRecord(port)) {
          throw new Error(
            `smolvm machine ${String(machineIndex)} port ${String(portIndex)} was not an object`,
          );
        }
        return {
          guest: requiredPort(
            port.guest,
            `machine ${String(machineIndex)} port ${String(portIndex)} guest`,
          ),
          host: requiredPort(
            port.host,
            `machine ${String(machineIndex)} port ${String(portIndex)} host`,
          ),
        };
      }),
    };
  });
}

/** Cleanup reads the adopted native ID, including names unlike a Workload prefix. */
export async function observeLocalSmolvmHost(
  http: Pick<TargetHttpClient, 'get'>,
  smolvmUrl: URL,
  cloudId: string,
  options: VmHostObservationOptions = {},
): Promise<VmHostPresenceObservation> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(cloudId))
    throw new Error('Local native machine identity is invalid');
  const response = await http.get(
    'local-smolvm-native-host',
    new URL('/api/v1/machines', smolvmUrl),
    { ...options, redirect: 'error' },
  );
  if (response.status !== 200)
    throw new Error('Local native machine inventory did not return HTTP 200');
  const machine = parseSmolvmMachines(response.body).find(
    (candidate) => candidate.name === cloudId,
  );
  return {
    provider: CloudType.Local,
    cloudId,
    presence: machine ? 'present' : 'absent',
    diagnostic: machine ? 'Local machine present' : 'Local machine absent',
  };
}

export function smolvmSshPort(machine: SmolvmMachine): SmolvmPort {
  const candidates = machine.ports.filter((port) => port.guest === 22);
  if (candidates.length !== 1) {
    throw new Error(
      `smolvm machine ${machine.name} exposed ${String(candidates.length)} SSH mappings; expected exactly one guest port 22`,
    );
  }
  return candidates[0];
}

export async function ownedSmolvmMachines(
  http: Pick<TargetHttpClient, 'get'>,
  smolvmUrl: URL,
  workloadId: string,
  options: VmHostObservationOptions & { readonly cloudId?: string } = {},
): Promise<readonly SmolvmMachine[]> {
  const { cloudId, ...requestOptions } = options;
  if (cloudId !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(cloudId))
    throw new Error('Local native machine identity is invalid');
  const response = await http.get(
    'local-smolvm-machines',
    new URL('/api/v1/machines', smolvmUrl),
    { ...requestOptions, redirect: 'error' },
  );
  if (response.status !== 200) {
    throw new Error(
      `smolvm machine list returned HTTP ${String(response.status)}`,
    );
  }
  const prefix = `ac-local-${workloadId}-`;
  return parseSmolvmMachines(response.body).filter(
    (machine) => machine.name.startsWith(prefix) || machine.name === cloudId,
  );
}

export function smolvmGuestPort(machine: SmolvmMachine, guest: number): number {
  const candidates = machine.ports.filter((port) => port.guest === guest);
  if (candidates.length !== 1) {
    throw new Error(
      `smolvm machine ${machine.name} exposed ${String(candidates.length)} mappings for guest port ${String(guest)}; expected exactly one`,
    );
  }
  return candidates[0].host;
}

export async function deleteLocalSmolvmHost(
  http: Pick<TargetHttpClient, 'delete'>,
  smolvmUrl: URL,
  context: PersistentVmRunningContext,
): Promise<void> {
  const url = new URL(
    `/api/v1/machines/${encodeURIComponent(context.cloudId)}`,
    smolvmUrl,
  );
  url.searchParams.set('force', 'true');
  const response = await http.delete('local-delete-vm-host', url);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `Local host deletion returned HTTP ${String(response.status)}`,
    );
  }
}

export class LocalSmolvmPersistentVmTransport
  implements PersistentVmTargetTransport
{
  readonly #artifacts: ArtifactStore;
  readonly #http: TargetHttpClient;
  readonly #smolvmUrl = new URL(LOCAL_SMOLVM_CONTRACT.baseUrl);

  constructor(artifacts: ArtifactStore, http: TargetHttpClient) {
    this.#artifacts = artifacts;
    this.#http = http;
  }

  async observeRunning(
    context: PersistentVmRunningContext,
  ): Promise<PersistentVmRunningObservationAttempt> {
    const machines = await this.#ownedMachines(context.ref.id);
    const machine = machines[0];
    const sshPort = machine ? smolvmSshPort(machine) : undefined;
    const observation: LocalSmolvmRunningObservation = {
      kind: 'local-smolvm',
      machineCount: machines.length,
      machineName: machine?.name ?? '',
      machineState: machine?.state ?? '',
      portCount: machine?.ports.length ?? 0,
      sshGuestPort: sshPort?.guest ?? 0,
      sshHostPort: sshPort?.host ?? 0,
    };
    await this.#artifacts.json('local-smolvm-running-observation', observation);
    return { kind: 'observed', observation };
  }

  async observeTerminated(
    context: PersistentVmRunningContext,
    deadlineAt?: number,
  ): Promise<PersistentVmTerminatedObservationAttempt> {
    const machines = await ownedSmolvmMachines(
      this.#http,
      this.#smolvmUrl,
      context.ref.id,
      {
        cloudId: context.cloudId,
        ...(deadlineAt === undefined ? {} : { deadlineAt }),
      },
    );
    const observation: LocalSmolvmTerminatedObservation = {
      kind: 'local-smolvm',
      remainingMachineCount: machines.length,
    };
    await this.#artifacts.json(
      'local-smolvm-terminated-observation',
      observation,
    );
    return { kind: 'observed', observation };
  }

  async deleteHost(context: PersistentVmRunningContext): Promise<void> {
    await deleteLocalSmolvmHost(this.#http, this.#smolvmUrl, context);
  }

  async #ownedMachines(workloadId: string): Promise<readonly SmolvmMachine[]> {
    return ownedSmolvmMachines(this.#http, this.#smolvmUrl, workloadId);
  }
}

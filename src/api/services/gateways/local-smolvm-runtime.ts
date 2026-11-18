import { LOCAL_SMOLVM_CONTRACT } from './local-smolvm-contract.js';
import { SmolvmServeClient } from './smolvm-serve-client.js';

export interface LocalSmolvmRuntimeConfig {
  baseUrl: string;
  sidecarPath: string;
  sshHost: string;
  sshUsername: string;
  machinePrefix: string;
  networkBackend: string;
  requestTimeoutMs: number;
  provisionTimeoutMs: number;
  setupTimeoutSecs: number;
  bucketHostPath: string;
  cpus?: number;
  memoryMb?: number;
  overlayGb?: number;
  storageGb?: number;
}

export type LocalSmolvmRuntimeClient = Pick<
  SmolvmServeClient,
  | 'health'
  | 'listMachines'
  | 'createMachine'
  | 'startMachine'
  | 'execMachine'
  | 'stopMachine'
  | 'deleteMachine'
  | 'getMachine'
>;

export interface LocalSmolvmRuntime {
  config: LocalSmolvmRuntimeConfig;
  client: LocalSmolvmRuntimeClient;
}

const DEFAULT_LOCAL_SMOLVM_RUNTIME_CONFIG = Object.freeze({
  baseUrl: LOCAL_SMOLVM_CONTRACT.baseUrl,
  sidecarPath: LOCAL_SMOLVM_CONTRACT.runnerSidecarPath,
  sshHost: 'localhost',
  sshUsername: 'root',
  machinePrefix: 'ac-local-',
  networkBackend: 'virtio-net',
  requestTimeoutMs: 30_000,
  provisionTimeoutMs: 180_000,
  setupTimeoutSecs: 120,
  bucketHostPath: LOCAL_SMOLVM_CONTRACT.bucketHostPath,
  // Sized for the widest lane rather than for comfort: the fan-out lane boots
  // several of these beside a host-networked API on a small CI runner, and a
  // sleeping workload with its own dockerd measured ~135 MB resident.
  cpus: 1,
  memoryMb: 512,
  overlayGb: 4,
  storageGb: 4,
} as const satisfies LocalSmolvmRuntimeConfig);

/** Construct the fixed default runtime without contacting the host service. */
export function createDefaultLocalSmolvmRuntime(): LocalSmolvmRuntime {
  return {
    config: DEFAULT_LOCAL_SMOLVM_RUNTIME_CONFIG,
    client: new SmolvmServeClient({
      baseUrl: DEFAULT_LOCAL_SMOLVM_RUNTIME_CONFIG.baseUrl,
      timeoutMs: DEFAULT_LOCAL_SMOLVM_RUNTIME_CONFIG.requestTimeoutMs,
      provisionTimeoutMs:
        DEFAULT_LOCAL_SMOLVM_RUNTIME_CONFIG.provisionTimeoutMs,
    }),
  };
}

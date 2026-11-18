import { LOGS_CONTAINER_NOT_READY } from '../../../shared/api-contract/native-schemas.js';
import { DockerManager, STATUS_INSPECT_TIMEOUT_MS } from '../docker.js';
import { channelBoundCommand } from '../gateways/channel-bound-command.js';
import { createTransport, createUserTransport } from '../gateways/transport.js';
import { log } from '../logger.js';
import { SupervisorManager } from '../supervisor.js';
import { toPublicContainerStatus } from '../container-health.js';
import {
  GPU_HEALTH_COMMAND,
  GPU_HEALTH_TIMEOUT_SECONDS,
  hasNvidiaGpu,
  parseGpuHealth,
} from '../host-runtime/gpu-health.js';
import type { GpuHealth } from '../../../shared/api-contract/workload-management-schemas.js';
import { type StoredWorkload } from '../workload-record.js';
import {
  WorkloadState,
  isDeployPipelineState,
  isTerminalState,
} from '../../../shared/workload.js';
import {
  WorkloadHealthStatus,
  isContainerHealthy,
} from '../../../shared/runtime.js';
import { shellEscape } from '../../../shared/utils.js';
import type { DbVM } from '../entities.js';
import type {
  JobExecPreparation,
  JobHealthObservation,
  JobLogsPreparation,
  JobOperationStream,
  JobOperations,
  JobVmHealth,
} from './operations.js';
import { errorMessage } from '../../../shared/log-diagnostics.js';

const LOGS_MISSING_CONTAINER_SENTINEL = '__anycloud_missing_container__';

export type SingleLiveVmCapability = 'exec' | 'ssh';

export type SingleLiveVmResolution =
  | {
      ok: true;
      vm: DbVM;
    }
  | {
      ok: false;
      status: number;
      clientError: string;
      telemetryError: string;
    };

interface LogsVmCandidate {
  vm: DbVM;
}

interface LogsContainerProbe extends LogsVmCandidate {
  found: boolean;
  containerStatus?: string;
  error?: string;
}

type LogsTargetResolution =
  | {
      ok: true;
      vm: DbVM;
      containerStatus: string;
      probes: LogsContainerProbe[];
    }
  | {
      ok: false;
      status: number;
      code?: string;
      clientError: string;
      telemetryError: string;
      probes: LogsContainerProbe[];
    };

export function vmSshHost(vm: DbVM): string {
  return vm.sshHost ?? vm.ip;
}

function vmProbeKey(vm: DbVM): string {
  return `${vmSshHost(vm)}:${vm.sshPort ?? 22}:${vm.sshUsername ?? 'root'}`;
}

function getLiveVms(allVms: DbVM[]): DbVM[] {
  return allVms.filter((candidate) => candidate.endedAt == null);
}

export function resolveSingleLiveVm(
  allVms: DbVM[],
  capability: SingleLiveVmCapability,
): SingleLiveVmResolution {
  const liveVms = getLiveVms(allVms);
  if (liveVms.length === 0) {
    return {
      ok: false,
      status: 400,
      clientError: 'No live VMs found for this workload',
      telemetryError: 'No live VMs',
    };
  }
  if (liveVms.length > 1) {
    return {
      ok: false,
      status: 400,
      clientError: `Workload has ${liveVms.length} live VMs. ${capability} only supports single-VM workloads.`,
      telemetryError: 'Multiple live VMs',
    };
  }

  return {
    ok: true,
    vm: liveVms[0],
  };
}

async function observeVmHealth(
  workload: StoredWorkload,
  allVms: DbVM[],
  verbose: boolean,
): Promise<JobHealthObservation> {
  const liveVms = getLiveVms(allVms);
  if (liveVms.length === 0) {
    return { status: WorkloadHealthStatus.Unknown };
  }

  const gpuWorkload = hasNvidiaGpu(workload);
  const vmHealth = await Promise.all(
    liveVms.map(async (vm): Promise<JobVmHealth> => {
      const dockerManager = new DockerManager(
        vmSshHost(vm),
        workload.sshPrivateKey,
        vm.sshPort,
        vm.sshUsername,
      );
      const supervisorManager = new SupervisorManager(
        createTransport(
          vmSshHost(vm),
          workload.sshPrivateKey,
          vm.sshPort,
          vm.sshUsername,
        ),
      );
      const [containerStatus, rcloneStatus, gpu] = await Promise.all([
        dockerManager.getContainerStatus(workload.id),
        supervisorManager.getRcloneStatus(verbose),
        gpuWorkload ? readGpuHealth(workload, vm) : undefined,
      ]);
      return {
        ip: vm.ip,
        container: toPublicContainerStatus(containerStatus),
        rclone: rcloneStatus,
        ...(gpu ? { gpu } : {}),
      };
    }),
  );

  return {
    // An unhealthy GPU is down even when its container runs; an unread one
    // says nothing either way.
    status: vmHealth.every(
      (vm) => isContainerHealthy(vm.container) && vm.gpu?.state !== 'unhealthy',
    )
      ? WorkloadHealthStatus.Up
      : WorkloadHealthStatus.Down,
    vmHealth,
  };
}

/** The VM's GPU health; a read that fails is `unknown`, never healthy. */
async function readGpuHealth(
  workload: StoredWorkload,
  vm: DbVM,
): Promise<GpuHealth> {
  try {
    const { stdout } = await createTransport(
      vmSshHost(vm),
      workload.sshPrivateKey,
      vm.sshPort,
      vm.sshUsername,
    ).exec(
      GPU_HEALTH_COMMAND,
      1,
      false,
      (GPU_HEALTH_TIMEOUT_SECONDS + 1.5) * 1_000,
    );
    return parseGpuHealth(stdout);
  } catch (error) {
    return {
      state: 'unknown',
      gpus: [],
      detail: `the GPU read failed: ${errorMessage(error).slice(0, 200)}`,
    };
  }
}

async function streamRemoteCommand(args: {
  command: string;
  host: string;
  sshPrivateKey: string;
  sshPort?: number;
  sshUsername?: string;
  stream: JobOperationStream;
}): Promise<number> {
  const transport = createUserTransport(
    args.host,
    args.sshPrivateKey,
    args.sshPort,
    args.sshUsername,
  );
  return await transport.execStream(args.command, args.stream);
}

function prepareVmExec(
  workload: StoredWorkload,
  allVms: DbVM[],
  command: string,
): JobExecPreparation {
  const target = resolveSingleLiveVm(allVms, 'exec');
  if (!target.ok) return target;

  // The guard has to sit on the same side of the container boundary as the
  // process it stops. When the workload runs in a container, that means
  // inside it — a signal from the VM reaches only the `docker exec` client,
  // and dockerd keeps running the process behind it. `-i` is what carries
  // the channel's stdin in, so the guard sees the same EOF the VM does.
  //
  // Only one level of wrapping: wrapping out here too would background
  // `docker exec` under an outer guard, handing it /dev/null stdin and
  // firing the inner guard the moment the command started.
  const remoteCommand = `docker exec -i ${shellEscape(
    workload.id,
  )} /bin/sh -c ${shellEscape(channelBoundCommand(command))}`;
  const vm = target.vm;
  return {
    ok: true,
    run: (stream) =>
      streamRemoteCommand({
        command: remoteCommand,
        host: vmSshHost(vm),
        sshPrivateKey: workload.sshPrivateKey,
        sshPort: vm.sshPort,
        sshUsername: vm.sshUsername,
        stream,
      }),
  };
}

function buildLogsVmCandidates(allVms: DbVM[]): LogsVmCandidate[] {
  const candidates = getLiveVms(allVms).map((vm) => ({ vm }));
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = vmProbeKey(candidate.vm);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function probeLogsContainer(args: {
  candidate: LogsVmCandidate;
  workloadId: string;
  sshPrivateKey: string;
}): Promise<LogsContainerProbe> {
  const { candidate, workloadId, sshPrivateKey } = args;
  const inspectCommand = [
    `if docker inspect --type container --format '{{.State.Status}}' ${shellEscape(workloadId)} 2>/dev/null; then`,
    ':;',
    'else',
    `printf '%s\\n' ${shellEscape(LOGS_MISSING_CONTAINER_SENTINEL)};`,
    'fi',
  ].join(' ');
  const transport = createTransport(
    vmSshHost(candidate.vm),
    sshPrivateKey,
    candidate.vm.sshPort,
    candidate.vm.sshUsername,
  );

  try {
    const result = await transport.exec(
      inspectCommand,
      1,
      false,
      STATUS_INSPECT_TIMEOUT_MS,
    );
    const containerStatus = result.stdout.trim() || 'unknown';
    if (containerStatus === LOGS_MISSING_CONTAINER_SENTINEL) {
      return { ...candidate, found: false };
    }
    return { ...candidate, found: true, containerStatus };
  } catch (error) {
    return {
      ...candidate,
      found: false,
      error: errorMessage(error),
    };
  }
}

/**
 * Until a Workload ends, a missing VM or container is retryable: before it runs
 * it has not started yet, and while it runs it may be restarting or briefly
 * unreachable. Once it has ended, the original error is final.
 */
function containerNotReady(
  workload: StoredWorkload,
  error: string,
): { code?: string; clientError: string } {
  if (isTerminalState(workload.state)) return { clientError: error };
  return {
    code: LOGS_CONTAINER_NOT_READY,
    clientError:
      workload.state === WorkloadState.Queued ||
      workload.state === WorkloadState.Retrying ||
      isDeployPipelineState(workload.state)
        ? `Workload is ${workload.state}; its container is not running yet.`
        : `Workload is ${workload.state}. ${error}`,
  };
}

async function resolveLogsVmTarget(
  workload: StoredWorkload,
  allVms: DbVM[],
): Promise<LogsTargetResolution> {
  if (getLiveVms(allVms).length === 0) {
    return {
      ok: false,
      status: 400,
      ...containerNotReady(workload, 'No live VMs found for this workload'),
      telemetryError: 'No live VMs',
      probes: [],
    };
  }

  const probes = await Promise.all(
    buildLogsVmCandidates(allVms).map((candidate) =>
      probeLogsContainer({
        candidate,
        workloadId: workload.id,
        sshPrivateKey: workload.sshPrivateKey,
      }),
    ),
  );
  const matches = probes.filter((probe) => probe.found);
  if (matches.length === 1) {
    const target = matches[0];
    return {
      ok: true,
      vm: target.vm,
      containerStatus: target.containerStatus ?? 'unknown',
      probes,
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      status: 409,
      clientError: `Workload has ${matches.length} live VMs with a workload container named "${workload.id}". logs cannot choose safely.`,
      telemetryError: 'Multiple live VMs with workload container',
      probes,
    };
  }
  // A VM the probe could not reach may still hold the container.
  const unreachable = probes.filter((probe) => probe.error !== undefined);
  if (unreachable.length > 0) {
    return {
      ok: false,
      status: 409,
      ...containerNotReady(
        workload,
        unreachable
          .map(
            (probe) =>
              `Could not reach the VM ${vmSshHost(probe.vm)} over SSH: ${probe.error}`,
          )
          .join(' '),
      ),
      telemetryError: 'Live VM unreachable over SSH',
      probes,
    };
  }
  return {
    ok: false,
    status: 409,
    ...containerNotReady(
      workload,
      `No workload container named "${workload.id}" found on any live VM for this workload.`,
    ),
    telemetryError: 'No workload container found',
    probes,
  };
}

async function prepareVmLogs(
  workload: StoredWorkload,
  allVms: DbVM[],
  follow: boolean,
): Promise<JobLogsPreparation> {
  const target = await resolveLogsVmTarget(workload, allVms);
  if (!target.ok) {
    log.warn('LOGS target resolution failed', {
      id: workload.id,
      error: target.telemetryError,
      probes: target.probes.map((probe) => ({
        cloudId: probe.vm.cloudId,
        host: vmSshHost(probe.vm),
        endedAt: probe.vm.endedAt,
        found: probe.found,
        containerStatus: probe.containerStatus,
        probeError: probe.error,
      })),
    });
    return {
      ok: false,
      status: target.status,
      ...(target.code && { code: target.code }),
      clientError: target.clientError,
      telemetryError: target.telemetryError,
      probeCount: target.probes.length,
    };
  }

  // `exec` replaces the wrapping shell with docker, so an aborted follow
  // signals the long-lived `docker logs -f` directly rather than a shell
  // sitting in front of it. The SSH server does not signal anything of
  // its own here — `channelBoundCommand` is what stops the command.
  // `docker logs` runs on the VM, not in the container, so the guard
  // belongs out here where the process it stops actually lives.
  const remoteCommand = channelBoundCommand(
    `exec docker logs ${follow ? '-f ' : ''}${shellEscape(workload.id)}`,
  );
  const vm = target.vm;
  return {
    ok: true,
    probeCount: target.probes.length,
    targetContainerStatus: target.containerStatus,
    run: (stream) =>
      streamRemoteCommand({
        command: remoteCommand,
        host: vmSshHost(vm),
        sshPrivateKey: workload.sshPrivateKey,
        sshPort: vm.sshPort,
        sshUsername: vm.sshUsername,
        stream,
      }),
  };
}

export function createVmHostJobOperations(): JobOperations {
  return {
    observeHealth({
      workload,
      allVms,
      verbose,
    }): Promise<JobHealthObservation> {
      return observeVmHealth(workload, allVms, verbose);
    },

    async prepareExec({
      workload,
      allVms,
      command,
    }): Promise<JobExecPreparation> {
      return prepareVmExec(workload, allVms, command);
    },

    prepareLogs({ workload, allVms, follow }): Promise<JobLogsPreparation> {
      return prepareVmLogs(workload, allVms, follow);
    },
  };
}

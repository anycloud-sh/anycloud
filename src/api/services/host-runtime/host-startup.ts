/**
 * VM-host startup effects: SSH and Docker readiness, host initialization, the
 * image pull on every VM with its telemetry, container start with the named
 * runtime secrets, and startup health.
 */

import {
  getCredentialSecretStore,
  getWorkloadEventStore,
} from '../persistence.js';
import { DockerManager } from '../docker.js';
import { pullImage } from './image-delivery.js';
import type { StoredWorkload } from '../workload-record.js';
import { CloudConfig, GpuRuntime } from '../../../shared/cloud.js';
import {
  imagePullTelemetryFromError,
  type ImagePullTelemetry,
} from '../../../shared/image.js';
import { WorkloadType } from '../../../shared/workload.js';
import { defaultRuntimeGpuAccess } from '../../../shared/cloud-config.js';
import type { CloudVM, DbVM } from '../entities.js';
import { InvalidAnycloudConfigError } from '../../../shared/errors.js';
import { WORKLOAD_ACTION } from '../codes.js';
import { log } from '../logger.js';
import { createTransport } from '../gateways/transport.js';
import { mountsForVmStorage } from '../vm-runtime-storage.js';
import {
  classifyStartupReadiness,
  hasSatisfiedServiceStartupDwell,
} from '../container-health.js';
import {
  INITIALIZATION_TIMEOUT_MS,
  SSH_READY_TIMEOUT_MS,
} from '../../config.js';
import { pollUntilReady, sleep } from '../../../shared/utils.js';
import { initializeVM } from '../vm-initializer.js';
import type { RuntimeSecret } from '../runtime-secrets.js';

/** The named-secret read a container start performs. */
interface ContainerSecrets {
  getRuntimeSecret(name: string): Promise<RuntimeSecret | null>;
}
/** The event write that keeps image-pull telemetry on the Downloading step. */
interface ImagePullEvents {
  setImagePullTelemetry(
    workloadId: string,
    eventId: number,
    value: ImagePullTelemetry | undefined,
  ): Promise<void>;
}

const SSH_POLL_INTERVAL_MS = 2_000;

export async function waitForSshReady(
  vms: DbVM[],
  props: StoredWorkload,
): Promise<void> {
  const { sshPrivateKey } = props;

  if (!sshPrivateKey) {
    throw new Error('SSH private key missing from workload request');
  }

  // Wait for SSH on all VMs. Timed-out probes outlast the interval: the
  // 10-minute bound is a deadline, not only an attempt count.
  const deadline = Date.now() + SSH_READY_TIMEOUT_MS;
  await pollUntilReady({
    items: vms,
    getKey: (vm) => vm.ip,
    check: async (vm) => {
      if (Date.now() > deadline) {
        throw new Error(`SSH readiness timed out. Still pending: ${vm.ip}`);
      }
      const ssh = createTransport(
        vm.sshHost ?? vm.ip,
        sshPrivateKey,
        vm.sshPort,
      );

      // Stage 1: kernel-level TCP probe. The handshake completes in the
      // listener's backlog before sshd's userspace wakes, so a booting VM pays
      // no disk or session cost per attempt — the
      // previous ritual of three authenticated pings spawned full SSH
      // sessions against a machine that wasn't ready.
      // Fake transports don't implement the probe; fall through to exec.
      if (ssh.portReachable && !(await ssh.portReachable(5_000))) {
        return false; // port not accepting yet — free to retry
      }

      // Stage 2: one patient authenticated exec proves login + shell. Two
      // attempts (not three short ones) cover the race where our own startup
      // script restarts sshd mid-boot; a generous timeout matters because a
      // killed attempt forfeits in-flight progress while its page-cache
      // effects persist — long single waits strictly beat short retries.
      try {
        await ssh.exec('echo "ready"', 2, true, 30_000);
      } catch {
        // SSH accepts TCP but can't exec yet — retry on next poll interval.
        return false;
      }

      return true;
    },
    intervalMs: SSH_POLL_INTERVAL_MS,
    maxAttempts: Math.ceil(SSH_READY_TIMEOUT_MS / SSH_POLL_INTERVAL_MS), // 10 min bound
  });
}

export async function waitForDockerReady(
  vms: CloudVM[],
  props: StoredWorkload,
): Promise<void> {
  const intervalMs = 5_000;
  log.info('Waiting for Docker daemon to be ready on all VMs', {
    id: props.id,
    vmCount: vms.length,
  });

  await Promise.all(
    vms.map(async (vm) => {
      const deadline = performance.now() + INITIALIZATION_TIMEOUT_MS;
      const docker = new DockerManager(
        vm.sshHost ?? vm.ip,
        props.sshPrivateKey!,
        vm.sshPort,
      );
      while (performance.now() < deadline) {
        try {
          // This loop owns retries, so each probe gets one SSH attempt.
          if (await docker.ping(1)) return;
        } catch {
          // Docker or SSH is not ready yet.
        }
        const remainingMs = deadline - performance.now();
        if (remainingMs > 0) {
          await sleep(Math.min(intervalMs, remainingMs));
        }
      }
      throw new Error(`Docker readiness timed out. Still pending: ${vm.ip}`);
    }),
  );

  log.info('All VMs have Docker daemon ready', { id: props.id });
}

export async function initializeAllVMs(
  vms: CloudVM[],
  props: StoredWorkload,
  gpuRuntime: GpuRuntime | null,
  jobHost: boolean,
): Promise<void> {
  const { sshPrivateKey } = props;

  if (!sshPrivateKey) {
    throw new Error('SSH private key missing from workload request');
  }

  // Initialize VMs in parallel after SSH readiness has been established.
  await Promise.all(
    vms.map((vm) => {
      const ssh = createTransport(
        vm.sshHost ?? vm.ip,
        sshPrivateKey,
        vm.sshPort,
      );
      return initializeVM(ssh, {
        workloadId: props.id,
        vmIp: vm.ip,
        gpuRuntime,
        dockerRuntime: props.dockerOptions?.runtime ?? null,
        // Only a resumed Job re-pulls; nothing restores a Service's or a VM's
        // container after a redeploy empties the resource disk.
        ephemeralImageStore: props.workloadType === WorkloadType.Job,
        jobHost,
      });
    }),
  );
}

export async function pullImages(
  vms: CloudVM[],
  props: StoredWorkload,
  preferContainerdTransfer: boolean,
  eventId: number,
): Promise<void> {
  const { id, sshPrivateKey } = props;

  const results = await Promise.allSettled(
    vms.map(async (vm) => {
      log.info('Pulling image', {
        id,
        image: props.image,
        action: WORKLOAD_ACTION.STARTING,
        ip: vm.ip,
      });

      const docker = new DockerManager(
        vm.sshHost ?? vm.ip,
        sshPrivateKey!,
        vm.sshPort,
      );
      return pullImage(docker, props, { preferContainerdTransfer });
    }),
  );

  const failed = results.find((result) => result.status === 'rejected');
  const telemetry = failed
    ? imagePullTelemetryFromError(failed.reason)
    : results[0]?.status === 'fulfilled'
      ? results[0].value
      : undefined;
  const events: ImagePullEvents = getWorkloadEventStore();
  await events.setImagePullTelemetry(id, eventId, telemetry);
  if (failed) throw failed.reason;
}

export async function startContainers(
  vms: DbVM[],
  props: StoredWorkload,
  cloudConfig: CloudConfig,
): Promise<void> {
  const { id, sshPrivateKey } = props;

  const { runtimeProps, secrets } = await resolveContainerRuntime(
    props,
    cloudConfig,
  );

  const results = await Promise.all(
    vms.map(async (vm) => {
      log.info('Starting container', {
        id,
        vmType: cloudConfig.vmType,
        cloud: cloudConfig.cloudProvider,
        region: cloudConfig.region,
        action: WORKLOAD_ACTION.STARTING,
        ip: vm.ip,
      });

      try {
        const docker = new DockerManager(
          vm.sshHost ?? vm.ip,
          sshPrivateKey!,
          vm.sshPort,
        );
        await docker.startContainer(
          runtimeProps,
          mountsForVmStorage(cloudConfig, id, vm),
          secrets,
        );
        return { vm, error: null };
      } catch (error) {
        return {
          vm,
          error: error, // Keep full error object with all metadata
        };
      }
    }),
  );

  const failed = results.filter((r) => r.error);
  if (failed.length > 0) {
    // runStep will handle state transition to Errored
    throw failed[0].error!; // Re-throw original error with all metadata
  }
}

/**
 * Write each Secret's files on VMs whose running container a start step
 * adopted, since only a new container start writes them otherwise.
 */
export async function writeAdoptedSecretFiles(
  vms: DbVM[],
  props: StoredWorkload,
  cloudConfig: Pick<CloudConfig, 'cloudProvider' | 'vmType'>,
): Promise<void> {
  if (vms.length === 0 || !props.secretNames?.length) return;
  const { secrets } = await resolveContainerRuntime(props, cloudConfig);
  await Promise.all(
    vms.map(async (vm) => {
      const docker = new DockerManager(
        vm.sshHost ?? vm.ip,
        props.sshPrivateKey!,
        vm.sshPort,
      );
      for (const secret of secrets) await docker.writeSecretFiles(secret);
    }),
  );
}

export async function resolveContainerRuntime(
  props: StoredWorkload,
  cloudConfig: Pick<CloudConfig, 'cloudProvider' | 'vmType'>,
): Promise<{
  runtimeProps: StoredWorkload;
  secrets: RuntimeSecret[];
}> {
  // Resolve named runtime secrets once for every VM in this workload.
  // Missing names fail fast — they were validated at submit, but catch
  // deletions-after-submit here too. Docker adds the authenticated GitHub token.
  const store: ContainerSecrets = getCredentialSecretStore();
  const secrets: RuntimeSecret[] = [];
  for (const name of props.secretNames ?? []) {
    const secret = await store.getRuntimeSecret(name);
    if (secret === null) {
      throw new InvalidAnycloudConfigError(`Secret "${name}" not found`);
    }
    secrets.push(secret);
  }

  // A resolved NVIDIA vm-host target needs Docker GPU passthrough; default
  // `--gpus all` when the user didn't request it. CUDA workloads also default to
  // host IPC unless the user provided explicit IPC or shared-memory options.
  // AMD/unsupported accelerators never get bogus CUDA Docker defaults.
  const dockerOptions = defaultRuntimeGpuAccess(
    cloudConfig,
    props.dockerOptions,
  );
  const runtimeProps =
    dockerOptions === props.dockerOptions ? props : { ...props, dockerOptions };
  return { runtimeProps, secrets };
}

export async function waitForContainerHealth(
  vms: CloudVM[],
  props: StoredWorkload,
): Promise<void> {
  await pollUntilReady({
    items: vms,
    getKey: (vm) => vm.ip,
    check: async (vm) => {
      const docker = new DockerManager(
        vm.sshHost ?? vm.ip,
        props.sshPrivateKey,
        vm.sshPort,
      );
      const status = await docker.getContainerStatus(props.id);
      const readiness = classifyStartupReadiness(status, props.workloadType);
      if (readiness !== 'ready') return false;
      if (props.workloadType === WorkloadType.Vm) {
        await docker.assertVmContainerReady(props.id);
        return true;
      }
      if (props.workloadType !== WorkloadType.Service) return true;
      return hasSatisfiedServiceStartupDwell(status);
    },
    intervalMs: 5_000, // Poll every 5 seconds (containers start quickly)
  });
}

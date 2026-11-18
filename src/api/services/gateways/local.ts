import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { ResolvedCloudConfig } from '../../../shared/cloud-config.js';
import {
  CloudCompute,
  createCloudCompute,
  type CloudStorage,
  VM_PRESENT,
  VM_RELEASE_CANDIDATE,
  vmReleaseUnknown,
  type VMReleaseObservation,
  type VMReleaseObservationOptions,
} from './cloud.js';
import {
  type GatewayVM,
  type IngressSpec,
  type IngressRule,
  type NewVMProps,
} from '../entities.js';
import { CloudFailureDiagnosis, CloudType } from '../../../shared/cloud.js';
import { DeployError } from '../../../shared/errors.js';
import { VMCreationError } from '../codes.js';
import {
  buildJobIngressSpec,
  hasHttpIngress,
  ingressUnsupportedMessage,
  SERVICE_PUBLIC_PORT,
  SSH_PORT,
} from '../network.js';
import { log } from '../logger.js';
import {
  assertSmolvmHealth,
  isSmolvmNotFound,
  isSmolvmPortInUse,
  smolvmCreatedAtMs,
  SmolvmServeError,
  type SmolvmCreateMachineRequest,
  type SmolvmMachineInfo,
  type SmolvmPortSpec,
} from './smolvm-serve-client.js';
import { cleanupLocalSmolvmMachines } from './local-smolvm-cleanup.js';
import { LOCAL_SMOLVM_CONTRACT } from './local-smolvm-contract.js';
import {
  createDefaultLocalSmolvmRuntime,
  type LocalSmolvmRuntime,
  type LocalSmolvmRuntimeConfig,
} from './local-smolvm-runtime.js';
import { createTransport } from './transport.js';
import type { VmTransport } from './transport-contract.js';
import { SSHManager } from './ssh.js';
import { generateStartupScript } from '../vm-startup-script.js';
import { LOCAL_BUCKET_STORE_GUEST_ROOT } from '../../../shared/providers.js';
import { createLocalFilesystemStorage } from './local-storage.js';
import { DOCKER_VERSION, RCLONE_VERSION } from '../../runtime-artifacts.js';
import {
  type CloudResourceSweeper,
  createCloudResourceSweeper,
  type ResourceSweepOptions,
  type ResourceSweepResult,
} from './resource-sweeper.js';
import { errorMessage } from '../../../shared/log-diagnostics.js';

export type LocalTransportFactory = (
  host: string,
  privateKey: string,
  port?: number,
  username?: string,
) => VmTransport;

export interface LocalDeps {
  runtime?: LocalSmolvmRuntime;
  keypairFactory?: LocalSmolvmPreflightOptions['keypairFactory'];
  preflightIdFactory?: () => string;
  transportFactory?: LocalTransportFactory;
  /** Workload-only allocator. The independent smoke preflight stays random. */
  workloadPortAllocator?: () => number;
}

const LOCAL_UNAVAILABLE_MESSAGE =
  'Local compute is unavailable on this API server.';
const PREFLIGHT_WORKLOAD_ID = 'preflight';
const PREFLIGHT_SSH_ATTEMPTS = 6;
const PREFLIGHT_SSH_ATTEMPT_TIMEOUT_MS = 10_000;
export const LOCAL_RUNTIME_PREFLIGHT_CACHE_TTL_MS = 5 * 60 * 1000;
const HOST_PORT_MIN = 20_000;
const HOST_PORT_MAX_EXCLUSIVE = 61_000;
const MAX_DISTINCT_PORT_PAIR_DRAWS = 8;

type RuntimePreflightCacheEntry = {
  promise: Promise<void>;
  expiresAt: number;
};

const runtimePreflightCache = new Map<string, RuntimePreflightCacheEntry>();

class LocalSmolvmPreflightError extends Error {
  constructor(
    public readonly stage: string,
    public readonly cause: unknown,
  ) {
    super(
      `Local compute preflight failed during ${stage}: ${errorMessage(cause)}`,
    );
    this.name = 'LocalSmolvmPreflightError';
  }
}

/**
 * Undocumented Local provider used by the VM-host integration harness.
 * Workloads run through the same SSH/Docker/sentinel path as production VMs;
 * smolvm supplies the disposable Linux hosts.
 */
export class Local {
  readonly region = 'local';
  readonly type = CloudType.Local;
  readonly vmType = 'local';
  readonly spot = false;

  private computeProvider?: CloudCompute;
  private storageProvider?: CloudStorage;
  private sweeperProvider?: CloudResourceSweeper;
  private readonly deps?: LocalDeps;
  private readonly runtime: LocalSmolvmRuntime;
  private preflightCacheEntry?: RuntimePreflightCacheEntry;

  constructor(
    private readonly config: ResolvedCloudConfig,
    deps?: LocalDeps,
  ) {
    this.deps = deps;
    this.runtime = deps?.runtime ?? createDefaultLocalSmolvmRuntime();
  }

  compute(): CloudCompute {
    this.computeProvider ??= createCloudCompute({
      type: this.type,
      region: this.region,
      spot: this.spot,
      vmType: this.vmType,
      rawValidateCredentials: () => this.validateCredentials(),
      rawClassifyError: (error) => this.classifyError(error),
      rawNewVM: (params) => this.newVM(params),
      rawRequestVMTermination: (cloudId) => this.terminateVM(cloudId),
      rawTerminateNetworking: async () => undefined,
      rawGetAllVMs: () => this.getAllVMs(),
      rawUpsertFirewall: async () => undefined,
      rawPrepareNetwork: (spec) => this.prepareNetwork(spec),
      observeVMReleaseOnce: (cloudId, options) =>
        this.observeVMReleaseOnce(cloudId, options),
      ingressSupport: {
        supportsIngress: (spec) => isSupportedLocalIngressSpec(spec),
        publishesPublicEndpoint: () => false,
      },
    });
    return this.computeProvider;
  }

  sweeper(): CloudResourceSweeper {
    this.sweeperProvider ??= createCloudResourceSweeper({
      type: this.type,
      region: this.region,
      rawSweepResources: (options) => this.sweepResources(options),
    });
    return this.sweeperProvider;
  }

  storage(): CloudStorage {
    this.storageProvider ??= createLocalFilesystemStorage(
      this.getRuntime().config.bucketHostPath,
    );
    return this.storageProvider;
  }

  private async validateCredentials(): Promise<void> {
    try {
      await this.ensureRuntimeReady();
    } catch (error) {
      throw localUnavailableError(error);
    }
  }

  private async newVM(params: NewVMProps): Promise<GatewayVM> {
    const startupScript = params.startupScript?.trim();
    if (!startupScript) {
      throw new DeployError('Local compute requires a VM startup script.', 400);
    }

    // Direct gateway callers predate ingress propagation. Treat an omitted
    // spec as a Job request, while rejecting every shape the submit-time
    // capability predicate would reject.
    const ingressSpec =
      params.ingressSpec ?? buildJobIngressSpec(params.ipWhitelist);
    assertSupportedLocalIngressSpec(ingressSpec);
    const includeHttp = hasHttpIngress(ingressSpec);

    try {
      await this.ensureRuntimeReady();
    } catch (error) {
      throw localUnavailableError(error);
    }
    const runtime = this.getRuntime();
    const machineName = localMachineName(
      runtime.config.machinePrefix,
      params.workloadId,
      params.vmId,
    );

    log.info('LocalProvider: creating smolvm-backed VM', {
      id: params.workloadId,
      vmId: params.vmId,
      machineName,
    });

    // Attribute latency per call. Create materializes disk images, start boots
    // a kernel, and guest setup runs through exec; they fail the same way from
    // the outside, so a slow provision needs stage timings.
    const timings: ProvisionTimings = {};
    let sshPort: number | undefined;
    try {
      const started = await this.createAndStartMachineWithRetry(
        runtime,
        machineName,
        includeHttp,
        timings,
      );
      sshPort =
        getSshPort(started) ??
        getSshPort(await runtime.client.getMachine(machineName));
      if (sshPort === undefined) {
        throw new Error(
          `Local compute did not receive an assigned SSH port for ${machineName}`,
        );
      }

      const startup = await timed(
        () =>
          runtime.client.execMachine(machineName, {
            command: ['/bin/bash', '-s'],
            stdin: params.startupScript,
            timeoutSecs: runtime.config.setupTimeoutSecs,
          }),
        (ms) => (timings.startupScriptMs = ms),
      );
      if (startup.exitCode !== 0) {
        throw new Error(
          `Local compute startup script failed for ${machineName} with exit code ${startup.exitCode}${startup.stderr ? `: ${startup.stderr.trim()}` : ''}${startup.stdout ? `\nstdout:\n${startup.stdout.trim()}` : ''}`,
        );
      }
    } catch (error) {
      log.warn('LocalProvider: smolvm-backed VM provisioning failed', {
        id: params.workloadId,
        machineName,
        ...timings,
        error: errorMessage(error),
      });
      // Only a sick runtime invalidates the shared smoke preflight. A per-VM
      // failure (bootstrap timeout, exec non-zero) says nothing about smolvm
      // itself, and dropping the cache there makes the next workload boot
      // and tear down an extra smoke VM before its own — worst exactly when
      // the host is already saturated.
      if (indicatesRuntimeUnhealthy(error)) {
        invalidateRuntimePreflight(runtime.config);
        this.preflightCacheEntry = undefined;
      }
      await this.bestEffortDelete(runtime, machineName);
      // Carry the provider-minted name so provisioner rollback targets the
      // real machine instead of the synthetic vmId, which never exists here.
      throw new VMCreationError(
        error instanceof Error ? error : new Error(String(error)),
        [machineName],
      );
    }

    log.info('LocalProvider: smolvm-backed VM ready', {
      id: params.workloadId,
      vmId: params.vmId,
      machineName,
      ...timings,
    });

    return machineToCloudVM(
      {
        name: machineName,
        state: 'running',
        ports: [{ guest: 22, host: sshPort }],
      },
      runtime.config,
      this.config.region ?? this.region,
    );
  }

  /** Cold-create an independent VM from the prepared stopped image. */
  private async createAndStartMachineWithRetry(
    runtime: LocalSmolvmRuntime,
    machineName: string,
    includeHttp: boolean,
    timings: ProvisionTimings = {},
  ): Promise<SmolvmMachineInfo> {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Allocate the whole mapping again for every retry. Reusing the HTTP half
      // after an SSH bind conflict (or vice versa) can repeat the same failed
      // create indefinitely.
      const ports = allocateWorkloadPorts(
        this.deps?.workloadPortAllocator ?? chooseHostPort,
        includeHttp,
      );
      try {
        await timed(
          () =>
            runtime.client.createMachine(
              createMachineRequest(runtime.config, machineName, ports),
            ),
          (ms) => (timings.createMs = ms),
        );
        return await timed(
          () => runtime.client.startMachine(machineName),
          (ms) => (timings.startMs = ms),
        );
      } catch (error) {
        await this.bestEffortDelete(runtime, machineName);
        if (!isPortBindConflict(error) || attempt === maxAttempts) throw error;
        log.warn(
          'LocalProvider: retrying smolvm machine start after port bind conflict',
          { machineName, attempt, error: errorMessage(error) },
        );
      }
    }
    throw new Error(`Local compute failed to start ${machineName}`);
  }

  private async terminateVM(machineName: string): Promise<void> {
    const runtime = this.getRuntime();
    try {
      await runtime.client.stopMachine(machineName);
    } catch (error) {
      if (!isSmolvmNotFound(error)) {
        log.warn('LocalProvider: failed to stop smolvm VM', {
          machineName,
          error: errorMessage(error),
        });
      }
    }
    try {
      await runtime.client.deleteMachine(machineName, true);
    } catch (error) {
      if (!isSmolvmNotFound(error)) throw error;
    }
  }

  private async getAllVMs(): Promise<GatewayVM[]> {
    const runtime = this.getRuntime();
    const machines = await runtime.client.listMachines();
    return machines.flatMap((machine) => {
      if (!machine.name?.startsWith(runtime.config.machinePrefix)) return [];
      return [machineToCloudVM(machine, runtime.config, this.region)];
    });
  }

  private async prepareNetwork(spec: IngressSpec): Promise<undefined> {
    assertSupportedLocalIngressSpec(spec);
    return undefined;
  }

  private async sweepResources(
    options: ResourceSweepOptions,
  ): Promise<ResourceSweepResult> {
    if (!options.policy.includeUnowned) {
      return { vmIds: [], otherResources: [], errors: [] };
    }
    return cleanupLocalSmolvmMachines(this.getRuntime(), {
      dryRun: options.dryRun,
      minAgeMs: options.policy.minAgeMs,
    });
  }

  private async observeVMReleaseOnce(
    cloudId: string,
    options: VMReleaseObservationOptions = {},
  ): Promise<VMReleaseObservation> {
    try {
      if (options.signal?.aborted) throw options.signal.reason;
      const machine = await this.getRuntime().client.getMachine(cloudId);
      if (options.signal?.aborted) throw options.signal.reason;
      // smolvm reports created, running, stopped, failed, unreachable or
      // frozen. Machines get no restart policy, so a stopped or failed one
      // never runs again; its leftovers go with the VM row's termination.
      // Unreachable keeps a live VMM whose busy guest can miss smolvm's
      // agent ping, so it stays present like any alive cloud VM.
      if (machine.state === 'stopped' || machine.state === 'failed') {
        log.info('LocalProvider: smolvm machine is no longer running', {
          machineName: cloudId,
          state: machine.state,
        });
        return VM_RELEASE_CANDIDATE;
      }
      return VM_PRESENT;
    } catch (error) {
      if (isSmolvmNotFound(error)) return VM_RELEASE_CANDIDATE;
      return vmReleaseUnknown(error);
    }
  }

  private getRuntime(): LocalSmolvmRuntime {
    return this.runtime;
  }

  private async ensureRuntimeReady(): Promise<void> {
    const runtime = this.getRuntime();
    try {
      await runLocalSmolvmHealthCheck(runtime);
    } catch (error) {
      invalidateRuntimePreflight(runtime.config);
      this.preflightCacheEntry = undefined;
      throw error;
    }

    const startPreflight = () =>
      runLocalSmolvmPreflight(runtime, {
        keypairFactory:
          this.deps?.keypairFactory ?? (() => SSHManager.generateKeypair()),
        machineName: localMachineName(
          runtime.config.machinePrefix,
          PREFLIGHT_WORKLOAD_ID,
          this.deps?.preflightIdFactory?.() ?? randomBytes(4).toString('hex'),
        ),
        transportFactory: this.deps?.transportFactory ?? createTransport,
      });

    if (this.deps?.runtime) {
      this.preflightCacheEntry = getFreshPreflightEntry(
        this.preflightCacheEntry,
        startPreflight,
        () => {
          this.preflightCacheEntry = undefined;
        },
      );
      await this.preflightCacheEntry.promise;
      return;
    }

    const cacheKey = runtimePreflightCacheKey(runtime.config);
    const preflight = getFreshPreflightEntry(
      runtimePreflightCache.get(cacheKey),
      startPreflight,
      () => runtimePreflightCache.delete(cacheKey),
    );
    runtimePreflightCache.set(cacheKey, preflight);
    await preflight.promise;
  }

  private async bestEffortDelete(
    runtime: LocalSmolvmRuntime,
    machineName: string,
  ): Promise<void> {
    try {
      await runtime.client.stopMachine(machineName);
    } catch (error) {
      if (!isSmolvmNotFound(error)) {
        log.warn('LocalProvider: best-effort smolvm stop failed', {
          machineName,
          error: errorMessage(error),
        });
      }
    }
    try {
      await runtime.client.deleteMachine(machineName, true);
    } catch (error) {
      if (!isSmolvmNotFound(error)) {
        log.warn('LocalProvider: best-effort smolvm delete failed', {
          machineName,
          error: errorMessage(error),
        });
      }
    }
  }

  private classifyError(error: unknown): CloudFailureDiagnosis {
    if (isSmolvmNotFound(error)) {
      return CloudFailureDiagnosis.InvalidTarget;
    }
    if (error instanceof DeployError && error.statusCode === 503) {
      return CloudFailureDiagnosis.TemporaryProviderFailure;
    }
    if (
      (error instanceof DeployError && error.statusCode === 400) ||
      (error instanceof SmolvmServeError && error.status === 400)
    ) {
      return CloudFailureDiagnosis.InvalidRequest;
    }
    if (/smolvm serve base URL is empty/i.test(errorMessage(error))) {
      return CloudFailureDiagnosis.InvalidRequest;
    }
    return CloudFailureDiagnosis.TemporaryProviderFailure;
  }
}

export interface LocalSmolvmPreflightOptions {
  keypairFactory?: () =>
    | ReturnType<typeof SSHManager.generateKeypair>
    | Awaited<ReturnType<typeof SSHManager.generateKeypair>>;
  machineName?: string;
  transportFactory?: LocalTransportFactory;
}

async function runLocalSmolvmHealthCheck(
  runtime: LocalSmolvmRuntime,
): Promise<void> {
  const healthText = await runtime.client.health();
  assertSmolvmHealth(healthText, LOCAL_SMOLVM_CONTRACT.supportedVersion);
}

/**
 * Guest-visible invariants a prepared smolvm image must satisfy. Exported so
 * the contract can be asserted without booting a VM.
 */
export function localSmolvmPreflightChecks(publicKey: string): string[] {
  return [
    'command -v bash >/dev/null 2>&1',
    'command -v curl >/dev/null 2>&1',
    'command -v python3 >/dev/null 2>&1',
    `docker --version | grep -F ${shellSingleQuote(DOCKER_VERSION)}`,
    `rclone version | head -n 1 | grep -F ${shellSingleQuote(`v${RCLONE_VERSION}`)}`,
    `grep -qx ${shellSingleQuote(LOCAL_SMOLVM_CONTRACT.runnerVersion)} /etc/anycloud-image-version`,
    'test -d /storage/docker',
    'test -s /etc/docker/daemon.json',
    'test -x /usr/sbin/sshd',
    'test -s /etc/ssl/certs/ca-certificates.crt',
    `grep -qx ${shellSingleQuote(publicKey)} /root/.ssh/authorized_keys`,
  ];
}

export async function runLocalSmolvmPreflight(
  runtime: LocalSmolvmRuntime,
  options: LocalSmolvmPreflightOptions = {},
): Promise<void> {
  const keypairFactory =
    options.keypairFactory ?? (() => SSHManager.generateKeypair());
  const transportFactory = options.transportFactory ?? createTransport;
  const machineName =
    options.machineName ??
    localMachineName(
      runtime.config.machinePrefix,
      PREFLIGHT_WORKLOAD_ID,
      randomBytes(4).toString('hex'),
    );
  const keypair = await keypairFactory();
  let failed: unknown;
  // Preflight boots a whole disposable VM. Log it so its cost is attributable
  // in CI artifacts instead of looking like unexplained provisioning latency.
  const startedAt = Date.now();
  log.info('LocalProvider: running smolvm smoke preflight', { machineName });

  try {
    await preflightStage('health', () => runLocalSmolvmHealthCheck(runtime));
    await preflightStage('create', () =>
      runtime.client.createMachine(
        createMachineRequest(runtime.config, machineName, [
          { host: chooseHostPort(), guest: SSH_PORT },
        ]),
      ),
    );
    const started = await preflightStage('start', () =>
      runtime.client.startMachine(machineName),
    );
    const sshPort =
      getSshPort(started) ??
      getSshPort(
        await preflightStage('inspect', () =>
          runtime.client.getMachine(machineName),
        ),
      );
    if (sshPort === undefined) {
      throw new LocalSmolvmPreflightError(
        'start',
        new Error(`smoke VM ${machineName} did not receive an SSH host port`),
      );
    }

    const startupScript = generateStartupScript(keypair);
    const startup = await preflightStage('startup-script', () =>
      runtime.client.execMachine(machineName, {
        command: ['/bin/bash', '-s'],
        stdin: startupScript,
        timeoutSecs: runtime.config.setupTimeoutSecs,
      }),
    );
    if (startup.exitCode !== 0) {
      throw new LocalSmolvmPreflightError(
        'startup-script',
        new Error(
          `smoke VM startup script exited ${startup.exitCode}${startup.stderr ? `: ${startup.stderr.trim()}` : ''}${startup.stdout ? `\nstdout:\n${startup.stdout.trim()}` : ''}`,
        ),
      );
    }

    const transport = transportFactory(
      runtime.config.sshHost,
      keypair.privateKey,
      sshPort,
      runtime.config.sshUsername,
    );
    await preflightStage('ssh', () =>
      transport.exec(
        localSmolvmPreflightChecks(keypair.publicKey).join(' && '),
        PREFLIGHT_SSH_ATTEMPTS,
        false,
        PREFLIGHT_SSH_ATTEMPT_TIMEOUT_MS,
      ),
    );
  } catch (error) {
    failed = error;
  }

  const cleanupError = await deletePreflightMachine(runtime, machineName);
  if (failed) {
    log.warn('LocalProvider: smolvm smoke preflight failed', {
      machineName,
      preflightMs: Date.now() - startedAt,
      error: errorMessage(failed),
    });
    throw failed;
  }
  if (cleanupError) {
    throw new LocalSmolvmPreflightError('delete', cleanupError);
  }
  await preflightStage('delete', async () => {
    try {
      await runtime.client.getMachine(machineName);
    } catch (error) {
      if (isSmolvmNotFound(error)) return;
      throw error;
    }
    throw new Error(`smoke VM ${machineName} still exists after delete`);
  });
  log.info('LocalProvider: smolvm smoke preflight passed', {
    machineName,
    preflightMs: Date.now() - startedAt,
  });
}

export function localMachineName(
  prefix: string,
  workloadId: string,
  vmId: string,
): string {
  // A retargeted provisioning attempt replays the provider-minted name back as
  // the vmId. It is already sanitized and length-bounded, so re-deriving would
  // silently address a different machine than the one being recovered.
  if (vmId.startsWith(prefix)) return vmId;

  const raw = vmId.startsWith(`${workloadId}-`)
    ? vmId
    : `${workloadId}-${vmId}`;
  const base = sanitizeMachineName(raw);
  const maxBaseLength = Math.max(1, 63 - prefix.length);
  if (base.length <= maxBaseLength) return `${prefix}${base}`;

  const hash = createHash('sha256').update(base).digest('hex').slice(0, 8);
  const numericSuffix = base.match(/-\d+$/)?.[0] ?? '';
  const fixedSuffix = `-${hash}${numericSuffix}`;
  const headLength = Math.max(1, maxBaseLength - fixedSuffix.length);
  const head = base.slice(0, headLength).replace(/-+$/g, '') || 'vm';
  return `${prefix}${head}${fixedSuffix}`.slice(0, 63).replace(/-+$/g, '');
}

function createMachineRequest(
  config: LocalSmolvmRuntimeConfig,
  name: string,
  ports: SmolvmPortSpec[],
): SmolvmCreateMachineRequest {
  return {
    name,
    from: config.sidecarPath,
    network: true,
    networkBackend: config.networkBackend,
    ports,
    mounts: [
      {
        source: config.bucketHostPath,
        target: LOCAL_BUCKET_STORE_GUEST_ROOT,
        readonly: false,
      },
    ],
    cpus: config.cpus,
    memoryMb: config.memoryMb,
    overlayGb: config.overlayGb,
    storageGb: config.storageGb,
  };
}

function machineToCloudVM(
  machine: SmolvmMachineInfo,
  config: LocalSmolvmRuntimeConfig,
  region: string,
): GatewayVM {
  const createdAt = smolvmCreatedAtMs(machine.createdAt);
  const ip = config.sshHost;
  return {
    cloudId: machine.name,
    ip,
    sshPort: getSshPort(machine),
    ...(createdAt === undefined ? {} : { createdAt }),
    region,
  };
}

function getSshPort(
  machine: SmolvmMachineInfo | undefined,
): number | undefined {
  const host = machine?.ports?.find((port) => port.guest === 22)?.host;
  return host === undefined || host === 0 ? undefined : host;
}

function chooseHostPort(): number {
  return randomInt(HOST_PORT_MIN, HOST_PORT_MAX_EXCLUSIVE);
}

function allocateWorkloadPorts(
  allocator: () => number,
  includeHttp: boolean,
): SmolvmPortSpec[] {
  if (!includeHttp) {
    return [{ host: allocateHostPort(allocator), guest: SSH_PORT }];
  }

  for (let draw = 0; draw < MAX_DISTINCT_PORT_PAIR_DRAWS; draw++) {
    const sshHostPort = allocateHostPort(allocator);
    const httpHostPort = allocateHostPort(allocator);
    if (sshHostPort === httpHostPort) continue;
    return [
      { host: sshHostPort, guest: SSH_PORT },
      { host: httpHostPort, guest: SERVICE_PUBLIC_PORT },
    ];
  }

  throw new Error(
    `Local compute could not allocate distinct SSH and HTTP host ports after ${MAX_DISTINCT_PORT_PAIR_DRAWS} draws`,
  );
}

function allocateHostPort(allocator: () => number): number {
  const port = allocator();
  if (
    !Number.isInteger(port) ||
    port < HOST_PORT_MIN ||
    port >= HOST_PORT_MAX_EXCLUSIVE
  ) {
    throw new Error(
      `Local compute host port allocator returned invalid port ${String(port)}; expected an integer from ${HOST_PORT_MIN} through ${HOST_PORT_MAX_EXCLUSIVE - 1}`,
    );
  }
  return port;
}

/**
 * The Local harness accepts exactly Job ingress (TCP/22) or Serve ingress
 * (TCP/22 plus TCP/80). This predicate is shared by submit-time capability
 * validation and both runtime gateway guards.
 */
function isSupportedLocalIngressSpec(spec: IngressSpec): boolean {
  if (!spec || !Array.isArray(spec.ingress)) return false;
  if (spec.ingress.length < 1 || spec.ingress.length > 2) return false;

  let hasSsh = false;
  let hasHttp = false;
  for (const rule of spec.ingress as unknown[]) {
    if (!isWellFormedLocalIngressRule(rule)) return false;
    if (rule.port === SSH_PORT) {
      if (hasSsh) return false;
      hasSsh = true;
      continue;
    }
    if (rule.port === SERVICE_PUBLIC_PORT) {
      if (hasHttp) return false;
      hasHttp = true;
      continue;
    }
    return false;
  }

  return hasSsh;
}

function isWellFormedLocalIngressRule(value: unknown): value is IngressRule {
  if (!value || typeof value !== 'object') return false;
  const rule = value as Partial<IngressRule>;
  return (
    rule.protocol === 'tcp' &&
    Number.isInteger(rule.port) &&
    Array.isArray(rule.sourceRanges) &&
    rule.sourceRanges.every((range) => typeof range === 'string') &&
    (rule.description === undefined || typeof rule.description === 'string')
  );
}

function assertSupportedLocalIngressSpec(spec: IngressSpec): void {
  if (isSupportedLocalIngressSpec(spec)) return;
  throw new DeployError(ingressUnsupportedMessage(CloudType.Local), 400);
}

function runtimePreflightCacheKey(config: LocalSmolvmRuntimeConfig): string {
  return JSON.stringify([
    config.baseUrl,
    config.sidecarPath,
    config.sshHost,
    config.sshUsername,
    config.machinePrefix,
    config.networkBackend,
    config.cpus,
    config.memoryMb,
    config.overlayGb,
    config.storageGb,
    config.bucketHostPath,
  ]);
}

function getFreshPreflightEntry(
  current: RuntimePreflightCacheEntry | undefined,
  startPreflight: () => Promise<void>,
  clearEntry: () => void,
): RuntimePreflightCacheEntry {
  const now = Date.now();
  if (current && current.expiresAt > now) return current;

  const entry: RuntimePreflightCacheEntry = {
    expiresAt: now + LOCAL_RUNTIME_PREFLIGHT_CACHE_TTL_MS,
    promise: startPreflight().catch((error) => {
      clearEntry();
      throw error;
    }),
  };
  return entry;
}

function invalidateRuntimePreflight(config: LocalSmolvmRuntimeConfig): void {
  runtimePreflightCache.delete(runtimePreflightCacheKey(config));
}

async function deletePreflightMachine(
  runtime: LocalSmolvmRuntime,
  machineName: string,
): Promise<unknown> {
  let cleanupError: unknown;
  try {
    await runtime.client.stopMachine(machineName);
  } catch (error) {
    if (!isSmolvmNotFound(error)) cleanupError = error;
  }
  try {
    await runtime.client.deleteMachine(machineName, true);
  } catch (error) {
    if (!isSmolvmNotFound(error)) cleanupError ??= error;
  }
  return cleanupError;
}

async function preflightStage<T>(
  stage: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof LocalSmolvmPreflightError) throw error;
    throw new LocalSmolvmPreflightError(stage, error);
  }
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

type ProvisionTimings = {
  createMs?: number;
  startMs?: number;
  startupScriptMs?: number;
};

/** Record how long an operation took, whether it succeeds or throws. */
async function timed<T>(
  operation: () => Promise<T>,
  record: (elapsedMs: number) => void,
): Promise<T> {
  const startedAt = Date.now();
  try {
    return await operation();
  } finally {
    record(Date.now() - startedAt);
  }
}

/**
 * Whether a VM-creation failure implicates the smolvm runtime rather than the
 * single VM. A refused connection or a 5xx means the service is unwell; a 4xx
 * or a non-zero bootstrap exit is local to that machine. Our own expired
 * deadline is neither — it says the host was busy, and dropping the shared
 * preflight over it makes the next workload boot an extra smoke VM at
 * exactly the wrong moment.
 */
function indicatesRuntimeUnhealthy(error: unknown): boolean {
  if (!(error instanceof SmolvmServeError)) return false;
  if (error.timedOut) return false;
  return error.status === null || error.status >= 500;
}

function isPortBindConflict(error: unknown): boolean {
  return (
    isSmolvmPortInUse(error) ||
    /address already in use|eaddrinuse|port.*in use|bind.*failed|failed to bind/i.test(
      errorMessage(error),
    )
  );
}

function sanitizeMachineName(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-+/g, '-') || 'vm'
  );
}

/**
 * Whether a runtime readiness failure says the host was busy rather than that
 * Local compute is missing or misconfigured. A slow boot or a port conflict on a
 * loaded host must be retried, not fail every workload waiting on the shared
 * preflight.
 */
function isTransientRuntimeFailure(error: unknown): boolean {
  if (/kvm/i.test(errorMessage(error))) return false;
  if (error instanceof LocalSmolvmPreflightError) {
    return isTransientRuntimeFailure(error.cause);
  }
  return (
    isPortBindConflict(error) ||
    (error instanceof SmolvmServeError &&
      (error.timedOut || (error.status !== null && error.status >= 500)))
  );
}

function localUnavailableError(error: unknown): DeployError {
  if (error instanceof DeployError) return error;
  if (isTransientRuntimeFailure(error)) {
    return new DeployError(
      `Local compute is temporarily unavailable: ${errorMessage(error)}`,
      503,
    );
  }
  return new DeployError(
    `${LOCAL_UNAVAILABLE_MESSAGE} ${errorMessage(error)}`,
    400,
  );
}

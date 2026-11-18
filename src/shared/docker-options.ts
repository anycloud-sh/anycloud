import { type CloudConfig } from './cloud.js';
import { type DockerOptions } from './runtime.js';
import { InvalidAnycloudConfigError } from './errors.js';
import {
  gpuCountForVMType,
  gpuRuntimeForVMType,
  hasUnclassifiedAccelerator,
} from './cloud-config.js';
import { CATALOG_BACKED_CLOUDS } from './providers.js';
import {
  containerPathsOverlap,
  parseDockerVolumeBind,
  type DockerVolumeBind,
} from './docker-volume.js';
import {
  CHECKPOINT_MOUNT_PATH,
  hasCheckpointTarget,
  type CheckpointTargetConfig,
} from './checkpoint.js';

const DOCKER_OPTION_FLAGS = {
  privileged: '--privileged',
  shmSize: '--shm-size',
  gpus: '--gpus',
  ipc: '--ipc',
  ulimits: '--ulimit',
  memory: '--memory',
  cpus: '--cpus',
  runtime: '--runtime',
  binds: '--bind',
  network: '--network',
} as const satisfies Record<keyof DockerOptions, string>;

const DOCKER_OPTION_KEYS = Object.keys(
  DOCKER_OPTION_FLAGS,
) as (keyof DockerOptions)[];
const DOCKER_OPTION_KEY_SET = new Set<string>(DOCKER_OPTION_KEYS);

const MAX_DOCKER_SIZE_BYTES = (1n << 63n) - 1n;
const MIN_DOCKER_MEMORY_BYTES = 6n * 1024n * 1024n;
const SIZE_MULTIPLIERS = {
  b: 1n,
  k: 1024n,
  m: 1024n ** 2n,
  g: 1024n ** 3n,
  t: 1024n ** 4n,
} as const;

const SUPPORTED_DOCKER_RUNTIMES = new Set(['runc', 'nvidia']);
const SUPPORTED_BIND_MODES = new Set([
  'ro',
  'rw',
  'z',
  'Z',
  'private',
  'rprivate',
  'shared',
  'rshared',
  'slave',
  'rslave',
  'nocopy',
]);

interface ParsedDockerSize {
  amount: string;
  unit?: keyof typeof SIZE_MULTIPLIERS;
  bytes: bigint;
}

interface DockerOptionsRequestContext extends CheckpointTargetConfig {
  inputBucket?: string | null;
  outputBucket?: string | null;
}

function invalid(message: string): never {
  throw new InvalidAnycloudConfigError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireString(
  value: unknown,
  key: keyof DockerOptions,
): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    invalid(`dockerOptions.${key} must be a non-empty string.`);
  }
}

function requireStringArray(
  value: unknown,
  key: 'ulimits' | 'binds',
): asserts value is string[] {
  if (!Array.isArray(value)) {
    invalid(`dockerOptions.${key} must be an array of strings.`);
  }
  const invalidIndex = value.findIndex(
    (entry) => typeof entry !== 'string' || entry.length === 0,
  );
  if (invalidIndex !== -1) {
    invalid(
      `dockerOptions.${key}[${invalidIndex}] must be a non-empty string.`,
    );
  }
}

function assertDockerOptionsShape(
  value: unknown,
): asserts value is DockerOptions | null | undefined {
  if (value === undefined || value === null) return;
  if (!isRecord(value)) {
    invalid('dockerOptions must be an object.');
  }

  const unknownKeys = Object.keys(value).filter(
    (key) => !DOCKER_OPTION_KEY_SET.has(key),
  );
  if (unknownKeys.length > 0) {
    invalid(`Unknown dockerOptions field(s): ${unknownKeys.join(', ')}.`);
  }

  for (const key of DOCKER_OPTION_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    if (key === 'privileged') {
      if (typeof value[key] !== 'boolean') {
        invalid(`dockerOptions.${key} must be a boolean.`);
      }
    } else if (key === 'ulimits' || key === 'binds') {
      requireStringArray(value[key], key);
    } else {
      requireString(value[key], key);
    }
  }
}

/** Parse the positive byte/K/M/G/T forms accepted by Docker size flags. */
function parseDockerSize(
  value: string,
  flag: '--memory' | '--shm-size',
): ParsedDockerSize {
  const match = /^([0-9]+)(?:(b)|([kmgt])(?:i?b?)?)?$/i.exec(value);
  if (!match) {
    invalid(
      `${flag} must be a positive integer optionally followed by b, k, m, g, or t.`,
    );
  }

  const amount = BigInt(match[1]!);
  if (amount <= 0n) {
    invalid(
      `${flag} must be a positive integer optionally followed by b, k, m, g, or t.`,
    );
  }
  const unit = match[3]?.toLowerCase() as
    | keyof typeof SIZE_MULTIPLIERS
    | undefined;
  const bytes = amount * (unit ? SIZE_MULTIPLIERS[unit] : 1n);
  if (bytes > MAX_DOCKER_SIZE_BYTES) {
    invalid(`${flag} is too large.`);
  }

  return { amount: match[1]!, ...(unit ? { unit } : {}), bytes };
}

/** Parse the documented Docker GPU request: `all` or a positive count. */
export function parseDockerGpuRequest(value: string): 'all' | number {
  if (value === 'all') return 'all';
  if (!/^[1-9][0-9]*$/.test(value)) {
    invalid('--gpus must be "all" or a positive GPU count.');
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count)) {
    invalid('--gpus count is too large.');
  }
  return count;
}

function validateDockerCpuCount(value: string): void {
  if (!/^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/.test(value)) {
    invalid('--cpus must be a positive number.');
  }
  const cpus = Number(value);
  if (!Number.isFinite(cpus) || cpus <= 0) {
    invalid('--cpus must be a positive number.');
  }
}

function validateDockerIpcMode(value: string): void {
  if (
    value === 'none' ||
    value === 'private' ||
    value === 'shareable' ||
    value === 'host' ||
    /^container:[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value)
  ) {
    return;
  }
  invalid(
    '--ipc must be none, private, shareable, host, or container:<name-or-id>.',
  );
}

function validateDockerUlimit(value: string): void {
  const match = /^([A-Za-z][A-Za-z0-9_-]*)=(-1|[0-9]+)(?::(-1|[0-9]+))?$/.exec(
    value,
  );
  if (!match) {
    invalid(`Invalid --ulimit "${value}"; expected name=soft[:hard].`);
  }

  const soft = BigInt(match[2]!);
  const hard = match[3] === undefined ? soft : BigInt(match[3]);
  if (soft > MAX_DOCKER_SIZE_BYTES || hard > MAX_DOCKER_SIZE_BYTES) {
    invalid(`Invalid --ulimit "${value}"; limit is too large.`);
  }
  if (hard !== -1n && (soft === -1n || soft > hard)) {
    invalid(`Invalid --ulimit "${value}"; soft limit exceeds hard limit.`);
  }
}

function validateDockerBind(value: string): DockerVolumeBind {
  if (/[\0\r\n]/.test(value)) {
    invalid('Invalid --bind; mount specifications cannot contain newlines.');
  }
  const parsed = parseDockerVolumeBind(value);
  if (!parsed || !parsed.target.startsWith('/')) {
    invalid(
      `Invalid --bind "${value}"; expected source:/absolute/container/path[:mode].`,
    );
  }
  if (
    parsed.source !== '' &&
    !parsed.source.startsWith('/') &&
    !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(parsed.source)
  ) {
    invalid(
      `Invalid --bind "${value}"; source must be an absolute remote-host path or a Docker volume name.`,
    );
  }
  if (parsed.mode !== undefined) {
    const modes = parsed.mode.split(',');
    if (modes.some((mode) => !mode || !SUPPORTED_BIND_MODES.has(mode))) {
      invalid(`Invalid --bind "${value}"; unsupported mount mode.`);
    }
  }
  return parsed;
}

function validateDockerNetwork(value: string): void {
  if (
    /^(?:[A-Za-z0-9][A-Za-z0-9_.-]*|container:[A-Za-z0-9][A-Za-z0-9_.-]*)$/.test(
      value,
    )
  ) {
    return;
  }
  invalid('--network must be a Docker network name or container:<name-or-id>.');
}

function validateDockerOptionValues(options: DockerOptions): void {
  if (options.shmSize !== undefined) {
    parseDockerSize(options.shmSize, '--shm-size');
  }
  if (options.gpus !== undefined) {
    parseDockerGpuRequest(options.gpus);
  }
  if (options.ipc !== undefined) {
    validateDockerIpcMode(options.ipc);
  }
  for (const ulimit of options.ulimits ?? []) {
    validateDockerUlimit(ulimit);
  }
  if (options.memory !== undefined) {
    const parsed = parseDockerSize(options.memory, '--memory');
    if (parsed.bytes < MIN_DOCKER_MEMORY_BYTES) {
      invalid('--memory must be at least 6m.');
    }
  }
  if (options.cpus !== undefined) {
    validateDockerCpuCount(options.cpus);
  }
  if (
    options.runtime !== undefined &&
    !SUPPORTED_DOCKER_RUNTIMES.has(options.runtime)
  ) {
    invalid(
      `Unsupported --runtime "${options.runtime}"; Anycloud-managed hosts support runc and nvidia.`,
    );
  }
  for (const bind of options.binds ?? []) {
    validateDockerBind(bind);
  }
  if (options.network !== undefined) {
    validateDockerNetwork(options.network);
  }
}

/**
 * Validate the wire shape and Docker-owned value syntax before catalog or
 * provider work. This is authoritative server-side validation; CLI checks are
 * only a convenience and cannot replace it for SDK/direct API callers.
 */
export function validateDockerOptionsRequest(
  value: unknown,
  context: DockerOptionsRequestContext = {},
): asserts value is DockerOptions | null | undefined {
  assertDockerOptionsShape(value);
  if (!value) return;
  validateDockerOptionValues(value);

  // Spot workloads get an implicit Anycloud-managed checkpoint bucket at the
  // same mount, so key off the resolved target rather than an explicit name.
  const managedPaths = [
    context.inputBucket ? '/mnt/input' : null,
    context.outputBucket ? '/mnt/output' : null,
    hasCheckpointTarget(context) ? CHECKPOINT_MOUNT_PATH : null,
  ].filter((path): path is string => path !== null);

  for (const bind of value.binds ?? []) {
    const parsed = validateDockerBind(bind);
    const conflict = managedPaths.find((path) =>
      containerPathsOverlap(parsed.target, path),
    );
    if (conflict) {
      invalid(
        `--bind target "${parsed.target}" conflicts with Anycloud-managed ${conflict}.`,
      );
    }
  }
}

/**
 * Validate options that depend on the optimizer's concrete VM selection. This
 * must run before provider mutation, after fallback aliases/lists are expanded.
 */
export function validateDockerOptionsForResolvedTarget(
  value: unknown,
  cloudConfig: Pick<CloudConfig, 'cloudProvider' | 'vmType'>,
): asserts value is DockerOptions | null | undefined {
  validateDockerOptionsRequest(value);
  if (!value || typeof cloudConfig.vmType !== 'string') return;
  // Catalog-less substrates (the local test harness) publish no VM
  // accelerator facts, so there is nothing to validate a GPU request against.
  if (!CATALOG_BACKED_CLOUDS.includes(cloudConfig.cloudProvider)) return;

  const needsCuda = value.gpus !== undefined || value.runtime === 'nvidia';
  if (!needsCuda) return;

  const runtime = gpuRuntimeForVMType(
    cloudConfig.cloudProvider,
    cloudConfig.vmType,
  );
  // A null runtime means CPU-only OR an accelerator the catalog never named.
  // Only the first is a definite mismatch; forcing GPU access on an unnamed
  // accelerator stays the documented escape hatch for catalog gaps.
  const unclassified =
    runtime === null &&
    hasUnclassifiedAccelerator(cloudConfig.cloudProvider, cloudConfig.vmType);
  if (runtime !== 'cuda' && !unclassified) {
    const flags = [
      value.gpus !== undefined ? '--gpus' : null,
      value.runtime === 'nvidia' ? '--runtime nvidia' : null,
    ].filter((flag): flag is string => flag !== null);
    invalid(
      `${flags.join(' and ')} require an NVIDIA CUDA VM, but ${cloudConfig.cloudProvider} VM type "${cloudConfig.vmType}" is not CUDA-capable.`,
    );
  }

  if (value.gpus !== undefined) {
    const requested = parseDockerGpuRequest(value.gpus);
    const available = gpuCountForVMType(
      cloudConfig.cloudProvider,
      cloudConfig.vmType,
    );
    if (
      requested !== 'all' &&
      available !== undefined &&
      requested > available
    ) {
      invalid(
        `--gpus ${requested} exceeds the ${available} GPU(s) on ${cloudConfig.cloudProvider} VM type "${cloudConfig.vmType}".`,
      );
    }
  }
}

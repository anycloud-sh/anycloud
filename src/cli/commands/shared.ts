/**
 * Shared CLI helpers for submit and workload-adjacent commands.
 * Extracts common logic to avoid duplication.
 */

import {
  buildCloudConfigFromFlags,
  hasInlineCredentialEnv,
} from '../services/config.js';
import { apiClient } from '../services/auth.js';
import {
  printInfo,
  printError,
  printWarning,
  createSpinner,
  exitWithError,
  isJsonMode,
} from '../utils/output.js';
import { suggestFilter } from '../utils/suggest-filter.js';
import { selectWorkload, selectWorkloads } from '../utils/workload-picker.js';
import {
  getCredentialsNameFromEnv,
  getCredentialsFromEnv,
} from '../services/non-interactive.js';
import { safePrompts, shouldAllowPrompts } from '../utils/safe-prompts.js';
import type { RedactedCredential } from '../../shared/api-contract/credentials-schemas.js';
import {
  getRegionsForVMType,
  isCloudType,
  requiresExplicitCheckpointStorage,
  supportsRegionFailover,
} from '../../shared/cloud-config.js';
import { ensureCatalogsBootstrapped } from '../../shared/catalog/index.js';
import {
  hasSpotComputeOfferings,
  pickComputeTarget,
} from '../services/target-picker.js';
import {
  defaultIncludePublicIpQuotaForAvailabilityHints,
  quotaSupportedRegionsForVmType,
} from '../../shared/quota-groups.js';
import { parseEnvFile, parseEnvFlags } from '../utils/env-parser.js';
import { isSecretKey } from '../../shared/secret-keys.js';
import { getCredentialCloudProvider } from '../services/credentials.js';
import { type QuotaStatusEntry } from '../../shared/api-contract/quota-schemas.js';
import { CloudType } from '../../shared/cloud.js';
import {
  isComputeProvider,
  storageOnlyComputeMessage,
} from '../../shared/providers.js';
import { type ListStateClass } from '../../shared/workload.js';
import { type DockerOptions } from '../../shared/runtime.js';
import type { InlineConfigFlags, ResolvedConfig } from '../services/config.js';

/** Options shape for env var parsing */
export interface EnvOptions {
  env?: string[];
  envFile?: string;
}

/**
 * Parse a positive-integer USD cap from raw user input (flag, arg, or
 * prompt). Throws with a human-readable message on invalid input.
 */
export function parseUsdCap(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    throw new Error('cap must be a positive integer (USD)');
  }
  return n;
}

/** Options shape for inline workload config flags */
export interface WorkloadConfigOptions {
  /** Optional compute credential name. Saved credentials retain normal selection. */
  credentials?: string;
  region?: string;
  /** Repeatable: commander hands us `string[]` (possibly empty). */
  vmType?: string[];
  /** Repeatable: commander hands us `string[]` (possibly empty). */
  gpuType?: string[];
  spot?: boolean;
  diskSize?: number;
  diskTier?: string;
  inputBucket?: string;
  outputBucket?: string;
  checkpointBucket?: string;
  inputStorageCredentials?: string;
  inputStorageRegion?: string;
  outputStorageCredentials?: string;
  outputStorageRegion?: string;
  checkpointStorageCredentials?: string;
  checkpointStorageRegion?: string;
  zone?: string;
}

type ResolveCloudConfigOptions = {
  requireTarget?: boolean;
  allowSpotPrompt?: boolean;
};

const VM_PICKER_QUOTA_STATUS_WAIT_MS = 3_000;

/** RFC 0049 C32: the privileged options go in the next release. */
export function warnPrivilegedDeprecated(flag: string): void {
  printWarning(
    `${flag} is deprecated and removed in the next release; use node-pool create --user-namespace-jobs`,
    true,
  );
}

/** Options shape for docker runtime flags */
export interface DockerRuntimeOptions {
  privileged?: boolean;
  shmSize?: string;
  gpus?: string;
  ipc?: string;
  ulimit?: string[];
  memory?: string;
  cpus?: string;
  runtime?: string;
  bind?: string[];
  network?: string;
}

/**
 * Parse environment variables from --env-file and -e flags.
 * Env file is loaded first, then -e flags override.
 */
export function parseEnvVars(
  options: EnvOptions,
): Record<string, string> | undefined {
  let envVars: Record<string, string> | undefined;

  if (options.envFile) {
    try {
      envVars = parseEnvFile(options.envFile);
      const count = Object.keys(envVars).length;
      if (count > 0) {
        printInfo(
          `Loaded ${count} environment variable(s) from ${options.envFile}`,
        );
      } else {
        printInfo(`No environment variables found in ${options.envFile}`);
      }
    } catch (error) {
      printError((error as Error).message);
      process.exit(1);
    }
  }

  if (options.env && options.env.length > 0) {
    try {
      const envFlagsVars = parseEnvFlags(options.env);
      const count = Object.keys(envFlagsVars).length;
      envVars = { ...envVars, ...envFlagsVars };
      printInfo(`Set ${count} environment variable(s) from -e flags`);
    } catch (error) {
      printError((error as Error).message);
      process.exit(1);
    }
  }

  if (envVars) {
    for (const key of Object.keys(envVars)) {
      if (isSecretKey(key)) {
        printWarning(
          `Detected likely-sensitive env var: ${key}\n` +
            `  Env values are visible via the API. For hidden storage + rotation, use:\n` +
            `    anycloud secrets new <name> ${key}=<value>\n` +
            `    anycloud job <image> --secret <name>`,
        );
      }
    }
  }

  return envVars;
}

/**
 * Collapse a commander-collector array: empty → undefined, single → scalar
 * string, multi → array. Keeps single-value users on the wire shape they had
 * before --vm-type became repeatable.
 */
function collapseRepeatable(
  v: string[] | undefined,
): string | string[] | undefined {
  if (!v || v.length === 0) return undefined;
  if (v.length === 1) return v[0];
  return v;
}

/**
 * Build InlineConfigFlags from CLI options (maps option names to config field names).
 */
function buildInlineFlags(options: WorkloadConfigOptions): InlineConfigFlags {
  return {
    credentials: options.credentials,
    region: options.region,
    vmType: collapseRepeatable(options.vmType),
    gpuType: collapseRepeatable(options.gpuType),
    spot: options.spot,
    diskSizeGb: options.diskSize,
    diskTier: options.diskTier,
    inputBucket: options.inputBucket,
    outputBucket: options.outputBucket,
    checkpointBucket: options.checkpointBucket,
    inputStorageCredentials: options.inputStorageCredentials,
    inputStorageRegion: options.inputStorageRegion,
    outputStorageCredentials: options.outputStorageCredentials,
    outputStorageRegion: options.outputStorageRegion,
    checkpointStorageCredentials: options.checkpointStorageCredentials,
    checkpointStorageRegion: options.checkpointStorageRegion,
    availabilityZone: options.zone,
  };
}

function warnIfPinnedComputeRegion(
  resolved: ResolvedConfig,
  resolvedProvider?: CloudType,
): void {
  const provider = resolved.cloudConfig.cloudProvider ?? resolvedProvider;
  if (!provider || !supportsRegionFailover(provider)) return;
  const region = resolved.cloudConfig.region;
  if (!region) return;
  printWarning(
    `Pinned region "${region}" prevents anycloud from failing over to another region when capacity is exhausted. ` +
      'Leave compute region unpinned for normal jobs; --region is only for quota tests, debugging, or an explicit user constraint.',
  );
}

function hasExplicitCheckpointStorage(options: WorkloadConfigOptions): boolean {
  return Boolean(
    options.checkpointStorageCredentials && options.checkpointStorageRegion,
  );
}

function canPromptForSpotPricing(
  cloud: CloudType,
  options: WorkloadConfigOptions,
  opts: ResolveCloudConfigOptions,
): boolean {
  if (options.spot !== undefined) return false;
  if (opts.allowSpotPrompt === false) return false;
  if (
    requiresExplicitCheckpointStorage(cloud) &&
    !hasExplicitCheckpointStorage(options)
  ) {
    return false;
  }
  return true;
}

function shouldPromptForSpotPricingBeforeTarget(
  cloud: CloudType,
  options: WorkloadConfigOptions,
  opts: ResolveCloudConfigOptions,
): boolean {
  return (
    canPromptForSpotPricing(cloud, options, opts) &&
    hasSpotComputeOfferings(cloud)
  );
}

async function promptPricingModel(): Promise<boolean> {
  const sel = await safePrompts<'pricing'>({
    type: 'select',
    name: 'pricing',
    message: 'Pricing model',
    choices: [
      { title: 'On-demand', value: 'ondemand' },
      {
        title: 'Spot / preemptible (cheaper, can be reclaimed)',
        value: 'spot',
      },
    ],
  });
  if (sel.pricing === undefined) process.exit(0);
  return sel.pricing === 'spot';
}

function selectedCredentialName(
  options: WorkloadConfigOptions,
): string | undefined {
  return options.credentials ?? getCredentialsNameFromEnv();
}

function quotaHintLabel(spot: boolean): string {
  return spot ? 'spot quota limit' : 'on-demand quota limit';
}

async function loadComputeTargetQuotaEntries(
  cloud: CloudType,
  options: WorkloadConfigOptions,
): Promise<QuotaStatusEntry[] | undefined> {
  const credentialName = selectedCredentialName(options);
  if (!credentialName) return undefined;

  const spinner = createSpinner('Checking quota limits...').start();
  try {
    const api = await apiClient();
    const response = await api.quota.status({
      query: {
        cloud,
        credentialName,
        waitMs: String(VM_PICKER_QUOTA_STATUS_WAIT_MS),
      },
    });
    if (response.entries.length > 0) {
      spinner.stop();
      return response.entries;
    }
  } catch {
    // Fall through to the warning below: a thrown request and an empty
    // response both mean we couldn't get quota data in time.
  }
  // No entries means the server's quota read timed out and failed open (a
  // healthy read always returns per-region limits). Say so instead of silently
  // dropping to the full catalog, which reads as a bug.
  spinner.warn("Couldn't fetch quota limits — showing the full catalog");
  return undefined;
}

function computeTargetQuotaHints(
  cloud: CloudType,
  options: WorkloadConfigOptions,
  entries: QuotaStatusEntry[] | undefined,
) {
  if (!entries) return undefined;
  const spot = options.spot === true;
  return {
    label: quotaHintLabel(spot),
    regionsForVmType: (vmType: string) =>
      quotaSupportedRegionsForVmType({
        cloud,
        vmType,
        spot,
        regions: options.region
          ? [options.region]
          : getRegionsForVMType(vmType, cloud, spot),
        entries,
        includePublicIpQuota:
          defaultIncludePublicIpQuotaForAvailabilityHints(cloud),
      }),
  };
}

type NamedCloudCredential = RedactedCredential & { cloudProvider: CloudType };

type ResolveNamedCredentialOptions = {
  credentials?: string;
  filterCloud?: CloudType;
  // Leave out storage-only credentials, and refuse one named explicitly.
  computeOnly?: boolean;
  allowPrompt?: boolean;
  ambiguousMessage?: string;
  /** Workload-only escape hatch: an empty saved-credential set is an API-owned default. */
  allowMissing?: boolean;
};

function isNamedCloudCredential(
  credential: RedactedCredential,
  filterCloud?: CloudType,
  computeOnly?: boolean,
): credential is NamedCloudCredential {
  if (!isCloudType(credential.cloudProvider)) return false;
  if (filterCloud && credential.cloudProvider !== filterCloud) return false;
  if (computeOnly && !isComputeProvider(credential.cloudProvider)) return false;
  return true;
}

function resolveNamedCredential(
  options: ResolveNamedCredentialOptions & { allowMissing: true },
): Promise<NamedCloudCredential | undefined>;
function resolveNamedCredential(
  options: ResolveNamedCredentialOptions & { allowMissing?: false },
): Promise<NamedCloudCredential>;
async function resolveNamedCredential(
  options: ResolveNamedCredentialOptions,
): Promise<NamedCloudCredential | undefined> {
  const api = await apiClient();
  const all = await api.credentials.list();
  const { credentials, filterCloud, computeOnly } = options;

  if (credentials) {
    const credential = all.find((c) => c.name === credentials);
    if (!credential) {
      exitWithError(
        `Credential "${credentials}" not found.\n` +
          '   Run "anycloud credentials list" to see available credentials.',
      );
    }
    if (!isCloudType(credential.cloudProvider)) {
      exitWithError(`Unknown cloud provider "${credential.cloudProvider}".`);
    }
    if (filterCloud && credential.cloudProvider !== filterCloud) {
      exitWithError(
        `Credential "${credentials}" is ${credential.cloudProvider}, expected ${filterCloud}.`,
      );
    }
    if (computeOnly && !isComputeProvider(credential.cloudProvider)) {
      exitWithError(storageOnlyComputeMessage(credential.cloudProvider));
    }
    return { ...credential, cloudProvider: credential.cloudProvider };
  }

  const candidates = all.filter((c) =>
    isNamedCloudCredential(c, filterCloud, computeOnly),
  );

  if (candidates.length === 0) {
    if (options.allowMissing) return undefined;
    const scope = filterCloud ? `${filterCloud} ` : '';
    exitWithError(
      `No ${scope}credentials configured.\n` +
        '   Use "anycloud credentials new" to add credentials.',
    );
  }

  if (candidates.length === 1) return candidates[0];

  if (options.allowPrompt === false) {
    exitWithError(options.ambiguousMessage ?? 'Pass --credentials <name>.');
  }

  const widest = candidates.reduce((m, c) => Math.max(m, c.name.length), 0);
  let typedCredential = '';
  const selection = await safePrompts({
    type: 'autocomplete',
    name: 'credential',
    message: 'Pick credentials',
    hint: '⌨️  Type to filter',
    choices: candidates.map((c) => ({
      title: `${c.name.padEnd(widest)}  (${c.cloudProvider})`,
      value: c.name,
    })),
    suggest: suggestFilter,
    onRender(this: { input?: string }) {
      typedCredential = this.input ?? '';
    },
  });
  const exact = candidates.find((c) => c.name === typedCredential);
  const picked =
    exact ?? candidates.find((c) => c.name === selection.credential);
  if (!picked) {
    exitWithError('No credential selected.');
  }
  return picked;
}

export async function resolveOptionalNamedCredential(options: {
  credentials?: string;
  filterCloud?: CloudType;
  computeOnly?: boolean;
  flagName?: string;
  allowPrompt?: boolean;
}): Promise<NamedCloudCredential> {
  const flagName = options.flagName ?? '--credentials';
  return resolveNamedCredential({
    credentials: options.credentials,
    filterCloud: options.filterCloud,
    computeOnly: options.computeOnly,
    allowPrompt: options.allowPrompt ?? shouldAllowPrompts(),
    ambiguousMessage: `Pass ${flagName} <name>.`,
  });
}

/**
 * Resolve a credential for the given (optional) cloud filter. Lists redacted
 * credentials from the server, narrows to the given cloud (if any), and prompts
 * when ambiguous.
 *
 * 0 matching credentials → exit with an actionable message.
 * 1 match → return silently.
 * 2+ → autocomplete picker.
 */
export async function pickCredential(
  filterCloud?: CloudType,
): Promise<NamedCloudCredential> {
  return resolveNamedCredential({ filterCloud, computeOnly: true });
}

/**
 * Resolve cloud config from inline flags and env-backed credentials.
 * Returns ResolvedConfig with credential names for server-side lookup.
 */
export async function resolveCloudConfig(
  options: WorkloadConfigOptions,
  opts: ResolveCloudConfigOptions = {},
): Promise<ResolvedConfig> {
  if (process.env.ANYCLOUD_CONFIG) {
    exitWithError(
      'ANYCLOUD_CONFIG and workload profiles have been removed. Pass inline flags instead, e.g. --credentials <name> --gpu-type h100.',
    );
  }

  const hasCredentialSource = Boolean(
    options.credentials ||
      getCredentialsNameFromEnv() ||
      hasInlineCredentialEnv(),
  );

  // Resolve one compute identity before target selection. A non-empty saved
  // pool keeps today's selection behavior; only an empty pool is left for the
  // API to resolve through an available credentialless provider capability.
  let resolvedCloud = await resolveSelectedCredentialCloud(options);
  let useImplicitApiDefault = false;
  if (!hasCredentialSource) {
    const credential = await resolveNamedCredential({
      allowPrompt: shouldAllowPrompts(),
      ambiguousMessage: 'Pass --credentials <name>.',
      computeOnly: true,
      allowMissing: true,
    });
    if (credential) {
      options = { ...options, credentials: credential.name };
      resolvedCloud = credential.cloudProvider;
    } else {
      useImplicitApiDefault = true;
    }
  }

  // Compute target: when no --vm-type/--gpu-type, prompt with the catalog
  // picker on a TTY once a saved/inline cloud is known. A request with no saved
  // compute identity stays unplaced so the API can resolve a healthy default.
  // Runs before buildInlineFlags so the picked vmType/spot reach the wire config.
  if (opts.requireTarget !== false) {
    const hasVmType = !!(options.vmType && options.vmType.length > 0);
    const hasGpuType = !!(options.gpuType && options.gpuType.length > 0);
    if (!hasVmType && !hasGpuType && !useImplicitApiDefault) {
      const cloud = shouldAllowPrompts() ? resolvedCloud : undefined;
      if (!cloud) {
        exitWithError('Pass either --vm-type <type> or --gpu-type <type>.');
      }
      try {
        await ensureCatalogsBootstrapped();
      } catch {
        exitWithError('Pass either --vm-type <type> or --gpu-type <type>.');
      }
      if (shouldPromptForSpotPricingBeforeTarget(cloud, options, opts)) {
        options = { ...options, spot: await promptPricingModel() };
      }
      const quotaEntries = await loadComputeTargetQuotaEntries(cloud, options);
      const quota = computeTargetQuotaHints(cloud, options, quotaEntries);
      const pickerOptions = {
        allowGpuTypes: true,
        ...(quota && { quota }),
        ...(options.spot === true && { spotOnly: true }),
      };
      const target = await pickComputeTarget(cloud, pickerOptions);
      options =
        target.kind === 'gpuType'
          ? { ...options, gpuType: [target.gpuType], vmType: undefined }
          : { ...options, vmType: [target.vmType], gpuType: undefined };
    }
  }

  const inlineFlags = buildInlineFlags(options);
  const resolved = await buildCloudConfigFromFlags(inlineFlags);

  warnIfPinnedComputeRegion(resolved, resolvedCloud);

  return resolved;
}

/**
 * CloudType from the exact selected credential source. Named credentials use a
 * direct metadata lookup; inline credentials use their env provider.
 */
async function resolveSelectedCredentialCloud(
  options: WorkloadConfigOptions,
): Promise<CloudType | undefined> {
  const name = options.credentials ?? getCredentialsNameFromEnv();
  if (name) {
    const cloud = await getCredentialCloudProvider(name);
    if (cloud && !isComputeProvider(cloud)) {
      exitWithError(storageOnlyComputeMessage(cloud));
    }
    return cloud;
  }

  if (hasInlineCredentialEnv()) {
    return getCredentialsFromEnv().cloudProvider;
  }

  return undefined;
}

/**
 * Build DockerOptions from CLI flags. Returns undefined if no docker options were specified.
 */
export function buildDockerOptions(
  options: DockerRuntimeOptions,
): DockerOptions | undefined {
  const values: DockerOptions = {
    privileged: options.privileged,
    shmSize: options.shmSize,
    gpus: options.gpus,
    ipc: options.ipc,
    ulimits: options.ulimit,
    memory: options.memory,
    cpus: options.cpus,
    runtime: options.runtime,
    binds: options.bind,
    network: options.network,
  };
  return Object.values(values).some((value) =>
    Array.isArray(value) ? value.length > 0 : value !== undefined,
  )
    ? values
    : undefined;
}

/**
 * Resolve a workload ID from argument / env var / interactive picker.
 * Order: explicit arg → ANYCLOUD_WORKLOAD_ID → TTY picker → error.
 *
 * `filter` is applied to picker candidates only (commands like terminate/
 * resubmit narrow to workloads they can actually act on).
 */
export async function resolveWorkloadId(
  idArg: string | undefined,
  options: {
    sinceMs?: number;
    limit?: number;
    stateClass?: ListStateClass;
  } = {},
): Promise<string> {
  if (idArg) return idArg;

  const envId = process.env.ANYCLOUD_WORKLOAD_ID;
  if (envId) return envId;

  // In --json mode the picker's stdout chrome would corrupt the JSON payload
  // pipe (`anycloud status --json | jq ...`). Treat it like non-interactive.
  if (isJsonMode()) {
    exitWithError(
      'Workload ID required with --json. Pass as argument or set ANYCLOUD_WORKLOAD_ID.',
    );
  }

  if (!shouldAllowPrompts()) {
    exitWithError(
      'Workload ID required. Pass as argument or set ANYCLOUD_WORKLOAD_ID.',
    );
  }

  const api = await apiClient();
  const spinner = createSpinner('Loading workloads...').start();
  // The server applies stateClass filtering and bounding; the CLI just renders.
  const workloads = await api.workloads.list({
    query: {
      limit: options.limit === undefined ? undefined : String(options.limit),
      sinceMs:
        options.sinceMs === undefined ? undefined : String(options.sinceMs),
      stateClass: options.stateClass,
    },
  });
  spinner.stop();

  if (workloads.length === 0) {
    printInfo('No workloads found.');
    process.exit(0);
  }

  const selected = await selectWorkload(workloads);
  if (!selected) process.exit(0);
  return selected.id;
}

/**
 * Multi-select variant of resolveWorkloadId for commands that act on a set
 * (terminate, resubmit). Same arg/env precedence; picker is multi-select.
 *
 * `noneMessage` / `cancelMessage` let the caller customize the copy printed
 * when the picker has nothing to show or the user cancels.
 */
export async function resolveWorkloadIds(
  idArgs: string[] | undefined,
  options: {
    sinceMs?: number;
    limit?: number;
    stateClass?: ListStateClass;
    noneMessage?: string;
    cancelMessage?: string;
  } = {},
): Promise<string[]> {
  if (idArgs && idArgs.length > 0) return [...idArgs];

  const envId = process.env.ANYCLOUD_WORKLOAD_ID;
  if (envId)
    return envId
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

  // Mirror resolveWorkload's --json guard so a future --json on terminate/
  // resubmit can't be silently corrupted by picker stdout chrome.
  if (isJsonMode()) {
    exitWithError(
      'Workload ID required with --json. Pass as argument or set ANYCLOUD_WORKLOAD_ID.',
    );
  }

  if (!shouldAllowPrompts()) {
    exitWithError(
      'Workload ID required. Pass as argument or set ANYCLOUD_WORKLOAD_ID.',
    );
  }

  const api = await apiClient();
  const spinner = createSpinner('Loading workloads...').start();
  // The server applies stateClass filtering and bounding; the CLI just renders.
  const workloads = await api.workloads.list({
    query: {
      limit: options.limit === undefined ? undefined : String(options.limit),
      sinceMs:
        options.sinceMs === undefined ? undefined : String(options.sinceMs),
      stateClass: options.stateClass,
    },
  });
  spinner.stop();

  if (workloads.length === 0) {
    printInfo(options.noneMessage ?? 'No workloads found.');
    process.exit(0);
  }

  const selected = await selectWorkloads(workloads);
  if (!selected || selected.length === 0) {
    if (options.cancelMessage) printInfo(options.cancelMessage);
    process.exit(0);
  }
  return selected;
}

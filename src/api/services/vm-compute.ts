import { createHash } from 'node:crypto';
import type { CloudConfig, CloudType } from '../../shared/cloud.js';
import { requiresComputeCredentials } from '../../shared/cloud-config.js';
import { usesAvailabilityZoneTargets } from '../../shared/providers.js';
import type { AddVMAttempt, DbVM, GatewayVM } from './entities.js';
import { resolveWorkloadPrice } from '../../shared/catalog/index.js';
import type { StoredWorkload } from './workload-record.js';
import { log } from './logger.js';
import {
  createComputeProvider,
  loadWorkloadConfigs,
  resolveComputeConfig,
} from './cloud-config.js';
import {
  canObserveStoppedVms,
  confirmVMRelease,
  isPreemptible,
  type CloudCompute,
  type VMReleaseConfirmationPolicy,
  type VMReleaseObservation,
  type VMReleaseObservationOptions,
  type VMReleaseStatus,
} from './gateways/cloud.js';

export type VmComputeCredential =
  | Readonly<{ source: 'attempt'; credentialId: string }>
  | Readonly<{
      source: 'legacy-workload' | 'credentialless';
      credentialId: null;
    }>;

export interface VmComputeIdentity {
  readonly cloudId: string;
  readonly provider: CloudType;
  readonly credential: VmComputeCredential;
  readonly region: string;
  readonly availabilityZone: string | null;
}

const vmComputeBrand: unique symbol = Symbol('VmCompute');

/** One bound VM. No lifecycle operation accepts a replacement native ID. */
export interface VmCompute {
  readonly [vmComputeBrand]: true;
  readonly identity: Readonly<VmComputeIdentity>;
  readonly releaseConfirmationPolicy: VMReleaseConfirmationPolicy;
  observeReleaseOnce(
    options?: VMReleaseObservationOptions,
  ): Promise<VMReleaseObservation>;
  confirmRelease(
    options?: VMReleaseObservationOptions,
  ): Promise<VMReleaseStatus>;
  readonly preemption: Readonly<{
    observe(): Promise<boolean>;
    restart(): Promise<string | null>;
  }> | null;
  /** Null when the gateway can't observe a stopped VM. */
  readonly observeStopped: (() => Promise<boolean>) | null;
}

const bindings = new WeakMap<
  VmCompute,
  { gateway: () => CloudCompute; legacyScopeKey: string | null }
>();

function legacyCredentialScope(
  credentials: CloudConfig['credentials'],
): string {
  if (!credentials || Object.keys(credentials).length === 0) {
    throw new Error('Legacy VM compute credentials are unavailable');
  }
  // Keep concrete fallback scopes isolated without exposing secret values in
  // an observation key or claiming that the attempt recorded these credentials.
  const entries = Object.entries(credentials)
    .filter(([, value]) => value !== undefined)
    .sort(([first], [second]) => first.localeCompare(second));
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

/** Composition clusterRecords have already resolved this attempt's credential and scope. */
export function bindVmCompute(
  compute: CloudCompute | (() => CloudCompute),
  input: VmComputeIdentity,
  legacyCredentials?: CloudConfig['credentials'],
): VmCompute {
  if (
    !input.cloudId ||
    (input.credential.source === 'attempt' && !input.credential.credentialId) ||
    (input.credential.source === 'credentialless' &&
      requiresComputeCredentials(input.provider))
  ) {
    throw new Error('VM compute identity is incomplete');
  }
  const identity = Object.freeze({
    ...input,
    credential: Object.freeze({ ...input.credential }),
  });
  const legacyScopeKey =
    identity.credential.source === 'legacy-workload'
      ? legacyCredentialScope(legacyCredentials)
      : null;
  let selected: CloudCompute | undefined;
  const gateway = () => {
    if (selected) return selected;
    const resolved = typeof compute === 'function' ? compute() : compute;
    if (
      identity.provider !== resolved.type ||
      identity.region !== resolved.region
    ) {
      throw new Error(
        'VM compute identity does not match its resolved gateway',
      );
    }
    selected = resolved;
    return resolved;
  };
  // Eagerly reject mismatched supplied gateways. Lazy resolution lets monitors
  // reuse an in-flight observation without constructing another SDK client.
  if (typeof compute !== 'function') gateway();
  const vm: VmCompute = Object.freeze({
    [vmComputeBrand]: true as const,
    identity,
    get releaseConfirmationPolicy() {
      return gateway().releaseConfirmationPolicy;
    },
    observeReleaseOnce: (options?: VMReleaseObservationOptions) =>
      gateway().observeVMReleaseOnce(identity.cloudId, options),
    confirmRelease: (options?: VMReleaseObservationOptions) =>
      confirmVMRelease(gateway(), identity.cloudId, options),
    get preemption() {
      const selected = gateway();
      return isPreemptible(selected)
        ? Object.freeze({
            observe: () => selected.verifyVMPreemption(identity.cloudId),
            restart: () => selected.startVM(identity.cloudId),
          })
        : null;
    },
    get observeStopped() {
      const selected = gateway();
      return canObserveStoppedVms(selected)
        ? () => selected.observeStoppedVm(identity.cloudId)
        : null;
    },
  });
  bindings.set(vm, { gateway, legacyScopeKey });
  return vm;
}

/** Preserve provider batching while accepting only already-bound VM handles. */
export async function terminateVmComputes(
  vms: readonly VmCompute[],
  onUnconfirmed?: (vm: VmCompute, error: unknown) => void,
): Promise<VmCompute[]> {
  const groups = new Map<CloudCompute, Map<string, VmCompute[]>>();
  for (const vm of vms) {
    const binding = bindings.get(vm);
    if (!binding)
      throw new Error('VM compute handle was not created by its owner');
    const compute = binding.gateway();
    const ids = groups.get(compute) ?? new Map<string, VmCompute[]>();
    const sameNativeId = ids.get(vm.identity.cloudId) ?? [];
    sameNativeId.push(vm);
    ids.set(vm.identity.cloudId, sameNativeId);
    groups.set(compute, ids);
  }
  const confirmed: VmCompute[] = [];
  for (const [compute, ids] of groups) {
    const result = await (onUnconfirmed
      ? compute.terminateVMs([...ids.keys()], (id, error) => {
          for (const vm of ids.get(id)!) onUnconfirmed(vm, error);
        })
      : compute.terminateVMs([...ids.keys()]));
    if (result.some((id) => !ids.has(id))) {
      throw new Error('Provider confirmed termination of an unrequested VM');
    }
    for (const id of new Set(result)) confirmed.push(...ids.get(id)!);
  }
  return confirmed;
}

export function vmComputeIdentityKey(vm: VmCompute): string {
  const binding = bindings.get(vm);
  if (!binding)
    throw new Error('VM compute handle was not created by its owner');
  const { cloudId, provider, credential, region, availabilityZone } =
    vm.identity;
  return JSON.stringify([
    provider,
    credential.source,
    credential.credentialId,
    binding.legacyScopeKey,
    region,
    availabilityZone,
    cloudId,
  ]);
}

export function vmComputeCredential(
  provider: CloudType,
  credentialId: string | null | undefined,
): VmComputeCredential {
  return credentialId
    ? { source: 'attempt', credentialId }
    : {
        source: requiresComputeCredentials(provider)
          ? 'legacy-workload'
          : 'credentialless',
        credentialId: null,
      };
}

/** A placement fact an attempt row records; historical rows can lack one. */
type AttemptFact = 'credential' | 'region' | 'zone' | 'vmType';

/**
 * An existing attempt as one operation resolved it; a new placement's
 * `ProvisioningResolution` instead carries the admitted target. `legacy` names
 * the facts the row lacks and the region or VM type substituted for them, which
 * is never written back. A missing credential means the configuration is the
 * operation's fallback (or it deferred); a missing zone is left to discovery.
 */
export type ExistingAttempt<T> = T &
  (
    | { readonly attempt: 'recorded' }
    | {
        readonly attempt: 'legacy';
        readonly missing: readonly AttemptFact[];
        readonly fallback: Readonly<Pick<CloudConfig, 'region' | 'vmType'>>;
      }
  );

/** Only a provider that requires a credential or targets zones needs one. */
export function existingAttempt<T extends object>(
  result: T,
  provider: CloudType | null | undefined,
  row: Readonly<Partial<Record<AttemptFact, unknown>>>,
  fallback: Readonly<Pick<CloudConfig, 'region' | 'vmType'>> = {},
): ExistingAttempt<T> {
  const needed = (fact: AttemptFact) =>
    !provider ||
    (fact === 'credential'
      ? requiresComputeCredentials(provider)
      : fact !== 'zone' || usesAvailabilityZoneTargets(provider));
  const missing = (Object.keys(row) as AttemptFact[]).filter(
    (fact) => row[fact] == null && needed(fact),
  );
  if (missing.length === 0) return { ...result, attempt: 'recorded' };
  return {
    ...result,
    attempt: 'legacy',
    missing,
    fallback: {
      ...(missing.includes('region') && { region: fallback.region }),
      ...(missing.includes('vmType') && { vmType: fallback.vmType }),
    },
  };
}

export type WorkloadVmComputeResolution = ExistingAttempt<
  | { vmCompute: VmCompute; cloudConfig: CloudConfig; reason?: never }
  | { vmCompute: null; cloudConfig: null; reason: string }
>;

/**
 * Resolve an existing VM attempt from its recorded facts. The row's credential
 * and zone are used as recorded (a row without a zone gets none, never the
 * fallback's or another attempt's, so the provider discovers it); its region
 * wins over the configuration's. Its configuration is `loadWorkloadConfigs` for
 * that credential (see its placement rule). A row without a recorded credential
 * follows the operation's rule:
 * - `{ fallback }` (retry, recovery, storage): use that configuration, with its
 *   region when the row has none; the identity says `legacy-workload`, or
 *   `credentialless` for a provider that needs no credential.
 * - `'defer'` (persistent-VM host loss): defer when the provider needs a
 *   credential, rather than borrowing one.
 */
export async function loadWorkloadVmCompute(
  workload: StoredWorkload,
  vm: DbVM,
  legacy: { fallback: CloudConfig } | 'defer',
): Promise<WorkloadVmComputeResolution> {
  const provider = vm.cloudProvider ?? workload.cloudProvider;
  const row = {
    credential: vm.credentialId,
    region: vm.region,
    zone: vm.availabilityZone,
  };
  const unavailable = (reason: string, known = provider) =>
    existingAttempt({ vmCompute: null, cloudConfig: null, reason }, known, row);
  if (
    legacy === 'defer' &&
    provider &&
    requiresComputeCredentials(provider) &&
    !vm.credentialId
  ) {
    return unavailable('exact VM attempt credentials unavailable');
  }
  const loaded = vm.credentialId
    ? await loadWorkloadConfigs(workload, vm.credentialId)
    : legacy === 'defer'
      ? await loadWorkloadConfigs(workload)
      : legacy.fallback;
  if (!loaded) return unavailable('compute credentials unavailable');
  if (provider && loaded.cloudProvider !== provider) {
    return unavailable('VM attempt credential provider changed');
  }
  if (
    legacy === 'defer' &&
    requiresComputeCredentials(loaded.cloudProvider) &&
    !vm.credentialId
  ) {
    return unavailable(
      'exact VM attempt credentials unavailable',
      loaded.cloudProvider,
    );
  }
  const cloudConfig: CloudConfig = {
    ...loaded,
    region: vm.region ?? loaded.region,
    availabilityZone: vm.availabilityZone,
  };
  const resolved = resolveComputeConfig(
    {
      ...cloudConfig,
      credentials: cloudConfig.credentials
        ? { ...cloudConfig.credentials }
        : undefined,
    },
    'observed-vm',
  );
  const vmCompute = bindVmCompute(
    () => createComputeProvider(resolved, 'observed-vm'),
    {
      cloudId: vm.cloudId,
      provider: cloudConfig.cloudProvider,
      credential: vmComputeCredential(
        cloudConfig.cloudProvider,
        vm.credentialId,
      ),
      region: vm.region ?? resolved.region ?? '',
      availabilityZone: vm.availabilityZone ?? null,
    },
    resolved.credentials,
  );
  return existingAttempt(
    { vmCompute, cloudConfig },
    cloudConfig.cloudProvider,
    row,
    loaded,
  );
}

/** A VM restarted in place and the attempt facts that track it. */
export interface RestartedVM {
  vm: GatewayVM;
  attempt: AddVMAttempt;
}

/**
 * Start a preempted VM in place and return the row facts that track it, or
 * null when the cloud could not restart it.
 */
export async function restartPreemptedVM(
  preemption: NonNullable<VmCompute['preemption']>,
  cloudConfig: CloudConfig,
  vm: DbVM,
): Promise<RestartedVM | null> {
  const newIp = await preemption.restart();
  if (!newIp) return null;
  return {
    // Spread every gateway fact (base-image provenance, SSH endpoint, etc.)
    // forward; dropping one would persist NULL and mislead later recovery work.
    vm: {
      ...vm,
      ip: newIp,
      // Direct SSH follows the VM IP; a separate gateway keeps its address.
      sshHost: vm.sshHost === vm.ip ? newIp : vm.sshHost,
    },
    attempt: {
      region: cloudConfig.region,
      // loadWorkloadConfigs surfaces the actual resolved VM type from the
      // current attempt, so this prices the restart exactly.
      vmType: cloudConfig.vmType,
      credentialId: vm.credentialId,
      pricePerHour: resolveWorkloadPrice(
        cloudConfig.cloudProvider,
        cloudConfig.vmType,
        cloudConfig.region,
        !!cloudConfig.spot,
      ),
    },
  };
}

/**
 * Restart a spot VM in place when the cloud reports it preempted. A spot
 * eviction stops the VM but keeps its disk, so final output sync can resume.
 * Fails open: a provider error returns null so final sync still spends its
 * bounded attempts instead of deferring forever.
 */
export async function restartIfPreempted(
  workload: StoredWorkload,
  vm: DbVM,
  fallback: CloudConfig,
): Promise<RestartedVM | null> {
  try {
    const { vmCompute, cloudConfig } = await loadWorkloadVmCompute(
      workload,
      vm,
      { fallback },
    );
    const preemption = vmCompute?.preemption;
    if (!preemption || !cloudConfig || !(await preemption.observe())) {
      return null;
    }
    return await restartPreemptedVM(preemption, cloudConfig, vm);
  } catch (error) {
    log.warn('VM preemption restart check failed', { id: workload.id, error });
    return null;
  }
}

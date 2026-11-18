/**
 * VM-host termination effects: group every provisioning attempt into the
 * placements cleanup must visit, retire only provider-confirmed compute
 * releases, then remove networking and DNS.
 */

import {
  getProvisioningAttemptStore,
  getWorkloadQueryStore,
} from '../persistence.js';
import {
  bindVmCompute,
  existingAttempt,
  terminateVmComputes,
  vmComputeCredential,
  type ExistingAttempt,
  type VmCompute,
} from '../vm-compute.js';
import { type ProvisioningAttemptRef } from '../entities.js';
import { type StoredWorkload } from '../workload-record.js';
import { type CloudConfig, type CloudType } from '../../../shared/cloud.js';
import { createComputeProvider, loadWorkloadConfigs } from '../cloud-config.js';
import { WORKLOAD_ACTION } from '../codes.js';
import { log } from '../logger.js';
import { usesAvailabilityZoneTargets } from '../../../shared/providers.js';
import { deleteDNSRecord } from '../../../shared/dns-worker.js';
import { completeWorkloadCleanup } from '../workload-cleanup.js';
import { quiesceVmServiceStorage } from '../vm-runtime-storage.js';

/** A VM ledger row as termination reads it; one row per provisioning attempt. */
interface TerminationAttempt {
  id: number;
  cloud_id: string;
  created_at: number;
  /** Set once the provider confirmed the compute gone. */
  ended_at: number | null;
  /** Null on historical rows; the cleanup configuration fills the gaps. */
  cloud_provider: CloudType | null;
  credential_id: string | null;
  region: string | null;
  availability_zone: string | null;
  vm_type: string | null;
}

/** The workload read VM termination performs. */
interface TerminationWorkloads {
  getWorkload(workloadId: string): Promise<StoredWorkload | null>;
}
/** The attempt-ledger reads and writes VM termination performs. */
interface TerminationAttempts {
  /** Every attempt, ended or not, oldest first. */
  getProvisioningAttempts(workloadId: string): Promise<TerminationAttempt[]>;
  /** Stamp the removal request on the listed attempts that are still unended. */
  claimVmRemoval(workloadId: string, cloudIds: string[]): Promise<void>;
  /** Retire one attempt whose compute the provider confirmed deleted. */
  endProvisioningAttempt(
    workloadId: string,
    ref: ProvisioningAttemptRef,
  ): Promise<void>;
  updateDnsRecordId(
    workloadId: string,
    dnsRecordId: string | null,
  ): Promise<void>;
}

/** Clean a workload with the default VM/network teardown implementation. */
export async function terminate(
  cloudConfig: CloudConfig,
  id: string,
): Promise<boolean> {
  return completeWorkloadCleanup(cloudConfig, id, (workload) =>
    terminateStep(cloudConfig, id, workload),
  );
}

/**
 * Tear down VMs only — used during retry/recovery so networking (NSG, VNet,
 * firewalls) stays alive for the next provisioning attempt. Without this
 * separation, retry cleanup and provisioning race: cleanup tries to delete the
 * NSG while provisioning has already attached a new NIC to it, causing
 * "NSG in use" errors that block cleanup for 30 min.
 */
export async function teardownVMs(
  cloudConfig: CloudConfig,
  id: string,
): Promise<void> {
  const groups = await prepareTermination(cloudConfig, id);
  for (const group of groups) {
    if (group.attempts.length === 0) continue;
    await terminateBoundVMs(id, bindTerminationGroup(group).targets);
  }
}

/**
 * Quiesce a previously-running Service, freeze its checkpoint writer, and force
 * a final upload before replacing its VM. A failed flush deliberately leaves
 * the old VM registered so reconciliation can retry without provisioning over
 * stale state.
 */
export async function teardownServiceVMs(
  cloudConfig: CloudConfig,
  id: string,
): Promise<void> {
  await quiesceVmServiceStorage(cloudConfig, id);
  await teardownVMs(cloudConfig, id);
}

/**
 * Final Service cleanup uses the same quiesce contract as replacement, then
 * removes networking and any other workload-scoped resources.
 */
export async function terminateServiceStep(
  cloudConfig: CloudConfig,
  id: string,
  workloadSnapshot?: StoredWorkload,
): Promise<void> {
  await quiesceVmServiceStorage(cloudConfig, id, workloadSnapshot);
  await terminateStep(cloudConfig, id, workloadSnapshot);
}

/**
 * Full cleanup — VMs + networking. Used for final teardown only
 * (user-initiated terminate, exhausted retries, stuck terminations).
 */
export async function terminateStep(
  cloudConfig: CloudConfig,
  id: string,
  workloadSnapshot?: StoredWorkload,
): Promise<void> {
  const workloads: TerminationWorkloads = getWorkloadQueryStore();
  const ledger: TerminationAttempts = getProvisioningAttemptStore();
  const workload = workloadSnapshot ?? (await workloads.getWorkload(id));

  const groups = await prepareTermination(cloudConfig, id, workload);
  const cleanupGroups =
    groups.length > 0
      ? groups
      : [{ cloudConfig: { ...cloudConfig }, credentialId: null, attempts: [] }];

  const preparedGroups = cleanupGroups.map(bindTerminationGroup);

  // Stop spend first. Persist each provider-confirmed deletion before any
  // networking, DNS, or checkpoint operation can fail.
  for (const { targets } of preparedGroups) {
    await terminateBoundVMs(id, targets);
  }

  for (const { compute } of preparedGroups) {
    await compute.terminateNetworking(id);
  }

  // DNS follows compute teardown so an outage cannot leave billable VMs
  // running. Clearing its durable ID avoids replaying a successful delete if a
  // later checkpoint operation fails.
  if (workload?.dnsRecordId) {
    log.info('Deleting DNS record', { id, recordId: workload.dnsRecordId });
    await deleteDNSRecord(workload.dnsRecordId, workload.githubToken);
    await ledger.updateDnsRecordId(id, null);
  }
}

interface TerminationGroup {
  cloudConfig: CloudConfig;
  credentialId: string | null;
  attempts: ProvisioningAttemptRef[];
}

function bindTerminationGroup(group: TerminationGroup) {
  const compute = createComputeProvider(group.cloudConfig, 'observed-vm');
  const targets = group.attempts.map((attempt) => ({
    attempt,
    vm: bindVmCompute(
      compute,
      {
        cloudId: attempt.cloudId,
        provider: group.cloudConfig.cloudProvider,
        credential: vmComputeCredential(
          group.cloudConfig.cloudProvider,
          group.credentialId,
        ),
        region: group.cloudConfig.region ?? compute.region,
        availabilityZone: group.cloudConfig.availabilityZone ?? null,
      },
      group.cloudConfig.credentials,
    ),
  }));
  return { compute, targets };
}

/**
 * Group every provisioning attempt into the credential/region placements
 * cleanup has to visit, and record the removal request against the VMs about to
 * be terminated. Both teardown entry points funnel through here, so this is the
 * one place that sees every VM we are about to stop wanting — including the
 * mid-life replacements teardownVMs handles. Stamping is why this does slightly
 * more than its name suggests.
 */
async function prepareTermination(
  cloudConfig: CloudConfig,
  id: string,
  workloadSnapshot?: StoredWorkload | null,
): Promise<ExistingAttempt<TerminationGroup>[]> {
  const ledger: TerminationAttempts = getProvisioningAttemptStore();
  const workloads: TerminationWorkloads = getWorkloadQueryStore();
  const workload =
    workloadSnapshot === undefined
      ? await workloads.getWorkload(id)
      : workloadSnapshot;

  // Group every attempt, including ones whose compute was already confirmed
  // deleted at T2. Networking is per credential/region, so a later
  // networking/DNS/checkpoint failure must be able to reconstruct each
  // ancillary group after a restart — an ended VM row does not mean its
  // region's networking is gone. Grouping collapses the list to distinct
  // placements, so replaying an already-torn-down group costs one idempotent
  // no-op, not growth with workload history. Only unended cloud IDs are
  // deleted (below), which is the same set markCleanupComplete requires to be
  // empty; deriving both from one predicate keeps them from disagreeing.
  const allAttempts = await ledger.getProvisioningAttempts(id);
  type ProvisioningAttempt = (typeof allAttempts)[number];
  interface AttemptGroup {
    provider: CloudConfig['cloudProvider'] | undefined;
    credentialId: string | null;
    region: string | undefined;
    availabilityZone: string | undefined;
    vmType: string | string[] | undefined;
    attempts: ProvisioningAttempt[];
  }
  const grouped = new Map<string, AttemptGroup>();
  for (const attempt of allAttempts) {
    const provider =
      attempt.cloud_provider ??
      (attempt.credential_id ? undefined : cloudConfig.cloudProvider);
    const credentialId = attempt.credential_id ?? null;
    const region = attempt.region ?? cloudConfig.region;
    const availabilityZone = attempt.availability_zone ?? undefined;
    const vmType = attempt.vm_type ?? cloudConfig.vmType;
    const key = JSON.stringify([
      provider,
      credentialId,
      region,
      availabilityZone,
      vmType,
    ]);
    const group: AttemptGroup = grouped.get(key) ?? {
      provider,
      credentialId,
      region,
      availabilityZone,
      vmType,
      attempts: [],
    };
    group.attempts.push(attempt);
    grouped.set(key, group);
  }

  const groups: ExistingAttempt<TerminationGroup>[] = [];
  for (const group of grouped.values()) {
    let groupConfig = { ...cloudConfig };
    if (group.credentialId) {
      if (!workload) {
        throw new Error(
          `Cannot load cleanup credentials for ${id}: workload not found`,
        );
      }
      const loaded = await loadWorkloadConfigs(workload, group.credentialId);
      if (!loaded) {
        throw new Error(
          `Cannot load cleanup credentials for ${id}: credential ${group.credentialId} not found`,
        );
      }
      groupConfig = { ...loaded };
    }
    if (group.provider && groupConfig.cloudProvider !== group.provider) {
      throw new Error(
        `Cannot load cleanup credentials for ${id}: VM attempt provider changed`,
      );
    }
    groupConfig.region = group.region;
    // A provisioning attempt's persisted zone is authoritative for zonal
    // lifecycle APIs. Legacy rows without zone metadata must not inherit the
    // latest attempt's zone: zone-scoped 404s are not project-wide absence.
    groupConfig.availabilityZone = group.availabilityZone;
    if (
      group.availabilityZone === undefined &&
      usesAvailabilityZoneTargets(groupConfig.cloudProvider)
    ) {
      log.warn('Legacy cleanup attempt requires provider-wide zone discovery', {
        id,
        cloud: groupConfig.cloudProvider,
        region: groupConfig.region,
        vmType: group.vmType,
        attemptCount: group.attempts.length,
      });
    }
    groupConfig.vmType = group.vmType;
    const attempts = group.attempts
      .filter((attempt) => attempt.ended_at === null)
      .map((attempt) => ({
        vmRowId: attempt.id,
        cloudId: attempt.cloud_id,
        createdAt: attempt.created_at,
      }));
    // A group's region or VM type is recorded only if every member row has it.
    const prepared = existingAttempt(
      { cloudConfig: groupConfig, credentialId: group.credentialId, attempts },
      groupConfig.cloudProvider,
      {
        credential: group.credentialId,
        region: group.attempts.every((row) => row.region != null)
          ? group.region
          : null,
        zone: group.availabilityZone,
        vmType: group.attempts.every((row) => row.vm_type != null)
          ? group.vmType
          : null,
      },
      cloudConfig,
    );
    log.info('Terminating VM cleanup group', {
      id,
      vmType: groupConfig.vmType,
      cloud: groupConfig.cloudProvider,
      region: groupConfig.region,
      availabilityZone: groupConfig.availabilityZone,
      action: WORKLOAD_ACTION.TERMINATING,
      cloudIds: attempts.map((attempt) => attempt.cloudId),
      attempt: prepared.attempt,
      ...(prepared.attempt === 'legacy' && {
        missing: prepared.missing,
        fallback: prepared.fallback,
      }),
    });
    groups.push(prepared);
  }

  // Reported, not billed: this is what lets a finished workload show how much
  // of its billable time was spent waiting for the provider to let go. Groups
  // with no unended VMs contribute nothing, so a networking-only replay stamps
  // nothing.
  await ledger.claimVmRemoval(
    id,
    groups.flatMap((group) => group.attempts.map((attempt) => attempt.cloudId)),
  );

  return groups;
}

// Marks `ended_at` only for VMs whose cloud-side resource is confirmed gone.
// vmIds the cloud failed to delete stay live so cleanup reconciliation retries
// them. Never end every row here — that would decouple the DB from cloud
// reality and orphan resources permanently.
async function terminateBoundVMs(
  id: string,
  targets: Array<{ vm: VmCompute; attempt: ProvisioningAttemptRef }>,
) {
  if (targets.length === 0) return;
  const deleted = new Set(
    await terminateVmComputes(targets.map(({ vm }) => vm)),
  );
  const ledger: TerminationAttempts = getProvisioningAttemptStore();
  await Promise.all(
    targets
      .filter(({ vm }) => deleted.has(vm))
      .map(({ attempt }) => ledger.endProvisioningAttempt(id, attempt)),
  );
}

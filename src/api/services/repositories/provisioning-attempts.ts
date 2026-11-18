/** The Workload provisioning-attempt ledger: attempt registration, completion, release, endpoints, and billing identity. */
import { WorkloadState } from '../../../shared/workload.js';
import {
  type CloudFailureDiagnosis,
  type CloudType,
} from '../../../shared/cloud.js';
import { normalizeBucketHostPaths } from '../../../shared/providers.js';
import { toArray } from '../../../shared/utils.js';
import {
  resolveGatewayVM,
  type AddVMAttempt,
  type GatewayVM,
  type ProvisioningAttemptRef,
} from '../entities.js';
import { assertSpecOwnership } from '../container-spec.js';
import type { WorkloadPublicEndpoint } from '../workload-record.js';
import { computedWorkloadCloudProviderSql } from './credential-reference.js';
import type { DB } from './db.js';

// A row in the `vms` table — the provisioning *ledger*, not a live VM list.
// Each row is ONE attempt to stand up a real cloud VM and has exactly one
// workload, node pool or cluster owner:
//   - ip IS NOT NULL → a provisioned VM (live iff ended_at IS NULL)
//   - ip IS NULL     → a durable in-flight/failed-attempt placeholder, written
//     before the first provider mutation so cleanup can recover after a crash.
// Columns split into the resolved TARGET (region, availability_zone, vm_type,
// credential_id — what the orchestrator picked for the attempt) and the gateway
// RESULT (ip, cloud_id, ssh_*, *_image_id — what the cloud returned). Jobs are
// single-VM, so an attempt is one row; the row-array shapes are about multiple
// attempts over a workload's life, not multiple concurrent VMs. (snake_case
// matches columns.)
export interface VMRow {
  id: number; // Immutable VM-ledger row identity
  workload_id: string | null;
  node_pool_id: string | null;
  cluster_id: string | null;
  cloud_id: string; // NOT NULL in schema
  created_at: number; // NOT NULL in schema
  region: string; // nullable in schema (ALTER TABLE can't add NOT NULL) but always set
  ip: string | null;
  private_ip: string | null;
  base_image_id: string | null;
  availability_zone: string | null;
  ended_at: number | null; // Spend cutoff for this VM; NULL accrues through the query window end
  preempt: number | null;
  // Credential the VM booted with. Nullable for legacy rows (pre-0043) and
  // for failed-VM placeholders inserted before a cred could be selected.
  credential_id: string | null;
  // Hourly catalog price at provision time. NULL for unpriced attempts and
  // for rows created before migration 0045.
  price_per_hour: number | null;
  // SSH endpoint when it differs from ip:22 — e.g. a Local VM's mapped port.
  // NULL for providers reached directly at ip:22 (added in migration 0051).
  ssh_host: string | null;
  ssh_port: number | null;
  // SSH username when it differs from root. NULL means root.
  ssh_username?: string | null;
  // Optimizer-resolved vmType for this attempt (added in migration 0056). NULL
  // for rows created before it. Read back by getLatestProvisioningConfig so the
  // monitor sees the actual provisioned type, not the request-array head.
  vm_type: string | null;
  cloud_provider: CloudType | null;
  input_host_path: string | null;
  output_host_path: string | null;
  checkpoint_host_path: string | null;
  removal_requested_at: number | null;
}

/** Current provider releases that have exceeded the alert threshold. */
export interface OverdueVmReleaseSummary {
  vmCount: number;
  workloadCount: number;
  oldestRemovalRequestedAt: number;
  workloadIds: string[];
}

export class ProvisioningAttemptStore {
  constructor(private readonly db: DB) {}

  /**
   * Durably register a provisioning attempt before any provider-side mutation.
   *
   * The synthetic cloud ID is also the requested VM name/client token. If the
   * process exits after networking or partial VM resources are created, the
   * terminal/retry cleanup paths can still discover this row and retry cleanup.
   */
  async beginProvisioningAttempt(
    workloadId: string,
    cloudId: string,
    attempt: AddVMAttempt = {},
  ): Promise<ProvisioningAttemptRef | null> {
    const createdAt = Date.now();
    const bucketHostPaths = normalizeBucketHostPaths(attempt.bucketHostPaths);
    const rows = await this.db.query<{
      id: number;
      cloud_id: string;
      created_at: number;
    }>(
      `INSERT INTO vms (
         workload_id, cloud_id, created_at, region, availability_zone,
         credential_id, price_per_hour, vm_type, input_host_path,
         output_host_path, checkpoint_host_path
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       FROM workloads
       WHERE id = ?
         AND state = ?
       RETURNING id, cloud_id, created_at`,
      [
        workloadId,
        cloudId,
        createdAt,
        attempt.region ?? null,
        attempt.availabilityZone ?? null,
        attempt.credentialId ?? null,
        attempt.pricePerHour ?? null,
        toArray(attempt.vmType)[0] ?? null,
        bucketHostPaths.input,
        bucketHostPaths.output,
        bucketHostPaths.checkpoint,
        workloadId,
        WorkloadState.Provisioning,
      ],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      vmRowId: row.id,
      cloudId: row.cloud_id,
      createdAt: row.created_at,
    };
  }

  /**
   * Fill the exact pre-registered attempt row with provider-returned VM facts.
   * Resolved attempt intent stays immutable; only a provider-accepted price may
   * replace its catalog estimate. Updating rather than inserting closes the
   * crash window between a successful launch and durable cleanup ownership.
   */
  async completeProvisioningAttempt(
    workloadId: string,
    ref: ProvisioningAttemptRef,
    vm: GatewayVM,
  ): Promise<ProvisioningAttemptRef> {
    const { sshHost, sshPort, sshUsername } = resolveGatewayVM(vm);
    const createdAt = vm.createdAt ?? ref.createdAt;
    const result = await this.db.query<{ rowsAffected: number }>(
      `UPDATE vms
       SET ip = ?,
           cloud_id = ?,
           private_ip = ?,
           base_image_id = ?,
           availability_zone = COALESCE(?, availability_zone),
           created_at = ?,
           ended_at = NULL,
           removal_requested_at = NULL,
           ssh_host = ?,
           ssh_port = ?,
           ssh_username = ?
       WHERE id = ?
         AND workload_id = ?
         AND ip IS NULL`,
      [
        vm.ip,
        vm.cloudId,
        vm.privateIp ?? null,
        vm.baseImageId ?? null,
        vm.availabilityZone ?? null,
        createdAt,
        sshHost,
        sshPort,
        sshUsername,
        ref.vmRowId,
        workloadId,
      ],
    );
    if (result[0]?.rowsAffected !== 1) {
      throw new Error(
        `Workload ${workloadId}: provisioning attempt ${ref.cloudId} is missing or already completed`,
      );
    }
    return { vmRowId: ref.vmRowId, cloudId: vm.cloudId, createdAt };
  }

  /**
   * Preserve a real provider cleanup ID exposed by a failed launch. Reopening
   * an attempt that cleanup raced and marked ended makes the terminal
   * reconciler discover the actual provider resource on its next pass.
   */
  async retargetProvisioningAttempt(
    workloadId: string,
    ref: ProvisioningAttemptRef,
    cloudId: string,
  ): Promise<ProvisioningAttemptRef> {
    const result = await this.db.query<{ rowsAffected: number }>(
      `UPDATE vms
       SET cloud_id = ?, ended_at = NULL, removal_requested_at = NULL
       WHERE id = ?
         AND workload_id = ?
         AND ip IS NULL`,
      [cloudId, ref.vmRowId, workloadId],
    );
    if (result[0]?.rowsAffected !== 1) {
      throw new Error(
        `Workload ${workloadId}: provisioning attempt ${ref.cloudId} cannot be retargeted`,
      );
    }
    return {
      vmRowId: ref.vmRowId,
      cloudId,
      createdAt: ref.createdAt,
    };
  }

  /**
   * Record that removal of these VMs was requested, before the provider is
   * asked to terminate them. The request prevents retry reuse; `ended_at`
   * remains the billing end because the provider goes on charging the
   * customer's own account until it actually releases the machine.
   *
   * First stamp wins: cleanup retries the same set until every row is ended,
   * and re-stamping would keep resetting how long the wait appears to be. Rows
   * the provider already confirmed gone are left alone.
   */
  async claimVmRemoval(workloadId: string, cloudIds: string[]): Promise<void> {
    if (cloudIds.length === 0) return;
    const placeholders = cloudIds.map(() => '?').join(', ');
    await this.db.query(
      `UPDATE vms SET removal_requested_at = COALESCE(removal_requested_at, ?)
       WHERE workload_id = ?
         AND ended_at IS NULL
         AND cloud_id IN (${placeholders})`,
      [Date.now(), workloadId, ...cloudIds],
    );
  }

  /**
   * Summarize currently overdue provider releases for one low-noise alert.
   *
   * A removal stamp, not a usable IP, proves cleanup was requested. Failed
   * provisioning attempts therefore remain visible while their provider-side
   * resource identity is being retired.
   */
  async summarizeOverdueVmReleases(
    cutoff: number,
    workloadSampleLimit = 10,
  ): Promise<OverdueVmReleaseSummary | null> {
    const predicate = `workload_id IS NOT NULL
      AND ended_at IS NULL
      AND removal_requested_at IS NOT NULL
      AND removal_requested_at <= ?`;
    const [summary] = await this.db.query<{
      vm_count: number;
      workload_count: number;
      oldest_removal_requested_at: number | null;
    }>(
      `SELECT COUNT(*) AS vm_count,
              COUNT(DISTINCT workload_id) AS workload_count,
              MIN(removal_requested_at) AS oldest_removal_requested_at
       FROM vms
       WHERE ${predicate}`,
      [cutoff],
    );
    if (!summary || summary.vm_count === 0) return null;
    if (summary.oldest_removal_requested_at === null) {
      throw new Error('Overdue VM release summary has no removal timestamp');
    }

    const limit = Math.max(0, Math.floor(workloadSampleLimit));
    const workloads = await this.db.query<{ workload_id: string }>(
      `SELECT workload_id
       FROM vms
       WHERE ${predicate}
       GROUP BY workload_id
       ORDER BY MIN(removal_requested_at), workload_id
       LIMIT ?`,
      [cutoff, limit],
    );
    return {
      vmCount: summary.vm_count,
      workloadCount: summary.workload_count,
      oldestRemovalRequestedAt: summary.oldest_removal_requested_at,
      workloadIds: workloads.map((row) => row.workload_id),
    };
  }

  /** Record a failed launch's classification on its own attempt row. */
  async recordLaunchFailure(
    workloadId: string,
    ref: ProvisioningAttemptRef,
    failure: { diagnosis: CloudFailureDiagnosis; regionDenied: string | null },
  ): Promise<void> {
    await this.db.query(
      `UPDATE vms SET launch_diagnosis = ?, launch_region_denied = ?
       WHERE id = ? AND workload_id = ?`,
      [failure.diagnosis, failure.regionDenied, ref.vmRowId, workloadId],
    );
  }

  /** End only the attempt whose exact native identity was confirmed released. */
  async endProvisioningAttempt(
    workloadId: string,
    ref: ProvisioningAttemptRef,
  ): Promise<void> {
    await this.db.query(
      `UPDATE vms SET ended_at = ?
       WHERE id = ? AND workload_id = ? AND cloud_id = ?
         AND created_at = ? AND ended_at IS NULL`,
      [Date.now(), ref.vmRowId, workloadId, ref.cloudId, ref.createdAt],
    );
  }

  /**
   * Count all VMs ever created for a workload (including ended/failed).
   * Used as startIndex for VM naming so each attempt gets a unique vmId.
   */
  async countAllVMs(workloadId: string): Promise<number> {
    const rows = await this.db.query<{ count: number }>(
      `SELECT COUNT(*) as count FROM vms WHERE workload_id = ?`,
      [workloadId],
    );
    return rows[0]?.count ?? 0;
  }

  /**
   * Get all provisioning attempts for a workload (including ended/failed VMs).
   * Used by the region optimizer to decide whether to reuse a region or fail over.
   */
  async getProvisioningAttempts(workloadId: string): Promise<VMRow[]> {
    return this.db.query<VMRow>(
      `SELECT * FROM vms WHERE workload_id = ? ORDER BY created_at ASC`,
      [workloadId],
    );
  }

  async getUnresolvedProvisioningAttempts(
    workloadId: string,
  ): Promise<VMRow[]> {
    return this.db.query<VMRow>(
      `SELECT *
       FROM vms
       WHERE workload_id = ?
         AND ip IS NULL
         AND ended_at IS NULL
       ORDER BY created_at ASC`,
      [workloadId],
    );
  }

  /**
   * Read only the identity required to reconcile one workload's VM costs.
   * The VM credential is an explicit override, including legacy NULL values;
   * never replace it with the workload's current credential. The provider
   * fallback is needed only when that selected credential no longer exists.
   * Keep owner/spec structure checks without hydrating unrelated configuration.
   */
  async getWorkloadBillingIdentity(
    workloadId: string,
    credentialId: string | null,
  ): Promise<{
    cloudProvider: CloudType | null;
    encryptedData: string | null;
  } | null> {
    const [row] = await this.db.query<{
      id: string;
      deployment_id: string | null;
      container_spec_owner_id: string | null;
      missing_image: number;
      missing_registry_username: number;
      cloudProvider: CloudType | null;
      encryptedData: string | null;
    }>(
      `SELECT d.id, d.deployment_id,
              s.workload_id AS container_spec_owner_id,
              s.image IS NULL AS missing_image,
              s.registry_username IS NULL AS missing_registry_username,
              c.encrypted_data AS encryptedData,
              CASE WHEN c.id IS NULL
                THEN ${computedWorkloadCloudProviderSql('d')}
                ELSE c.cloud_provider
              END AS cloudProvider
       FROM workloads d
       LEFT JOIN container_specs s ON s.workload_id = d.id
       LEFT JOIN credentials c ON c.id = ?
       WHERE d.id = ?`,
      [credentialId, workloadId],
    );
    if (!row) return null;
    assertSpecOwnership(row);
    if (
      row.deployment_id === null &&
      (row.missing_image || row.missing_registry_username)
    ) {
      throw new Error(`Workload ${row.id}: container spec is incomplete`);
    }
    return {
      cloudProvider: row.cloudProvider,
      encryptedData: row.encryptedData,
    };
  }

  async updateDnsRecordId(
    workloadId: string,
    dnsRecordId: string | null,
  ): Promise<void> {
    await this.db.query(`UPDATE workloads SET dns_record_id = ? WHERE id = ?`, [
      dnsRecordId,
      workloadId,
    ]);
  }

  /** The node pool Service's public endpoint view; null clears it with the record. */
  async updatePublicEndpoint(
    workloadId: string,
    endpoint: WorkloadPublicEndpoint | null,
  ): Promise<void> {
    await this.db.query(
      `UPDATE workloads SET public_endpoint_ip = ?, public_endpoint_state = ?, public_endpoint_error = ? WHERE id = ?`,
      [
        endpoint?.ip ?? null,
        endpoint?.state ?? null,
        endpoint?.error ?? null,
        workloadId,
      ],
    );
  }
}

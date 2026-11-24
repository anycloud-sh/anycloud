/**
 * Workload query projections: hydrated Workload reads, the list and status
 * reads on the read-only connection, the terminal digest rows, scheduling
 * candidates, and the VM projection.
 */

import { type DB } from './db.js';
import {
  computedWorkloadCloudProviderSql,
  scalarCredentialSql,
} from './credential-reference.js';
import {
  type StoredWorkload,
  type ProvisioningConfig,
} from '../workload-record.js';
import { CloudType, isDiskTier } from '../../../shared/cloud.js';
import {
  ACTIVE_STATES,
  WorkloadState,
  WorkloadType,
  TERMINAL_STATES,
  RESUBMITTABLE_STATES,
  type EndReason,
  type ListStateClass,
  type WorkloadTypeValue,
} from '../../../shared/workload.js';
import { ImageRuntime } from '../../../shared/image.js';
import {
  launchFailureDisposition,
  type ProvisioningFailure,
} from '../provisioning-failure.js';
import {
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
} from '../../../shared/workload-list.js';
import { type DbVM, resolveGatewayVM } from '../entities.js';
import { decryptSecret } from '../secret-crypto.js';
import {
  assertSpecOwnership,
  decodeContainerSpec,
  decodePublicContainerSpec,
  type EncodedContainerSpec,
  type PublicContainerSpec,
} from '../container-spec.js';
import {
  normalizeBucketHostPaths,
  type BucketHostPaths,
} from '../../../shared/providers.js';
import {
  ownershipBranches,
  ownershipPredicate,
  type OwnershipIdentity,
  type OwnershipScope,
} from './ownership-filter.js';
import { latestEventMessage } from '../workload-event-metadata.js';
import { cleanupNeededSql } from './workload-outcomes.js';
import type { VMRow } from './provisioning-attempts.js';
import type { WorkloadEventRow } from './workload-events.js';
import {
  retryCandidatesQuery,
  type RetryCandidate,
} from './retry-candidates.js';

export function parseStringOrArray(v: string | null): string | string[] | null {
  if (v === null) return null;
  if (v.startsWith('[')) {
    try {
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed)) return parsed as string[];
    } catch {
      // fall through to scalar
    }
  }
  return v;
}

function parseScalarCredentialId(v: string | null): string | null {
  if (!v) return null;
  if (v.startsWith('[')) {
    try {
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed)) return null;
    } catch {
      // fall through to scalar
    }
  }
  return v;
}

// Narrow the raw TEXT column to the StoredWorkload.imageRuntime enum.
// Any value outside the three known literals (incl. NULL / corrupt rows) maps to
// null — the conservative keep-all signal the optimizer treats as "don't filter".
function parseImageRuntime(v: string | null): ImageRuntime | null {
  if (
    v === ImageRuntime.Cuda ||
    v === ImageRuntime.Rocm ||
    v === ImageRuntime.Unknown
  ) {
    return v;
  }
  return null;
}

/**
 * Scheduling identity for fair queueing: one workstream of one tenant inside
 * one pool of contended capacity, joined by unit separators so the tuple stays
 * one scalar key.
 *
 * The tenant term is load-bearing — a hosted API shares its credentials across
 * members, so the credential alone cannot separate two callers. The capacity term
 * is the compute credential the attempt draws on. The session term makes each agent
 * session a full lane of its own: two sessions launching into one credential
 * hold two window shares by design. The cost, accepted deliberately, is that a
 * tenant with more queued session-lanes than the window has slots can crowd
 * other lanes out of the window until its backlog drains. Sessionless
 * submissions share one lane, and the type term keeps an interactive vm from
 * queueing behind its own session's batch jobs. Fairness lands per lane rather
 * than per tenant; the listQueued lane tests pin what that means.
 */
function laneKeySql(alias: string): string {
  return `(
    COALESCE(${alias}.owner_user_id, LOWER(${alias}.user_id))
    || char(31)
    || COALESCE(${alias}.credential_id, '')
    || char(31)
    || COALESCE(${alias}.session, '')
    || char(31)
    || ${alias}.workload_type
  )`;
}

/** Cloud provider, for hydrated workload reads. */
function workloadOriginColumnsSql(workloadAlias: string): string {
  return `${computedWorkloadCloudProviderSql(workloadAlias)} AS computed_cloud_provider`;
}

function computedVmCloudProviderSql(
  vmAlias: string,
  workloadAlias: string,
): string {
  return `COALESCE(
    (
      SELECT c.cloud_provider
      FROM credentials c
      WHERE c.id = ${vmAlias}.credential_id
      LIMIT 1
    ),
    ${workloadAlias}.requested_compute_provider,
    (
      SELECT c.cloud_provider
      FROM credentials c
      WHERE c.id = ${scalarCredentialSql(`${workloadAlias}.credential_id`)}
      LIMIT 1
    )
  )`;
}

function bucketHostPathsFromRow(
  row: Pick<
    VMRow,
    'input_host_path' | 'output_host_path' | 'checkpoint_host_path'
  >,
): BucketHostPaths {
  return normalizeBucketHostPaths({
    input: row.input_host_path ?? undefined,
    output: row.output_host_path ?? undefined,
    checkpoint: row.checkpoint_host_path ?? undefined,
  });
}

type DbVMRow = Pick<
  VMRow,
  | 'ip'
  | 'cloud_id'
  | 'private_ip'
  | 'base_image_id'
  | 'availability_zone'
  | 'created_at'
  | 'ended_at'
  | 'preempt'
  | 'region'
  | 'credential_id'
  | 'ssh_host'
  | 'ssh_port'
  | 'ssh_username'
  | 'vm_type'
  | 'cloud_provider'
  | 'input_host_path'
  | 'output_host_path'
  | 'checkpoint_host_path'
>;

function dbVmProjectionSql(vmAlias: string, workloadAlias: string): string {
  return `${vmAlias}.ip, ${vmAlias}.cloud_id, ${vmAlias}.private_ip,
          ${vmAlias}.base_image_id, ${vmAlias}.availability_zone,
          ${vmAlias}.created_at, ${vmAlias}.ended_at, ${vmAlias}.preempt,
          ${vmAlias}.region, ${vmAlias}.credential_id, ${vmAlias}.ssh_host,
          ${vmAlias}.ssh_port, ${vmAlias}.ssh_username, ${vmAlias}.vm_type,
          ${vmAlias}.input_host_path, ${vmAlias}.output_host_path,
          ${vmAlias}.checkpoint_host_path,
          ${computedVmCloudProviderSql(vmAlias, workloadAlias)} AS cloud_provider`;
}

/** Hydrate persisted provider facts into the complete VM used by operations. */
function rowToDbVM(row: DbVMRow): DbVM {
  if (row.ip === null) {
    throw new Error('Cannot hydrate a VM without an IP address');
  }
  const paths = bucketHostPathsFromRow(row);
  const vm = resolveGatewayVM({
    ip: row.ip,
    cloudId: row.cloud_id,
    privateIp: row.private_ip ?? undefined,
    baseImageId: row.base_image_id ?? undefined,
    availabilityZone: row.availability_zone ?? undefined,
    createdAt: row.created_at,
    region: row.region ?? undefined,
    sshHost: row.ssh_host ?? undefined,
    sshPort: row.ssh_port ?? undefined,
    sshUsername: row.ssh_username ?? undefined,
  });
  return {
    ...vm,
    createdAt: row.created_at,
    endedAt: row.ended_at,
    preempt: row.preempt,
    credentialId: row.credential_id ?? undefined,
    cloudProvider: row.cloud_provider ?? undefined,
    ...(row.vm_type !== null && { vmType: row.vm_type }),
    inputHostPath: paths.input,
    outputHostPath: paths.output,
    checkpointHostPath: paths.checkpoint,
  };
}

/**
 * VM aggregate columns (vm_count, vm_duration_ms, awaiting_release_ms,
 * total_cost, cost_source) for queries that
 * `LEFT JOIN vms v ON d.id = v.workload_id … GROUP BY d.id`.
 * `awaiting_release_ms` is the slice of vm_duration_ms that fell after teardown
 * was requested — reported alongside the total, never subtracted from it, since
 * the provider bills the customer's own account for that time.
 * `nowMs` caps accrual for live VMs (`COALESCE(v.ended_at, nowMs)`).
 * Failed-provisioning placeholders (ip IS NULL) are excluded from duration and
 * cost.
 */
export function vmAggregateColumnsSql(nowMs: number): string {
  // Starts at the request or at creation, whichever is later, so the reported
  // wait can never exceed the row's own lifetime. Workload rows cannot reach
  // that state today — the two paths that reopen an attempt clear the stamp,
  // and owner-exclusive rows keep node pool attempts out of this join — so treat
  // it as an invariant rather than a live case.
  const awaitingStart = `(CASE
    WHEN v.removal_requested_at > v.created_at THEN v.removal_requested_at
    ELSE v.created_at
  END)`;
  return `SUM(CASE WHEN v.ip IS NOT NULL AND v.ended_at IS NULL THEN 1 ELSE 0 END) as vm_count,
    SUM(CASE WHEN v.ip IS NOT NULL THEN COALESCE(v.ended_at, ${nowMs}) - v.created_at ELSE 0 END) as vm_duration_ms,
    SUM(CASE
      WHEN v.ip IS NOT NULL AND v.removal_requested_at IS NOT NULL
        AND COALESCE(v.ended_at, ${nowMs}) > ${awaitingStart}
        THEN COALESCE(v.ended_at, ${nowMs}) - ${awaitingStart}
      ELSE 0
    END) as awaiting_release_ms,
    SUM(CASE
      WHEN v.ip IS NOT NULL AND v.cost IS NOT NULL THEN v.cost
      WHEN v.ip IS NOT NULL AND v.price_per_hour IS NOT NULL
        THEN v.price_per_hour * (COALESCE(v.ended_at, ${nowMs}) - v.created_at) / 3600000.0
      ELSE 0
    END) as total_cost,
    CASE WHEN SUM(CASE
        WHEN v.ip IS NOT NULL AND v.price_per_hour IS NOT NULL AND v.cost IS NULL THEN 1
        ELSE 0
      END) = 0 THEN 'actual' ELSE 'estimated' END as cost_source`;
}

export interface WorkloadAttributionFilter {
  session?: string | null;
  sessionExact?: boolean;
  agent?: string | null;
  user?: string | null;
}

export function workloadAttributionFiltersSql(
  workloadAlias: string,
  filter?: WorkloadAttributionFilter,
): { clauses: string[]; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter?.session && filter.sessionExact) {
    // Auto-scoped reads know the complete session id. Exact matching prevents
    // prefix-colliding agents from seeing one another's workloads.
    clauses.push(`${workloadAlias}.session = ?`);
    params.push(filter.session);
  } else if (filter?.session) {
    // Typed --session accepts every form rendered by the CLI: exact id,
    // literal id prefix, label, or `<agent>:<prefix>`.
    const arms = [
      `${workloadAlias}.session = ?`,
      `substr(${workloadAlias}.session, 1, ?) = ?`,
      `${workloadAlias}.session_label = ?`,
    ];
    const sessionParams: unknown[] = [
      filter.session,
      filter.session.length,
      filter.session,
      filter.session,
    ];
    const display = /^([^:]+):(.+)$/.exec(filter.session);
    if (display) {
      const [, agentPart, prefixPart] = display;
      arms.push(
        `(${workloadAlias}.agent = ? AND substr(${workloadAlias}.session, 1, ?) = ?)`,
      );
      sessionParams.push(agentPart, prefixPart.length, prefixPart);
    }
    clauses.push(`(${arms.join(' OR ')})`);
    params.push(...sessionParams);
  }
  if (filter?.agent) {
    clauses.push(`${workloadAlias}.agent = ?`);
    params.push(filter.agent);
  }
  if (filter?.user) {
    // Accept the captured username or the immutable account id. `user_id` is
    // written once at submit time and never rewritten, so a renamed person's
    // older rows are only reachable by id.
    clauses.push(
      `(${workloadAlias}.user_id = ? COLLATE NOCASE` +
        ` OR ${workloadAlias}.owner_user_id = ?)`,
    );
    params.push(filter.user, filter.user);
  }
  return { clauses, params };
}

// Row type for workloads table (snake_case matches SQLite columns)
export interface WorkloadRow {
  id: string;
  user_id: string;
  owner_user_id: string | null;
  workload_type: WorkloadTypeValue;
  computed_cloud_provider?: CloudType | null;
  region: string | null;
  vm_type: string | null;
  gpu_type: string | null;
  spot: number; // SQLite stores boolean as 0/1
  state: WorkloadState;
  started_at: number;
  submitted_at: number | null;
  completed_at: number | null; // Terminal outcome timestamp
  cleaned_at: number | null; // T3 provider teardown confirmation timestamp
  cleanup_error: string | null; // Why the last cleanup attempt failed (0129); null once cleaned
  end_reason: EndReason | null; // Why it ended (0156); null before its terminal state or if unrecorded
  last_attempt_end_reason: EndReason | null; // With retries-exhausted: what ended the final attempt
  max_retries: number | null; // A Job's --max-retries (0161)
  no_checkpoint: number; // A VM Job's --no-checkpoint (0166)
  require_nested_virtualization: number; // A VM Job's KVM (0166)
  host_docker: number; // A VM Job's --host-docker (0167)
  disk_iops: number | null; // A VM Job's own root IOPS (0168)
  disk_throughput_mibps: number | null; // ... and MiB/s (0168)
  regions: string | null; // A VM Job's --regions, JSON string[] (0169)
  docker_command: string;
  input_bucket: string | null;
  output_bucket: string | null;
  checkpoint_bucket: string | null;
  disk_size_gb: number | null;
  disk_tier: string | null;
  availability_zone: string | null;
  vm_count?: number; // Computed by the vms-aggregate JOIN (getWorkload/listWorkloads/cost queries)
  vm_duration_ms?: number; // Computed by the vms-aggregate JOIN — total VM compute time
  // Computed by the vms-aggregate JOIN — the slice of vm_duration_ms that fell
  // after teardown was requested. Reported, never subtracted: the provider
  // bills the customer's own account for it.
  awaiting_release_ms?: number;
  total_cost?: number; // Computed by the vms-aggregate JOIN — SUM(v.cost OR price*duration fallback)
  cost_source?: 'actual' | 'estimated'; // Computed by the vms-aggregate JOIN — 'actual' iff no priced VM (live or ended) is still awaiting its billing-reconciled v.cost
  preempted_vm_count?: number; // Computed by listTerminalWorkloadsByDateRange — count of VMs with preempt = 1
  latest_event_metadata?: string | null; // Computed by listWorkloads — JSON string of the most recent event's metadata, used to surface block reasons
  ssh_private_key: string;
  // Nullable scalar credential id. NULL is reserved for credentialless compute.
  credential_id: string | null;
  // Explicit credentialless compute provider selection (Local).
  // NULL means the normal credential-derived provider identity applies.
  requested_compute_provider: CloudType | null;
  input_storage_credential_id: string | null;
  input_storage_region: string | null;
  output_storage_credential_id: string | null;
  output_storage_region: string | null;
  checkpoint_storage_credential_id: string | null;
  checkpoint_storage_region: string | null;
  image_runtime: string | null; // 'cuda'|'rocm'|'unknown' (migration 0066). Raw TEXT; narrowed on read. Insert-only.
  dns_record_id: string | null;
  secret_names: string | null; // JSON string[] in DB
  // Caller-supplied attribution (migration 0047). Insert-only, never mutated.
  session: string | null;
  agent: string | null;
  session_label: string | null; // Human-readable display label (migration 0052). Insert-only.
}

// A legacy ledger row without a VM type falls back to the Workload's first.
const FIRST_WORKLOAD_VM_TYPE_SQL = `CASE
  WHEN json_valid(d.vm_type) AND json_type(d.vm_type) = 'array'
  THEN json_extract(d.vm_type, '$[0]') ELSE d.vm_type END`;
const PUBLIC_WORKLOAD_COLUMNS = `d.id, d.user_id, d.owner_user_id, d.workload_type, d.region, d.vm_type, d.gpu_type, d.spot, d.state, d.started_at, d.submitted_at, d.completed_at, d.cleaned_at, d.cleanup_error, d.end_reason, d.last_attempt_end_reason, d.max_retries, d.no_checkpoint, d.require_nested_virtualization, d.host_docker, d.docker_command, d.input_bucket, d.output_bucket, d.checkpoint_bucket, d.disk_size_gb, d.disk_tier, d.disk_iops, d.disk_throughput_mibps, d.regions, d.availability_zone, d.credential_id, d.requested_compute_provider, d.input_storage_credential_id, d.input_storage_region, d.output_storage_credential_id, d.output_storage_region, d.checkpoint_storage_credential_id, d.checkpoint_storage_region, d.image_runtime, d.dns_record_id, d.secret_names, d.session, d.agent, d.session_label`;

/** The LEFT JOIN deliberately exposes missing children instead of hiding owners. */
interface HydratedWorkloadRow
  extends WorkloadRow,
    Omit<EncodedContainerSpec, 'image' | 'registry_username'> {
  container_spec_owner_id: string | null;
  image: string | null;
  registry_username: string | null;
}

type PublicWorkloadRow = Omit<WorkloadRow, 'ssh_private_key'> &
  Pick<
    HydratedWorkloadRow,
    | 'container_spec_owner_id'
    | 'image'
    | 'image_digest'
    | 'command'
    | 'docker_options'
  >;

function containerSpecColumnsSql(): string {
  return `${publicContainerSpecColumnsSql()}, s.env, s.registry_username, s.registry_token`;
}

function publicContainerSpecColumnsSql(): string {
  return `s.workload_id AS container_spec_owner_id,
    s.image, s.image_digest, s.command, s.docker_options`;
}

/** The secret-free projection a list row carries; the list SQL never selects these. */
type PublicWorkload = Omit<
  StoredWorkload,
  'env' | 'githubToken' | 'registryUsername' | 'sshPrivateKey'
>;

export type ListedWorkload = PublicWorkload & {
  /** Request-relative metadata; absent for internal callers with no viewer. */
  isOwnedByCaller?: boolean;
};

function workloadRowIsOwnedBy(
  row: Pick<WorkloadRow, 'owner_user_id' | 'user_id'>,
  viewer: OwnershipIdentity,
): boolean {
  return row.owner_user_id
    ? row.owner_user_id === viewer.id
    : row.user_id.toLowerCase() === viewer.username.toLowerCase();
}

function toListedWorkloads(
  rows: PublicWorkloadRow[],
  viewer?: OwnershipIdentity,
): ListedWorkload[] {
  return rows.map((row) => {
    assertSpecOwnership(row);
    let spec: PublicContainerSpec | null = null;
    if (row.container_spec_owner_id !== null) {
      if (row.image === null)
        throw new Error(`Workload ${row.id}: container spec is incomplete`);
      spec = decodePublicContainerSpec(
        { ...row, image: row.image },
        `Workload ${row.id}`,
      );
    }
    return {
      ...workloadFromRow(row, spec),
      ...(viewer ? { isOwnedByCaller: workloadRowIsOwnedBy(row, viewer) } : {}),
    };
  });
}

const PROVISIONING_PIPELINE_STATES = [
  WorkloadState.Provisioning,
  WorkloadState.Initializing,
  WorkloadState.Downloading,
  WorkloadState.Starting,
  WorkloadState.Syncing,
];

/**
 * Lightweight durable facts used to reconstruct the process-local workload
 * reconciliation schedule. Heavy workload config, credentials, and event
 * metadata are loaded only for the bounded set of work that actually runs.
 */
export interface WorkloadReconcileCandidate {
  id: string;
  state: WorkloadState;
  workloadType: WorkloadTypeValue;
  spot: boolean;
  revision: number;
  latestEventAt: number | null;
  completedAt: number | null;
}

interface WorkloadReconcileCandidateRow {
  id: string;
  state: WorkloadState;
  workload_type: WorkloadTypeValue;
  spot: number;
  revision: number | null;
  latest_event_at: number | null;
  completed_at: number | null;
}

function toWorkloadReconcileCandidate(
  row: WorkloadReconcileCandidateRow,
): WorkloadReconcileCandidate {
  return {
    id: row.id,
    state: row.state,
    workloadType: row.workload_type,
    spot: row.spot === 1,
    revision: row.revision ?? 0,
    latestEventAt: row.latest_event_at,
    completedAt: row.completed_at,
  };
}

export class WorkloadQueryStore {
  constructor(private readonly db: DB) {}

  /** User-facing reads that must not wait behind queued reconciler writes. */
  private readRows<T>(sql: string, params: unknown[]): Promise<T[]> {
    return this.db.read((reader) => reader.query<T>(sql, params));
  }

  /**
   * Get workload by ID
   */
  async getWorkload(workloadId: string): Promise<StoredWorkload | null> {
    const rows = await this.db.query<HydratedWorkloadRow>(
      `SELECT d.*, ${containerSpecColumnsSql()}, ${workloadOriginColumnsSql('d')},
        ${vmAggregateColumnsSql(Date.now())}
       FROM workloads d
       LEFT JOIN container_specs s ON s.workload_id = d.id
       LEFT JOIN vms v ON d.id = v.workload_id
       WHERE d.id = ?
       GROUP BY d.id`,
      [workloadId],
    );
    return rows[0] ? await toStoredWorkload(rows[0]) : null;
  }

  /** Authenticated lookup that does not reveal cross-user workload ids. */
  async getWorkloadForScope(
    workloadId: string,
    scope: OwnershipScope,
  ): Promise<StoredWorkload | null> {
    const owner = ownershipPredicate(scope, 'd');
    const rows = await this.db.query<HydratedWorkloadRow>(
      `SELECT d.*, ${containerSpecColumnsSql()}, ${workloadOriginColumnsSql('d')},
        ${vmAggregateColumnsSql(Date.now())}
       FROM workloads d
       LEFT JOIN container_specs s ON s.workload_id = d.id
       LEFT JOIN vms v ON d.id = v.workload_id
       WHERE d.id = ? AND ${owner.sql}
       GROUP BY d.id`,
      [workloadId, ...owner.params],
    );
    return rows[0] ? await toStoredWorkload(rows[0]) : null;
  }

  /**
   * Read authorized status from one snapshot.
   * `eventsLimit` keeps the most recent events (chronological order); `null`
   * returns the whole history. `eventsTotal` counts every event either way.
   */
  async getWorkloadStatusForScope(
    workloadId: string,
    scope: OwnershipScope,
    eventsLimit: number | null = null,
  ): Promise<{
    workload: StoredWorkload;
    events: WorkloadEventRow[];
    eventsTotal: number;
    retry: RetryCandidate | null;
  } | null> {
    const owner = ownershipPredicate(scope, 'd');
    const now = Date.now();
    const snapshot = await this.db.read((tx) => {
      const workload = tx.query<HydratedWorkloadRow>(
        `SELECT d.*, ${containerSpecColumnsSql()}, ${workloadOriginColumnsSql('d')},
          ${vmAggregateColumnsSql(now)}
         FROM workloads d
         LEFT JOIN container_specs s ON s.workload_id = d.id
         LEFT JOIN vms v ON d.id = v.workload_id
         WHERE d.id = ? AND ${owner.sql}
         GROUP BY d.id`,
        [workloadId, ...owner.params],
      )[0];
      if (!workload) return null;

      // Newest-first with a LIMIT walks idx_events_workload backwards and stops
      // (-1 = no limit); the tail is put back into chronological order.
      const events = tx
        .query<WorkloadEventRow>(
          `SELECT * FROM workload_events WHERE workload_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
          [workloadId, eventsLimit ?? -1],
        )
        .reverse();
      const eventsTotal =
        tx.query<{ count: number }>(
          `SELECT COUNT(*) AS count FROM workload_events WHERE workload_id = ?`,
          [workloadId],
        )[0]?.count ?? events.length;
      let retry: RetryCandidate | null = null;
      // The VM-host reconciler follows this backoff window.
      if (workload.state === WorkloadState.Retrying) {
        const { sql, params } = retryCandidatesQuery([workloadId]);
        retry = tx.query<RetryCandidate>(sql, params)[0] ?? null;
      }
      return { workload, events, eventsTotal, retry };
    });
    if (!snapshot) return null;
    return { ...snapshot, workload: await toStoredWorkload(snapshot.workload) };
  }

  /**
   * List user's workloads with active VM count, newest first.
   * @param limit - Positive row cap, bounded by MAX_LIST_LIMIT upstream.
   * @param filter - Optional server-side filters. `sinceMs` applies a
   *   `started_at >= sinceMs` window.
   *   `session`/`agent` match; `status` (exact state), `credentialId` (selected
   *   workload credential or actual VM credential), `stateClass` (picker
   *   set), `workloadType` (job/service/vm), and `search` (literal substring across id/type/image/cloud/
   *   region/state/session/agent) narrow the set.
   *   Null/undefined fields are skipped. `limitExplicit` distinguishes a
   *   caller-specified `-n`/`limit` (honored as a hard cap, active rows
   *   included) from the server's own default page size (active rows get a
   *   much higher MAX_LIST_LIMIT ceiling instead, since nobody asked for a
   *   small page — see the Newest-N branch below).
   */
  async listWorkloads(
    scope: OwnershipScope,
    limit: number = DEFAULT_LIST_LIMIT,
    filter?: {
      session?: string | null;
      sessionExact?: boolean;
      agent?: string | null;
      sinceMs?: number;
      stateClass?: ListStateClass;
      status?: WorkloadState;
      workloadType?: WorkloadTypeValue;
      credentialId?: string;
      search?: string;
      user?: string;
      limitExplicit?: boolean;
    },
    viewer?: OwnershipIdentity,
  ): Promise<ListedWorkload[]> {
    const nowMs = Date.now();
    const terminatable = filter?.stateClass === 'terminatable';
    const { clauses: extraFilters, params: filterParams } =
      workloadAttributionFiltersSql('d', filter);
    if (filter?.status) {
      extraFilters.push('d.state = ?');
      filterParams.push(filter.status);
    }
    if (filter?.workloadType) {
      extraFilters.push('d.workload_type = ?');
      filterParams.push(filter.workloadType);
    }
    if (filter?.credentialId) {
      // Pinned: stale stats once rescanned a credential's VMs per workload.
      extraFilters.push(
        `(d.credential_id = ? OR EXISTS (SELECT 1 FROM vms vc INDEXED BY ` +
          `idx_vms_workload_id WHERE vc.workload_id = d.id AND vc.credential_id = ?))`,
      );
      filterParams.push(filter.credentialId, filter.credentialId);
    }
    if (filter?.stateClass === 'resubmittable') {
      extraFilters.push(
        `(d.state IN (${RESUBMITTABLE_STATES.map(() => '?').join(', ')}) ` +
          `AND d.cleaned_at IS NOT NULL AND NOT EXISTS (` +
          `SELECT 1 FROM vms v2 WHERE v2.workload_id = d.id ` +
          `AND v2.ended_at IS NULL) AND d.workload_type <> ?)`,
      );
      filterParams.push(...RESUBMITTABLE_STATES, WorkloadType.Vm);
    } else if (filter?.stateClass === 'terminatable') {
      // Active workloads can be terminated; terminal workloads remain
      // actionable only until their workload-scoped cleanup completes.
      const active = ACTIVE_STATES.map(() => '?').join(', ');
      const terminal = TERMINAL_STATES.map(() => '?').join(', ');
      extraFilters.push(
        `(d.state IN (${active}) OR (` +
          `d.state IN (${terminal}) AND d.cleaned_at IS NULL))`,
      );
      filterParams.push(...ACTIVE_STATES, ...TERMINAL_STATES);
    }
    if (filter?.search) {
      // Literal substring across the columns the CLI used to match
      // client-side. Escape LIKE metacharacters so user text can't act as a
      // pattern (e.g. `%` matching everything).
      const escaped = filter.search.replace(/[\\%_]/g, (c) => `\\${c}`);
      const like = `%${escaped}%`;
      const cols = [
        'd.id',
        'd.workload_type',
        's.image',
        computedWorkloadCloudProviderSql('d'),
        'd.region',
        'd.state',
        'd.session',
        'd.session_label',
        'd.agent',
      ];
      extraFilters.push(
        `(${cols.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')})`,
      );
      filterParams.push(...cols.map(() => like));
    }
    const sinceMs =
      typeof filter?.sinceMs === 'number' ? filter.sinceMs : undefined;
    const joinFilter = (extra?: string) =>
      [extra, ...extraFilters].filter(Boolean).join(' AND ') || undefined;

    // Two-phase: bound the workload set in a derived table FIRST (filter +
    // order + limit), then LEFT JOIN vms / aggregate / run the correlated
    // subqueries over only that set. The old shape joined vms and ran both
    // correlated subqueries across the user's whole history and applied LIMIT
    // last, so a deep account paid the full join + per-row subquery cost before
    // trimming. Result-equivalent: same workloads, same aggregates — only the
    // order of operations changes. `started_at DESC, id DESC` pins the LIMIT
    // boundary deterministically (started_at alone left ties undefined).
    //
    // Gate aggregates on v.ip IS NOT NULL so failed-provisioning rows
    // (cloud_id set, ended_at NULL, no IP) don't show up as "live VMs" in
    // `anycloud list`, accrue billable time in `anycloud cost`, or contribute
    // to total_cost. Matches the ip-bearing definition used by workload
    // reconciliation and by getVMs after the cloud-confirms-delete refactor.
    const ownerBranches = ownershipBranches(scope, 'd');
    const buildQuery = (ownerWhere: string, extraWhere?: string) => {
      const combined = joinFilter(extraWhere);
      return `
      SELECT d.*,
        ${workloadOriginColumnsSql('d')},
        ${vmAggregateColumnsSql(nowMs)},
        (SELECT metadata FROM workload_events
         WHERE workload_id = d.id
         ORDER BY created_at DESC, id DESC LIMIT 1) as latest_event_metadata
      FROM (
        SELECT ${PUBLIC_WORKLOAD_COLUMNS}, ${publicContainerSpecColumnsSql()}
        FROM workloads d
        LEFT JOIN container_specs s ON s.workload_id = d.id
        WHERE ${ownerWhere}${combined ? ` AND ${combined}` : ''}
        ORDER BY d.started_at DESC, d.id DESC LIMIT ?
      ) d
      LEFT JOIN vms v ON d.id = v.workload_id
      GROUP BY d.id
      ORDER BY d.started_at DESC, d.id DESC`;
    };

    const queryOwned = async (
      extraWhere: string | undefined,
      extraParams: unknown[],
      cap: number,
    ): Promise<PublicWorkloadRow[]> => {
      const rowSets = await Promise.all(
        ownerBranches.map((owner) =>
          this.readRows<PublicWorkloadRow>(buildQuery(owner.sql, extraWhere), [
            ...owner.params,
            ...extraParams,
            ...filterParams,
            cap,
          ]),
        ),
      );
      return rowSets
        .flat()
        .sort(
          (a, b) =>
            b.started_at - a.started_at ||
            (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
        )
        .slice(0, cap);
    };

    if (terminatable) {
      // The generic Newest-N shape is workload-history driven because it must
      // satisfy user/order/limit semantics. For the picker, discover the two
      // bounded actionable sets through their dedicated indexes first, apply
      // the remaining filters and Newest-N active-first cap (period windows
      // remain globally newest-first), and only then hydrate the expensive
      // VM/event projections.
      const selectedFilters = [
        sinceMs !== undefined ? 'd.started_at >= ?' : undefined,
        ...extraFilters,
      ].filter((clause): clause is string => clause !== undefined);
      const active = ACTIVE_STATES.map(() => '?').join(', ');
      // Each ownership branch contributes an active leg and a cleanup-pending
      // leg. The active leg takes no hint and lets SQLite reach for
      // idx_workloads_state_started; the pending index serves every branch.
      const activeBranches = ownershipBranches(scope, 'active');
      const pendingBranches = ownershipBranches(scope, 'pending');
      const terminatableLegs = activeBranches.flatMap((activeBranch, i) => {
        const pendingBranch = pendingBranches[i];
        return [
          {
            sql: `SELECT active.id, 0
           FROM workloads AS active
           WHERE ${activeBranch.sql}
             AND active.state IN (${active})`,
            params: [...activeBranch.params, ...ACTIVE_STATES],
          },
          {
            sql: `SELECT pending.id, 1
           FROM workloads AS pending INDEXED BY idx_workloads_pending_cleanup
           WHERE ${pendingBranch.sql}
             AND ${cleanupNeededSql('pending')}`,
            params: [...pendingBranch.params, ...TERMINAL_STATES],
          },
        ];
      });
      const rows = await this.readRows<PublicWorkloadRow>(
        `WITH terminatable_ids(id, priority) AS (
           ${terminatableLegs.map((leg) => leg.sql).join('\n           UNION ALL\n           ')}
         ),
         selected_workloads AS (
           SELECT ${PUBLIC_WORKLOAD_COLUMNS}, ${publicContainerSpecColumnsSql()}
           FROM terminatable_ids candidate
           JOIN workloads d ON d.id = candidate.id
           LEFT JOIN container_specs s ON s.workload_id = d.id
           ${selectedFilters.length > 0 ? `WHERE ${selectedFilters.join(' AND ')}` : ''}
           ORDER BY ${
             sinceMs === undefined ? 'candidate.priority ASC, ' : ''
           }d.started_at DESC, d.id DESC
           LIMIT ?
         )
         SELECT selected.*,
           ${workloadOriginColumnsSql('selected')},
           ${vmAggregateColumnsSql(nowMs)},
           (SELECT metadata FROM workload_events
            WHERE workload_id = selected.id
            ORDER BY created_at DESC, id DESC LIMIT 1) as latest_event_metadata
         FROM selected_workloads selected
         LEFT JOIN vms v ON selected.id = v.workload_id
         GROUP BY selected.id
         ORDER BY selected.started_at DESC, selected.id DESC`,
        [
          ...terminatableLegs.flatMap((leg) => leg.params),
          ...(sinceMs !== undefined ? [sinceMs] : []),
          ...filterParams,
          limit,
        ],
      );
      return toListedWorkloads(rows, viewer);
    }

    let rows: PublicWorkloadRow[];
    if (sinceMs !== undefined) {
      // -p/--period window + -n/--limit cap (current clients).
      rows = await queryOwned('d.started_at >= ?', [sinceMs], limit);
    } else {
      // Newest-N: the default view and bare -n (current clients). A row in
      // ACTIVE_STATES is still billing, so it gets first claim on the
      // budget: it must never be evicted by a flood of newer,
      // already-finished workloads. Non-active rows fill whatever's left.
      // NOT IN (active) rather than a second hardcoded TERMINAL_STATES list
      // stays exhaustive by construction — a future state nobody's
      // classified yet still lands in the ordinary bounded arm instead of
      // silently vanishing from the page.
      //
      // The active arm's own cap depends on whether `limit` was the
      // caller's explicit ask or just the server's default page size. An
      // explicit -n/--status running -n 3 is a real request for "at most 3"
      // — respect it, active included, same as the terminal side. The
      // default view is different: nobody asked for "at most 200," so an
      // active-heavy account (e.g. a 200+-node training fleet) still must
      // not have older-but-still-running workloads silently dropped —
      // give the active side real headroom (MAX_LIST_LIMIT) instead.
      //
      // These queries are sequential because the second query's limit depends
      // on how many active rows the first query returns.
      const activePlaceholders = ACTIVE_STATES.map(() => '?').join(', ');
      const activeCap = filter?.limitExplicit ? limit : MAX_LIST_LIMIT;
      const activeRows = await queryOwned(
        `d.state IN (${activePlaceholders})`,
        [...ACTIVE_STATES],
        activeCap,
      );
      const remaining = Math.max(0, limit - activeRows.length);
      const otherRows = remaining
        ? await queryOwned(
            `d.state NOT IN (${activePlaceholders})`,
            [...ACTIVE_STATES],
            remaining,
          )
        : [];
      rows = [...activeRows, ...otherRows].sort(
        (a, b) =>
          b.started_at - a.started_at ||
          (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
      );
    }
    return toListedWorkloads(rows, viewer);
  }

  /**
   * Launch failures for one workload and attempted credential, oldest first,
   * read from the VM ledger: every classified attempt row, every unlaunched
   * one in a region where this credential has no healthy VM, and each
   * preempted VM once however often it restarted in place. Disposition is
   * derived from the diagnosis and the Workload's immutable pins.
   */
  async getProvisioningFailures(
    workloadId: string,
    credentialId: string | null,
    cloud: CloudType,
  ): Promise<ProvisioningFailure[]> {
    const rows = await this.db.query<
      Omit<ProvisioningFailure, 'disposition' | 'spot'> & {
        spot: number;
        pinnedRegion: string | null;
        pinnedZone: string | null;
        multi: number | null;
      }
    >(
      `WITH healthy_regions AS (
         SELECT v.region
         FROM vms v
         JOIN workloads d ON d.id = v.workload_id
         WHERE v.workload_id = ?
           AND COALESCE(v.credential_id, d.credential_id) IS ?
           AND v.region IS NOT NULL
         GROUP BY v.region
         HAVING SUM(v.ip IS NOT NULL AND COALESCE(v.preempt, 0) = 0) > 0
            AND SUM(COALESCE(v.preempt, 0) = 1) = 0
       )
       SELECT COALESCE(v.credential_id, d.credential_id) AS credentialId,
              COALESCE(v.vm_type, ${FIRST_WORKLOAD_VM_TYPE_SQL}) AS vmType,
              v.region AS region,
              v.availability_zone AS availabilityZone,
              v.launch_diagnosis AS diagnosis, d.spot AS spot,
              v.launch_region_denied AS regionDenied,
              d.region AS pinnedRegion, d.availability_zone AS pinnedZone,
              json_array_length(CASE WHEN json_valid(d.vm_type) THEN d.vm_type END) > 1 AS multi
       FROM vms v
       JOIN workloads d ON d.id = v.workload_id
       WHERE v.workload_id = ?
         AND COALESCE(v.credential_id, d.credential_id) IS ?
         AND v.region IS NOT NULL
         AND typeof(COALESCE(v.vm_type, ${FIRST_WORKLOAD_VM_TYPE_SQL})) = 'text'
         AND (
           v.launch_diagnosis IS NOT NULL
           OR (v.ip IS NULL
               AND v.region NOT IN (SELECT region FROM healthy_regions))
           OR (v.preempt = 1 AND NOT EXISTS (
             SELECT 1 FROM vms p
             WHERE p.workload_id = v.workload_id AND p.cloud_id = v.cloud_id
               AND p.preempt = 1 AND p.rowid < v.rowid
           ))
         )
       ORDER BY v.created_at, v.rowid`,
      [workloadId, credentialId, workloadId, credentialId],
    );
    return rows.map(({ pinnedRegion, pinnedZone, multi, spot, ...row }) => ({
      ...row,
      disposition:
        row.diagnosis === null
          ? null
          : launchFailureDisposition(
              row.diagnosis,
              cloud,
              pinnedRegion,
              pinnedZone,
              multi === 1 && !row.regionDenied,
              row.regionDenied !== null,
            ),
      spot: spot === 1,
    }));
  }

  /**
   * Get the resolved provisioning placement from the most recent attempt.
   * Used by monitors and loadWorkloadConfigs to determine the concrete
   * region (and later vmType, etc.) for workloads where the user omitted it.
   */
  async getLatestProvisioningConfig(
    workloadId: string,
  ): Promise<ProvisioningConfig | null> {
    const rows = await this.db.query<ProvisioningConfig>(
      `SELECT region,
              availability_zone AS availabilityZone,
              vm_type AS vmType,
              credential_id AS credentialId
       FROM vms
       WHERE workload_id = ?
       ORDER BY created_at DESC LIMIT 1`,
      [workloadId],
    );
    return rows[0] ?? null;
  }

  /**
   * List workload outcomes in the given `completed_at` outcome-timestamp
   * range. Cleanup completion is deliberately independent and never creates a
   * second outcome event, so each terminal row is reported exactly once at T1.
   *
   * Only outcome and spot-preemption data are projected (not on-demand stops). Daily spend is calculated
   * separately from VM lifetimes so `completed_at` cannot filter or cap it.
   *
   * Range is half-open [startMs, endMs).
   */
  async listTerminalWorkloadsByDateRange(
    startMs: number,
    endMs: number,
  ): Promise<
    Array<
      StoredWorkload & {
        wasPreempted: boolean;
        ownerUserId: string | null;
      }
    >
  > {
    const placeholders = TERMINAL_STATES.map(() => '?').join(', ');
    const rows = await this.db.query<HydratedWorkloadRow>(
      `SELECT d.*, ${containerSpecColumnsSql()},
        CASE WHEN d.spot = 1 AND EXISTS (
          SELECT 1
          FROM vms preempted
          WHERE preempted.workload_id = d.id
            AND preempted.preempt = 1
        ) THEN 1 ELSE 0 END AS preempted_vm_count
       FROM workloads d
       LEFT JOIN container_specs s ON s.workload_id = d.id
       WHERE d.state IN (${placeholders})
         AND d.completed_at >= ? AND d.completed_at < ?
       ORDER BY d.completed_at ASC`,
      [...TERMINAL_STATES, startMs, endMs],
    );
    const workloads = await Promise.all(rows.map(toStoredWorkload));
    return workloads.map((d, i) => ({
      ...d,
      wasPreempted: (rows[i].preempted_vm_count ?? 0) > 0,
      ownerUserId: rows[i].owner_user_id,
    }));
  }

  /**
   * Discover the live set owned by the process-local workload
   * reconciler. The query projects only scheduling facts:
   *
   * - state and workload kind for lane selection;
   * - the latest indexed event id/timestamp for revision and orphan timing.
   *
   * It never loads credentials, event metadata, or lifetime event history.
   * Cleanup-needed rows come from the partial cleaned_at index, so cleaned
   * terminal history never becomes a startup-sized result set. Return the
   * complete outstanding set: truncating this list can starve newer cleanup
   * forever when an older page is paused on invalid credentials. Provider
   * concurrency remains bounded by WorkloadReconciler.
   */
  async listWorkloadReconcileCandidates(): Promise<
    WorkloadReconcileCandidate[]
  > {
    const pipelineStates = [
      WorkloadState.Provisioning,
      WorkloadState.Initializing,
      WorkloadState.Downloading,
      WorkloadState.Syncing,
      WorkloadState.Starting,
      WorkloadState.Retrying,
      WorkloadState.Recovering,
      WorkloadState.Finalizing,
    ];
    const pipeline = pipelineStates.map(() => '?').join(', ');
    // The physical index name predates the cleanup-needed terminology. Keep it
    // until a follow-on migration can rename already-created indexes.
    const rows = await this.db.query<WorkloadReconcileCandidateRow>(
      `WITH candidate_ids AS (
         SELECT id
         FROM workloads INDEXED BY idx_workloads_state_started
         WHERE state IN (${pipeline})
         UNION
         SELECT id
         FROM workloads INDEXED BY idx_workloads_state_started
         WHERE state = ?
           AND (workload_type IN (?, ?) OR spot = 1
              OR (workload_type = ? AND ((checkpoint_storage_credential_id IS NOT NULL AND checkpoint_bucket IS NOT NULL)
                OR secret_names IS NOT NULL)))
         UNION
         SELECT id
         FROM workloads INDEXED BY idx_workloads_pending_cleanup
         WHERE ${cleanupNeededSql()}
       )
       SELECT d.id,
              d.state,
              d.workload_type,
              d.spot,
              d.completed_at,
              e.id AS revision,
              e.created_at AS latest_event_at
       FROM candidate_ids candidates
       JOIN workloads d ON d.id = candidates.id
       LEFT JOIN workload_events e ON e.id = (
         SELECT latest.id
         FROM workload_events latest INDEXED BY idx_events_workload_id
         WHERE latest.workload_id = d.id
         ORDER BY latest.id DESC
         LIMIT 1
       )
       ORDER BY d.started_at ASC, d.id ASC`,
      [
        ...pipelineStates,
        WorkloadState.Running,
        WorkloadType.Job,
        WorkloadType.Vm,
        WorkloadType.Service,
        ...TERMINAL_STATES,
      ],
    );
    return rows.map(toWorkloadReconcileCandidate);
  }

  /**
   * Re-read one candidate immediately before/after bounded external work.
   */
  async getWorkloadReconcileCandidate(
    workloadId: string,
  ): Promise<WorkloadReconcileCandidate | null> {
    const pipelineStates = [
      WorkloadState.Provisioning,
      WorkloadState.Initializing,
      WorkloadState.Downloading,
      WorkloadState.Syncing,
      WorkloadState.Starting,
      WorkloadState.Retrying,
      WorkloadState.Recovering,
      WorkloadState.Finalizing,
    ];
    const pipeline = pipelineStates.map(() => '?').join(', ');
    const rows = await this.db.query<WorkloadReconcileCandidateRow>(
      `SELECT d.id,
              d.state,
              d.workload_type,
              d.spot,
              d.completed_at,
              e.id AS revision,
              e.created_at AS latest_event_at
       FROM workloads d
       LEFT JOIN workload_events e ON e.id = (
         SELECT latest.id
         FROM workload_events latest INDEXED BY idx_events_workload_id
         WHERE latest.workload_id = d.id
         ORDER BY latest.id DESC
         LIMIT 1
       )
       WHERE d.id = ?
         AND (
           d.state IN (${pipeline})
           OR (
             d.state = ?
             AND (d.workload_type IN (?, ?) OR d.spot = 1
                OR (d.workload_type = ? AND ((d.checkpoint_storage_credential_id IS NOT NULL AND d.checkpoint_bucket IS NOT NULL)
                  OR d.secret_names IS NOT NULL)))
           )
           OR (
             ${cleanupNeededSql('d')}
           )
         )`,
      [
        workloadId,
        ...pipelineStates,
        WorkloadState.Running,
        WorkloadType.Job,
        WorkloadType.Vm,
        WorkloadType.Service,
        ...TERMINAL_STATES,
      ],
    );
    return rows[0] ? toWorkloadReconcileCandidate(rows[0]) : null;
  }

  /**
   * List queued workloads fairly across scheduling-identity lanes (see
   * `laneKeySql`). Each lane remains FIFO; lanes with less active provisioning
   * work are selected first.
   */
  async listQueued(limit: number): Promise<WorkloadRow[]> {
    const placeholders = PROVISIONING_PIPELINE_STATES.map(() => '?').join(', ');
    return this.db.query<WorkloadRow>(
      `WITH lane_load AS (
         SELECT ${laneKeySql('workloads')} AS lane_key, COUNT(*) AS active_count
         FROM workloads
         WHERE state IN (${placeholders})
         GROUP BY lane_key
       ),
       ranked AS (
         SELECT d.*,
                COALESCE(l.active_count, 0) AS lane_active_count,
                ROW_NUMBER() OVER (
                  PARTITION BY ${laneKeySql('d')}
                  ORDER BY d.started_at ASC, d.id ASC
                ) AS lane_position
         FROM workloads d
         LEFT JOIN lane_load l ON l.lane_key IS ${laneKeySql('d')}
         WHERE d.state = ?
       )
       SELECT * FROM ranked
       ORDER BY lane_active_count + lane_position ASC,
                started_at ASC,
                id ASC
       LIMIT ?`,
      [...PROVISIONING_PIPELINE_STATES, WorkloadState.Queued, limit],
    );
  }

  /**
   * Count workloads actively running through the provisioning pipeline
   */
  async countDeploying(): Promise<number> {
    const placeholders = PROVISIONING_PIPELINE_STATES.map(() => '?').join(', ');
    const rows = await this.db.query<{ count: number }>(
      `SELECT COUNT(*) as count
       FROM workloads d
       WHERE d.state IN (${placeholders})`,
      PROVISIONING_PIPELINE_STATES,
    );
    return rows[0]?.count ?? 0;
  }

  // =========================================================================
  // VM Management (replaces cloud.getAllVMs() calls)
  // =========================================================================

  /** Whether the cloud reclaimed the workload's newest VM (`preempt`). */
  async lastVmPreempted(workloadId: string): Promise<boolean> {
    const [row] = await this.db.query<{ preempt: number | null }>(
      'SELECT preempt FROM vms WHERE workload_id = ? ORDER BY rowid DESC LIMIT 1',
      [workloadId],
    );
    return row?.preempt === 1;
  }

  async getVMs(workloadId: string): Promise<DbVM[]> {
    // Excludes in-flight/failed provisioning rows (ip IS NULL): they carry a
    // cleanup target but no usable VM endpoint. Cleanup reads the complete
    // provisioning ledger through getProvisioningAttempts instead.
    const rows = await this.db.query<DbVMRow>(
      `SELECT ${dbVmProjectionSql('v', 'd')}
       FROM vms v
       JOIN workloads d ON d.id = v.workload_id
       WHERE v.workload_id = ? AND v.ended_at IS NULL AND v.ip IS NOT NULL`,
      [workloadId],
    );
    return rows.map(rowToDbVM);
  }

  /**
   * Like getVMs but returns both active and terminated VMs, in lifecycle
   * order. Used by /status to expose the full VM history for a workload so
   * callers can read per-VM provisioning metadata after cleanup.
   *
   * Still excludes failed-provisioning rows (ip IS NULL) for the same reason
   * getVMs does — those rows never represented a real VM the user would
   * recognize.
   */
  async listVms(
    workloadId: string,
    { readPath = false }: { readPath?: boolean } = {},
  ): Promise<DbVM[]> {
    const sql = `SELECT ${dbVmProjectionSql('v', 'd')}
       FROM vms v
       JOIN workloads d ON d.id = v.workload_id
       WHERE v.workload_id = ? AND v.ip IS NOT NULL
       ORDER BY v.created_at ASC, v.rowid ASC`;
    const rows = readPath
      ? await this.readRows<DbVMRow>(sql, [workloadId])
      : await this.db.query<DbVMRow>(sql, [workloadId]);
    return rows.map(rowToDbVM);
  }

  /**
   * VM Services and Jobs on their own VM that haven't ended: the hosted API
   * refuses to delete itself while any could still be serving.
   */
  async listLiveVmHostWorkloadIds(): Promise<string[]> {
    const rows = await this.db.query<{ id: string }>(
      `SELECT id FROM workloads
       WHERE state NOT IN (${TERMINAL_STATES.map(() => '?').join(', ')})
       ORDER BY id`,
      [...TERMINAL_STATES],
    );
    return rows.map((row) => row.id);
  }

  /**
   * Check if a workload exists in the workloads table
   */
  async workloadExists(workloadId: string): Promise<boolean> {
    const rows = await this.db.query<{ count: number }>(
      `SELECT COUNT(*) as count FROM workloads WHERE id = ?`,
      [workloadId],
    );
    return rows[0]?.count > 0;
  }

  /**
   * Resolve the credential id a workload is actually using for cloud ops: an
   * explicit override, else the most recent live VM's credential, else the
   * workload credential. Undefined for credentialless compute.
   */
  async resolveActiveCredentialId(
    workload: StoredWorkload,
    computeCredIdOverride?: string,
  ): Promise<string | undefined> {
    if (computeCredIdOverride !== undefined) return computeCredIdOverride;
    const liveVmCredentialId = (await this.getVMs(workload.id))
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .find((vm) => vm.credentialId)?.credentialId;
    return liveVmCredentialId ?? workload.credentialId ?? undefined;
  }
}

/**
 * Convert WorkloadRow (snake_case) to StoredWorkload (camelCase)
 */
async function toStoredWorkload(
  row: HydratedWorkloadRow,
): Promise<StoredWorkload> {
  assertSpecOwnership(row);
  assertRuntimeSpec(row);
  const spec = await decodeContainerSpec(row, `Workload ${row.id}`);
  return {
    ...workloadFromRow(row, spec),
    env: spec.env,
    githubToken: spec.registryToken,
    registryUsername: spec.registryUsername,
    sshPrivateKey: await decryptSecret(row.ssh_private_key),
  };
}

function assertRuntimeSpec(
  row: HydratedWorkloadRow,
): asserts row is HydratedWorkloadRow & EncodedContainerSpec {
  if (row.image === null || row.registry_username === null) {
    throw new Error(`Workload ${row.id}: container spec is incomplete`);
  }
}

function workloadFromRow(
  row: Omit<WorkloadRow, 'ssh_private_key'>,
  spec: PublicContainerSpec | null,
): PublicWorkload {
  return {
    id: row.id,
    userId: row.user_id,
    workloadType: row.workload_type,
    image: spec?.image ?? null,
    cloudProvider:
      row.computed_cloud_provider ?? row.requested_compute_provider ?? null,
    region: row.region,
    vmType: parseStringOrArray(row.vm_type),
    gpuType: parseStringOrArray(row.gpu_type),
    spot: row.spot === 1,
    state: row.state,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    cleanedAt: row.cleaned_at,
    cleanupError: row.cleanup_error,
    endReason: row.end_reason,
    lastAttemptEndReason: row.last_attempt_end_reason,
    maxRetries: row.max_retries,
    noCheckpoint: row.no_checkpoint === 1,
    requireNestedVirtualization: row.require_nested_virtualization === 1,
    hostDocker: row.host_docker === 1,
    dockerCommand: row.docker_command,
    inputBucket: row.input_bucket,
    outputBucket: row.output_bucket,
    checkpointBucket: row.checkpoint_bucket,
    diskSizeGb: row.disk_size_gb,
    diskTier: isDiskTier(row.disk_tier) ? row.disk_tier : null,
    diskIops: row.disk_iops,
    diskThroughputMibps: row.disk_throughput_mibps,
    regions: row.regions ? (JSON.parse(row.regions) as string[]) : null,
    dockerOptions: spec?.dockerOptions ?? null,
    availabilityZone: row.availability_zone,
    vmCount: row.vm_count ?? 0,
    credentialId: parseScalarCredentialId(row.credential_id),
    inputStorageCredentialId: row.input_storage_credential_id,
    inputStorageRegion: row.input_storage_region,
    outputStorageCredentialId: row.output_storage_credential_id,
    outputStorageRegion: row.output_storage_region,
    checkpointStorageCredentialId: row.checkpoint_storage_credential_id,
    checkpointStorageRegion: row.checkpoint_storage_region,
    command: spec?.command ?? null,
    imageDigest: spec?.imageDigest ?? null,
    imageRuntime: parseImageRuntime(row.image_runtime),
    vmDurationMs: row.vm_duration_ms ?? null,
    awaitingReleaseMs: row.awaiting_release_ms ?? null,
    totalCost: row.total_cost ?? null,
    costSource: row.cost_source ?? null,
    dnsRecordId: row.dns_record_id,
    secretNames: row.secret_names
      ? (JSON.parse(row.secret_names) as string[])
      : null,
    session: row.session,
    agent: row.agent,
    sessionLabel: row.session_label,
    latestMessage: latestEventMessage(row.latest_event_metadata),
  };
}

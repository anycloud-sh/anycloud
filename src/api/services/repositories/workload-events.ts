/** Workload event reads and the event writes made outside a state transition. */
import { CloudType } from '../../../shared/cloud.js';
import { WorkloadState } from '../../../shared/workload.js';
import { type ImagePullTelemetry } from '../../../shared/image.js';
import { log } from '../logger.js';
import {
  decodeWorkloadEventMetadata,
  eventMetadataColumn,
} from '../workload-event-metadata.js';
import type {
  ProvisioningIntent,
  WorkloadEvent,
  WorkloadEventState,
} from '../workload-record.js';
import type { DB } from './db.js';

// Row type for workload_events table (snake_case matches database columns)
export interface WorkloadEventRow {
  id: number;
  workload_id: string;
  state: WorkloadEventState;
  metadata: string | null; // JSON string in DB
  created_at: number;
}

export interface WorkloadEventMetadata {
  metadata: Record<string, unknown> | null;
  createdAt: number;
}

interface WorkloadEventMetadataRow {
  metadata: string | null;
  created_at: number;
}

function parseWorkloadEventMetadataRow(
  row: WorkloadEventMetadataRow | undefined,
): WorkloadEventMetadata | null {
  if (!row) return null;
  return {
    metadata: decodeWorkloadEventMetadata(row.metadata),
    createdAt: row.created_at,
  };
}

/**
 * Convert WorkloadEventRow (snake_case) to WorkloadEvent (camelCase).
 * All WorkloadEvent fields are non-optional so adding a new field causes
 * a compile error here until it is mapped.
 */
export function toWorkloadEvent(row: WorkloadEventRow): WorkloadEvent {
  return {
    id: row.id,
    workloadId: row.workload_id,
    state: row.state,
    metadata: decodeWorkloadEventMetadata(row.metadata),
    createdAt: row.created_at,
  };
}

export class WorkloadEventStore {
  constructor(private readonly db: DB) {}

  /**
   * Add structured telemetry to the exact event that claimed this pull attempt.
   * Binding by event ID prevents an older pull from overwriting a newer attempt.
   * Telemetry failures are logged and never fail the workload.
   */
  async setImagePullTelemetry(
    workloadId: string,
    eventId: number,
    value: ImagePullTelemetry | undefined,
  ): Promise<void> {
    if (!value) return;
    try {
      await this.db.query(
        `UPDATE workload_events
         SET metadata = json_set(
           CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END,
           '$.imagePull',
           json(?)
         )
         WHERE id = ? AND workload_id = ? AND state = ?`,
        [
          // Spread so the telemetry satisfies the metadata input shape; the
          // column helper is the one place this is redacted and stringified.
          eventMetadataColumn({ ...value }),
          eventId,
          workloadId,
          WorkloadState.Downloading,
        ],
      );
    } catch (error) {
      log.warn('Failed to persist workload step telemetry', {
        id: workloadId,
        state: WorkloadState.Downloading,
        error: error,
      });
    }
  }

  /** Attach best-effort teardown diagnostics to the current outcome event. */
  async updateTerminalDiagnostics(
    workloadId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    try {
      const updated = await this.db.query<{ rowsAffected: number }>(
        `UPDATE workload_events
         SET metadata = json_patch(
           CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END,
           json(?)
         )
         WHERE id = (
           SELECT e.id
           FROM workload_events e
           JOIN workloads d ON d.id = e.workload_id
           WHERE e.workload_id = ?
             AND e.state = d.state
             AND e.created_at = d.completed_at
             AND d.cleaned_at IS NULL
           ORDER BY e.id DESC
           LIMIT 1
         )`,
        [eventMetadataColumn(metadata), workloadId],
      );
      if (!updated[0]?.rowsAffected) {
        log.warn('Terminal cleanup diagnostics event not found', {
          id: workloadId,
        });
      }
    } catch (error) {
      log.warn('Failed to persist terminal cleanup diagnostics', {
        id: workloadId,
        error: error,
      });
    }
  }

  /**
   * Record a Queued event carrying a soft-block message (e.g. budget/throttle
   * cap exceeded). Dedup against the latest event so the scheduler can call
   * this every tick without spamming events — only the first tick under each
   * distinct reason appends. When the cap clears, the next dispatch
   * transitions to Provisioning, which supersedes the rendered message.
   */
  async recordQueuedBlockReason(
    workloadId: string,
    message: string,
  ): Promise<void> {
    await this.recordBlockReason(workloadId, WorkloadState.Queued, message);
  }

  /**
   * Refresh the human-readable reason a workload is waiting in `state`
   * without appending a duplicate event while the reason is unchanged.
   */
  async recordBlockReason(
    workloadId: string,
    state: WorkloadState.Queued | WorkloadState.Provisioning,
    message: string,
  ): Promise<void> {
    const latest = await this.db.query<{
      state: WorkloadState;
      metadata: string | null;
    }>(
      `SELECT state, metadata FROM workload_events
       WHERE workload_id = ?
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [workloadId],
    );
    const prev = latest[0];
    if (prev && prev.state === state && prev.metadata) {
      const parsed = decodeWorkloadEventMetadata(prev.metadata);
      if (parsed?.message === message) return;
    }
    // Only append while the workload is actually in that state. Cleanup
    // identifies its terminal outcome as the latest event, so a non-terminal
    // event landing after a terminal one would leave the workload permanently
    // unclaimable — and terminate could not re-trigger it either.
    await this.db.query(
      `INSERT INTO workload_events (workload_id, state, metadata, created_at)
       SELECT id, ?, ?, ? FROM workloads WHERE id = ? AND state = ?`,
      [
        state,
        // The reason embeds a caller-supplied agent-session id.
        eventMetadataColumn({ message }),
        Date.now(),
        workloadId,
        state,
      ],
    );
  }

  /**
   * When the workload entered its current run of `state`: the first event of
   * that state after the latest event of any other state. Block-reason
   * refreshes within the run do not move it. Null when it never entered it.
   */
  async getStateEnteredAt(
    workloadId: string,
    state: WorkloadState,
  ): Promise<number | null> {
    const rows = await this.db.query<{ entered_at: number | null }>(
      `SELECT MIN(e.created_at) AS entered_at FROM workload_events e
       WHERE e.workload_id = ? AND e.state = ?
         AND e.id > COALESCE((
           SELECT MAX(o.id) FROM workload_events o
           WHERE o.workload_id = ? AND o.state <> ?
         ), 0)`,
      [workloadId, state, workloadId, state],
    );
    return rows[0]?.entered_at ?? null;
  }

  /**
   * Latest generation-boundary events used to decide whether a Service VM owns
   * the durable checkpoint. Return only the two event ids the checkpoint path
   * needs instead of materializing and parsing the workload's full history.
   */
  async getLatestRunningAndProvisioningEventIds(workloadId: string): Promise<{
    latestRunningEventId: number;
    latestProvisioningEventId: number;
  }> {
    const rows = await this.db.query<{
      latest_running_event_id: number | null;
      latest_provisioning_event_id: number | null;
    }>(
      `SELECT
         MAX(CASE WHEN state = ? THEN id END) AS latest_running_event_id,
         MAX(CASE WHEN state = ? THEN id END) AS latest_provisioning_event_id
       FROM workload_events
       WHERE workload_id = ?
         AND state IN (?, ?)`,
      [
        WorkloadState.Running,
        WorkloadState.Provisioning,
        workloadId,
        WorkloadState.Running,
        WorkloadState.Provisioning,
      ],
    );
    return {
      latestRunningEventId: rows[0]?.latest_running_event_id ?? 0,
      latestProvisioningEventId: rows[0]?.latest_provisioning_event_id ?? 0,
    };
  }

  /**
   * Get workload events for debugging
   */
  async getWorkloadEvents(workloadId: string): Promise<WorkloadEventRow[]> {
    return this.db.query<WorkloadEventRow>(
      `SELECT * FROM workload_events WHERE workload_id = ? ORDER BY created_at, rowid`,
      [workloadId],
    );
  }

  /**
   * Latest Finalizing event that still carries finalization-control metadata.
   * Diagnostic observations can be appended while a workload remains Finalizing;
   * they must stay visible in status without hiding the retry-control event.
   */
  async getLatestFinalizationEventMetadata(
    workloadId: string,
  ): Promise<WorkloadEventMetadata | null> {
    const rows = await this.db.query<WorkloadEventMetadataRow>(
      `SELECT metadata, created_at
       FROM workload_events
       WHERE workload_id = ?
         AND state = ?
         AND metadata IS NOT NULL
         AND json_valid(metadata)
         AND json_extract(metadata, '$.targetState') IN (?, ?)
         AND typeof(json_extract(metadata, '$.workloadExitCode')) IN ('integer', 'real')
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [
        workloadId,
        WorkloadState.Finalizing,
        WorkloadState.Completed,
        WorkloadState.Errored,
      ],
    );
    return parseWorkloadEventMetadataRow(rows[0]);
  }

  /**
   * Read the most recent scheduler/deploy placement claim. New admissions can
   * therefore be resumed after a process exit even when provisionStep had not
   * yet reached the point where it registers a VM-ledger placeholder.
   */
  async getLatestProvisioningIntent(
    workloadId: string,
  ): Promise<ProvisioningIntent | null> {
    const rows = await this.db.query<{ metadata: string }>(
      `SELECT metadata
       FROM workload_events
       WHERE id = (
         SELECT id
         FROM workload_events
         WHERE workload_id = ?
         ORDER BY id DESC
         LIMIT 1
       )
         AND state = ?
         AND json_valid(metadata)
         AND json_type(metadata, '$.provisioningIntent') = 'object'
       LIMIT 1`,
      [workloadId, WorkloadState.Provisioning],
    );
    const metadata = rows[0]?.metadata;
    if (!metadata) return null;

    const parsed = decodeWorkloadEventMetadata(metadata);
    const intentValue = parsed?.provisioningIntent;
    if (
      !intentValue ||
      typeof intentValue !== 'object' ||
      Array.isArray(intentValue)
    ) {
      return null;
    }
    const intent = intentValue as Record<string, unknown>;
    if (typeof intent.cloudProvider !== 'string') return null;
    if (
      !(Object.values(CloudType) as string[]).includes(intent.cloudProvider)
    ) {
      return null;
    }
    return {
      cloudProvider: intent.cloudProvider as CloudType,
      availabilityZone:
        typeof intent.availabilityZone === 'string'
          ? intent.availabilityZone
          : null,
      ...(typeof intent.region === 'string' ? { region: intent.region } : {}),
      ...(typeof intent.vmType === 'string' ? { vmType: intent.vmType } : {}),
      ...(typeof intent.credentialId === 'string'
        ? { credentialId: intent.credentialId }
        : {}),
    };
  }

  /**
   * The latest failure classification recorded on a workload event. New
   * events use diagnosis/disposition; errorKind is read as a legacy fallback.
   */
  async getLatestFailureClassification(workloadId: string): Promise<{
    diagnosis: string | null;
    disposition: string | null;
  } | null> {
    const rows = await this.db.query<{
      diagnosis: string | null;
      disposition: string | null;
    }>(
      `SELECT COALESCE(
                json_extract(metadata, '$.diagnosis'),
                json_extract(metadata, '$.errorKind')
              ) as diagnosis,
              json_extract(metadata, '$.disposition') as disposition
       FROM workload_events
       WHERE workload_id = ?
         AND json_valid(metadata)
         AND (
           json_extract(metadata, '$.diagnosis') IS NOT NULL
           OR json_extract(metadata, '$.errorKind') IS NOT NULL
         )
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [workloadId],
    );
    return rows[0] ?? null;
  }

  /** Events recording `diagnosis`, which bounds the retries for one cause. */
  async countFailureDiagnosis(id: string, diagnosis: string): Promise<number> {
    const rows = await this.db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM workload_events WHERE workload_id = ?
         AND json_valid(metadata) AND json_extract(metadata, '$.diagnosis') = ?`,
      [id, diagnosis],
    );
    return rows[0]?.n ?? 0;
  }

  /** Transitions into `state` since the latest resubmission: a VM Job's Recovering events are its disruptions. */
  async countStateEvents(id: string, state: WorkloadState): Promise<number> {
    const rows = await this.db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM workload_events WHERE workload_id = ? AND state = ?
         AND id > COALESCE((SELECT MAX(id) FROM workload_events WHERE workload_id = ?
           AND json_valid(metadata) AND json_extract(metadata, '$.reason') = 'resubmitted'), 0)`,
      [id, state, id],
    );
    return rows[0]?.n ?? 0;
  }
}

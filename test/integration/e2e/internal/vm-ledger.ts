import type { CliClient } from './cli.js';
import { CliDatabase, databaseInteger, escapedSql } from './database.js';
import type {
  TrackedWorkloadKernel,
  TrackedWorkloadRef,
  VmLedgerCleared,
} from './workloads.js';
import type { LiveVmMetadata } from './types.js';
import type { StatusResponse } from './types.js';

const vmLedgerSnapshotBrand: unique symbol = Symbol('VmLedgerSnapshot');

type StatusVm = NonNullable<StatusResponse['vms']>[number];

export type VmLedgerSnapshot = Readonly<{
  readonly workloadId: string;
  readonly [vmLedgerSnapshotBrand]: true;
}>;

const vmLedgerEntries = new WeakMap<
  VmLedgerSnapshot,
  readonly Readonly<StatusVm>[]
>();

function entriesForSnapshot(
  snapshot: VmLedgerSnapshot,
): readonly Readonly<StatusVm>[] {
  const entries = vmLedgerEntries.get(snapshot);
  if (!entries)
    throw new Error('VM ledger snapshot was not created by its probe');
  return entries;
}

function cloudIdInventory(snapshot: VmLedgerSnapshot): readonly string[] {
  return entriesForSnapshot(snapshot)
    .map((entry) => String(entry.cloudId ?? ''))
    .sort((left, right) => left.localeCompare(right));
}

function nullableMetadataString(
  row: Record<string, unknown>,
  key: string,
): string | null {
  const value = row[key];
  if (value !== null && typeof value !== 'string') {
    throw new Error(`Live VM metadata ${key} was not a string or null`);
  }
  return value;
}

export function liveStatusVmEntries(
  snapshot: VmLedgerSnapshot,
): readonly Readonly<StatusVm>[] {
  return entriesForSnapshot(snapshot).filter((entry) => entry.endedAt === null);
}

export function statusVmEntriesForCloudId(
  snapshot: VmLedgerSnapshot,
  cloudId: string,
): readonly Readonly<StatusVm>[] {
  return entriesForSnapshot(snapshot).filter(
    (entry) => String(entry.cloudId ?? '') === cloudId,
  );
}

export function snapshotStatusVmLedger(
  workloadId: string,
  status: StatusResponse,
): VmLedgerSnapshot {
  if (status.workload.id !== workloadId) {
    throw new Error(
      `VM ledger snapshot for ${workloadId} identified workload ${status.workload.id}`,
    );
  }
  const snapshot: VmLedgerSnapshot = Object.freeze({
    workloadId,
    [vmLedgerSnapshotBrand]: true as const,
  });
  vmLedgerEntries.set(
    snapshot,
    Object.freeze(
      (status.vms ?? []).map((entry) => Object.freeze({ ...entry })),
    ),
  );
  return snapshot;
}

export function assertVmLedgerUnchanged(
  baseline: VmLedgerSnapshot,
  current: VmLedgerSnapshot,
): void {
  if (baseline.workloadId !== current.workloadId) {
    throw new Error('VM ledger snapshots belong to different workloads');
  }
  if (
    JSON.stringify(cloudIdInventory(baseline)) !==
    JSON.stringify(cloudIdInventory(current))
  ) {
    throw new Error('VM ledger gained or lost a row after its baseline');
  }
}

export class VmLedgerProbe {
  readonly #database: CliDatabase;
  readonly #kernel: Pick<
    TrackedWorkloadKernel,
    'assertActive' | 'recordLedgerCleared'
  >;

  constructor(
    cli: Pick<CliClient, 'run'>,
    kernel: Pick<TrackedWorkloadKernel, 'assertActive' | 'recordLedgerCleared'>,
  ) {
    this.#database = new CliDatabase(cli);
    this.#kernel = kernel;
  }

  snapshot(ref: TrackedWorkloadRef, status: StatusResponse): VmLedgerSnapshot {
    this.#kernel.assertActive(ref);
    return snapshotStatusVmLedger(ref.id, status);
  }

  assertUnchangedSince(
    ref: TrackedWorkloadRef,
    baseline: VmLedgerSnapshot,
    status: StatusResponse,
  ): VmLedgerSnapshot {
    this.#kernel.assertActive(ref);
    if (baseline.workloadId !== ref.id) {
      throw new Error(`VM ledger baseline does not belong to ${ref.id}`);
    }
    const current = snapshotStatusVmLedger(ref.id, status);
    assertVmLedgerUnchanged(baseline, current);
    return current;
  }

  liveEntries(snapshot: VmLedgerSnapshot): readonly Readonly<StatusVm>[] {
    return liveStatusVmEntries(snapshot);
  }

  entriesForCloudId(
    snapshot: VmLedgerSnapshot,
    cloudId: string,
  ): readonly Readonly<StatusVm>[] {
    return statusVmEntriesForCloudId(snapshot, cloudId);
  }

  async liveVmCount(ref: TrackedWorkloadRef): Promise<number> {
    this.#kernel.assertActive(ref);
    const [row] = await this.#database.query(
      `SELECT COUNT(*) AS count FROM vms WHERE ended_at IS NULL AND workload_id = '${escapedSql(ref.id)}'`,
      'db-live-vm-count',
    );
    return databaseInteger(row?.count, 'Live VM count');
  }

  /**
   * Runs the count and mints the proof from it, so the evidence releasing
   * fallback cleanup cannot exist without the query behind it.
   */
  async assertCleared(ref: TrackedWorkloadRef): Promise<VmLedgerCleared> {
    return this.#kernel.recordLedgerCleared(ref, await this.liveVmCount(ref));
  }

  async provisioningRecordCounts(ref: TrackedWorkloadRef): Promise<{
    readonly workloadRows: number;
    readonly vmRows: number;
  }> {
    this.#kernel.assertActive(ref);
    const workloadId = escapedSql(ref.id);
    const [row] = await this.#database.query(
      `SELECT (SELECT COUNT(*) FROM workloads WHERE id = '${workloadId}') AS workload_rows, (SELECT COUNT(*) FROM vms WHERE workload_id = '${workloadId}') AS vm_rows`,
      'db-provisioning-record-counts',
    );
    return {
      workloadRows: databaseInteger(row?.workload_rows, 'Workload row count'),
      vmRows: databaseInteger(row?.vm_rows, 'VM row count'),
    };
  }

  async credentialName(ref: TrackedWorkloadRef): Promise<string | undefined> {
    this.#kernel.assertActive(ref);
    const [row] = await this.#database.query(
      `SELECT c.name FROM workloads d JOIN credentials c ON c.id = d.credential_id WHERE d.id = '${escapedSql(ref.id)}'`,
      'db-workload-credential',
    );
    return typeof row?.name === 'string' ? row.name : undefined;
  }

  async liveVmMetadata(ref: TrackedWorkloadRef): Promise<LiveVmMetadata> {
    this.#kernel.assertActive(ref);
    const rows = await this.#database.queryComplete(
      `SELECT workload_id, cloud_id, ended_at, ip, ssh_host, ssh_port, ssh_username, base_image_id FROM vms WHERE workload_id = '${escapedSql(ref.id)}' AND ended_at IS NULL`,
      'db-live-vm-metadata',
    );
    const [row] = rows;
    if (
      rows.length !== 1 ||
      !row ||
      row.workload_id !== ref.id ||
      row.ended_at !== null
    ) {
      throw new Error(
        `Expected exactly one owned live VM metadata row for ${ref.id}`,
      );
    }
    if (
      !(
        (typeof row.cloud_id === 'string' && row.cloud_id.trim().length > 0) ||
        (typeof row.cloud_id === 'number' &&
          Number.isSafeInteger(row.cloud_id) &&
          row.cloud_id > 0)
      )
    ) {
      throw new Error(`Live VM metadata cloud ID was invalid for ${ref.id}`);
    }
    const ip = nullableMetadataString(row, 'ip');
    const sshHost = nullableMetadataString(row, 'ssh_host') ?? ip;
    const sshUsername = nullableMetadataString(row, 'ssh_username') ?? 'root';
    const sshPort = row.ssh_port === null ? 22 : row.ssh_port;
    if (
      !sshHost?.trim() ||
      !sshUsername.trim() ||
      typeof sshPort !== 'number' ||
      !Number.isSafeInteger(sshPort) ||
      sshPort <= 0 ||
      sshPort > 65535
    ) {
      throw new Error(
        `Live VM database SSH metadata was invalid for ${ref.id}`,
      );
    }

    return {
      cloudId: String(row.cloud_id),
      baseImageId: nullableMetadataString(row, 'base_image_id'),
      sshHost,
      sshPort,
      sshUsername,
    };
  }
}

import { CloudType } from '../../../../src/shared/cloud.js';

import type { ApiClient } from './api.js';
import type { CliDatabase } from './database.js';
import { databaseInteger, escapedSql } from './database.js';
import {
  assertJobController,
  type JobControllerBinding,
} from './job-controller.js';
import type {
  DedicatedJobCloudType,
  JobNativeAttempt,
} from './targets/job-types.js';
import type { TrackedWorkloadKernel, TrackedWorkloadRef } from './workloads.js';

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Job attempt ${label} is missing or invalid`);
  }
  return value;
}

function nullableText(value: unknown, label: string): string | null {
  return value === null ? null : text(value, label);
}

export interface JobAttemptIdentity {
  readonly provider: DedicatedJobCloudType;
  readonly credentialId: string | null;
  readonly controller: JobControllerBinding;
}

/** Reads every attempt, including rows omitted by public Workload VM status. */
export class JobAttemptLedger {
  readonly #api: Pick<ApiClient, 'controller'>;
  readonly #database: Pick<CliDatabase, 'queryComplete'>;
  readonly #kernel: Pick<TrackedWorkloadKernel, 'assertActive'>;
  readonly #identities = new WeakMap<TrackedWorkloadRef, JobAttemptIdentity>();
  readonly #observations = new WeakMap<
    TrackedWorkloadRef,
    readonly JobNativeAttempt[]
  >();
  readonly #history = new WeakMap<
    TrackedWorkloadRef,
    ReadonlyMap<number, JobNativeAttempt>
  >();

  constructor(dependencies: {
    readonly api: Pick<ApiClient, 'controller'>;
    readonly database: Pick<CliDatabase, 'queryComplete'>;
    readonly kernel: Pick<TrackedWorkloadKernel, 'assertActive'>;
  }) {
    this.#api = dependencies.api;
    this.#database = dependencies.database;
    this.#kernel = dependencies.kernel;
  }

  async read(
    ref: TrackedWorkloadRef,
    inputIdentity: JobAttemptIdentity,
    deadlineAt = Date.now() + 60_000,
  ): Promise<readonly JobNativeAttempt[]> {
    this.#kernel.assertActive(ref);
    const identity = Object.freeze({
      provider: inputIdentity.provider,
      credentialId: inputIdentity.credentialId,
      controller: Object.freeze({ ...inputIdentity.controller }),
    });
    assertJobController(this.#api, identity.controller);
    if (
      ![
        CloudType.AWS,
        CloudType.Azure,
        CloudType.GCP,
        CloudType.Lambda,
        CloudType.Local,
      ].includes(identity.provider) ||
      (identity.provider === CloudType.Local) !==
        (identity.credentialId === null) ||
      (identity.credentialId !== null &&
        (typeof identity.credentialId !== 'string' ||
          !identity.credentialId.trim()))
    ) {
      throw new Error(
        'Job attempt identity requires its original compute credential',
      );
    }
    const captured = this.#identities.get(ref);
    if (
      captured &&
      (captured.provider !== identity.provider ||
        captured.credentialId !== identity.credentialId ||
        captured.controller.url !== identity.controller.url ||
        captured.controller.generation !== identity.controller.generation)
    ) {
      throw new Error(
        'Job attempt identity differs from its original registration',
      );
    }
    this.#identities.set(ref, identity);
    const rows = await this.#database.queryComplete(
      `SELECT v.id, v.workload_id, v.created_at, v.ended_at, v.cloud_id, v.ip, v.private_ip, v.region, v.availability_zone, v.vm_type, v.credential_id, c.cloud_provider FROM vms v LEFT JOIN credentials c ON c.id = v.credential_id WHERE v.workload_id = '${escapedSql(ref.id)}' ORDER BY v.created_at, v.id`,
      `job-${ref.id}-all-attempts`,
      deadlineAt,
    );
    this.#kernel.assertActive(ref);
    // A reply from a replaced controller must not enter original attempt history.
    assertJobController(this.#api, identity.controller);
    const attempts = new Map<number, JobNativeAttempt>();
    const previous = this.#history.get(ref);
    const history = new Map(previous);
    const observations = new Map(
      (this.#observations.get(ref) ?? []).map((attempt) => [
        JSON.stringify(attempt),
        attempt,
      ]),
    );
    for (const row of rows) {
      if (
        row.workload_id !== ref.id ||
        row.credential_id !== identity.credentialId
      ) {
        throw new Error(
          `Job ${ref.id} attempt belongs to a different Workload or credential`,
        );
      }
      const provider =
        identity.provider === CloudType.Local && row.cloud_provider === null
          ? CloudType.Local
          : row.cloud_provider;
      if (provider !== identity.provider) {
        throw new Error(
          `Job ${ref.id} attempt provider differs from its captured credential`,
        );
      }
      const rowId = databaseInteger(row.id, 'Job attempt row ID');
      if (rowId < 1 || attempts.has(rowId))
        throw new Error(
          'Job attempt inventory repeats or omits a row identity',
        );
      const createdAt = databaseInteger(
        row.created_at,
        'Job attempt creation time',
      );
      const endedAt =
        row.ended_at === null
          ? null
          : databaseInteger(row.ended_at, 'Job attempt end time');
      if (endedAt !== null && endedAt < createdAt)
        throw new Error('Job attempt ended before creation');
      attempts.set(
        rowId,
        Object.freeze({
          ref,
          rowId,
          createdAt,
          endedAt,
          cloudId: text(row.cloud_id, 'native or reserved cloud ID'),
          ip: nullableText(row.ip, 'IP address'),
          ...(row.private_ip != null && {
            privateIp: text(row.private_ip, 'private IP address'),
          }),
          cloudProvider: identity.provider,
          credentialId: identity.credentialId,
          region: text(row.region, 'original region'),
          availabilityZone: nullableText(
            row.availability_zone,
            'original zone',
          ),
          vmType: text(row.vm_type, 'original VM type'),
        }),
      );
      const current = attempts.get(rowId);
      if (!current) throw new Error('Job attempt observation was lost');
      const old = previous?.get(rowId);
      if (old) {
        const completingReservation = old.ip === null && current.ip !== null;
        // Reads are snapshots: a reservation may be completed or retargeted and
        // then ended before the next read. An IP-null retarget may also reuse its
        // cloud ID. Once adopted, native identity and placement are immutable.
        if (
          current.credentialId !== old.credentialId ||
          current.cloudProvider !== old.cloudProvider ||
          current.region !== old.region ||
          current.vmType !== old.vmType ||
          (!completingReservation && current.createdAt !== old.createdAt) ||
          (!completingReservation &&
            current.availabilityZone !== old.availabilityZone) ||
          (completingReservation &&
            old.availabilityZone !== null &&
            current.availabilityZone === null) ||
          (old.ip !== null &&
            (current.cloudId !== old.cloudId ||
              current.ip !== old.ip ||
              (old.endedAt !== null && current.endedAt !== old.endedAt)))
        ) {
          throw new Error(
            `Job ${ref.id} rewrote original coordinates of attempt ${String(rowId)}`,
          );
        }
      }
      // Commit each validated row before inspecting the next one. A malformed
      // suffix cannot erase an exact native identity already read from the
      // complete transport receipt, or undo an observed reservation adoption.
      history.set(rowId, current);
      this.#history.set(ref, new Map(history));
      observations.set(JSON.stringify(current), current);
      this.#observations.set(ref, Object.freeze([...observations.values()]));
    }
    for (const rowId of previous?.keys() ?? []) {
      if (!attempts.has(rowId))
        throw new Error(
          `Job ${ref.id} lost tracked provisioning attempt ${String(rowId)}`,
        );
    }
    this.#history.set(ref, attempts);
    return Object.freeze([...attempts.values()]);
  }

  /** Original reservations remain available after a legitimate native refinement. */
  observations(ref: TrackedWorkloadRef): readonly JobNativeAttempt[] {
    this.#kernel.assertActive(ref);
    return this.#observations.get(ref) ?? Object.freeze([]);
  }
}

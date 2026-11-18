import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { TEST_USERNAMES } from '../../src/api/services/test-identity.js';
import {
  WorkloadState,
  WorkloadType,
  TERMINAL_STATES,
} from '../../src/shared/workload.js';
import type { MigrationDatabase } from '../../src/api/services/repositories/migration-database.js';
import type { EncodedContainerSpec } from '../../src/api/services/container-spec.js';
import { formatSessionDisplay } from '../../src/shared/session-display.js';

interface StateWeight {
  state: WorkloadState;
  weight: number;
}

interface WeightedString {
  name: string;
  weight: number;
}

interface SessionPoolEntry {
  session: string | null;
  agent: string | null;
  sessionLabel: string | null;
  weight: number;
}

interface RowsAffected {
  rowsAffected: number;
}

export const NUKE_DB_SHAPE = {
  baselineWorkloads: 3700,
  baselineEvents: 529000,
  baselineHistoricalVmRows: 3200,
  syntheticUserId: TEST_USERNAMES[0],
  syntheticCredentialId: 'nuke-db-synthetic-missing-credential',
  eventZipfExponent: 0.7,
  heavyStatusWorkloadCount: 5,
  failedVmAttemptsPerWorkload: 0.08,
  stateMix: [
    { state: WorkloadState.Completed, weight: 46 },
    { state: WorkloadState.Failed, weight: 22 },
    { state: WorkloadState.Errored, weight: 8 },
    { state: WorkloadState.Invalid, weight: 2 },
    { state: WorkloadState.Terminated, weight: 2 },
  ] satisfies StateWeight[],
  metadataSizeMix: [
    { name: 'small', weight: 64 },
    { name: 'medium', weight: 32 },
    { name: 'large', weight: 4 },
  ] satisfies WeightedString[],
  regions: [
    'eastus',
    'eastus2',
    'westus3',
    'centralus',
    'southcentralus',
    'northeurope',
    'westeurope',
    'australiacentral2',
  ],
  vmTypes: ['Standard_D2as_v5', 'Standard_D4as_v5', 'Standard_D2s_v5'],
  // Varied agent-session attribution so the seeded history exercises every
  // SESSION display/filter form: a labeled claude session, unlabeled long-id
  // sessions (rendered agent:<6char>), short synthesized ids (rendered raw), and
  // a human/untagged null bucket. Distinct first-6 chars so agent:<prefix>
  // filters disambiguate. UUIDs/labels are synthetic (PII-free, colon-free).
  // Weights keep every per-session subset under MAX_LIST_LIMIT (1000) at the
  // default baselineWorkloads (3700) so the integration --session probes get
  // exact, uncapped counts (max bucket here is 24% -> ~888 rows).
  sessionPool: [
    {
      session: '11111111-1111-4111-8111-111111111111',
      agent: 'claude',
      sessionLabel: 'nuke-db training run',
      weight: 24,
    },
    {
      session: '22222222-2222-4222-8222-222222222222',
      agent: 'claude',
      sessionLabel: null,
      weight: 24,
    },
    {
      session: '33333333-3333-4333-8333-333333333333',
      agent: 'cursor',
      sessionLabel: null,
      weight: 16,
    },
    { session: 'codex-49152', agent: 'codex', sessionLabel: null, weight: 12 },
    { session: 'aider-50001', agent: 'aider', sessionLabel: null, weight: 12 },
    { session: null, agent: null, sessionLabel: null, weight: 12 },
  ] satisfies SessionPoolEntry[],
} as const;

export interface NukeDbDerivedCounts {
  workloads: number;
  events: number;
  historicalVmRows: number;
  failedVmAttempts: number;
}

/** Per-workload attribution assigned by the seeder (parallel to workloadIds). */
export interface SessionAssignment {
  session: string | null;
  agent: string | null;
  sessionLabel: string | null;
}

/** Per-pool-entry rollup recorded in the manifest for tests to assert against. */
export interface NukeDbSeedSession extends SessionAssignment {
  /** What the SESSION column shows (label / agent:<6char> / '-'). */
  displayForm: string;
  workloadCount: number;
}

export interface NukeDbSeedPlan {
  seedHash: string;
  now: number;
  counts: NukeDbDerivedCounts;
  workloadIds: string[];
  states: WorkloadState[];
  eventCounts: number[];
  historicalVmWorkloadIndexes: number[];
  failedVmAttemptWorkloadIndexes: number[];
  heavyStatusWorkloadIds: string[];
  sessions: SessionAssignment[];
}

export interface NukeDbSeedManifest {
  name: 'seed nuke-db';
  generatedAt: string;
  seedHash: string;
  syntheticUserId: string;
  counts: NukeDbDerivedCounts;
  heavyStatusWorkloadIds: string[];
  sessions: NukeDbSeedSession[];
  shape: {
    baselineWorkloads: number;
    baselineEvents: number;
    baselineHistoricalVmRows: number;
    eventZipfExponent: number;
  };
}

export interface SeedNukeDbOptions {
  dbPath: string;
  workloads: number;
  seed?: string;
  manifestPath?: string;
  dryRun?: boolean;
  now?: number;
}

interface WorkloadSeedRow {
  id: string;
  state: WorkloadState;
  startedAt: number;
  completedAt: number | null;
  cleanedAt: number | null;
  now: number;
  region: string;
  vmType: string;
  spot: boolean;
  outputBucket: string | null;
  eventCount: number;
}

class BetterSqliteMigrationAdapter implements MigrationDatabase {
  constructor(private readonly raw: Database.Database) {}

  get inTransaction(): boolean {
    return this.raw.inTransaction;
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  query<T>(sql: string, params?: unknown[]): T[] {
    const stmt = this.raw.prepare(sql);
    if (stmt.reader) {
      return (params ? stmt.all(...params) : stmt.all()) as T[];
    }
    const result = params ? stmt.run(...params) : stmt.run();
    const row: RowsAffected = { rowsAffected: result.changes };
    return [row as unknown as T];
  }
}

export function deriveNukeDbCounts(workloads: number): NukeDbDerivedCounts {
  if (!Number.isInteger(workloads) || workloads < 1) {
    throw new Error(`workloads must be a positive integer, got ${workloads}`);
  }
  return {
    workloads,
    events: Math.round(
      (workloads * NUKE_DB_SHAPE.baselineEvents) /
        NUKE_DB_SHAPE.baselineWorkloads,
    ),
    historicalVmRows: Math.round(
      (workloads * NUKE_DB_SHAPE.baselineHistoricalVmRows) /
        NUKE_DB_SHAPE.baselineWorkloads,
    ),
    failedVmAttempts: Math.round(
      workloads * NUKE_DB_SHAPE.failedVmAttemptsPerWorkload,
    ),
  };
}

export function createNukeDbSeedPlan(options: {
  workloads: number;
  seed?: string;
  now?: number;
}): NukeDbSeedPlan {
  const seed = options.seed ?? 'nuke-db';
  const counts = deriveNukeDbCounts(options.workloads);
  const seedHash = hashString32(seed).toString(36).padStart(7, '0');
  const now = options.now ?? Date.now();
  const workloadIds = Array.from({ length: counts.workloads }, (_, i) =>
    workloadId(seedHash, i),
  );
  const states = assignStates(counts.workloads, seed);
  const sessions = assignSessions(counts.workloads, seed);
  const eventCounts = assignEventCounts(counts.events, states, seed);
  const heavyStatusWorkloadIndexes = selectHeavyStatusIndexes(
    eventCounts,
    states,
    seed,
  );
  const historicalVmWorkloadIndexes = selectHistoricalVmWorkloadIndexes(
    counts.historicalVmRows,
    states,
    seed,
  );
  const failedVmAttemptWorkloadIndexes = selectFailedVmAttemptIndexes(
    counts.failedVmAttempts,
    states,
    seed,
  );

  return {
    seedHash,
    now,
    counts,
    workloadIds,
    states,
    eventCounts,
    historicalVmWorkloadIndexes,
    failedVmAttemptWorkloadIndexes,
    heavyStatusWorkloadIds: heavyStatusWorkloadIndexes.map(
      (i) => workloadIds[i],
    ),
    sessions,
  };
}

/**
 * Deterministically assign each workload one of the NUKE_DB_SHAPE.sessionPool
 * entries (weighted, reproducible per seed) — mirrors assignStates.
 */
function assignSessions(
  workloadCount: number,
  seed: string,
): SessionAssignment[] {
  const pool = NUKE_DB_SHAPE.sessionPool;
  const counts = allocateWeighted(
    workloadCount,
    pool.map((entry, i) => ({ id: String(i), weight: entry.weight })),
  );
  const assignments = new Array<SessionAssignment>(workloadCount);
  const shuffled = shuffledIndexes(workloadCount, seed, 'session');
  let cursor = 0;
  for (let i = 0; i < pool.length; i++) {
    const entry = pool[i];
    const entryCount = counts.get(String(i)) ?? 0;
    for (let k = 0; k < entryCount; k++) {
      assignments[shuffled[cursor]] = {
        session: entry.session,
        agent: entry.agent,
        sessionLabel: entry.sessionLabel,
      };
      cursor++;
    }
  }
  return assignments;
}

function summarizeSessions(plan: NukeDbSeedPlan): NukeDbSeedSession[] {
  return NUKE_DB_SHAPE.sessionPool.map((entry) => ({
    session: entry.session,
    agent: entry.agent,
    sessionLabel: entry.sessionLabel,
    displayForm: formatSessionDisplay(entry) ?? '-',
    workloadCount: plan.sessions.filter((s) => s.session === entry.session)
      .length,
  }));
}

export async function seedNukeDb(
  options: SeedNukeDbOptions,
): Promise<NukeDbSeedManifest> {
  const plan = createNukeDbSeedPlan({
    workloads: options.workloads,
    seed: options.seed,
    now: options.now,
  });
  const manifest = toManifest(plan);

  if (options.dryRun) {
    return manifest;
  }

  // Runtime imports initialize API configuration and its encryption key.
  const { encryptSecret } = await import(
    '../../src/api/services/secret-crypto.js'
  );
  const { runMigrations } = await import(
    '../../src/api/services/repositories/migrations.js'
  );
  const { encodeContainerSpec } = await import(
    '../../src/api/services/container-spec.js'
  );
  const { auditContainerSpecOwnership } = await import(
    '../../src/api/services/repositories/container-spec-ownership.js'
  );
  const encryptedSshPrivateKey = await encryptSecret(
    syntheticSshPrivateKey(plan.seedHash),
  );
  const raw = new Database(options.dbPath);
  try {
    await runMigrations(new BetterSqliteMigrationAdapter(raw));
    raw.pragma('foreign_keys = ON');

    const deployRows = plan.workloadIds.map((id, index) =>
      workloadRowFor(plan, id, index),
    );
    const containerSpecs = await Promise.all(
      deployRows.map((_, index) =>
        encodeContainerSpec({
          image: syntheticImage(index),
          imageDigest: syntheticDigest(plan.seedHash, index),
          command: ['sh', '-c', 'sleep 30'],
          dockerOptions: index % 7 === 0 ? { shmSize: '1g' } : null,
          env: null,
          registryUsername: NUKE_DB_SHAPE.syntheticUserId,
          registryToken: null,
        }),
      ),
    );

    raw.transaction(() => {
      insertSeedRows(raw, {
        plan,
        deployRows,
        historicalVmIndexes: new Set(plan.historicalVmWorkloadIndexes),
        failedAttemptIndexes: plan.failedVmAttemptWorkloadIndexes,
        encryptedSshPrivateKey,
        containerSpecs,
      });
      auditContainerSpecOwnership(new BetterSqliteMigrationAdapter(raw));
    })();
  } finally {
    raw.close();
  }

  if (options.manifestPath) {
    mkdirSync(dirname(options.manifestPath), { recursive: true });
    writeFileSync(
      options.manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
  }

  return manifest;
}

export function formatNukeDbSeedSummary(manifest: NukeDbSeedManifest): string {
  return [
    'seed nuke-db',
    `workloads=${manifest.counts.workloads}`,
    `events=${manifest.counts.events}`,
    `historical_vm_rows=${manifest.counts.historicalVmRows}`,
    `failed_vm_attempts=${manifest.counts.failedVmAttempts}`,
    `seed_hash=${manifest.seedHash}`,
    `heavy_status_ids=${manifest.heavyStatusWorkloadIds.join(',')}`,
    `session_mix=${manifest.sessions
      .map((s) => `${s.displayForm}=${s.workloadCount}`)
      .join(' ')}`,
  ].join('\n');
}

function insertSeedRows(
  raw: Database.Database,
  input: {
    plan: NukeDbSeedPlan;
    deployRows: WorkloadSeedRow[];
    historicalVmIndexes: Set<number>;
    failedAttemptIndexes: number[];
    encryptedSshPrivateKey: string;
    containerSpecs: EncodedContainerSpec[];
  },
): void {
  const insertWorkload = raw.prepare(`
    INSERT INTO workloads (
      id, user_id, workload_type,
      region, vm_type, gpu_type, spot,
      state, started_at, submitted_at, completed_at, cleaned_at,
      docker_command,
      input_bucket, output_bucket, disk_size_gb,
      availability_zone, ssh_private_key, credential_id,
      input_storage_credential_id, input_storage_region,
      output_storage_credential_id, output_storage_region,
      checkpoint_storage_credential_id, checkpoint_storage_region,
      dns_record_id, secret_names,
      session, agent, session_label
    ) VALUES (
      ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?,
      ?, ?,
      ?, ?,
      ?, ?,
      ?, ?, ?
    )
  `);
  const insertContainerSpec = raw.prepare(`
    INSERT INTO container_specs (
      workload_id, image, image_digest, command,
      docker_options, env, registry_username, registry_token
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertEvent = raw.prepare(`
    INSERT INTO workload_events (workload_id, state, metadata, created_at)
    VALUES (?, ?, ?, ?)
  `);
  const insertVm = raw.prepare(`
    INSERT INTO vms (
      workload_id, ip, cloud_id, private_ip,
      base_image_id, availability_zone,
      created_at, ended_at, preempt, region, credential_id, price_per_hour,
      cost, ssh_host, ssh_port, ssh_username, vm_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  deleteExistingNukeDbSeedRows(raw);

  for (let index = 0; index < input.deployRows.length; index++) {
    const row = input.deployRows[index];
    insertWorkload.run(
      row.id,
      NUKE_DB_SHAPE.syntheticUserId,
      WorkloadType.Job,
      row.region,
      row.vmType,
      null,
      row.spot ? 1 : 0,
      row.state,
      row.startedAt,
      row.startedAt,
      row.completedAt,
      row.cleanedAt,
      `docker run --rm ${syntheticImage(index)} sh -c 'sleep 30'`,
      null,
      row.outputBucket,
      64,
      availabilityZone(row.region, index),
      input.encryptedSshPrivateKey,
      NUKE_DB_SHAPE.syntheticCredentialId,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      input.plan.sessions[index].session,
      input.plan.sessions[index].agent,
      input.plan.sessions[index].sessionLabel,
    );
    const spec = input.containerSpecs[index];
    insertContainerSpec.run(
      row.id,
      spec.image,
      spec.image_digest,
      spec.command,
      spec.docker_options,
      spec.env,
      spec.registry_username,
      spec.registry_token,
    );

    for (let eventIndex = 0; eventIndex < row.eventCount; eventIndex++) {
      const eventState = eventStateFor(row.state, eventIndex, row.eventCount);
      insertEvent.run(
        row.id,
        eventState,
        metadataForEvent({
          state: eventState,
          finalState: row.state,
          workloadIndex: index,
          eventIndex,
          isLast: eventIndex === row.eventCount - 1,
          region: row.region,
        }),
        eventCreatedAt(row, eventIndex),
      );
    }

    if (input.historicalVmIndexes.has(index)) {
      const createdAt = row.startedAt + 60_000;
      insertVm.run(
        row.id,
        documentationIp(index),
        syntheticCloudId(row.id, 'historical', 0),
        null,
        syntheticBaseImageId(index),
        availabilityZone(row.region, index),
        createdAt,
        historicalVmEndedAt(row, createdAt, index),
        row.spot && index % 13 === 0 ? 1 : null,
        row.region,
        null,
        0.0268,
        0.002,
        null,
        null,
        'azureuser',
        row.vmType,
      );
    }
  }

  for (let index = 0; index < input.failedAttemptIndexes.length; index++) {
    const workloadIndex = input.failedAttemptIndexes[index];
    const row = input.deployRows[workloadIndex];
    const createdAt = row.startedAt + ((index % 3) + 1) * 90_000;
    insertVm.run(
      row.id,
      null,
      syntheticCloudId(row.id, 'failed', index),
      null,
      syntheticBaseImageId(workloadIndex),
      availabilityZone(row.region, workloadIndex + index),
      createdAt,
      historicalVmEndedAt(row, createdAt, index),
      null,
      row.region,
      null,
      null,
      0,
      null,
      null,
      null,
      row.vmType,
    );
  }
}

function deleteExistingNukeDbSeedRows(raw: Database.Database): void {
  // Identify seeded rows by their id prefix, not the session column — the seeder
  // stamps varied session/agent/session_label values. Scope to the synthetic
  // user so a real workload cannot match the cleanup sentinel accidentally.
  const seedWorkloadIds = `SELECT id FROM workloads WHERE id LIKE 'nuke-db-%' AND user_id = '${NUKE_DB_SHAPE.syntheticUserId}'`;
  raw
    .prepare(
      `DELETE FROM workload_events WHERE workload_id IN (${seedWorkloadIds})`,
    )
    .run();
  raw
    .prepare(`DELETE FROM vms WHERE workload_id IN (${seedWorkloadIds})`)
    .run();
  raw.prepare(`DELETE FROM workloads WHERE id IN (${seedWorkloadIds})`).run();
}

function toManifest(plan: NukeDbSeedPlan): NukeDbSeedManifest {
  return {
    name: 'seed nuke-db',
    generatedAt: new Date(plan.now).toISOString(),
    seedHash: plan.seedHash,
    syntheticUserId: NUKE_DB_SHAPE.syntheticUserId,
    counts: plan.counts,
    heavyStatusWorkloadIds: plan.heavyStatusWorkloadIds,
    sessions: summarizeSessions(plan),
    shape: {
      baselineWorkloads: NUKE_DB_SHAPE.baselineWorkloads,
      baselineEvents: NUKE_DB_SHAPE.baselineEvents,
      baselineHistoricalVmRows: NUKE_DB_SHAPE.baselineHistoricalVmRows,
      eventZipfExponent: NUKE_DB_SHAPE.eventZipfExponent,
    },
  };
}

function assignStates(workloadCount: number, seed: string): WorkloadState[] {
  const counts = allocateWeighted(
    workloadCount,
    NUKE_DB_SHAPE.stateMix.map((entry) => ({
      id: entry.state,
      weight: entry.weight,
    })),
  );
  const states = new Array<WorkloadState>(workloadCount);
  const shuffled = shuffledIndexes(workloadCount, seed, 'state');
  let cursor = 0;
  for (const entry of NUKE_DB_SHAPE.stateMix) {
    const count = counts.get(entry.state) ?? 0;
    for (let i = 0; i < count; i++) {
      states[shuffled[cursor]] = entry.state;
      cursor++;
    }
  }
  return states;
}

function assignEventCounts(
  totalEvents: number,
  states: WorkloadState[],
  seed: string,
): number[] {
  const minimums = states.map((state) => baseEventStates(state).length);
  const baseTotal = minimums.reduce((sum, count) => sum + count, 0);
  const remaining = Math.max(0, totalEvents - baseTotal);
  const rankedIndexes = shuffledIndexes(states.length, seed, 'events');
  const weighted = rankedIndexes.map((index, rank) => ({
    id: String(index),
    weight: 1 / Math.pow(rank + 1, NUKE_DB_SHAPE.eventZipfExponent),
  }));
  const extras = allocateWeighted(remaining, weighted);
  return minimums.map((base, i) => base + (extras.get(String(i)) ?? 0));
}

function selectHeavyStatusIndexes(
  eventCounts: number[],
  states: WorkloadState[],
  seed: string,
): number[] {
  const sentinelCount = Math.min(
    NUKE_DB_SHAPE.heavyStatusWorkloadCount,
    states.length,
  );
  if (sentinelCount === 0) return [];
  const completed = eventCounts
    .map((count, index) => ({ count, index }))
    .filter((entry) => states[entry.index] === WorkloadState.Completed)
    .sort(
      (a, b) =>
        b.count - a.count ||
        randomInt(seed, a.index, 'heavy-tiebreak') -
          randomInt(seed, b.index, 'heavy-tiebreak'),
    );
  const fallback = eventCounts
    .map((count, index) => ({ count, index }))
    .sort((a, b) => b.count - a.count);
  const source = completed.length > 0 ? completed : fallback;
  return source
    .slice(0, Math.min(sentinelCount, source.length))
    .map((entry) => entry.index);
}

function selectHistoricalVmWorkloadIndexes(
  historicalVmRows: number,
  states: WorkloadState[],
  seed: string,
): number[] {
  if (historicalVmRows <= 0) return [];
  const blocked = new Set<number>();
  const candidates = candidateIndexes(
    states,
    (state) => TERMINAL_STATES.includes(state),
    blocked,
    seed,
    'historical-vm',
  );
  return candidates.slice(0, historicalVmRows).sort((a, b) => a - b);
}

function selectFailedVmAttemptIndexes(
  attempts: number,
  states: WorkloadState[],
  seed: string,
): number[] {
  if (attempts <= 0) return [];
  const preferred = candidateIndexes(
    states,
    (state) =>
      state === WorkloadState.Failed ||
      state === WorkloadState.Errored ||
      state === WorkloadState.Invalid,
    new Set(),
    seed,
    'failed-vm',
  );
  const candidates =
    preferred.length > 0
      ? preferred
      : shuffledIndexes(states.length, seed, 'failed-vm-fallback');
  return Array.from(
    { length: attempts },
    (_, i) => candidates[i % candidates.length],
  );
}

function workloadRowFor(
  plan: NukeDbSeedPlan,
  id: string,
  index: number,
): WorkloadSeedRow {
  const state = plan.states[index];
  const ageMs =
    30 * 60_000 +
    (randomInt(String(plan.seedHash), index, 'age') % (23 * 60 * 60_000));
  const startedAt = plan.now - ageMs;
  const isTerminal = TERMINAL_STATES.includes(state);
  const completedAt = isTerminal
    ? Math.min(
        plan.now - 30_000,
        startedAt +
          4 * 60_000 +
          (randomInt(String(plan.seedHash), index, 'duration') %
            (2 * 60 * 60_000)),
      )
    : null;
  const region = NUKE_DB_SHAPE.regions[index % NUKE_DB_SHAPE.regions.length];
  const vmType = NUKE_DB_SHAPE.vmTypes[index % NUKE_DB_SHAPE.vmTypes.length];
  // Terminal history is cleaned history. `cleanupPendingPredicate` admits any
  // terminal row with a null cleaned_at to the cleanup lane, so leaving this
  // unset seeded thousands of workloads permanently stuck in teardown —
  // a shape no live API has, and one that dominated everything the seed was
  // meant to measure.
  const cleanedAt =
    completedAt === null
      ? null
      : Math.min(
          plan.now - 15_000,
          completedAt +
            30_000 +
            (randomInt(String(plan.seedHash), index, 'cleaned') % (5 * 60_000)),
        );
  return {
    id,
    state,
    startedAt,
    completedAt,
    cleanedAt,
    now: plan.now,
    region,
    vmType,
    spot: index % 10 !== 0,
    outputBucket: index % 4 === 0 ? `nuke-db-output-${index % 97}` : null,
    eventCount: plan.eventCounts[index],
  };
}

function eventStateFor(
  finalState: WorkloadState,
  eventIndex: number,
  eventCount: number,
): WorkloadState {
  const base = baseEventStates(finalState);
  if (eventIndex < base.length - 1) return base[eventIndex];
  if (eventIndex === eventCount - 1) return finalState;
  const fillers = [
    WorkloadState.Provisioning,
    WorkloadState.Initializing,
    WorkloadState.Downloading,
    WorkloadState.Retrying,
    WorkloadState.Queued,
    WorkloadState.Provisioning,
    WorkloadState.Recovering,
  ];
  return fillers[eventIndex % fillers.length];
}

function baseEventStates(finalState: WorkloadState): WorkloadState[] {
  switch (finalState) {
    case WorkloadState.Completed:
      return [
        WorkloadState.Queued,
        WorkloadState.Provisioning,
        WorkloadState.Initializing,
        WorkloadState.Downloading,
        WorkloadState.Starting,
        WorkloadState.Running,
        WorkloadState.Completed,
      ];
    case WorkloadState.Errored:
      return [
        WorkloadState.Queued,
        WorkloadState.Provisioning,
        WorkloadState.Initializing,
        WorkloadState.Downloading,
        WorkloadState.Starting,
        WorkloadState.Running,
        WorkloadState.Errored,
      ];
    case WorkloadState.Failed:
      return [
        WorkloadState.Queued,
        WorkloadState.Provisioning,
        WorkloadState.Retrying,
        WorkloadState.Provisioning,
        WorkloadState.Failed,
      ];
    case WorkloadState.Invalid:
      return [
        WorkloadState.Queued,
        WorkloadState.Provisioning,
        WorkloadState.Invalid,
      ];
    case WorkloadState.Terminated:
      return [
        WorkloadState.Queued,
        WorkloadState.Provisioning,
        WorkloadState.Terminated,
      ];
    case WorkloadState.Running:
      return [
        WorkloadState.Queued,
        WorkloadState.Provisioning,
        WorkloadState.Initializing,
        WorkloadState.Downloading,
        WorkloadState.Starting,
        WorkloadState.Running,
      ];
    case WorkloadState.Retrying:
      return [
        WorkloadState.Queued,
        WorkloadState.Provisioning,
        WorkloadState.Retrying,
      ];
    case WorkloadState.Recovering:
      return [
        WorkloadState.Queued,
        WorkloadState.Provisioning,
        WorkloadState.Running,
        WorkloadState.Recovering,
      ];
    default:
      return [WorkloadState.Queued, finalState];
  }
}

function eventCreatedAt(row: WorkloadSeedRow, eventIndex: number): number {
  const end = row.completedAt ?? row.now - 15_000;
  const windowMs = Math.max(1, end - row.startedAt);
  const stepMs = Math.max(
    1,
    Math.floor(windowMs / Math.max(1, row.eventCount)),
  );
  return row.startedAt + eventIndex * stepMs;
}

function historicalVmEndedAt(
  row: WorkloadSeedRow,
  createdAt: number,
  salt: number,
): number {
  const completedAt = row.completedAt ?? row.now - 30_000;
  const latest = Math.max(createdAt + 1, completedAt - 5_000);
  const durationMs =
    2 * 60_000 + (randomInt(row.id, salt, 'vm-duration') % (45 * 60_000));
  return Math.min(latest, createdAt + durationMs);
}

function metadataForEvent(input: {
  state: WorkloadState;
  finalState: WorkloadState;
  workloadIndex: number;
  eventIndex: number;
  isLast: boolean;
  region: string;
}): string {
  const size = weightedChoice(
    NUKE_DB_SHAPE.metadataSizeMix,
    String(input.workloadIndex),
    input.eventIndex,
    'metadata-size',
  );
  const base: Record<string, unknown> = {
    region: input.region,
    synthetic: true,
    source: 'seed nuke-db',
  };

  if (input.isLast) {
    Object.assign(base, finalMetadata(input.finalState, input.region));
  } else if (input.state === WorkloadState.Retrying) {
    Object.assign(base, retryMetadata(input.workloadIndex));
  } else if (input.state === WorkloadState.Recovering) {
    Object.assign(base, {
      reason: 'synthetic spot preemption recovery',
      preempted: true,
    });
  } else if (input.state === WorkloadState.Provisioning) {
    Object.assign(base, provisioningMetadata(input.workloadIndex));
  } else {
    Object.assign(base, {
      message: `synthetic ${input.state} event`,
    });
  }

  if (size === 'medium') {
    base.diagnostics = {
      requestId: syntheticRequestId(input.workloadIndex, input.eventIndex),
      elapsedMs: 500 + ((input.workloadIndex + input.eventIndex) % 25_000),
      retryable: input.state === WorkloadState.Retrying,
    };
  } else if (size === 'large') {
    base.error = `${String(base.error ?? base.message ?? 'synthetic event')}\n${syntheticStackTrace(
      input.workloadIndex,
    )}`;
  }

  return JSON.stringify(base);
}

function finalMetadata(
  finalState: WorkloadState,
  region: string,
): Record<string, unknown> {
  switch (finalState) {
    case WorkloadState.Completed:
      return {
        exitCode: 0,
        message: 'synthetic job completed',
      };
    case WorkloadState.Errored:
      return {
        exitCode: 137,
        oomKilled: false,
        error: 'synthetic container exited non-zero',
      };
    case WorkloadState.Failed:
      return {
        error: 'synthetic Azure provisioning failed after retries',
        errorKind: 'quota-exhausted-region',
        diagnosis: 'quota-exhausted-region',
        disposition: 'retryable',
        code: 'OperationNotAllowed',
        region,
      };
    case WorkloadState.Invalid:
      return {
        error: 'synthetic invalid workload configuration',
        disposition: 'terminal',
      };
    case WorkloadState.Terminated:
      return {
        reason: 'synthetic termination',
      };
    case WorkloadState.Retrying:
      return retryMetadata(0);
    case WorkloadState.Recovering:
      return {
        reason: 'synthetic spot preemption recovery',
        preempted: true,
      };
    default:
      return {
        message: `synthetic ${finalState} state`,
      };
  }
}

function retryMetadata(workloadIndex: number): Record<string, unknown> {
  const quota = workloadIndex % 3 !== 0;
  return quota
    ? {
        error: 'synthetic Azure LowPriorityCores quota exhausted',
        errorKind: 'quota-exhausted-region',
        diagnosis: 'quota-exhausted-region',
        disposition: 'retryable',
        code: 'OperationNotAllowed',
        resubmitted: workloadIndex % 2 === 0,
      }
    : {
        error: 'synthetic region unavailable for resource type',
        errorKind: 'region-unavailable',
        diagnosis: 'region-unavailable',
        disposition: 'retryable',
        code: 'LocationNotAvailableForResourceType',
        resubmitted: true,
      };
}

function provisioningMetadata(workloadIndex: number): Record<string, unknown> {
  if (workloadIndex % 19 === 0) {
    return {
      message: 'synthetic provisioning retry after regional capacity miss',
      code: 'AllocationFailed',
    };
  }
  return {
    message: 'synthetic VM provisioning attempt',
  };
}

function allocateWeighted<T extends string>(
  total: number,
  entries: Array<{ id: T; weight: number }>,
): Map<T, number> {
  const weightTotal = entries.reduce((sum, entry) => sum + entry.weight, 0);
  const raw = entries.map((entry) => {
    const exact = (total * entry.weight) / weightTotal;
    return {
      id: entry.id,
      floor: Math.floor(exact),
      fraction: exact - Math.floor(exact),
    };
  });
  let remaining = total - raw.reduce((sum, entry) => sum + entry.floor, 0);
  raw
    .slice()
    .sort((a, b) => b.fraction - a.fraction || a.id.localeCompare(b.id))
    .forEach((entry) => {
      if (remaining <= 0) return;
      entry.floor++;
      remaining--;
    });
  return new Map(raw.map((entry) => [entry.id, entry.floor]));
}

function candidateIndexes(
  states: WorkloadState[],
  predicate: (state: WorkloadState) => boolean,
  blocked: Set<number>,
  seed: string,
  salt: string,
): number[] {
  return shuffledIndexes(states.length, seed, salt).filter(
    (index) => !blocked.has(index) && predicate(states[index]),
  );
}

function shuffledIndexes(count: number, seed: string, salt: string): number[] {
  return Array.from({ length: count }, (_, index) => index).sort(
    (a, b) => randomInt(seed, a, salt) - randomInt(seed, b, salt),
  );
}

function weightedChoice(
  entries: readonly WeightedString[],
  seed: string,
  index: number,
  salt: string,
): string {
  const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
  let cursor = randomInt(seed, index, salt) % total;
  for (const entry of entries) {
    if (cursor < entry.weight) return entry.name;
    cursor -= entry.weight;
  }
  return entries[entries.length - 1].name;
}

function hashString32(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function randomInt(seed: string, index: number, salt: string): number {
  return hashString32(`${seed}:${salt}:${index}`);
}

function workloadId(seedHash: string, index: number): string {
  return `nuke-db-${seedHash}-${String(index + 1).padStart(6, '0')}`;
}

function syntheticImage(index: number): string {
  return index % 5 === 0
    ? 'synthetic/nuke-db-gpu:latest'
    : 'synthetic/nuke-db:latest';
}

function syntheticDigest(seedHash: string, index: number): string {
  return `sha256:${hashString32(`${seedHash}:digest:${index}`)
    .toString(16)
    .padStart(8, '0')
    .repeat(8)}`;
}

function syntheticSshPrivateKey(seedHash: string): string {
  return [
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    `synthetic-seed-nuke-db-${seedHash}`,
    '-----END OPENSSH PRIVATE KEY-----',
  ].join('\n');
}

function documentationIp(index: number): string {
  const ranges = ['192.0.2', '198.51.100', '203.0.113'];
  return `${ranges[index % ranges.length]}.${(index % 254) + 1}`;
}

function syntheticCloudId(
  workloadIdValue: string,
  kind: 'historical' | 'failed',
  index: number,
): string {
  return `/synthetic/azure/vm/${workloadIdValue}/${kind}-${index}`;
}

function syntheticBaseImageId(index: number): string {
  return `/synthetic/azure/image/base-${index % 17}`;
}

function availabilityZone(region: string, index: number): string {
  return `${region}-${(index % 3) + 1}`;
}

function syntheticRequestId(workloadIndex: number, eventIndex: number): string {
  return `synthetic-${workloadIndex.toString(16)}-${eventIndex.toString(16)}`;
}

function syntheticStackTrace(workloadIndex: number): string {
  const frames = Array.from({ length: 18 }, (_, i) => {
    const line = 40 + ((workloadIndex + i) % 200);
    return `    at syntheticNukeDbStep${i} (/workspace/synthetic/nuke-db.js:${line}:17)`;
  });
  return [
    'SyntheticError: generated nuke-db stack for payload-size realism',
    ...frames,
  ].join('\n');
}

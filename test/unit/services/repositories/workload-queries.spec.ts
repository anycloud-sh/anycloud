import {
  describe,
  it,
  expect,
  beforeEach,
  beforeAll,
  onTestFinished,
  vi,
} from 'vitest';
import { randomBytes } from 'crypto';
import {
  resetPersistence,
  getWorkloadLifecycle as lifecycle,
  getProvisioningAttemptStore as ledger,
  getWorkloadEventStore as eventLog,
  getWorkloadQueryStore as queries,
  getWorkloadOutcomes as outcomes,
} from '../../../../src/api/services/persistence.js';
import {
  seedTestWorkload,
  walkToState,
  provisionTestVm,
  releaseTestVms,
  preemptTestVm,
} from '../../../helpers/workload-store.js';
import { getDB } from '../../../../src/api/services/repositories/db.js';
import {
  listVmsNeedingCost,
  settleVmCostGroup,
} from '../../../../src/api/services/repositories/billing.js';
import type { CreateWorkloadInput } from '../../../../src/api/services/repositories/workload-creation.js';
import {
  explainQueryPlan,
  spyOnReadQueries,
} from '../../helpers/query-plan.js';
import { encryptSecret } from '../../../../src/api/services/secret-crypto.js';
import {
  CloudFailureDiagnosis,
  CloudType,
} from '../../../../src/shared/cloud.js';
import {
  FailureDisposition,
  type LaunchFailure,
} from '../../../../src/api/services/provisioning-failure.js';
import type { AddVMAttempt } from '../../../../src/api/services/entities.js';
import {
  WorkloadState,
  WorkloadType,
  ACTIVE_STATES,
  PREEMPTIBLE_STATES,
} from '../../../../src/shared/workload.js';
import config from '../../../../src/api/config';
import {
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
} from '../../../../src/shared/workload-list';

import { upsertCredential } from '../../../../src/api/services/repositories/credential-secrets.js';
import { createWorkload } from '../../../../src/api/services/repositories/workload-creation.js';
import { seedWorkloadRows } from '../../helpers/seed-workload-rows.js';

// Every caller reaches the whole API; the identity arguments name the submitter.
const scope = (_username?: string, _id?: string) => ({ kind: 'api' }) as const;

/** Settle one VM's bill through the billing monitor's write. */
async function settleVmCost(cloudId: string, costUsd: number): Promise<void> {
  const [vm] = await getDB().query<{ id: number }>(
    'SELECT id FROM vms WHERE cloud_id = ?',
    [cloudId],
  );
  await settleVmCostGroup([{ vmId: vm.id, costUsd }]);
}

describe('WorkloadQueryStore', () => {
  beforeAll(() => {
    // Set up cipher key for encryption tests
    config.cipherKey = randomBytes(32).toString('hex');
  });

  beforeEach(async () => {
    // Reset the store for each test (creates fresh SQLite database)
    resetPersistence();

    // Seed the credential IDs used by the various baseInput fixtures so FK
    // enforcement (migration 0042) doesn't reject the workload inserts.
    for (const id of [
      'test-credential-id',
      'test-cred',
      'test-cred-id',
      'checkpoint-cred-id',
    ]) {
      await getDB().query(
        `INSERT OR IGNORE INTO credentials (id, encrypted_data, cloud_provider) VALUES (?, '', 'AWS')`,
        [id],
      );
    }
  });

  // The SESSION column shows the friendly label or a claude:<hash> short form,
  // never the raw uuid — so `--session` must match what the user can see: the
  // exact id, an id prefix (the hash), or the session label.
  describe('listWorkloads session filter', () => {
    const baseInput = {
      userId: 'test-user',
      workloadType: 'job' as const,
      image: 'alpine:latest',
      cloudProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.medium',
      dockerCommand: 'docker run alpine',
      sshPrivateKey: 'ssh-ed25519-test-private-key',
      credentialId: 'test-credential-id',
    };
    const SESSION = '74e6d7c5-1d4b-470c-af47-103bffd77484';

    beforeEach(async () => {
      await createWorkload(getDB(), {
        ...baseInput,
        id: 'g1-polar-cocain10',
        session: SESSION,
        agent: 'claude',
        sessionLabel: 'gas-pipeline-tautomer-refactor',
      });
      await createWorkload(getDB(), {
        ...baseInput,
        id: 'other-session-job',
        session: 'ffffffff-0000-0000-0000-000000000000',
        agent: 'claude',
        sessionLabel: undefined,
      });
      // Two synthesized ids in a string-prefix relation, to exercise exact vs
      // fuzzy matching (auto-scope must not leak one into the other).
      await createWorkload(getDB(), {
        ...baseInput,
        id: 'codex-job-1234',
        session: 'codex-1234',
        agent: 'codex',
        sessionLabel: undefined,
      });
      await createWorkload(getDB(), {
        ...baseInput,
        id: 'codex-job-12340',
        session: 'codex-12340',
        agent: 'codex',
        sessionLabel: undefined,
      });
    });

    async function listIds(session: string): Promise<string[]> {
      const rows = await queries().listWorkloads(
        scope('test-user'),
        MAX_LIST_LIMIT,
        {
          session,
        },
      );
      return rows.map((d) => d.id);
    }

    async function listIdsExact(session: string): Promise<string[]> {
      const rows = await queries().listWorkloads(
        scope('test-user'),
        MAX_LIST_LIMIT,
        {
          session,
          sessionExact: true,
        },
      );
      return rows.map((d) => d.id);
    }

    it('matches the exact raw session id', async () => {
      expect(await listIds(SESSION)).toEqual(['g1-polar-cocain10']);
    });

    it('matches a bare session id prefix (the 6-char hash)', async () => {
      expect(await listIds('74e6d7')).toEqual(['g1-polar-cocain10']);
    });

    it('matches the displayed agent:<prefix> form (claude:74e6d7)', async () => {
      // The SESSION column shows unlabeled sessions as `<agent>:<6-char>`, so
      // copying that cell verbatim into --session must work too.
      expect(await listIds('claude:74e6d7')).toEqual(['g1-polar-cocain10']);
    });

    it('agent:<prefix> enforces the agent (cursor:74e6d7 matches nothing)', async () => {
      expect(await listIds('cursor:74e6d7')).toEqual([]);
    });

    it('matches the friendly session label shown in the SESSION column', async () => {
      expect(await listIds('gas-pipeline-tautomer-refactor')).toEqual([
        'g1-polar-cocain10',
      ]);
    });

    it('returns nothing for a session that matches no row', async () => {
      expect(await listIds('nope')).toEqual([]);
    });

    it('fuzzy match prefix-matches longer synthesized ids (default)', async () => {
      expect((await listIds('codex-1234')).sort()).toEqual(
        ['codex-job-1234', 'codex-job-12340'].sort(),
      );
    });

    it('exact match (sessionExact) does not prefix-match longer ids', async () => {
      expect(await listIdsExact('codex-1234')).toEqual(['codex-job-1234']);
    });

    it('treats LIKE metacharacters literally (no wildcard injection)', async () => {
      // `%` / `_` must be literal prefixes, not match-anything wildcards.
      expect(await listIds('%')).toEqual([]);
      expect(await listIds('_')).toEqual([]);
    });
  });

  // Workload cost is aggregated from vms.price_per_hour (set when the attempt is registered).
  // Verify the JOIN across one and many VM rows, and that an unpriced VM
  // contributes zero cost but still counts toward vmDurationMs (so the CLI can
  // detect "rate unavailable").
  describe('totalCost JOIN', () => {
    const baseInput = {
      userId: 'test-user',
      workloadType: 'job' as const,
      image: 'alpine:latest',
      cloudProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.medium',
      dockerCommand: 'docker run alpine',
      sshPrivateKey: 'ssh-ed25519-test-private-key',
      credentialId: 'test-credential-id',
    };

    it('reads back the type each VM launched as', async () => {
      await createWorkload(getDB(), {
        ...baseInput,
        id: 'vt-1',
        vmType: ['m7i.xlarge', 'm8i.xlarge'],
      });
      await provisionTestVm(
        'vt-1',
        { ip: '1.2.3.4', cloudId: 'vm-a' },
        // An attempt keeps the head of its ordered fallback list.
        { region: 'us-east-1', vmType: ['m8i.xlarge', 'm7i.xlarge'] },
      );
      const [vm] = await queries().getVMs('vt-1');
      expect(vm?.vmType).toBe('m8i.xlarge');
      expect((await queries().getWorkload('vt-1'))?.vmType).toEqual([
        'm7i.xlarge',
        'm8i.xlarge',
      ]);
    });

    it('listWorkloads returns totalCost = SUM(price × duration)', async () => {
      await createWorkload(getDB(), { ...baseInput, id: 'tc-2' });
      // Two VMs at different prices; end both quickly so the duration is real.
      await provisionTestVm(
        'tc-2',
        { ip: '1.2.3.4', cloudId: 'vm-a' },
        { region: 'us-east-1', pricePerHour: 2.0 },
      );
      await new Promise((r) => setTimeout(r, 25));
      await releaseTestVms('tc-2', 'vm-a');
      await provisionTestVm(
        'tc-2',
        { ip: '5.6.7.8', cloudId: 'vm-b' },
        { region: 'us-west-2', pricePerHour: 4.0 },
      );
      await new Promise((r) => setTimeout(r, 25));
      await releaseTestVms('tc-2', 'vm-b');

      const [d] = await queries().listWorkloads(scope('test-user'));
      expect(d.totalCost).not.toBeNull();
      // Both VMs ran for ≥20ms; floor is (2 × 0.02 + 4 × 0.02) / 3600 ≈ 3.3e-5
      // (price is per hour; durations here are ms — see the / 3600000 in the JOIN).
      expect(d.totalCost!).toBeGreaterThan(0);
      expect(d.totalCost!).toBeLessThan(0.01);
    });

    it('an unpriced VM (NULL price_per_hour) contributes 0 to totalCost but counts toward vmDurationMs', async () => {
      await createWorkload(getDB(), { ...baseInput, id: 'tc-3' });
      await provisionTestVm(
        'tc-3',
        { ip: '1.2.3.4', cloudId: 'vm-1' },
        { region: 'us-east-1' }, // pricePerHour omitted — column stays NULL
      );
      await new Promise((r) => setTimeout(r, 25));
      await releaseTestVms('tc-3', 'vm-1');

      const [d] = await queries().listWorkloads(scope('test-user'));
      expect(d.totalCost).toBe(0);
      expect(d.vmDurationMs!).toBeGreaterThan(0);
    });

    // When the cost-calculation monitor writes a real billed cost to v.cost,
    // it replaces the catalog estimate for that VM. Mixed workloads (some
    // VMs reconciled, some not) sum honestly: actual where we have it,
    // estimate elsewhere. cost_source reports 'actual' only when no priced VM
    // (live or ended) is still awaiting its billing-reconciled cost.
    it('vms.cost overrides the price_per_hour estimate when present', async () => {
      await createWorkload(getDB(), { ...baseInput, id: 'tc-cost-1' });
      await provisionTestVm(
        'tc-cost-1',
        { ip: '1.2.3.4', cloudId: 'vm-1' },
        {
          region: 'us-east-1',
          pricePerHour: 2.0, // estimate would dominate without v.cost
        },
      );
      await releaseTestVms('tc-cost-1', 'vm-1');
      await settleVmCost('vm-1', 42.5);

      const [d] = await queries().listWorkloads(scope('test-user'));
      expect(d.totalCost).toBe(42.5);
      expect(d.costSource).toBe('actual');
    });

    it('mixed-state workload: cost = SUM(real where reconciled, estimate elsewhere)', async () => {
      await createWorkload(getDB(), { ...baseInput, id: 'tc-cost-mix' });
      await provisionTestVm(
        'tc-cost-mix',
        { ip: '1.2.3.4', cloudId: 'vm-real' },
        { region: 'us-east-1', pricePerHour: 100.0 },
      );
      await releaseTestVms('tc-cost-mix', 'vm-real');
      await settleVmCost('vm-real', 7.0);

      // Second VM: ended without ever being reconciled → falls back to estimate.
      await provisionTestVm(
        'tc-cost-mix',
        { ip: '5.6.7.8', cloudId: 'vm-est' },
        {
          region: 'us-west-2',
          pricePerHour: 3600.0, // $1/sec to make the estimate easy to spot
        },
      );
      await new Promise((r) => setTimeout(r, 30));
      await releaseTestVms('tc-cost-mix', 'vm-est');

      const [d] = await queries().listWorkloads(scope('test-user'));
      // Estimate portion is ≥ 3600 × 0.03s/3600 = 0.03; real portion = 7.0.
      // Sum is 7 + something small.
      expect(d.totalCost!).toBeGreaterThan(7.0);
      expect(d.totalCost!).toBeLessThan(7.5);
      // Not all priced terminal VMs have v.cost set → estimated.
      expect(d.costSource).toBe('estimated');
    });

    it('costSource = estimated when no VMs have been reconciled', async () => {
      await createWorkload(getDB(), { ...baseInput, id: 'tc-cost-none' });
      await provisionTestVm(
        'tc-cost-none',
        { ip: '1.2.3.4', cloudId: 'vm-x' },
        { region: 'us-east-1', pricePerHour: 1.0 },
      );
      await releaseTestVms('tc-cost-none', 'vm-x');

      const [d] = await queries().listWorkloads(scope('test-user'));
      expect(d.costSource).toBe('estimated');
    });

    it('costSource = estimated while a live priced VM accrues catalog estimate', async () => {
      await createWorkload(getDB(), { ...baseInput, id: 'tc-cost-active' });
      // Terminal, reconciled.
      await provisionTestVm(
        'tc-cost-active',
        { ip: '1.2.3.4', cloudId: 'vm-done' },
        { region: 'us-east-1', pricePerHour: 1.0 },
      );
      await releaseTestVms('tc-cost-active', 'vm-done');
      await settleVmCost('vm-done', 4.0);
      // Live priced VM — accrues price × duration, which is an estimate until
      // billing reconciles it, so the whole total is marked estimated.
      await provisionTestVm(
        'tc-cost-active',
        { ip: '5.6.7.8', cloudId: 'vm-live' },
        { region: 'us-east-1', pricePerHour: 1.0 },
      );

      const [d] = await queries().listWorkloads(scope('test-user'));
      expect(d.costSource).toBe('estimated');
    });

    it('costSource = actual when the only unreconciled VM is unpriced (contributes no estimate)', async () => {
      await createWorkload(getDB(), { ...baseInput, id: 'tc-cost-unpriced' });
      await provisionTestVm(
        'tc-cost-unpriced',
        { ip: '1.2.3.4', cloudId: 'vm-done' },
        { region: 'us-east-1', pricePerHour: 1.0 },
      );
      await releaseTestVms('tc-cost-unpriced', 'vm-done');
      await settleVmCost('vm-done', 4.0);
      // Live VM without a catalog price — adds nothing to total_cost, so the
      // total remains fully billing-derived.
      await provisionTestVm(
        'tc-cost-unpriced',
        { ip: '5.6.7.8', cloudId: 'vm-live' },
        { region: 'us-east-1' },
      );

      const [d] = await queries().listWorkloads(scope('test-user'));
      expect(d.totalCost).toBe(4.0);
      expect(d.costSource).toBe('actual');
    });
  });

  // Billable time still runs to ended_at — the provider charges the customer's
  // own account until it releases the machine. What is new is being able to say
  // how much of that was spent waiting, after the releasing marker is gone.
  describe('awaiting-release attribution', () => {
    const baseInput = {
      userId: 'test-user',
      workloadType: 'job' as const,
      image: 'alpine:latest',
      cloudProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.medium',
      dockerCommand: 'docker run alpine',
      sshPrivateKey: 'ssh-ed25519-test-private-key',
      credentialId: 'test-credential-id',
    };
    const MINUTE = 60_000;

    /** Place one priced VM row on an exact timeline. */
    const seedVm = async (
      id: string,
      cloudId: string,
      times: {
        createdAt: number;
        endedAt?: number | null;
        removalRequestedAt?: number | null;
      },
    ) => {
      await createWorkload(getDB(), { ...baseInput, id });
      await provisionTestVm(
        id,
        { ip: '1.2.3.4', cloudId },
        { region: 'us-east-1', pricePerHour: 3600 }, // $1/second
      );
      await getDB().query(
        `UPDATE vms SET created_at = ?, ended_at = ?, removal_requested_at = ?
         WHERE workload_id = ? AND cloud_id = ?`,
        [
          times.createdAt,
          times.endedAt ?? null,
          times.removalRequestedAt ?? null,
          id,
          cloudId,
        ],
      );
      return queries();
    };

    it('reports the post-request wait without changing billable time or cost', async () => {
      const now = Date.now();
      // A real overrun: asked at T-30m, provider confirmed 26m later.
      const store = await seedVm('ar-overrun', 'vm-overrun', {
        createdAt: now - 60 * MINUTE,
        removalRequestedAt: now - 30 * MINUTE,
        endedAt: now - 4 * MINUTE,
      });

      const d = await store.getWorkload('ar-overrun');
      // Unchanged: this is what the provider billed.
      expect(d!.vmDurationMs).toBe(56 * MINUTE);
      expect(d!.totalCost).toBeCloseTo(56 * 60, 5);
      // New: how much of it was spent waiting.
      expect(d!.awaitingReleaseMs).toBe(26 * MINUTE);
    });

    it('reports zero when no removal was requested', async () => {
      const now = Date.now();
      const store = await seedVm('ar-none', 'vm-none', {
        createdAt: now - 20 * MINUTE,
        endedAt: now - 5 * MINUTE,
      });

      const d = await store.getWorkload('ar-none');
      expect(d!.vmDurationMs).toBe(15 * MINUTE);
      expect(d!.awaitingReleaseMs).toBe(0);
    });

    it('keeps counting the wait while the provider has still not released', async () => {
      const now = Date.now();
      const store = await seedVm('ar-live', 'vm-live', {
        createdAt: now - 40 * MINUTE,
        removalRequestedAt: now - 10 * MINUTE,
        endedAt: null,
      });

      const d = await store.getWorkload('ar-live');
      expect(d!.awaitingReleaseMs).toBeGreaterThanOrEqual(10 * MINUTE);
      expect(d!.awaitingReleaseMs).toBeLessThan(11 * MINUTE);
      // Still un-ended, so the releasing marker still applies.
      expect(d!.vmCount).toBe(1);
    });

    it('never reports more wait than the row has existed', async () => {
      const now = Date.now();
      // Invariant, not a live path: the reopen paths clear the stamp, so a
      // workload row cannot carry a request older than its created_at. Pinned
      // because the expression would otherwise overstate the wait if one did.
      const store = await seedVm('ar-clamped', 'vm-clamped', {
        createdAt: now - 5 * MINUTE,
        removalRequestedAt: now - 90 * MINUTE,
        endedAt: now - MINUTE,
      });

      const d = await store.getWorkload('ar-clamped');
      expect(d!.awaitingReleaseMs).toBe(4 * MINUTE);
      expect(d!.awaitingReleaseMs).toBeLessThanOrEqual(d!.vmDurationMs!);
    });
  });

  // getWorkload shares the vms-aggregate JOIN with listWorkloads so the
  // The workload item route can surface billable duration and cost for a single
  // workload.
  describe('getWorkload aggregates', () => {
    const baseInput = {
      userId: 'test-user',
      workloadType: 'job' as const,
      image: 'alpine:latest',
      cloudProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.medium',
      dockerCommand: 'docker run alpine',
      sshPrivateKey: 'ssh-ed25519-test-private-key',
      credentialId: 'test-credential-id',
    };

    it('returns duration and estimated cost for a priced, ended VM', async () => {
      await createWorkload(getDB(), { ...baseInput, id: 'gd-1' });
      await provisionTestVm(
        'gd-1',
        { ip: '1.2.3.4', cloudId: 'vm-1' },
        { region: 'us-east-1', pricePerHour: 2.0 },
      );
      await new Promise((r) => setTimeout(r, 25));
      await releaseTestVms('gd-1', 'vm-1');

      const d = await queries().getWorkload('gd-1');
      expect(d!.vmDurationMs!).toBeGreaterThan(0);
      expect(d!.totalCost!).toBeGreaterThan(0);
      expect(d!.costSource).toBe('estimated');
    });

    it('returns the reconciled billed cost as actual', async () => {
      await createWorkload(getDB(), { ...baseInput, id: 'gd-2' });
      await provisionTestVm(
        'gd-2',
        { ip: '1.2.3.4', cloudId: 'vm-1' },
        { region: 'us-east-1', pricePerHour: 2.0 },
      );
      await releaseTestVms('gd-2', 'vm-1');
      await settleVmCost('vm-1', 42.5);

      const d = await queries().getWorkload('gd-2');
      expect(d!.totalCost).toBe(42.5);
      expect(d!.costSource).toBe('actual');
    });

    it('accrues duration and cost for a live VM', async () => {
      await createWorkload(getDB(), { ...baseInput, id: 'gd-3' });
      await provisionTestVm(
        'gd-3',
        { ip: '1.2.3.4', cloudId: 'vm-1' },
        { region: 'us-east-1', pricePerHour: 2.0 },
      );
      await new Promise((r) => setTimeout(r, 25));

      const d = await queries().getWorkload('gd-3');
      expect(d!.vmCount).toBe(1);
      expect(d!.vmDurationMs!).toBeGreaterThan(0);
      expect(d!.totalCost!).toBeGreaterThan(0);
      // A live VM's accrual is price × duration — an estimate by definition.
      expect(d!.costSource).toBe('estimated');
    });

    it('excludes failed-provisioning placeholder rows', async () => {
      await createWorkload(getDB(), { ...baseInput, id: 'gd-4' });
      await provisionTestVm(
        'gd-4',
        { cloudId: 'vm-failed' },
        { region: 'us-east-1' },
      );

      const d = await queries().getWorkload('gd-4');
      expect(d!.vmCount).toBe(0);
      expect(d!.vmDurationMs).toBe(0);
      expect(d!.totalCost).toBe(0);
    });

    it('returns zero aggregates for a workload with no VMs', async () => {
      await createWorkload(getDB(), { ...baseInput, id: 'gd-5' });

      const d = await queries().getWorkload('gd-5');
      expect(d!.vmCount).toBe(0);
      expect(d!.vmDurationMs).toBe(0);
      expect(d!.totalCost).toBe(0);
    });
  });

  // latestMessage hangs the most recent workload_event's metadata.message
  // off the listWorkloads JOIN so `anycloud list` can surface soft-block
  // reasons (budget/throttle) without a second round-trip.
  describe('latestMessage on listWorkloads', () => {
    const baseInput = {
      userId: 'test-user',
      workloadType: 'job' as const,
      image: 'alpine:latest',
      cloudProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.medium',
      dockerCommand: 'docker run alpine',
      sshPrivateKey: 'ssh-ed25519-test-private-key',
      credentialId: 'test-credential-id',
    };

    it('returns null when no event has a message', async () => {
      await createWorkload(getDB(), { ...baseInput, id: 'lm-1' });
      const [d] = await queries().listWorkloads(scope('test-user'));
      expect(d.latestMessage).toBeNull();
    });

    it('returns the most recent Queued event message', async () => {
      await createWorkload(getDB(), { ...baseInput, id: 'lm-2' });
      await eventLog().recordQueuedBlockReason(
        'lm-2',
        'blocked by daily budget',
      );

      const [d] = await queries().listWorkloads(scope('test-user'));
      expect(d.latestMessage).toBe('blocked by daily budget');
    });

    it('is superseded by a later non-message event', async () => {
      await createWorkload(getDB(), { ...baseInput, id: 'lm-3' });
      await eventLog().recordQueuedBlockReason(
        'lm-3',
        'blocked by hourly throttle',
      );
      // Later event has no `message`; latestMessage should drop back to null.
      await getDB().query(
        `INSERT INTO workload_events (workload_id, state, metadata, created_at)
         VALUES (?, ?, ?, ?)`,
        ['lm-3', WorkloadState.Provisioning, null, Date.now() + 1],
      );

      const [d] = await queries().listWorkloads(scope('test-user'));
      expect(d.latestMessage).toBeNull();
    });

    it('names a capacity or quota cause for the latest retry', async () => {
      for (const [id, diagnosis, expected] of [
        ['lm-cap', 'capacity-exhausted', 'waiting for capacity'],
        [
          'lm-quota',
          'account-regional-spot-quota-exhausted',
          'waiting for quota',
        ],
        ['lm-other', 'transient', null],
      ] as const) {
        await createWorkload(getDB(), { ...baseInput, id });
        await getDB().query(
          `INSERT INTO workload_events (workload_id, state, metadata, created_at)
           VALUES (?, ?, ?, ?)`,
          [
            id,
            WorkloadState.Retrying,
            JSON.stringify({ diagnosis }),
            Date.now() + 1,
          ],
        );
        const listed = await queries().listWorkloads(scope('test-user'));
        expect(listed.find((row) => row.id === id)?.latestMessage).toBe(
          expected,
        );
      }
    });
  });

  // listWorkloads bounds the workload set in a derived table BEFORE the vms
  // join / aggregates / correlated subqueries. These guard that the
  // bound-before-aggregate path returns exactly the limited set with the same
  // per-workload aggregates the post-aggregate-limit shape produced.
  describe('listWorkloads two-phase bounding', () => {
    const baseInput = {
      userId: 'test-user',
      workloadType: 'job' as const,
      image: 'alpine:latest',
      cloudProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.medium',
      dockerCommand: 'docker run alpine',
      sshPrivateKey: 'ssh-ed25519-test-private-key',
      credentialId: 'test-credential-id',
    };

    it('limit > 0 returns the N most-recent TERMINAL workloads with aggregates scoped to the bounded set', async () => {
      // Five terminated workloads oldest→newest (5ms apart → distinct
      // started_at), each with one live priced VM and a block-reason event.
      const ids = ['tp-1', 'tp-2', 'tp-3', 'tp-4', 'tp-5'];
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        await createWorkload(getDB(), { ...baseInput, id });
        await provisionTestVm(
          id,
          { ip: `10.0.0.${i + 1}`, cloudId: `vm-${id}` },
          { region: 'us-east-1', pricePerHour: 1.0 },
        );
        // The terminal event itself carries the message, which is how the
        // Invalid/Failed paths publish one. Appending a Queued event after a
        // terminal one would leave cleanup unable to claim the workload.
        await walkToState(id, WorkloadState.Completed);
        await getDB().query(
          `UPDATE workload_events
             SET metadata = ?
           WHERE id = (
             SELECT id FROM workload_events
             WHERE workload_id = ?
             ORDER BY id DESC LIMIT 1
           )`,
          [JSON.stringify({ message: `reason-${id}` }), id],
        );
        await new Promise((r) => setTimeout(r, 5));
      }

      const rows = await queries().listWorkloads(scope('test-user'), 3);
      // Exactly the 3 newest, in started_at DESC order; tp-1/tp-2 excluded.
      expect(rows.map((d) => d.id)).toEqual(['tp-5', 'tp-4', 'tp-3']);
      // Aggregates are correct per workload (not smeared across the join).
      for (const d of rows) {
        expect(d.vmCount).toBe(1);
        expect(d.totalCost).toBeGreaterThan(0);
        expect(d.costSource).toBe('estimated');
        expect(d.latestMessage).toBe(`reason-${d.id}`);
      }
    });

    it('explicit limit caps ACTIVE_STATES rows too — the newest N survive, not all of them', async () => {
      // Regression test for the reported bug: an active-heavy EXPLICIT
      // request (e.g. --status running -n 2) must still respect the
      // requested cap instead of returning every active row regardless of
      // what was asked. limitExplicit: true is what the route sets whenever
      // the client actually sent a limit.
      const ids = ['ta-1', 'ta-2', 'ta-3', 'ta-4', 'ta-5'];
      for (const id of ids) {
        await createWorkload(getDB(), { ...baseInput, id });
        await new Promise((r) => setTimeout(r, 5));
      }

      const rows = await queries().listWorkloads(scope('test-user'), 2, {
        limitExplicit: true,
      });
      expect(rows.map((d) => d.id)).toEqual(['ta-5', 'ta-4']);
    });

    it('default (non-explicit) limit never truncates ACTIVE_STATES rows, however many there are', async () => {
      // Nobody asked for "at most N" here — this is the server's own
      // default page size, so an active-heavy account (e.g. a 200+-node
      // training fleet) must not have live workloads silently dropped.
      const ids = ['ta-1', 'ta-2', 'ta-3', 'ta-4', 'ta-5'];
      for (const id of ids) {
        await createWorkload(getDB(), { ...baseInput, id });
      }

      const rows = await queries().listWorkloads(scope('test-user'), 2);
      expect(rows.map((d) => d.id).sort()).toEqual([...ids].sort());
    });

    it('ACTIVE_STATES rows all survive when they fit within an explicit limit', async () => {
      const ids = ['tf-1', 'tf-2'];
      for (const id of ids) {
        await createWorkload(getDB(), { ...baseInput, id });
      }

      const rows = await queries().listWorkloads(scope('test-user'), 5, {
        limitExplicit: true,
      });
      expect(rows.map((d) => d.id).sort()).toEqual([...ids].sort());
    });

    it('active rows fill the limit budget first; terminal rows fill what remains', async () => {
      const seed = async (
        id: string,
        startedAt: number,
        state: WorkloadState,
      ) => {
        await createWorkload(getDB(), { ...baseInput, id });
        await walkToState(id, state);
        await getDB().query(
          'UPDATE workloads SET started_at = ? WHERE id = ?',
          [startedAt, id],
        );
      };
      const now = Date.now();
      // Two active workloads, both older than every terminal row below —
      // recency only matters for ordering within a bucket, not for priority
      // between active and terminal.
      await seed('mix-active-old', now - 6000, WorkloadState.Running);
      await seed('mix-active-new', now - 5500, WorkloadState.Queued);
      // Five terminal workloads, oldest→newest.
      await seed('mix-term-1', now - 5000, WorkloadState.Completed);
      await seed('mix-term-2', now - 4000, WorkloadState.Completed);
      await seed('mix-term-3', now - 3000, WorkloadState.Completed);
      await seed('mix-term-4', now - 2000, WorkloadState.Completed);
      await seed('mix-term-5', now - 1000, WorkloadState.Completed);

      const rows = await queries().listWorkloads(scope('test-user'), 3);
      // Both active rows claim 2 of the 3 slots (active always wins budget
      // first), leaving 1 slot for the single newest terminal row —
      // mix-term-1..4 excluded despite existing. Final order is still
      // newest-first across the combined set.
      expect(rows.map((d) => d.id)).toEqual([
        'mix-term-5',
        'mix-active-new',
        'mix-active-old',
      ]);
    });

    it('reproduces the reported bug: a live workload survives a session with ~200 rapid-fire terminal ones', async () => {
      const seedAt = async (
        id: string,
        startedAt: number,
        state: WorkloadState,
      ) => {
        await createWorkload(getDB(), { ...baseInput, id });
        if (state !== WorkloadState.Queued) {
          await walkToState(id, state);
        }
        await getDB().query(
          'UPDATE workloads SET started_at = ? WHERE id = ?',
          [startedAt, id],
        );
      };
      const now = Date.now();
      // One long-running active workload, started well before the burst
      // below — mirrors the reported case (a single sustained live VM,
      // claude:6f66e8, showing real $/hr spend).
      await seedAt('live-vm', now - 1_000_000, WorkloadState.Running);
      // A 250-workload rapid-fire job-array session, all newer than the
      // live VM — mirrors the reported case (~198 jobs from one session,
      // dimer-inter-training-task1, created in a burst).
      for (let i = 0; i < 250; i++) {
        await seedAt(
          `term-${i}`,
          now - (250 - i) * 1000,
          WorkloadState.Completed,
        );
      }

      // The actual default: `anycloud list` with no explicit -n.
      const rows = await queries().listWorkloads(
        scope('test-user'),
        DEFAULT_LIST_LIMIT,
      );
      const ids = rows.map((d) => d.id);

      expect(rows).toHaveLength(DEFAULT_LIST_LIMIT);
      expect(ids).toContain('live-vm');
      // The oldest 51 terminal rows are correctly evicted to make room for
      // the live VM — only it plus the newest 199 terminal rows fit in 200.
      expect(ids).not.toContain('term-0');
      expect(ids).not.toContain('term-50');
      expect(ids).toContain('term-51');
      expect(ids).toContain('term-249');
    });
  });

  describe('workload list windows', () => {
    const baseInput = {
      userId: 'test-user',
      workloadType: 'job' as const,
      image: 'alpine:latest',
      cloudProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.medium',
      dockerCommand: 'docker run alpine',
      sshPrivateKey: 'ssh-ed25519-test-private-key',
      credentialId: 'test-credential-id',
    };
    const HOUR = 60 * 60 * 1000;
    const DAY = 24 * HOUR;

    // started_at is stamped at insert; backdate it directly so we can place a
    // workload on either side of a window boundary.
    const seedAt = async (
      id: string,
      startedAt: number,
      overrides: Partial<CreateWorkloadInput> = {},
    ) => {
      await createWorkload(getDB(), { ...baseInput, id, ...overrides });
      await walkToState(id, WorkloadState.Completed);
      await getDB().query(
        'UPDATE workloads SET started_at = ?, completed_at = ? WHERE id = ?',
        [startedAt, startedAt + 1000, id],
      );
    };

    it('sinceMs returns only workloads started at/after the cutoff', async () => {
      const now = Date.now();
      await seedAt('win-recent', now - HOUR);
      await seedAt('win-old', now - 25 * HOUR);
      await seedAt('win-ancient', now - 8 * DAY);

      const ids = (
        await queries().listWorkloads(scope('test-user'), 50, {
          sinceMs: now - DAY,
        })
      ).map((d) => d.id);
      expect(ids).toContain('win-recent');
      expect(ids).not.toContain('win-old');
      expect(ids).not.toContain('win-ancient');
    });
  });

  describe('listVms', () => {
    const baseInput = {
      userId: 'test-user',
      workloadType: 'job' as const,
      image: 'alpine:latest',
      cloudProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.medium',
      dockerCommand: 'docker run alpine',
      sshPrivateKey: 'ssh-ed25519-test-private-key',
      credentialId: 'test-credential-id',
    };

    it('stores and returns a complete SSH endpoint in every VM read path', async () => {
      await createWorkload(getDB(), { ...baseInput, id: 'lv-active' });
      await provisionTestVm('lv-active', {
        ip: '1.2.3.4',
        cloudId: 'cloud-live',
      });

      await expect(
        getDB().query<{
          ssh_host: string | null;
          ssh_port: number | null;
          ssh_username: string | null;
        }>(
          'SELECT ssh_host, ssh_port, ssh_username FROM vms WHERE workload_id = ?',
          ['lv-active'],
        ),
      ).resolves.toEqual([
        {
          ssh_host: '1.2.3.4',
          ssh_port: 22,
          ssh_username: 'root',
        },
      ]);

      const expected = {
        cloudId: 'cloud-live',
        endedAt: null,
        sshHost: '1.2.3.4',
        sshPort: 22,
        sshUsername: 'root',
      };
      expect(await queries().getVMs('lv-active')).toMatchObject([expected]);
      expect(await queries().listVms('lv-active')).toMatchObject([expected]);
    });

    it('hydrates legacy nullable SSH fields consistently in every VM read path', async () => {
      await createWorkload(getDB(), { ...baseInput, id: 'lv-legacy-ssh' });
      await provisionTestVm('lv-legacy-ssh', {
        ip: '1.2.3.5',
        cloudId: 'cloud-legacy',
      });
      await getDB().query(
        `UPDATE vms
         SET ssh_host = NULL, ssh_port = NULL, ssh_username = NULL
         WHERE workload_id = ?`,
        ['lv-legacy-ssh'],
      );

      const expected = {
        cloudId: 'cloud-legacy',
        endedAt: null,
        sshHost: '1.2.3.5',
        sshPort: 22,
        sshUsername: 'root',
      };
      expect(await queries().getVMs('lv-legacy-ssh')).toMatchObject([expected]);
      expect(await queries().listVms('lv-legacy-ssh')).toMatchObject([
        expected,
      ]);
    });

    it('hydrates a mapped port without requiring redundant host or username facts', async () => {
      await createWorkload(getDB(), { ...baseInput, id: 'lv-mapped-port' });
      await provisionTestVm('lv-mapped-port', {
        ip: 'localhost',
        cloudId: 'ac-local-lv-mapped-port-0',
        sshPort: 22022,
      });

      expect(await queries().getVMs('lv-mapped-port')).toMatchObject([
        {
          sshHost: 'localhost',
          sshPort: 22022,
          sshUsername: 'root',
        },
      ]);
    });

    it('rejects a malformed VM row without an IP during hydration', async () => {
      const store = queries();
      vi.spyOn(getDB(), 'query').mockResolvedValueOnce([{ ip: null }] as never);

      await expect(store.getVMs('malformed-vm')).rejects.toThrow(
        'Cannot hydrate a VM without an IP address',
      );
    });

    it('persists non-root SSH endpoint usernames for active and historical VM reads', async () => {
      await createWorkload(getDB(), { ...baseInput, id: 'lv-ssh-user' });
      await provisionTestVm('lv-ssh-user', {
        ip: '127.0.0.1',
        cloudId: 'ns/pod',
        sshHost: '127.0.0.1',
        sshPort: 31022,
        sshUsername: 'acuser',
      });

      const active = await queries().getVMs('lv-ssh-user');
      expect(active[0]).toMatchObject({
        sshHost: '127.0.0.1',
        sshPort: 31022,
        sshUsername: 'acuser',
      });

      const historical = await queries().listVms('lv-ssh-user');
      expect(historical[0]).toMatchObject({
        sshHost: '127.0.0.1',
        sshPort: 31022,
        sshUsername: 'acuser',
      });
    });

    it('persists bucket host paths for active and historical VM reads', async () => {
      const bucketHostPaths = {
        input: '/var/lib/anycloud/deployments/input',
        output: '/var/lib/anycloud/deployments/output',
        checkpoint: '/var/lib/anycloud/deployments/checkpoint',
      };
      await createWorkload(getDB(), { ...baseInput, id: 'lv-bucket-paths' });
      await provisionTestVm(
        'lv-bucket-paths',
        {
          ip: '1.2.3.4',
          cloudId: 'cloud-bucket-paths',
        },
        { bucketHostPaths },
      );

      expect(await queries().getVMs('lv-bucket-paths')).toMatchObject([
        {
          inputHostPath: bucketHostPaths.input,
          outputHostPath: bucketHostPaths.output,
          checkpointHostPath: bucketHostPaths.checkpoint,
        },
      ]);
      expect(await queries().listVms('lv-bucket-paths')).toMatchObject([
        {
          inputHostPath: bucketHostPaths.input,
          outputHostPath: bucketHostPaths.output,
          checkpointHostPath: bucketHostPaths.checkpoint,
        },
      ]);
    });

    it('falls back to legacy /mnt bucket paths when a VM row has none', async () => {
      await createWorkload(getDB(), { ...baseInput, id: 'lv-legacy-paths' });
      await getDB().query(
        `INSERT INTO vms (workload_id, cloud_id, ip, created_at)
         VALUES (?, ?, ?, ?)`,
        ['lv-legacy-paths', 'cloud-legacy-paths', '1.2.3.4', Date.now()],
      );

      expect(await queries().getVMs('lv-legacy-paths')).toMatchObject([
        {
          inputHostPath: '/mnt/input',
          outputHostPath: '/mnt/output',
          checkpointHostPath: '/mnt/checkpoint',
        },
      ]);
    });

    it('returns terminated VMs with endedAt populated', async () => {
      await createWorkload(getDB(), { ...baseInput, id: 'lv-done' });
      await provisionTestVm('lv-done', {
        ip: '1.2.3.4',
        cloudId: 'cloud-done',
      });
      await releaseTestVms('lv-done', 'cloud-done');

      const vms = await queries().listVms('lv-done');
      expect(vms).toHaveLength(1);
      expect(vms[0].cloudId).toBe('cloud-done');
      expect(vms[0].endedAt).not.toBeNull();
      expect(typeof vms[0].endedAt).toBe('number');
    });

    it('returns mixed active + terminated in created_at order', async () => {
      await createWorkload(getDB(), { ...baseInput, id: 'lv-mixed' });
      // First VM created, terminated.
      await provisionTestVm('lv-mixed', {
        ip: '1.2.3.4',
        cloudId: 'cloud-first',
      });
      await releaseTestVms('lv-mixed', 'cloud-first');
      // Tiny delay so created_at differs.
      await new Promise((r) => setTimeout(r, 5));
      // Second VM, still live.
      await provisionTestVm('lv-mixed', {
        ip: '5.6.7.8',
        cloudId: 'cloud-second',
      });

      const vms = await queries().listVms('lv-mixed');
      expect(vms).toHaveLength(2);
      expect(vms[0].cloudId).toBe('cloud-first');
      expect(vms[0].endedAt).not.toBeNull();
      expect(vms[1].cloudId).toBe('cloud-second');
      expect(vms[1].endedAt).toBeNull();
    });

    it('excludes failed-provisioning rows (ip IS NULL)', async () => {
      // A failed launch leaves rows with cloud_id but ip=NULL to track
      // partially-created cloud resources. These never represented a live VM
      // and would be noise in status output.
      await createWorkload(getDB(), { ...baseInput, id: 'lv-noip' });
      await getDB().query(
        `INSERT INTO vms (workload_id, cloud_id, ip, created_at) VALUES (?, ?, NULL, ?)`,
        ['lv-noip', 'cloud-failed', Date.now()],
      );
      await provisionTestVm('lv-noip', {
        ip: '1.2.3.4',
        cloudId: 'cloud-ok',
      });

      const vms = await queries().listVms('lv-noip');
      expect(vms.map((v) => v.cloudId)).toEqual(['cloud-ok']);
    });
  });

  describe('VM compute provider derivation', () => {
    const baseInput = {
      userId: 'test-user',
      workloadType: 'job' as const,
      image: 'alpine:latest',
      requestedComputeProvider: CloudType.Azure,
      region: 'eastus',
      vmType: 'Standard_D2s_v5',
      dockerCommand: 'docker run alpine',
      sshPrivateKey: 'ssh-ed25519-test-private-key',
      credentialId: 'azure-provider-cred',
    };

    it('derives VM cloud provider from the VM credential', async () => {
      await upsertCredential(
        getDB(),
        'azure-provider-cred',
        'encrypted',
        CloudType.Azure,
      );
      await createWorkload(getDB(), { ...baseInput, id: 'vm-provider-cred' });
      await provisionTestVm(
        'vm-provider-cred',
        {
          ip: '1.2.3.4',
          cloudId: 'vm-provider',
        },
        {
          credentialId: 'azure-provider-cred',
        },
      );

      expect(await queries().getVMs('vm-provider-cred')).toMatchObject([
        { cloudId: 'vm-provider', cloudProvider: CloudType.Azure },
      ]);
    });

    it('falls back to the requested provider for credentialless VM rows', async () => {
      const id = 'vm-provider-local';
      await createWorkload(getDB(), {
        ...baseInput,
        id,
        requestedComputeProvider: CloudType.Local,
        region: 'local',
        vmType: 'local',
        credentialId: undefined,
      });
      await provisionTestVm(id, { ip: '1.2.3.4', cloudId: 'vm-local' });

      expect(await queries().getVMs(id)).toMatchObject([
        { cloudId: 'vm-local', cloudProvider: CloudType.Local },
      ]);
    });

    it('derives VM cloud provider across in-place recovery reinsert', async () => {
      const id = 'vm-provider-recovery';
      const bucketHostPaths = {
        input: '/var/lib/anycloud/deployments/input',
        output: '/var/lib/anycloud/deployments/output',
        checkpoint: '/var/lib/anycloud/deployments/checkpoint',
      };
      await upsertCredential(
        getDB(),
        'azure-provider-cred',
        'encrypted',
        CloudType.Azure,
      );
      await createWorkload(getDB(), { ...baseInput, id });
      await provisionTestVm(
        id,
        { ip: '1.2.3.4', cloudId: 'vm-before-recovery' },
        { credentialId: 'azure-provider-cred', bucketHostPaths },
      );
      await preemptTestVm(id, 'vm-before-recovery');

      expect(
        await lifecycle().finishPreemptionRecovery(
          id,
          WorkloadType.Job,
          'vm-before-recovery',
          { ip: '5.6.7.8', cloudId: 'vm-after-recovery' },
          { credentialId: 'azure-provider-cred' },
        ),
      ).toBe(true);
      expect(await queries().getVMs(id)).toMatchObject([
        {
          cloudId: 'vm-after-recovery',
          cloudProvider: CloudType.Azure,
          outputHostPath: bucketHostPaths.output,
          checkpointHostPath: bucketHostPaths.checkpoint,
        },
      ]);
    });
  });

  describe('resolveActiveCredentialId', () => {
    it('prefers an override, then the newest live VM, then the workload credential', async () => {
      const workload = await seedTestWorkload({
        id: 'active-credential',
        userId: 'test-user',
        credentialId: 'test-credential-id',
        state: WorkloadState.Provisioning,
      });
      expect(await queries().resolveActiveCredentialId(workload)).toBe(
        'test-credential-id',
      );
      // Insert the older VM first so the rowid order disagrees with recency.
      for (const [cloudId, credentialId, createdAt] of [
        ['vm-rotated-away', 'test-cred', 1_000],
        ['vm-replacement', 'test-cred-id', 2_000],
      ] as const) {
        await provisionTestVm(
          workload.id,
          { ip: `10.0.0.${createdAt / 1_000}`, cloudId, createdAt },
          { credentialId },
        );
      }
      await walkToState(workload.id, WorkloadState.Running);
      expect(await queries().resolveActiveCredentialId(workload)).toBe(
        'test-cred-id',
      );
      expect(
        await queries().resolveActiveCredentialId(workload, 'override-cred'),
      ).toBe('override-cred');
    });
  });

  describe('getProvisioningFailures', () => {
    const baseInput = {
      userId: 'test-user',
      workloadType: 'job' as const,
      image: 'alpine:latest',
      cloudProvider: CloudType.GCP,
      region: 'us-central1',
      vmType: 'e2-standard-2',
      dockerCommand: 'docker run alpine',
      sshPrivateKey: 'ssh-ed25519-test-private-key',
      credentialId: 'test-credential-id',
    };
    const failures = (id: string, credentialId = 'test-credential-id') =>
      queries().getProvisioningFailures(id, credentialId, CloudType.GCP);

    /** One launch attempt that never got an IP, optionally classified. */
    async function failLaunch(
      id: string,
      cloudId: string,
      attempt: AddVMAttempt,
      failure?: LaunchFailure,
    ): Promise<void> {
      await walkToState(id, WorkloadState.Provisioning);
      const ref = await provisionTestVm(id, { cloudId }, attempt);
      if (failure) await ledger().recordLaunchFailure(id, ref, failure);
      await releaseTestVms(id, cloudId);
    }

    it('returns every failed launch in ledger order, with disposition derived from the pins', async () => {
      const id = 'ledger-failure-order';
      await createWorkload(getDB(), { ...baseInput, id });
      const a2 = {
        vmType: 'a2-highgpu-1g',
        credentialId: 'test-credential-id',
      };
      await failLaunch(id, 'a2-0', { ...a2, region: 'europe-west4' });
      await failLaunch(
        id,
        'a2-1',
        { ...a2, region: 'us-central1', availabilityZone: 'us-central1-b' },
        {
          diagnosis: CloudFailureDiagnosis.CapacityExhausted,
          regionDenied: null,
        },
      );
      await failLaunch(id, 'a2-2', { ...a2, region: 'europe-west4' });
      await failLaunch(
        id,
        'a2-3',
        { ...a2, region: 'us-central1', availabilityZone: 'us-central1-b' },
        {
          diagnosis: CloudFailureDiagnosis.InvalidTarget,
          regionDenied: 'denied',
        },
      );
      await provisionTestVm(id, { cloudId: 'a2-4', ip: '10.0.0.1' }, a2);

      const unclassified = {
        credentialId: 'test-credential-id',
        vmType: 'a2-highgpu-1g',
        region: 'europe-west4',
        availabilityZone: null,
        diagnosis: null,
        disposition: null,
        spot: false,
        regionDenied: null,
      };
      // A GCP region pin without a zone pin fails over between zones.
      const zoneB = {
        ...unclassified,
        region: 'us-central1',
        availabilityZone: 'us-central1-b',
        disposition: FailureDisposition.FailoverTarget,
      };
      expect(await failures(id)).toEqual([
        unclassified,
        { ...zoneB, diagnosis: CloudFailureDiagnosis.CapacityExhausted },
        unclassified,
        {
          ...zoneB,
          diagnosis: CloudFailureDiagnosis.InvalidTarget,
          regionDenied: 'denied',
        },
      ]);
    });

    it('preserves repeated preemptions of the same target', async () => {
      const id = 'repeated-target-preemptions';
      await createWorkload(getDB(), { ...baseInput, id, spot: true });

      const attempt = {
        credentialId: 'test-credential-id',
        vmType: 'e2-standard-2',
        region: 'us-central1',
        availabilityZone: undefined,
      };
      for (const [cloudId, ip, createdAt] of [
        ['preempted-vm-1', '10.0.0.1', 1],
        ['preempted-vm-2', '10.0.0.2', 2],
      ] as const) {
        await provisionTestVm(id, { cloudId, ip, createdAt }, attempt);
        await preemptTestVm(id, cloudId);
        await releaseTestVms(id, cloudId);
        await walkToState(id, WorkloadState.Queued);
      }

      const failure = {
        credentialId: 'test-credential-id',
        vmType: 'e2-standard-2',
        region: 'us-central1',
        availabilityZone: null,
        diagnosis: null,
        disposition: null,
        spot: true,
        regionDenied: null,
      };
      expect(await failures(id)).toEqual([failure, failure]);
    });

    it('counts one preemption per VM across in-place restarts, in time order', async () => {
      let timestamp = Date.now();
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => timestamp);
      onTestFinished(() => clock.mockRestore());
      const id = 'in-place-restart-preemptions';
      await createWorkload(getDB(), { ...baseInput, id, spot: true });
      const attempt = {
        credentialId: 'test-credential-id',
        vmType: 'e2-standard-2',
        region: 'us-central1',
      };
      await provisionTestVm(
        id,
        { cloudId: 'restarted-vm', ip: '10.0.0.1' },
        attempt,
      );
      for (const ip of ['10.0.0.2', '10.0.0.3']) {
        // Distinct recovery attempts must not share a millisecond identity.
        timestamp += 1000;
        await preemptTestVm(id, 'restarted-vm');
        await lifecycle().finishPreemptionRecovery(
          id,
          'job',
          'restarted-vm',
          { cloudId: 'restarted-vm', ip },
          attempt,
        );
      }
      await preemptTestVm(id, 'restarted-vm');
      await releaseTestVms(id, 'restarted-vm');
      await failLaunch(
        id,
        'east-vm',
        { ...attempt, region: 'us-east1' },
        {
          diagnosis: CloudFailureDiagnosis.CapacityExhausted,
          regionDenied: null,
        },
      );

      expect(await failures(id)).toMatchObject([
        { region: 'us-central1', diagnosis: null, disposition: null },
        {
          region: 'us-east1',
          diagnosis: CloudFailureDiagnosis.CapacityExhausted,
          disposition: FailureDisposition.FailoverTarget,
        },
      ]);
    });

    it('keeps a preemption distinct from a classified failure on the same target', async () => {
      const id = 'classified-failure-then-preemption';
      await createWorkload(getDB(), { ...baseInput, id, spot: true });
      const attempt = {
        credentialId: 'test-credential-id',
        vmType: 'e2-standard-2',
        region: 'us-central1',
      };
      await failLaunch(id, 'failed-vm', attempt, {
        diagnosis: CloudFailureDiagnosis.CapacityExhausted,
        regionDenied: null,
      });
      await provisionTestVm(
        id,
        { cloudId: 'preempted-vm', ip: '10.0.0.1' },
        attempt,
      );
      await preemptTestVm(id, 'preempted-vm');

      expect(await failures(id)).toMatchObject([
        { diagnosis: CloudFailureDiagnosis.CapacityExhausted },
        { diagnosis: null, disposition: null },
      ]);
    });

    it('ignores an unclassified unlaunched attempt in a region where the credential has a healthy VM', async () => {
      const id = 'healthy-region-unlaunched';
      await createWorkload(getDB(), { ...baseInput, id, spot: true });
      const attempt = (
        region: string,
        credentialId = 'test-credential-id',
      ) => ({
        credentialId,
        vmType: 'e2-standard-2',
        region,
      });
      await failLaunch(id, 'central-unclassified', attempt('us-central1'));
      await failLaunch(id, 'central-classified', attempt('us-central1'), {
        diagnosis: CloudFailureDiagnosis.CapacityExhausted,
        regionDenied: null,
      });
      await failLaunch(id, 'east-unclassified', attempt('us-east1'));
      await failLaunch(id, 'west-unclassified', attempt('us-west1'));
      // us-central1 is healthy, so only its classified failure counts.
      // us-east1 has a running VM but also a preemption, so it is not healthy.
      // us-west1 is healthy only for another credential.
      for (const [cloudId, ip, region, credentialId] of [
        ['central-good', '10.0.0.1', 'us-central1', undefined],
        ['east-good', '10.0.0.2', 'us-east1', undefined],
        ['east-preempted', '10.0.0.3', 'us-east1', undefined],
        ['west-good-other', '10.0.0.4', 'us-west1', 'test-cred'],
      ] as const) {
        await provisionTestVm(
          id,
          { cloudId, ip },
          attempt(region, credentialId),
        );
      }
      await preemptTestVm(id, 'east-preempted');

      expect(await failures(id)).toMatchObject([
        {
          region: 'us-central1',
          diagnosis: CloudFailureDiagnosis.CapacityExhausted,
        },
        { region: 'us-east1', diagnosis: null },
        { region: 'us-west1', diagnosis: null },
        { region: 'us-east1', diagnosis: null },
      ]);
    });

    it('returns only failures made with the requested credential', async () => {
      const id = 'credential-scoped-failures';
      await createWorkload(getDB(), { ...baseInput, id, credentialId: null });
      for (const [credentialId, region] of [
        ['test-cred', 'us-east1'],
        ['test-cred-id', 'us-west1'],
      ] as const) {
        await failLaunch(id, `${credentialId}-vm`, {
          credentialId,
          vmType: 'a2-highgpu-1g',
          region,
        });
      }

      expect(await failures(id, 'test-cred')).toMatchObject([
        { credentialId: 'test-cred', region: 'us-east1' },
      ]);
    });

    it('keeps a VM Job region allow-list, and fails over within it as an unpinned Job', async () => {
      const id = 'ledger-regions-allow-list';
      await createWorkload(getDB(), {
        ...baseInput,
        id,
        region: undefined,
        regions: ['us-central1', 'us-east1'],
      });
      const stored = await queries().getWorkload(id);
      expect(stored).toMatchObject({
        region: null,
        regions: ['us-central1', 'us-east1'],
      });
      await failLaunch(
        id,
        'e2-0',
        {
          vmType: 'e2-standard-2',
          credentialId: 'test-credential-id',
          region: 'us-central1',
          availabilityZone: 'us-central1-b',
        },
        {
          diagnosis: CloudFailureDiagnosis.QuotaExhaustedRegion,
          regionDenied: null,
        },
      );
      // A pinned region would retry the same target; the allow-list fails over.
      expect(await failures(id)).toMatchObject([
        {
          region: 'us-central1',
          disposition: FailureDisposition.FailoverTarget,
        },
      ]);
    });
  });

  describe('vm_type persistence + readback', () => {
    const baseInput = {
      userId: 'test-user',
      workloadType: 'job' as const,
      image: 'alpine:latest',
      cloudProvider: CloudType.GCP,
      region: 'us-central1',
      vmType: 'e2-standard-2',
      dockerCommand: 'docker run alpine',
      sshPrivateKey: 'ssh-ed25519-test-private-key',
      credentialId: 'test-credential-id',
    };

    it('getLatestProvisioningConfig returns the latest attempt region + vmType', async () => {
      await createWorkload(getDB(), { ...baseInput, id: 'vt-latest' });
      // Two attempts; the latest (by created_at) wins. Backdate the first so the
      // ordering is deterministic (both inserts could land in the same ms).
      await provisionTestVm(
        'vt-latest',
        { cloudId: 'vm-old' },
        { region: 'us-east1', vmType: 'fake-a' },
      );
      await getDB().query(`UPDATE vms SET created_at = ? WHERE cloud_id = ?`, [
        Date.now() - 60_000,
        'vm-old',
      ]);
      await provisionTestVm(
        'vt-latest',
        { cloudId: 'vm-new' },
        { region: 'us-central1', vmType: 'e2-standard-2' },
      );
      const latest = await queries().getLatestProvisioningConfig('vt-latest');
      expect(latest).toMatchObject({
        region: 'us-central1',
        vmType: 'e2-standard-2',
      });
    });
  });

  // listVmsNeedingCost backs the cost-calculation monitor's eligibility query.
  // Only VMs that are: parent-terminal, ended at least billLagMs ago, and not
  // yet reconciled (vms.cost IS NULL) should be returned. The lag argument is
  // a parameter so integration tests can pass 0.
  describe('listVmsNeedingCost', () => {
    const baseInput = {
      userId: 'test-user',
      workloadType: 'job' as const,
      image: 'alpine:latest',
      cloudProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.medium',
      dockerCommand: 'docker run alpine',
      sshPrivateKey: 'ssh-ed25519-test-private-key',
      credentialId: 'test-credential-id',
    };

    it('returns VMs from terminal workloads past the lag with NULL cost', async () => {
      await createWorkload(getDB(), { ...baseInput, id: 'vc-1' });
      await provisionTestVm('vc-1', {
        ip: '1.2.3.4',
        cloudId: 'cloud-vc-1',
      });
      await releaseTestVms('vc-1', 'cloud-vc-1');
      await walkToState('vc-1', WorkloadState.Completed);

      const eligible = await listVmsNeedingCost(getDB(), Date.now());
      const ids = eligible.map((v) => v.cloud_id);
      expect(ids).toContain('cloud-vc-1');
    });

    it('skips active (non-terminal) workloads', async () => {
      await createWorkload(getDB(), { ...baseInput, id: 'vc-active' });
      await provisionTestVm('vc-active', {
        ip: '1.2.3.4',
        cloudId: 'cloud-active',
      });
      await releaseTestVms('vc-active', 'cloud-active');
      // State stays Queued — not terminal.

      const eligible = await listVmsNeedingCost(getDB(), Date.now());
      expect(eligible.map((v) => v.cloud_id)).not.toContain('cloud-active');
    });

    it('skips VMs that still have a NULL ended_at', async () => {
      await createWorkload(getDB(), { ...baseInput, id: 'vc-live' });
      await provisionTestVm('vc-live', {
        ip: '1.2.3.4',
        cloudId: 'cloud-live',
      });
      await walkToState('vc-live', WorkloadState.Completed);
      // Note: never released — VM row keeps ended_at NULL.

      const eligible = await listVmsNeedingCost(getDB(), Date.now());
      expect(eligible.map((v) => v.cloud_id)).not.toContain('cloud-live');
    });

    it('skips VMs whose bill has not settled (ended_at within lag)', async () => {
      await createWorkload(getDB(), { ...baseInput, id: 'vc-fresh' });
      await provisionTestVm('vc-fresh', {
        ip: '1.2.3.4',
        cloudId: 'cloud-fresh',
      });
      await releaseTestVms('vc-fresh', 'cloud-fresh');
      await walkToState('vc-fresh', WorkloadState.Completed);

      // 1-hour lag: the VM ended right now, well within lag.
      const eligible = await listVmsNeedingCost(
        getDB(),
        Date.now() - 60 * 60 * 1000,
      );
      expect(eligible.map((v) => v.cloud_id)).not.toContain('cloud-fresh');
    });

    it('skips VMs already reconciled (cost IS NOT NULL)', async () => {
      await createWorkload(getDB(), { ...baseInput, id: 'vc-done' });
      await provisionTestVm('vc-done', {
        ip: '1.2.3.4',
        cloudId: 'cloud-done',
      });
      await releaseTestVms('vc-done', 'cloud-done');
      await walkToState('vc-done', WorkloadState.Completed);
      await settleVmCost('cloud-done', 1.23);

      const eligible = await listVmsNeedingCost(getDB(), Date.now());
      expect(eligible.map((v) => v.cloud_id)).not.toContain('cloud-done');
    });
  });

  describe('session / agent attribution', () => {
    const baseInput = {
      userId: 'test-user',
      workloadType: 'job' as const,
      image: 'alpine:latest',
      cloudProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.medium',
      dockerCommand: 'docker run alpine',
      sshPrivateKey: 'ssh-ed25519-test-private-key',
      credentialId: 'test-credential-id',
    };

    it('defaults session/agent to null when not provided', async () => {
      await createWorkload(getDB(), { ...baseInput, id: 'attr-default' });
      const d = await queries().getWorkload('attr-default');
      expect(d?.session).toBeNull();
      expect(d?.agent).toBeNull();
    });

    it('round-trips session and agent', async () => {
      await createWorkload(getDB(), {
        ...baseInput,
        id: 'attr-stamped',
        session: 'claude-1234',
        agent: 'claude',
      });
      const d = await queries().getWorkload('attr-stamped');
      expect(d?.session).toBe('claude-1234');
      expect(d?.agent).toBe('claude');
    });

    it('listWorkloads filter narrows by agent', async () => {
      await createWorkload(getDB(), {
        ...baseInput,
        id: 'attr-claude-1',
        session: 'claude-1',
        agent: 'claude',
      });
      await createWorkload(getDB(), {
        ...baseInput,
        id: 'attr-cursor-1',
        session: 'cursor-1',
        agent: 'cursor',
      });
      await createWorkload(getDB(), { ...baseInput, id: 'attr-untagged' });

      const claudeOnly = await queries().listWorkloads(
        scope('test-user'),
        MAX_LIST_LIMIT,
        {
          agent: 'claude',
        },
      );
      expect(claudeOnly.map((d) => d.id)).toEqual(['attr-claude-1']);

      const cursorOnly = await queries().listWorkloads(
        scope('test-user'),
        MAX_LIST_LIMIT,
        {
          agent: 'cursor',
        },
      );
      expect(cursorOnly.map((d) => d.id)).toEqual(['attr-cursor-1']);
    });

    it('listWorkloads filter narrows by session id (exact)', async () => {
      await createWorkload(getDB(), {
        ...baseInput,
        id: 'attr-sess-a',
        session: 'session-a',
        agent: 'claude',
      });
      await createWorkload(getDB(), {
        ...baseInput,
        id: 'attr-sess-b',
        session: 'session-b',
        agent: 'claude',
      });

      const only = await queries().listWorkloads(
        scope('test-user'),
        MAX_LIST_LIMIT,
        {
          session: 'session-a',
        },
      );
      expect(only.map((d) => d.id)).toEqual(['attr-sess-a']);
    });

    it('listWorkloads with both filters ANDs them', async () => {
      await createWorkload(getDB(), {
        ...baseInput,
        id: 'attr-and-1',
        session: 'sx',
        agent: 'claude',
      });
      await createWorkload(getDB(), {
        ...baseInput,
        id: 'attr-and-2',
        session: 'sx',
        agent: 'cursor',
      });

      const both = await queries().listWorkloads(
        scope('test-user'),
        MAX_LIST_LIMIT,
        {
          session: 'sx',
          agent: 'cursor',
        },
      );
      expect(both.map((d) => d.id)).toEqual(['attr-and-2']);
    });

    it('null filter fields are ignored (returns everything)', async () => {
      await createWorkload(getDB(), {
        ...baseInput,
        id: 'attr-ignore-1',
        session: 'x',
      });
      await createWorkload(getDB(), { ...baseInput, id: 'attr-ignore-2' });
      const all = await queries().listWorkloads(
        scope('test-user'),
        MAX_LIST_LIMIT,
        {
          session: null,
          agent: null,
        },
      );
      expect(all.map((d) => d.id).sort()).toEqual([
        'attr-ignore-1',
        'attr-ignore-2',
      ]);
    });
  });

  describe('workload reconciler poll candidates', () => {
    const baseWorkload = {
      userId: 'test-user',
      workloadType: 'job' as const,
      image: 'alpine:latest',
      cloudProvider: CloudType.GCP,
      region: 'us-central1',
      vmType: 'n2-standard-4',
      dockerCommand: 'echo hello',
      sshPrivateKey: 'test-key',
      credentialId: 'test-cred',
      spot: true,
    };

    it('returns spot workloads in PREEMPTIBLE_STATES and excludes cleanup/no-VM states', async () => {
      // Seed one workload per PREEMPTIBLE state
      for (const state of PREEMPTIBLE_STATES) {
        const id = `spot-${state}`;
        await createWorkload(getDB(), { ...baseWorkload, id });
        await walkToState(id, state);
      }

      // States excluded: no VM yet (Queued, Provisioning) and cleanup
      // (Retrying, Recovering)
      for (const state of ACTIVE_STATES.filter(
        (s) => !PREEMPTIBLE_STATES.includes(s),
      )) {
        const id = `spot-excluded-${state}`;
        await createWorkload(getDB(), { ...baseWorkload, id });
        await walkToState(id, state);
      }

      // Non-spot running workload — excluded by spot = 1 filter
      await createWorkload(getDB(), {
        ...baseWorkload,
        id: 'non-spot-running',
        spot: false,
      });
      await walkToState('non-spot-running', WorkloadState.Running);

      // Spot workloads in terminal states — excluded by state IN (...) filter
      await createWorkload(getDB(), { ...baseWorkload, id: 'spot-failed' });
      await walkToState('spot-failed', WorkloadState.Failed);
      await createWorkload(getDB(), {
        ...baseWorkload,
        id: 'spot-terminated',
      });
      await walkToState('spot-terminated', WorkloadState.Terminated);

      const results = (
        await queries().listWorkloadReconcileCandidates()
      ).filter(
        (candidate) =>
          candidate.spot && PREEMPTIBLE_STATES.includes(candidate.state),
      );
      const ids = results.map((d) => d.id);

      expect(ids).toEqual(
        expect.arrayContaining(PREEMPTIBLE_STATES.map((s) => `spot-${s}`)),
      );
      expect(ids).toHaveLength(PREEMPTIBLE_STATES.length);
    });

    it('discovers every cleanup-needed row beyond a single 1,000-row page', async () => {
      const store = queries();
      await seedWorkloadRows(
        `INSERT INTO workloads (
           id, user_id, workload_type, state, started_at,
           completed_at, docker_command, ssh_private_key
         )
         WITH RECURSIVE sequence(n) AS (
           SELECT 0
           UNION ALL
           SELECT n + 1 FROM sequence WHERE n < 1000
         )
         SELECT printf('cleanup-needed-%04d', n),
                'test-user', 'job', 'completed', n, n + 1,
                'echo complete', ''
         FROM sequence`,
        [],
        'alpine:latest',
        ['test-user'],
      );
      await getDB().query(
        `INSERT INTO workload_events (
           workload_id, state, metadata, created_at
         )
         SELECT id, state, NULL, completed_at
         FROM workloads
         WHERE id LIKE 'cleanup-needed-%'`,
      );

      const needed = (await store.listWorkloadReconcileCandidates()).filter(
        (candidate) => candidate.id.startsWith('cleanup-needed-'),
      );

      expect(needed).toHaveLength(1001);
      expect(needed[0]?.id).toBe('cleanup-needed-0000');
      expect(needed.at(-1)?.id).toBe('cleanup-needed-1000');
    });
  });

  describe('workload reconciler running-job candidates', () => {
    const baseJob = {
      userId: 'test-user',
      workloadType: 'job' as const,
      image: 'alpine:latest',
      cloudProvider: CloudType.GCP,
      region: 'us-central1',
      vmType: 'n2-standard-4',
      dockerCommand: 'echo hello',
      sshPrivateKey: 'test-key',
      credentialId: 'test-cred',
    };

    it('returns only running jobs when mixed with non-running jobs', async () => {
      // Should be returned
      await createWorkload(getDB(), { ...baseJob, id: 'job-running-1' });
      await walkToState('job-running-1', WorkloadState.Running);
      await createWorkload(getDB(), { ...baseJob, id: 'job-running-2' });
      await walkToState('job-running-2', WorkloadState.Running);

      // Jobs in other states — excluded by state filter
      await createWorkload(getDB(), { ...baseJob, id: 'job-downloading' });
      await walkToState('job-downloading', WorkloadState.Downloading);
      await createWorkload(getDB(), { ...baseJob, id: 'job-starting' });
      await walkToState('job-starting', WorkloadState.Starting);
      await createWorkload(getDB(), { ...baseJob, id: 'job-completed' });
      await walkToState('job-completed', WorkloadState.Completed);
      await createWorkload(getDB(), { ...baseJob, id: 'job-failed' });
      await walkToState('job-failed', WorkloadState.Failed);

      const results = (
        await queries().listWorkloadReconcileCandidates()
      ).filter(
        (candidate) =>
          candidate.workloadType === WorkloadType.Job &&
          candidate.state === WorkloadState.Running,
      );
      const ids = results.map((d) => d.id);

      expect(ids).toEqual(
        expect.arrayContaining(['job-running-1', 'job-running-2']),
      );
      expect(ids).toHaveLength(2);
    });

    it('excludes finalizing jobs from the running completion list', async () => {
      await createWorkload(getDB(), { ...baseJob, id: 'job-running' });
      await walkToState('job-running', WorkloadState.Running);

      await createWorkload(getDB(), { ...baseJob, id: 'job-finalizing' });
      await walkToState('job-finalizing', WorkloadState.Running);
      await lifecycle().updateState(
        'job-finalizing',
        WorkloadState.Finalizing,
        {
          metadata: {
            targetState: WorkloadState.Completed,
            workloadExitCode: 0,
            attempt: 0,
            maxAttempts: 20,
          },
        },
      );

      await createWorkload(getDB(), { ...baseJob, id: 'job-startup-sync' });
      await walkToState('job-startup-sync', WorkloadState.Syncing);

      const ids = (await queries().listWorkloadReconcileCandidates())
        .filter(
          (candidate) =>
            candidate.workloadType === WorkloadType.Job &&
            candidate.state === WorkloadState.Running,
        )
        .map((candidate) => candidate.id);

      expect(ids).toEqual(['job-running']);
      expect(ids).not.toContain('job-finalizing');
      expect(ids).not.toContain('job-startup-sync');
    });

    it('preserves credentialless Local provider identity for running jobs', async () => {
      await createWorkload(getDB(), {
        ...baseJob,
        id: 'job-running-local',
        requestedComputeProvider: CloudType.Local,
        region: 'local',
        vmType: 'local',
        credentialId: null,
      });
      await walkToState('job-running-local', WorkloadState.Running);

      const localJob = await queries().getWorkload('job-running-local');

      expect(localJob?.cloudProvider).toBe(CloudType.Local);
      expect(localJob?.credentialId).toBeNull();
    });
  });

  describe('workload reconciler finalization candidates', () => {
    const baseJob = {
      userId: 'test-user',
      workloadType: 'job' as const,
      image: 'alpine:latest',
      cloudProvider: CloudType.GCP,
      region: 'us-central1',
      vmType: 'n2-standard-4',
      dockerCommand: 'echo hello',
      sshPrivateKey: 'test-key',
      credentialId: 'test-cred',
    };

    it('returns only jobs in Finalizing', async () => {
      await createWorkload(getDB(), { ...baseJob, id: 'job-running' });
      await walkToState('job-running', WorkloadState.Running);

      await createWorkload(getDB(), { ...baseJob, id: 'job-finalizing' });
      await walkToState('job-finalizing', WorkloadState.Running);
      await lifecycle().updateState(
        'job-finalizing',
        WorkloadState.Finalizing,
        {
          metadata: {
            targetState: WorkloadState.Completed,
            workloadExitCode: 0,
            attempt: 0,
            maxAttempts: 20,
          },
        },
      );

      const ids = (await queries().listWorkloadReconcileCandidates())
        .filter(
          (candidate) =>
            candidate.workloadType === WorkloadType.Job &&
            candidate.state === WorkloadState.Finalizing,
        )
        .map((candidate) => candidate.id);

      expect(ids).toEqual(['job-finalizing']);
    });
  });

  describe('countDeploying', () => {
    const baseJob = {
      userId: 'test-user',
      workloadType: 'job' as const,
      image: 'alpine:latest',
      cloudProvider: CloudType.GCP,
      region: 'us-central1',
      vmType: 'n2-standard-4',
      dockerCommand: 'echo hello',
      sshPrivateKey: 'test-key',
      credentialId: 'test-cred',
    };

    it('excludes finalizing jobs from provisioning concurrency', async () => {
      await createWorkload(getDB(), { ...baseJob, id: 'deploy-startup-sync' });
      await walkToState('deploy-startup-sync', WorkloadState.Syncing);

      await createWorkload(getDB(), { ...baseJob, id: 'deploy-finalizing' });
      await walkToState('deploy-finalizing', WorkloadState.Running);
      await lifecycle().updateState(
        'deploy-finalizing',
        WorkloadState.Finalizing,
        {
          metadata: {
            targetState: WorkloadState.Completed,
            workloadExitCode: 0,
            attempt: 0,
            maxAttempts: 20,
          },
        },
      );

      expect(await queries().countDeploying()).toBe(1);
    });
  });

  describe('workload reconciler active-pipeline candidates', () => {
    const baseJob = {
      userId: 'test-user',
      workloadType: 'job' as const,
      image: 'alpine:latest',
      cloudProvider: CloudType.GCP,
      region: 'us-central1',
      vmType: 'n2-standard-4',
      dockerCommand: 'echo hello',
      sshPrivateKey: 'test-key',
      credentialId: 'test-cred',
    };

    it('excludes finalizing jobs from active-pipeline recovery', async () => {
      await createWorkload(getDB(), { ...baseJob, id: 'stuck-startup-sync' });
      await walkToState('stuck-startup-sync', WorkloadState.Syncing);

      await createWorkload(getDB(), { ...baseJob, id: 'stuck-finalizing' });
      await walkToState('stuck-finalizing', WorkloadState.Running);
      await lifecycle().updateState(
        'stuck-finalizing',
        WorkloadState.Finalizing,
        {
          metadata: {
            targetState: WorkloadState.Completed,
            workloadExitCode: 0,
            attempt: 0,
            maxAttempts: 20,
          },
        },
      );

      const activeStates = [
        WorkloadState.Provisioning,
        WorkloadState.Initializing,
        WorkloadState.Downloading,
        WorkloadState.Syncing,
        WorkloadState.Starting,
      ];
      const ids = (await queries().listWorkloadReconcileCandidates())
        .filter((candidate) => activeStates.includes(candidate.state))
        .map((candidate) => candidate.id);

      expect(ids).toContain('stuck-startup-sync');
      expect(ids).not.toContain('stuck-finalizing');
    });
  });

  describe('vmDurationMs', () => {
    const baseInput = {
      id: 'vm-duration-test',
      userId: 'test-user',
      workloadType: 'job' as const,
      image: 'alpine:latest',
      cloudProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.medium',
      dockerCommand: 'docker run alpine',
      sshPrivateKey: 'ssh-ed25519-test-private-key',
      credentialId: 'test-credential-id',
    };

    it('should sum VM lifetimes across preempted VMs', async () => {
      await createWorkload(getDB(), baseInput);

      // VM1: ran for some time then ended (preempted)
      await provisionTestVm('vm-duration-test', {
        ip: '1.2.3.4',
        cloudId: 'vm-1',
      });
      // Small delay to ensure measurable duration
      await new Promise((r) => setTimeout(r, 50));
      await releaseTestVms('vm-duration-test', 'vm-1');

      // VM2: still running
      await provisionTestVm('vm-duration-test', {
        ip: '5.6.7.8',
        cloudId: 'vm-2',
      });

      const [workload] = await queries().listWorkloads(scope('test-user'));
      expect(workload.vmDurationMs).toBeGreaterThan(0);
      // Should be at least 40ms (VM1 slept 50ms, allow timer jitter)
      expect(workload.vmDurationMs).toBeGreaterThanOrEqual(40);
      expect(workload.vmDurationMs!).toBeLessThan(10_000);
    });

    it('should return 0 for workload with no VMs', async () => {
      await createWorkload(getDB(), { ...baseInput, id: 'no-vms-test' });

      const [workload] = await queries().listWorkloads(scope('test-user'));
      expect(workload.vmDurationMs).toBe(0);
    });

    it('ignores failed-attempt placeholders in vm_count and vm_duration_ms', async () => {
      // Failed provisioning rows have cloud_id but no ip and no ended_at.
      // They must not show up as live VMs in `anycloud list` or accrue billable
      // minutes in `anycloud cost` — that's user-visible state, and the rows
      // are internal bookkeeping for startIndex + orphan cleanup.
      await createWorkload(getDB(), { ...baseInput, id: 'failed-only-test' });
      await Promise.all(
        ['failed-only-test-0', 'failed-only-test-1'].map((cloudId) =>
          provisionTestVm(
            'failed-only-test',
            { cloudId },
            { region: 'us-east-1' },
          ),
        ),
      );
      // Sleep so any incorrect (now - created_at) accrual would be detectable.
      await new Promise((r) => setTimeout(r, 50));

      const [workload] = await queries().listWorkloads(scope('test-user'));
      expect(workload.vmCount).toBe(0);
      expect(workload.vmDurationMs).toBe(0);
      // countAllVMs (which is meant to count attempts) still sees them.
      expect(await ledger().countAllVMs('failed-only-test')).toBe(2);
    });
  });

  describe('team-scoped workloads', () => {
    const teamScope = { kind: 'api' as const };
    const baseInput = {
      workloadType: 'job' as const,
      image: 'alpine:latest',
      region: 'us-east-1',
      vmType: 't3.medium',
      dockerCommand: 'docker run alpine',
      sshPrivateKey: 'ssh-ed25519-test-private-key',
      credentialId: 'test-credential-id',
    };

    const seedTwoMembers = async () => {
      await createWorkload(getDB(), {
        ...baseInput,
        id: 'owner-workload',
        userId: 'owner',
        ownerUserId: '100',
      });
      await createWorkload(getDB(), {
        ...baseInput,
        id: 'member-workload',
        userId: 'member',
        ownerUserId: '200',
      });
      return queries();
    };

    it('lists every member workload and names its creator', async () => {
      const store = await seedTwoMembers();

      const rows = await store.listWorkloads(teamScope);
      expect(rows.map((row) => [row.id, row.userId]).sort()).toEqual([
        ['member-workload', 'member'],
        ['owner-workload', 'owner'],
      ]);
    });

    it('lets one member terminate another member workload', async () => {
      const store = await seedTwoMembers();

      await expect(
        store.getWorkloadForScope('member-workload', teamScope),
      ).resolves.toMatchObject({ id: 'member-workload' });
      await expect(
        outcomes().requestTermination('member-workload', teamScope),
      ).resolves.toMatchObject({ previousState: WorkloadState.Queued });
    });

    it('collects the terminatable set through a single indexed branch', async () => {
      const encryptedKey = await encryptSecret('ssh-ed25519-team-plan-key');
      // Deep finished history across two members, already cleaned up, plus a
      // couple of live rows — the shape the terminate picker actually meets.
      await seedWorkloadRows(
        `INSERT INTO workloads (
           id, user_id, owner_user_id, workload_type, state,
           started_at, submitted_at, completed_at, cleaned_at,
           docker_command, ssh_private_key
         )
         WITH RECURSIVE rows(n) AS (
           SELECT 1
           UNION ALL
           SELECT n + 1 FROM rows WHERE n < 60000
         )
         SELECT printf('team-%06d', n),
                CASE n % 2 WHEN 0 THEN 'owner' ELSE 'member' END,
                CASE n % 2 WHEN 0 THEN '100' ELSE '200' END,
                'job', 'completed', n, n, n, n,
                'docker run alpine', ?
         FROM rows`,
        [encryptedKey],
        'alpine',
        ['owner', 'member'],
      );
      await createWorkload(getDB(), {
        ...baseInput,
        id: 'team-live-owner',
        userId: 'owner',
        ownerUserId: '100',
      });
      await createWorkload(getDB(), {
        ...baseInput,
        id: 'team-live-member',
        userId: 'member',
        ownerUserId: '200',
      });
      await getDB().query('ANALYZE');

      const querySpy = spyOnReadQueries(getDB());
      const terminatable = await queries().listWorkloads(
        teamScope,
        DEFAULT_LIST_LIMIT,
        { stateClass: 'terminatable' },
      );
      expect(terminatable.map((row) => row.id).sort()).toEqual([
        'team-live-member',
        'team-live-owner',
      ]);
      const [terminatableSql, terminatableParams] = querySpy.mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.includes('terminatable_ids'),
      )!;

      // Team scope contributes one ownership branch, so the CTE has two legs
      // (active + cleanup-pending) instead of four, and the active leg cannot
      // use the owner/legacy partial indexes it would take under user scope.
      expect(String(terminatableSql).split('UNION ALL')).toHaveLength(2);
      const plan = (
        await getDB().query<{ detail: string }>(
          `EXPLAIN QUERY PLAN ${terminatableSql}`,
          terminatableParams,
        )
      ).map((row) => row.detail);
      expect(
        plan.some((detail) => detail.includes('USING INDEX')),
        plan.join('\n'),
      ).toBe(true);
      expect(
        plan.some((detail) => /SCAN (workloads|active)\b/.test(detail)),
        plan.join('\n'),
      ).toBe(false);
    });
  });
});

describe('bounded workload lookup index usage', () => {
  it('keeps active-first limiting and returns selected rows newest-first', async () => {
    const input = {
      userId: 'terminate-order-user',
      workloadType: 'job' as const,
      image: 'alpine:latest',
      cloudProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.medium',
      dockerCommand: 'docker run alpine',
      sshPrivateKey: 'ssh-ed25519-test-private-key',
      credentialId: 'test-credential-id',
    };
    await createWorkload(getDB(), { ...input, id: 'terminate-active-old' });
    await walkToState('terminate-active-old', WorkloadState.Running);
    await createWorkload(getDB(), { ...input, id: 'terminate-pending-new' });
    await walkToState('terminate-pending-new', WorkloadState.Completed);
    await getDB().query(
      `UPDATE workloads
       SET started_at = CASE id
         WHEN 'terminate-active-old' THEN 100
         WHEN 'terminate-pending-new' THEN 200
       END
       WHERE id IN ('terminate-active-old', 'terminate-pending-new')`,
    );

    const all = await queries().listWorkloads(
      scope('terminate-order-user'),
      10,
      {
        stateClass: 'terminatable',
        limitExplicit: true,
        user: 'terminate-order-user',
      },
    );
    expect(all.map((row) => row.id)).toEqual([
      'terminate-pending-new',
      'terminate-active-old',
    ]);

    const limited = await queries().listWorkloads(
      scope('terminate-order-user'),
      1,
      {
        stateClass: 'terminatable',
        limitExplicit: true,
        user: 'terminate-order-user',
      },
    );
    expect(limited.map((row) => row.id)).toEqual(['terminate-active-old']);

    const periodLimited = await queries().listWorkloads(
      scope('terminate-order-user'),
      1,
      {
        stateClass: 'terminatable',
        sinceMs: 0,
        limitExplicit: true,
        user: 'terminate-order-user',
      },
    );
    expect(periodLimited.map((row) => row.id)).toEqual([
      'terminate-pending-new',
    ]);
  });
});

// Regression guards for the workload_events indices added in migrations
// 0060 and 0077.
// Retry discovery was measured at ~2s per minute-tick on a real 529k-row
// customer DB before the indices, 32ms after — these tests pin (a) that the
// query still hits the indices (the partial index only matches while the query
// predicate stays textually equivalent, so an innocent edit can silently bring
// the full scan back) and (b) the resubmit-count semantics of the rewritten
// predicate.
describe('workload_events JSON index usage', () => {
  beforeAll(() => {
    config.cipherKey = randomBytes(32).toString('hex');
  });

  it('workload reconciler discovery stays on candidate and latest-event indices', async () => {
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const { rmSync } = await import('fs');

    const dbFile = join(
      tmpdir(),
      `anycloud-reconcile-idx-spec-${process.pid}.db`,
    );
    rmSync(dbFile, { force: true });
    vi.stubEnv('SQLITE_PATH', dbFile);
    resetPersistence();
    try {
      const store = queries();
      const querySpy = vi.spyOn(getDB(), 'query');
      await store.listWorkloadReconcileCandidates();
      const call = querySpy.mock.calls.find(
        (candidate) =>
          typeof candidate[0] === 'string' &&
          candidate[0].includes('WITH candidate_ids AS'),
      );
      expect(call).toBeDefined();
      const [sql, params] = call!;

      {
        const details = explainQueryPlan(dbFile, sql, params ?? []);
        const detailText = details.join('\n');

        expect(detailText).toContain('idx_workloads_state_started');
        expect(detailText).toContain('idx_workloads_pending_cleanup');
        expect(detailText).not.toContain('idx_vms_active');
        expect(detailText).toContain('idx_events_workload_id');
        expect(
          details.filter(
            (detail) =>
              detail.includes('SCAN workload_events') &&
              !detail.includes('USING'),
          ),
        ).toEqual([]);
      }
    } finally {
      vi.unstubAllEnvs();
      resetPersistence();
      rmSync(dbFile, { force: true });
    }
  });

  it('listVmsNeedingCost uses the pending-cost VM index', async () => {
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const { rmSync } = await import('fs');

    const dbFile = join(tmpdir(), `anycloud-cost-idx-spec-${process.pid}.db`);
    rmSync(dbFile, { force: true });
    vi.stubEnv('SQLITE_PATH', dbFile);
    resetPersistence();
    try {
      const querySpy = vi.spyOn(getDB(), 'query');
      await listVmsNeedingCost(getDB(), Date.now());
      const call = querySpy.mock.calls.find(
        (c) =>
          typeof c[0] === 'string' &&
          c[0].includes('FROM vms v') &&
          c[0].includes('v.cost IS NULL'),
      );
      expect(call).toBeDefined();
      const [sql, params] = call!;

      {
        const details = explainQueryPlan(dbFile, sql, params ?? []).join('\n');
        expect(details).toContain('idx_vms_needing_cost');
      }
    } finally {
      vi.unstubAllEnvs();
      resetPersistence();
      rmSync(dbFile, { force: true });
    }
  });

  it('returns a null revision timestamp for active rows without event history', async () => {
    resetPersistence();
    await getDB().query(
      `INSERT OR IGNORE INTO credentials (id, encrypted_data, cloud_provider) VALUES ('test-credential-id', '', 'AWS')`,
    );
    await createWorkload(getDB(), {
      id: 'stuck-state-no-event',
      userId: 'test-user',
      workloadType: 'job',
      image: 'alpine:latest',
      requestedComputeProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.medium',
      dockerCommand: 'docker run alpine',
      sshPrivateKey: 'ssh-ed25519-test-private-key',
      credentialId: 'test-credential-id',
    });
    await getDB().query(`UPDATE workloads SET state = ? WHERE id = ?`, [
      WorkloadState.Provisioning,
      'stuck-state-no-event',
    ]);

    const row = (await queries().listWorkloadReconcileCandidates()).find(
      (candidate) => candidate.id === 'stuck-state-no-event',
    );
    expect(row).toMatchObject({
      id: 'stuck-state-no-event',
      latestEventAt: null,
    });
  });

  describe('listQueued', () => {
    beforeEach(async () => {
      resetPersistence();
      for (const id of ['test-cred', 'test-cred-id']) {
        await getDB().query(
          `INSERT OR IGNORE INTO credentials (id, encrypted_data, cloud_provider) VALUES (?, '', 'AWS')`,
          [id],
        );
      }
    });

    const queueInput = {
      userId: 'test-user',
      workloadType: 'job' as const,
      image: 'alpine:latest',
      cloudProvider: CloudType.AWS,
      vmType: 'c7i.4xlarge',
      dockerCommand: 'docker run alpine',
      sshPrivateKey: 'ssh-ed25519-test-private-key',
    };

    async function createQueued(
      id: string,
      options: {
        credentialId?: string | null;
        requestedComputeProvider?: CloudType;
        ownerUserId?: string;
        userId?: string;
        spot?: boolean;
        region?: string;
      } = {},
    ): Promise<void> {
      await createWorkload(getDB(), {
        ...queueInput,
        id,
        ...(options.userId ? { userId: options.userId } : {}),
        ownerUserId: options.ownerUserId,
        credentialId:
          options.credentialId === undefined
            ? 'test-cred'
            : options.credentialId,
        requestedComputeProvider: options.requestedComputeProvider,
        spot: options.spot ?? true,
        region: options.region ?? 'us-east-1',
      });
    }

    async function setStartedAt(id: string, startedAt: number): Promise<void> {
      await getDB().query(`UPDATE workloads SET started_at = ? WHERE id = ?`, [
        startedAt,
        id,
      ]);
    }

    it('includes a newer credential lane despite an older deep backlog', async () => {
      const store = queries();
      for (let i = 0; i < 60; i++) {
        const id = `lane-a-${i.toString().padStart(2, '0')}`;
        await createQueued(id);
        await setStartedAt(id, i + 1);
      }
      await createQueued('lane-b', { credentialId: 'test-cred-id' });
      await setStartedAt('lane-b', 1_000);

      const selected = (await store.listQueued(50)).map((row) => row.id);
      expect(selected).toHaveLength(50);
      expect(selected).toContain('lane-b');
      expect(selected.filter((id) => id.startsWith('lane-a-'))).toEqual(
        Array.from(
          { length: 49 },
          (_, i) => `lane-a-${i.toString().padStart(2, '0')}`,
        ),
      );
    });

    it('prioritizes the lane with less active provisioning work', async () => {
      const store = queries();
      await createQueued('queued-a');
      await createQueued('queued-b', { credentialId: 'test-cred-id' });
      await setStartedAt('queued-a', 1);
      await setStartedAt('queued-b', 2);

      for (let i = 0; i < 3; i++) {
        const id = `active-a-${i}`;
        await createQueued(id);
        await getDB().query(`UPDATE workloads SET state = ? WHERE id = ?`, [
          WorkloadState.Provisioning,
          id,
        ]);
      }

      expect((await store.listQueued(1)).map((row) => row.id)).toEqual([
        'queued-b',
      ]);
    });

    it('preserves FIFO order when only one lane has work', async () => {
      await createQueued('lane-only-late');
      await createQueued('lane-only-early');
      await createQueued('lane-only-middle');
      await setStartedAt('lane-only-late', 3);
      await setStartedAt('lane-only-early', 1);
      await setStartedAt('lane-only-middle', 2);

      expect((await queries().listQueued(3)).map((row) => row.id)).toEqual([
        'lane-only-early',
        'lane-only-middle',
        'lane-only-late',
      ]);
    });

    it('selects lanes through the state index, not a table scan', async () => {
      // The scheduler runs this every five seconds, and the lane key is a
      // computed expression: an edit that makes it index-hostile would turn the
      // hot path into a full scan, which is how the June 2026 outage started.
      await createQueued('plan-a');
      await createQueued('plan-b', { credentialId: 'test-cred-id' });
      const query = vi.spyOn(getDB(), 'query');
      await queries().listQueued(50);
      const call = query.mock.calls.find(
        ([candidate]) =>
          typeof candidate === 'string' && candidate.includes('lane_load AS ('),
      );
      query.mockRestore();
      expect(call, 'listQueued did not issue its lane query').toBeDefined();
      const [sql, params] = call!;
      const details = (
        await getDB().query<{ detail: string }>(
          `EXPLAIN QUERY PLAN ${sql}`,
          params as unknown[],
        )
      ).map(({ detail }) => detail);
      // Assert on the ranked query's own access path: the lane_load CTE reads
      // the same index, so a looser check passes even when this one degrades.
      expect(
        details.some((detail) =>
          /\bSEARCH d USING INDEX idx_workloads_state_started\b/.test(detail),
        ),
        details.join('\n'),
      ).toBe(true);
      expect(
        details.some((detail) => /\bSCAN d\b/.test(detail)),
        details.join('\n'),
      ).toBe(false);
    });

    it('lanes by owner so one member cannot starve another on a shared credential', async () => {
      // Hosted-API members share the API's credentials, so the credential alone
      // cannot separate them.
      for (let i = 0; i < 60; i++) {
        const id = `member-a-${i.toString().padStart(2, '0')}`;
        await createQueued(id, {
          ownerUserId: 'user-a',
          userId: 'member-a',
        });
        await setStartedAt(id, i + 1);
      }
      await createQueued('member-b-late', {
        ownerUserId: 'user-b',
        userId: 'member-b',
      });
      await setStartedAt('member-b-late', 1_000);

      const selected = (await queries().listQueued(50)).map((row) => row.id);
      expect(selected).toContain('member-b-late');
    });

    it('shares slots per lane, so one caller on three credentials outdraws one on a single credential', async () => {
      for (const id of ['cred-a1', 'cred-b1', 'cred-b2', 'cred-b3']) {
        await getDB().query(
          `INSERT OR IGNORE INTO credentials (id, encrypted_data, cloud_provider) VALUES (?, '', 'AWS')`,
          [id],
        );
      }
      let startedAt = 0;
      const seed = async (
        user: string,
        credentialId: string,
        count: number,
      ): Promise<void> => {
        for (let i = 0; i < count; i++) {
          const id = `${credentialId}-${i.toString().padStart(2, '0')}`;
          await createQueued(id, {
            credentialId,
            ownerUserId: user,
            userId: user,
          });
          await setStartedAt(id, ++startedAt);
        }
      };
      await seed('user-a', 'cred-a1', 30);
      await seed('user-b', 'cred-b1', 10);
      await seed('user-b', 'cred-b2', 10);
      await seed('user-b', 'cred-b3', 10);

      const rows = await queries().listQueued(40);
      const perUser = new Map<string, number>();
      const perCredential = new Map<string, number>();
      for (const row of rows) {
        perUser.set(row.user_id, (perUser.get(row.user_id) ?? 0) + 1);
        const credential = row.credential_id ?? 'none';
        perCredential.set(credential, (perCredential.get(credential) ?? 0) + 1);
      }

      // Four lanes take the window in equal turns, so the caller holding three
      // of them draws three times the share at identical queue depth. This is a
      // consequence of keeping a caller's own clouds unblocked, not a bug — but
      // it means the slot budget divides per lane rather than per tenant.
      expect(perCredential.get('cred-a1')).toBe(10);
      expect(perCredential.get('cred-b1')).toBe(10);
      expect(perCredential.get('cred-b2')).toBe(10);
      expect(perCredential.get('cred-b3')).toBe(10);
      expect(perUser.get('user-a')).toBe(10);
      expect(perUser.get('user-b')).toBe(30);
    });
  });
  describe('status snapshot', () => {
    beforeEach(() => {
      resetPersistence();
    });

    it('returns a queued VM-host Workload with its container spec', async () => {
      const store = queries();
      for (const workloadType of [
        WorkloadType.Job,
        WorkloadType.Service,
        WorkloadType.Vm,
      ]) {
        const id = `vm-host-${workloadType}`;
        await seedTestWorkload({
          id,
          userId: 'target-owner',
          workloadType,
          state: WorkloadState.Queued,
          image: 'status-image',
          command: ['echo', 'status'],
          env: { STATUS_MARKER: 'snapshot' },
          githubToken: 'status-token',
        });
        await expect(
          store.getWorkloadStatusForScope(id, {
            kind: 'api',
          }),
        ).resolves.toMatchObject({
          workload: {
            image: 'status-image',
            command: ['echo', 'status'],
            env: { STATUS_MARKER: 'snapshot' },
            githubToken: 'status-token',
            registryUsername: 'x-access-token',
          },
        });
      }
    });

    it('returns the most recent events in chronological order under a limit', async () => {
      await seedTestWorkload({ id: 'history', userId: 'target-owner' });
      await getDB().query(
        `DELETE FROM workload_events WHERE workload_id = 'history'`,
      );
      // Events 1 and 2 share created_at so the rowid tiebreak is exercised.
      for (const seq of [0, 1, 2, 3, 4, 5]) {
        await getDB().query(
          `INSERT INTO workload_events (workload_id, state, metadata, created_at)
             VALUES ('history', 'running', ?, ?)`,
          [String(seq), Math.max(seq, 2)],
        );
      }
      const read = async (limit?: number) => {
        const snapshot = await queries().getWorkloadStatusForScope(
          'history',
          { kind: 'api' },
          limit,
        );
        return {
          total: snapshot?.eventsTotal,
          seqs: snapshot?.events.map((e) => Number(e.metadata)),
        };
      };
      expect(await read(3)).toEqual({ total: 6, seqs: [3, 4, 5] });
      expect(await read(5)).toEqual({ total: 6, seqs: [1, 2, 3, 4, 5] });
      expect(await read()).toEqual({ total: 6, seqs: [0, 1, 2, 3, 4, 5] });
    });
  });

  describe('getWorkloadStatusForScope retry progress', () => {
    const seedHistory = async (
      id: string,
      state: WorkloadState,
      history: Array<[WorkloadState, number]>,
    ) => {
      await seedTestWorkload({ id, userId: 'u', state });
      await getDB().query(`DELETE FROM workload_events WHERE workload_id = ?`, [
        id,
      ]);
      for (const [eventState, createdAt] of history) {
        await getDB().query(
          `INSERT INTO workload_events (workload_id, state, metadata, created_at)
           VALUES (?, ?, NULL, ?)`,
          [id, eventState, createdAt],
        );
      }
    };

    it('reports the attempt count, last retry time and failing state while Retrying', async () => {
      await seedHistory('retrying', WorkloadState.Retrying, [
        [WorkloadState.Provisioning, 1_000],
        [WorkloadState.Retrying, 2_000],
        [WorkloadState.Provisioning, 3_000],
        [WorkloadState.Retrying, 4_000],
      ]);
      const snapshot = await queries().getWorkloadStatusForScope('retrying', {
        kind: 'api',
      });
      expect(snapshot?.retry).toMatchObject({
        retryCount: 2,
        lastRetryAt: 4_000,
        failedAtState: WorkloadState.Provisioning,
      });
    });

    it('reports no retry progress outside Retrying', async () => {
      await seedHistory('running', WorkloadState.Running, [
        [WorkloadState.Provisioning, 1_000],
        [WorkloadState.Retrying, 2_000],
        [WorkloadState.Running, 3_000],
      ]);
      const snapshot = await queries().getWorkloadStatusForScope('running', {
        kind: 'api',
      });
      expect(snapshot?.retry).toBeNull();
    });
  });
});

// `anycloud list --credentials <c>` took 9.4s on a 41k-workload self-hosted
// customer DB. Its ANALYZE statistics predated most of one credential's VMs, so
// SQLite took that credential as near-empty and served the per-workload VM check
// from idx_vms_credential, rescanning all of its VMs for every workload.
describe('listWorkloads credential filter index usage', () => {
  beforeAll(() => {
    config.cipherKey = randomBytes(32).toString('hex');
  });

  it('checks VM credentials per workload when statistics predate the credential', async () => {
    resetPersistence();
    for (const id of ['cred-a', 'cred-b', 'new-cred']) {
      await getDB().query(
        `INSERT INTO credentials (id, encrypted_data, cloud_provider) VALUES (?, '', 'Azure')`,
        [id],
      );
    }
    const encryptedKey = await encryptSecret('ssh-ed25519-cred-plan-key');
    await seedWorkloadRows(
      `INSERT INTO workloads (
         id, user_id, workload_type, state, started_at, completed_at,
         docker_command, ssh_private_key, session, credential_id
       )
       WITH RECURSIVE rows(n) AS (
         SELECT 1 UNION ALL SELECT n + 1 FROM rows WHERE n < 2000
       )
       SELECT printf('cred-plan-%04d', n), 'test-user', 'job', 'completed',
              n, n + 1, 'docker run alpine', ?, 'heavy-session', 'cred-a'
       FROM rows`,
      [encryptedKey],
      'alpine',
      ['test-user'],
    );
    // Thirteen VMs per workload, as in the customer's DB, alternating between
    // the two credentials ANALYZE sees.
    await getDB().query(
      `INSERT INTO vms (workload_id, cloud_id, ip, created_at, ended_at, credential_id)
       WITH RECURSIVE k(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM k WHERE i < 12)
       SELECT d.id, d.id || '-old-' || k.i, '10.0.0.1', d.started_at,
              d.completed_at, printf('cred-%s', char(97 + k.i % 2))
       FROM workloads d, k
       WHERE d.session = 'heavy-session'`,
    );
    await getDB().query('ANALYZE');
    // Every 40th workload later runs thirteen VMs on a credential ANALYZE never saw.
    await getDB().query(
      `INSERT INTO vms (workload_id, cloud_id, ip, created_at, ended_at, credential_id)
       WITH RECURSIVE k(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM k WHERE i < 12)
       SELECT d.id, d.id || '-new-' || k.i, '10.0.0.1', d.started_at,
              d.completed_at, 'new-cred'
       FROM workloads d, k
       WHERE d.session = 'heavy-session' AND d.started_at % 40 = 0`,
    );

    const querySpy = spyOnReadQueries(getDB());
    const listed = await queries().listWorkloads(scope(), DEFAULT_LIST_LIMIT, {
      session: 'heavy-session',
      sessionExact: true,
      credentialId: 'new-cred',
      search: 'cred-plan',
    });
    expect(listed.map((row) => row.id).sort()).toEqual(
      Array.from(
        { length: 50 },
        (_, i) => `cred-plan-${String((i + 1) * 40).padStart(4, '0')}`,
      ),
    );

    const calls = querySpy.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && sql.includes('FROM vms vc'),
    );
    expect(calls.length).toBeGreaterThan(0);
    for (const [sql, params] of calls) {
      const plan = (
        await getDB().query<{ detail: string }>(
          `EXPLAIN QUERY PLAN ${sql}`,
          params,
        )
      ).map((row) => row.detail);
      const vmCheck = plan.filter((detail) => /\bvc\b/.test(detail));
      expect(vmCheck, plan.join('\n')).toEqual([
        expect.stringMatching(/SEARCH vc USING INDEX idx_vms_workload_id\b/),
      ]);
    }
  });
});

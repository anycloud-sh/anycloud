import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import config from '../../../src/api/config.js';
import { COST_CALCULATION_CONCURRENCY } from '../../../src/api/config.js';
import { loadWorkloadConfigs } from '../../../src/api/services/cloud-config.js';
import { runCostCalculationOnce } from '../../../src/api/services/cost-calculation/monitor.js';
import {
  getWorkloadQueryStore as queries,
  resetPersistence,
} from '../../../src/api/services/persistence.js';
import { listVmsNeedingCost } from '../../../src/api/services/repositories/billing.js';
import { getDB } from '../../../src/api/services/repositories/db.js';
import { WorkloadState } from '../../../src/shared/workload.js';
import {
  seedBillingCredential as credential,
  seedBillingGroup as seedGroup,
} from '../../helpers/billing-groups.mjs';

const { clientFactory } = vi.hoisted(() => ({ clientFactory: vi.fn() }));
vi.mock(
  '../../../src/api/services/provider-clients/aws.js',
  async (importOriginal) => ({
    ...(await importOriginal()),
    createAwsCostExplorerClient: clientFactory,
  }),
);

const BILL_USD = 137;
const DAY_MS = 24 * 3600_000;
const NOW = Date.now();
// One GroupBy-TAG result per requested owner, as Cost Explorer returns it,
// on the batch's last day (the day the seeded groups ended).
const bill = ({ input }, amount = BILL_USD) => ({
  ResultsByTime: [
    {
      TimePeriod: {
        Start: new Date(Date.parse(input.TimePeriod.End) - DAY_MS)
          .toISOString()
          .slice(0, 10),
        End: input.TimePeriod.End,
      },
      Groups: input.Filter.Tags.Values.map((value) => ({
        Keys: [input.GroupBy[0].Key + '$' + value],
        Metrics: { UnblendedCost: { Amount: String(amount), Unit: 'USD' } },
      })),
    },
  ],
});

beforeEach(() => {
  resetPersistence();
  config.cipherKey = 'a'.repeat(64);
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  clientFactory.mockReset();
  clientFactory.mockImplementation(() => ({
    send: vi.fn(async (command) => bill(command)),
  }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('billing monitor with real AWS allocation and persistence', () => {
  it.each([
    [
      'SSH key',
      'UPDATE workloads SET ssh_private_key=? WHERE id=?',
      'not-ciphertext',
    ],
    [
      'secret names',
      'UPDATE workloads SET secret_names=? WHERE id=?',
      'not-json',
    ],
    [
      'environment',
      'UPDATE container_specs SET env=? WHERE workload_id=?',
      'not-ciphertext',
    ],
    [
      'registry username',
      'UPDATE container_specs SET registry_username=? WHERE workload_id=?',
      'not-ciphertext',
    ],
    [
      'registry token',
      'UPDATE container_specs SET registry_token=? WHERE workload_id=?',
      'not-ciphertext',
    ],
    [
      'container command',
      'UPDATE container_specs SET command=? WHERE workload_id=?',
      '[1]',
    ],
    [
      'GPU placement',
      'UPDATE workloads SET vm_type=NULL,gpu_type=? WHERE id=?',
      '[1]',
    ],
  ])(
    'settles costs despite unrelated malformed %s',
    async (_name, statement, value) => {
      const account = await credential('account-a');
      await seedGroup({
        id: 'damaged-config',
        credentialId: account,
        workloadType: 'service',
      });
      await getDB().query(statement, [value, 'damaged-config']);
      await expect(
        (async () => {
          const workload = await queries().getWorkload('damaged-config');
          await loadWorkloadConfigs(workload);
        })(),
      ).rejects.toThrow();

      await runCostCalculationOnce();
      expect(clientFactory).toHaveBeenCalledOnce();
      const [result] = await getDB().query(
        'SELECT COUNT(cost) AS settled,SUM(cost) AS total FROM vms',
      );
      expect(result.settled).toBe(3);
      expect(result.total).toBeCloseTo(BILL_USD, 10);
    },
  );

  it('settles costs without decrypting an unrelated storage credential', async () => {
    const account = await credential('account-a');
    const storage = await credential('storage-only');
    await seedGroup({ id: 'bad-storage', credentialId: account });
    await getDB().query(
      'UPDATE workloads SET input_storage_credential_id=? WHERE id=?',
      [storage, 'bad-storage'],
    );
    await getDB().query('UPDATE credentials SET encrypted_data=? WHERE id=?', [
      'not-ciphertext',
      storage,
    ]);
    const workload = await queries().getWorkload('bad-storage');
    await expect(loadWorkloadConfigs(workload)).rejects.toThrow();
    await runCostCalculationOnce();
    expect(clientFactory).toHaveBeenCalledOnce();
    const [result] = await getDB().query(
      'SELECT COUNT(cost) AS settled,SUM(cost) AS total FROM vms',
    );
    expect(result.settled).toBe(3);
    expect(result.total).toBeCloseTo(BILL_USD, 10);
  });

  it('continues past an unusable compute identity and retains its unsettled group', async () => {
    const broken = await credential('broken-account');
    const healthy = await credential('healthy-account');
    await seedGroup({ id: 'broken-owner', credentialId: broken });
    await seedGroup({ id: 'healthy-owner', credentialId: healthy });
    await getDB().query('UPDATE credentials SET encrypted_data=? WHERE id=?', [
      'not-ciphertext',
      broken,
    ]);
    await runCostCalculationOnce();
    expect(clientFactory).toHaveBeenCalledOnce();
    expect(clientFactory.mock.calls[0][0].accessKeyId).toBe('healthy-account');
    const rows = await getDB().query(
      'SELECT workload_id,COUNT(cost) AS settled,SUM(cost) AS total FROM vms GROUP BY workload_id ORDER BY workload_id',
    );
    expect(rows[0]).toEqual({
      workload_id: 'broken-owner',
      settled: 0,
      total: null,
    });
    expect(rows[1].settled).toBe(3);
    expect(rows[1].total).toBeCloseTo(BILL_USD, 10);
  });

  it('does not settle a group whose required container spec is missing', async () => {
    const account = await credential('account-a');
    await seedGroup({ id: 'missing-spec', credentialId: account });
    await getDB().query('DROP TRIGGER container_specs_no_detach');
    await getDB().query('DELETE FROM container_specs WHERE workload_id=?', [
      'missing-spec',
    ]);
    await runCostCalculationOnce();
    expect(clientFactory).not.toHaveBeenCalled();
    expect(
      await getDB().query('SELECT COUNT(cost) AS settled FROM vms'),
    ).toEqual([{ settled: 0 }]);
  });

  it('keeps each credential group whole and uses the VM account override', async () => {
    const accountA = await credential('account-a');
    const accountB = await credential('account-b');
    await seedGroup({
      id: 'owner',
      credentialId: accountA,
      state: WorkloadState.Provisioning,
    });
    await seedGroup({
      id: 'owner',
      credentialId: accountA,
      vmCredentialId: accountB,
      suffix: '-other-account',
    });
    await runCostCalculationOnce();
    expect(clientFactory).toHaveBeenCalledTimes(2);
    expect(
      clientFactory.mock.calls
        .map(([credentials]) => credentials.accessKeyId)
        .sort(),
    ).toEqual(['account-a', 'account-b']);
    const rows = await getDB().query(
      'SELECT credential_id,cost FROM vms ORDER BY credential_id,created_at DESC',
    );
    for (const id of [accountA, accountB]) {
      const costs = rows
        .filter((row) => row.credential_id === id)
        .map((row) => row.cost);
      expect(costs).toHaveLength(3);
      // Fixed independent oracle: a $137 bill split 1:2:4, once per account.
      expect(costs[0]).toBeCloseTo(137 / 7, 10);
      expect(costs[1]).toBeCloseTo(274 / 7, 10);
      expect(costs[2]).toBeCloseTo(548 / 7, 10);
      expect(costs.reduce((sum, value) => sum + value, 0)).toBeCloseTo(137, 10);
    }
  });

  it('preserves the existing explicit NULL VM credential skip', async () => {
    const account = await credential('account-a');
    await seedGroup({
      id: 'legacy-null',
      credentialId: account,
      vmCredentialId: null,
    });
    expect(await listVmsNeedingCost(getDB(), Date.now() - DAY_MS)).toHaveLength(
      3,
    );
    await runCostCalculationOnce();
    expect(clientFactory).not.toHaveBeenCalled();
    expect(await listVmsNeedingCost(getDB(), Date.now() - DAY_MS)).toHaveLength(
      3,
    );
  });

  it('asks once per page of a credential and settles each group from it', async () => {
    const account = await credential('account-a');
    const count = COST_CALCULATION_CONCURRENCY * 2 + 5;
    for (let index = 0; index < count; index++) {
      await seedGroup({
        id: 'owner-' + index,
        credentialId: account,
        weights: [1],
      });
    }
    const send = vi.fn(async (command) => {
      if (command.input.Filter.Tags.Values.includes('owner-0'))
        throw new Error('Synthetic provider failure');
      return bill(command);
    });
    clientFactory.mockImplementation(() => ({ send }));
    await runCostCalculationOnce();
    const batches = send.mock.calls.map(
      ([command]) => command.input.Filter.Tags.Values,
    );
    expect(batches.map((owners) => owners.length)).toEqual([
      COST_CALCULATION_CONCURRENCY,
      COST_CALCULATION_CONCURRENCY,
      5,
    ]);
    const rows = await getDB().query('SELECT workload_id,cost FROM vms');
    expect(rows).toHaveLength(count);
    for (const row of rows) {
      const failed = batches[0].includes(row.workload_id);
      expect(row.cost).toBe(failed ? null : BILL_USD);
    }
  });

  it("pages grouped bills and keeps each owner's spend to its own days", async () => {
    const account = await credential('account-a');
    // A resubmitted owner: its earlier attempt's spend is still tagged.
    await seedGroup({ id: 'resubmitted', credentialId: account, weights: [1] });
    await seedGroup({ id: 'long-lived', credentialId: account, weights: [1] });
    await getDB().query('UPDATE vms SET created_at=? WHERE workload_id=?', [
      NOW - 25 * DAY_MS,
      'long-lived',
    ]);
    const day = (offsetDays) =>
      new Date(NOW + offsetDays * DAY_MS).toISOString().slice(0, 10);
    const spend = (owner, offsetDays, amount) => ({
      TimePeriod: { Start: day(offsetDays), End: day(offsetDays + 1) },
      Groups: [
        {
          Keys: ['anycloud_deployment$' + owner],
          Metrics: {
            UnblendedCost: { Amount: String(amount), Unit: 'USD' },
          },
        },
      ],
    });
    const send = vi.fn(async (command) =>
      command.input.NextPageToken
        ? { ResultsByTime: [spend('resubmitted', -3, BILL_USD)] }
        : {
            ResultsByTime: [
              spend('resubmitted', -20, 100),
              spend('long-lived', -10, BILL_USD),
            ],
            NextPageToken: 'page-2',
          },
    );
    clientFactory.mockImplementation(() => ({ send }));
    await runCostCalculationOnce();
    expect(send).toHaveBeenCalledTimes(2);
    expect(
      await getDB().query(
        'SELECT workload_id,cost FROM vms ORDER BY workload_id',
      ),
    ).toEqual([
      { workload_id: 'long-lived', cost: BILL_USD },
      { workload_id: 'resubmitted', cost: BILL_USD },
    ]);
  });

  it('stops asking for bills a week after termination', async () => {
    const account = await credential('account-a');
    await seedGroup({
      id: 'expired',
      credentialId: account,
      endedAt: NOW - 7 * DAY_MS,
    });
    await getDB().query('UPDATE workloads SET completed_at=? WHERE id=?', [
      NOW - 7 * DAY_MS,
      'expired',
    ]);
    await seedGroup({
      id: 'recent',
      credentialId: account,
      endedAt: NOW - 7 * DAY_MS + 1,
    });
    await runCostCalculationOnce();
    expect(clientFactory).toHaveBeenCalledOnce();
    expect(
      await getDB().query(
        'SELECT workload_id,COUNT(cost) AS settled FROM vms GROUP BY workload_id ORDER BY workload_id',
      ),
    ).toEqual([
      { workload_id: 'expired', settled: 0 },
      { workload_id: 'recent', settled: 3 },
    ]);
  });

  it('keeps the sweep cutoff fixed and picks up newly eligible work on the next sweep', async () => {
    const account = await credential('account-a');
    const eligibleCount = COST_CALCULATION_CONCURRENCY + 5;
    for (let index = 0; index < eligibleCount; index++) {
      await seedGroup({
        id: 'anchor-' + index,
        credentialId: account,
        weights: [1],
        endedAt: NOW - DAY_MS,
      });
    }
    // Sort after more than one concurrency-sized page so a fresh cutoff on a
    // later discovery page would incorrectly include this group in this sweep.
    await seedGroup({
      id: 'z-after-cutoff',
      credentialId: account,
      weights: [1],
      endedAt: NOW - DAY_MS + 1,
    });
    clientFactory.mockImplementation(() => ({
      send: async (command) => {
        vi.mocked(Date.now).mockReturnValue(NOW + 2);
        return bill(command);
      },
    }));
    await runCostCalculationOnce();
    // One query per page: the full first page, then the rest.
    expect(clientFactory).toHaveBeenCalledTimes(2);
    expect(
      await getDB().query('SELECT cost FROM vms WHERE workload_id=?', [
        'z-after-cutoff',
      ]),
    ).toEqual([{ cost: null }]);
    await runCostCalculationOnce();
    expect(clientFactory).toHaveBeenCalledTimes(3);
    expect(
      await getDB().query('SELECT cost FROM vms WHERE workload_id=?', [
        'z-after-cutoff',
      ]),
    ).toEqual([{ cost: BILL_USD }]);
  });

  it('allocates one bill across an oversized 10000-VM group', async () => {
    const account = await credential('account-a');
    await seedGroup({
      id: 'oversized',
      credentialId: account,
      weights: Array.from({ length: 10000 }, (_, index) => (index % 7) + 1),
    });
    await runCostCalculationOnce();
    expect(clientFactory).toHaveBeenCalledOnce();
    const [result] = await getDB().query(
      'SELECT COUNT(cost) AS settled,SUM(cost) AS total FROM vms',
    );
    expect(result.settled).toBe(10000);
    expect(result.total).toBeCloseTo(BILL_USD, 7);
  });

  it.each(['empty', 'error', 'ineligible'])(
    'services an I/O turn between pages of %s groups',
    async (response) => {
      const account = await credential('account-a');
      for (let index = 0; index < COST_CALCULATION_CONCURRENCY * 2; index++) {
        const id = 'a-skip-' + index;
        await seedGroup({
          id,
          credentialId: account,
          weights: [1],
          state:
            response === 'ineligible'
              ? WorkloadState.Running
              : WorkloadState.Completed,
        });
      }
      await seedGroup({ id: 'z-tail', credentialId: account, weights: [1] });
      let ioTurn = false;
      let tailSawIo = false;
      const io = new Promise((resolve) =>
        setImmediate(() => {
          ioTurn = true;
          resolve();
        }),
      );
      clientFactory.mockImplementation(() => ({
        send: async (command) => {
          const id = command.input.Filter.Tags.Values[0];
          if (id === 'z-tail') {
            tailSawIo = ioTurn;
            return bill(command);
          }
          if (response === 'error') throw new Error('Synthetic provider error');
          return { ResultsByTime: [] };
        },
      }));
      await runCostCalculationOnce();
      await io;
      expect(tailSawIo).toBe(true);
      expect(
        await getDB().query('SELECT COUNT(cost) AS settled FROM vms'),
      ).toEqual([{ settled: 1 }]);
    },
  );

  it.each(['success', 'failure'])(
    'services I/O before each settlement in one page, including %s',
    async (outcome) => {
      const account = await credential('account-a');
      const db = getDB();
      for (let index = 0; index < 4; index++) {
        await seedGroup({ id: 'queued-' + index, credentialId: account });
      }
      if (outcome === 'failure') {
        await db.query(`CREATE TEMP TRIGGER fail_queued_settlement
          BEFORE UPDATE OF cost ON vms
          WHEN NEW.workload_id = 'queued-1'
          BEGIN SELECT RAISE(ABORT, 'Synthetic queued settlement failure'); END`);
      }
      let turn = 0;
      let immediate;
      const tick = () => {
        turn++;
        immediate = setImmediate(tick);
      };
      immediate = setImmediate(tick);
      const turns = [];
      const transaction = db.db.transaction;
      vi.spyOn(db.db, 'transaction').mockImplementation(function (callback) {
        return transaction.call(this, function (...args) {
          turns.push(turn);
          return callback.apply(this, args);
        });
      });
      try {
        await runCostCalculationOnce();
      } finally {
        clearImmediate(immediate);
      }
      expect(turns).toHaveLength(4);
      expect(turns[0]).toBeGreaterThan(0);
      expect(new Set(turns).size).toBe(4);
      const totals = await db.query(
        'SELECT workload_id,COUNT(cost) AS settled,SUM(cost) AS total FROM vms GROUP BY workload_id ORDER BY workload_id',
      );
      for (const row of totals) {
        const failed = outcome === 'failure' && row.workload_id === 'queued-1';
        expect(row.settled).toBe(failed ? 0 : 3);
        if (failed) expect(row.total).toBeNull();
        else expect(row.total).toBeCloseTo(BILL_USD, 10);
      }
    },
  );

  it('rolls back a failed group, continues other groups, and retries its complete bill', async () => {
    const account = await credential('account-a');
    const db = getDB();
    const weights = Array.from({ length: 18 }, (_, index) => index + 1);
    await seedGroup({ id: 'a-interrupted', credentialId: account, weights });
    await seedGroup({ id: 'z-healthy', credentialId: account });
    await db.query(`CREATE TEMP TRIGGER interrupt_billing_settlement
      BEFORE UPDATE OF cost ON vms
      WHEN NEW.workload_id = 'a-interrupted' AND NEW.cost IS NOT NULL
        AND (SELECT COUNT(cost) FROM vms WHERE workload_id = 'a-interrupted') = 4
      BEGIN SELECT RAISE(ABORT, 'Synthetic fifth write failure'); END`);
    const transactionStates = [];
    clientFactory.mockImplementation(() => ({
      send: async (command) => {
        transactionStates.push(db.db.inTransaction);
        await new Promise((resolve) => setImmediate(resolve));
        transactionStates.push(db.db.inTransaction);
        return bill(command);
      },
    }));
    await runCostCalculationOnce();
    expect(transactionStates).toEqual([false, false]);
    const totals = await db.query(
      'SELECT workload_id,COUNT(cost) AS settled,SUM(cost) AS total FROM vms GROUP BY workload_id ORDER BY workload_id',
    );
    expect(totals[0]).toEqual({
      workload_id: 'a-interrupted',
      settled: 0,
      total: null,
    });
    expect(totals[1].settled).toBe(3);
    expect(totals[1].total).toBeCloseTo(137, 10);
    expect(await listVmsNeedingCost(getDB(), Date.now() - DAY_MS)).toHaveLength(
      18,
    );
    await db.query('DROP TRIGGER interrupt_billing_settlement');
    await runCostCalculationOnce();
    expect(clientFactory).toHaveBeenCalledTimes(2);
    const rows = await db.query(
      'SELECT cloud_id,cost FROM vms WHERE workload_id=?',
      ['a-interrupted'],
    );
    expect(rows).toHaveLength(18);
    for (const row of rows) {
      const weight = Number(row.cloud_id.split('-').at(-1)) + 1;
      // 1 + ... + 18 = 171; no production allocation helper in this oracle.
      expect(row.cost).toBeCloseTo((137 * weight) / 171, 10);
    }
    expect(rows.reduce((sum, row) => sum + row.cost, 0)).toBeCloseTo(137, 10);
  });

  it('settles immutable VM attempts when separate accounts reuse a cloud ID', async () => {
    const db = getDB();
    for (const [id, weights] of [
      ['account-a', [1, 2]],
      ['account-b', [1, 3]],
    ]) {
      const account = await credential(id);
      await seedGroup({ id, credentialId: account, weights });
      await db.query('UPDATE vms SET cloud_id=? WHERE cloud_id=?', [
        'same-provider-vm-id',
        id + '-vm-0',
      ]);
    }
    await runCostCalculationOnce();
    const rows = await db.query('SELECT workload_id,cloud_id,cost FROM vms');
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      const sharedId = row.cloud_id === 'same-provider-vm-id';
      const share =
        row.workload_id === 'account-a'
          ? (sharedId ? 1 : 2) / 3
          : (sharedId ? 1 : 3) / 4;
      expect(row.cost).toBeCloseTo(137 * share, 10);
    }
  });
});

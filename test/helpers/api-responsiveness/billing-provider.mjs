import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setImmediate, setTimeout } from 'node:timers/promises';

let expected = new Map();
let calls = new Map();
let groupVisits = new Map();
let failures = [];
let active = 0;
let peak = 0;
let response = 'empty';
let boundary = 'yield';
let delayMs = 0;

export const SYNTHETIC_BILL_USD = 137;

export function configureBillingProvider(groups, options) {
  expected = new Map(groups.map((group) => [group.key, group]));
  calls = new Map();
  groupVisits = new Map();
  failures = [];
  active = 0;
  peak = 0;
  response = options.response;
  boundary = options.boundary;
  delayMs = options.delayMs ?? 0;
}

export function billingProviderSnapshot() {
  return {
    calls: [...calls.values()].reduce((sum, count) => sum + count, 0),
    distinctGroups: calls.size,
    peak,
    failures,
    groups: [...calls].sort(([a], [b]) => a.localeCompare(b)),
    groupVisits: [...groupVisits].sort(([a], [b]) => a.localeCompare(b)),
  };
}

export function billingMemberDigest(rows) {
  return createHash('sha256')
    .update(
      JSON.stringify(
        rows
          .map((row) => [row.cloud_id, row.created_at, row.ended_at])
          .sort(([a], [b]) => a.localeCompare(b)),
      ),
    )
    .digest('hex');
}

/** Observe the unmodified gateway inputs, including when bills are empty. */
// Released baselines up to v0.1.67 bill one group per call (rows, no GroupBy);
// drop that shape once the daily baseline release batches.
export function recordBillingGroups(identity, groups) {
  const batch = Array.isArray(groups[0]) ? groups : [groups];
  for (const rows of batch) recordBillingGroup(identity, rows);
}

function recordBillingGroup(identity, rows) {
  try {
    assert(rows.length > 0);
    const first = rows[0];
    const key = JSON.stringify([
      first.resource_tag,
      first.resource_id,
      identity.credentials.accessKeyId,
    ]);
    const group = expected.get(key);
    assert(group, 'Unexpected billing identity/group');
    assert.equal(rows.length, group.members, 'Incomplete billing group');
    assert.equal(
      billingMemberDigest(rows),
      group.membersSha256,
      'Billing group membership changed',
    );
    assert(
      rows.every(
        (row) =>
          row.credential_id === group.credentialId &&
          row.resource_id === group.resourceId &&
          row.resource_tag === first.resource_tag,
      ),
      'Mixed billing identities in one group',
    );
    groupVisits.set(key, (groupVisits.get(key) ?? 0) + 1);
    assert.equal(groupVisits.get(key), 1, 'Billing group visited twice');
  } catch (error) {
    failures.push(error.message);
    throw error;
  }
}

/** Only the external Cost Explorer response is replaced; AWS allocation is real. */
export function createAwsCostExplorerClient(credentials, options) {
  return {
    async send(command) {
      try {
        assert.equal(options.region, 'us-east-1');
        const filter = command.input.Filter?.Tags;
        const grouped = command.input.GroupBy !== undefined;
        if (grouped) {
          assert.deepEqual(command.input.GroupBy, [
            { Type: 'TAG', Key: filter?.Key },
          ]);
        } else assert.equal(filter?.Values?.length, 1);
        const batch = (filter?.Values ?? []).map((value) => {
          const key = JSON.stringify([
            filter.Key,
            value,
            credentials.accessKeyId,
          ]);
          const group = expected.get(key);
          assert(group, 'Unexpected billing resource/account: ' + key);
          return { key, value, group };
        });
        assert(batch.length > 0, 'Empty billing batch');
        assert.equal(credentials.secretAccessKey, 'synthetic-no-authority');
        const periods = batch.map(({ group }) => group.timePeriod);
        assert.deepEqual(command.input.TimePeriod, {
          Start: periods.map((period) => period.Start).sort()[0],
          End: periods
            .map((period) => period.End)
            .sort()
            .at(-1),
        });
        assert.equal(command.input.NextPageToken, undefined);
        // Mixed bills fail every third group. A batch holding one is rejected
        // as malformed so the monitor retries per group; each group counts
        // once, on the call that answers or fails it alone.
        const failing =
          response === 'mixed' &&
          batch.some(({ group }) => group.ordinal % 3 === 2);
        if (!failing || batch.length === 1) {
          for (const { key } of batch)
            calls.set(key, (calls.get(key) ?? 0) + 1);
        }
        active++;
        peak = Math.max(peak, active);
        try {
          if (delayMs > 0) await setTimeout(delayMs);
          else if (boundary === 'yield') await setImmediate();
          if (failing) {
            throw Object.assign(
              new Error('Synthetic billing provider unavailable'),
              { statusCode: batch.length > 1 ? 400 : 503 },
            );
          }
          // A batch answers per owner: mixed settles every third group.
          const settled = batch.filter(
            ({ group }) =>
              response === 'settled' ||
              (response === 'mixed' && group.ordinal % 3 === 0),
          );
          const Amount = String(SYNTHETIC_BILL_USD);
          if (!grouped) {
            return {
              ResultsByTime: settled.map(() => ({
                Total: { UnblendedCost: { Amount, Unit: 'USD' } },
              })),
            };
          }
          return {
            ResultsByTime: settled.map(({ value, group }) => ({
              TimePeriod: group.timePeriod,
              Groups: [
                {
                  Keys: [filter.Key + '$' + value],
                  Metrics: { UnblendedCost: { Amount, Unit: 'USD' } },
                },
              ],
            })),
          };
        } finally {
          active--;
        }
      } catch (error) {
        // The monitor catches provider failures. Invariant failures must survive it.
        if (error.message !== 'Synthetic billing provider unavailable') {
          failures.push(error.message);
        }
        throw error;
      }
    },
  };
}

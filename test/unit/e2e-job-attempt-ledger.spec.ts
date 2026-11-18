import { describe, expect, test } from 'vitest';

import { CloudType } from '../../src/shared/cloud.js';
import { CliDatabase } from '../integration/e2e/internal/database.js';
import { JobAttemptLedger } from '../integration/e2e/internal/job-attempt-ledger.js';
import type { CommandResult } from '../integration/e2e/internal/types.js';
import {
  commandResultForTest,
  trackedWorkloadRefForTest,
} from './helpers/e2e.js';

const ref = trackedWorkloadRefForTest('job-original');
const identity = {
  provider: CloudType.AWS as const,
  credentialId: 'credential-original',
  controller: { url: 'http://job-controller.invalid', generation: 1 },
};

function attempt(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 1,
    workload_id: ref.id,
    created_at: 100,
    ended_at: null,
    cloud_id: 'i-0123456789abcdef0',
    ip: '192.0.2.1',
    region: 'us-east-1',
    availability_zone: 'us-east-1a',
    vm_type: 't3.large',
    credential_id: identity.credentialId,
    cloud_provider: 'AWS',
    ...overrides,
  };
}

function harness(initial: readonly Record<string, unknown>[]) {
  let rows = initial;
  let response: Partial<CommandResult> = {};
  let envelope: Record<string, unknown> = {};
  let active = true;
  let controller = { ...identity.controller };
  let replaceDuringRead = false;
  const sql: string[] = [];
  const database = new CliDatabase({
    run: async (args) => {
      sql.push(args.at(-1) ?? '');
      if (replaceDuringRead)
        controller = { ...controller, generation: controller.generation + 1 };
      return commandResultForTest({
        stdout: JSON.stringify({
          rows,
          rowCount: rows.length,
          truncated: false,
          ...envelope,
        }),
        ...response,
      });
    },
  });
  const ledger = new JobAttemptLedger({
    api: {
      get controller() {
        return controller;
      },
    },
    database,
    kernel: {
      assertActive: (candidate) => {
        if (!active || candidate !== ref)
          throw new Error('Reference is inactive or foreign');
      },
    },
  });
  return {
    ledger,
    sql,
    replaceDuringRead() {
      replaceDuringRead = true;
    },
    setRows(value: readonly Record<string, unknown>[]) {
      rows = value;
    },
    setEnvelope(value: Record<string, unknown>) {
      envelope = value;
    },
    setResult(value: Partial<CommandResult>) {
      response = value;
    },
    release() {
      active = false;
    },
  };
}

describe('complete Job attempt inventory', () => {
  test('a controller replacement during a later query retains only the original history', async () => {
    const world = harness([attempt()]);
    await world.ledger.read(ref, identity);
    world.setRows([
      attempt(),
      attempt({ id: 2, cloud_id: 'i-22222222222222222' }),
    ]);
    world.replaceDuringRead();
    await expect(world.ledger.read(ref, identity)).rejects.toThrow(
      'original controller',
    );
    expect(world.ledger.observations(ref).map((row) => row.rowId)).toEqual([1]);
    await expect(world.ledger.read(ref, identity)).rejects.toThrow(
      'original controller',
    );
    expect(world.sql).toHaveLength(2);
    await expect(
      world.ledger.read(ref, {
        ...identity,
        controller: { ...identity.controller, generation: 2 },
      }),
    ).rejects.toThrow('original registration');
    expect(world.sql).toHaveLength(2);
  });

  test('retains a validated prefix when a later row is foreign or malformed', async () => {
    const world = harness([
      attempt(),
      attempt({ id: 2, credential_id: 'foreign' }),
    ]);
    await expect(world.ledger.read(ref, identity)).rejects.toThrow(
      'different Workload or credential',
    );
    expect(world.ledger.observations(ref)).toMatchObject([
      { rowId: 1, cloudId: 'i-0123456789abcdef0' },
    ]);
    world.setRows([]);
    await expect(world.ledger.read(ref, identity)).rejects.toThrow(
      'lost tracked provisioning attempt',
    );
  });

  test('uses the caller deadline for the complete inventory read', async () => {
    const world = harness([]);
    await expect(
      world.ledger.read(ref, identity, Date.now() - 1),
    ).rejects.toThrow('deadline');
    expect(world.sql).toEqual([]);
  });
  test('includes ended and failed reservations with their own original coordinates', async () => {
    const world = harness([
      attempt({ ended_at: 200 }),
      attempt({
        id: 2,
        created_at: 201,
        cloud_id: 'ac-job-original-1',
        ip: null,
        region: 'us-west-2',
        availability_zone: 'us-west-2b',
        vm_type: 't3.xlarge',
      }),
    ]);
    const rows = await world.ledger.read(ref, identity);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      rowId: 1,
      endedAt: 200,
      cloudId: 'i-0123456789abcdef0',
      region: 'us-east-1',
    });
    expect(rows[1]).toMatchObject({
      rowId: 2,
      ip: null,
      cloudId: 'ac-job-original-1',
      region: 'us-west-2',
      availabilityZone: 'us-west-2b',
      credentialId: 'credential-original',
    });
    expect(world.sql[0]).toContain("v.workload_id = 'job-original'");
    expect(world.sql[0]).not.toMatch(
      /ended_at IS NULL|ip IS NOT NULL|JOIN workloads/u,
    );
    expect(rows.every((row) => row.ref === ref && Object.isFrozen(row))).toBe(
      true,
    );
    expect(Object.isFrozen(rows)).toBe(true);
  });

  test.each([
    { truncated: true },
    { truncated: undefined },
    { rowCount: 2 },
    { rowCount: undefined },
    { rowCount: '1' },
    { rows: [] },
  ])(
    'rejects incomplete or inconsistent database inventory %#',
    async (envelope) => {
      const world = harness([attempt()]);
      world.setEnvelope(envelope);
      await expect(world.ledger.read(ref, identity)).rejects.toThrow(
        'incomplete or invalid',
      );
    },
  );

  test.each([
    { outputTruncated: true },
    { aborted: true },
    { timedOut: true },
    { spawnError: 'no process' },
    { signal: 'SIGTERM' as const },
    { exitCode: 1 },
  ])(
    'refuses incomplete process output even with plausible rows %#',
    async (result) => {
      const world = harness([attempt()]);
      world.setResult(result);
      await expect(world.ledger.read(ref, identity)).rejects.toThrow(
        'did not complete',
      );
    },
  );

  test.each([
    { workload_id: 'another-job' },
    { credential_id: 'new-credential' },
    { credential_id: null },
    { cloud_provider: 'Azure' },
    { cloud_provider: null },
    { id: 0 },
    { created_at: 'invalid' },
    { ended_at: 99 },
    { cloud_id: '' },
    { region: null },
    { vm_type: null },
    { availability_zone: undefined },
  ])(
    'rejects missing or substituted original attempt facts %#',
    async (change) => {
      const world = harness([attempt(change)]);
      const [result] = await Promise.allSettled([
        world.ledger.read(ref, identity),
      ]);
      expect(result?.status).toBe('rejected');
    },
  );

  test('does not borrow a credential for an old public-cloud attempt', async () => {
    const world = harness([
      attempt({ credential_id: null, cloud_provider: null }),
    ]);
    await expect(
      world.ledger.read(ref, {
        ...identity,
        provider: CloudType.AWS,
        credentialId: null,
      }),
    ).rejects.toThrow('original compute credential');
    expect(world.sql).toEqual([]);
  });

  test('accepts credentialless Local facts only for the captured Local member', async () => {
    const world = harness([
      attempt({
        cloud_id: 'ac-local-job-original-0',
        region: 'local',
        availability_zone: null,
        vm_type: 'local',
        credential_id: null,
        cloud_provider: null,
      }),
    ]);
    const rows = await world.ledger.read(ref, {
      provider: CloudType.Local,
      credentialId: null,
      controller: identity.controller,
    });
    expect(rows[0]).toMatchObject({
      cloudProvider: CloudType.Local,
      credentialId: null,
      region: 'local',
    });
  });

  test('accepts provider adoption of a reserved attempt while retaining completed native attempts', async () => {
    const world = harness([
      attempt({
        cloud_id: 'ac-job-original-0',
        ip: null,
        availability_zone: null,
      }),
    ]);
    await world.ledger.read(ref, identity);
    world.setRows([attempt()]);
    expect((await world.ledger.read(ref, identity))[0]?.cloudId).toBe(
      'i-0123456789abcdef0',
    );
    world.setRows([
      attempt({ ended_at: 200 }),
      attempt({
        id: 2,
        created_at: 201,
        cloud_id: 'i-11111111111111111',
        ip: '192.0.2.2',
      }),
    ]);
    expect(await world.ledger.read(ref, identity)).toHaveLength(2);
  });

  test('retains original reservation evidence while adopting provider time/zone and reopening cleanup', async () => {
    const reserved = attempt({
      cloud_id: 'job-reservation-0',
      ip: null,
      created_at: 100,
      ended_at: 200,
      availability_zone: 'a',
    });
    const world = harness([reserved]);
    await world.ledger.read(ref, identity);
    world.setRows([
      attempt({ created_at: 110, ended_at: null, availability_zone: 'b' }),
    ]);
    const adopted = await world.ledger.read(ref, identity);
    expect(adopted[0]).toMatchObject({
      createdAt: 110,
      endedAt: null,
      availabilityZone: 'b',
    });
    expect(world.ledger.observations(ref)).toMatchObject([
      {
        cloudId: 'job-reservation-0',
        createdAt: 100,
        endedAt: 200,
        availabilityZone: 'a',
      },
      {
        cloudId: 'i-0123456789abcdef0',
        createdAt: 110,
        endedAt: null,
        availabilityZone: 'b',
      },
    ]);
  });

  test('allows exact failed-launch retargeting of an ended IP-null reservation and preserves both identities', async () => {
    const world = harness([
      attempt({ cloud_id: 'job-reservation-0', ip: null, ended_at: 200 }),
    ]);
    await world.ledger.read(ref, identity);
    world.setRows([attempt({ ip: null, ended_at: null })]);
    expect((await world.ledger.read(ref, identity))[0]).toMatchObject({
      cloudId: 'i-0123456789abcdef0',
      ip: null,
      endedAt: null,
    });
    expect(world.ledger.observations(ref)).toHaveLength(2);
  });

  test.each([
    { cloud_id: 'job-reservation-0', ip: null, ended_at: null },
    { cloud_id: 'job-reservation-0', ip: null, ended_at: 300 },
    { cloud_id: 'i-11111111111111111', ip: null, ended_at: 300 },
    {
      cloud_id: 'i-11111111111111111',
      ip: '192.0.2.2',
      created_at: 110,
      ended_at: 300,
      availability_zone: 'us-east-1b',
    },
  ])(
    'accepts retarget/adoption snapshots even when the attempt ended before the next observation %#',
    async (change) => {
      const world = harness([
        attempt({ cloud_id: 'job-reservation-0', ip: null, ended_at: 200 }),
      ]);
      const original = await world.ledger.read(ref, identity);
      world.setRows([attempt(change)]);
      const current = await world.ledger.read(ref, identity);
      expect(current[0]).toMatchObject({
        cloudId: change.cloud_id,
        ip: change.ip,
        endedAt: change.ended_at,
      });
      expect(world.ledger.observations(ref)).toEqual([...original, ...current]);
    },
  );

  test.each([
    {
      original: { ip: null, availability_zone: null },
      current: { ip: null, availability_zone: 'us-east-1a' },
    },
    {
      original: { availability_zone: null },
      current: { availability_zone: 'us-east-1a' },
    },
    {
      original: { ip: null, availability_zone: 'us-east-1a' },
      current: { availability_zone: null },
    },
    {
      original: { ip: null, availability_zone: 'us-east-1a' },
      current: { ip: null, availability_zone: 'us-east-1b' },
    },
  ])(
    'rejects zone rewrites outside native adoption and cannot clear a known reserved zone %#',
    async ({ original, current }) => {
      const world = harness([attempt(original)]);
      const prior = await world.ledger.read(ref, identity);
      world.setRows([attempt(current)]);
      await expect(world.ledger.read(ref, identity)).rejects.toThrow(
        'rewrote original coordinates',
      );
      expect(world.ledger.observations(ref)).toEqual(prior);
    },
  );

  test.each([
    { cloud_id: 'i-11111111111111111' },
    { region: 'us-west-2' },
    { availability_zone: 'us-east-1b' },
    { created_at: 101 },
    { ip: '192.0.2.2' },
    { vm_type: 't3.xlarge' },
  ])(
    'retains the original snapshot when an established attempt is rewritten %#',
    async (change) => {
      const world = harness([attempt()]);
      const original = await world.ledger.read(ref, identity);
      world.setRows([attempt(change)]);
      await expect(world.ledger.read(ref, identity)).rejects.toThrow(
        'rewrote original coordinates',
      );
      world.setRows([attempt()]);
      expect(await world.ledger.read(ref, identity)).toEqual(original);
    },
  );

  test('rejects missing, repeated or resurrected attempt rows instead of shrinking cleanup inventory', async () => {
    const world = harness([attempt({ ended_at: 200 })]);
    await world.ledger.read(ref, identity);
    world.setRows([]);
    await expect(world.ledger.read(ref, identity)).rejects.toThrow(
      'lost tracked provisioning attempt',
    );
    world.setRows([attempt({ ended_at: 200 }), attempt({ ended_at: 200 })]);
    await expect(world.ledger.read(ref, identity)).rejects.toThrow(
      'repeats or omits',
    );
    world.setRows([attempt()]);
    await expect(world.ledger.read(ref, identity)).rejects.toThrow(
      'rewrote original coordinates',
    );
  });

  test('binds the original credential even when the first inventory is empty', async () => {
    const world = harness([]);
    await world.ledger.read(ref, identity);
    world.setRows([attempt({ credential_id: 'substituted-credential' })]);
    await expect(
      world.ledger.read(ref, {
        provider: CloudType.AWS,
        credentialId: 'substituted-credential',
        controller: identity.controller,
      }),
    ).rejects.toThrow('original registration');
    expect(world.sql).toHaveLength(1);
  });

  test('captures identity before an asynchronous read can mutate caller input', async () => {
    const mutable = { ...identity };
    const database = {
      queryComplete: async () => {
        mutable.credentialId = 'substituted-credential';
        return [attempt()];
      },
    };
    const ledger = new JobAttemptLedger({
      api: { controller: identity.controller },
      database,
      kernel: { assertActive: () => undefined },
    });
    expect((await ledger.read(ref, mutable))[0]?.credentialId).toBe(
      identity.credentialId,
    );
    await expect(ledger.read(ref, mutable)).rejects.toThrow(
      'original registration',
    );
  });

  test('does not query through a released or foreign reference', async () => {
    const world = harness([attempt()]);
    await expect(
      world.ledger.read(trackedWorkloadRefForTest(ref.id), identity),
    ).rejects.toThrow('foreign');
    world.release();
    await expect(world.ledger.read(ref, identity)).rejects.toThrow('inactive');
    expect(world.sql).toEqual([]);
  });
});

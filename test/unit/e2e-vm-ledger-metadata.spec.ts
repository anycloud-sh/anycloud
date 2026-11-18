import { describe, expect, test, vi } from 'vitest';

import type { CliClient } from '../integration/e2e/internal/cli.js';
import type { CommandResult } from '../integration/e2e/internal/types.js';
import { VmLedgerProbe } from '../integration/e2e/internal/vm-ledger.js';
import {
  commandResultForTest,
  trackedWorkloadRefForTest,
} from './helpers/e2e.js';

const metadata = {
  workload_id: 'vm-test',
  cloud_id: 'cloud-vm-1',
  ended_at: null,
  ip: '127.0.0.1',
  ssh_host: 'localhost',
  ssh_port: 2222,
  ssh_username: 'root',
  base_image_id: 'base-image:test',
};

function fixture(
  rows: readonly unknown[] = [metadata],
  command: Partial<CommandResult> = {},
  envelope: Record<string, unknown> = {},
) {
  const run = vi.fn<CliClient['run']>(async () =>
    commandResultForTest({
      stdout: JSON.stringify({
        rows,
        rowCount: rows.length,
        truncated: false,
        ...envelope,
      }),
      ...command,
    }),
  );
  const assertActive = vi.fn();
  const probe = new VmLedgerProbe(
    { run },
    {
      assertActive,
      recordLedgerCleared: () => {
        throw new Error('Unexpected ledger release');
      },
    },
  );
  return {
    run,
    assertActive,
    probe,
    ref: trackedWorkloadRefForTest('vm-test'),
  };
}

describe('Persistent VM live database metadata', () => {
  test('retains only validated metadata from one owned live VM without raw artifacts', async () => {
    const world = fixture([
      { ...metadata, credential: 'must-not-be-retained' },
    ]);
    await expect(world.probe.liveVmMetadata(world.ref)).resolves.toEqual({
      cloudId: 'cloud-vm-1',
      baseImageId: 'base-image:test',
      sshHost: 'localhost',
      sshPort: 2222,
      sshUsername: 'root',
    });
    expect(world.assertActive).toHaveBeenCalledWith(world.ref);
    expect(world.run).toHaveBeenCalledWith(
      [
        'db',
        'query',
        '--json',
        expect.stringContaining("workload_id = 'vm-test' AND ended_at IS NULL"),
      ],
      expect.objectContaining({
        label: 'db-live-vm-metadata',
        recordArtifact: false,
      }),
    );
    expect(world.run.mock.calls[0]?.[0].at(-1)).not.toContain('LIMIT 1');
  });

  test('uses explicit SQL null SSH defaults and normalizes numeric cloud IDs', async () => {
    const world = fixture([
      {
        ...metadata,
        cloud_id: 123,
        ssh_host: null,
        ssh_port: null,
        ssh_username: null,
        base_image_id: null,
      },
    ]);
    await expect(world.probe.liveVmMetadata(world.ref)).resolves.toEqual({
      cloudId: '123',
      baseImageId: null,
      sshHost: '127.0.0.1',
      sshPort: 22,
      sshUsername: 'root',
    });
  });

  test.each([
    { label: 'no live VM', rows: [] },
    { label: 'duplicate live VMs', rows: [metadata, metadata] },
    {
      label: 'foreign workload',
      rows: [{ ...metadata, workload_id: 'foreign' }],
    },
    { label: 'ended VM', rows: [{ ...metadata, ended_at: 100 }] },
    {
      label: 'missing ownership',
      rows: [{ ...metadata, workload_id: undefined }],
    },
    {
      label: 'missing live marker',
      rows: [{ ...metadata, ended_at: undefined }],
    },
    ...[
      ['cloud_id', null],
      ['cloud_id', ''],
      ['cloud_id', 1.5],
      ['ip', undefined],
      ['ssh_host', undefined],
      ['ssh_host', 7],
      ['ssh_host', ''],
      ['ssh_port', undefined],
      ['ssh_port', '2222'],
      ['ssh_port', 0],
      ['ssh_port', 65536],
      ['ssh_port', 1.5],
      ['ssh_username', undefined],
      ['ssh_username', ''],
      ['ssh_username', false],
      ['base_image_id', undefined],
      ['base_image_id', 7],
    ].map(([key, value]) => ({
      label: `invalid ${String(key)} ${String(value)}`,
      rows: [{ ...metadata, [String(key)]: value }],
    })),
  ])('rejects $label', async ({ rows }) => {
    const world = fixture(rows);
    await expect(world.probe.liveVmMetadata(world.ref)).rejects.toThrow();
  });

  test.each([
    { label: 'truncated response', envelope: { truncated: true } },
    { label: 'partial row count', envelope: { rowCount: 2 } },
    {
      label: 'missing completeness metadata',
      envelope: { truncated: undefined },
    },
  ])('rejects $label', async ({ envelope }) => {
    const world = fixture([metadata], {}, envelope);
    await expect(world.probe.liveVmMetadata(world.ref)).rejects.toThrow(
      'incomplete or invalid',
    );
  });

  test.each([
    { outputTruncated: true },
    { timedOut: true },
    { aborted: true },
    { signal: 'SIGTERM' as const },
    { exitCode: 1 },
    { spawnError: 'failed' },
  ])('rejects incomplete process output %j', async (command) => {
    const world = fixture([metadata], command);
    await expect(world.probe.liveVmMetadata(world.ref)).rejects.toThrow();
  });

  test('does not expose unvalidated response text on a schema failure', async () => {
    const world = fixture([], {
      stdout: '{"credential":"must-not-be-retained"',
    });
    await expect(world.probe.liveVmMetadata(world.ref)).rejects.toThrow(
      'was not JSON',
    );
    await expect(world.probe.liveVmMetadata(world.ref)).rejects.not.toThrow(
      'must-not-be-retained',
    );
  });
});

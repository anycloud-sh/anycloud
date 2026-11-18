import { createHash } from 'node:crypto';
import type { EC2Client } from '@aws-sdk/client-ec2';
import { describe, expect, it, vi } from 'vitest';
import {
  managedGpuRunOwners,
  observeManagedGpuAws,
  recoverManagedGpuRun,
  type ManagedGpuCleanupAuthority,
  type ManagedGpuRecoveryOperations,
} from '../../../ci/cleanup/managed-gpu-run.js';

const sha = (value: Buffer | string) =>
  createHash('sha256').update(value).digest('hex');
const candidate = Buffer.from(JSON.stringify({ sourceSha: 'b'.repeat(40) }));
const authority: ManagedGpuCleanupAuthority = {
  schemaVersion: 1,
  repository: 'anycloud-sh/anycloud',
  workflowRunId: '12345678',
  workflowRunAttempt: 2,
  workflowSourceSha: 'a'.repeat(40),
  candidateSourceSha: 'b'.repeat(40),
  candidateManifestSha256: sha(candidate),
  fixtureRunId: sha('managed-gpu:12345678:2').slice(0, 10),
  createdAt: '2026-09-09T00:00:00.000Z',
  host: { provider: 'aws', region: 'us-east-2' },
  state: { provider: 'aws', region: 'us-east-1' },
  capacity: { provider: 'azure', region: 'westus2' },
  awsAccountId: '123456789012',
  azureSubscriptionId: '11111111-2222-4333-8444-555555555555',
};
// The cleanup authority producer retired with the Cluster surface; the
// recovery tool still consumes retained authorities for abandoned attempts.
describe('manual recovery deletion boundaries', () => {
  const operations = (): ManagedGpuRecoveryOperations => ({
    stopHosts: vi.fn().mockResolvedValue(undefined),
    cleanupAzure: vi.fn().mockResolvedValue([]),
    cleanupAwsSupporting: vi.fn().mockResolvedValue([]),
    cleanupDns: vi.fn().mockResolvedValue(undefined),
    cleanupState: vi.fn().mockResolvedValue(undefined),
  });

  it('confirms cleanup in dependency order and repeats from a fresh operation set', async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const ops = operations();
      const result = await recoverManagedGpuRun(ops);
      expect(result).toEqual({
        confirmed: true,
        completed: [
          'aws-hosts',
          'azure-capacity',
          'aws-supporting-resources',
          'dns',
          'aws-state',
        ],
        residualResources: [],
        errors: [],
      });
      const order = Object.values(ops).map(
        (fn) => vi.mocked(fn).mock.invocationCallOrder[0],
      );
      expect(order).toEqual([...order].sort((a, b) => a - b));
    }
  });

  it('does not touch Azure, DNS or checkpoint state when host absence is unconfirmed', async () => {
    const ops = operations();
    vi.mocked(ops.stopHosts).mockRejectedValue(new Error('host still running'));
    expect((await recoverManagedGpuRun(ops)).confirmed).toBe(false);
    for (const key of [
      'cleanupAzure',
      'cleanupAwsSupporting',
      'cleanupDns',
      'cleanupState',
    ] as const)
      expect(ops[key]).not.toHaveBeenCalled();
  });

  it.each(['cleanupAzure', 'cleanupAwsSupporting', 'cleanupDns'] as const)(
    'retains checkpoint state after %s fails',
    async (key) => {
      const ops = operations();
      vi.mocked(ops[key]).mockRejectedValue(new Error('denied'));
      expect((await recoverManagedGpuRun(ops)).confirmed).toBe(false);
      expect(ops.cleanupState).not.toHaveBeenCalled();
    },
  );

  it('retains residual resource IDs and checkpoint state instead of certifying partial coverage', async () => {
    const ops = operations();
    vi.mocked(ops.cleanupAzure).mockResolvedValue(['azure:disk:retained']);
    expect(await recoverManagedGpuRun(ops)).toMatchObject({
      confirmed: false,
      residualResources: ['azure:disk:retained'],
      completed: ['aws-hosts', 'aws-supporting-resources'],
    });
    expect(ops.cleanupState).not.toHaveBeenCalled();
  });

  it('uses exact workload and owner tags for AWS inventory and rejects permission failures', async () => {
    const owners = managedGpuRunOwners(authority);
    const tags = [
      { Key: 'anycloud_deployment', Value: owners.host },
      { Key: 'anycloud_owner_api', Value: 'd'.repeat(32) },
    ];
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Reservations: [
          {
            Instances: [
              { InstanceId: 'i-owned', State: { Name: 'running' }, Tags: tags },
            ],
          },
        ],
      })
      .mockResolvedValueOnce({ Volumes: [] })
      .mockResolvedValueOnce({ NetworkInterfaces: [] })
      .mockResolvedValueOnce({ Addresses: [] });
    const ec2: Pick<EC2Client, 'send'> = { send };
    expect(await observeManagedGpuAws(ec2, authority)).toMatchObject({
      instances: ['i-owned'],
    });
    for (const [command] of send.mock.calls)
      expect(command.input.Filters).toEqual([
        { Name: 'tag:anycloud_deployment', Values: owners.workloads },
      ]);
    send.mockReset().mockResolvedValueOnce({
      Reservations: [
        {
          Instances: [
            {
              InstanceId: 'i-foreign',
              State: { Name: 'running' },
              Tags: [{ Key: 'anycloud_deployment', Value: 'customer' }],
            },
          ],
        },
      ],
    });
    await expect(observeManagedGpuAws(ec2, authority)).rejects.toThrow(
      'outside the exact',
    );
    send.mockReset().mockRejectedValue(new Error('AccessDenied'));
    await expect(observeManagedGpuAws(ec2, authority)).rejects.toThrow(
      'AccessDenied',
    );
  });
});

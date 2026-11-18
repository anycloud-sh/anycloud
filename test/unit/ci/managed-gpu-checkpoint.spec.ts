import { GetBucketTaggingCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import {
  cleanupManagedGpuCheckpoint,
  type ManagedGpuCleanupAuthority,
} from '../../../ci/cleanup/managed-gpu-run.js';

const authority: ManagedGpuCleanupAuthority = {
  schemaVersion: 1,
  repository: 'anycloud-sh/anycloud',
  workflowRunId: '12345678',
  workflowRunAttempt: 2,
  workflowSourceSha: 'a'.repeat(40),
  candidateSourceSha: 'b'.repeat(40),
  candidateManifestSha256: 'c'.repeat(64),
  fixtureRunId: '123456789a',
  createdAt: '2026-09-09T00:00:00.000Z',
  host: { provider: 'aws', region: 'us-east-2' },
  state: { provider: 'aws', region: 'us-east-1' },
  capacity: { provider: 'azure', region: 'westus2' },
  awsAccountId: '123456789012',
  azureSubscriptionId: '11111111-2222-4333-8444-555555555555',
};
const bucket = 'anycloud-mk8s-123456789a';
const request = {
  Bucket: bucket,
  ExpectedBucketOwner: '123456789012',
};
const ownerTags = {
  anycloud_owner_api: 'd'.repeat(32),
  anycloud_created_at: String(Date.parse(authority.createdAt)),
};
const tagged = (tags: Record<string, string> = ownerTags) => ({
  TagSet: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
});
const missing = () =>
  Object.assign(new Error('Not Found'), {
    $metadata: { httpStatusCode: 404 },
  });
const forbidden = () =>
  Object.assign(new Error('Access Denied'), {
    $metadata: { httpStatusCode: 403 },
  });

function setup() {
  const send = vi.fn().mockRejectedValue(new Error('Unexpected S3 request'));
  const deleteBucket = vi
    .fn<(bucketName: string) => Promise<void>>()
    .mockResolvedValue();
  const cleanup = () =>
    cleanupManagedGpuCheckpoint({ send }, { deleteBucket }, authority);
  return { send, deleteBucket, cleanup };
}

describe('manual managed GPU checkpoint recovery', () => {
  it('accepts an authoritative 404 without reading tags or deleting anything', async () => {
    const { send, deleteBucket, cleanup } = setup();
    send.mockRejectedValueOnce(missing());

    await expect(cleanup()).resolves.toBeUndefined();

    expect(send).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ input: request }),
    );
    expect(send.mock.calls[0][0]).toBeInstanceOf(HeadBucketCommand);
    expect(deleteBucket).not.toHaveBeenCalled();
  });

  it.each([0, 1000])(
    'deletes only the authorized bucket created %i ms after reservation and confirms absence',
    async (offset) => {
      const { send, deleteBucket, cleanup } = setup();
      send
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce(
          tagged({
            ...ownerTags,
            anycloud_created_at: String(
              Date.parse(authority.createdAt) + offset,
            ),
          }),
        )
        .mockRejectedValueOnce(missing())
        .mockRejectedValueOnce(missing());

      await expect(cleanup()).resolves.toBeUndefined();
      await expect(cleanup()).resolves.toBeUndefined();

      expect(deleteBucket).toHaveBeenCalledExactlyOnceWith(bucket);
      expect(send.mock.calls.map(([command]) => command.constructor)).toEqual([
        HeadBucketCommand,
        GetBucketTaggingCommand,
        HeadBucketCommand,
        HeadBucketCommand,
      ]);
      for (const [command] of send.mock.calls)
        expect(command.input).toEqual(request);
      expect(deleteBucket.mock.invocationCallOrder[0]).toBeGreaterThan(
        send.mock.invocationCallOrder[1],
      );
      expect(deleteBucket.mock.invocationCallOrder[0]).toBeLessThan(
        send.mock.invocationCallOrder[2],
      );
    },
  );

  it.each([
    ['403', forbidden()],
    ['transport failure', new Error('Connection reset')],
    [
      'name-only absence',
      Object.assign(new Error('Missing'), { name: 'NoSuchBucket' }),
    ],
  ])('refuses an initial %s without deleting the bucket', async (_, error) => {
    const { send, deleteBucket, cleanup } = setup();
    send.mockRejectedValueOnce(error);

    await expect(cleanup()).rejects.toBe(error);

    expect(send).toHaveBeenCalledTimes(1);
    expect(deleteBucket).not.toHaveBeenCalled();
  });

  it.each([
    ['403', forbidden()],
    ['404 during tagging', missing()],
    ['unknown failure', new Error('Unavailable')],
  ])('refuses a tagging %s without deleting the bucket', async (_, error) => {
    const { send, deleteBucket, cleanup } = setup();
    send.mockResolvedValueOnce({}).mockRejectedValueOnce(error);

    await expect(cleanup()).rejects.toBe(error);

    expect(send).toHaveBeenCalledTimes(2);
    expect(deleteBucket).not.toHaveBeenCalled();
  });

  it.each([
    ['missing tags', {}],
    ['missing owner', { anycloud_created_at: ownerTags.anycloud_created_at }],
    ['malformed owner', { ...ownerTags, anycloud_owner_api: 'foreign' }],
    ['missing time', { anycloud_owner_api: ownerTags.anycloud_owner_api }],
    ['invalid time', { ...ownerTags, anycloud_created_at: 'unknown' }],
    ['infinite time', { ...ownerTags, anycloud_created_at: 'Infinity' }],
    [
      'predates reservation',
      {
        ...ownerTags,
        anycloud_created_at: String(Date.parse(authority.createdAt) - 1),
      },
    ],
  ] as const)('refuses ownership with %s', async (_, tags) => {
    const { send, deleteBucket, cleanup } = setup();
    send.mockResolvedValueOnce({}).mockResolvedValueOnce(tagged(tags));

    await expect(cleanup()).rejects.toThrow(
      'Checkpoint bucket does not have ownership from this reserved run',
    );

    expect(send).toHaveBeenCalledTimes(2);
    expect(deleteBucket).not.toHaveBeenCalled();
  });

  it('propagates a deletion failure without claiming that state is gone', async () => {
    const { send, deleteBucket, cleanup } = setup();
    const error = new Error('Bucket deletion failed');
    send.mockResolvedValueOnce({}).mockResolvedValueOnce(tagged());
    deleteBucket.mockRejectedValueOnce(error);

    await expect(cleanup()).rejects.toBe(error);

    expect(send).toHaveBeenCalledTimes(2);
    expect(deleteBucket).toHaveBeenCalledExactlyOnceWith(bucket);
  });

  it('refuses to confirm cleanup while the bucket still exists', async () => {
    const { send, deleteBucket, cleanup } = setup();
    send
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(tagged())
      .mockResolvedValueOnce({});

    await expect(cleanup()).rejects.toThrow(
      'Checkpoint bucket absence is not confirmed',
    );

    expect(send).toHaveBeenCalledTimes(3);
    expect(deleteBucket).toHaveBeenCalledExactlyOnceWith(bucket);
  });

  it.each([
    ['403', forbidden()],
    ['unknown failure', new Error('No response')],
    [
      'name-only absence',
      Object.assign(new Error('Missing'), { name: 'NotFound' }),
    ],
  ])('refuses to confirm post-delete %s as absence', async (_, error) => {
    const { send, deleteBucket, cleanup } = setup();
    send
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(tagged())
      .mockRejectedValueOnce(error);

    await expect(cleanup()).rejects.toBe(error);

    expect(send).toHaveBeenCalledTimes(3);
    expect(deleteBucket).toHaveBeenCalledExactlyOnceWith(bucket);
  });
});

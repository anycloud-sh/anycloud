import { afterEach, describe, expect, onTestFinished, test, vi } from 'vitest';
import {
  jobNativeSessionFixture,
  JOB_NATIVE_CREDENTIALS,
} from '../helpers/e2e-job-native.js';
import { JobBucketNativeReader } from '../integration/e2e/internal/transports/job-bucket-native.js';
import { JobNativeReadIncomplete } from '../integration/e2e/internal/transports/job-cloud-session.js';
import type { CommandResult } from '../integration/e2e/internal/types.js';

afterEach(() => vi.restoreAllMocks());
const bucket = 'job-original-bucket';
const metadata = {
  anycloud_created_at: '1789960000000',
  anycloud_owner_api: 'a'.repeat(32),
  anycloud_user: 'test-user',
  anycloud_deployment: 'd-job-original',
};
const azureAccount = `/subscriptions/${JOB_NATIVE_CREDENTIALS.azure.subscriptionId}/resourceGroups/anycloud-storage/providers/Microsoft.Storage/storageAccounts/anycloud11111111`;
const containersPath = `${azureAccount}/blobServices/default/containers`;
const container = (name = bucket) => ({
  id: `${containersPath}/${name}`,
  name,
  type: 'Microsoft.Storage/storageAccounts/blobServices/containers',
  properties: { metadata },
});

describe('Job original native bucket identity and absence', () => {
  test.each(['$root', '$web', '$logs'])(
    'accepts the reserved Azure container %s in a complete unrelated inventory',
    async (reserved) => {
      const world = jobNativeSessionFixture(JOB_NATIVE_CREDENTIALS.azure);
      const reader = new JobBucketNativeReader(world.session, 'eastus');
      vi.spyOn(world.session, 'get').mockImplementation(async (url) => {
        if (url.pathname === azureAccount)
          return {
            status: 200,
            body: { id: azureAccount, location: 'eastus' },
          };
        if (url.pathname.endsWith(`/${bucket}`))
          return {
            status: 404,
            body: { error: { code: 'ContainerNotFound' } },
          };
        return { status: 200, body: { value: [container(reserved)] } };
      });
      await expect(
        reader.observe(bucket, Date.now() + 5_000),
      ).resolves.toMatchObject({ presence: 'absent', name: bucket });
    },
  );

  test.each([
    'complete',
    'denied',
    'present-later',
    'foreign-subscription',
    'later-page-denied',
  ] as const)(
    'corroborates a lazy Azure parent absence with complete authorized subscription inventory: %s',
    async (kind) => {
      const world = jobNativeSessionFixture(JOB_NATIVE_CREDENTIALS.azure);
      const reader = new JobBucketNativeReader(world.session, 'eastus');
      const accountsPath = `/subscriptions/${JOB_NATIVE_CREDENTIALS.azure.subscriptionId}/providers/Microsoft.Storage/storageAccounts`;
      const next = `https://management.azure.com${accountsPath}?api-version=2025-06-01&$skipToken=page2`;
      const get = vi
        .spyOn(world.session, 'get')
        .mockImplementation(async (url) => {
          if (url.pathname === azureAccount)
            return {
              status: 404,
              body: { error: { code: 'ResourceGroupNotFound' } },
            };
          if (!url.searchParams.has('$skipToken'))
            return {
              status: kind === 'denied' ? 403 : 200,
              body: {
                value: [
                  {
                    name: 'unrelatedaccount',
                    id: `${azureAccount.replace('anycloud11111111', 'unrelatedaccount')}${kind === 'foreign-subscription' ? '/foreign' : ''}`,
                    type: 'Microsoft.Storage/storageAccounts',
                  },
                ],
                nextLink: next,
              },
            };
          return {
            status: kind === 'later-page-denied' ? 403 : 200,
            body: {
              value:
                kind === 'present-later'
                  ? [
                      {
                        name: 'anycloud11111111',
                        id: azureAccount,
                        type: 'Microsoft.Storage/storageAccounts',
                      },
                    ]
                  : [],
            },
          };
        });
      const result = reader.observe(bucket, Date.now() + 5_000);
      if (kind === 'complete')
        await expect(result).resolves.toEqual({
          presence: 'absent',
          name: bucket,
          scope: azureAccount.toLowerCase(),
        });
      else await expect(result).rejects.toThrow();
      expect(
        get.mock.calls.every(([url]) => !url.pathname.includes('/containers')),
      ).toBe(true);
    },
  );

  test('binds S3 expected owner and captures actual automatic-bucket placement', async () => {
    const world = jobNativeSessionFixture(
      JOB_NATIVE_CREDENTIALS.aws,
      (_exe, args) => {
        if (args[1] === 'get-bucket-location')
          return '{"LocationConstraint":"us-west-2"}';
        return JSON.stringify({
          TagSet: Object.entries(metadata).map(([Key, Value]) => ({
            Key,
            Value,
          })),
        });
      },
    );
    const reader = new JobBucketNativeReader(world.session, 'us-east-1');
    await reader.initialize(Date.now() + 10_000);
    await expect(reader.observe(bucket, Date.now() + 5_000)).rejects.toThrow(
      'original region',
    );
    await expect(
      reader.observe(bucket, Date.now() + 5_000, false, true),
    ).resolves.toMatchObject({
      presence: 'present',
      identity: {
        provider: 'aws',
        scope: '123456789012',
        nativeId: `arn:aws:s3:::${bucket}`,
        region: 'us-west-2',
        workloadId: metadata.anycloud_deployment,
      },
    });
    for (const call of world.calls.filter((call) => call.args[0] === 's3api')) {
      expect(call.args).toContain('--expected-bucket-owner');
      expect(call.args).toContain('123456789012');
      expect(call.args).toContain(bucket);
    }
    expect(world.calls.at(-1)?.args).toContain(
      'https://s3.us-west-2.amazonaws.com',
    );
  });

  test.each([
    { label: 'complete exact NoSuchBucket', receipt: {}, absent: true },
    { label: 'truncated', receipt: { outputTruncated: true }, absent: false },
    { label: 'timed out', receipt: { timedOut: true }, absent: false },
    { label: 'cancelled', receipt: { aborted: true }, absent: false },
    { label: 'mixed success output', receipt: { stdout: '{}' }, absent: false },
    {
      label: 'authentication failure',
      receipt: {
        stderr:
          'An error occurred (AccessDenied) when calling the GetBucketLocation operation: denied',
      },
      absent: false,
    },
    {
      label: 'generic 404',
      receipt: { stderr: '404 Not Found' },
      absent: false,
    },
  ] satisfies Array<{
    label: string;
    receipt: Partial<CommandResult>;
    absent: boolean;
  }>)(
    'requires a complete typed S3 absence: $label',
    async ({ receipt, absent }) => {
      const world = jobNativeSessionFixture(JOB_NATIVE_CREDENTIALS.aws, () => ({
        exitCode: 255,
        stderr:
          'An error occurred (NoSuchBucket) when calling the GetBucketLocation operation: missing',
        ...receipt,
      }));
      const reader = new JobBucketNativeReader(world.session, 'us-east-1');
      await reader.initialize(Date.now() + 5_000);
      const operation = reader.observe(bucket, Date.now() + 5_000, true);
      if (absent)
        await expect(operation).resolves.toEqual({
          presence: 'absent',
          name: bucket,
          scope: '123456789012',
        });
      else await expect(operation).rejects.toThrow();
      expect(world.calls.at(-1)?.options?.signal).toBe(world.cleanup.signal);
    },
  );

  test.each(['missing', 'duplicate'] as const)(
    'rejects %s native S3 ownership metadata',
    async (failure) => {
      const tags = Object.entries(metadata).map(([Key, Value]) => ({
        Key,
        Value,
      }));
      if (failure === 'missing') tags.pop();
      else tags.push(tags[0]);
      const world = jobNativeSessionFixture(
        JOB_NATIVE_CREDENTIALS.aws,
        (_exe, args) =>
          args[1] === 'get-bucket-location'
            ? '{"LocationConstraint":null}'
            : JSON.stringify({ TagSet: tags }),
      );
      const reader = new JobBucketNativeReader(world.session, 'us-east-1');
      await reader.initialize(Date.now() + 5_000);
      await expect(
        reader.observe(bucket, Date.now() + 5_000),
      ).rejects.toThrow();
    },
  );

  test.each([
    'original',
    'foreign-project',
    'foreign-name',
    'foreign-location',
    'non-uniform',
  ] as const)(
    'validates GCS exact identity, project, placement and access: %s',
    async (kind) => {
      const world = jobNativeSessionFixture(JOB_NATIVE_CREDENTIALS.gcp);
      const reader = new JobBucketNativeReader(world.session, 'us-central1');
      await reader.initialize(Date.now() + 5_000);
      const body = {
        kind: 'storage#bucket',
        name: bucket,
        id: bucket,
        projectNumber: '1234567890',
        location: 'US-CENTRAL1',
        timeCreated: '2026-09-21T05:00:00Z',
        labels: metadata,
        iamConfiguration: {
          uniformBucketLevelAccess: { enabled: kind !== 'non-uniform' },
        },
      };
      if (kind === 'foreign-project') body.projectNumber = '9999999999';
      if (kind === 'foreign-name') body.name = 'foreign-bucket';
      if (kind === 'foreign-location') body.location = 'EUROPE-WEST1';
      vi.spyOn(world.session, 'get').mockResolvedValue({ status: 200, body });
      const operation = reader.observe(bucket, Date.now() + 5_000);
      if (kind === 'original')
        await expect(operation).resolves.toMatchObject({
          presence: 'present',
          identity: {
            scope: 'original-project/1234567890',
            region: 'us-central1',
            ownerApi: metadata.anycloud_owner_api,
          },
        });
      else
        await expect(operation).rejects.toThrow(
          'identity, location or uniform access',
        );
    },
  );

  test.each([
    {
      status: 404,
      body: {
        error: {
          code: 404,
          errors: [{ reason: 'notFound', domain: 'global' }],
        },
      },
      absent: true,
    },
    { status: 404, body: {}, absent: false },
    {
      status: 403,
      body: {
        error: {
          code: 403,
          errors: [{ reason: 'forbidden', domain: 'global' }],
        },
      },
      absent: false,
    },
    { status: 200, body: { items: [] }, absent: false },
  ])(
    'requires typed GCS bucket absence, never an empty object list: %j',
    async ({ status, body, absent }) => {
      const world = jobNativeSessionFixture(JOB_NATIVE_CREDENTIALS.gcp);
      const reader = new JobBucketNativeReader(world.session, 'us-central1');
      await reader.initialize(Date.now() + 5_000);
      vi.spyOn(world.session, 'get').mockResolvedValue({ status, body });
      const operation = reader.observe(bucket, Date.now() + 5_000);
      if (absent)
        await expect(operation).resolves.toMatchObject({
          presence: 'absent',
          name: bucket,
        });
      else await expect(operation).rejects.toThrow();
    },
  );

  test('retains the GCS reader grant three-attempt bound and two-second propagation pauses', async () => {
    const world = jobNativeSessionFixture(JOB_NATIVE_CREDENTIALS.gcp);
    const reader = new JobBucketNativeReader(world.session, 'us-central1');
    const pause = vi.spyOn(world.session, 'pause').mockResolvedValue();
    let grants = 0;
    const gcp = vi
      .spyOn(world.session, 'gcp')
      .mockImplementation(async (args) => {
        if (args[2] === 'add-iam-policy-binding' && ++grants < 3)
          throw new Error('propagation pending');
        return JSON.stringify({
          bindings: [
            {
              role: 'roles/storage.objectViewer',
              members: [
                `serviceAccount:${JOB_NATIVE_CREDENTIALS.gcp.clientEmail}`,
              ],
            },
          ],
        });
      });
    const deadline = Date.now() + 10_000;
    await reader.prepareInput(bucket, deadline);
    expect(grants).toBe(3);
    expect(pause.mock.calls).toEqual([
      [2_000, deadline],
      [2_000, deadline],
    ]);
    expect(gcp.mock.calls.at(-1)?.[0]).toEqual([
      'storage',
      'buckets',
      'get-iam-policy',
      `gs://${bucket}`,
      '--format=json',
    ]);
    gcp.mockRejectedValue(new Error('still denied'));
    await expect(reader.prepareInput(bucket, deadline)).rejects.toThrow(
      'three bounded attempts',
    );
    expect(pause).toHaveBeenCalledTimes(4);
  });

  test('captures Azure original container and actual shared-account location', async () => {
    const world = jobNativeSessionFixture(JOB_NATIVE_CREDENTIALS.azure);
    const reader = new JobBucketNativeReader(world.session, 'westus2');
    const get = vi
      .spyOn(world.session, 'get')
      .mockImplementation(async (url) => ({
        status: 200,
        body:
          url.pathname === azureAccount
            ? { id: azureAccount, location: 'eastus' }
            : container(),
      }));
    await expect(
      reader.observe(bucket, Date.now() + 5_000),
    ).resolves.toMatchObject({
      presence: 'present',
      identity: {
        scope: azureAccount.toLowerCase(),
        nativeId: `${containersPath}/${bucket}`.toLowerCase(),
        region: 'eastus',
      },
    });
    expect(get.mock.calls.map(([url]) => url.pathname)).toEqual([
      azureAccount,
      `${containersPath}/${bucket}`,
    ]);
  });

  test.each([false, true])(
    'retries an incomplete Azure read at most three times with two-second pauses (cleanup %s)',
    async (cleanup) => {
      const world = jobNativeSessionFixture(JOB_NATIVE_CREDENTIALS.azure);
      const reader = new JobBucketNativeReader(world.session, 'westus2');
      const pause = vi.spyOn(world.session, 'pause').mockResolvedValue();
      let incomplete = 2;
      const get = vi
        .spyOn(world.session, 'get')
        .mockImplementation(async (url) => {
          if (url.pathname !== azureAccount && incomplete-- > 0)
            throw new JobNativeReadIncomplete();
          return {
            status: 200,
            body:
              url.pathname === azureAccount
                ? { id: azureAccount, location: 'eastus' }
                : container(),
          };
        });
      const deadline = Date.now() + 10_000;
      await expect(
        reader.observe(bucket, deadline, cleanup),
      ).resolves.toMatchObject({ presence: 'present' });
      expect(get.mock.calls.map(([url]) => url.pathname)).toEqual([
        azureAccount,
        ...Array(3).fill(`${containersPath}/${bucket}`),
      ]);
      expect(pause.mock.calls).toEqual([
        [2_000, deadline, cleanup],
        [2_000, deadline, cleanup],
      ]);

      // The validated account readback is reused, so only the container is read.
      incomplete = 3;
      await expect(reader.observe(bucket, deadline, cleanup)).rejects.toThrow(
        JobNativeReadIncomplete,
      );
      expect(get).toHaveBeenCalledTimes(7);
      expect(pause).toHaveBeenCalledTimes(4);
    },
  );

  test('retries a throttled or failing storage-account readback within its deadline', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const world = jobNativeSessionFixture(JOB_NATIVE_CREDENTIALS.azure);
    const reader = new JobBucketNativeReader(world.session, 'westus2');
    const pause = vi
      .spyOn(world.session, 'pause')
      .mockImplementation(async (milliseconds) => {
        vi.setSystemTime(Date.now() + milliseconds);
      });
    const answers = [
      { status: 429, body: { error: { code: 'TooManyRequests' } } },
      { status: 503, body: { error: { code: 'ServiceUnavailable' } } },
    ];
    const get = vi
      .spyOn(world.session, 'get')
      .mockImplementation(async (url) =>
        url.pathname === azureAccount
          ? (answers.shift() ?? {
              status: 200,
              body: { id: azureAccount, location: 'eastus' },
            })
          : { status: 200, body: container() },
      );
    const deadline = Date.now() + 10_000;
    await expect(reader.observe(bucket, deadline, true)).resolves.toMatchObject(
      { presence: 'present' },
    );
    expect(get).toHaveBeenCalledTimes(4);
    expect(pause.mock.calls).toEqual([
      [2_000, deadline, true],
      [2_000, deadline, true],
    ]);

    // Throttling that outlasts the deadline names the last status and code.
    get.mockResolvedValue({
      status: 429,
      body: { error: { code: 'TooManyRequests' } },
    });
    await expect(
      new JobBucketNativeReader(world.session, 'westus2').observe(
        bucket,
        Date.now() + 5_000,
      ),
    ).rejects.toThrow(
      'no exact original storage-account readback (HTTP 429, TooManyRequests)',
    );
    expect(pause).toHaveBeenCalledTimes(4);
  });

  test('retries a failing container readback and names a final status', async () => {
    const world = jobNativeSessionFixture(JOB_NATIVE_CREDENTIALS.azure);
    vi.spyOn(world.session, 'pause').mockResolvedValue();
    let failures = 1;
    const get = vi
      .spyOn(world.session, 'get')
      .mockImplementation(async (url) =>
        url.pathname === azureAccount
          ? { status: 200, body: { id: azureAccount, location: 'eastus' } }
          : failures-- > 0
            ? { status: 503, body: { error: { code: 'ServiceUnavailable' } } }
            : { status: 200, body: container() },
      );
    const reader = new JobBucketNativeReader(world.session, 'westus2');
    await expect(
      reader.observe(bucket, Date.now() + 10_000),
    ).resolves.toMatchObject({ presence: 'present' });
    expect(get).toHaveBeenCalledTimes(3);
    failures = 1;
    get.mockResolvedValueOnce({
      status: 403,
      body: { error: { code: 'AuthorizationFailed' } },
    });
    await expect(reader.observe(bucket, Date.now() + 10_000)).rejects.toThrow(
      'malformed (HTTP 403, AuthorizationFailed)',
    );
  });

  test('waits out a throttled storage-account readback for its Retry-After, once per run', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const world = jobNativeSessionFixture(JOB_NATIVE_CREDENTIALS.azure);
    const reader = new JobBucketNativeReader(world.session, 'westus2');
    const pause = vi
      .spyOn(world.session, 'pause')
      .mockImplementation(async (milliseconds) => {
        vi.setSystemTime(Date.now() + milliseconds);
      });
    const answers = [
      {
        status: 429,
        body: { error: { code: 'TooManyRequests' } },
        retryAfterMs: 46_000,
      },
    ];
    const get = vi
      .spyOn(world.session, 'get')
      .mockImplementation(async (url) =>
        url.pathname === azureAccount
          ? (answers.shift() ?? {
              status: 200,
              body: { id: azureAccount, location: 'eastus' },
            })
          : { status: 200, body: container() },
      );
    const deadline = Date.now() + 120_000;
    await expect(reader.observe(bucket, deadline)).resolves.toMatchObject({
      presence: 'present',
    });
    expect(pause.mock.calls).toEqual([
      [2_000, deadline, false],
      [44_000, deadline, false],
    ]);

    await reader.observe(bucket, deadline);
    expect(
      get.mock.calls.filter(([url]) => url.pathname === azureAccount),
    ).toHaveLength(2);
  });

  test('re-lists an Azure inventory that still names a deleted container within its deadline', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const world = jobNativeSessionFixture(JOB_NATIVE_CREDENTIALS.azure);
    const reader = new JobBucketNativeReader(world.session, 'westus2');
    const pause = vi
      .spyOn(world.session, 'pause')
      .mockImplementation(async (milliseconds) => {
        vi.setSystemTime(Date.now() + milliseconds);
      });
    let inventories = [[container()], [container()], []];
    const get = vi
      .spyOn(world.session, 'get')
      .mockImplementation(async (url) =>
        url.pathname === azureAccount
          ? { status: 200, body: { id: azureAccount, location: 'eastus' } }
          : url.pathname === containersPath
            ? {
                status: 200,
                body: { value: inventories.shift() ?? [container()] },
              }
            : { status: 404, body: { error: { code: 'ContainerNotFound' } } },
      );
    const deadline = Date.now() + 10_000;
    await expect(reader.observe(bucket, deadline, true)).resolves.toMatchObject(
      { presence: 'absent' },
    );
    expect(get).toHaveBeenCalledTimes(5);
    expect(pause.mock.calls).toEqual([
      [2_000, deadline, true],
      [2_000, deadline, true],
    ]);

    // An inventory that still lists the container at the deadline contradicts it.
    await expect(reader.observe(bucket, Date.now() + 5_000)).rejects.toThrow(
      'Job Azure container absence contradicts its native inventory',
    );
    expect(pause).toHaveBeenCalledTimes(4);

    // A malformed row is never waited through.
    inventories = [[null as never]];
    await expect(reader.observe(bucket, Date.now() + 10_000)).rejects.toThrow(
      'inventory is malformed, repeated or foreign',
    );
    expect(pause).toHaveBeenCalledTimes(4);
  });

  // Run 37745156990: the product created the checkpoint container between the
  // probe's 404 GET and its corroborating inventory.
  test.each(['container', 'account'] as const)(
    'observes a just-created %s between its 404 GET and inventory as present',
    async (kind) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      onTestFinished(() => {
        vi.useRealTimers();
      });
      const world = jobNativeSessionFixture(JOB_NATIVE_CREDENTIALS.azure);
      const reader = new JobBucketNativeReader(world.session, 'westus2');
      const pause = vi
        .spyOn(world.session, 'pause')
        .mockImplementation(async (milliseconds) => {
          vi.setSystemTime(Date.now() + milliseconds);
        });
      const accountsPath = `/subscriptions/${JOB_NATIVE_CREDENTIALS.azure.subscriptionId}/providers/Microsoft.Storage/storageAccounts`;
      const account = {
        id: azureAccount,
        name: 'anycloud11111111',
        type: 'Microsoft.Storage/storageAccounts',
        location: 'eastus',
      };
      let created = false;
      const get = vi
        .spyOn(world.session, 'get')
        .mockImplementation(async (url) => {
          const notFound = {
            status: 404,
            body: {
              error: {
                code:
                  kind === 'account' ? 'ResourceNotFound' : 'ContainerNotFound',
              },
            },
          };
          if (url.pathname === azureAccount)
            return kind === 'account' && !created
              ? notFound
              : { status: 200, body: account };
          if (
            url.pathname ===
            (kind === 'account' ? accountsPath : containersPath)
          ) {
            // The creation lands after the GET's 404 and before this listing.
            created = true;
            return {
              status: 200,
              body: { value: [kind === 'account' ? account : container()] },
            };
          }
          return kind === 'container' && !created
            ? notFound
            : { status: 200, body: container() };
        });
      const deadline = Date.now() + 300_000;
      await expect(reader.observe(bucket, deadline)).resolves.toMatchObject({
        presence: 'present',
      });
      // One listing and one two-second pause, not a re-list to the deadline.
      expect(
        get.mock.calls.filter(([url]) =>
          [accountsPath, containersPath].includes(url.pathname),
        ),
      ).toHaveLength(1);
      expect(pause.mock.calls).toEqual([[2_000, deadline, false]]);
    },
  );

  test('fails a storage-account readback with a 404 without an absence code at once', async () => {
    const world = jobNativeSessionFixture(JOB_NATIVE_CREDENTIALS.azure);
    const reader = new JobBucketNativeReader(world.session, 'westus2');
    const pause = vi.spyOn(world.session, 'pause').mockResolvedValue();
    const get = vi.spyOn(world.session, 'get').mockResolvedValue({
      status: 404,
      body: { error: { code: 'SubscriptionNotFound' } },
    });
    await expect(reader.observe(bucket, Date.now() + 10_000)).rejects.toThrow(
      'no exact original storage-account readback (HTTP 404, SubscriptionNotFound)',
    );
    expect(get).toHaveBeenCalledTimes(1);
    expect(pause).not.toHaveBeenCalled();
  });

  test('does not retry an Azure read that failed for another reason', async () => {
    const world = jobNativeSessionFixture(JOB_NATIVE_CREDENTIALS.azure);
    const reader = new JobBucketNativeReader(world.session, 'westus2');
    const pause = vi.spyOn(world.session, 'pause').mockResolvedValue();
    const get = vi
      .spyOn(world.session, 'get')
      .mockRejectedValue(
        new Error('Job native Azure token changed tenant or subscription'),
      );
    await expect(reader.observe(bucket, Date.now() + 5_000)).rejects.toThrow(
      'changed tenant',
    );
    expect(get).toHaveBeenCalledTimes(1);
    expect(pause).not.toHaveBeenCalled();
  });

  test.each([
    'complete',
    'later-denied',
    'foreign-account',
    'foreign-page',
    'filtered-page',
    'repeated-page',
    'malformed-tail',
    'still-present',
  ] as const)(
    'requires an authorized complete Azure inventory after a 404: %s',
    async (kind) => {
      const world = jobNativeSessionFixture(JOB_NATIVE_CREDENTIALS.azure);
      const reader = new JobBucketNativeReader(world.session, 'westus2');
      const firstUrl = `https://management.azure.com${containersPath}?api-version=2025-06-01`;
      const secondUrl = `${firstUrl}&$skipToken=page2`;
      const get = vi
        .spyOn(world.session, 'get')
        .mockImplementation(async (url) => {
          if (url.pathname === azureAccount)
            return {
              status: 200,
              body: {
                id:
                  kind === 'foreign-account'
                    ? `${azureAccount}-foreign`
                    : azureAccount,
                location: 'eastus',
              },
            };
          if (url.pathname === `${containersPath}/${bucket}`)
            return {
              status: 404,
              body: { error: { code: 'ResourceNotFound' } },
            };
          if (url.href === firstUrl)
            return {
              status: 200,
              body: {
                value: [container('unrelated-container')],
                nextLink:
                  kind === 'foreign-page'
                    ? secondUrl.replace(
                        'management.azure.com',
                        'foreign.invalid',
                      )
                    : kind === 'filtered-page'
                      ? `${secondUrl}&$filter=name%20eq%20unrelated`
                      : kind === 'repeated-page'
                        ? firstUrl
                        : secondUrl,
              },
            };
          return {
            status: kind === 'later-denied' ? 403 : 200,
            body: {
              value:
                kind === 'malformed-tail'
                  ? [null]
                  : kind === 'still-present'
                    ? [container()]
                    : [],
            },
          };
        });
      const operation = reader.observe(bucket, Date.now() + 5_000, true);
      if (kind === 'complete') {
        await expect(operation).resolves.toEqual({
          presence: 'absent',
          name: bucket,
          scope: azureAccount.toLowerCase(),
        });
        expect(get).toHaveBeenCalledTimes(4);
      } else await expect(operation).rejects.toThrow();
      for (const [, , cleanup] of get.mock.calls) expect(cleanup).toBe(true);
    },
  );
});

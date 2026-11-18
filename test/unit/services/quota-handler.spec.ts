import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const {
  decryptCredentialMock,
  getCredentialMock,
  getNamedCredentialMock,
  listNamedCredentialsMock,
  getQuotaRequestRegionsMock,
  getRegionsMock,
  getEnabledRegionsMock,
  listRecentRequestsMock,
  requestAwsQuotaMock,
  awsQuotaStatusMock,
  azureQuotaStatusMock,
} = vi.hoisted(() => ({
  decryptCredentialMock: vi.fn(),
  getCredentialMock: vi.fn(),
  getNamedCredentialMock: vi.fn(),
  listNamedCredentialsMock: vi.fn(),
  getQuotaRequestRegionsMock: vi.fn(),
  getRegionsMock: vi.fn(),
  getEnabledRegionsMock: vi.fn(),
  listRecentRequestsMock: vi.fn(),
  requestAwsQuotaMock: vi.fn(),
  awsQuotaStatusMock: vi.fn(),
  azureQuotaStatusMock: vi.fn(),
}));

vi.mock('../../../src/shared/cloud-config.js', () => ({
  cloudsSupporting: vi.fn(() => ['AWS', 'Azure']),
  getQuotaRequestRegions: getQuotaRequestRegionsMock,
  getRegions: getRegionsMock,
  getRegionsForVMType: vi.fn(() => []),
  getVCPUsForVMType: vi.fn(() => 1),
  resolveVMType: vi.fn((vmType: string) => vmType),
  supportsQuota: vi.fn(() => true),
}));

vi.mock('../../../src/api/services/persistence.js', () => ({
  getCredentialSecretStore: vi.fn(() => ({
    getCredential: getCredentialMock,
    getNamedCredential: getNamedCredentialMock,
    listNamedCredentials: listNamedCredentialsMock,
  })),
}));

vi.mock('../../../src/api/services/cloud-config.js', () => ({
  decryptCredential: decryptCredentialMock,
  resolveCredentialByName: vi.fn(async (name: string) => {
    const row = await getNamedCredentialMock(name);
    if (!row) return null;
    const creds = await decryptCredentialMock(row.encryptedData);
    return { id: row.id, cloudProvider: row.cloudProvider, creds };
  }),
}));

vi.mock('../../../src/shared/catalog/index.js', () => ({
  ensureCatalogBootstrapped: vi.fn(async () => {}),
}));

vi.mock('../../../src/api/services/quota/aws.js', () => ({
  AwsQuotaProvider: vi.fn().mockImplementation(() => ({
    getEnabledRegions: getEnabledRegionsMock,
    listRecentRequests: listRecentRequestsMock,
  })),
  requestAwsQuota: requestAwsQuotaMock,
  awsQuotaStatus: awsQuotaStatusMock,
}));

vi.mock('../../../src/api/services/quota/azure.js', () => ({
  AzureQuotaProvider: vi.fn(),
  azureQuotaStatus: azureQuotaStatusMock,
  azurePortalSupportUrl: vi.fn((ticketId: string) => `azure:${ticketId}`),
  parseQuotaTicketDescription: vi.fn(() => null),
}));

vi.mock('../../../src/api/services/logger.js', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  clearProviderQuotaStatusCacheForTests,
  PROVIDER_QUOTA_STATUS_INCOMPLETE_TTL_MS,
  handleCanceledQuotaStatus,
  handleQuotaStatus,
} from '../../../src/api/services/quota/handler.js';
import { getDB, resetDB } from '../../../src/api/services/repositories/db.js';
import { listQuotaStatusOperationTargets } from '../../../src/api/services/repositories/quota-operations.js';
import { type QuotaRequestEntry } from '../../../src/shared/api-contract/quota-schemas.js';
import { CloudType } from '../../../src/shared/cloud.js';
import { QuotaRequestStatus } from '../../../src/shared/quota.js';

const creds = { accessKeyId: 'k', secretAccessKey: 's' };
const identity = (username: string, id = '1') => ({ id, username });

describe('handleQuotaStatus — AWS regions', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    clearProviderQuotaStatusCacheForTests();
    tmpDir = mkdtempSync(join(tmpdir(), 'anycloud-quota-handler-status-'));
    vi.stubEnv('SQLITE_PATH', join(tmpDir, 'test.db'));
    resetDB();
    await getDB().init?.();
    getNamedCredentialMock.mockResolvedValue({
      cloudProvider: CloudType.AWS,
      encryptedData: 'encrypted',
    });
    decryptCredentialMock.mockResolvedValue(creds);
    getRegionsMock.mockReturnValue(['us-east-1', 'ap-south-1', 'eu-west-1']);
    getEnabledRegionsMock.mockResolvedValue(
      new Set(['eu-west-1', 'us-east-1', 'unknown-enabled-region']),
    );
    awsQuotaStatusMock.mockResolvedValue([
      {
        cloud: CloudType.AWS,
        region: 'us-east-1',
        resourceName: 'Running On-Demand G and VT instances',
        status: 'PENDING',
        requestedLimit: 100,
        requestId: 'req-1',
        requestedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
  });

  afterEach(() => {
    resetDB();
    vi.unstubAllEnvs();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('delegates all-region AWS status to awsQuotaStatus', async () => {
    const entries = await handleQuotaStatus(
      identity('user-1'),
      CloudType.AWS,
      'awstest',
      undefined,
    );

    expect(awsQuotaStatusMock).toHaveBeenCalledWith(creds, undefined);
    expect(entries).toEqual([
      {
        cloud: CloudType.AWS,
        region: 'us-east-1',
        resourceName: 'Running On-Demand G and VT instances',
        status: 'PENDING',
        requestedLimit: 100,
        requestId: 'req-1',
        requestedAt: '2026-01-01T00:00:00.000Z',
        resourceKey: 'aws:l-db2e81ba',
      },
    ]);
  });

  it('honors an explicit AWS status region without checking account-enabled regions', async () => {
    await handleQuotaStatus(
      identity('user-1'),
      CloudType.AWS,
      'awstest',
      'ap-south-1',
    );

    expect(awsQuotaStatusMock).toHaveBeenCalledWith(creds, 'ap-south-1');
  });

  it('reuses cached provider status entries for identical reads', async () => {
    const first = await handleQuotaStatus(
      identity('user-1'),
      CloudType.AWS,
      'awstest',
      undefined,
    );
    awsQuotaStatusMock.mockResolvedValue([
      {
        cloud: CloudType.AWS,
        region: 'us-west-2',
        resourceName: 'Running On-Demand Standard instances',
        status: 'PENDING',
        requestedLimit: 64,
      },
    ]);

    const second = await handleQuotaStatus(
      identity('user-1'),
      CloudType.AWS,
      'awstest',
      undefined,
    );

    expect(awsQuotaStatusMock).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it('keeps a read with an unavailable row 30 s and a complete one 5 min', async () => {
    vi.useFakeTimers();
    try {
      const unavailableRow = {
        kind: 'unavailable' as const,
        cloud: CloudType.AWS,
        region: 'us-east-2',
        resourceName: 'All Standard Spot Instance Requests',
        status: 'UNAVAILABLE',
        message: 'The security token included in the request is invalid',
      };
      awsQuotaStatusMock.mockResolvedValueOnce([unavailableRow]);
      const read = () =>
        handleQuotaStatus(
          identity('user-1'),
          CloudType.AWS,
          'awstest',
          'us-east-2',
        );

      expect(await read()).toEqual([unavailableRow]);
      await vi.advanceTimersByTimeAsync(
        PROVIDER_QUOTA_STATUS_INCOMPLETE_TTL_MS - 1_000,
      );
      await read();
      expect(awsQuotaStatusMock).toHaveBeenCalledTimes(1);

      // Past the short TTL the retry reads again, and the complete read
      // that comes back is kept for the full 5 minutes.
      await vi.advanceTimersByTimeAsync(2_000);
      await read();
      expect(awsQuotaStatusMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      await read();
      expect(awsQuotaStatusMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(61_000);
      await read();
      expect(awsQuotaStatusMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not cache failed Azure current reads and caches the next healthy result', async () => {
    getNamedCredentialMock.mockResolvedValue({
      cloudProvider: CloudType.Azure,
      encryptedData: 'encrypted',
    });
    const failure = new Error(
      'Azure quota status unavailable for eastus: Azure current quota eastus timed out after 1 minute',
    );
    const healthy = [
      {
        cloud: CloudType.Azure,
        region: 'eastus',
        kind: 'current' as const,
        resourceName: 'Total Regional vCPUs',
        resourceKey: 'azure:cores',
        status: 'CURRENT',
        currentLimit: 65,
      },
    ];
    azureQuotaStatusMock
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(healthy);
    const read = () =>
      handleQuotaStatus(
        identity('user-1'),
        CloudType.Azure,
        'azuretest',
        'eastus',
      );
    await expect(read()).rejects.toBe(failure);
    await expect(read()).resolves.toEqual(healthy);
    await expect(read()).resolves.toEqual(healthy);
    expect(azureQuotaStatusMock).toHaveBeenCalledTimes(2);
  });

  it('can fail open for quick provider status reads', async () => {
    awsQuotaStatusMock.mockRejectedValueOnce(new Error('provider timeout'));

    await expect(
      handleQuotaStatus(
        identity('user-1'),
        CloudType.AWS,
        'awstest',
        undefined,
        {
          providerWaitMs: 1,
          failOpenProviderStatus: true,
        },
      ),
    ).resolves.toEqual([]);
  });
});

describe('quota operation handler', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    clearProviderQuotaStatusCacheForTests();
    tmpDir = mkdtempSync(join(tmpdir(), 'anycloud-quota-handler-'));
    vi.stubEnv('SQLITE_PATH', join(tmpDir, 'test.db'));
    resetDB();
    await getDB().init?.();
    getCredentialMock.mockResolvedValue('encrypted');
    getNamedCredentialMock.mockResolvedValue({
      id: 'cred-named',
      cloudProvider: CloudType.AWS,
      encryptedData: 'encrypted',
    });
    listNamedCredentialsMock.mockResolvedValue([
      {
        id: 'cred-singleton',
        name: 'aws-singleton',
        cloudProvider: CloudType.AWS,
        encryptedData: 'encrypted',
      },
    ]);
    decryptCredentialMock.mockResolvedValue(creds);
    getQuotaRequestRegionsMock.mockReturnValue(['us-east-1', 'us-west-2']);
  });

  afterEach(() => {
    resetDB();
    vi.unstubAllEnvs();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  let nextOperationId = 0;
  async function createLocalOperation() {
    const id = `quota-history-${++nextOperationId}`;
    const targetId = `${id}-target`;
    const createdAt = Date.now();
    await getDB().query(
      `INSERT INTO quota_operations
       (id, user_id, owner_user_id, cloud_provider, credential_name, dry_run,
        status, total_targets, created_at, updated_at)
       VALUES (?, 'user-1', '1', 'AWS', 'awstest', 0, 'queued', 1, ?, ?)`,
      [id, createdAt, createdAt],
    );
    await getDB().query(
      `INSERT INTO quota_operation_targets
       (id, operation_id, target_index, vm_type, region, spot, status, updated_at)
       VALUES (?, ?, 0, 'g6e.48xlarge', 'us-east-1', 0, 'pending', ?)`,
      [targetId, id, createdAt],
    );
    return { id, targetId };
  }

  it('shows canceled upgrade targets alongside provider history and current limits', async () => {
    const operation = await createLocalOperation();
    await getDB().query(
      `UPDATE quota_operation_targets
       SET status = 'completed', error = 'Canceled: quota submissions retired'
       WHERE operation_id = ?`,
      [operation.id],
    );
    await getDB().query(
      `UPDATE quota_operations SET status = 'completed' WHERE id = ?`,
      [operation.id],
    );
    awsQuotaStatusMock.mockResolvedValue([
      {
        kind: 'request',
        cloud: CloudType.AWS,
        region: 'us-east-1',
        resourceName: 'Running On-Demand G and VT instances',
        status: 'PENDING',
        requestedLimit: 192,
      },
      {
        kind: 'current',
        cloud: CloudType.AWS,
        region: 'us-east-1',
        resourceName: 'Running On-Demand G and VT instances',
        status: 'CURRENT',
        currentLimit: 0,
      },
    ]);

    const entries = await handleQuotaStatus(
      identity('user-1'),
      CloudType.AWS,
      'awstest',
      'us-east-1',
    );
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'PENDING' }),
        expect.objectContaining({ status: 'CURRENT' }),
        expect.objectContaining({
          status: 'CANCELED',
          source: 'local_operation',
          operationId: operation.id,
          vmType: 'g6e.48xlarge',
          region: 'us-east-1',
          message: expect.stringContaining('Canceled:'),
        }),
      ]),
    );
  });

  it('reads owned canceled targets after the credential is deleted', async () => {
    const operation = await createLocalOperation();
    await getDB().query(
      `UPDATE quota_operation_targets
       SET status = 'completed', error = 'Canceled: quota submissions retired'
       WHERE id = ?`,
      [operation.targetId],
    );
    getNamedCredentialMock.mockResolvedValue(null);
    awsQuotaStatusMock.mockRejectedValue(new Error('provider unavailable'));

    const entries = await handleCanceledQuotaStatus();
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: 'CANCELED',
          operationId: operation.id,
          operationTargetId: operation.targetId,
        }),
      ]),
    );
    expect(getNamedCredentialMock).not.toHaveBeenCalled();
    expect(awsQuotaStatusMock).not.toHaveBeenCalled();
  });

  it('filters status targets by credential, region, and cancellation', async () => {
    const matching = await createLocalOperation();
    const otherCredential = await createLocalOperation();
    const otherRegion = await createLocalOperation();
    const canceled = await createLocalOperation();
    const failed = await createLocalOperation();
    const db = getDB();
    await db.query(
      `UPDATE quota_operations SET credential_name = 'other' WHERE id = ?`,
      [otherCredential.id],
    );
    await db.query(
      `UPDATE quota_operation_targets SET region = 'us-west-2' WHERE id = ?`,
      [otherRegion.targetId],
    );
    for (const [target, error] of [
      [canceled.targetId, 'Canceled: quota submissions retired'],
      [failed.targetId, 'Quota request failed'],
    ]) {
      await db.query(
        `UPDATE quota_operation_targets
         SET status = 'completed', error = ? WHERE id = ?`,
        [error, target],
      );
    }
    const scope = { kind: 'api' } as const;
    const listed = async (
      input: Parameters<typeof listQuotaStatusOperationTargets>[0],
    ) =>
      (await listQuotaStatusOperationTargets(input)).map(
        (row) => row.operation_id,
      );

    expect(await listed({ scope, cloud: CloudType.AWS })).toEqual([
      matching.id,
      otherCredential.id,
      otherRegion.id,
      canceled.id,
    ]);
    expect(
      await listed({
        scope,
        cloud: CloudType.AWS,
        credentialName: 'awstest',
        region: 'us-east-1',
      }),
    ).toEqual([matching.id, canceled.id]);
    expect(await listed({ scope, canceledOnly: true })).toEqual([canceled.id]);
  });

  async function completeSubmittedLocalOperation(
    overrides: Partial<QuotaRequestEntry> = {},
  ) {
    const submittedEntry: QuotaRequestEntry = {
      cloud: CloudType.AWS,
      region: 'us-east-1',
      resourceName: 'Running On-Demand G and VT instances',
      previousLimit: 0,
      requestedLimit: 192,
      grantedLimit: null,
      status: QuotaRequestStatus.Submitted,
      providerRequestId: 'provider-request-local',
      providerCaseId: 'case-local',
      url: 'https://example.com/case-local',
      ...overrides,
    };
    const operation = await createLocalOperation();
    await getDB().query(
      `UPDATE quota_operation_targets
       SET status = 'completed', entries_json = ? WHERE id = ?`,
      [JSON.stringify([submittedEntry]), operation.targetId],
    );
    await getDB().query(
      `UPDATE quota_operations SET status = 'completed' WHERE id = ?`,
      [operation.id],
    );
    return { operation, submittedEntry };
  }

  it('adds active local quota operations to status and preserves current limits', async () => {
    awsQuotaStatusMock.mockResolvedValue([
      {
        kind: 'current',
        cloud: CloudType.AWS,
        region: 'us-east-1',
        resourceName: 'Running On-Demand G and VT instances',
        status: 'CURRENT',
        currentLimit: 0,
      },
      {
        kind: 'current',
        cloud: CloudType.AWS,
        region: 'us-east-1',
        resourceName: 'Running On-Demand Standard instances',
        status: 'CURRENT',
        currentLimit: 64,
      },
    ]);

    const operation = await createLocalOperation();

    const entries = await handleQuotaStatus(
      identity('user-1'),
      CloudType.AWS,
      'awstest',
      'us-east-1',
    );

    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'request',
          source: 'local_operation',
          cloud: CloudType.AWS,
          region: 'us-east-1',
          resourceName: 'Running On-Demand G and VT instances',
          resourceKey: 'aws:l-db2e81ba',
          status: 'QUEUED',
          operationId: operation.id,
          vmType: 'g6e.48xlarge',
          spot: false,
        }),
        expect.objectContaining({
          kind: 'current',
          resourceName: 'Running On-Demand G and VT instances',
          currentLimit: 0,
          resourceKey: 'aws:l-db2e81ba',
        }),
        expect.objectContaining({
          kind: 'current',
          resourceName: 'Running On-Demand Standard instances',
          currentLimit: 64,
          resourceKey: 'aws:l-1216c47a',
        }),
      ]),
    );
  });

  it('lets provider request rows supersede matching local operation rows while preserving current limits', async () => {
    awsQuotaStatusMock.mockResolvedValue([
      {
        kind: 'request',
        cloud: CloudType.AWS,
        region: 'us-east-1',
        resourceName: 'Running On-Demand G and VT instances',
        status: 'PENDING',
        requestedLimit: 192,
        requestId: 'provider-req',
        requestedAt: '2026-06-20T16:20:30.000Z',
      },
      {
        kind: 'current',
        cloud: CloudType.AWS,
        region: 'us-east-1',
        resourceName: 'Running On-Demand G and VT instances',
        status: 'CURRENT',
        currentLimit: 0,
      },
    ]);

    await createLocalOperation();

    const entries = await handleQuotaStatus(
      identity('user-1'),
      CloudType.AWS,
      'awstest',
      'us-east-1',
    );

    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'request',
          requestId: 'provider-req',
          requestedLimit: 192,
          resourceKey: 'aws:l-db2e81ba',
        }),
        expect.objectContaining({
          kind: 'current',
          currentLimit: 0,
          resourceKey: 'aws:l-db2e81ba',
        }),
      ]),
    );
    expect(entries).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'local_operation' }),
      ]),
    );
  });

  it('keeps local operation rows when matching provider history is terminal', async () => {
    awsQuotaStatusMock.mockResolvedValue([
      {
        kind: 'request',
        cloud: CloudType.AWS,
        region: 'us-east-1',
        resourceName: 'Running On-Demand G and VT instances',
        status: 'APPROVED',
        requestedLimit: 192,
        grantedLimit: 192,
        requestId: 'provider-approved',
        requestedAt: '2026-06-01T16:20:30.000Z',
      },
      {
        kind: 'current',
        cloud: CloudType.AWS,
        region: 'us-east-1',
        resourceName: 'Running On-Demand G and VT instances',
        status: 'CURRENT',
        currentLimit: 192,
      },
    ]);

    const operation = await createLocalOperation();

    const entries = await handleQuotaStatus(
      identity('user-1'),
      CloudType.AWS,
      'awstest',
      'us-east-1',
    );

    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'request',
          requestId: 'provider-approved',
          status: 'APPROVED',
          resourceKey: 'aws:l-db2e81ba',
        }),
        expect.objectContaining({
          kind: 'request',
          source: 'local_operation',
          operationId: operation.id,
          status: 'QUEUED',
          resourceKey: 'aws:l-db2e81ba',
        }),
        expect.objectContaining({
          kind: 'current',
          currentLimit: 192,
          resourceKey: 'aws:l-db2e81ba',
        }),
      ]),
    );
  });

  it('adds completed submitted local quota operations to status until provider history appears', async () => {
    awsQuotaStatusMock.mockResolvedValue([
      {
        kind: 'current',
        cloud: CloudType.AWS,
        region: 'us-east-1',
        resourceName: 'Running On-Demand G and VT instances',
        status: 'CURRENT',
        currentLimit: 0,
      },
    ]);
    const { operation } = await completeSubmittedLocalOperation();

    const entries = await handleQuotaStatus(
      identity('user-1'),
      CloudType.AWS,
      'awstest',
      'us-east-1',
    );

    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'request',
          source: 'local_operation',
          cloud: CloudType.AWS,
          region: 'us-east-1',
          resourceName: 'Running On-Demand G and VT instances',
          resourceKey: 'aws:l-db2e81ba',
          status: 'submitted',
          requestedLimit: 192,
          providerRequestId: 'provider-request-local',
          providerCaseId: 'case-local',
          operationId: operation.id,
          vmType: 'g6e.48xlarge',
          spot: false,
        }),
        expect.objectContaining({
          kind: 'current',
          currentLimit: 0,
          resourceKey: 'aws:l-db2e81ba',
        }),
      ]),
    );
  });

  it('hides completed local rows when matching active provider history appears', async () => {
    await completeSubmittedLocalOperation();
    awsQuotaStatusMock.mockResolvedValue([
      {
        kind: 'request',
        cloud: CloudType.AWS,
        region: 'us-east-1',
        resourceName: 'Running On-Demand G and VT instances',
        status: 'PENDING',
        requestedLimit: 192,
        requestId: 'provider-request-local',
        requestedAt: new Date().toISOString(),
      },
      {
        kind: 'current',
        cloud: CloudType.AWS,
        region: 'us-east-1',
        resourceName: 'Running On-Demand G and VT instances',
        status: 'CURRENT',
        currentLimit: 0,
      },
    ]);

    const entries = await handleQuotaStatus(
      identity('user-1'),
      CloudType.AWS,
      'awstest',
      'us-east-1',
    );

    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'request',
          requestId: 'provider-request-local',
          status: 'PENDING',
          resourceKey: 'aws:l-db2e81ba',
        }),
        expect.objectContaining({
          kind: 'current',
          currentLimit: 0,
          resourceKey: 'aws:l-db2e81ba',
        }),
      ]),
    );
    expect(entries).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'local_operation' }),
      ]),
    );
  });

  it('hides completed local rows when matching terminal provider history appears', async () => {
    await completeSubmittedLocalOperation();
    awsQuotaStatusMock.mockResolvedValue([
      {
        kind: 'request',
        cloud: CloudType.AWS,
        region: 'us-east-1',
        resourceName: 'Running On-Demand G and VT instances',
        status: 'APPROVED',
        requestedLimit: 192,
        grantedLimit: 192,
        providerRequestId: 'provider-request-local',
        requestedAt: new Date().toISOString(),
      },
      {
        kind: 'current',
        cloud: CloudType.AWS,
        region: 'us-east-1',
        resourceName: 'Running On-Demand G and VT instances',
        status: 'CURRENT',
        currentLimit: 192,
      },
    ]);

    const entries = await handleQuotaStatus(
      identity('user-1'),
      CloudType.AWS,
      'awstest',
      'us-east-1',
    );

    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'request',
          providerRequestId: 'provider-request-local',
          status: 'APPROVED',
          resourceKey: 'aws:l-db2e81ba',
        }),
        expect.objectContaining({
          kind: 'current',
          currentLimit: 192,
          resourceKey: 'aws:l-db2e81ba',
        }),
      ]),
    );
    expect(entries).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'local_operation' }),
      ]),
    );
  });

  it('hides completed local rows when same-resource provider history is newer without matching ids', async () => {
    await completeSubmittedLocalOperation({
      providerRequestId: undefined,
      providerCaseId: undefined,
      requestId: undefined,
      url: undefined,
    });
    awsQuotaStatusMock.mockResolvedValue([
      {
        kind: 'request',
        cloud: CloudType.AWS,
        region: 'us-east-1',
        resourceName: 'Running On-Demand G and VT instances',
        status: 'APPROVED',
        requestedLimit: 192,
        grantedLimit: 192,
        requestedAt: '2999-01-01T00:00:00.000Z',
      },
      {
        kind: 'current',
        cloud: CloudType.AWS,
        region: 'us-east-1',
        resourceName: 'Running On-Demand G and VT instances',
        status: 'CURRENT',
        currentLimit: 192,
      },
    ]);

    const entries = await handleQuotaStatus(
      identity('user-1'),
      CloudType.AWS,
      'awstest',
      'us-east-1',
    );

    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'request',
          status: 'APPROVED',
          requestedAt: '2999-01-01T00:00:00.000Z',
          resourceKey: 'aws:l-db2e81ba',
        }),
        expect.objectContaining({
          kind: 'current',
          currentLimit: 192,
          resourceKey: 'aws:l-db2e81ba',
        }),
      ]),
    );
    expect(entries).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'local_operation' }),
      ]),
    );
  });

  it('keeps completed local rows when same-resource terminal provider history is older', async () => {
    const { operation } = await completeSubmittedLocalOperation({
      providerRequestId: 'provider-request-new',
      providerCaseId: 'case-new',
    });
    awsQuotaStatusMock.mockResolvedValue([
      {
        kind: 'request',
        cloud: CloudType.AWS,
        region: 'us-east-1',
        resourceName: 'Running On-Demand G and VT instances',
        status: 'APPROVED',
        requestedLimit: 96,
        grantedLimit: 96,
        providerRequestId: 'provider-request-old',
        requestedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        kind: 'current',
        cloud: CloudType.AWS,
        region: 'us-east-1',
        resourceName: 'Running On-Demand G and VT instances',
        status: 'CURRENT',
        currentLimit: 96,
      },
    ]);

    const entries = await handleQuotaStatus(
      identity('user-1'),
      CloudType.AWS,
      'awstest',
      'us-east-1',
    );

    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'request',
          providerRequestId: 'provider-request-old',
          status: 'APPROVED',
          resourceKey: 'aws:l-db2e81ba',
        }),
        expect.objectContaining({
          kind: 'request',
          source: 'local_operation',
          operationId: operation.id,
          providerRequestId: 'provider-request-new',
          status: 'submitted',
          resourceKey: 'aws:l-db2e81ba',
        }),
        expect.objectContaining({
          kind: 'current',
          currentLimit: 96,
          resourceKey: 'aws:l-db2e81ba',
        }),
      ]),
    );
  });
});

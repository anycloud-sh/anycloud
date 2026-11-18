import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  publishServeEndpoint,
  serveUrl,
} from '../../../src/api/services/serve';
import { waitForDNSPublication } from '../../../src/api/services/dns-publication.js';
import { resetTestStore } from '../utils';
import { CloudType } from '../../../src/shared/cloud.js';
import { upsertDNSRecord } from '../../../src/shared/dns-worker';
import { getWorkloadQueryStore as queries } from '../../../src/api/services/persistence.js';
import { createWorkload } from '../../../src/api/services/repositories/workload-creation.js';
import { getDB } from '../../../src/api/services/repositories/db.js';
import { provisionTestVm } from '../../helpers/workload-store.js';

vi.mock('../../../src/api/services/dns-publication.js', () => ({
  waitForDNSPublication: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/shared/dns-worker', () => ({
  upsertDNSRecord: vi.fn(),
}));

vi.mock('../../../src/api/services/logger', () => ({
  log: {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('../../../src/api/config', () => ({
  default: { cipherKey: 'a'.repeat(64) },
  getApiBackupConfig: () => undefined,
}));

describe('serve endpoint publishing', () => {
  beforeEach(async () => {
    await resetTestStore();
    vi.clearAllMocks();
    vi.mocked(waitForDNSPublication).mockResolvedValue(undefined);
    vi.mocked(upsertDNSRecord).mockResolvedValue('dns-record-1');
  });

  async function createServiceWorkload(id: string) {
    await createWorkload(getDB(), {
      id,
      userId: 'test-user',
      workloadType: 'service',
      image: 'nginx:alpine',
      requestedComputeProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 't3.medium',
      dockerCommand: 'docker run nginx:alpine',
      sshPrivateKey: 'test-ssh-private-key',
      credentialId: 'test-credential-id',
    });
  }

  it('formats stable serve URLs', () => {
    expect(serveUrl('api-1')).toBe('https://api-1.anycloud.sh');
  });

  it('publishes DNS for the single live VM and stores the record id', async () => {
    const id = 'service-publish';
    await createServiceWorkload(id);
    await provisionTestVm(
      id,
      { ip: '1.2.3.4', cloudId: 'i-service' },
      { region: 'us-east-1', credentialId: 'test-credential-id' },
    );

    await expect(publishServeEndpoint(id, 'gh-token')).resolves.toBe(
      'https://service-publish.anycloud.sh',
    );

    expect(upsertDNSRecord).toHaveBeenCalledWith(id, '1.2.3.4', 'gh-token', {
      recordId: null,
    });

    const stored = await queries().getWorkload(id);
    expect(stored?.dnsRecordId).toBe('dns-record-1');

    // A republish (upgrade) presents the held id so the Worker updates it
    // in place.
    await publishServeEndpoint(id, 'gh-token');
    expect(upsertDNSRecord).toHaveBeenLastCalledWith(
      id,
      '1.2.3.4',
      'gh-token',
      { recordId: 'dns-record-1' },
    );
  });

  it('keeps ownership durable while publication waits and after a timeout', async () => {
    const id = 'service-propagation';
    await createServiceWorkload(id);
    await provisionTestVm(id, { ip: '1.2.3.4', cloudId: 'i-service' });
    const failure = new Error('authority still returns NXDOMAIN');
    vi.mocked(waitForDNSPublication).mockImplementationOnce(async () => {
      expect((await queries().getWorkload(id))?.dnsRecordId).toBe(
        'dns-record-1',
      );
      throw failure;
    });
    await expect(publishServeEndpoint(id, 'gh-token')).rejects.toBe(failure);
    expect((await queries().getWorkload(id))?.dnsRecordId).toBe('dns-record-1');
    expect(waitForDNSPublication).toHaveBeenCalledWith(`${id}.anycloud.sh`);
    await publishServeEndpoint(id, 'gh-token');
    expect(upsertDNSRecord).toHaveBeenLastCalledWith(
      id,
      '1.2.3.4',
      'gh-token',
      {
        recordId: 'dns-record-1',
      },
    );
  });

  it('rejects publishing when there is no live VM', async () => {
    const id = 'service-no-vm';
    await createServiceWorkload(id);

    await expect(publishServeEndpoint(id, null)).rejects.toThrow(
      'has no live VM',
    );
    expect(upsertDNSRecord).not.toHaveBeenCalled();
  });

  it('rejects publishing more than one live VM', async () => {
    const id = 'service-multi-vm';
    await createServiceWorkload(id);
    await provisionTestVm(id, {
      ip: '1.2.3.4',
      cloudId: 'i-service-1',
    });
    await provisionTestVm(id, {
      ip: '5.6.7.8',
      cloudId: 'i-service-2',
    });

    await expect(publishServeEndpoint(id, null)).rejects.toThrow(
      'v0 serve expects 1',
    );
    expect(upsertDNSRecord).not.toHaveBeenCalled();
  });

  it('does not store a DNS record id when publication fails', async () => {
    const id = 'service-publish-failure';
    await createServiceWorkload(id);
    await provisionTestVm(
      id,
      { ip: '1.2.3.4', cloudId: 'i-service' },
      { region: 'us-east-1', credentialId: 'test-credential-id' },
    );

    vi.mocked(upsertDNSRecord).mockRejectedValueOnce(
      new Error('cloudflare 502'),
    );

    await expect(publishServeEndpoint(id, 'gh-token')).rejects.toThrow(
      'cloudflare 502',
    );

    const stored = await queries().getWorkload(id);
    expect(stored?.dnsRecordId).toBeNull();
  });
});

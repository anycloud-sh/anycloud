import { describe, it, expect, vi, beforeEach } from 'vitest';
import { callApi } from '../helpers/api-test-helper';
import { InvalidAnycloudConfigError } from '../../../src/shared/errors';

const { handleQuotaStatusMock, handleCanceledQuotaStatusMock } = vi.hoisted(
  () => ({
    handleQuotaStatusMock: vi.fn(),
    handleCanceledQuotaStatusMock: vi.fn(),
  }),
);

vi.mock('../../../src/api/services/quota/handler.js', () => ({
  handleQuotaStatus: handleQuotaStatusMock,
  handleCanceledQuotaStatus: handleCanceledQuotaStatusMock,
}));

const AUTH_HEADER = { Authorization: 'Bearer mock-github-token' };

describe('Quota API routes', () => {
  beforeEach(() => {
    handleQuotaStatusMock.mockReset();
    handleCanceledQuotaStatusMock.mockReset();
  });

  it('retired operation routes are unavailable', async () => {
    const request = await callApi('https://example.com/v1/quota/operations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH_HEADER },
      body: JSON.stringify({
        cloud: 'AWS',
        credentialName: 'aws-a',
        vmType: 'g6e.48xlarge',
      }),
    });
    const operation = await callApi(
      'https://example.com/v1/quota/operations/old-id',
      { headers: AUTH_HEADER },
    );
    expect(request.status).toBe(404);
    expect(operation.status).toBe(404);
  });

  it('status rejects missing credentialName', async () => {
    const res = await callApi('https://example.com/v1/quota/status?cloud=AWS', {
      headers: AUTH_HEADER,
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: 'BAD_REQUEST',
      data: {
        issues: [
          expect.objectContaining({ path: ['query', 'credentialName'] }),
        ],
      },
    });
    expect(handleQuotaStatusMock).not.toHaveBeenCalled();
  });

  it('status rejects credentialName arrays', async () => {
    const res = await callApi(
      'https://example.com/v1/quota/status?cloud=AWS&credentialName=aws-a&credentialName=aws-b',
      { headers: AUTH_HEADER },
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: 'BAD_REQUEST',
      data: {
        issues: [
          expect.objectContaining({
            path: ['query', 'credentialName'],
            message: expect.stringContaining('received array'),
          }),
        ],
      },
    });
    expect(handleQuotaStatusMock).not.toHaveBeenCalled();
  });

  it('status reports why the quota service rejected the read', async () => {
    handleQuotaStatusMock.mockRejectedValue(
      new InvalidAnycloudConfigError('Quota status is not supported for GCP.'),
    );

    const res = await callApi(
      'https://example.com/v1/quota/status?cloud=GCP&credentialName=gcp-a',
      { headers: AUTH_HEADER },
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: 'QUOTA_STATUS_INVALID',
      message: 'Quota status is not supported for GCP.',
    });
  });

  it('status keeps an unexpected provider failure internal', async () => {
    handleQuotaStatusMock.mockRejectedValue(
      new Error('Quota status provider read failed against secret-host'),
    );

    const res = await callApi(
      'https://example.com/v1/quota/status?cloud=AWS&credentialName=aws-a',
      { headers: AUTH_HEADER },
    );

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    expect(JSON.stringify(body)).not.toContain('secret-host');
  });

  it('status forwards clamped waitMs for quick provider reads', async () => {
    handleQuotaStatusMock.mockResolvedValue([]);

    const res = await callApi(
      'https://example.com/v1/quota/status?cloud=AWS&credentialName=aws-a&waitMs=100',
      { headers: AUTH_HEADER },
    );

    expect(res.status).toBe(200);
    expect(handleQuotaStatusMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: '1', username: 'test-user' }),
      'AWS',
      'aws-a',
      undefined,
      {
        providerWaitMs: 500,
        failOpenProviderStatus: true,
      },
    );
  });

  it('reads canceled local submissions without a credential or provider call', async () => {
    handleCanceledQuotaStatusMock.mockResolvedValue([]);

    const res = await callApi('https://example.com/v1/quota/canceled', {
      headers: AUTH_HEADER,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ entries: [] });
    expect(handleCanceledQuotaStatusMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: '1', username: 'test-user' }),
    );
    expect(handleQuotaStatusMock).not.toHaveBeenCalled();
  });
});

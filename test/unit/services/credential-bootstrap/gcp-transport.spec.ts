import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  gcpOperator,
  runGcloud,
} from '../../../../src/cli/services/credential-bootstrap/gcp-cli-runner.js';
import {
  createGCPTransport,
  GCPBootstrapError,
} from '../../../../src/cli/services/credential-bootstrap/gcp-transport.js';

vi.mock(
  '../../../../src/cli/services/credential-bootstrap/gcp-cli-runner.js',
  async (original) => ({
    ...(await original<
      typeof import('../../../../src/cli/services/credential-bootstrap/gcp-cli-runner.js')
    >()),
    runGcloud: vi.fn(),
  }),
);
beforeEach(() => {
  nock.disableNetConnect();
  vi.mocked(runGcloud).mockResolvedValue('PRIVATE-OPERATOR-TOKEN\n');
});
afterEach(() => {
  nock.cleanAll();
  nock.enableNetConnect();
  vi.resetAllMocks();
});

describe('0038/S3 GCP mutation transport', () => {
  it.each([
    [
      'Service account new@selected-project.iam.gserviceaccount.com does not exist.',
      400,
      'INVALID_ARGUMENT',
      'new@selected-project.iam.gserviceaccount.com',
    ],
    [
      'Exception calling IAM: Service account new@selected-project.iam.gserviceaccount.com does not exist.',
      400,
      'INVALID_ARGUMENT',
      'new@selected-project.iam.gserviceaccount.com',
    ],
    [
      'Service account new@selected-project.iam.gserviceaccount.com does not exist.',
      403,
      'PERMISSION_DENIED',
      undefined,
    ],
    [
      'Service account new@selected-project.iam.gserviceaccount.com does not exist. PRIVATE-DETAIL',
      400,
      'INVALID_ARGUMENT',
      undefined,
    ],
  ])(
    'retains only the exact visibility rejection (%s, %i)',
    async (message, status, code, missingServiceAccount) => {
      const scope = nock('https://cloudresourcemanager.googleapis.com')
        .post('/v1/projects/selected-project:setIamPolicy')
        .reply(status as number, { error: { status: code, message } });
      const transport = await createGCPTransport(
        gcpOperator('selected@example.com', 'selected-project', {}),
      );
      const failure = await transport
        .request(
          'projects',
          '/v1/projects/selected-project:setIamPolicy',
          'POST',
          {},
        )
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(GCPBootstrapError);
      expect(failure).toMatchObject({ status, code, missingServiceAccount });
      expect(String(failure)).not.toContain('PRIVATE-');
      expect(scope.isDone()).toBe(true);
    },
  );

  it.each([
    ['SERVICE_DISABLED', 'SERVICE_DISABLED'],
    ['IAM_PERMISSION_DENIED', 'PERMISSION_DENIED'],
  ])(
    'distinguishes a disabled API from a permission denial (%s)',
    async (reason, code) => {
      nock('https://iam.googleapis.com')
        .get('/v1/projects/selected-project/serviceAccounts/new')
        .reply(403, {
          error: {
            status: 'PERMISSION_DENIED',
            message: 'PRIVATE-DETAIL',
            details: [
              { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason },
            ],
          },
        });
      const transport = await createGCPTransport(
        gcpOperator('selected@example.com', 'selected-project', {}),
      );
      const failure = await transport
        .request('iam', '/v1/projects/selected-project/serviceAccounts/new')
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({ status: 403, code });
      expect(String(failure)).not.toContain('PRIVATE-');
    },
  );

  it.each(['server failure', 'lost response'])(
    'sends key creation once after %s and redacts diagnostics',
    async (failure) => {
      let attempts = 0;
      const scope = nock('https://iam.googleapis.com').persist();
      const pending = scope.post(
        '/v1/projects/selected-project/serviceAccounts/123/keys',
      );
      if (failure === 'lost response')
        pending.replyWithError(new Error('PRIVATE-RESPONSE-DETAIL'));
      else
        pending.reply(503, { error: { message: 'PRIVATE-RESPONSE-DETAIL' } });
      scope.on('request', () => {
        attempts++;
      });
      const operator = gcpOperator(
        'selected@example.com',
        'selected-project',
        {},
      );
      const transport = await createGCPTransport(operator);
      const error = await transport
        .request(
          'iam',
          '/v1/projects/selected-project/serviceAccounts/123/keys',
          'POST',
          {},
        )
        .catch((value: unknown) => value);
      expect(attempts).toBe(1);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain('PRIVATE-');
      expect(error).not.toHaveProperty('cause');
      expect(runGcloud).toHaveBeenCalledExactlyOnceWith(
        [
          'auth',
          'print-access-token',
          '--account=selected@example.com',
          '--project=selected-project',
        ],
        operator.environment,
      );
    },
  );

  it('never follows a redirect carrying the operator token', async () => {
    const scope = nock('https://iam.googleapis.com')
      .post('/v1/projects/selected-project/serviceAccounts')
      .reply(307, '', { Location: 'https://unselected.example/collect' });
    const transport = await createGCPTransport(
      gcpOperator('selected@example.com', 'selected-project', {}),
    );
    await expect(
      transport.request(
        'iam',
        '/v1/projects/selected-project/serviceAccounts',
        'POST',
        {},
      ),
    ).rejects.toThrow('may have succeeded');
    expect(scope.isDone()).toBe(true);
  });
});

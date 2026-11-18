import { createHash } from 'crypto';
import { execFile } from 'child_process';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { promisify } from 'util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gcpOperator } from '../../../src/cli/services/credential-bootstrap/gcp-cli-runner.js';
import { cleanupGCPGeneration } from '../../../src/cli/services/credential-bootstrap/gcp.js';
import {
  cleanupGCPGenerationFixture,
  prepareGCPGenerationFixture,
  readGCPGenerationOwnership,
} from '../../integration/credentials-onboarding/gcp/generation-fixture.js';

vi.mock(
  '../../../src/cli/services/credential-bootstrap/gcp.js',
  async (original) => ({
    ...(await original<
      typeof import('../../../src/cli/services/credential-bootstrap/gcp.js')
    >()),
    cleanupGCPGeneration: vi.fn(),
  }),
);

const clusterRecords: string[] = [];
const operator = gcpOperator('operator@example.com', 'selected-project', {});
const name = 'onb-gen-abcdef123456';
const owned = {
  projectId: operator.projectId,
  projectNumber: '123456789012',
  email: `anycloud-${name}@${operator.projectId}.iam.gserviceaccount.com`,
  uniqueId: '222222222222222222222',
  invocationId: '00000000-0000-4000-8000-000000000001',
  keyIds: ['abc123'],
  projectRoles: ['roles/storage.admin'],
};
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gcp-ownership-test-'));
  clusterRecords.push(root);
  return prepareGCPGenerationFixture(root, operator, name);
}
beforeEach(() => {
  vi.mocked(cleanupGCPGeneration).mockReset().mockResolvedValue(undefined);
});
afterEach(async () => {
  for (const root of clusterRecords.splice(0))
    await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('0038/S3 GCP generation CI ownership', () => {
  it('records creation responses without replacing their immutable ID or persisting secrets', async () => {
    const context = await fixture();
    const root = clusterRecords.at(-1)!;
    const bootstrap = join(root, 'stub-fetch.mjs');
    const privateKey = 'NEVER-RECORD-THIS-PRIVATE-KEY';
    const account = {
      ...owned,
      description: `AnyCloud credential generation ${owned.invocationId}`,
    };
    const requests = [
      {
        path: '',
        method: 'GET',
        body: {
          projectId: operator.projectId,
          projectNumber: owned.projectNumber,
        },
      },
      { path: '/serviceAccounts', method: 'POST', body: account },
      {
        path: `/serviceAccounts/${owned.uniqueId}`,
        method: 'GET',
        body: { ...account, uniqueId: '333333333333333333333' },
      },
      {
        path: '/serviceAccounts/' + owned.uniqueId + '/keys',
        method: 'POST',
        body: {
          privateKeyData: Buffer.from(
            JSON.stringify({
              type: 'service_account',
              project_id: operator.projectId,
              client_email: owned.email,
              client_id: owned.uniqueId,
              private_key_id: owned.keyIds[0],
              private_key: privateKey,
            }),
          ).toString('base64'),
        },
      },
    ];
    await writeFile(
      bootstrap,
      'globalThis.fetch = async (_input, init) => new Response(init.body, { headers: { "Content-Type": "application/json" } });\n',
    );
    await promisify(execFile)(
      process.execPath,
      [
        '--import',
        bootstrap,
        '--import',
        resolve(
          'test/integration/credentials-onboarding/gcp/recording-fetch.mjs',
        ),
        '--input-type=module',
        '--eval',
        `for (const request of ${JSON.stringify(requests)}) {
        const host = request.path ? 'iam.googleapis.com' : 'cloudresourcemanager.googleapis.com';
        await fetch('https://' + host + '/v1/projects/${operator.projectId}' + request.path, { method: request.method, body: JSON.stringify(request.body) });
      }`,
      ],
      { env: { ...context.environment, NODE_OPTIONS: '' } },
    );
    const record = await readGCPGenerationOwnership(context);
    expect(record.uniqueId).toBe(owned.uniqueId);
    expect(record.keyIds).toEqual(owned.keyIds);
    expect(record.privateKeyFingerprint).toBe(
      createHash('sha256').update(privateKey).digest('hex'),
    );
    expect(await readFile(context.recordPath, 'utf8')).not.toContain(
      privateKey,
    );
  });

  it('requires creation evidence before any cloud cleanup', async () => {
    const context = await fixture();
    const deleteAPI = vi.fn().mockResolvedValue(undefined);
    await expect(
      cleanupGCPGenerationFixture(context, deleteAPI),
    ).rejects.toMatchObject({
      errors: [
        expect.objectContaining({
          message: expect.stringContaining('No name-based cleanup is allowed'),
        }),
      ],
    });
    expect(cleanupGCPGeneration).not.toHaveBeenCalled();
    expect(deleteAPI).toHaveBeenCalledOnce();
    expect(() =>
      prepareGCPGenerationFixture(clusterRecords.at(-1)!, operator, 'onb-123'),
    ).toThrow('Invalid GCP generation fixture name');
  });

  it('rejects a creation record for another target', async () => {
    const context = await fixture();
    await writeFile(
      context.recordPath,
      JSON.stringify({ ...owned, projectId: 'other-project' }),
    );
    await expect(readGCPGenerationOwnership(context)).rejects.toThrow(
      'another target',
    );
    expect(cleanupGCPGeneration).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'attempts owned provider teardown even after API deletion fails (provider also fails: %s)',
    async (providerFails) => {
      const context = await fixture();
      await writeFile(context.recordPath, JSON.stringify(owned), {
        mode: 0o600,
      });
      const apiFailure = new Error('API unavailable');
      const providerFailure = new Error('Provider denied cleanup');
      if (providerFails)
        vi.mocked(cleanupGCPGeneration).mockRejectedValue(providerFailure);
      const log = vi.spyOn(console, 'info').mockImplementation(() => {});
      await expect(
        cleanupGCPGenerationFixture(
          context,
          vi.fn().mockRejectedValue(apiFailure),
        ),
      ).rejects.toMatchObject({
        errors: providerFails ? [apiFailure, providerFailure] : [apiFailure],
      });
      expect(cleanupGCPGeneration).toHaveBeenCalledExactlyOnceWith(
        operator,
        owned,
      );
      for (const value of [owned.projectId, owned.uniqueId, owned.invocationId])
        expect(log.mock.calls.flat().join(' ')).toContain(value);
    },
  );
});

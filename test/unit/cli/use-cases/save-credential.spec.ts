import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTestApiUrl } from '../../helpers/api-test-helper.js';
import {
  getCredentialSecretStore,
  resetPersistence,
} from '../../../../src/api/services/persistence.js';
import { decryptCredential } from '../../../../src/api/services/cloud-config.js';
import { ANYCLOUD_CLIENT_VERSION_HEADER } from '../../../../src/shared/api-version.js';
import { CloudType } from '../../../../src/shared/cloud.js';
import { createApiClient } from '../../../../src/shared/services/api-client/rpc.js';
import {
  acquiredCredential,
  generatedCredential,
} from '../../../../src/cli/services/credential-onboarding/acquired-credential.js';
import type { CredentialAcquisition } from '../../../../src/cli/services/credential-onboarding/index.js';
import {
  credentialNameTaken,
  saveCredential,
} from '../../../../src/cli/use-cases/save-credential.js';

const credentialName = 'save-safety';
const azureCredential = {
  cloudProvider: CloudType.Azure,
  applicationId: 'generated-application',
  secret: 'generated-secret',
  subscriptionId: 'selected-subscription',
  directoryId: 'selected-directory',
} as const;

// The client binds fetch when created, so create it after any interception.
function save(acquired: CredentialAcquisition) {
  return saveCredential(
    createApiClient('mock-github-token'),
    credentialName,
    acquired,
    false,
  );
}

async function storedCredential() {
  const stored =
    await getCredentialSecretStore().getNamedCredential(credentialName);
  expect(stored).toBeDefined();
  return decryptCredential(stored!.encryptedData);
}

type FetchHandler = (
  request: Request,
  forward: typeof globalThis.fetch,
) => Promise<Response>;

function interceptRequests(handle: FetchHandler): Request[] {
  const forward = globalThis.fetch;
  const requests: Request[] = [];
  vi.stubGlobal(
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      expect(new URL(request.url).origin).toBe(getTestApiUrl());
      requests.push(request);
      return handle(request, forward);
    },
  );
  return requests;
}

async function rejectVersion(
  request: Request,
  forward: typeof globalThis.fetch,
) {
  const headers = new Headers(request.headers);
  headers.set(ANYCLOUD_CLIENT_VERSION_HEADER, '0.0.0');
  const response = await forward(new Request(request, { headers }));
  expect(response.status).toBe(400);
  expect(await response.clone().json()).toMatchObject({
    code: 'CLIENT_VERSION_MISMATCH',
  });
  return response;
}

function loseSaveResponse(verification?: FetchHandler): Request[] {
  let puts = 0;
  return interceptRequests(async (request, forward) => {
    if (request.method !== 'PUT') {
      return puts > 0 && verification
        ? verification(request, forward)
        : forward(request);
    }

    puts += 1;
    // An API upgrade can reject a retry before the idempotent save domain runs.
    if (puts > 1) return rejectVersion(request, forward);

    const response = await forward(request);
    expect(response.status).toBe(204);
    await response.arrayBuffer();
    throw new TypeError('fetch failed after the save committed');
  });
}

function putCount(requests: Request[]): number {
  return requests.filter((request) => request.method === 'PUT').length;
}

describe('saveCredential through the RPC client and API', () => {
  const cleanup = vi.fn(async () => undefined);
  const generatedAzure = () => generatedCredential(azureCredential, cleanup);

  beforeEach(() => {
    resetPersistence();
    cleanup.mockReset().mockResolvedValue(undefined);
    vi.stubEnv('API_URL', getTestApiUrl());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('preserves a saved Azure identity when a lost response would be followed by a rejected retry', async () => {
    const requests = loseSaveResponse();
    const acquired = generatedAzure();

    await save(acquired);

    expect(await storedCredential()).toEqual(azureCredential);
    expect(cleanup).not.toHaveBeenCalled();
    expect(putCount(requests)).toBe(1);
    expect(acquired.lease?.state).toBe('committed');
  });

  it('commits a confirmed Azure save and prevents subsequent lease cleanup', async () => {
    const acquired = generatedAzure();

    await save(acquired);

    expect(await storedCredential()).toEqual(azureCredential);
    expect(acquired.lease?.state).toBe('committed');
    await acquired.lease?.rollback();
    expect(cleanup).not.toHaveBeenCalled();
    const client = createApiClient('mock-github-token');
    expect(await credentialNameTaken(client, credentialName)).toBe(true);
    expect(await credentialNameTaken(client, 'other')).toBe(false);
  });

  it('cleans up when the first save is rejected before reaching the domain', async () => {
    const requests = interceptRequests((request, forward) =>
      request.method === 'PUT'
        ? rejectVersion(request, forward)
        : forward(request),
    );
    const acquired = generatedAzure();

    await expect(save(acquired)).rejects.toThrow();

    expect(
      await getCredentialSecretStore().getNamedCredential(credentialName),
    ).toBeNull();
    expect(putCount(requests)).toBe(1);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(acquired.lease?.state).toBe('rolled-back');
  });

  it('reports a failed cleanup together with the definitive save rejection', async () => {
    interceptRequests((request, forward) =>
      request.method === 'PUT'
        ? rejectVersion(request, forward)
        : forward(request),
    );
    cleanup.mockRejectedValue(new Error('cleanup denied'));
    const acquired = generatedAzure();

    await expect(save(acquired)).rejects.toThrow(
      /Cleanup of the generated cloud identity also failed: cleanup denied/,
    );

    expect(cleanup).toHaveBeenCalledOnce();
    expect(acquired.lease?.state).toBe('rollback-failed');
  });

  it('cleans up a rejected generation when another credential wins the name race', async () => {
    const otherCredential = {
      ...azureCredential,
      applicationId: 'existing-application',
    };
    const requests = interceptRequests(async (request, forward) => {
      if (request.method === 'PUT') {
        const winner = await forward(
          new Request(request.clone(), {
            body: JSON.stringify(otherCredential),
          }),
        );
        expect(winner.status).toBe(204);
        await winner.arrayBuffer();
      }
      return forward(request);
    });
    const acquired = generatedAzure();

    await expect(save(acquired)).rejects.toThrow();

    expect(await storedCredential()).toEqual(otherCredential);
    expect(putCount(requests)).toBe(1);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(acquired.lease?.state).toBe('rolled-back');
  });

  it.each(['empty', 'mismatched', 'failed'] as const)(
    'retains a saved Azure identity after a lost response and %s verification',
    async (verification) => {
      const requests = loseSaveResponse((request, forward) => {
        if (verification === 'failed') return rejectVersion(request, forward);
        return Promise.resolve(
          Response.json(
            verification === 'empty'
              ? []
              : [
                  {
                    name: credentialName,
                    cloudProvider: CloudType.Azure,
                    applicationId: 'different-application',
                    subscriptionId: azureCredential.subscriptionId,
                  },
                ],
          ),
        );
      });
      const acquired = generatedAzure();

      await expect(save(acquired)).rejects.toThrow(
        'retained for safe manual reconciliation',
      );

      expect(await storedCredential()).toEqual(azureCredential);
      expect(putCount(requests)).toBe(1);
      expect(acquired.lease?.state).toBe('retained');
      await acquired.lease?.rollback();
      expect(cleanup).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      provider: 'aws',
      credential: {
        cloudProvider: CloudType.AWS,
        accessKeyId: 'AKIA-GENERATED',
        secretAccessKey: 'generated-secret',
      },
      state: 'committed',
    },
    {
      provider: 'gcp',
      credential: {
        cloudProvider: CloudType.GCP,
        projectId: 'generated-project',
        clientEmail: 'generated@generated-project.iam.gserviceaccount.com',
        privateKey: 'generated-private-key',
      },
      state: 'retained',
    },
  ] as const)(
    'keeps the $provider lease $state after a lost save response',
    async ({ credential, state }) => {
      const acquired = generatedCredential(credential, cleanup);
      const requests = loseSaveResponse();

      const outcome = await save(acquired).catch((error: unknown) => error);

      expect(await storedCredential()).toEqual(credential);
      expect(putCount(requests)).toBe(1);
      expect(acquired.lease?.state).toBe(state);
      expect(cleanup).not.toHaveBeenCalled();
      if (state === 'retained') {
        expect(outcome).toBeInstanceOf(Error);
        expect((outcome as Error).message).toContain(
          'retained for safe manual reconciliation',
        );
      } else {
        expect(outcome).toBeUndefined();
      }
    },
  );

  it('keeps normal replay for an imported credential without a generation lease', async () => {
    let puts = 0;
    interceptRequests(async (request, forward) => {
      const response = await forward(request);
      if (request.method === 'PUT' && ++puts === 1) {
        expect(response.status).toBe(204);
        await response.arrayBuffer();
        throw new TypeError('fetch failed after the save committed');
      }
      return response;
    });

    await save(acquiredCredential(azureCredential));

    expect(await storedCredential()).toEqual(azureCredential);
    expect(puts).toBe(2);
  });

  it('does not reconcile an imported secret from a redacted identity', async () => {
    const saveError = new Error('API request timed out');
    const client = {
      credentials: {
        save: vi.fn().mockRejectedValue(saveError),
        list: vi.fn(),
      },
    };

    await expect(
      saveCredential(
        client,
        credentialName,
        acquiredCredential(azureCredential),
        true,
      ),
    ).rejects.toBe(saveError);

    expect(client.credentials.list).not.toHaveBeenCalled();
  });
});

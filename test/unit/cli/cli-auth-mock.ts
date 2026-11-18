import { vi } from 'vitest';

import {
  createApiClient,
  type CreateApiClientOptions,
} from '../../../src/shared/services/api-client/rpc.js';

/**
 * The CLI auth module for command specs: clients and native calls carry a
 * fixed bearer instead of reading a local API token or GitHub sign-in.
 */
export function cliAuthMock(
  bearer: string | (() => Promise<string>) = 'test-token',
) {
  const token = typeof bearer === 'string' ? async () => bearer : bearer;
  return {
    // Specs assert createApiClient's arguments, so pass options only if given.
    apiClient: vi.fn(async (options?: CreateApiClientOptions) =>
      createApiClient(await token(), ...(options ? [options] : [])),
    ),
    nativeApiBearer: vi.fn(token),
    // Signed out has no bearer; any sign-in gets the fixed one.
    hostedApiBearer: vi.fn(
      async (_apiUrl: string, signIn: () => Promise<string | null>) =>
        (await signIn()) === null ? null : token(),
    ),
  };
}

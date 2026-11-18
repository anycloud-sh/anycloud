import type { AuthenticateApiRequest } from '../../src/api/services/api-authentication.js';
import Github from '../../src/api/services/gateways/github.js';

/**
 * In-process APIs and harness children authenticate any bearer as the GitHub
 * identity `Github.authenticate` resolves: IS_TEST's stub, or a unit spec's
 * mock of it. A production API takes API tokens or its install token instead.
 */
export const testAuthenticate: AuthenticateApiRequest = async (
  token,
  signal,
) => {
  const { id, username } = await Github.authenticate(token, signal);
  return { id, username, token };
};

import { ServiceUpgradeError } from '../services/service-upgrade-domain.js';
import {
  throwDeclaredDeployError,
  throwDeclaredError,
  type DeclaredErrorCodes,
} from './errors.js';
import { clientWindowAuthenticatedImplementation as authenticated } from './base.js';

const UPGRADE_CODES = {
  400: 'SERVICE_UPGRADE_INVALID',
  404: 'SERVICE_NOT_FOUND',
  409: 'SERVICE_UPGRADE_CONFLICT',
  503: 'SERVICE_UPGRADE_UNAVAILABLE',
} satisfies DeclaredErrorCodes;

function throwUpgradeError(error: unknown): never {
  if (error instanceof ServiceUpgradeError) {
    throwDeclaredError(error, error.statusCode, error.message, UPGRADE_CODES);
  }
  throwDeclaredDeployError(error, UPGRADE_CODES);
}

export const serviceUpgradeRouter = {
  upgrade: authenticated.serviceUpgrade.upgrade.handler(
    async ({ context, input, signal }) => {
      try {
        return await context.domains.serviceUpgrade.upgrade(
          context.actor,
          { id: input.params.id, ...input.body },
          context.clientVersion,
          signal,
        );
      } catch (error) {
        throwUpgradeError(error);
      }
    },
  ),
};

import { authenticatedEndpoints } from './base.js';
import {
  serviceUpgradeRequestSchema,
  serviceUpgradeResponseSchema,
} from './service-upgrade-schemas.js';

const authenticated = authenticatedEndpoints({}, 'Service Upgrades');

const upgrade = authenticated
  .command(
    {
      method: 'POST',
      path: '/workloads/{id}/upgrades',
      operationId: 'upgradeService',
      summary: 'Queue an in-place Service upgrade',
      inputStructure: 'detailed',
      successStatus: 202,
    },
    {
      replay: 'not-processed',
      timeoutMs: null,
    },
  )
  .input(serviceUpgradeRequestSchema)
  .output(serviceUpgradeResponseSchema)
  .errors({
    SERVICE_UPGRADE_INVALID: {
      status: 400,
      message: 'Invalid Service upgrade',
    },
    SERVICE_NOT_FOUND: {
      status: 404,
      message: 'Service workload not found',
    },
    SERVICE_UPGRADE_CONFLICT: {
      status: 409,
      message: 'Service upgrade conflict',
    },
    SERVICE_UPGRADE_UNAVAILABLE: {
      status: 503,
      message: 'Service upgrade unavailable',
    },
  });

export const serviceUpgradeContract = { upgrade };

import type { ResourceSweepPolicy } from '../../src/api/services/gateways/resource-sweeper';
import {
  TEST_USER_ID,
  TEST_USERNAMES,
} from '../../src/api/services/test-identity.js';

export const CI_RESOURCE_SWEEP_MIN_AGE_MS = 3 * 60 * 60 * 1000;

/**
 * CI shares its cloud accounts with other installations, so it reclaims only
 * test users' resources (old or end-marked) and old unstamped ones. Dedicated
 * Jobs tag the test username; pools tag the test user's id.
 */
export const CI_RESOURCE_SWEEP_POLICY = {
  reclaimableUserIds: [...TEST_USERNAMES, TEST_USER_ID],
  includeUnowned: true,
  minAgeMs: CI_RESOURCE_SWEEP_MIN_AGE_MS,
  reclaimMarkedEnded: true,
} satisfies ResourceSweepPolicy;

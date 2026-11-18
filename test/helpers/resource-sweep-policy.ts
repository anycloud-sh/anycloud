import { CI_RESOURCE_SWEEP_POLICY } from '../../ci/cleanup/policy';

/**
 * Specs sweep with the policy CI actually runs, so integration cleanup
 * coverage cannot drift from ci/cleanup/*.ts.
 */
export const TEST_RESOURCE_SWEEP_OPTIONS = {
  policy: CI_RESOURCE_SWEEP_POLICY,
} as const;

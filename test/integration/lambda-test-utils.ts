/**
 * Shared test utilities for Lambda Labs integration tests
 */
import { Lambda } from '../../src/api/services/gateways/lambda';
import { retryUntil } from '../../src/shared/utils';

/**
 * Helper to verify a Lambda instance is terminated.
 * Polls until instance is gone or in terminal state.
 */
export async function ensureVMTerminated(lambda: Lambda, cloudId: string) {
  await retryUntil(
    async () => {
      const vms = await lambda.compute().getAllVMs();
      return { exists: vms.some((v) => v.cloudId === cloudId) };
    },
    (result) => !result.exists,
    'Lambda instance termination',
    { maxAttempts: 24, waitMs: 5000 }, // 2 minutes total
  );
}

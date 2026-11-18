/**
 * Lambda Labs Sad Path Integration Test
 *
 * Tests failure scenarios against the real Lambda API and, critically,
 * asserts that Lambda.classifyError maps each real error message to the
 * correct CloudFailureDiagnosis. Without these assertions, a reworded Lambda API
 * error silently falls through to Transient and the workload would spin
 * in Retrying / block the wrong region.
 *
 * Requirements:
 * - Lambda Labs API key in environment:
 *   - LAMBDA_API_KEY
 *
 * Run with:
 *   source .env.lambda && yarn test:lambda-sad
 *
 * yarn test:lambda-sad selects the API error suite. The manual Lambda
 * boot-failover workflow selects the separate paid qualification suite.
 * That trial shortens only the first real instance's IP wait; its provider
 * calls and retry pipeline remain real.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';

const forcedBootWait = vi.hoisted(() => ({ armed: false, used: false }));

vi.mock('../../src/shared/utils', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/shared/utils')>();
  return {
    ...actual,
    retryUntil: async <T>(
      operation: () => Promise<T>,
      condition: (result: T) => boolean,
      name: string,
      options: { maxAttempts?: number; waitMs?: number } = {},
    ): Promise<T> => {
      if (
        forcedBootWait.armed &&
        !forcedBootWait.used &&
        name.startsWith('Lambda instance IP for ')
      ) {
        forcedBootWait.used = true;
        forcedBootWait.armed = false;
        const result = await operation();
        if (condition(result)) return result;
        throw new Error(`${name} failed after 1 attempts`);
      }
      return actual.retryUntil(operation, condition, name, options);
    },
  };
});

import { completeCloudConfig } from '../../src/shared/cloud-config.js';
import { Lambda } from '../../src/api/services/gateways/lambda';
import { CloudFailureDiagnosis } from '../../src/shared/cloud';
import { CloudConfig, CloudType } from '../../src/shared/cloud.js';
import { FailureDisposition } from '../../src/api/services/provisioning-failure.js';

async function captureError(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
  throw new Error('Expected the operation to throw, but it resolved');
}

beforeAll(() => {
  if (!process.env.LAMBDA_API_KEY) {
    throw new Error(
      'Lambda credentials not found in environment. Please set LAMBDA_API_KEY',
    );
  }
});

describe('Lambda sad path integration', () => {
  it('classifies invalid API key as BadCredential', async () => {
    // Region doesn't matter — we're testing that invalid credentials are rejected
    const config: CloudConfig = {
      cloudProvider: CloudType.Lambda,
      credentials: { apiKey: 'invalid-key-12345' },
      region: 'us-east-1',
      availabilityZone: undefined,
      vmType: 'gpu_1x_a100',
    };

    const lambda = new Lambda(completeCloudConfig(config));
    const error = await captureError(() =>
      lambda.compute().validateCredentials(),
    );
    expect(lambda.compute().classifyError(error)).toBe(
      CloudFailureDiagnosis.BadCredential,
    );
  }, 30000);

  it('classifies invalid instance type as InvalidTarget', async () => {
    const region = 'us-east-1';
    const availabilityZone = undefined;
    const config: CloudConfig = {
      cloudProvider: CloudType.Lambda,
      credentials: { apiKey: process.env.LAMBDA_API_KEY! },
      region,
      availabilityZone,
      vmType: 'INVALID_TYPE_DOES_NOT_EXIST',
    };

    const lambda = new Lambda(completeCloudConfig(config));
    const error = await captureError(() =>
      lambda.compute().newVM({
        startupScript: '#!/bin/bash\necho test',
        ipWhitelist: [],
        vmId: `sad-test-${Date.now()}`,
        workloadId: `deploy-sad-${Date.now()}`,
        version: '0.0.0-test',
        userId: '',
      }),
    );
    expect(lambda.compute().classifyError(error)).toBe(
      CloudFailureDiagnosis.InvalidTarget,
    );
  }, 60000);

  it('classifies invalid region as InvalidTarget', async () => {
    const config: CloudConfig = {
      cloudProvider: CloudType.Lambda,
      credentials: { apiKey: process.env.LAMBDA_API_KEY! },
      region: 'zz-fake-region-1',
      availabilityZone: undefined,
      vmType: 'gpu_1x_a100',
    };

    const lambda = new Lambda(completeCloudConfig(config));
    const error = await captureError(() =>
      lambda.compute().newVM({
        startupScript: '#!/bin/bash\necho test',
        ipWhitelist: [],
        vmId: `sad-region-${Date.now()}`,
        workloadId: `deploy-sad-region-${Date.now()}`,
        version: '0.0.0-test',
        userId: '',
      }),
    );
    expect(lambda.compute().classifyError(error)).toBe(
      CloudFailureDiagnosis.InvalidTarget,
    );
  }, 60000);
});

describe('Lambda boot failover qualification', () => {
  it(
    'forces one real no-IP failure, changes target, and reaches Running',
    async () => {
      // Listing suites must not initialize the paid trial's live API harness.
      const { runLambdaBootTimeoutQualification } = await import(
        './helpers/lambda-boot-timeout-qualification.js'
      );
      forcedBootWait.used = false;
      const workloadId =
        `lbto-${process.env.GITHUB_RUN_ID ?? Date.now()}-${process.env.TRIAL_ID ?? '00'}`.slice(
          0,
          28,
        );

      const result = await runLambdaBootTimeoutQualification({
        apiKey: process.env.LAMBDA_API_KEY!,
        armForcedBootTimeout: () => {
          forcedBootWait.armed = true;
        },
        workloadId,
        ledgerPath: process.env.LAMBDA_BOOT_FAILOVER_LEDGER_PATH,
      });

      expect(forcedBootWait.used).toBe(true);
      expect(result).toMatchObject({
        diagnosis: CloudFailureDiagnosis.CapacityExhausted,
        disposition: FailureDisposition.FailoverTarget,
      });
      expect(result.secondTarget).not.toEqual(result.firstTarget);
      expect(result.replacementInstanceId).not.toBe(result.firstInstanceId);
    },
    55 * 60_000,
  );
});

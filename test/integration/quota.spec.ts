/**
 * Quota Provider Integration Tests
 *
 * Exercises the AWS and Azure quota providers against real cloud APIs via the
 * read-only status paths. No quota increases, support tickets, or region
 * opt-ins are submitted.
 *
 * Requirements:
 * - AWS:   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
 * - Azure: AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_TENANT_ID, AZURE_SUBSCRIPTION_ID
 *
 * Run with:
 *   source .env.aws && source .env.azure && yarn test:quota
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { requireAzureAuthentication } from './helpers/external-errors';
import {
  AwsQuotaProvider,
  AwsQuotaResolution,
} from '../../src/api/services/quota/aws';
import { AzureQuotaProvider } from '../../src/api/services/quota/azure';
import { QUOTA_REGION_TIMEOUT_MS } from '../../src/api/config';
import { TimeoutError, withTimeout } from '../../src/shared/utils';
import { useTestCatalogs } from './helpers/test-catalogs.js';

useTestCatalogs();

describe('AWS quota provider integration', { timeout: 90_000 }, () => {
  let provider: AwsQuotaProvider;

  beforeAll(() => {
    if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
      throw new Error(
        'AWS credentials not found. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY',
      );
    }
    provider = new AwsQuotaProvider({
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    });
  });

  it('lists open requests for an enabled region without throwing', async () => {
    const results = await provider.listOpenRequests(['us-east-1']);
    expect(Array.isArray(results)).toBe(true);
  });

  it('lists recent requests with resolution + grantedLimit shape', async () => {
    const results = await provider.listRecentRequests(['us-east-1']);
    expect(Array.isArray(results)).toBe(true);
    for (const r of results) {
      expect(Object.values(AwsQuotaResolution)).toContain(r.resolution);
      if (
        r.resolution === AwsQuotaResolution.Approved ||
        r.resolution === AwsQuotaResolution.Partial
      ) {
        expect(typeof r.grantedLimit).toBe('number');
      }
    }
  });

  it('lists current quota limits for an enabled region', async () => {
    const results = await provider.listCurrentLimits(['us-east-1']);
    // A throttled code is an unavailable row; the others must read.
    const current = results.filter((r) => r.kind === 'current');
    expect(current.length).toBeGreaterThan(0);
    for (const r of current) {
      expect(r.region).toBe('us-east-1');
      expect(typeof r.resourceName).toBe('string');
      expect(typeof r.currentLimit).toBe('number');
      expect('requestedLimit' in r).toBe(false);
    }
  });
});

describe('Azure quota provider integration', { timeout: 90_000 }, () => {
  let provider: AzureQuotaProvider;
  beforeAll(async () => {
    if (
      !process.env.AZURE_CLIENT_ID ||
      !process.env.AZURE_CLIENT_SECRET ||
      !process.env.AZURE_TENANT_ID ||
      !process.env.AZURE_SUBSCRIPTION_ID
    ) {
      throw new Error(
        'Azure credentials not found. Set AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_TENANT_ID, AZURE_SUBSCRIPTION_ID',
      );
    }
    await requireAzureAuthentication({
      tenantId: process.env.AZURE_TENANT_ID,
      clientId: process.env.AZURE_CLIENT_ID,
      clientSecret: process.env.AZURE_CLIENT_SECRET,
    });
    provider = new AzureQuotaProvider({
      applicationId: process.env.AZURE_CLIENT_ID,
      secret: process.env.AZURE_CLIENT_SECRET,
      directoryId: process.env.AZURE_TENANT_ID,
      subscriptionId: process.env.AZURE_SUBSCRIPTION_ID,
    });
  });

  // `quota status` caps this read at QUOTA_REGION_TIMEOUT_MS and reports a slow
  // Azure as an UNAVAILABLE row, so the same bounded timeout passes here while
  // any other scope or read error still fails.
  it(
    'lists open quota requests without throwing',
    { timeout: QUOTA_REGION_TIMEOUT_MS + 30_000 },
    async () => {
      const errors: unknown[] = [];
      const results = await withTimeout(
        provider.listOpenRequests('eastus', (_scope, err) => errors.push(err)),
        QUOTA_REGION_TIMEOUT_MS,
        'Azure quota eastus',
      ).catch((err: unknown) => {
        errors.push(err);
        return [];
      });
      expect(Array.isArray(results)).toBe(true);
      for (const err of errors) {
        if (!(err instanceof TimeoutError)) throw err;
        console.warn(`UNAVAILABLE: ${err.message}`);
        if (process.env.GITHUB_ACTIONS) {
          console.log(`::warning::Azure quota read tolerated: ${err.message}`);
        }
      }
    },
  );

  it('lists current status quota limits for a region', async () => {
    const results = await provider.listCurrentStatusQuotas('eastus');
    for (const r of results) {
      expect(r.region).toBe('eastus');
      expect(typeof r.resourceName).toBe('string');
      expect(typeof r.limit).toBe('number');
    }
  });

  it('lists open support tickets without throwing', async () => {
    const results = await provider.listOpenSupportTickets('eastus');
    expect(Array.isArray(results)).toBe(true);
  });
});

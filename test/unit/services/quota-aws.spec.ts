import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  quotasSend,
  accountSend,
  ec2Send,
  ec2Regions,
  getRegionsMock,
  getVMTypesMock,
  serviceQuotasRegions,
} = vi.hoisted(() => ({
  quotasSend: vi.fn(),
  accountSend: vi.fn(),
  ec2Send: vi.fn(),
  ec2Regions: [] as string[],
  getRegionsMock: vi.fn(),
  getVMTypesMock: vi.fn(() => [] as string[]),
  serviceQuotasRegions: [] as string[],
}));

vi.mock('@aws-sdk/client-service-quotas', () => ({
  ServiceQuotasClient: vi.fn().mockImplementation(function (config: {
    region?: string;
  }) {
    if (config.region) serviceQuotasRegions.push(config.region);
    return { send: quotasSend };
  }),
  GetServiceQuotaCommand: vi.fn().mockImplementation(function (
    this: { __type: string; input: unknown },
    input: unknown,
  ) {
    this.__type = 'GetServiceQuota';
    this.input = input;
  }),
  RequestServiceQuotaIncreaseCommand: vi.fn().mockImplementation(function (
    this: { __type: string; input: unknown },
    input: unknown,
  ) {
    this.__type = 'RequestServiceQuotaIncrease';
    this.input = input;
  }),
  ListRequestedServiceQuotaChangeHistoryCommand: vi
    .fn()
    .mockImplementation(function (
      this: { __type: string; input: unknown },
      input: unknown,
    ) {
      this.__type = 'ListRequestedServiceQuotaChangeHistory';
      this.input = input;
    }),
}));

vi.mock('@aws-sdk/client-account', () => ({
  AccountClient: vi.fn().mockImplementation(function () {
    return { send: accountSend };
  }),
  GetRegionOptStatusCommand: vi.fn().mockImplementation(function (
    this: { __type: string; input: unknown },
    input: unknown,
  ) {
    this.__type = 'GetRegionOptStatus';
    this.input = input;
  }),
  EnableRegionCommand: vi.fn().mockImplementation(function (
    this: { __type: string; input: unknown },
    input: unknown,
  ) {
    this.__type = 'EnableRegion';
    this.input = input;
  }),
  ListRegionsCommand: vi.fn().mockImplementation(function (
    this: { __type: string; input: unknown },
    input: unknown,
  ) {
    this.__type = 'ListRegions';
    this.input = input;
  }),
}));

vi.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: vi.fn().mockImplementation(function (config: { region?: string }) {
    ec2Regions.push(config.region ?? '');
    return { send: ec2Send };
  }),
  DescribeRegionsCommand: vi.fn().mockImplementation(function (
    this: { __type: string; input: unknown },
    input: unknown,
  ) {
    this.__type = 'DescribeRegions';
    this.input = input;
  }),
}));

vi.mock('../../../src/api/services/logger', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../../src/shared/cloud-config.js', () => ({
  getRegions: getRegionsMock,
  getQuotaRequestRegions: vi.fn(() => []),
  getRegionsForVMType: vi.fn(() => []),
  getVCPUsForVMType: vi.fn(() => 1),
  getVMTypes: getVMTypesMock,
}));

import {
  AwsQuotaProvider,
  awsQuotaStatus,
} from '../../../src/api/services/quota/aws.js';
import {
  AWS_CANDIDATE_PREFLIGHT_REGION_TIMEOUT_MS,
  QUOTA_REGION_TIMEOUT_MS,
} from '../../../src/api/config.js';

const creds = { accessKeyId: 'k', secretAccessKey: 's' };
const G_FAMILY_QUOTA_CODE = 'L-DB2E81BA';

describe('AwsQuotaProvider.listRecentRequests — partial-grant detection', () => {
  beforeEach(() => {
    quotasSend.mockReset();
    accountSend.mockReset();
  });

  it('reports CASE_CLOSED entries as partial when current limit < requested', async () => {
    quotasSend.mockImplementation(async (cmd: { __type: string }) => {
      if (cmd.__type === 'ListRequestedServiceQuotaChangeHistory') {
        return {
          RequestedQuotas: [
            {
              QuotaCode: G_FAMILY_QUOTA_CODE,
              QuotaName: 'All G and VT Spot Instance Requests',
              Status: 'CASE_CLOSED',
              DesiredValue: 4000,
              Id: 'req-closed',
              CaseId: 'case-closed-1',
              Created: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
            },
          ],
        };
      }
      if (cmd.__type === 'GetServiceQuota') {
        return { Quota: { Value: 3072 } };
      }
      throw new Error(`unexpected quotas command: ${cmd.__type}`);
    });

    const provider = new AwsQuotaProvider(creds);
    const recent = await provider.listRecentRequests(['us-east-1']);

    expect(recent).toHaveLength(1);
    expect(recent[0].resolution).toBe('partial');
    expect(recent[0].grantedLimit).toBe(3072);
    expect(recent[0].requestedLimit).toBe(4000);
    expect(recent[0].caseId).toBe('case-closed-1');
    expect(recent[0].url).toBe(
      'https://support.console.aws.amazon.com/support/home#/case/?displayId=case-closed-1',
    );
  });

  it('reports CASE_CLOSED entries as approved when current limit >= requested', async () => {
    quotasSend.mockImplementation(async (cmd: { __type: string }) => {
      if (cmd.__type === 'ListRequestedServiceQuotaChangeHistory') {
        return {
          RequestedQuotas: [
            {
              QuotaCode: G_FAMILY_QUOTA_CODE,
              Status: 'CASE_CLOSED',
              DesiredValue: 100,
              Id: 'req-ok',
              Created: new Date(),
            },
          ],
        };
      }
      if (cmd.__type === 'GetServiceQuota') {
        return { Quota: { Value: 100 } };
      }
      throw new Error(`unexpected quotas command: ${cmd.__type}`);
    });

    const provider = new AwsQuotaProvider(creds);
    const recent = await provider.listRecentRequests(['us-east-1']);

    expect(recent[0].resolution).toBe('approved');
    expect(recent[0].grantedLimit).toBe(100);
  });

  it('filters out entries older than the cutoff', async () => {
    quotasSend.mockImplementation(async (cmd: { __type: string }) => {
      if (cmd.__type === 'ListRequestedServiceQuotaChangeHistory') {
        return {
          RequestedQuotas: [
            {
              QuotaCode: G_FAMILY_QUOTA_CODE,
              Status: 'CASE_CLOSED',
              DesiredValue: 100,
              Id: 'req-old',
              Created: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
            },
          ],
        };
      }
      throw new Error(`unexpected quotas command: ${cmd.__type}`);
    });

    const provider = new AwsQuotaProvider(creds);
    const recent = await provider.listRecentRequests(['us-east-1'], 30);

    expect(recent).toHaveLength(0);
  });
});

describe('awsQuotaStatus — region selection', () => {
  beforeEach(() => {
    quotasSend.mockReset();
    accountSend.mockReset();
    getRegionsMock.mockReset();
    serviceQuotasRegions.length = 0;
  });

  it('limits all-region status to catalog regions', async () => {
    getRegionsMock.mockReturnValue(['us-east-1', 'ap-south-1', 'eu-west-1']);
    quotasSend.mockResolvedValue({ RequestedQuotas: [] });

    await awsQuotaStatus(creds);

    expect(accountSend).not.toHaveBeenCalled();
    expect(new Set(serviceQuotasRegions)).toEqual(
      new Set(['us-east-1', 'ap-south-1', 'eu-west-1']),
    );
  });

  it('honors an explicit status region without checking account-enabled regions', async () => {
    quotasSend.mockResolvedValue({ RequestedQuotas: [] });

    await awsQuotaStatus(creds, 'ap-south-1');

    expect(accountSend).not.toHaveBeenCalled();
    expect(getRegionsMock).not.toHaveBeenCalled();
    expect(new Set(serviceQuotasRegions)).toEqual(new Set(['ap-south-1']));
  });

  it('returns current quota rows when no recent requests exist', async () => {
    quotasSend.mockImplementation(
      async (cmd: { __type: string; input?: { QuotaCode?: string } }) => {
        if (cmd.__type === 'ListRequestedServiceQuotaChangeHistory') {
          return { RequestedQuotas: [] };
        }
        if (cmd.__type === 'GetServiceQuota') {
          return {
            Quota: {
              Value: cmd.input?.QuotaCode === G_FAMILY_QUOTA_CODE ? 96 : 0,
            },
          };
        }
        throw new Error(`unexpected quotas command: ${cmd.__type}`);
      },
    );

    const entries = await awsQuotaStatus(creds, 'us-east-1');
    const current = entries.filter((entry) => entry.kind === 'current');

    expect(entries.filter((entry) => entry.kind === 'request')).toEqual([]);
    expect(current).toHaveLength(10);
    expect(current).toContainEqual(
      expect.objectContaining({
        region: 'us-east-1',
        resourceName: 'Running On-Demand G and VT instances',
        status: 'CURRENT',
        currentLimit: 96,
      }),
    );
    expect(current[0]).not.toHaveProperty('requestedLimit');
  });

  it('reports a code it failed to read as unavailable, with the error', async () => {
    quotasSend.mockImplementation(
      async (cmd: { __type: string; input?: { QuotaCode?: string } }) => {
        if (cmd.__type === 'ListRequestedServiceQuotaChangeHistory')
          return { RequestedQuotas: [] };
        if (cmd.input?.QuotaCode === G_FAMILY_QUOTA_CODE)
          throw new Error(
            'The security token included in the request is invalid',
          );
        return { Quota: { Value: 32 } };
      },
    );

    const entries = await awsQuotaStatus(creds, 'us-east-1');

    expect(entries.filter((entry) => entry.kind === 'current')).toHaveLength(9);
    expect(entries.filter((entry) => entry.kind === 'unavailable')).toEqual([
      {
        kind: 'unavailable',
        cloud: 'AWS',
        region: 'us-east-1',
        resourceName: 'Running On-Demand G and VT instances',
        resourceKey: `aws:${G_FAMILY_QUOTA_CODE.toLowerCase()}`,
        status: 'UNAVAILABLE',
        message: 'The security token included in the request is invalid',
      },
    ]);
  });

  it('reports a region whose read timed out as unavailable', async () => {
    vi.useFakeTimers();
    try {
      quotasSend.mockImplementation(async (cmd: { __type: string }) =>
        cmd.__type === 'GetServiceQuota'
          ? new Promise(() => {})
          : { RequestedQuotas: [] },
      );
      const read = new AwsQuotaProvider(creds).listCurrentLimits([
        'me-south-1',
      ]);
      await vi.advanceTimersByTimeAsync(QUOTA_REGION_TIMEOUT_MS + 1);
      await expect(read).resolves.toEqual([
        expect.objectContaining({
          kind: 'unavailable',
          cloud: 'AWS',
          region: 'me-south-1',
          resourceName: 'EC2 current limits',
          status: 'UNAVAILABLE',
          message: expect.any(String),
        }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('AwsQuotaProvider.getEnabledRegions', () => {
  beforeEach(() => {
    accountSend.mockReset();
    ec2Send.mockReset();
  });

  const listRegionsDenied = Object.assign(
    new Error(
      'User: arn:aws:iam::123:user/restricted is not authorized to perform: account:ListRegions',
    ),
    { name: 'AccessDeniedException' },
  );

  it("reads EC2's enabled regions when the Account API is refused (run 42568226202)", async () => {
    accountSend.mockRejectedValue(listRegionsDenied);
    ec2Send.mockImplementation(
      async (cmd: { __type: string; input: unknown }) => {
        expect(cmd).toMatchObject({
          __type: 'DescribeRegions',
          input: { AllRegions: false },
        });
        return {
          Regions: [{ RegionName: 'ap-south-1' }, { RegionName: 'us-east-1' }],
        };
      },
    );

    const enabled = await new AwsQuotaProvider(creds).getEnabledRegions();

    expect(enabled).toEqual(new Set(['ap-south-1', 'us-east-1']));
    // Asked in us-east-1, which is never opt-in.
    expect(ec2Regions.at(-1)).toBe('us-east-1');
  });

  it('keeps the Account API error when EC2 refuses too, so the caller fails open', async () => {
    accountSend.mockRejectedValue(listRegionsDenied);
    ec2Send.mockRejectedValue(
      Object.assign(new Error('denied'), { name: 'UnauthorizedOperation' }),
    );

    await expect(new AwsQuotaProvider(creds).getEnabledRegions()).rejects.toBe(
      listRegionsDenied,
    );
  });

  it('returns the set of enabled + enabled-by-default region names', async () => {
    accountSend.mockImplementation(async (cmd: { __type: string }) => {
      if (cmd.__type === 'ListRegions') {
        return {
          Regions: [
            { RegionName: 'us-east-1', RegionOptStatus: 'ENABLED_BY_DEFAULT' },
            { RegionName: 'us-west-2', RegionOptStatus: 'ENABLED_BY_DEFAULT' },
            { RegionName: 'eu-central-1', RegionOptStatus: 'ENABLED' },
          ],
        };
      }
      throw new Error(`unexpected account command: ${cmd.__type}`);
    });

    const provider = new AwsQuotaProvider(creds);
    const enabled = await provider.getEnabledRegions();

    expect(enabled).toEqual(
      new Set(['us-east-1', 'us-west-2', 'eu-central-1']),
    );
  });

  it('passes the ENABLED + ENABLED_BY_DEFAULT filter to ListRegions', async () => {
    let captured: unknown;
    accountSend.mockImplementation(
      async (cmd: { __type: string; input: unknown }) => {
        if (cmd.__type === 'ListRegions') {
          captured = cmd.input;
          return { Regions: [] };
        }
        throw new Error(`unexpected account command: ${cmd.__type}`);
      },
    );

    const provider = new AwsQuotaProvider(creds);
    await provider.getEnabledRegions();

    expect(captured).toEqual({
      RegionOptStatusContains: ['ENABLED', 'ENABLED_BY_DEFAULT'],
    });
  });

  it('returns an empty set when AWS reports no regions', async () => {
    accountSend.mockImplementation(async (cmd: { __type: string }) => {
      if (cmd.__type === 'ListRegions') return {};
      throw new Error(`unexpected account command: ${cmd.__type}`);
    });

    const provider = new AwsQuotaProvider(creds);
    const enabled = await provider.getEnabledRegions();

    expect(enabled.size).toBe(0);
  });
});

describe('AwsQuotaProvider.getZeroQuotaRegions', () => {
  beforeEach(() => {
    quotasSend.mockReset();
    serviceQuotasRegions.length = 0;
  });

  it('returns regions where the vmType-family vCPU quota is 0', async () => {
    // g6e.* on-demand maps to L-DB2E81BA. Mock per-region values.
    const limits: Record<string, number> = {
      'us-east-1': 0,
      'us-west-2': 192,
      'eu-central-1': 0,
    };
    quotasSend.mockImplementation(
      async (cmd: { __type: string; input: { QuotaCode: string } }) => {
        if (cmd.__type === 'GetServiceQuota') {
          // ServiceQuotasClient is per-region, but the mock collapses them;
          // disambiguate by reading the mock's call order.
          const callIdx = quotasSend.mock.calls.length - 1;
          const region = ['us-east-1', 'us-west-2', 'eu-central-1'][callIdx];
          return { Quota: { Value: limits[region] } };
        }
        throw new Error(`unexpected quotas command: ${cmd.__type}`);
      },
    );

    const provider = new AwsQuotaProvider(creds);
    const result = await provider.getZeroQuotaRegions('g6e.48xlarge', false, [
      'us-east-1',
      'us-west-2',
      'eu-central-1',
    ]);

    expect(result).toEqual({
      zeroRegions: new Set(['us-east-1', 'eu-central-1']),
      unknownRegions: new Set(),
      complete: true,
    });
  });

  it('returns empty set when vmType has no quota-code mapping', async () => {
    // Hypothetical unmapped prefix would fall back to "Standard"; verify
    // that an explicit-null path (if quotaCodeFor ever returns null) is
    // safe. Use a real call and assert no quotasSend calls were made by
    // confirming the function short-circuits.
    quotasSend.mockImplementation(async () => {
      throw new Error('should not be called');
    });
    const provider = new AwsQuotaProvider(creds);
    // All known prefixes resolve to a code today, so this asserts the
    // empty-regions input case (no work to do).
    const result = await provider.getZeroQuotaRegions(
      'g6e.48xlarge',
      false,
      [],
    );
    expect(result).toEqual({
      zeroRegions: new Set(),
      unknownRegions: new Set(),
      complete: true,
    });
    expect(quotasSend).not.toHaveBeenCalled();
  });

  it('fails open for regional quota read errors without rejecting the whole sweep', async () => {
    const { log } = await import('../../../src/api/services/logger.js');
    const warnMock = vi.mocked(log.warn);
    const callsBefore = warnMock.mock.calls.length;
    const limits: Record<string, number> = {
      'us-east-1': 0,
      'us-west-2': 96,
    };

    quotasSend.mockImplementation(async (cmd: { __type: string }) => {
      if (cmd.__type === 'GetServiceQuota') {
        const callIdx = quotasSend.mock.calls.length - 1;
        const region = serviceQuotasRegions[callIdx];
        if (region === 'me-south-1') {
          throw new Error('Service Quotas endpoint timed out');
        }
        return { Quota: { Value: limits[region] ?? 5 } };
      }
      throw new Error(`unexpected quotas command: ${cmd.__type}`);
    });

    const provider = new AwsQuotaProvider(creds);
    const result = await provider.getZeroQuotaRegions('t3.large', true, [
      'us-east-1',
      'me-south-1',
      'us-west-2',
    ]);

    expect(result).toEqual({
      zeroRegions: new Set(['us-east-1']),
      unknownRegions: new Set(['me-south-1']),
      complete: false,
    });
    const warnings = warnMock.mock.calls
      .slice(callsBefore)
      .filter(
        (call) => call[0] === 'Failed to read AWS quotas for candidate regions',
      );
    expect(warnings).toHaveLength(1);
    expect(warnings[0][1]).toMatchObject({
      vmType: 't3.large',
      spot: true,
      failedRegions: 1,
      regions: 'me-south-1',
      error: 'Service Quotas endpoint timed out',
    });
  });

  it('times out a hung regional quota read and returns the other regions', async () => {
    vi.useFakeTimers();
    try {
      quotasSend.mockImplementation(async (cmd: { __type: string }) => {
        if (cmd.__type === 'GetServiceQuota') {
          const callIdx = quotasSend.mock.calls.length - 1;
          const region = serviceQuotasRegions[callIdx];
          if (region === 'me-south-1') return new Promise(() => {});
          return { Quota: { Value: region === 'us-east-1' ? 0 : 96 } };
        }
        throw new Error(`unexpected quotas command: ${cmd.__type}`);
      });

      const provider = new AwsQuotaProvider(creds);
      const zeroPromise = provider.getZeroQuotaRegions('t3.large', true, [
        'us-east-1',
        'me-south-1',
        'us-west-2',
      ]);

      await vi.advanceTimersByTimeAsync(
        AWS_CANDIDATE_PREFLIGHT_REGION_TIMEOUT_MS + 1,
      );
      await expect(zeroPromise).resolves.toEqual({
        zeroRegions: new Set(['us-east-1']),
        unknownRegions: new Set(['me-south-1']),
        complete: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('AwsQuotaProvider — history pagination', () => {
  beforeEach(() => {
    quotasSend.mockReset();
  });

  it('drains NextToken across pages when listing requests', async () => {
    let call = 0;
    quotasSend.mockImplementation(async (cmd: { __type: string }) => {
      if (cmd.__type === 'ListRequestedServiceQuotaChangeHistory') {
        call += 1;
        if (call === 1) {
          return {
            RequestedQuotas: [
              {
                QuotaCode: 'L-1',
                Status: 'PENDING',
                DesiredValue: 1,
                Id: 'p1',
                Created: new Date(),
              },
            ],
            NextToken: 'page2',
          };
        }
        return {
          RequestedQuotas: [
            {
              QuotaCode: 'L-2',
              Status: 'PENDING',
              DesiredValue: 2,
              Id: 'p2',
              Created: new Date(),
            },
          ],
        };
      }
      throw new Error(`unexpected quotas command: ${cmd.__type}`);
    });

    const provider = new AwsQuotaProvider(creds);
    const open = await provider.listOpenRequests(['us-east-1']);

    expect(open.map((o) => o.requestId)).toEqual(['p1', 'p2']);
    // The second page request carried the continuation token from the first.
    expect(quotasSend.mock.calls[1][0].input).toMatchObject({
      NextToken: 'page2',
    });
  });
});

import { getVCPUsForVMType } from '../cloud-config.js';
import { CloudType } from '../cloud.js';
import type {
  QuotaResource,
  QuotaResourceResolveOptions,
  QuotaTargetSpec,
} from './types.js';

export const AWS_QUOTA_CODES: Record<
  string,
  { onDemand: string; spot: string }
> = {
  G: { onDemand: 'L-DB2E81BA', spot: 'L-3819A6DF' },
  P: { onDemand: 'L-417A185B', spot: 'L-7212CCBC' },
  Trn: { onDemand: 'L-2C3B7624', spot: 'L-6B0D517C' },
  Inf: { onDemand: 'L-1945791B', spot: 'L-B5D1601B' },
  Standard: { onDemand: 'L-1216C47A', spot: 'L-34B43A08' },
};

/** The Service Quotas name of a family's spot or on-demand vCPU quota. */
export function awsQuotaNameFor(family: string, spot: boolean): string {
  return awsQuotaResourceName(family === 'G' ? 'G and VT' : family, spot);
}

export type AwsQuotaFamily = 'G and VT' | 'P' | 'Trn' | 'Inf' | 'Standard';

export function awsQuotaFamilyForVMType(vmType: string): AwsQuotaFamily {
  const prefix = vmType.split('.')[0]?.toLowerCase() ?? '';
  // "gr6"/"gr6f" are RAM-optimized G instances (NVIDIA L4); the optional "r"
  // keeps them in the "G and VT" quota instead of the catch-all Standard bucket.
  if (/^gr?\d/.test(prefix)) return 'G and VT';
  if (/^p\d/.test(prefix)) return 'P';
  if (prefix.startsWith('trn')) return 'Trn';
  if (prefix.startsWith('inf')) return 'Inf';
  return 'Standard';
}

function awsQuotaCodeFamilyForVMType(
  vmType: string,
): keyof typeof AWS_QUOTA_CODES {
  const family = awsQuotaFamilyForVMType(vmType);
  // 'G and VT' is the human family name; AWS_QUOTA_CODES keys it as 'G'. Every
  // other AwsQuotaFamily value is already a valid key, so no cast is needed.
  return family === 'G and VT' ? 'G' : family;
}

export function awsQuotaCodeForVMType(vmType: string, spot: boolean): string {
  const codes = AWS_QUOTA_CODES[awsQuotaCodeFamilyForVMType(vmType)];
  return spot ? codes.spot : codes.onDemand;
}

function awsQuotaCodeFamilyFromName(
  family: string,
): keyof typeof AWS_QUOTA_CODES | null {
  if (family === 'G' || family === 'G and VT') return 'G';
  if (family === 'P') return 'P';
  if (family === 'Trn') return 'Trn';
  if (family === 'Inf') return 'Inf';
  if (family === 'Standard') return 'Standard';
  return null;
}

function awsQuotaCodeForFamily(family: string, spot: boolean): string | null {
  const codeFamily = awsQuotaCodeFamilyFromName(family);
  if (!codeFamily) return null;
  const codes = AWS_QUOTA_CODES[codeFamily];
  return spot ? codes.spot : codes.onDemand;
}

export function awsQuotaResourceKey(quotaCode: string): string {
  return `aws:${quotaCode.toLowerCase()}`;
}

function awsQuotaResourceName(family: string, spot: boolean): string {
  return spot
    ? `All ${family} Spot Instance Requests`
    : `Running On-Demand ${family} instances`;
}

export function parseAwsResourceName(
  name: string,
): { family: string; spot: boolean } | null {
  const spotMatch = name.match(/^All (.+?) Spot Instance Requests$/);
  const onDemandMatch = name.match(/^Running On-Demand (.+?) instances$/);
  const match = spotMatch ?? onDemandMatch;
  if (!match) return null;
  return {
    family: match[1].replace(/^Standard \([^)]*\)$/, 'Standard'),
    spot: Boolean(spotMatch),
  };
}

export function awsQuotaResourceKeyFromName(name: string): string | null {
  const parsed = parseAwsResourceName(name);
  if (!parsed) return null;
  const quotaCode = awsQuotaCodeForFamily(parsed.family, parsed.spot);
  return quotaCode ? awsQuotaResourceKey(quotaCode) : null;
}

const AWS_SPOT_QUOTA_KEYS = new Set(
  Object.values(AWS_QUOTA_CODES).map((codes) =>
    awsQuotaResourceKey(codes.spot),
  ),
);

const AWS_ON_DEMAND_QUOTA_KEYS = new Set(
  Object.values(AWS_QUOTA_CODES).map((codes) =>
    awsQuotaResourceKey(codes.onDemand),
  ),
);

export function awsQuotaSpotFromResourceKey(
  resourceKey: string,
): boolean | undefined {
  const key = canonicalAwsQuotaResourceKey(resourceKey) ?? resourceKey;
  const lower = key.toLowerCase();
  if (AWS_SPOT_QUOTA_KEYS.has(lower)) return true;
  if (AWS_ON_DEMAND_QUOTA_KEYS.has(lower)) return false;
  return undefined;
}

export function awsQuotaSpotFromResourceName(
  resourceName: string,
): boolean | undefined {
  return parseAwsResourceName(resourceName)?.spot;
}

export function canonicalAwsQuotaResourceKey(key: string): string | null {
  const lower = key.toLowerCase();
  const providerIdMatch = lower.match(/^aws:(l-[a-z0-9]+)$/);
  if (providerIdMatch) return `aws:${providerIdMatch[1]}`;

  const legacy = lower.match(/^aws:(spot|on-demand):(.+)$/);
  if (!legacy) return null;
  const spot = legacy[1] === 'spot';
  const familyByKey: Record<string, string> = {
    gandvt: 'G and VT',
    p: 'P',
    trn: 'Trn',
    inf: 'Inf',
    standard: 'Standard',
  };
  const family = familyByKey[legacy[2]];
  if (!family) return null;
  const quotaCode = awsQuotaCodeForFamily(family, spot);
  return quotaCode ? awsQuotaResourceKey(quotaCode) : null;
}

export function resolveAwsQuotaResources(
  input: QuotaTargetSpec,
  _options: QuotaResourceResolveOptions = {},
): QuotaResource[] {
  const family = awsQuotaFamilyForVMType(input.vmType);
  const quotaCode = awsQuotaCodeForVMType(input.vmType, input.spot);
  return [
    {
      key: awsQuotaResourceKey(quotaCode),
      providerId: quotaCode,
      name: awsQuotaResourceName(family, input.spot),
      kind: 'vm-family',
      unit: 'vcpus',
      required: getVCPUsForVMType(input.vmType, CloudType.AWS),
    },
  ];
}

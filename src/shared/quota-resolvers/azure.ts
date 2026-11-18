import { readCatalog } from '../catalog/index.js';
import {
  AZURE_FAMILY_TO_GPU,
  normalizeAzureFamilyName,
} from '../catalog/azure-gpu-map.js';
import { getVCPUsForVMType } from '../cloud-config.js';
import { CloudType } from '../cloud.js';
import type {
  QuotaResource,
  QuotaResourceResolveOptions,
  QuotaTargetSpec,
} from './types.js';
import { normalizeResourceKeyPart } from './util.js';
import {
  AZURE_QUOTA_RESOURCE_KEYS,
  azureQuotaResourceKey,
  canonicalAzureQuotaResourceKey,
  type AzureQuotaResourceKey,
} from './azure-identity.js';

// Real Azure family provider IDs keep separators ("standardncasv3_t4family")
// that normalizeResourceKeyPart flattens. Map the flattened form back to the
// canonical family so a key derived from a display name agrees with the key
// derived from the VM type.
const FAMILY_BY_FLATTENED_KEY: Record<string, string> = Object.fromEntries(
  Object.keys(AZURE_FAMILY_TO_GPU).map((family) => [
    normalizeResourceKeyPart(family),
    family,
  ]),
);

/**
 * Special-case rules for Azure families the generic digit-stripping parser
 * below gets wrong: Azure reorders the generation token, the accelerator token,
 * and size modifiers ("r"/"a"/"m") differently per family. Each rule maps a VM
 * name straight to its real quota provider ID. These only run when the catalog
 * lacks a QuotaGroup for the type (catalog/live-SKU data is always preferred).
 *
 * Families whose name omits a token the family needs (e.g. Standard_ND96asr_v4
 * -> "standardndasv4_a100family", which has no A100 token in the name) cannot be
 * reconstructed from the name at all and depend on the catalog QuotaGroup column
 * — they are intentionally absent here. The catalog-backed tests assert these
 * parser gaps have QuotaGroup coverage.
 */
const FAMILY_NAME_RULES: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
  // NCas T4: "as_t4" -> "asv<g>_t4" (generation before the accelerator).
  [/^standard_nc\d+as_t4_v(\d+)$/, (m) => `standardncasv${m[1]}_t4family`],
  // NDamsr A100: "amsr_a100" -> "amsv<g>_a100".
  [
    /^standard_nd\d+amsr_a100_v(\d+)$/,
    (m) => `standardndamsv${m[1]}_a100family`,
  ],
  // NDisr H100: "isr_h100" -> "sh100v<g>" (drops "ir", keeps trailing v<g>).
  [/^standard_nd\d+isr_h100_v(\d+)$/, (m) => `standardndsh100v${m[1]}family`],
  // NDisr MI300X: generation v<g> moves BEFORE the accelerator, "isr" -> "is".
  [
    /^standard_nd\d+isr?_mi300x_v(\d+)$/,
    (m) => `standardndisv${m[1]}mi300xfamily`,
  ],
  // Bare NV "<n>as_v<g>" collapses to the standardnvsv<g> (MI25) family.
  [/^standard_nv\d+as_v(\d+)$/, (m) => `standardnvsv${m[1]}family`],
  // NV "adms" A10 shares the standardnvadsa10v<g> quota family.
  [/^standard_nv\d+adms_a10_v(\d+)$/, (m) => `standardnvadsa10v${m[1]}family`],
  // Bare NC "<n>rs_v<g>" collapses to standardncsv<g> (V100).
  [/^standard_nc\d+rs_v(\d+)$/, (m) => `standardncsv${m[1]}family`],
  // Bare ND "<n>rs_v<g>" collapses to standardndsv<g> (V100-32GB).
  [/^standard_nd\d+rs_v(\d+)$/, (m) => `standardndsv${m[1]}family`],
];

/**
 * Map an Azure VM type (e.g. "Standard_NC40ads_H100_v5") to the family
 * portion of its canonical resource key. This is a catalog-compatibility
 * helper, not an exact Azure provider name and must not be used for writes.
 *
 * @deprecated Prefer getAzureQuotaResourceKeyForVMType.
 */
export function getAzureQuotaGroupForVMType(vmType: string): string {
  return getAzureQuotaResourceKeyForVMType(vmType).slice('azure:'.length);
}

/**
 * Resolve a planned VM type to AnyCloud's canonical Azure quota identity.
 * Catalog Resource-SKU data wins; the name parser remains an offline fallback.
 */
export function getAzureQuotaResourceKeyForVMType(
  vmType: string,
): AzureQuotaResourceKey {
  try {
    const catalogFamily = readCatalog(CloudType.Azure)?.quotaGroupPerType[
      vmType.toLowerCase()
    ];
    if (catalogFamily) {
      return (
        canonicalAzureQuotaResourceKey(catalogFamily) ??
        azureQuotaResourceKey(catalogFamily)
      );
    }
  } catch {
    // Keep the parser usable if the local catalog is absent/corrupt.
  }

  const normalized = vmType.toLowerCase();
  for (const [re, fmt] of FAMILY_NAME_RULES) {
    const m = normalized.match(re);
    if (m) return azureQuotaResourceKey(fmt(m));
  }

  const parts = normalized.split('_');
  if (parts.length >= 2) {
    parts[1] = parts[1].replace(/\d+/g, '');
  }
  return azureQuotaResourceKey(
    normalizeAzureFamilyName(parts.join('') + 'family'),
  );
}

function azureFamilyResourceName(vmType: string): string {
  const parts = vmType.split('_');
  if (parts.length >= 2 && parts[0].toLowerCase() === 'standard') {
    const familyParts = [parts[0], parts[1].replace(/\d+/g, '')].concat(
      parts.slice(2),
    );
    return `${familyParts.join(' ')} Family vCPUs`;
  }
  return `${getAzureQuotaGroupForVMType(vmType)} Family vCPUs`;
}

export function azureQuotaResourceKeyFromName(
  resourceName: string,
): AzureQuotaResourceKey {
  const lower = resourceName.toLowerCase();
  if (lower === 'total regional low-priority vcpus') {
    return azureQuotaResourceKey('lowprioritycores');
  }
  if (lower === 'total regional vcpus') return azureQuotaResourceKey('cores');
  const normalized = normalizeResourceKeyPart(resourceName).replace(
    /vcpus$/,
    '',
  );
  // Azure's real localizedValue (e.g. "Standard NCASv3 T4 Family vCPUs")
  // flattens to a separator-less form; restore the canonical underscore-bearing
  // family so this key matches the one resolveAzureQuotaResources assigns.
  const knownFamily = FAMILY_BY_FLATTENED_KEY[normalized];
  if (knownFamily) return azureQuotaResourceKey(knownFamily);

  if (normalized.startsWith('standard') && normalized.endsWith('family')) {
    return azureQuotaResourceKey(normalized);
  }

  // Azure support tickets store the series name without the leading "Standard"
  // or trailing "Family vCPUs"; map that back to the compute quota family key.
  return azureQuotaResourceKey(`standard${normalized}family`);
}

export function azureQuotaSpotFromResourceKey(
  resourceKey: string,
): boolean | undefined {
  const canonical = canonicalAzureQuotaResourceKey(resourceKey);
  if (canonical === AZURE_QUOTA_RESOURCE_KEYS.lowPriorityCores) return true;
  if (canonical === AZURE_QUOTA_RESOURCE_KEYS.cores) return false;
  // VM-family vCPU quotas gate only on-demand launches — spot draws from the
  // regional low-priority pool — so family rows always belong to the
  // on-demand view, even when a request was historically filed for a spot
  // target. Public-IP quota applies to both pricing models, so those keys
  // stay undefined — including keyless historical rows whose display name
  // was family-wrapped by the ticket-series fallback in
  // azureQuotaResourceKeyFromName (e.g.
  // azure:standardpublicipaddressesstandardfamily); no real VM family
  // contains "publicip".
  if (
    canonical !== null &&
    !canonical.includes('publicip') &&
    /^azure:standard.*family$/.test(canonical)
  ) {
    return false;
  }
  return undefined;
}

export function azureQuotaSpotFromResourceName(
  resourceName: string,
): boolean | undefined {
  const lower = resourceName.toLowerCase();
  if (
    lower === 'total regional low-priority vcpus' ||
    lower === 'low priority cores' ||
    lower === 'low-priority cores'
  ) {
    return true;
  }
  if (lower === 'total regional vcpus') return false;
  return undefined;
}

export function resolveAzureQuotaResources(
  input: QuotaTargetSpec,
  options: QuotaResourceResolveOptions = {},
): QuotaResource[] {
  const requiredVCPUs = getVCPUsForVMType(input.vmType, CloudType.Azure);
  const familyResourceKey = options.resourceKey
    ? canonicalAzureQuotaResourceKey(options.resourceKey)
    : getAzureQuotaResourceKeyForVMType(input.vmType);
  if (!familyResourceKey) {
    throw new Error(`Invalid Azure quota resource key: ${options.resourceKey}`);
  }
  const aggregateResourceName = input.spot
    ? 'Total Regional Low-priority vCPUs'
    : 'Total Regional vCPUs';
  const resources: QuotaResource[] = [];
  // Spot draws from a separate quota pool gated only by the regional
  // low-priority vCPU quota; the VM-family quota never applies to it.
  if (!input.spot) {
    resources.push({
      key: familyResourceKey,
      name: azureFamilyResourceName(input.vmType),
      kind: 'vm-family',
      unit: 'vcpus',
      required: requiredVCPUs,
    });
  }
  resources.push({
    key: input.spot
      ? AZURE_QUOTA_RESOURCE_KEYS.lowPriorityCores
      : AZURE_QUOTA_RESOURCE_KEYS.cores,
    name: aggregateResourceName,
    kind: 'regional-aggregate',
    unit: 'vcpus',
    required: requiredVCPUs,
  });
  if (input.includePublicIpQuota) {
    resources.push({
      key: AZURE_QUOTA_RESOURCE_KEYS.standardSkuPublicIpAddresses,
      name: 'Public IP Addresses - Standard',
      kind: 'network',
      unit: 'count',
      required: 1,
    });
  }
  return resources;
}

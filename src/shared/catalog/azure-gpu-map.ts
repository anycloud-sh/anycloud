/**
 * Azure VM family → GPU model name mapping.
 * The `family` field comes from the Resource SKUs API.
 * Keys are normalized (lowercased, spaces stripped) — lookup does the same.
 * Source: Azure Resource SKUs API family names.
 */
export function normalizeAzureFamilyName(family: string): string {
  return family.replace(/\s+/g, '').toLowerCase();
}

/** Normalize Azure location display names (for example, "East US") to IDs. */
export function normalizeAzureRegionName(region: string): string {
  return region.replace(/\s+/g, '').toLowerCase();
}

export const AZURE_FAMILY_TO_GPU: Record<string, string> = {
  standardncfamily: 'K80',
  standardncsv2family: 'P100',
  standardncsv3family: 'V100',
  standardncpromofamily: 'K80',
  standardncasv3_t4family: 'T4',
  standardncadsa10v4family: 'A10',
  standardndsv2family: 'V100-32GB',
  standardncadsa100v4family: 'A100-80GB',
  standardndamsv4_a100family: 'A100-80GB',
  standardndasv4_a100family: 'A100',
  standardnvfamily: 'M60',
  standardnvsv2family: 'M60',
  standardnvsv3family: 'M60',
  standardnvpromofamily: 'M60',
  standardnvsv4family: 'MI25',
  standardndsfamily: 'P40',
  // NP-series are Xilinx FPGAs, not GPUs — exclude from accelerator index
  // standardnpsfamily: excluded
  standardnvadsa10v5family: 'A10',
  standardncadsh100v5family: 'H100',
  standardnccads2023family: 'H100',
  standardndsh100v5family: 'H100',
  standardndisrh200v5family: 'H200',
  standardndisv5mi300xfamily: 'MI300X',
};

/**
 * VM families excluded from the catalog.
 *
 * `standardnvsv2family` (M60) was already retired as no-longer-available.
 *
 * The rest are pre-Turing GPUs (Kepler K80, Pascal P100/P40, Maxwell M60) that
 * anycloud can't reliably boot: the default Azure GPU base images are dstack's
 * community-gallery images, and dstack's Azure allowlist offers only V100 among
 * pre-Turing GPUs — it never validates its proprietary-module image
 * (dstack-cuda-0.10) on K80/P100/P40/M60. Rather than point them at an
 * unvalidated image, drop them (they're low-demand pre-Turing rarities). V100
 * (NCv3 `standardncsv3family` + NDv2 `standardndsv2family`) is kept and routes to
 * dstack-cuda-0.10. Already-running workloads are unaffected — this only gates
 * the catalog for new launches.
 */
export const DEPRECATED_FAMILIES = new Set([
  'standardnvsv2family', // M60 (no longer available)
  // Pre-Turing GPUs dstack doesn't support on Azure (open kernel modules can't
  // load on them, and dstack-cuda-0.10 is unvalidated there):
  'standardncfamily', // K80 (Kepler)
  'standardncpromofamily', // K80 (Kepler)
  'standardncsv2family', // P100 (Pascal)
  'standardndsfamily', // P40 (Pascal)
  'standardnvfamily', // M60 (Maxwell)
  'standardnvsv3family', // M60 (Maxwell)
  'standardnvpromofamily', // M60 (Maxwell)
]);

/**
 * Azure regions where all three dstack GPU image definitions below are
 * replicated. A read-only Community Gallery probe confirmed that the legacy
 * cuda-0.10 definition exactly matches the existing cuda/grid region set.
 * GPU (SKU, region) catalog entries outside this set are dropped because
 * scheduling there would fail with a gallery NotFound.
 */
export const AZURE_GPU_COMMUNITY_IMAGE_REGIONS = new Set([
  'australiaeast',
  'brazilsouth',
  'canadacentral',
  'centralindia',
  'centralus',
  'eastasia',
  'eastus',
  'eastus2',
  'francecentral',
  'germanywestcentral',
  'japaneast',
  'koreacentral',
  'northeurope',
  'norwayeast',
  'qatarcentral',
  'southafricanorth',
  'southcentralus',
  'southeastasia',
  'swedencentral',
  'switzerlandnorth',
  'uaenorth',
  'uksouth',
  'westeurope',
  'westus2',
  'westus3',
]);

/**
 * The public dstack community-gallery GPU base images anycloud defaults to for
 * Azure GPU deploys. Unlike the old NGC / A10-VMI marketplace images, these boot
 * final (no first-boot self-upgrade + reboot that SIGKILLed workloads mid-run).
 *
 * `dstack-cuda-0.14` uses NVIDIA OPEN kernel modules (Turing and newer only);
 * `dstack-cuda-0.10` is dstack's proprietary-modules image for Volta-and-older
 * datacenter GPUs (V100). 0.10 is a permanent, non-versioned pin in dstack
 * (consts.py DSTACK_OS_IMAGE_WITH_PROPRIETARY_NVIDIA_KERNEL_MODULES = "0.10"), so
 * — unlike 0.14 — it is never bumped and its drift is not tracked.
 */
const DSTACK_COMMUNITY_GALLERY =
  '/CommunityGalleries/dstack-ebac134d-04b9-4c2b-8b6c-ad3e73904aa7/Images';
export const AZURE_CUDA_COMMUNITY_IMAGE_ID = `${DSTACK_COMMUNITY_GALLERY}/dstack-cuda-0.14`;
export const AZURE_CUDA_PROPRIETARY_COMMUNITY_IMAGE_ID = `${DSTACK_COMMUNITY_GALLERY}/dstack-cuda-0.10`;
export const AZURE_GRID_COMMUNITY_IMAGE_ID = `${DSTACK_COMMUNITY_GALLERY}/dstack-grid-0.14`;

/**
 * NVIDIA GPU models that require proprietary kernel modules (they predate Turing,
 * so the open kernel modules in dstack-cuda-0.14 can't drive them). Mirrors
 * dstack's NVIDIA_GPUS_REQUIRING_PROPRIETARY_KERNEL_MODULES
 * (backends/base/compute.py), plus `v100-32gb` — anycloud's catalog labels the
 * NDv2 V100 SKU `V100-32GB` where dstack normalizes to `v100`. Of these, only
 * V100 SKUs remain in the catalog (K80/P100/P40/M60 are in DEPRECATED_FAMILIES);
 * the rest are kept for provenance and to stay correct if a family is un-retired.
 */
const NVIDIA_GPUS_REQUIRING_PROPRIETARY_MODULES = new Set([
  'v100',
  'v100-32gb',
  'p100',
  'p40',
  'p4',
  'm60',
  'm40',
  'm4',
  'k80',
  'k40',
  'k20',
]);

export function requiresProprietaryNvidiaModules(
  acceleratorName: string,
): boolean {
  return NVIDIA_GPUS_REQUIRING_PROPRIETARY_MODULES.has(
    acceleratorName.trim().toLowerCase(),
  );
}

/**
 * Pick the dstack community-gallery image id for an NVIDIA GPU deploy, or `null`
 * when the GPU model can't be determined for an NC/ND CUDA target (so the caller
 * fails clearly rather than booting a possibly-incompatible image):
 *   - NV-series (vGPU) → GRID image (accelerator name irrelevant; A10 lives in
 *     both an NC and an NV family, so the model can't split GRID vs CUDA).
 *   - NC/ND with no resolvable accelerator name → null.
 *   - NC/ND with a pre-Turing accelerator (V100) → proprietary-modules 0.10.
 *   - NC/ND, Turing or newer → CUDA 0.14.
 */
export function selectAzureGpuImageId(
  vmType: string,
  acceleratorName: string | null | undefined,
): string | null {
  if (/^Standard_NV/i.test(vmType)) return AZURE_GRID_COMMUNITY_IMAGE_ID;
  if (!acceleratorName?.trim()) return null;
  return requiresProprietaryNvidiaModules(acceleratorName)
    ? AZURE_CUDA_PROPRIETARY_COMMUNITY_IMAGE_ID
    : AZURE_CUDA_COMMUNITY_IMAGE_ID;
}

/**
 * Fractional A10 instances — Azure reports 1 GPU but the actual allocation
 * is a fraction of an A10. We override the GPU count here.
 * Ref: https://learn.microsoft.com/en-us/azure/virtual-machines/nva10v5-series
 */
export const FRACTIONAL_A10_GPU_COUNTS: Record<string, number> = {
  Standard_NV6ads_A10_v5: 0.167,
  Standard_NV12ads_A10_v5: 0.333,
  Standard_NV18ads_A10_v5: 0.5,
};

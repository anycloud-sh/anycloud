/**
 * Optimizer — resolves a VM Job's provisioning target. The VM-Job-only rules
 * (the pinned fast path, region reuse, docker-option, image-runtime, premium
 * storage and accelerator filters, and the Queued/Invalid mapping) live here;
 * candidates, preflight, denial filtering and the picker are shared with node
 * pools in launch-targets.ts.
 */

import {
  type ProvisioningConfig,
  type StoredWorkload,
} from './workload-record.js';
import { CloudType, type CloudConfig } from '../../shared/cloud.js';
import { WorkloadState } from '../../shared/workload.js';
import { ImageRuntime } from '../../shared/image.js';
import { toArray } from '../../shared/utils.js';
import {
  getRegionsForVMType,
  getZonesForVMType,
  gpuRuntimeForVMType,
  resolveVMTypes,
  diskTierRequiresPremiumStorage,
  isImageRuntimeCompatible,
  nestedVirtualizationSupport,
} from '../../shared/cloud-config.js';
import { getPremiumStorageCapable } from '../../shared/catalog/queries.js';
import {
  refreshCatalog as refreshPublishedCatalog,
  type CatalogRefreshOptions,
} from '../../shared/catalog/index.js';
import { type CloudCompute } from './gateways/cloud.js';
import { log } from './logger.js';
import {
  buildTargetCandidates,
  pickTarget,
  untriedTargetCount,
  preflightTargetCandidates,
  withoutDeniedRegions,
} from './launch-targets.js';
import type { DbVM } from './entities.js';
import type { ProvisioningFailure } from './provisioning-failure.js';
import {
  acceleratorRuntimeRejectionMessage,
  usesAvailabilityZoneTargets,
} from '../../shared/providers.js';
import { validateDockerOptionsForResolvedTarget } from '../../shared/docker-options.js';
import { InvalidAnycloudConfigError } from '../../shared/errors.js';
import { errorMessage } from '../../shared/log-diagnostics.js';

export interface ProvisioningTargetStore {
  getVMs(workloadId: string): Promise<DbVM[]>;
  getLatestProvisioningConfig(
    workloadId: string,
  ): Promise<ProvisioningConfig | null>;
  getProvisioningFailures(
    workloadId: string,
    credentialId: string | null,
    cloud: CloudType,
  ): Promise<ProvisioningFailure[]>;
}

export interface ProvisioningResolutionOptions {
  signal?: AbortSignal;
  deadlineAt?: number;
  /** Test seam for the one forced refresh used by explicit GCP pins. */
  refreshCatalog?: (
    cloud: CloudType,
    options?: CatalogRefreshOptions,
  ) => Promise<void>;
}

async function refreshExplicitPlacementCatalog(
  cloud: CloudType,
  options: ProvisioningResolutionOptions,
): Promise<string | null> {
  try {
    await (options.refreshCatalog ?? refreshPublishedCatalog)(cloud, {
      signal: options.signal,
      deadlineAt: options.deadlineAt,
    });
    return null;
  } catch (error) {
    if (
      options.signal?.aborted ||
      (error instanceof Error &&
        (error.name === 'AbortError' || error.name === 'TimeoutError'))
    ) {
      throw error;
    }
    return `Could not refresh the ${cloud} catalog to validate the explicit placement: ${errorMessage(error)}. Waiting to retry.`;
  }
}

type ConstrainedImageRuntime = ImageRuntime.Cuda | ImageRuntime.Rocm;

function isConstrainedImageRuntime(
  imageRuntime: StoredWorkload['imageRuntime'],
): imageRuntime is ConstrainedImageRuntime {
  return (
    imageRuntime === ImageRuntime.Cuda || imageRuntime === ImageRuntime.Rocm
  );
}

/**
 * Return a terminal runtime rejection only when every requested VM fallback is
 * rejected by the provider. A mixed list must stay eligible so another type can
 * still resolve from the catalog and provision.
 */
function acceleratorRuntimeRejectionForAllVMTypes(
  cloudProvider: CloudType,
  vmTypes: readonly string[],
): string | null {
  if (vmTypes.length === 0) return null;

  const rejections = new Set<string>();
  for (const vmType of vmTypes) {
    const rejection = acceleratorRuntimeRejectionMessage(
      cloudProvider,
      gpuRuntimeForVMType(cloudProvider, vmType),
    );
    if (!rejection) return null;
    rejections.add(rejection);
  }
  return [...rejections].join(' ');
}

function imageRuntimeIncompatibilityMessage(
  imageRuntime: ConstrainedImageRuntime,
  vmTypes: string[],
  cloudProvider: CloudType,
): string {
  return `Image requires a ${imageRuntime.toUpperCase()} GPU runtime but no compatible accelerator is available for VM type "${vmTypes.join(
    ', ',
  )}" on ${cloudProvider}`;
}

function premiumStorageIncompatibilityMessage(
  vmTypes: string[],
  cloudProvider: CloudType,
): string {
  return `--disk-tier high/ultra needs the Premium disk that VM type "${vmTypes.join(
    ', ',
  )}" on ${cloudProvider} does not support. Use a Premium-capable VM size or a lower disk tier.`;
}

function dockerOptionsTargetRejection(
  workload: StoredWorkload,
  cloudProvider: CloudType,
  vmType: string,
): string | null {
  try {
    validateDockerOptionsForResolvedTarget(workload.dockerOptions, {
      cloudProvider,
      vmType,
    });
    return null;
  } catch (error) {
    if (error instanceof InvalidAnycloudConfigError) return error.message;
    throw error;
  }
}

export type ProvisioningResolution =
  | {
      state: WorkloadState.Provisioning;
      config: CloudConfig;
      credentialId?: string;
      eligibleRegions?: string[];
      /** Candidates no prior failure applies to, besides the picked one. */
      untriedTargets?: number;
    }
  | {
      state: WorkloadState.Queued | WorkloadState.Invalid;
      message: string;
    };

/**
 * Resolve the (vmType, region) target for a workload whose credentials and
 * gpuType→vmType are already resolved (see resolveProvisioningConfig). Expands
 * the catalog into a candidate pool, centrally applies account availability
 * assessments from the gateway (if any), and uses only this
 * workload's failure history to rotate retries. Mutates and returns the
 * passed cloudConfig with vmType/region/availabilityZone filled.
 */
export async function resolveProvisioningTarget(
  workload: StoredWorkload,
  cloudConfig: CloudConfig,
  store: ProvisioningTargetStore,
  makeGateway: (
    vmType: string,
    region: string,
    availabilityZone?: string,
  ) => CloudCompute,
  credentialId: string | null = workload.credentialId,
  options: ProvisioningResolutionOptions = {},
): Promise<ProvisioningResolution> {
  // Array inputs AND GPU aliases go through pickTarget: an alias must expand to
  // its full interchangeable SKU family (e.g. Lambda's H100 pcie + sxm5) so the
  // scheduler can rotate to a sibling after the cheapest one fails,
  // and unresolvable list entries get filtered out. A directly-pinned scalar
  // vmType (no gpuType) keeps the fast path below: region is pinned (or reusable
  // from a prior attempt's VMs) and there is a single type to try, so we trust
  // the user.
  const targetsAvailabilityZones = usesAvailabilityZoneTargets(
    cloudConfig.cloudProvider,
  );
  const needsZoneExpansion =
    targetsAvailabilityZones && !workload.availabilityZone;
  // A region allow-list is expanded like an unpinned Job, then filtered.
  const allowedRegions = workload.regions?.length
    ? new Set(workload.regions)
    : null;
  const needsCandidateExpansion =
    Array.isArray(workload.vmType) ||
    workload.gpuType !== null ||
    needsZoneExpansion ||
    allowedRegions !== null;

  // Region resolution (only when user omitted region)
  if (workload.region && !needsCandidateExpansion) {
    // The pinned scalar fast-path otherwise skips catalog validation entirely,
    // so a typo'd VM type ("totally_fake_…") would only be rejected after slow
    // cloud provisioning (and on Azure could hang there). Fail fast when the
    // catalog knows this type in NO region at all — a genuine user error.
    // We do NOT downgrade a *known* type pinned to an uncatalogued region: the
    // catalog may be incomplete, so we still trust the pinned region there.
    // Catalog-less clouds (e.g. Lambda) return their default region, so they
    // never trip this; if the catalog isn't loaded getRegionsForVMType throws,
    // and we fall through to provisioning (unchanged behavior).
    if (typeof cloudConfig.vmType === 'string') {
      let knownRegions: string[] | undefined;
      try {
        knownRegions = getRegionsForVMType(
          cloudConfig.vmType,
          cloudConfig.cloudProvider,
          cloudConfig.spot,
        );
      } catch {
        knownRegions = undefined; // catalog unavailable — don't block
      }
      if (targetsAvailabilityZones && workload.availabilityZone) {
        let compatibleZones: string[] | undefined;
        try {
          compatibleZones = getZonesForVMType(
            workload.region,
            cloudConfig.vmType,
          );
        } catch {
          compatibleZones = undefined;
        }
        if (!compatibleZones?.includes(workload.availabilityZone)) {
          const refreshError = await refreshExplicitPlacementCatalog(
            cloudConfig.cloudProvider,
            options,
          );
          if (refreshError) {
            return { state: WorkloadState.Queued, message: refreshError };
          }
          let refreshedZones: string[];
          try {
            refreshedZones = getZonesForVMType(
              workload.region,
              cloudConfig.vmType,
            );
          } catch (error) {
            return {
              state: WorkloadState.Queued,
              message: `Could not read the refreshed ${cloudConfig.cloudProvider} catalog to validate the explicit placement: ${errorMessage(error)}. Waiting to retry.`,
            };
          }
          if (!refreshedZones.includes(workload.availabilityZone)) {
            return {
              state: WorkloadState.Invalid,
              message: `GCP zone "${workload.region}-${workload.availabilityZone}" does not offer VM type "${cloudConfig.vmType}". Compatible zones after catalog refresh: ${refreshedZones.join(', ') || 'none'}`,
            };
          }
        }
        cloudConfig.availabilityZone = workload.availabilityZone;
      } else if (knownRegions && knownRegions.length === 0) {
        // The catalog may trail a provider capability's family recognition.
        // Prefer the existing unsupported-runtime result over misreporting a
        // recognized accelerator as a typo. Explicit GCP placements take the
        // refresh path above before this terminal decision.
        const runtimeRejection = acceleratorRuntimeRejectionForAllVMTypes(
          cloudConfig.cloudProvider,
          [cloudConfig.vmType],
        );
        return {
          state: WorkloadState.Invalid,
          message:
            runtimeRejection ??
            `VM type "${cloudConfig.vmType}" is not offered on ${cloudConfig.cloudProvider} — check the name`,
        };
      }
      const dockerOptionsRejection = dockerOptionsTargetRejection(
        workload,
        cloudConfig.cloudProvider,
        cloudConfig.vmType,
      );
      if (dockerOptionsRejection) {
        return {
          state: WorkloadState.Invalid,
          message: dockerOptionsRejection,
        };
      }
      const imageRuntime = workload.imageRuntime;
      if (
        isConstrainedImageRuntime(imageRuntime) &&
        !isImageRuntimeCompatible(
          cloudConfig.cloudProvider,
          cloudConfig.vmType,
          imageRuntime,
        )
      ) {
        return {
          state: WorkloadState.Invalid,
          message: imageRuntimeIncompatibilityMessage(
            imageRuntime,
            [cloudConfig.vmType],
            cloudConfig.cloudProvider,
          ),
        };
      }
    }
    return { state: WorkloadState.Provisioning, config: cloudConfig };
  }

  // Reuse region from existing VMs (previous attempt left orphans)
  let reusedRegion: string | undefined;
  const existingVMs = await store.getVMs(workload.id);
  if (existingVMs.length > 0) {
    const latest = await store.getLatestProvisioningConfig(workload.id);
    if (latest?.region) {
      reusedRegion = latest.region;
      log.info('Reusing region from existing VMs', {
        id: workload.id,
        region: reusedRegion,
      });
    }
  }
  if (reusedRegion && !needsCandidateExpansion) {
    cloudConfig.region = reusedRegion;
    if (typeof cloudConfig.vmType === 'string') {
      const dockerOptionsRejection = dockerOptionsTargetRejection(
        workload,
        cloudConfig.cloudProvider,
        cloudConfig.vmType,
      );
      if (dockerOptionsRejection) {
        return {
          state: WorkloadState.Invalid,
          message: dockerOptionsRejection,
        };
      }
    }
    const imageRuntime = workload.imageRuntime;
    if (
      typeof cloudConfig.vmType === 'string' &&
      isConstrainedImageRuntime(imageRuntime) &&
      !isImageRuntimeCompatible(
        cloudConfig.cloudProvider,
        cloudConfig.vmType,
        imageRuntime,
      )
    ) {
      return {
        state: WorkloadState.Invalid,
        message: imageRuntimeIncompatibilityMessage(
          imageRuntime,
          [cloudConfig.vmType],
          cloudConfig.cloudProvider,
        ),
      };
    }
    return { state: WorkloadState.Provisioning, config: cloudConfig };
  }

  // No active VMs (or array input) — pick best target (vmType, region) from
  // catalog. When gpuType is set, expand each entry to all interchangeable
  // instance types. When the user supplied a vmType list directly, use that
  // order. Either way, retry history rotates away from a failed primary.
  const gpuList = toArray(workload.gpuType);
  const expanded =
    gpuList.length > 0
      ? gpuList.flatMap((g) => resolveVMTypes(g, cloudConfig.cloudProvider))
      : toArray(workload.vmType);
  // Dedupe while preserving order.
  const vmTypes = Array.from(new Set(expanded));

  // If region is pinned (or reused from an earlier attempt), constrain
  // candidates to that single region while still validating each vmType
  // against the catalog.
  const pinnedRegion = workload.region ?? reusedRegion;
  const buildCandidates = () =>
    buildTargetCandidates(
      cloudConfig.cloudProvider,
      vmTypes,
      cloudConfig.spot,
      {
        region: pinnedRegion,
        availabilityZone: workload.availabilityZone,
      },
    ).filter(
      // A nested VM Job launches only where the catalog
      // reports support; unknown counts as none.
      (candidate) =>
        (!allowedRegions || allowedRegions.has(candidate.region)) &&
        (!workload.requireNestedVirtualization ||
          nestedVirtualizationSupport(
            cloudConfig.cloudProvider,
            candidate.vmType,
            candidate.region,
            candidate.availabilityZone,
          ) === true),
    );
  let candidates = buildCandidates();

  // A pinned GCP placement can be absent only because the pin is incompatible
  // or the local catalog is stale. Refresh exactly once before deciding. An
  // Automatic region-unpinned placement never launches into an arbitrary
  // zone; its empty set remains Queued below for the scheduled refresh path.
  if (
    candidates.length === 0 &&
    targetsAvailabilityZones &&
    (pinnedRegion || allowedRegions)
  ) {
    const refreshError = await refreshExplicitPlacementCatalog(
      cloudConfig.cloudProvider,
      options,
    );
    if (refreshError) {
      return { state: WorkloadState.Queued, message: refreshError };
    }
    candidates = buildCandidates();
  }

  // Docker GPU/runtime options constrain the concrete host just like an image
  // runtime does. Remove incompatible siblings while preserving a valid
  // fallback, and fail terminally only when this request eliminates the whole
  // otherwise-valid candidate pool.
  if (workload.dockerOptions) {
    const hadCandidates = candidates.length > 0;
    const rejections = new Set<string>();
    candidates = candidates.filter((candidate) => {
      const rejection = dockerOptionsTargetRejection(
        workload,
        cloudConfig.cloudProvider,
        candidate.vmType,
      );
      if (rejection) rejections.add(rejection);
      return rejection === null;
    });
    if (hadCandidates && candidates.length === 0) {
      return {
        state: WorkloadState.Invalid,
        message:
          [...rejections][0] ??
          'Docker runtime options are incompatible with every requested VM type.',
      };
    }
  }

  // Image-runtime compatibility guard. The persisted imageRuntime is the GPU
  // runtime the image's base layer expects (detected from its config blob at
  // submit). Drop candidates whose RESOLVED accelerator can't run it, keying off
  // the candidate vmType via gpuRuntimeForVMType (the resolved truth) — never the
  // requested gpuType/fallback head. 'unknown'/null images skip the filter
  // entirely (conservative keep-all: this is a guardrail, not a scheduler). This
  // runs BEFORE the gateway probe below, so an incompatible image short-circuits
  // without any cloud call.
  const imageRuntime = workload.imageRuntime;
  if (isConstrainedImageRuntime(imageRuntime)) {
    const hadCandidates = candidates.length > 0;
    candidates = candidates.filter((c) =>
      isImageRuntimeCompatible(
        cloudConfig.cloudProvider,
        c.vmType,
        imageRuntime,
      ),
    );
    // Distinct TERMINAL Invalid (not the catalog-stale Queued below): the pool was
    // otherwise valid and was emptied solely by image/accelerator incompatibility,
    // which no catalog refresh will fix.
    if (hadCandidates && candidates.length === 0) {
      return {
        state: WorkloadState.Invalid,
        message: imageRuntimeIncompatibilityMessage(
          imageRuntime,
          vmTypes,
          cloudConfig.cloudProvider,
        ),
      };
    }
  }

  // Premium-storage capability guard. --disk-tier high/ultra provisions a Premium
  // OS disk, which only premium-capable VM sizes accept (Azure's 's'-family; the
  // per-type PremiumIO catalog column is the source of truth). Drop non-capable
  // candidates up front, keeping capable AND unknown ones: getPremiumStorageCapable
  // returns undefined → allowed for clouds/catalogs without the column (e.g. AWS,
  // whose gp3 tiers gate on volume IOPS not VM size, so this filter is a no-op
  // there), and the gateway's classifyError terminates any that slip through.
  // Cloud-scoped through the catalog rather than a provider-name branch. Like the
  // image filter, this runs before any cloud call and preserves failover to a
  // capable sibling in a mixed vmType list.
  if (diskTierRequiresPremiumStorage(cloudConfig.diskTier)) {
    const hadCandidates = candidates.length > 0;
    candidates = candidates.filter(
      (c) =>
        getPremiumStorageCapable(cloudConfig.cloudProvider, c.vmType) !== false,
    );
    if (hadCandidates && candidates.length === 0) {
      return {
        state: WorkloadState.Invalid,
        message: premiumStorageIncompatibilityMessage(
          vmTypes,
          cloudConfig.cloudProvider,
        ),
      };
    }
  }

  if (candidates.length === 0) {
    const vmLabel = vmTypes.join(', ');
    // Family recognition can be newer than the catalog. If every requested
    // fallback is already known to require an unsupported runtime, refreshing
    // catalog regions cannot make the workload viable.
    const runtimeRejection = acceleratorRuntimeRejectionForAllVMTypes(
      cloudConfig.cloudProvider,
      vmTypes,
    );
    if (runtimeRejection) {
      return {
        state: WorkloadState.Invalid,
        message: runtimeRejection,
      };
    }
    if (pinnedRegion) {
      if (targetsAvailabilityZones && workload.availabilityZone) {
        const compatibleZones = Array.from(
          new Set(
            vmTypes.flatMap((vmType) =>
              getZonesForVMType(pinnedRegion, vmType),
            ),
          ),
        ).sort();
        return {
          state: WorkloadState.Invalid,
          message: `${cloudConfig.cloudProvider} zone "${pinnedRegion}-${workload.availabilityZone}" does not offer VM type "${vmLabel}". Compatible zones after catalog refresh: ${compatibleZones.join(', ') || 'none'}`,
        };
      }
      return {
        state: WorkloadState.Invalid,
        message: `Region "${pinnedRegion}" does not offer VM type "${vmLabel}" on ${cloudConfig.cloudProvider}`,
      };
    }

    if (allowedRegions) {
      const listed = [...allowedRegions].join(', ');
      // Nesting, not the list, may be what left nothing.
      const offeredInList = buildTargetCandidates(
        cloudConfig.cloudProvider,
        vmTypes,
        cloudConfig.spot,
        { availabilityZone: workload.availabilityZone },
      ).some((candidate) => allowedRegions.has(candidate.region));
      return {
        state: WorkloadState.Invalid,
        message:
          offeredInList && workload.requireNestedVirtualization
            ? `None of the regions ${listed} offers VM type "${vmLabel}" with nested virtualization on ${cloudConfig.cloudProvider}`
            : `None of the regions ${listed} offers VM type "${vmLabel}" on ${cloudConfig.cloudProvider}`,
      };
    }
    // Catalog may be stale — VM type was valid at submission time. Stay queued
    // and retry after the next hourly catalog refresh.
    const message = `No regions in catalog for VM type "${vmLabel}" on ${cloudConfig.cloudProvider} — waiting for catalog refresh`;
    return { state: WorkloadState.Queued, message };
  }

  const preflight = await preflightTargetCandidates(
    candidates,
    makeGateway,
    {
      id: workload.id,
      cloud: cloudConfig.cloudProvider,
      spot: cloudConfig.spot ?? false,
      vmLabel: vmTypes.join(', '),
    },
    { signal: options.signal, deadlineAt: options.deadlineAt },
  );
  if ('invalid' in preflight) {
    return { state: WorkloadState.Invalid, message: preflight.invalid };
  }
  candidates = preflight.candidates;

  const priorFailures = await store.getProvisioningFailures(
    workload.id,
    credentialId,
    cloudConfig.cloudProvider,
  );

  const allowed = withoutDeniedRegions(
    candidates,
    priorFailures,
    !!pinnedRegion,
    cloudConfig.cloudProvider,
  );
  if ('invalid' in allowed) {
    return { state: WorkloadState.Invalid, message: allowed.invalid };
  }
  candidates = allowed.candidates;

  const eligibleRegions = pinnedRegion
    ? undefined
    : Array.from(new Set(candidates.map((candidate) => candidate.region)));
  const target = pickTarget(
    candidates,
    priorFailures,
    cloudConfig.cloudProvider,
    cloudConfig.spot ?? false,
    preflight.verifiedKeys,
  );
  cloudConfig.vmType = target.vmType;
  cloudConfig.region = target.region;
  cloudConfig.availabilityZone = target.availabilityZone;
  log.info('Resolved target for workload', {
    id: workload.id,
    vmType: target.vmType,
    region: target.region,
    availabilityZone: cloudConfig.availabilityZone,
    candidateCount: candidates.length,
  });
  return {
    state: WorkloadState.Provisioning,
    config: cloudConfig,
    ...(eligibleRegions ? { eligibleRegions } : {}),
    untriedTargets: untriedTargetCount(
      candidates,
      target,
      priorFailures,
      cloudConfig.cloudProvider,
      cloudConfig.spot ?? false,
      preflight.verifiedKeys,
    ),
  };
}

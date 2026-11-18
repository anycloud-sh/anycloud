import {
  installationSweepPolicy,
  type CloudResourceSweeper,
  type ResourceSweepError,
  type ResourceSweepPolicy,
  type ResourceSweepResult,
  type SparedSweepResource,
} from './gateways/resource-sweeper.js';

/**
 * One installation's sweep in one cloud account, across every location
 * (RFC 0049 C26 (c)): AWS's enabled regions, Azure's `anycloud-<region>`
 * groups, GCP's zones in one listing. A discovery dry run first finds the
 * running VM-host workloads, so the passes after it spare everything they use.
 */
export interface InstallationSweepInput {
  readonly clusterId: string;
  /** The account's sweeper for a location; no location is the default one. */
  sweeperFor(location?: string): CloudResourceSweeper;
  /** Pool IDs the backup manifest names, for untagged resources (GCP rules). */
  readonly resourceOwnerIds?: readonly string[];
  /** Lift the running VM-host workload exception (`--delete-workload-vms`). */
  readonly deleteWorkloadVms: boolean;
  /** The API's own self-delete: leave the management scope (and bucket). */
  readonly keepManagement?: { readonly keepBucket: boolean };
}

interface InstallationSweepLocated {
  readonly location: string | null;
}

interface InstallationSweepPass {
  /** Deleted, or under a dry run what would be. */
  readonly vms: Array<InstallationSweepLocated & { id: string }>;
  readonly resources: Array<
    InstallationSweepLocated & { type: string; id: string }
  >;
  readonly spared: Array<InstallationSweepLocated & SparedSweepResource>;
  readonly errors: Array<InstallationSweepLocated & ResourceSweepError>;
}

export interface InstallationSweep {
  /** The running VM-host workloads a pass spares. */
  readonly spareWorkloadIds: readonly string[];
  resources(options: { dryRun: boolean }): Promise<InstallationSweepPass>;
  /** Buckets, after the VMs, the backup trust and the DNS record are gone. */
  storage(options: { dryRun: boolean }): Promise<InstallationSweepPass>;
}

function emptyPass(): InstallationSweepPass {
  return { vms: [], resources: [], spared: [], errors: [] };
}

function addResult(
  pass: InstallationSweepPass,
  location: string | null,
  result: ResourceSweepResult,
): void {
  pass.vms.push(...result.vmIds.map((id) => ({ location, id })));
  pass.resources.push(
    ...result.otherResources.map((resource) => ({ location, ...resource })),
  );
  pass.spared.push(
    ...(result.spared ?? []).map((resource) => ({ location, ...resource })),
  );
  pass.errors.push(...result.errors.map((error) => ({ location, ...error })));
}

async function sweepEach(
  units: ReadonlyArray<{
    location: string | null;
    run(): Promise<ResourceSweepResult>;
  }>,
): Promise<InstallationSweepPass> {
  const pass = emptyPass();
  const results = await Promise.allSettled(units.map((unit) => unit.run()));
  results.forEach((settled, index) => {
    const location = units[index]!.location;
    if (settled.status === 'fulfilled') {
      addResult(pass, location, settled.value);
    } else {
      pass.errors.push({
        location,
        resourceType: 'location',
        resourceId: location ?? 'default',
        error: String((settled.reason as Error)?.message ?? settled.reason),
      });
    }
  });
  return pass;
}

/**
 * Plan the sweep: list the locations, then dry-run them to find the running
 * VM-host workloads whose resources stay. A location that can't be listed, or
 * whose VMs can't be read, fails the plan: a workload it missed would keep its
 * VM but lose its buckets, disks and rules. The discovery pass isn't a
 * listing; a dry run of `resources` is.
 */
export async function planInstallationSweep(
  input: InstallationSweepInput,
): Promise<InstallationSweep> {
  const base = input.sweeperFor();
  const locations: Array<string | null> = base.sweepLocations
    ? await base.sweepLocations()
    : [null];
  const policyFor = (spareWorkloadIds: readonly string[]) =>
    installationSweepPolicy(input.clusterId, {
      resourceOwnerIds: input.resourceOwnerIds,
      spareRunningWorkloads: !input.deleteWorkloadVms,
      spareWorkloadIds,
      keepManagement: input.keepManagement,
    });
  const resourcesPass = (policy: ResourceSweepPolicy, dryRun: boolean) =>
    sweepEach(
      locations.map((location) => ({
        location,
        run: () =>
          (location === null
            ? base
            : input.sweeperFor(location)
          ).sweepResources({ policy, dryRun }),
      })),
    );

  const discovery = await resourcesPass(policyFor([]), true);
  const unread = discovery.errors.filter(
    // Azure reads a region's group before its VMs.
    (error) => ['vm', 'location', 'resourceGroup'].includes(error.resourceType),
  );
  if (unread.length > 0) {
    throw new Error(
      `Could not read the VMs in ${unread
        .map(
          (error) =>
            `${error.location ?? 'the default location'} (${error.error})`,
        )
        .join(', ')}, so running workloads there can't be spared`,
    );
  }
  const spareWorkloadIds = [
    ...new Set(discovery.spared.map((resource) => resource.workloadId)),
  ];
  const policy = policyFor(spareWorkloadIds);
  return {
    spareWorkloadIds,
    resources: ({ dryRun }) => resourcesPass(policy, dryRun),
    storage: ({ dryRun }) =>
      sweepEach(
        base.sweepStorage
          ? [
              {
                location: null,
                run: () => base.sweepStorage!({ policy, dryRun }),
              },
            ]
          : [],
      ),
  };
}

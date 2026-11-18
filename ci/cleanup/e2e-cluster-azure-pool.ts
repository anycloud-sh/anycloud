import { cleanupAzureManagedGpuOwner } from './azure-nuke-run.js';

/**
 * `npx tsx ci/cleanup/e2e-cluster-azure-pool.ts <region> <owner>…` with the
 * Azure credential in the environment: deletes every resource each hosted API
 * owner identity holds in `anycloud-<region>` (an `e2e-cluster-cloud` node
 * pool's VMs, disks and networking; never the shared group), prints what was
 * deleted, and exits 1 when a deletion failed or a resource remains.
 */
const [region = '', ...owners] = process.argv.slice(2);
for (const owner of owners) {
  const { summary, residualResources } = await cleanupAzureManagedGpuOwner(
    region,
    owner,
  );
  console.log(`purged ${owner}: ${JSON.stringify(summary.deleted)}`);
  for (const { type, id, error } of summary.errors) {
    process.exitCode = 1;
    console.error(`::error::Azure ${type} ${id}: ${error}`);
  }
  if (residualResources.length) {
    process.exitCode = 1;
    console.error(
      `::error::Azure resources remain for ${owner}: ${residualResources.join(' ')}`,
    );
  }
}

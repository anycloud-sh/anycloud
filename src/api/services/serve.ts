import {
  getProvisioningAttemptStore,
  getWorkloadQueryStore,
} from './persistence.js';
import { upsertDNSRecord } from '../../shared/dns-worker.js';
import { waitForDNSPublication } from './dns-publication.js';
import { log } from './logger.js';

export function serveUrl(workloadId: string): string {
  return `https://${workloadId}.anycloud.sh`;
}

function singleServiceVm(
  workloadId: string,
  vms: Awaited<ReturnType<ReturnType<typeof getWorkloadQueryStore>['getVMs']>>,
) {
  if (vms.length === 0) {
    throw new Error(`Service workload ${workloadId} has no live VM`);
  }
  if (vms.length > 1) {
    throw new Error(
      `Service workload ${workloadId} has ${vms.length} VMs; v0 serve expects 1`,
    );
  }
  const vm = vms[0];
  if (!vm.ip) {
    throw new Error(`Service workload ${workloadId} VM has no public IP`);
  }
  return vm;
}

/** The DNS record identity this Service endpoint holds. */
interface ServeEndpointRecords {
  updateDnsRecordId(workloadId: string, dnsRecordId: string): Promise<void>;
}

export async function publishServeEndpoint(
  workloadId: string,
  githubToken: string | null,
): Promise<string> {
  const store = getWorkloadQueryStore();
  const vms = await store.getVMs(workloadId);
  const vm = singleServiceVm(workloadId, vms);

  // The Worker updates the record this Service holds in place, so an upgrade
  // has no routing gap. Do not delete first: that creates a public gap.
  const held = (await store.getWorkload(workloadId))?.dnsRecordId;
  const recordId = await upsertDNSRecord(workloadId, vm.ip, githubToken, {
    recordId: held,
  });
  const endpoints: ServeEndpointRecords = getProvisioningAttemptStore();
  await endpoints.updateDnsRecordId(workloadId, recordId);

  const url = serveUrl(workloadId);
  // Persist ownership first: a publication timeout must remain cleanable.
  await waitForDNSPublication(new URL(url).hostname);
  log.info('Service endpoint published', {
    id: workloadId,
    ip: vm.ip,
    recordId,
    url,
  });
  return url;
}

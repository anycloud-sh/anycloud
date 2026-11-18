import type {
  WorkloadStatusInput as StatusRequest,
  WorkloadStatusResponse as StatusResponse,
} from '../../shared/api-contract/workload-management-schemas.js';
import type { ApiClient } from '../../shared/services/api-client/rpc.js';
import {
  WorkloadState,
  WorkloadType,
  isTerminalState,
} from '../../shared/workload.js';
import { extractErrorLines } from '../../shared/utils.js';
import { watchUntil } from '../utils/watch.js';
import { ServiceState, isContainerHealthy } from '../../shared/runtime.js';

type StatusVm = NonNullable<StatusResponse['vms']>[number];
type StatusRcloneService = NonNullable<
  NonNullable<StatusVm['rclone']>['output']
>;

export interface WorkloadStatusClient {
  workloads: Pick<ApiClient['workloads'], 'status'>;
}

interface WorkloadStatusReadOptions {
  history?: boolean;
  signal?: AbortSignal;
}

export function readWorkloadStatus(
  client: WorkloadStatusClient,
  statusRequest: StatusRequest,
  options: WorkloadStatusReadOptions,
): Promise<StatusResponse> {
  return client.workloads.status(
    {
      params: { id: statusRequest.id },
      query: {
        verbose: statusRequest.verbose ? 'true' : undefined,
        // The API returns the recent tail; --history asks for every event.
        eventsLimit: options.history ? 'all' : undefined,
      },
    },
    { signal: options.signal },
  );
}

/** Poll until the workload reaches a terminal state, handing each read over. */
export async function watchWorkloadStatus(
  client: WorkloadStatusClient,
  statusRequest: StatusRequest,
  options: WorkloadStatusReadOptions & {
    intervalSeconds: number;
    onStatus: (response: StatusResponse, iteration: number) => void;
  },
): Promise<void> {
  await watchUntil(() => readWorkloadStatus(client, statusRequest, options), {
    intervalSeconds: options.intervalSeconds,
    done: (response) => isTerminalState(response.workload.state),
    onRead: options.onStatus,
    signal: options.signal,
  });
}

type VmLifecycle = 'terminated' | 'releasing' | null;

export interface WorkloadStatusSync {
  label: 'output-sync' | 'checkpoint-sync';
  service: StatusRcloneService;
  running: boolean;
  hasErrors: boolean;
  ok: boolean;
}

interface WorkloadStatusVm {
  ip: string;
  /** The type it launched as, when the API reports one. */
  vmType?: string;
  lifecycle: VmLifecycle;
  container: StatusVm['container'];
  containerHealthy: boolean;
  syncs: WorkloadStatusSync[];
  gpu: StatusVm['gpu'];
}

export interface WorkloadStatusView {
  workload: StatusResponse['workload'];
  isPending: boolean;
  isCompleted: boolean;
  vms: WorkloadStatusVm[];
  showEvents: boolean;
  events: StatusResponse['events'];
  groupServiceUpgrades: boolean;
  /** Events the API left out of a default read (null when none); `--history` shows them. */
  hiddenEvents: number | null;
  retry: StatusResponse['retry'];
  checkpoint: StatusResponse['checkpoint'];
}

function statusSync(
  label: WorkloadStatusSync['label'],
  service: StatusRcloneService,
): WorkloadStatusSync {
  // rclone logs are structured (--verbose tags every failure ERROR/FATAL), so
  // sync health must not use the unstructured keyword net.
  const running = service.status === ServiceState.Running;
  const hasErrors =
    extractErrorLines(service.logs, { structuredOnly: true }).length > 0;
  return { label, service, running, hasErrors, ok: running && !hasErrors };
}

export function workloadStatusView(
  response: StatusResponse,
  options: { verbose?: boolean },
): WorkloadStatusView {
  const selectedWorkload = response.workload;
  const isPending = selectedWorkload?.state === WorkloadState.Starting;
  const isCompleted =
    !!selectedWorkload?.state && isTerminalState(selectedWorkload.state);
  // Bucket sync status for configured output or checkpoint storage. Input
  // bucket has no sync service (download-once).
  const hasCheckpoint = Boolean(
    selectedWorkload?.checkpointBucket || selectedWorkload?.spot,
  );
  // Default view hides terminated VMs (history noise); --verbose shows them
  // with a marker.
  const vms = (response.vms ?? [])
    .filter((vm) => options.verbose || vm.endedAt == null)
    .map((vm): WorkloadStatusVm => {
      const syncs: WorkloadStatusSync[] = [];
      if (selectedWorkload?.outputBucket && vm.rclone?.output) {
        syncs.push(statusSync('output-sync', vm.rclone.output));
      }
      if (hasCheckpoint && vm.rclone?.checkpoint) {
        syncs.push(statusSync('checkpoint-sync', vm.rclone.checkpoint));
      }
      // A live VM under a terminal workload is a machine the user believes
      // they already stopped paying for — mark it, don't render it bare.
      const lifecycle: VmLifecycle =
        vm.endedAt != null ? 'terminated' : isCompleted ? 'releasing' : null;
      return {
        ip: vm.ip,
        ...(vm.vmType && { vmType: vm.vmType }),
        lifecycle,
        container: vm.container,
        containerHealthy: vm.container
          ? isContainerHealthy(vm.container)
          : false,
        syncs,
        gpu: vm.gpu,
      };
    });
  const hidden =
    (response.eventsTotal ?? response.events.length) - response.events.length;
  return {
    workload: selectedWorkload,
    isPending,
    isCompleted,
    vms,
    showEvents: response.events.length > 0 && !!selectedWorkload,
    events: response.events,
    groupServiceUpgrades:
      selectedWorkload?.workloadType === WorkloadType.Service,
    hiddenEvents: hidden > 0 ? hidden : null,
    retry: response.retry,
    checkpoint: response.checkpoint,
  };
}

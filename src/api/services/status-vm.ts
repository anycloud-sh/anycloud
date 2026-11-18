import type { WorkloadStatusResponse } from '../../shared/api-contract/workload-management-schemas.js';
import type { DbVM } from './entities.js';
import type { JobVmHealth } from './job/operations.js';

type StatusVm = NonNullable<WorkloadStatusResponse['vms']>[number];

export function toStatusVm(
  vm: DbVM,
  health: JobVmHealth | undefined,
  exposeUserSsh: boolean,
): StatusVm {
  const serialized: StatusVm = {
    ip: vm.ip,
    cloudId: vm.cloudId,
    endedAt: vm.endedAt,
  };

  if (vm.region !== undefined) serialized.region = vm.region;
  if (vm.availabilityZone !== undefined) {
    serialized.availabilityZone = vm.availabilityZone;
  }
  if (vm.vmType !== undefined) serialized.vmType = vm.vmType;
  if (exposeUserSsh) {
    serialized.sshHost = vm.sshHost;
    serialized.sshPort = vm.sshPort;
    serialized.sshUsername = vm.sshUsername;
  }
  if (health) {
    serialized.container = health.container;
    serialized.rclone = health.rclone;
    if (health.gpu) serialized.gpu = health.gpu;
  }

  return serialized;
}

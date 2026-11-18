import * as termination from '../host-runtime/termination.js';
import * as startup from '../workload-workflows/vm-host-startup.js';
import { vmHostStartupDeps } from '../job/default-runtime.js';
import { getWorkloadLifecycle } from '../persistence.js';
import {
  createVmHostServeRuntime,
  createServeRuntimeRouter,
  type ServeRuntime,
} from './runtime.js';

let defaultRuntime: ServeRuntime | undefined;

/**
 * Process-level composition root for Serve. Substrate selection stays here so
 * the API and scheduler contracts do not depend on a concrete runtime.
 */
export function getDefaultServeRuntime(): ServeRuntime {
  if (defaultRuntime) {
    return defaultRuntime;
  }

  const vmHost = createVmHostServeRuntime({
    deploy: (cloudConfig, workload, selectedCredentialId, options) =>
      startup.deploy(
        vmHostStartupDeps(),
        cloudConfig,
        workload,
        selectedCredentialId,
        options,
      ),
    beginUpdate: (input) => getWorkloadLifecycle().beginServiceUpgrade(input),
    teardown: (cloudConfig, workloadId) =>
      termination.teardownServiceVMs(cloudConfig, workloadId),
    cleanup: (cloudConfig, workload) =>
      termination.terminateServiceStep(cloudConfig, workload.id, workload),
  });
  defaultRuntime = createServeRuntimeRouter({ vmHost });
  return defaultRuntime;
}

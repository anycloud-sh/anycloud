import { SSHManager } from '../gateways/ssh.js';
import { teardownVMs, terminateStep } from '../host-runtime/termination.js';
import {
  checkJobCompletion,
  type CompletionPersistence,
} from '../workload-workflows/completion.js';
import {
  deploy,
  type VmHostStartupDeps,
} from '../workload-workflows/vm-host-startup.js';
import {
  getCredentialSecretStore,
  getProvisioningAttemptStore,
  getWorkloadEventStore,
  getWorkloadLifecycle,
  getWorkloadOutcomes,
  getWorkloadQueryStore,
} from '../persistence.js';
import {
  createJobRuntimeRouter,
  createVmHostJobRuntime,
  type JobRuntime,
} from './runtime.js';

let defaultRuntime: JobRuntime | undefined;

/** Persistence and SSH key derivation for VM-host startup and the Job poll. */
export function vmHostStartupDeps(): VmHostStartupDeps & CompletionPersistence {
  return {
    store: getWorkloadQueryStore(),
    lifecycle: getWorkloadLifecycle(),
    outcomes: getWorkloadOutcomes(),
    attempts: getProvisioningAttemptStore(),
    events: getWorkloadEventStore(),
    credentials: getCredentialSecretStore(),
    derivePublicKey: (privateKey) => SSHManager.derivePublicKey(privateKey),
  };
}

/** Process-level Job lifecycle composition root. */
export function getDefaultJobRuntime(): JobRuntime {
  if (defaultRuntime) return defaultRuntime;

  const vmHost = createVmHostJobRuntime({
    deploy: (cloudConfig, workload, selectedCredentialId, options) =>
      deploy(
        vmHostStartupDeps(),
        cloudConfig,
        workload,
        selectedCredentialId,
        options,
      ),
    poll: async (id, sshPrivateKey, cloudConfig) =>
      checkJobCompletion(vmHostStartupDeps(), id, sshPrivateKey, cloudConfig),
    teardown: teardownVMs,
    cleanup: terminateStep,
  });
  defaultRuntime = createJobRuntimeRouter({
    vmHost,
  });
  return defaultRuntime;
}

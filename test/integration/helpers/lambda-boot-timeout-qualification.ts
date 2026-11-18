import { randomBytes } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import config from '../../../src/api/config.js';
import {
  encryptCredential,
  hashCredential,
  resolveProvisioningConfig,
} from '../../../src/api/services/cloud-config.js';
import { deploy } from '../../../src/api/services/workload-workflows/vm-host-startup.js';
import { vmHostStartupDeps } from '../../../src/api/services/job/default-runtime.js';
import { teardownVMs } from '../../../src/api/services/host-runtime/termination.js';
import { VMCreationError } from '../../../src/api/services/codes.js';
import { resetLambdaCandidatePreflightCache } from '../../../src/api/services/gateways/lambda.js';
import { SSHManager } from '../../../src/api/services/gateways/ssh.js';
import { runWorkloadReconcileOnce } from '../../../src/api/services/monitor.js';
import {
  getCredentialSecretStore,
  resetPersistence,
  getWorkloadLifecycle,
  getProvisioningAttemptStore as ledger,
  getWorkloadEventStore as eventLog,
  getWorkloadQueryStore as queries,
} from '../../../src/api/services/persistence.js';
import {
  CloudFailureDiagnosis,
  CloudType,
  type CloudConfig,
} from '../../../src/shared/cloud.js';
import { WorkloadState } from '../../../src/shared/workload.js';
import { FailureDisposition } from '../../../src/api/services/provisioning-failure.js';
import {
  requestLambdaInstanceTermination,
  verifyLambdaInstanceReleased,
} from './lambda-release-verifier.js';
import { upsertCredential } from '../../../src/api/services/repositories/credential-secrets.js';
import { getDB } from '../../../src/api/services/repositories/db.js';
import { createWorkload } from '../../../src/api/services/repositories/workload-creation.js';

const VM_TYPES = ['gpu_1x_a10', 'cpu_4x_general', 'gpu_1x_a100_sxm4'];
const RETRY_DEADLINE_MS = 20 * 60_000;

interface SelectedTarget {
  readonly region: string;
  readonly vmType: string;
}

export interface LambdaBootTimeoutQualificationResult {
  readonly diagnosis: CloudFailureDiagnosis;
  readonly disposition: FailureDisposition;
  readonly firstInstanceId: string;
  readonly firstTarget: SelectedTarget;
  readonly replacementInstanceId: string;
  readonly secondTarget: SelectedTarget;
}

interface LambdaBootTimeoutQualificationOptions {
  readonly apiKey: string;
  readonly armForcedBootTimeout: () => void;
  readonly workloadId: string;
  readonly ledgerPath?: string;
}

const LAMBDA_INSTANCE_ID_RE =
  /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function persistInstanceLedger(
  ledgerPath: string | undefined,
  workloadId: string,
  instanceIds: ReadonlySet<string>,
): Promise<void> {
  if (!ledgerPath) return;
  await mkdir(dirname(ledgerPath), { recursive: true });
  const temporaryPath = `${ledgerPath}.${process.pid}.tmp`;
  await writeFile(
    temporaryPath,
    `${JSON.stringify({ workloadId, instanceIds: [...instanceIds].sort() })}\n`,
  );
  await rename(temporaryPath, ledgerPath);
}

function selectedTarget(config: {
  vmType?: string | string[];
  region?: string;
}): SelectedTarget {
  if (typeof config.vmType !== 'string' || !config.region) {
    throw new Error(
      `Expected one selected target, got ${JSON.stringify({
        vmType: config.vmType,
        region: config.region,
      })}`,
    );
  }
  return { vmType: config.vmType, region: config.region };
}

async function waitForRetryCleanup(workloadId: string): Promise<void> {
  const store = queries();
  const deadline = Date.now() + RETRY_DEADLINE_MS;
  while (Date.now() < deadline) {
    await runWorkloadReconcileOnce();
    const workload = await store.getWorkload(workloadId);
    if (!workload) throw new Error('Workload disappeared during retry');
    console.log(`LIVE_TIMEOUT retry_state=${workload.state}`);
    if (workload.state === WorkloadState.Queued) return;
    if (workload.state !== WorkloadState.Retrying) {
      throw new Error(`Unexpected retry state: ${workload.state}`);
    }
    await delay(5_000);
  }
  throw new Error('Timed out waiting for the first Lambda VM to be released');
}

export async function runLambdaBootTimeoutQualification(
  options: LambdaBootTimeoutQualificationOptions,
): Promise<LambdaBootTimeoutQualificationResult> {
  let cleanupConfig: CloudConfig | undefined;
  let operationError: Error | undefined;
  let result: LambdaBootTimeoutQualificationResult | undefined;
  const recordedInstanceIds = new Set<string>();

  const recordInstanceIds = async (instanceIds: readonly string[]) => {
    for (const instanceId of instanceIds) {
      if (LAMBDA_INSTANCE_ID_RE.test(instanceId)) {
        recordedInstanceIds.add(instanceId);
      }
    }
    await persistInstanceLedger(
      options.ledgerPath,
      options.workloadId,
      recordedInstanceIds,
    );
  };

  config.cipherKey = randomBytes(32).toString('hex');
  resetPersistence();
  resetLambdaCandidatePreflightCache();
  console.log(`LIVE_TIMEOUT workload_id=${options.workloadId}`);
  await recordInstanceIds([]);

  try {
    const credentials = {
      cloudProvider: CloudType.Lambda,
      apiKey: options.apiKey,
    } as const;
    const credentialId = await upsertCredential(
      getDB(),
      hashCredential(credentials),
      await encryptCredential(credentials),
      CloudType.Lambda,
    );
    const { privateKey } = await SSHManager.generateKeypair();
    await createWorkload(getDB(), {
      id: options.workloadId,
      userId: 'ci-lambda-timeout',
      workloadType: 'job',
      image: 'alpine:3.20',
      requestedComputeProvider: CloudType.Lambda,
      vmType: VM_TYPES,
      spot: false,
      dockerCommand: 'docker run alpine:3.20 sleep 600',
      command: ['sleep', '600'],
      sshPrivateKey: privateKey,
      credentialId,
    });

    const workload = await queries().getWorkload(options.workloadId);
    if (!workload) throw new Error('Failed to create workload');
    const firstResolution = await resolveProvisioningConfig(
      workload,
      queries(),
      getCredentialSecretStore(),
    );
    if (firstResolution.state !== WorkloadState.Provisioning) {
      throw new Error(
        `First target could not be selected: ${firstResolution.state} ${firstResolution.message}`,
      );
    }
    cleanupConfig = firstResolution.config;
    const firstTarget = selectedTarget(firstResolution.config);
    console.log(`LIVE_TIMEOUT first_target=${JSON.stringify(firstTarget)}`);

    if (
      !(await getWorkloadLifecycle().updateState(
        options.workloadId,
        WorkloadState.Provisioning,
        {
          metadata: {
            region: firstResolution.config.region,
            eligibleRegions: firstResolution.eligibleRegions,
          },
        },
      ))
    ) {
      throw new Error('Could not claim the first provisioning attempt');
    }

    options.armForcedBootTimeout();
    let bootError: VMCreationError | undefined;
    try {
      await deploy(
        vmHostStartupDeps(),
        firstResolution.config,
        workload,
        firstResolution.credentialId,
      );
    } catch (error) {
      if (!(error instanceof VMCreationError)) throw error;
      bootError = error;
    }
    if (!bootError) throw new Error('The forced first boot did not fail');
    if (
      !bootError.message.includes('did not get IP') ||
      !bootError.message.includes('status=booting') ||
      !bootError.message.includes('hasIp=false')
    ) {
      throw new Error(`Unexpected first boot error: ${bootError.message}`);
    }
    const firstInstanceId = bootError.attemptedVmIds[0];
    if (!firstInstanceId) throw new Error('Boot error lost the Lambda VM ID');
    await recordInstanceIds([firstInstanceId]);
    console.log(`LIVE_TIMEOUT first_instance_id=${firstInstanceId}`);

    const classification = await eventLog().getLatestFailureClassification(
      options.workloadId,
    );
    console.log(
      `LIVE_TIMEOUT classification=${JSON.stringify(classification)}`,
    );
    if (
      classification?.diagnosis !== CloudFailureDiagnosis.CapacityExhausted ||
      classification.disposition !== FailureDisposition.FailoverTarget
    ) {
      throw new Error(
        `Wrong boot failure classification: ${JSON.stringify(classification)}`,
      );
    }

    await delay(2_000);
    await waitForRetryCleanup(options.workloadId);
    const firstAttempt = (
      await ledger().getProvisioningAttempts(options.workloadId)
    ).find((attempt) => attempt.cloud_id === firstInstanceId);
    if (!firstAttempt?.ended_at) {
      throw new Error(
        'First Lambda VM row stayed open after release confirmation',
      );
    }
    await verifyLambdaInstanceReleased({
      apiKey: options.apiKey,
      deadlineMs: 60_000,
      instanceId: firstInstanceId,
      onObservation: (observation) =>
        console.log(
          `LIVE_TIMEOUT first_instance_observation=${JSON.stringify(observation)}`,
        ),
    });
    console.log('LIVE_TIMEOUT first_instance_released=true');

    const queued = await queries().getWorkload(options.workloadId);
    if (!queued) throw new Error('Workload disappeared after cleanup');
    const secondResolution = await resolveProvisioningConfig(
      queued,
      queries(),
      getCredentialSecretStore(),
    );
    if (secondResolution.state !== WorkloadState.Provisioning) {
      throw new Error(
        `Second target could not be selected: ${secondResolution.state} ${secondResolution.message}`,
      );
    }
    const secondTarget = selectedTarget(secondResolution.config);
    const changedTarget =
      firstTarget.vmType !== secondTarget.vmType ||
      firstTarget.region !== secondTarget.region;
    console.log(`LIVE_TIMEOUT second_target=${JSON.stringify(secondTarget)}`);
    console.log(`LIVE_TIMEOUT changed_target=${String(changedTarget)}`);
    if (!changedTarget) throw new Error('Retry did not change Lambda target');

    if (
      !(await getWorkloadLifecycle().updateState(
        options.workloadId,
        WorkloadState.Provisioning,
        {
          metadata: {
            region: secondResolution.config.region,
            eligibleRegions: secondResolution.eligibleRegions,
          },
        },
      ))
    ) {
      throw new Error('Could not claim the replacement provisioning attempt');
    }
    await deploy(
      vmHostStartupDeps(),
      secondResolution.config,
      queued,
      secondResolution.credentialId,
    );
    const finalWorkload = await queries().getWorkload(options.workloadId);
    if (finalWorkload?.state !== WorkloadState.Running) {
      throw new Error(
        `Replacement did not reach Running: ${String(finalWorkload?.state)}`,
      );
    }
    const liveVMs = await queries().getVMs(options.workloadId);
    if (liveVMs.length !== 1 || !liveVMs[0]) {
      throw new Error(`Expected one replacement VM, found ${liveVMs.length}`);
    }
    console.log(
      `LIVE_TIMEOUT replacement_running=${JSON.stringify({
        cloudId: liveVMs[0].cloudId,
        vmType: secondTarget.vmType,
        region: liveVMs[0].region,
      })}`,
    );
    await recordInstanceIds([liveVMs[0].cloudId]);

    result = {
      diagnosis: classification.diagnosis,
      disposition: classification.disposition,
      firstInstanceId,
      firstTarget,
      replacementInstanceId: liveVMs[0].cloudId,
      secondTarget,
    };
  } catch (error) {
    if (error instanceof VMCreationError) {
      await recordInstanceIds(error.attemptedVmIds);
    }
    operationError = asError(error);
  }

  const cleanupErrors: Error[] = [];
  try {
    const attempts = await ledger().getProvisioningAttempts(options.workloadId);
    await recordInstanceIds(attempts.map((attempt) => attempt.cloud_id));
  } catch (error) {
    cleanupErrors.push(asError(error));
  }
  try {
    if (cleanupConfig) {
      await teardownVMs(cleanupConfig, options.workloadId);
    }
  } catch (error) {
    cleanupErrors.push(asError(error));
  }

  // Send every independent termination request before judging any outcome.
  // A failure for one exact ID must not prevent cleanup of the others.
  const terminationResults = await Promise.allSettled(
    [...recordedInstanceIds].map((instanceId) =>
      requestLambdaInstanceTermination({
        apiKey: options.apiKey,
        instanceId,
      }),
    ),
  );
  terminationResults.forEach((termination, index) => {
    const instanceId = [...recordedInstanceIds][index];
    if (termination.status === 'rejected') {
      cleanupErrors.push(
        new Error(
          `Independent termination failed for ${instanceId}: ${asError(termination.reason).message}`,
        ),
      );
    }
  });

  // Verify each exact ledger ID through both Lambda views. Do this even when a
  // termination request failed, and collect every failure before reporting.
  for (const instanceId of recordedInstanceIds) {
    try {
      await verifyLambdaInstanceReleased({
        apiKey: options.apiKey,
        instanceId,
        onObservation: (observation) =>
          console.log(
            `LIVE_TIMEOUT cleanup_observation=${JSON.stringify({ instanceId, ...observation })}`,
          ),
      });
      console.log(`LIVE_TIMEOUT cleanup_released=${instanceId}`);
    } catch (error) {
      cleanupErrors.push(asError(error));
    }
  }

  try {
    const remaining = await queries().getVMs(options.workloadId);
    console.log(`LIVE_TIMEOUT cleanup_remaining=${remaining.length}`);
    if (remaining.length > 0) {
      throw new Error(
        `Cleanup left Lambda VM rows: ${remaining
          .map((vm) => vm.cloudId)
          .join(',')}`,
      );
    }
  } catch (error) {
    cleanupErrors.push(asError(error));
  }
  resetLambdaCandidatePreflightCache();
  resetPersistence();

  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      cleanupErrors,
      'Lambda qualification cleanup failed',
    );
  }
  if (operationError) throw operationError;
  if (!result) {
    throw new Error('Lambda boot-timeout qualification produced no result');
  }
  return result;
}

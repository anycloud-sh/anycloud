/**
 * Real-provider qualification of the production Azure restart policy after a
 * failed allocation. Run through the Azure spot restart probe workflow's
 * candidate_recovery input. A run that never exercises failed provisioning
 * fails qualification; it must not be counted as evidence for that branch.
 */
import {
  ComputeManagementClient,
  type VirtualMachine,
  type VirtualMachinesGetOptionalParams,
} from '@azure/arm-compute';
import { NetworkManagementClient } from '@azure/arm-network';
import { ResourceManagementClient } from '@azure/arm-resources';
import { ClientSecretCredential } from '@azure/identity';
import { createHash, randomBytes } from 'node:crypto';
import { renameSync, writeFileSync } from 'node:fs';
import {
  Azure,
  isAzureNotFound,
} from '../../src/api/services/gateways/azure.js';
import { isPreemptible } from '../../src/api/services/gateways/cloud.js';
import { completeCloudConfig } from '../../src/shared/cloud-config.js';
import { CloudType } from '../../src/shared/cloud.js';
import { sleep, withTimeout } from '../../src/shared/utils.js';

const trace: Record<string, unknown>[] = [];
function report(event: string, detail: Record<string, unknown> = {}) {
  const entry = { event, at: new Date().toISOString(), ...detail };
  trace.push(entry);
  const output = process.env.ANYCLOUD_SPOT_RACE_OUTPUT;
  if (output) {
    // Keep the last complete observation even if CI kills the probe process.
    writeFileSync(`${output}.tmp`, `${JSON.stringify(trace, null, 2)}\n`);
    renameSync(`${output}.tmp`, output);
  }
  console.log(JSON.stringify(entry));
}

function workflowSuffix() {
  const run = process.env.GITHUB_RUN_ID;
  const attempt = process.env.GITHUB_RUN_ATTEMPT;
  if (run === undefined && attempt === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(run ?? '') || !/^[1-9]\d*$/.test(attempt ?? '')) {
    throw new Error('Qualification requires a valid workflow run and attempt');
  }
  return `${run}-${attempt}`;
}

async function cleanup(
  resources: ResourceManagementClient,
  group: string,
  suffix: string,
) {
  const cleanupSignal = AbortSignal.timeout(10 * 60_000);
  const options = { abortSignal: cleanupSignal };
  await withTimeout(
    (async () => {
      try {
        const existing = await resources.resourceGroups.get(group, options);
        if (
          existing.tags?.qualification !== 'anycloud-azure-restart' ||
          existing.tags.run !== suffix
        ) {
          throw new Error(
            `Refusing cleanup of an unowned resource group: ${group}`,
          );
        }
        await resources.resourceGroups.beginDeleteAndWait(group, options);
      } catch (error) {
        if (!isAzureNotFound(error)) throw error;
      }
      try {
        await resources.resourceGroups.get(group, options);
        throw new Error(
          `Qualification resource group survived deletion: ${group}`,
        );
      } catch (error) {
        if (!isAzureNotFound(error)) throw error;
      }
      cleanupSignal.throwIfAborted();
      report('cleanup-confirmed', { group });
    })(),
    10 * 60_000,
    `Clean up Azure qualification group ${group}`,
  );
}

function observation(vm: VirtualMachine) {
  return {
    vmId: vm.vmId,
    osDiskId: vm.storageProfile?.osDisk?.managedDisk?.id,
    provisioningState: vm.provisioningState,
    statuses: vm.instanceView?.statuses,
  };
}

async function run(clock: {
  now: () => number;
  wait: (ms: number, signal?: AbortSignal) => Promise<void>;
}) {
  const credentials = {
    subscriptionId: process.env.AZURE_SUBSCRIPTION_ID!,
    directoryId: process.env.AZURE_TENANT_ID!,
    applicationId: process.env.AZURE_CLIENT_ID!,
    secret: process.env.AZURE_CLIENT_SECRET!,
  };
  if (Object.values(credentials).some((value) => !value)) {
    throw new Error(
      'Explicit Azure service-principal credentials are required',
    );
  }
  const cleanupOnly = process.argv.includes('--cleanup');
  const workflow = workflowSuffix();
  if (cleanupOnly && !workflow) {
    throw new Error(
      'Independent cleanup requires the workflow run and attempt',
    );
  }
  const suffix = workflow ?? randomBytes(6).toString('hex');
  // A separate workflow step can recover this exact owned group after a process
  // kill. Local runs remain unique; neither path sweeps shared anycloud groups.
  const group = `azure-restart-qualification-${suffix}`;
  const credential = new ClientSecretCredential(
    credentials.directoryId,
    credentials.applicationId,
    credentials.secret,
  );
  const resources = new ResourceManagementClient(
    credential,
    credentials.subscriptionId,
  );
  if (cleanupOnly) {
    await cleanup(resources, group, suffix);
    return;
  }
  const region = process.env.ANYCLOUD_SPOT_RACE_REGION ?? 'austriaeast';
  const vmSize = process.env.ANYCLOUD_SPOT_RACE_VM_SIZE ?? 'Standard_D2s_v5';
  const attempts = Number(process.env.ANYCLOUD_SPOT_RACE_REPETITIONS ?? '10');
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 20) {
    throw new Error('Candidate recovery requires 1–20 induction attempts');
  }
  const name = `restart-${suffix}`;
  const marker = randomBytes(16).toString('hex');
  const markerDigest = createHash('sha256').update(marker).digest('hex');
  const compute = new ComputeManagementClient(
    credential,
    credentials.subscriptionId,
  );
  const network = new NetworkManagementClient(
    credential,
    credentials.subscriptionId,
  );
  const controller = new AbortController();
  const signal = controller.signal;
  const withCancellation = (
    operationSignal?: VirtualMachinesGetOptionalParams['abortSignal'],
  ) => {
    signal.throwIfAborted();
    // The gateway and this fixture both use native signals. Preserve the
    // gateway's deadline while also cancelling its SDK requests with the probe.
    return operationSignal
      ? AbortSignal.any([signal, operationSignal as AbortSignal])
      : signal;
  };
  // Observe real SDK responses without changing them. Qualification requires
  // the candidate itself to start from three failed-allocation observations
  // with absent power state; an earlier failure alone is insufficient proof.
  let candidateActive = false;
  let failedAllocationStarted = false;
  const candidateReads: VirtualMachine[] = [];
  const rawGet = compute.virtualMachines.get.bind(compute.virtualMachines);
  compute.virtualMachines.get = async (resourceGroup, vmName, options) => {
    const vm = await rawGet(resourceGroup, vmName, {
      ...options,
      abortSignal: withCancellation(options?.abortSignal),
    });
    if (candidateActive) candidateReads.push(vm);
    return vm;
  };
  const rawStart = compute.virtualMachines.beginStart.bind(
    compute.virtualMachines,
  );
  compute.virtualMachines.beginStart = async (
    resourceGroup,
    vmName,
    options,
  ) => {
    const abortSignal = withCancellation(options?.abortSignal);
    if (candidateActive) {
      const preceding = candidateReads.slice(-3);
      failedAllocationStarted =
        preceding.length === 3 &&
        preceding.every((vm) => {
          const statuses = vm.instanceView?.statuses ?? [];
          return (
            statuses.some((status) =>
              /^provisioningstate\/failed\/(allocationfailed|overconstrainedallocationrequest|zonalallocationfailed|overconstrainedzonalallocationrequest)(?:\/|$)/i.test(
                status.code ?? '',
              ),
            ) &&
            !statuses.some((status) => /^powerstate\//i.test(status.code ?? ''))
          );
        });
      report('candidate-start-request', {
        failedAllocationStarted,
        preceding: preceding.map(observation),
      });
    }
    const poller = await rawStart(resourceGroup, vmName, {
      ...options,
      abortSignal,
    });
    const rawPoll = poller.pollUntilDone.bind(poller);
    poller.pollUntilDone = (pollOptions) =>
      rawPoll({
        ...pollOptions,
        abortSignal: withCancellation(pollOptions?.abortSignal),
      });
    return poller;
  };
  const rawIP = network.publicIPAddresses.get.bind(network.publicIPAddresses);
  network.publicIPAddresses.get = (resourceGroup, ipName, options) =>
    rawIP(resourceGroup, ipName, {
      ...options,
      abortSignal: withCancellation(options?.abortSignal),
    });
  const gateway = new Azure(
    completeCloudConfig({
      cloudProvider: CloudType.Azure,
      region,
      vmType: vmSize,
      spot: true,
      credentials,
    }),
  );
  // Use real SDK clients and the production recovery method. Only the fixture
  // resource-group selector differs, so cleanup cannot touch shared resources.
  Object.defineProperty(gateway, 'resourceGroup', { value: group });
  gateway.computeClient = compute;
  gateway.networkClient = network;
  const recovery = gateway.compute();
  if (!isPreemptible(recovery))
    throw new Error('Azure does not expose restart recovery');

  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  const options = { abortSignal: signal };
  const read = () =>
    compute.virtualMachines.get(group, name, {
      ...options,
      expand: 'instanceView',
    });
  const runGuestCommand = async (
    commandName: string,
    script: string,
    expectedDigest: string,
  ) => {
    // Action Run Command stalled after a successful recovery. Managed commands
    // provide a script timeout and a separately inspectable execution result.
    const commandSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(300_000),
    ]);
    const commandOptions = { abortSignal: commandSignal };
    report('guest-command-requested', { commandName });
    await withTimeout(
      (async () => {
        await compute.virtualMachineRunCommands.beginCreateOrUpdateAndWait(
          group,
          name,
          commandName,
          {
            location: region,
            source: { script },
            timeoutInSeconds: 60,
            asyncExecution: false,
          },
          commandOptions,
        );
        commandSignal.throwIfAborted();
        const { instanceView } =
          await compute.virtualMachineRunCommands.getByVirtualMachine(
            group,
            name,
            commandName,
            { ...commandOptions, expand: 'instanceView' },
          );
        commandSignal.throwIfAborted();
        report('guest-command-result', {
          commandName,
          expectedDigest,
          instanceView,
        });
        if (
          instanceView?.executionState !== 'Succeeded' ||
          instanceView.exitCode !== 0 ||
          instanceView.output?.trim().split(/\s+/)[0] !== expectedDigest
        ) {
          throw new Error(`Guest command did not confirm ${commandName}`);
        }
        // Remove the seed command before eviction so boot cannot replay it and
        // recreate the marker that the recovery check must find on the disk.
        await compute.virtualMachineRunCommands.beginDeleteAndWait(
          group,
          name,
          commandName,
          commandOptions,
        );
        commandSignal.throwIfAborted();
      })(),
      300_000,
      `Azure guest command ${commandName}`,
    );
  };
  let exercised = false;
  const failures: unknown[] = [];
  try {
    report('qualification-start', {
      sourceSha: process.env.GITHUB_SHA,
      group,
      name,
      region,
      vmSize,
      attempts,
    });
    await resources.resourceGroups.createOrUpdate(
      group,
      {
        location: region,
        tags: { qualification: 'anycloud-azure-restart', run: suffix },
      },
      options,
    );
    const vnet = await network.virtualNetworks.beginCreateOrUpdateAndWait(
      group,
      name,
      {
        location: region,
        addressSpace: { addressPrefixes: ['10.43.0.0/16'] },
        subnets: [{ name: 'default', addressPrefix: '10.43.0.0/24' }],
      },
      options,
    );
    const subnet = vnet.subnets?.[0]?.id;
    if (!subnet) throw new Error('Azure returned no subnet');
    const publicIP = await network.publicIPAddresses.beginCreateOrUpdateAndWait(
      group,
      name,
      {
        location: region,
        publicIPAllocationMethod: 'Static',
        sku: { name: 'Standard' },
      },
      options,
    );
    // Default NSG rules deny inbound Internet traffic. The public IP exercises
    // startVM's readiness contract; guest checks use Azure's management agent.
    const nsg = await network.networkSecurityGroups.beginCreateOrUpdateAndWait(
      group,
      name,
      {
        location: region,
        securityRules: [],
      },
      options,
    );
    const nic = await network.networkInterfaces.beginCreateOrUpdateAndWait(
      group,
      name,
      {
        location: region,
        networkSecurityGroup: { id: nsg.id },
        ipConfigurations: [
          {
            name: 'primary',
            subnet: { id: subnet },
            privateIPAllocationMethod: 'Dynamic',
            publicIPAddress: { id: publicIP.id },
          },
        ],
      },
      options,
    );
    await compute.virtualMachines.beginCreateOrUpdateAndWait(
      group,
      name,
      {
        location: region,
        hardwareProfile: { vmSize },
        priority: 'Spot',
        evictionPolicy: 'Deallocate',
        billingProfile: { maxPrice: -1 },
        osProfile: {
          computerName: name,
          adminUsername: 'anycloud',
          adminPassword: `Ac1!${randomBytes(24).toString('base64url')}`,
          linuxConfiguration: { disablePasswordAuthentication: false },
        },
        storageProfile: {
          imageReference: {
            publisher: 'canonical',
            offer: 'ubuntu-24_04-lts',
            // service-terminology-ok: Azure owns this marketplace SKU spelling
            sku: 'server',
            version: 'latest',
          },
          osDisk: {
            createOption: 'FromImage',
            managedDisk: { storageAccountType: 'Premium_LRS' },
          },
        },
        networkProfile: { networkInterfaces: [{ id: nic.id, primary: true }] },
      },
      options,
    );
    const original = observation(await read());
    if (!original.vmId || !original.osDiskId)
      throw new Error('Azure returned incomplete VM identity');
    report('original-identity', original);
    await runGuestCommand(
      'seed-marker',
      `set -eu; printf '%s' '${marker}' > /var/lib/anycloud-restart-qualification; sync; sha256sum /var/lib/anycloud-restart-qualification`,
      markerDigest,
    );
    await runGuestCommand(
      'verify-before-eviction',
      'set -eu; sha256sum /var/lib/anycloud-restart-qualification',
      markerDigest,
    );

    for (let attempt = 1; attempt <= attempts; attempt++) {
      signal.throwIfAborted();
      await compute.virtualMachines.simulateEviction(group, name, options);
      report('eviction-requested', { attempt });
      const deadline = clock.now() + 180_000;
      let evictionObserved = false;
      while (clock.now() < deadline) {
        const vm = await withTimeout(
          read(),
          deadline - clock.now(),
          'Observe Azure eviction',
        );
        if (clock.now() >= deadline)
          throw new Error('Azure eviction observation exceeded its deadline');
        const running = vm.instanceView?.statuses?.some(
          (status) => status.code?.toLowerCase() === 'powerstate/running',
        );
        if (!running) {
          evictionObserved = true;
          report('eviction-observed', { attempt, ...observation(vm) });
          break;
        }
        await clock.wait(
          Math.min(1000, Math.max(0, deadline - clock.now())),
          signal,
        );
      }
      if (!evictionObserved)
        throw new Error('Azure did not expose the requested eviction');
      // This deliberately reproduces the old race to induce a failed previous
      // allocation. It is separate from the candidate's bounded start policy.
      // Sample the short transition window instead of always requesting at its
      // first edge; the historical refusal happened during deallocation.
      const inductionDelayMs = ((attempt - 1) % 5) * 2500;
      if (inductionDelayMs) await clock.wait(inductionDelayMs, signal);
      report('before-induction', {
        attempt,
        inductionDelayMs,
        ...observation(await read()),
      });
      const inductionDeadline = clock.now() + 180_000;
      const inductionSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(180_000),
      ]);
      try {
        await withTimeout(
          (async () => {
            const start = await compute.virtualMachines.beginStart(
              group,
              name,
              { abortSignal: inductionSignal },
            );
            inductionSignal.throwIfAborted();
            await start.pollUntilDone({ abortSignal: inductionSignal });
          })(),
          180_000,
          'Induce Azure allocation failure',
        );
        report('induction-start-accepted', { attempt });
      } catch (error) {
        if (inductionSignal.aborted || clock.now() >= inductionDeadline)
          throw error;
        report('induction-start-rejected', {
          attempt,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      signal.throwIfAborted();
      const before = observation(await read());
      report('before-candidate', { attempt, ...before });
      candidateReads.length = 0;
      failedAllocationStarted = false;
      candidateActive = true;
      let onAbort!: () => void;
      const cancelled = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
      });
      let ip: string | null;
      try {
        signal.throwIfAborted();
        // Reach cleanup even while the gateway is sleeping between reads.
        // The SDK wrappers prevent any later request after cancellation.
        ip = await Promise.race([recovery.startVM(name), cancelled]);
      } finally {
        candidateActive = false;
        signal.removeEventListener('abort', onAbort);
      }
      signal.throwIfAborted();
      if (!ip)
        throw new Error(
          `Candidate restart returned null on attempt ${attempt}`,
        );
      const after = observation(await read());
      report('after-candidate', {
        attempt,
        ip,
        failedAllocationStarted,
        ...after,
      });
      if (
        after.vmId !== original.vmId ||
        // ARM can change resource-group casing after start. Keep the provider's
        // raw values in the trace and compare its case-insensitive resource IDs.
        after.osDiskId?.toLowerCase() !== original.osDiskId.toLowerCase()
      ) {
        throw new Error(
          'Candidate recovery changed Azure VM or OS disk identity',
        );
      }
      await runGuestCommand(
        `verify-marker-${attempt}`,
        'set -eu; sha256sum /var/lib/anycloud-restart-qualification',
        markerDigest,
      );
      report('guest-marker-confirmed', { attempt, failedAllocationStarted });
      if (failedAllocationStarted) {
        exercised = true;
        break;
      }
    }
    if (!exercised)
      throw new Error(
        `Failed allocation was not exercised in ${attempts} attempts`,
      );
    report('failed-allocation-recovery-qualified');
  } catch (error) {
    report('candidate-check-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    failures.push(error);
  } finally {
    // Cleanup uses a separate deadline so a cancelled qualification cannot
    // cancel teardown of the fixture's uniquely owned resource group.
    controller.abort();
    try {
      await cleanup(resources, group, suffix);
    } catch (error) {
      report('cleanup-failed', {
        group,
        error: error instanceof Error ? error.message : String(error),
      });
      failures.push(error);
    }
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      failures
        .map((error) =>
          error instanceof Error ? error.message : String(error),
        )
        .join('; '),
    );
  }
}

run({ now: () => Date.now(), wait: sleep }).catch((error) => {
  report('qualification-failed', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});

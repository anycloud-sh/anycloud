#!/usr/bin/env tsx
/**
 * Live experiment: when a spot VM is evicted and we ask Azure to start it
 * again while the eviction is still settling, does ARM drop that start, or
 * does it accept the start and merely lag its instance view?
 *
 * The experiment intentionally calls the Azure ARM SDK directly. Its purpose
 * is to establish a provider fact before changing production recovery code.
 * `Azure.startVM` currently gives up the moment one instance-view read
 * reports `powerState=deallocated`, and the CI artifacts cannot distinguish
 * the two explanations because the VM is torn down 0.4s later.
 *
 * Arm A reproduces production: start as soon as the power state leaves
 * `running`, exactly as the e2e harness and the reconciler do. Arm B is the
 * control: wait for the eviction to settle first. Arm C repeats arm A and
 * re-issues the start once, to size a possible retry fix.
 */
import { ComputeManagementClient } from '@azure/arm-compute';
import type { VirtualMachine } from '@azure/arm-compute';
import { NetworkManagementClient } from '@azure/arm-network';
import { ResourceManagementClient } from '@azure/arm-resources';
import { DefaultAzureCredential } from '@azure/identity';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const ARM_SCOPE = 'https://management.azure.com/.default';
const ARM_ENDPOINT = 'https://management.azure.com';

const DEFAULT_REGION = 'austriaeast';
const DEFAULT_VM_SIZE = 'Standard_D2s_v5';
const DEFAULT_REPETITIONS = 5;

// Mirrors test/integration/helpers/azure-blob.sh stop_azure_vm, which returns
// as soon as the power state is anything other than running — that is what
// hands the reconciler a mid-eviction VM in production.
const EVICTION_WATCH_INTERVAL_MS = 1_000;
const EVICTION_WATCH_TIMEOUT_MS = 180_000;

// Deliberately longer than the 5 minutes Azure.startVM budgets, so a VM that
// would have converged late is still observed converging.
const RECOVERY_POLL_INTERVAL_MS = 2_000;
const DEFAULT_OBSERVE_SECONDS = 600;
const AZURE_START_BUDGET_SECONDS = 300;

// Arm B waits for this many consecutive settled reads before starting.
const SETTLED_READS_REQUIRED = 3;

// Arm C re-issues the start after this long without a running power state.
const REISSUE_AFTER_MS = 60_000;

const RUNNING_WAIT_TIMEOUT_MS = 10 * 60_000;

type ArmName = 'A' | 'B' | 'C';

type RepetitionOutcome =
  | 'recovered'
  | 'recovered-after-reissue'
  | 'stuck-deallocated'
  | 'start-rejected'
  | 'aborted';

interface InstanceViewRead {
  /** Milliseconds since the repetition began. */
  atMs: number;
  powerState: string | null;
  provisioningState: string | null;
  /**
   * True when the instance view carried no PowerState status at all. The
   * production parser reports this identically to a transient power state,
   * which is one of the ambiguities this experiment exists to remove.
   */
  powerStateAbsent: boolean;
}

interface StartAttempt {
  issuedAtMs: number;
  /** Wall time the beginStart long-running operation took to report done. */
  lroDurationMs: number | null;
  error: string | null;
  /** Power state observed immediately before the start was issued. */
  powerStateAtIssue: string | null;
}

interface Repetition {
  arm: ArmName;
  index: number;
  outcome: RepetitionOutcome;
  /** Time from the start request to the first running read, when it happened. */
  recoveredAfterMs: number | null;
  starts: StartAttempt[];
  trace: InstanceViewRead[];
  note: string | null;
}

interface ActivityLogEntry {
  eventTimestamp: string | null;
  operationName: string | null;
  status: string | null;
  caller: string | null;
  resourceId: string | null;
}

interface SpikeConfig {
  subscriptionId: string;
  region: string;
  vmSize: string;
  repetitions: number;
  arms: ArmName[];
  observeMs: number;
  outputPath: string;
  runId: string;
}

function report(event: string, detail: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ...detail }));
}

function readConfig(): SpikeConfig {
  const subscriptionId = process.env.AZURE_SUBSCRIPTION_ID;
  if (!subscriptionId) {
    throw new Error(
      'AZURE_SUBSCRIPTION_ID is required. In CI it comes from the repository secret of the same name; locally an `az login` session also needs it set.',
    );
  }
  const repetitionsRaw =
    process.env.ANYCLOUD_SPOT_RACE_REPETITIONS ?? String(DEFAULT_REPETITIONS);
  const repetitions = Number.parseInt(repetitionsRaw, 10);
  if (!Number.isFinite(repetitions) || repetitions < 1) {
    throw new Error(
      `ANYCLOUD_SPOT_RACE_REPETITIONS must be a positive integer, got "${repetitionsRaw}"`,
    );
  }

  const armsRaw = process.env.ANYCLOUD_SPOT_RACE_ARMS ?? 'A,B,C';
  const arms: ArmName[] = [];
  for (const entry of armsRaw.split(',')) {
    const name = entry.trim().toUpperCase();
    if (name === 'A' || name === 'B' || name === 'C') {
      arms.push(name);
      continue;
    }
    if (name.length > 0) {
      throw new Error(
        `ANYCLOUD_SPOT_RACE_ARMS accepts A, B and C, got "${entry.trim()}"`,
      );
    }
  }
  if (arms.length === 0) {
    throw new Error('ANYCLOUD_SPOT_RACE_ARMS selected no arms');
  }

  const observeRaw =
    process.env.ANYCLOUD_SPOT_RACE_OBSERVE_SECONDS ??
    String(DEFAULT_OBSERVE_SECONDS);
  const observeSeconds = Number.parseInt(observeRaw, 10);
  if (!Number.isFinite(observeSeconds) || observeSeconds < 1) {
    throw new Error(
      `ANYCLOUD_SPOT_RACE_OBSERVE_SECONDS must be a positive integer, got "${observeRaw}"`,
    );
  }
  if (observeSeconds <= AZURE_START_BUDGET_SECONDS) {
    // Observing for no longer than production waits could not tell a late
    // convergence from no convergence, which is the whole question.
    throw new Error(
      `ANYCLOUD_SPOT_RACE_OBSERVE_SECONDS must exceed the ${AZURE_START_BUDGET_SECONDS}s Azure.startVM budget, got ${observeSeconds}`,
    );
  }

  return {
    subscriptionId,
    region: process.env.ANYCLOUD_SPOT_RACE_REGION ?? DEFAULT_REGION,
    vmSize: process.env.ANYCLOUD_SPOT_RACE_VM_SIZE ?? DEFAULT_VM_SIZE,
    repetitions,
    arms,
    observeMs: observeSeconds * 1_000,
    outputPath:
      process.env.ANYCLOUD_SPOT_RACE_OUTPUT ?? './azure-spot-restart-race.json',
    runId: randomBytes(4).toString('hex'),
  };
}

/**
 * Azure requires Linux admin credentials at creation time even when nothing
 * ever logs in. A random password avoids carrying an SSH key through the
 * experiment; it is never printed and dies with the resource group.
 */
function generateAdminPassword(): string {
  return `Ac1!${randomBytes(24).toString('base64url').slice(0, 28)}`;
}

interface ParsedInstanceView {
  powerState: string | null;
  provisioningState: string | null;
  powerStateAbsent: boolean;
}

class SpikeRunner {
  private readonly compute: ComputeManagementClient;
  private readonly network: NetworkManagementClient;
  private readonly resources: ResourceManagementClient;
  private readonly credential: DefaultAzureCredential;
  private readonly resourceGroup: string;
  private readonly vmName: string;

  constructor(private readonly config: SpikeConfig) {
    this.credential = new DefaultAzureCredential();
    this.compute = new ComputeManagementClient(
      this.credential,
      config.subscriptionId,
    );
    this.network = new NetworkManagementClient(
      this.credential,
      config.subscriptionId,
    );
    this.resources = new ResourceManagementClient(
      this.credential,
      config.subscriptionId,
    );
    this.resourceGroup = `anycloud-spot-restart-spike-${config.runId}`;
    this.vmName = `spot-race-${config.runId}`;
  }

  get groupName(): string {
    return this.resourceGroup;
  }

  async provision(): Promise<void> {
    const { region, vmSize } = this.config;
    report('provision-start', {
      resourceGroup: this.resourceGroup,
      vm: this.vmName,
      region,
      vmSize,
    });

    await this.resources.resourceGroups.createOrUpdate(this.resourceGroup, {
      location: region,
      tags: { 'anycloud:spot-restart-spike': this.config.runId },
    });

    const vnet = await this.network.virtualNetworks.beginCreateOrUpdateAndWait(
      this.resourceGroup,
      `${this.vmName}-vnet`,
      {
        location: region,
        addressSpace: { addressPrefixes: ['10.42.0.0/16'] },
        subnets: [{ name: 'default', addressPrefix: '10.42.0.0/24' }],
      },
    );
    const subnetId = vnet.subnets?.[0]?.id;
    if (!subnetId) throw new Error('Azure returned a VNet with no subnet id');

    // No public IP: the experiment never connects to the VM, it only reads
    // control-plane state, so the NIC stays private.
    const nic = await this.network.networkInterfaces.beginCreateOrUpdateAndWait(
      this.resourceGroup,
      `${this.vmName}-nic`,
      {
        location: region,
        ipConfigurations: [
          {
            name: 'primary',
            subnet: { id: subnetId },
            privateIPAllocationMethod: 'Dynamic',
          },
        ],
      },
    );
    if (!nic.id) throw new Error('Azure returned a NIC with no id');

    const parameters: VirtualMachine = {
      location: region,
      hardwareProfile: { vmSize },
      // Spot with Deallocate is what production requests (azure.ts:3411-3414);
      // an evicted VM therefore still exists and is restartable.
      priority: 'Spot',
      evictionPolicy: 'Deallocate',
      billingProfile: { maxPrice: -1 },
      osProfile: {
        computerName: this.vmName,
        adminUsername: 'anycloud',
        adminPassword: generateAdminPassword(),
        linuxConfiguration: { disablePasswordAuthentication: false },
      },
      storageProfile: {
        imageReference: {
          publisher: 'canonical',
          // service-terminology-ok: Azure owns this marketplace SKU spelling
          offer: 'ubuntu-24_04-lts',
          sku: 'server',
          version: 'latest',
        },
        osDisk: {
          createOption: 'FromImage',
          managedDisk: { storageAccountType: 'Premium_LRS' },
        },
      },
      networkProfile: {
        networkInterfaces: [{ id: nic.id, primary: true }],
      },
    };

    await this.compute.virtualMachines.beginCreateOrUpdateAndWait(
      this.resourceGroup,
      this.vmName,
      parameters,
    );
    await this.waitForRunning();
    report('provision-complete', { vm: this.vmName });
  }

  private async readInstanceView(): Promise<ParsedInstanceView> {
    const vm = await this.compute.virtualMachines.get(
      this.resourceGroup,
      this.vmName,
      { expand: 'instanceView' },
    );
    let powerState: string | null = null;
    let provisioningState = vm.provisioningState?.toLowerCase() ?? null;
    for (const status of vm.instanceView?.statuses ?? []) {
      const [kind, state] = status.code?.split('/') ?? [];
      if (!kind || !state) continue;
      if (kind.toLowerCase() === 'powerstate') {
        powerState = state.toLowerCase();
      } else if (kind.toLowerCase() === 'provisioningstate') {
        provisioningState = state.toLowerCase();
      }
    }
    return {
      powerState,
      provisioningState,
      powerStateAbsent: powerState === null,
    };
  }

  private async waitForRunning(): Promise<void> {
    const deadline = Date.now() + RUNNING_WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const view = await this.readInstanceView();
      if (view.powerState === 'running') return;
      await delay(RECOVERY_POLL_INTERVAL_MS);
    }
    throw new Error(
      `VM ${this.vmName} did not reach running within ${RUNNING_WAIT_TIMEOUT_MS}ms`,
    );
  }

  /** Bring the VM back to running between repetitions. */
  private async resetToRunning(): Promise<void> {
    const view = await this.readInstanceView();
    if (view.powerState === 'running') return;
    report('reset-start', { powerState: view.powerState });
    const poller = await this.compute.virtualMachines.beginStart(
      this.resourceGroup,
      this.vmName,
    );
    await poller.pollUntilDone();
    await this.waitForRunning();
    report('reset-complete');
  }

  private async issueStart(startedAt: number): Promise<StartAttempt> {
    const view = await this.readInstanceView();
    const issuedAt = Date.now();
    const attempt: StartAttempt = {
      issuedAtMs: issuedAt - startedAt,
      lroDurationMs: null,
      error: null,
      powerStateAtIssue: view.powerState,
    };
    try {
      const poller = await this.compute.virtualMachines.beginStart(
        this.resourceGroup,
        this.vmName,
      );
      await poller.pollUntilDone();
      attempt.lroDurationMs = Date.now() - issuedAt;
    } catch (error) {
      attempt.error = error instanceof Error ? error.message : String(error);
      attempt.lroDurationMs = Date.now() - issuedAt;
    }
    report('start-issued', {
      powerStateAtIssue: attempt.powerStateAtIssue,
      lroDurationMs: attempt.lroDurationMs,
      error: attempt.error,
    });
    return attempt;
  }

  /** Evict, then return once the power state has left `running`. */
  private async evictAndWatch(
    startedAt: number,
    trace: InstanceViewRead[],
  ): Promise<boolean> {
    await this.compute.virtualMachines.simulateEviction(
      this.resourceGroup,
      this.vmName,
    );
    report('eviction-requested');
    const deadline = Date.now() + EVICTION_WATCH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const view = await this.readInstanceView();
      trace.push({ atMs: Date.now() - startedAt, ...view });
      if (view.powerState !== 'running') {
        report('eviction-observed', { powerState: view.powerState });
        return true;
      }
      await delay(EVICTION_WATCH_INTERVAL_MS);
    }
    return false;
  }

  /** Wait for consecutive identical non-running reads before returning. */
  private async awaitSettled(
    startedAt: number,
    trace: InstanceViewRead[],
  ): Promise<boolean> {
    const deadline = Date.now() + EVICTION_WATCH_TIMEOUT_MS;
    let consecutive = 0;
    while (Date.now() < deadline) {
      const view = await this.readInstanceView();
      trace.push({ atMs: Date.now() - startedAt, ...view });
      if (view.powerState === 'deallocated' || view.powerState === 'stopped') {
        consecutive++;
        if (consecutive >= SETTLED_READS_REQUIRED) return true;
      } else {
        consecutive = 0;
      }
      await delay(EVICTION_WATCH_INTERVAL_MS);
    }
    return false;
  }

  async runRepetition(arm: ArmName, index: number): Promise<Repetition> {
    const startedAt = Date.now();
    const trace: InstanceViewRead[] = [];
    const starts: StartAttempt[] = [];
    report('repetition-start', { arm, index });

    await this.resetToRunning();

    const evicted = await this.evictAndWatch(startedAt, trace);
    if (!evicted) {
      return {
        arm,
        index,
        outcome: 'aborted',
        recoveredAfterMs: null,
        starts,
        trace,
        note: 'VM never left running after simulateEviction',
      };
    }

    if (arm === 'B') {
      const settled = await this.awaitSettled(startedAt, trace);
      if (!settled) {
        return {
          arm,
          index,
          outcome: 'aborted',
          recoveredAfterMs: null,
          starts,
          trace,
          note: 'power state never settled within the eviction watch budget',
        };
      }
    }

    const firstStart = await this.issueStart(startedAt);
    starts.push(firstStart);

    const startIssuedAt = Date.now();
    // Measure recovery from when the start request was actually sent, not from
    // when its long-running operation reported done — beginStart's poller can
    // sit for a full 30s interval, and timing from after it hides the whole
    // restart latency behind a near-zero number.
    const firstRequestAt = startedAt + firstStart.issuedAtMs;
    const observeDeadline = startIssuedAt + this.config.observeMs;
    let reissued = false;
    while (Date.now() < observeDeadline) {
      const view = await this.readInstanceView();
      trace.push({ atMs: Date.now() - startedAt, ...view });
      if (view.powerState === 'running') {
        const recoveredAfterMs = Date.now() - firstRequestAt;
        report('recovered', { arm, index, recoveredAfterMs, reissued });
        return {
          arm,
          index,
          outcome: reissued ? 'recovered-after-reissue' : 'recovered',
          recoveredAfterMs,
          starts,
          trace,
          note: null,
        };
      }
      if (
        arm === 'C' &&
        !reissued &&
        Date.now() - startIssuedAt >= REISSUE_AFTER_MS
      ) {
        report('reissuing-start', { arm, index });
        starts.push(await this.issueStart(startedAt));
        reissued = true;
      }
      await delay(RECOVERY_POLL_INTERVAL_MS);
    }

    const outcome: RepetitionOutcome =
      firstStart.error !== null && starts.every((s) => s.error !== null)
        ? 'start-rejected'
        : 'stuck-deallocated';
    report('not-recovered', { arm, index, outcome });
    return {
      arm,
      index,
      outcome,
      recoveredAfterMs: null,
      starts,
      trace,
      note: null,
    };
  }

  /**
   * The management activity log is what pins the ordering of our start
   * against Azure's own eviction — the API logs from the failing CI run could
   * not show that.
   */
  async fetchActivityLog(since: Date): Promise<ActivityLogEntry[]> {
    const token = await this.credential.getToken(ARM_SCOPE);
    if (!token) return [];
    const filter = [
      `eventTimestamp ge '${since.toISOString()}'`,
      `resourceGroupName eq '${this.resourceGroup}'`,
    ].join(' and ');
    const url =
      `${ARM_ENDPOINT}/subscriptions/${this.config.subscriptionId}` +
      `/providers/Microsoft.Insights/eventtypes/management/values` +
      `?api-version=2015-04-01&$filter=${encodeURIComponent(filter)}`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token.token}` },
    });
    if (!response.ok) {
      report('activity-log-unavailable', { status: response.status });
      return [];
    }
    const body: unknown = await response.json();
    if (
      typeof body !== 'object' ||
      body === null ||
      !('value' in body) ||
      !Array.isArray(body.value)
    ) {
      return [];
    }
    const entries: ActivityLogEntry[] = [];
    for (const raw of body.value) {
      if (typeof raw !== 'object' || raw === null) continue;
      const record: Record<string, unknown> = { ...raw };
      const operation = record.operationName;
      const status = record.status;
      entries.push({
        eventTimestamp:
          typeof record.eventTimestamp === 'string'
            ? record.eventTimestamp
            : null,
        operationName:
          typeof operation === 'object' &&
          operation !== null &&
          'value' in operation &&
          typeof operation.value === 'string'
            ? operation.value
            : null,
        status:
          typeof status === 'object' &&
          status !== null &&
          'value' in status &&
          typeof status.value === 'string'
            ? status.value
            : null,
        caller: typeof record.caller === 'string' ? record.caller : null,
        resourceId:
          typeof record.resourceId === 'string' ? record.resourceId : null,
      });
    }
    return entries;
  }

  async cleanup(): Promise<string | null> {
    report('cleanup-start', { resourceGroup: this.resourceGroup });
    try {
      // Group-scoped deletion is the only teardown that cannot leave an
      // orphaned disk, NIC or VNet behind if the run dies mid-repetition.
      await this.resources.resourceGroups.beginDeleteAndWait(
        this.resourceGroup,
      );
      report('cleanup-complete', { resourceGroup: this.resourceGroup });
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report('cleanup-failed', {
        resourceGroup: this.resourceGroup,
        error: message,
      });
      return message;
    }
  }
}

function summarize(repetitions: Repetition[], arm: ArmName): string {
  const rows = repetitions.filter((r) => r.arm === arm);
  if (rows.length === 0) return `${arm}: not run`;
  const recovered = rows.filter(
    (r) => r.outcome === 'recovered' || r.outcome === 'recovered-after-reissue',
  );
  const times = recovered
    .map((r) => r.recoveredAfterMs)
    .filter((value): value is number => value !== null);
  const median =
    times.length > 0
      ? [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)]
      : null;
  return (
    `${arm}: ${recovered.length}/${rows.length} recovered` +
    (median === null ? '' : `, median ${Math.round(median / 1000)}s`)
  );
}

const SETTLED_POWER_STATES = new Set(['deallocated', 'stopped']);

/**
 * Did this individual start request take effect? True when the VM reached
 * running before the next start request was issued.
 */
function startTookEffect(repetition: Repetition, index: number): boolean {
  const start = repetition.starts[index];
  const next = repetition.starts[index + 1];
  const until = next ? next.issuedAtMs : Number.POSITIVE_INFINITY;
  return repetition.trace.some(
    (read) =>
      read.powerState === 'running' &&
      read.atMs > start.issuedAtMs &&
      read.atMs < until,
  );
}

/**
 * Turn the results into the decision the experiment exists to make. Each
 * branch names the fix it selects for Azure.startVM.
 *
 * The causal variable is the power state at the moment the start was issued,
 * not the arm: an arm A repetition can happen to catch an already-settled VM
 * and succeed, so arm-level rates blur exactly the boundary being measured.
 */
function verdict(repetitions: Repetition[]): string {
  let settledOk = 0;
  let settledTotal = 0;
  let unsettledOk = 0;
  let unsettledTotal = 0;
  for (const repetition of repetitions) {
    for (let index = 0; index < repetition.starts.length; index++) {
      const at = repetition.starts[index].powerStateAtIssue;
      const worked = startTookEffect(repetition, index);
      if (at !== null && SETTLED_POWER_STATES.has(at)) {
        settledTotal++;
        if (worked) settledOk++;
      } else {
        unsettledTotal++;
        if (worked) unsettledOk++;
      }
    }
  }
  const counts = `settled ${settledOk}/${settledTotal}, unsettled ${unsettledOk}/${unsettledTotal}`;
  if (settledTotal === 0 || unsettledTotal === 0) {
    return `INCONCLUSIVE: one condition was never sampled (${counts}). Run more repetitions.`;
  }

  const settledRate = settledOk / settledTotal;
  const unsettledRate = unsettledOk / unsettledTotal;

  if (settledRate < 0.8) {
    return `INCONCLUSIVE / CAPACITY: starts issued against an already-settled VM also failed (${counts}), so restarts are limited by spot capacity rather than by a status race. Failing fast is defensible and the e2e in-place assertion is what should change.`;
  }
  if (unsettledRate >= 0.8) {
    return `HYPOTHESIS (a) STALE READ: starts issued mid-eviction do take effect (${counts}). Fix Azure.startVM by tolerating deallocated reads in the post-start poll instead of throwing on the first one; size the tolerance from the traces.`;
  }
  if (unsettledRate <= 0.2) {
    // Only arm C re-issues, so a run without it has no evidence either way.
    // Saying "re-issuing does not help" when it was never attempted would put
    // an unsupported claim in the artifact.
    const reissueAttempted = repetitions.some((r) => r.starts.length > 1);
    const reissuesWorked = repetitions.some(
      (r) => r.outcome === 'recovered-after-reissue',
    );
    if (!reissueAttempted) {
      return `HYPOTHESIS (b) SUPERSEDED START: a start issued before the eviction settles is silently lost (${counts}). Fix with a pre-start settle fence. Whether a bounded re-issue also recovers it was NOT tested — arm C did not run.`;
    }
    if (reissuesWorked) {
      return `HYPOTHESIS (b) SUPERSEDED START, RECOVERABLE: a start issued before the eviction settles is silently lost (${counts}), but re-issuing it once the VM is deallocated works. Fix with a pre-start settle fence plus one bounded re-issue.`;
    }
    return `HYPOTHESIS (b) SUPERSEDED START: a start issued before the eviction settles is silently lost (${counts}) and re-issuing does not help. Fix with a pre-start settle fence so beginStart is never called before the power state settles.`;
  }
  return `MIXED: starts issued mid-eviction neither reliably took effect nor reliably failed (${counts}). Inspect the traces before choosing a fix; consider more repetitions.`;
}

async function main(): Promise<void> {
  const config = readConfig();
  const runner = new SpikeRunner(config);
  const startedAt = new Date();

  report('start', {
    runId: config.runId,
    region: config.region,
    vmSize: config.vmSize,
    arms: config.arms,
    repetitions: config.repetitions,
  });

  let interruptedSignal: string | null = null;
  const interrupt = (signal: string) => {
    interruptedSignal = signal;
    report('interrupted', { signal });
  };
  const onSigint = () => interrupt('SIGINT');
  const onSigterm = () => interrupt('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);

  const repetitions: Repetition[] = [];
  let runError: unknown;
  try {
    await runner.provision();
    for (const arm of config.arms) {
      for (let index = 1; index <= config.repetitions; index++) {
        if (interruptedSignal) break;
        repetitions.push(await runner.runRepetition(arm, index));
      }
      if (interruptedSignal) break;
    }
  } catch (error) {
    runError = error;
    report('run-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  }

  let activityLog: ActivityLogEntry[] = [];
  try {
    activityLog = await runner.fetchActivityLog(startedAt);
  } catch (error) {
    report('activity-log-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const decision = verdict(repetitions);
  const artifact = {
    runId: config.runId,
    startedAt: startedAt.toISOString(),
    region: config.region,
    vmSize: config.vmSize,
    resourceGroup: runner.groupName,
    repetitions,
    activityLog,
    verdict: decision,
  };
  writeFileSync(config.outputPath, `${JSON.stringify(artifact, null, 2)}\n`);
  report('artifact-written', { path: config.outputPath });

  for (const arm of config.arms) {
    report('summary', { line: summarize(repetitions, arm) });
  }
  report('verdict', { decision });

  const cleanupError = await runner.cleanup();

  if (interruptedSignal) {
    throw new Error(
      `Azure spot restart spike interrupted by ${interruptedSignal}`,
    );
  }
  if (runError) throw runError;
  if (cleanupError) {
    throw new Error(
      `Azure spot restart spike cleanup failed, resource group ${runner.groupName} may survive: ${cleanupError}`,
    );
  }
}

void main().catch((error) => {
  console.error(
    `AZURE_SPOT_RESTART_SPIKE failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
});

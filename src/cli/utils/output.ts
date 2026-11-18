import chalk from 'chalk';
import ora, { type Ora } from 'ora';
import {
  type WorkloadListRow as StoredWorkload,
  type StatusWorkloadMetadata,
  type WorkloadStatusResponse,
} from '../../shared/api-contract/workload-management-schemas.js';
import {
  WorkloadState,
  stateEmoji,
  isTerminalState,
  isReleasingResources,
} from '../../shared/workload.js';
import { workloadRequestsManagedHttpIngress } from '../../shared/workload-behavior.js';
import { DEFAULT_DISK_TIER } from '../../shared/cloud-config.js';
import { formatSessionDisplay } from '../../shared/session-display.js';
import { formatAge, formatDurationCompact } from './duration.js';
import { RELEASING_LABELS, awaitingReleaseSuffix } from './releasing.js';
import { componentLine } from '../renderers/component-line.js';
import { isUnattended } from '../session/detect.js';

// Console output helpers with colors

// When JSON mode is enabled, all human-facing chrome (info/success/warning/
// section/highlight) routes to stderr so stdout is left clean for the JSON
// payload. Errors already go to stderr regardless.
let jsonMode = false;

export function setJsonMode(enabled: boolean): void {
  jsonMode = enabled;
}

export function isJsonMode(): boolean {
  return jsonMode;
}

function chromeOut(message: string): void {
  if (jsonMode) {
    console.error(message);
  } else {
    console.log(message);
  }
}

export function printSuccess(message: string): void {
  chromeOut(chalk.green(`   ✓ ${message}`));
}

export function printError(message: string): void {
  // Continuation lines align under the first line's text.
  console.error(chalk.red(`   ✗ ${message.replace(/\n/g, '\n     ')}`));
}

export function printInfo(message: string): void {
  chromeOut(chalk.dim(`   ${message}`));
}

export function printWarning(message: string, alwaysStderr = false): void {
  const formatted = chalk.yellow(`   ⚠ ${message}`);
  if (alwaysStderr) {
    console.error(formatted);
    return;
  }
  chromeOut(formatted);
}

export function printHighlight(message: string): void {
  chromeOut(chalk.cyan(`   ${message}`));
}

export function exitWithError(message: string, code: number = 1): never {
  printError(message);
  process.exit(code);
}

/** What a human must do before a non-interactive command can go on. */
export interface ActionRequired {
  code:
    | 'GITHUB_SIGN_IN_REQUIRED'
    | 'CLOUD_ADMIN_REQUIRED'
    | 'CLOUD_SIGN_IN_REQUIRED';
  /** What to relay to the human. */
  message: string;
  url?: string;
  userCode?: string;
  expiresAt?: string;
  /** The command that does it, when one does (`gcloud auth login`). */
  command?: string;
}

/**
 * Print `{"actionRequired": ...}` on stdout for the agent to relay, then exit.
 * A person at a terminal whose stdout is redirected sees the message too.
 */
export function exitWithActionRequired(
  action: ActionRequired,
  code: number = 1,
): never {
  if (process.stderr.isTTY && !process.stdout.isTTY) {
    printWarning(action.message, true);
  }
  console.log(JSON.stringify({ actionRequired: action }));
  process.exit(code);
}

/** Unattended, relay an error tagged `CLOUD_ADMIN_REQUIRED` instead of failing. */
export function exitIfActionRequired(error: unknown): void {
  const { code, message } = (error ?? {}) as {
    code?: unknown;
    message: string;
  };
  if (code === 'CLOUD_ADMIN_REQUIRED' && isUnattended()) {
    exitWithActionRequired({ code, message });
  }
}

/**
 * Create a spinner for long-running operations
 */
export function createSpinner(text: string): Ora {
  return ora({
    text,
    color: 'cyan',
    // Suppress all spinner chrome when stdout isn't an interactive terminal
    // (CI, pipes, redirects) or in JSON mode. Otherwise a polled command — e.g.
    // `status` called in a loop by the e2e harness — floods the captured log
    // with one "Fetching status..." frame per call.
    isSilent: jsonMode || !process.stdout.isTTY,
  });
}

/**
 * Color a percent value (0–100) by usage threshold: green <70, yellow 70–<90,
 * red ≥90. Returns a formatted string like "  3%" / " 42%" / "97%" right-
 * aligned to width 3.
 */
export function formatPercentColored(pct: number): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const text = `${Math.round(clamped).toString().padStart(2, ' ')}%`;
  if (clamped >= 90) return chalk.red(text);
  if (clamped >= 70) return chalk.yellow(text);
  return chalk.green(text);
}

/**
 * Render a 10-cell (default) progress bar for a percent (0–100). TTY-only
 * decoration — non-TTY callers should omit this column entirely. Colored to
 * match the threshold used by `formatPercentColored`.
 */
export function renderBar(percent: number, width: number = 10): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  if (clamped >= 90) return chalk.red(bar);
  if (clamped >= 70) return chalk.yellow(bar);
  return chalk.green(bar);
}

/**
 * Format a calendar-window reset timestamp as a friendly relative phrase
 * ("in 42m", "in 8h", "in 3d"). Falls back to an absolute UTC date for resets
 * more than a week away. Pure display — never parse back.
 */
export function formatResetRelative(endMs: number): string {
  const diffMs = endMs - Date.now();
  if (diffMs <= 0) return 'now';
  const m = Math.floor(diffMs / 60000);
  const h = Math.floor(diffMs / 3600000);
  const d = Math.floor(diffMs / 86400000);
  if (m < 60) return `in ${m}m`;
  if (h < 24) return `in ${h}h`;
  if (d < 7) return `in ${d}d`;
  const dt = new Date(endMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())} UTC`;
}

export function formatCurrency(amount: number): string {
  const fixed = amount.toFixed(2);
  const [whole, decimal] = fixed.split('.');
  const withCommas = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `$${withCommas}.${decimal}`;
}

/**
 * Extract org and image name from a full image URI
 * e.g., "ghcr.io/org/myapp:v2" → "org/myapp:v2"
 */
export function formatImageName(image: string): string {
  // Remove registry prefix, keep org/image:tag
  const parts = image.split('/');
  if (parts.length >= 3) {
    // ghcr.io/org/image:tag → org/image:tag
    return parts.slice(1).join('/');
  }
  // Fallback: return last part
  return parts[parts.length - 1];
}

/** `AWS / us-east-1 (zone us-east-1a)`: one location format for every resource. */
export function formatLocation(
  cloud: string,
  region: string | null | undefined,
  zone?: string | null,
): string {
  return `${cloud}${region ? ` / ${region}` : ''}${zone ? ` (zone ${zone})` : ''}`;
}

/**
 * Dim, aligned `label  value` lines, as `status` prints a Workload. Indented
 * like printInfo and printSuccess, so fields line up with the lines around
 * them.
 */
export function printFields(lines: Array<[string, string]>): void {
  const maxLabelLen = Math.max(...lines.map(([label]) => label.length));
  lines.forEach(([label, value]) => {
    console.log(`   ${chalk.dim(label.padEnd(maxLabelLen))}  ${value}`);
  });
}

/**
 * The emoji and state line that opens `status`. A tombstone on its own reads
 * as "spend stopped", so `releasing` says the VMs are still up and billing.
 */
export function printStateHeader(
  state: WorkloadState | 'unknown',
  releasing = false,
  releasingLabel: string = RELEASING_LABELS.state,
): void {
  const suffix = releasing ? chalk.yellow(releasingLabel) : '';
  console.log('');
  console.log(
    `${state === 'unknown' ? '❓' : stateEmoji[state]}  ${state}${suffix}`,
  );
  console.log('');
}

/** The `Upgrade N · <target>` entry and its component line in `status`. */
export function printUpgrade(
  upgrade: { number: number; state: WorkloadState },
  target: string,
  label: string,
  detail: string,
): void {
  console.log('');
  console.log(`   Upgrade ${upgrade.number} · ${target}`);
  console.log(
    `   ${componentLine(
      label,
      upgrade.state === WorkloadState.Running,
      upgrade.state === WorkloadState.Starting,
      `${upgrade.state}${detail}`,
    )}`,
  );
}

export function printWorkloadHeader(
  workload: StatusWorkloadMetadata,
  options?: {
    verbose?: boolean;
    checkpoint?: WorkloadStatusResponse['checkpoint'];
  },
): void {
  printStateHeader(workload.state, isReleasingResources(workload));

  // Build info lines (skip ID - already shown in selection)
  const lines: Array<[string, string]> = [];

  if (workload.image !== null) {
    lines.push(['Image', formatImageName(workload.image)]);
  }

  if (workload.cloudProvider) {
    lines.push([
      'Cloud',
      formatLocation(
        workload.cloudProvider,
        workload.region,
        workload.availabilityZone,
      ),
    ]);
  }
  if (workload.endReason) {
    lines.push([
      'End reason',
      workload.lastAttemptEndReason
        ? `${workload.endReason} (last attempt: ${workload.lastAttemptEndReason})`
        : workload.endReason,
    ]);
  }

  if (workload.gpuType || workload.vmType) {
    const rawType = workload.gpuType || workload.vmType;
    const typeDisplay = Array.isArray(rawType) ? rawType.join(', ') : rawType;
    lines.push(['VM', typeDisplay!]);
  }

  // Why the tombstone is still releasing: the cleanup lane's last failure,
  // which used to live only in the API log.
  if (
    isTerminalState(workload.state) &&
    (workload.cleanedAt === undefined || workload.cleanedAt === null) &&
    workload.cleanupError
  ) {
    lines.push(['Cleanup pending', chalk.yellow(workload.cleanupError)]);
  }

  lines.push(['Spot', workload.spot ? 'yes' : 'no']);
  lines.push([
    'Disk Size',
    workload.diskSizeGb == null ? 'default' : `${workload.diskSizeGb} GB`,
  ]);
  if (workload.diskTier && workload.diskTier !== DEFAULT_DISK_TIER) {
    lines.push(['Disk Tier', workload.diskTier]);
  }

  if (workload.version) {
    // Recorded from the submitting client, once, at creation — it does not
    // track the API that ran or tore down the workload, and labelling it
    // "Version" invited exactly that misreading.
    lines.push(['CLI Version', workload.version]);
  }

  if (
    workloadRequestsManagedHttpIngress(workload.workloadType) &&
    workload.dnsRecordId
  ) {
    lines.push(['URL', `https://${workload.id}.anycloud.sh`]);
  }

  const sessionDisplay = formatSessionDisplay(workload);
  if (sessionDisplay) {
    lines.push(['Session', sessionDisplay]);
  }

  if (workload.inputBucket) {
    lines.push(['Input Bucket', workload.inputBucket]);
  }

  if (workload.outputBucket) {
    lines.push(['Output Bucket', workload.outputBucket]);
  }

  const checkpoint = options?.checkpoint;
  if (checkpoint) {
    lines.push([
      'Checkpoint',
      `${checkpoint.bucket} → ${checkpoint.mount} (${checkpoint.retained ? 'retained' : 'deleted at cleanup'})`,
    ]);
  }

  // Duration/timing info
  // - For completed workloads: always show wall-clock duration
  // - For running workloads: show age since workload started
  if (workload.completedAt) {
    const duration = formatDurationCompact(
      workload.completedAt - workload.startedAt,
    );
    const completedAge = formatAge(workload.completedAt);
    lines.push(['Duration', `${duration} (ended ${completedAge} ago)`]);
  } else {
    const age = formatAge(workload.startedAt);
    lines.push(['Age', age]);
  }

  // Billable = summed VM lifetimes (created→deleted, incl. boot/sync) — what
  // the cloud charges for, not wall clock and not time in the running state.
  const billableMs = workload.vmDurationMs ?? 0;
  if (billableMs > 0) {
    // The releasing marker above vanishes once cleanup completes, so this is
    // the only place a finished workload can show that some of what it was
    // charged for was spent waiting on the provider.
    lines.push([
      'Billable',
      `${formatDurationCompact(billableMs)}${awaitingReleaseSuffix(
        workload.awaitingReleaseMs,
      )}`,
    ]);
  }

  // Reconciled billing can land on failed-provisioning rows that never count
  // toward billable time, so cost can exist without it — show it rateless.
  const totalCost = workload.totalCost ?? 0;
  if (totalCost > 0) {
    const estimated = workload.costSource === 'estimated';
    let detail = '';
    if (billableMs > 0) {
      const rate = formatCurrency(totalCost / (billableMs / 3_600_000));
      detail = chalk.dim(estimated ? ` (est. @ ${rate}/hr)` : ` (${rate}/hr)`);
    } else if (estimated) {
      detail = chalk.dim(' (est.)');
    }
    lines.push(['Cost', `${formatCurrency(totalCost)}${detail}`]);
  }

  printFields(lines);

  console.log('');

  // Docker command (only in verbose mode)
  if (options?.verbose && workload.dockerCommand) {
    console.log(chalk.dim('Docker command:'));
    console.log(chalk.dim(workload.dockerCommand));
    console.log('');
  }
}

/**
 * Format a workload for selection display (compact format).
 * All fields are in the title so autocomplete can filter on any of them.
 */
export function formatWorkloadChoice(
  workload: StoredWorkload,
  idWidth: number = 30,
  imageWidth: number = 16,
): {
  title: string;
  description: string;
  value: { id: string; state: WorkloadState };
} {
  const emoji = stateEmoji[workload.state] || '❓';
  const imageName = workloadChoiceTarget(workload);

  const cloud = (workload.cloudProvider || '').padEnd(8);
  const region = (workload.region || '').padEnd(14);
  // Include the session so the picker shows it and its autocomplete (which
  // filters on the title) can narrow by session label / agent:hash.
  const session = formatSessionDisplay(workload);
  const sessionSuffix = session ? `  ${session}` : '';
  const title = `${workload.id.padEnd(idWidth)}  ${imageName.padEnd(imageWidth)}  ${cloud}  ${region}  ${workload.state} ${emoji}${sessionSuffix}`;

  return {
    title,
    description: '',
    value: { id: workload.id, state: workload.state },
  };
}

function workloadChoiceTarget(workload: StoredWorkload): string {
  const parts = workload.image?.split('/') ?? [];
  return parts[parts.length - 1]?.split(':')[0] ?? '';
}

export function formatWorkloadChoices(workloads: StoredWorkload[]) {
  const sorted = [...workloads].sort((a, b) => {
    const aTerminal = isTerminalState(a.state) ? 1 : 0;
    const bTerminal = isTerminalState(b.state) ? 1 : 0;
    if (aTerminal !== bTerminal) return aTerminal - bTerminal;
    return b.startedAt - a.startedAt;
  });
  const idWidth = Math.max(...sorted.map((d) => d.id.length), 10);
  const imageWidth = Math.max(
    ...sorted.map((d) => workloadChoiceTarget(d).length),
    8,
  );
  return sorted.map((workload) =>
    formatWorkloadChoice(workload, idWidth, imageWidth),
  );
}

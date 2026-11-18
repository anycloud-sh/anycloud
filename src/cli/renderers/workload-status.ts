import {
  type WorkloadEvent,
  type WorkloadStatusResponse,
  type StatusWorkloadMetadata,
} from '../../shared/api-contract/workload-management-schemas.js';
import { CloudType } from '../../shared/cloud.js';
import { WorkloadState, WorkloadType } from '../../shared/workload.js';
import {
  isImagePullTelemetry,
  type ImagePullTelemetry,
} from '../../shared/image.js';
import { ContainerState, ServiceState } from '../../shared/runtime.js';
import {
  archMismatchGuidance,
  formatErrorForUser,
} from '../../shared/error-formatter.js';
import {
  DIAGNOSTIC_TAIL_CHARS,
  collectDiagnosticSections,
  diagnosticDedupeKey,
  normalizeLogText,
} from '../../shared/log-diagnostics.js';
import {
  extractErrorLines,
  sanitizeRcloneDiagnostics,
} from '../../shared/utils.js';
import { formatAge, formatDurationCompact } from '../utils/duration.js';
import { formatBytes } from '../utils/byte-progress.js';
import { componentLine } from './component-line.js';
import { gpuLines } from './gpu-health-line.js';
import { formatQuotaHint, formatRetryHint } from './workload-retry.js';
import { RELEASING_LABELS } from '../utils/releasing.js';
import type {
  WorkloadStatusSync,
  WorkloadStatusView,
} from '../use-cases/workload-status.js';

const STATUS_LOG_MAX_LINES = 120;
type StatusVm = NonNullable<WorkloadStatusResponse['vms']>[number];
type StatusRcloneService = NonNullable<
  NonNullable<StatusVm['rclone']>['output']
>;
interface StatusRenderOptions {
  verbose?: boolean;
  history?: boolean;
  /** Terminal width for wrapping; the command passes stdout's. */
  columns?: number;
}

// Wrap long lines to terminal width, preserving a prefix on continuation lines
const wrapLine = (
  line: string,
  prefix: string,
  columns: number | undefined,
): string[] => {
  const maxWidth = columns || 80;
  const available = maxWidth - prefix.length;
  if (line.length <= available) return [line];

  const lines: string[] = [];
  let remaining = line;
  while (remaining.length > available) {
    // Try to break at a space within the available width
    let breakPoint = remaining.lastIndexOf(' ', available);
    if (breakPoint <= 0) breakPoint = available; // No space found, hard break
    lines.push(remaining.slice(0, breakPoint));
    remaining = remaining.slice(breakPoint).trimStart();
  }
  if (remaining) lines.push(remaining);
  return lines;
};

function formatErrorDetail(error: unknown, cloud: CloudType | null): string {
  const errorStr = formatErrorForUser(error, cloud);
  const seen = new Set([diagnosticDedupeKey(errorStr)]);
  const details: string[] = [];
  for (const { label, text } of collectDiagnosticSections(error)) {
    const key = diagnosticDedupeKey(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    details.push(`${label}:\n${text}`);
  }

  return details.length > 0
    ? `${errorStr}\n\n${details.join('\n\n')}`
    : errorStr;
}

function formatEventDiagnostic(
  value: unknown,
  cloud: CloudType | null,
): string | null {
  if (value === undefined || value === null) return null;
  const formatted = formatErrorDetail(value, cloud);
  const normalized = normalizeLogText(
    archMismatchGuidance(formatted) ?? formatted,
    {
      tailChars: Number.POSITIVE_INFINITY,
    },
  );
  // Old workloads persisted the benign systemd cgroup warning (and its
  // synthetic sync header) into event metadata; strip it at render time.
  return sanitizeRcloneDiagnostics(normalized ?? undefined) ?? null;
}

function appendDetailBlock(
  blocks: string[],
  seen: Set<string>,
  label: string,
  text: string | null,
): void {
  if (!text) return;
  const key = diagnosticDedupeKey(text);
  if (!key || seen.has(key)) return;
  seen.add(key);
  blocks.push(`${label}:\n${text}`);
}

const PULL_FAILURE_REASONS = new Set([
  'registry_throttled',
  'registry_auth',
  'timeout',
  'transport_error',
  'auth_setup_failed',
  'transfer_failed',
]);

function telemetryLabel(value: string): string {
  return value.replace(/[_-]/g, ' ');
}

function transferWasUnavailable(pull: ImagePullTelemetry): boolean {
  return (
    pull.method === 'docker' &&
    !!pull.reason &&
    !PULL_FAILURE_REASONS.has(pull.reason)
  );
}

function formatImagePullSummary(value: unknown): string | null {
  if (!isImagePullTelemetry(value)) return null;
  if (value.alreadyPresent) return 'image already on Node';
  let label =
    value.method === 'kubelet'
      ? 'kubelet'
      : value.method === 'containerd-transfer'
        ? 'containerd transfer'
        : value.method === 'docker-fallback'
          ? 'Docker fallback'
          : transferWasUnavailable(value)
            ? 'Docker (transfer unavailable)'
            : 'Docker';
  if (value.outcome === 'failed') label += ' failed';
  return `${label}, ${formatDurationCompact(value.elapsedMs)}`;
}

function formatTelemetryDetails(value: unknown): string[] {
  if (!isImagePullTelemetry(value)) return [];
  const details: string[] = [];
  if (value.reason) {
    const prefix =
      value.method === 'docker-fallback'
        ? 'transfer fallback'
        : transferWasUnavailable(value)
          ? 'transfer unavailable'
          : value.outcome === 'failed'
            ? 'pull failed'
            : null;
    if (prefix) details.push(`${prefix}: ${telemetryLabel(value.reason)}`);
  }
  const runtime = [
    value.containerdVersion && `containerd ${value.containerdVersion}`,
    value.snapshotter && `snapshotter ${value.snapshotter}`,
  ].filter((part): part is string => !!part);
  if (runtime.length > 0) details.push(runtime.join(', '));
  if (
    value.bytesFetched !== undefined &&
    value.timeToLastByteMs !== undefined &&
    value.unpackTailMs !== undefined
  ) {
    const seconds = (ms: number) => `${Math.round(ms / 1000)}s`;
    details.push(
      `fetched ${formatBytes(value.bytesFetched)} in ${seconds(value.timeToLastByteMs)}, then unpacked for ${seconds(value.unpackTailMs)}`,
    );
  }
  return details;
}

// Format workload events as human-readable log
export const formatEvents = (
  events: WorkloadEvent[],
  cloud: CloudType | null,
  options: { verbose?: boolean } = {},
): string => {
  const displayEvents = events;
  if (displayEvents.length === 0) return 'No events recorded';

  // Collapse consecutive events with the same state into "(×N)" counts.
  // An event is only collapsible when its metadata has no fields the rendering
  // code below will display (exitCode, oomKilled, message, reason, logs, error).
  // Region-only metadata is fine to collapse — it's shown but doesn't
  // differentiate events, so we just require the regions match.
  const deduplicated: Array<{ event: WorkloadEvent; count: number }> = [];

  for (const event of displayEvents) {
    const last = deduplicated[deduplicated.length - 1];
    // True when the event carries metadata the render pass will display.
    // These fields mirror the checks in the .map() below (lines ~102-126).
    const renders = (e: WorkloadEvent) => {
      const m = e.metadata;
      return (
        m &&
        (m.exitCode !== undefined ||
          m.oomKilled === true ||
          typeof m.finalSyncAttempts === 'number' ||
          formatEligibleRegions(m.eligibleRegions) ||
          m.message ||
          m.reason ||
          m.logs ||
          m.error ||
          formatImagePullSummary(m.imagePull))
      );
    };
    if (
      last &&
      last.event.state === event.state &&
      !renders(event) &&
      !renders(last.event) &&
      event.metadata?.region === last.event.metadata?.region
    ) {
      last.count++;
    } else {
      deduplicated.push({ event, count: 1 });
    }
  }

  return deduplicated
    .map(({ event: e, count }) => {
      const time = new Date(e.createdAt).toISOString().slice(11, 19);
      let result = `[${time}] ${e.state}`;

      // Add count if duplicated
      if (count > 1) {
        result += ` (×${count})`;
      }

      // Add region if present (multi-region provisioning attempts)
      if (e.metadata?.region) {
        result += ` (${e.metadata.region})`;
      }

      // Add exit code indicator if present
      if (e.metadata?.exitCode !== undefined) {
        result += ` [exit: ${e.metadata.exitCode}]`;
      }

      // Add OOM indicator if true
      if (e.metadata?.oomKilled === true) {
        result += ' [OOM]';
      }

      // Final bucket sync outcome, separate from the workload's exit code.
      // finalizeJobArtifacts persists finalSyncAttempts only on the terminal
      // transition after a successful sync, so its presence means success;
      // failures surface via reason/error on Finalizing and Failed events.
      if (typeof e.metadata?.finalSyncAttempts === 'number') {
        result += ` [final sync: succeeded, attempt: ${e.metadata.finalSyncAttempts}]`;
      }

      const imagePullSummary = formatImagePullSummary(e.metadata?.imagePull);
      if (imagePullSummary) {
        result += ` [pull: ${imagePullSummary}]`;
      }

      // Add message/reason as the headline, then render logs/error explicitly
      // below so one field cannot hide the other.
      const detail = formatEligibleRegions(e.metadata?.eligibleRegions);
      const errorText = formatEventDiagnostic(e.metadata?.error, cloud);
      const logsText = formatEventDiagnostic(e.metadata?.logs, cloud);
      let headlineText: string | null = null;
      if (detail) {
        result += `: ${detail}`;
      } else if (e.metadata?.message) {
        headlineText = String(e.metadata.message);
        result += `: ${headlineText}`;
      } else {
        const reason =
          e.metadata?.reason !== undefined ? String(e.metadata.reason) : null;
        if (reason) {
          headlineText = reason;
          result += `: ${reason}`;
        } else if (errorText) {
          headlineText = errorText;
          result += `: ${errorText}`;
        } else if (logsText) {
          headlineText = logsText;
          result += `: ${logsText}`;
        }
      }

      if (!detail) {
        const blocks: string[] = [];
        const seen = new Set<string>();
        if (headlineText) seen.add(diagnosticDedupeKey(headlineText));

        if (e.metadata?.message || e.metadata?.reason || e.metadata?.error) {
          appendDetailBlock(blocks, seen, 'Logs', logsText);
        }
        if (e.metadata?.message || e.metadata?.reason) {
          appendDetailBlock(blocks, seen, 'Error', errorText);
        }

        if (blocks.length > 0) {
          result += `${result.includes('\n') ? '\n\n' : '\n'}${blocks.join('\n\n')}`;
        }
      }

      if (options.verbose && e.metadata) {
        const telemetryDetails = formatTelemetryDetails(e.metadata.imagePull);
        if (telemetryDetails.length > 0) {
          result += `\n${telemetryDetails.join('\n')}`;
        }
      }

      return result;
    })
    .join('\n');
};

function formatEligibleRegions(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const regions = value.filter(
    (region): region is string => typeof region === 'string' && region !== '',
  );
  if (regions.length === 0) return null;
  if (regions.length === 1) return `only eligible region: ${regions[0]}`;
  return `eligible regions: ${regions.join(', ')}`;
}

export const formatLogs = (
  events: WorkloadEvent[],
  cloud: CloudType | null,
  options: { verbose?: boolean; columns?: number } = {},
): string => {
  const formatted = formatEvents(events, cloud, options);
  const allLines = formatted.split('\n');
  const prefix = '  │ ';
  const output: string[] = [];
  let i = 0;

  while (i < allLines.length) {
    const line = allLines[i];
    // Match any event line: [HH:MM:SS] state ...
    const eventMatch = line.match(/^(\[\d{2}:\d{2}:\d{2}\]) (\w+)(.*)$/);

    if (eventMatch) {
      const [, timestamp, state, rest] = eventMatch;
      const indicatorMatch = rest.match(
        /^((?:\s*\[[^\]]+\])*)(?:\s*:\s*(.*))?$/,
      );
      const indicators = indicatorMatch?.[1]?.trim() || '';
      const firstMessage = indicatorMatch?.[2] || '';
      const header = `${timestamp} ${state}${indicators ? ' ' + indicators : ''}`;

      // Collect the first message line plus any continuation lines that follow
      // (lines without a timestamp belong to this event's log content)
      const messageLines: string[] = [];
      if (firstMessage) messageLines.push(firstMessage);
      while (
        i + 1 < allLines.length &&
        !allLines[i + 1].match(/^\[\d{2}:\d{2}:\d{2}\]/)
      ) {
        i++;
        if (allLines[i].trim()) messageLines.push(allLines[i].trim());
      }

      if (messageLines.length === 0) {
        output.push(line); // No message — preserve original (keeps "(×2)" suffix etc.)
      } else {
        output.push(header);
        for (const ml of messageLines) {
          output.push(
            ...wrapLine(ml, prefix, options.columns).map(
              (w) => `${prefix}${w}`,
            ),
          );
        }
      }
    } else {
      output.push(line);
    }
    i++;
  }

  return output.join('\n');
};

function isServiceUpgradeEvent(event: WorkloadEvent): boolean {
  return (
    event.state === WorkloadState.Recovering &&
    event.metadata?.reason === 'serve-upgrade'
  );
}

function eventImage(
  event: WorkloadEvent,
  field: 'previousImage' | 'image',
): string | null {
  const value = event.metadata?.[field];
  return typeof value === 'string' && value.trim() ? value : null;
}

/**
 * Group one Service's flat event history into its initial workload and
 * URL-preserving upgrades. The status wire contract deliberately stays flat;
 * this grouping belongs only to human-readable CLI presentation.
 */
export const formatServiceLogs = (
  events: WorkloadEvent[],
  cloud: CloudType | null,
  options: StatusRenderOptions = {},
  truncated = false,
): string => {
  const firstUpgrade = events.find(isServiceUpgradeEvent);
  if (!firstUpgrade) return formatLogs(events, cloud, options);

  const initialImage = eventImage(firstUpgrade, 'previousImage');
  const sections: Array<{ heading: string; events: WorkloadEvent[] }> = [
    {
      heading: initialImage
        ? `Initial workload · ${initialImage}`
        : 'Initial workload',
      events: [],
    },
  ];
  let upgradeNumber = 0;

  for (const event of events) {
    if (isServiceUpgradeEvent(event)) {
      upgradeNumber++;
      const previousImage = eventImage(event, 'previousImage');
      const image = eventImage(event, 'image');
      const upgradeLabel = truncated ? 'Upgrade' : `Upgrade ${upgradeNumber}`;
      sections.push({
        heading:
          previousImage && image
            ? `${upgradeLabel} · ${previousImage} → ${image}`
            : upgradeLabel,
        events: [event],
      });
      continue;
    }
    sections[sections.length - 1].events.push(event);
  }

  const availableSections = sections.filter(
    (section) => section.events.length > 0,
  );
  const formatSection = (section: (typeof availableSections)[number]) =>
    `${section.heading}\n${formatLogs(section.events, cloud, options)}`;

  if (options.history || availableSections.length === 1) {
    return availableSections.map(formatSection).join('\n\n');
  }

  const hiddenCount = availableSections.length - 1;
  const latestSection = availableSections.at(-1);
  if (!latestSection) return formatLogs(events, cloud, options);
  // A partial tail cannot establish absolute upgrade or hidden-version counts.
  // The status renderer separately reports the number of omitted events.
  if (truncated) return formatSection(latestSection);
  const versionLabel = hiddenCount === 1 ? 'version' : 'versions';
  return `${formatSection(latestSection)}\n\n${hiddenCount} earlier workload ${versionLabel} hidden. Run with --history to show all.`;
};

function formatContainerLine(
  container: StatusVm['container'],
  options: {
    isPending: boolean;
    isCompleted: boolean;
    ok: boolean;
    workload: StatusWorkloadMetadata;
  },
): { ok: boolean; text: string; logs?: string } {
  const { isPending, isCompleted, ok, workload } = options;
  if (isPending) return { ok: false, text: 'pending' };
  // A Job that exited 0 succeeded, whether status still sees the container or
  // the Job has already completed and released it. A Service never should exit.
  if (
    workload.workloadType === WorkloadType.Job &&
    container?.oomKilled !== true &&
    (container
      ? container.state === ContainerState.Exited && container.exitCode === 0
      : workload.state === WorkloadState.Completed)
  ) {
    return { ok: true, text: 'finished, exit 0' };
  }

  const state =
    container?.state || (isCompleted ? ContainerState.Exited : 'unknown');
  const details: string[] = [];
  if (container?.exitCode !== undefined) {
    details.push(`exit: ${container.exitCode}`);
  }
  if (container?.oomKilled === true) {
    details.push('OOM');
  }
  const detail = details.length > 0 ? ` [${details.join(', ')}]` : '';
  const uptime = ok && container?.uptime ? `    ${container.uptime}` : '';
  return {
    ok,
    text: `${state}${detail}${uptime}`,
    logs: normalizeStatusLog(container?.logs),
  };
}

function normalizeStatusLog(logs: string | undefined): string | undefined {
  return (
    normalizeLogText(sanitizeRcloneDiagnostics(logs), {
      tailChars: DIAGNOSTIC_TAIL_CHARS,
      maxLines: STATUS_LOG_MAX_LINES,
    }) ?? undefined
  );
}

function indentedLines(
  text: string,
  prefix: string,
  columns: number | undefined,
): string[] {
  const output: string[] = [];
  const lines = text.split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    for (const wrapped of wrapLine(line.trim(), prefix, columns)) {
      output.push(`${prefix}${wrapped}`);
    }
  }
  return output;
}

// rclone logs are structured (--verbose tags every failure ERROR/FATAL), so
// sync health must not use the unstructured keyword net — journald lifecycle
// lines from old VMs contain words like "failed" without any transfer failing.
function serviceDiagnosticText(
  service: StatusRcloneService | undefined,
): string | undefined {
  if (!service || typeof service !== 'object') return undefined;
  const logs = normalizeStatusLog(service.logs);
  if (!logs) return undefined;
  const errors = extractErrorLines(logs, { structuredOnly: true });
  return errors.length > 0 ? linesWithContext(logs, errors).join('\n') : logs;
}

function linesWithContext(
  logs: string,
  targetLines: string[],
  contextLines = 1,
): string[] {
  const lines = logs.split('\n').filter((line) => line.trim());
  const targetKeys = new Set(targetLines.map(diagnosticDedupeKey));
  const selected = new Set<number>();

  lines.forEach((line, index) => {
    if (!targetKeys.has(diagnosticDedupeKey(line))) return;
    for (
      let i = Math.max(0, index - contextLines);
      i <= Math.min(lines.length - 1, index + contextLines);
      i++
    ) {
      selected.add(i);
    }
  });

  const withContext = [...selected]
    .sort((a, b) => a - b)
    .map((index) => lines[index]);
  return withContext.length > 0 ? withContext : targetLines;
}

function diagnosticLines(
  label: string,
  ok: boolean,
  text: string | undefined,
  options: StatusRenderOptions,
): string[] {
  if (ok) return [];
  if (!text) return [];
  if (options.verbose) {
    return indentedLines(text, '      │ ', options.columns);
  }
  return [`      Run with --verbose for ${label} logs.`];
}

function syncLines(
  { label, service, running, hasErrors, ok }: WorkloadStatusSync,
  isPending: boolean,
  options: StatusRenderOptions,
): string[] {
  const state = isPending
    ? 'pending'
    : running
      ? hasErrors
        ? 'running (errors)'
        : 'running'
      : service.status === ServiceState.Fatal
        ? 'failed'
        : service.status === ServiceState.Starting
          ? 'starting'
          : 'stopped';
  return [
    `    ${componentLine(label, ok, isPending, state)}`,
    ...diagnosticLines(label, ok, serviceDiagnosticText(service), options),
  ];
}

/** Status lines below the workload header, which the command prints first. */
export function buildStatusLines(
  view: WorkloadStatusView,
  options: StatusRenderOptions,
): string[] {
  const { workload: selectedWorkload, isPending, isCompleted } = view;
  const lines: string[] = [];
  const checkpoint = formatCheckpointHealth(view.checkpoint?.health);
  if (checkpoint) lines.push(checkpoint, '');
  if (view.vms.length > 0) {
    lines.push('VMs:');
    view.vms.forEach((vm) => {
      const lifecycleSuffix =
        vm.lifecycle === 'terminated'
          ? ' (terminated)'
          : vm.lifecycle === 'releasing'
            ? RELEASING_LABELS.vm
            : '';
      lines.push(
        `  ${vm.ip}${vm.vmType ? ` (${vm.vmType})` : ''}${lifecycleSuffix}`,
      );

      // Container status
      const container = formatContainerLine(vm.container, {
        isPending,
        isCompleted,
        ok: vm.containerHealthy,
        workload: selectedWorkload,
      });
      const containerOk = container.ok;
      lines.push(
        `    ${componentLine('container'.padEnd(11), containerOk, isPending, container.text)}`,
      );
      lines.push(
        ...diagnosticLines('container', containerOk, container.logs, options),
      );
      for (const sync of vm.syncs) {
        lines.push(...syncLines(sync, isPending, options));
      }
      lines.push(...gpuLines(vm.gpu, isPending));

      lines.push('');
    });
  }

  // Events log
  if (view.showEvents) {
    lines.push(
      view.groupServiceUpgrades
        ? formatServiceLogs(
            view.events,
            selectedWorkload.cloudProvider,
            options,
            view.hiddenEvents !== null,
          )
        : formatLogs(view.events, selectedWorkload.cloudProvider, options),
    );
    const hints = [
      formatRetryHint(view.events, selectedWorkload, view.retry),
      formatQuotaHint(view.events, selectedWorkload),
      formatHiddenEventsHint(view.hiddenEvents),
    ].filter((hint): hint is string => hint !== null);
    if (hints.length > 0) {
      lines.push('', ...hints);
    }
  }
  return lines;
}

function formatCheckpointHealth(
  health: NonNullable<WorkloadStatusResponse['checkpoint']>['health'],
): string | null {
  if (!health) return null;
  if (health.objects === 0 && !health.truncated) {
    return 'Checkpoint: nothing saved yet';
  }
  const objects = `${health.truncated ? 'at least ' : ''}${health.objects} object${health.objects === 1 ? '' : 's'}`;
  const newest =
    health.lastModifiedAt === null
      ? ''
      : `, newest ${formatAge(health.lastModifiedAt)} ago`;
  return `Checkpoint: ${objects}, ${formatBytes(health.bytes)} in the bucket${newest}`;
}

function formatHiddenEventsHint(hidden: number | null): string | null {
  return hidden !== null
    ? `${hidden} earlier event${hidden === 1 ? '' : 's'} hidden. Run with --history to show all.`
    : null;
}

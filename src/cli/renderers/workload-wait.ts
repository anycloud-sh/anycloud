import { WorkloadState } from '../../shared/workload.js';
import { formatDurationCompact } from '../utils/duration.js';
import { retryCause, retryWhen } from './workload-retry.js';
import type { WaitRecord } from '../use-cases/workload-wait.js';

const iso = (timestamp: number) => new Date(timestamp).toISOString();

/** Retry facts a Retrying state record carries, when status reported them. */
function retryFacts(record: Extract<WaitRecord, { type: 'state' }>) {
  if (!record.status) return undefined;
  const { retry, events, workload } = record.status;
  if (record.state !== WorkloadState.Retrying || !retry) return undefined;
  return { ...retry, cause: retryCause(events, workload) };
}

function formatJson(record: WaitRecord): string {
  const observedAt = iso(record.observedAt);
  switch (record.type) {
    case 'state': {
      const { status: _status, ...fields } = record;
      const retry = retryFacts(record);
      return JSON.stringify({
        ...fields,
        observedAt,
        ...(retry && {
          retry: {
            attempt: retry.attempt,
            ...(retry.cause && {
              diagnosis: retry.cause.diagnosis,
              target: retry.cause.target,
            }),
            earliestAt: iso(retry.earliestAt),
            latestAt: iso(retry.latestAt),
          },
        }),
      });
    }
    case 'heartbeat': {
      const { elapsedMs, ...fields } = record;
      return JSON.stringify({
        ...fields,
        observedAt,
        elapsedSeconds: Math.floor(elapsedMs / 1000),
      });
    }
    case 'observer':
    case 'result':
      return JSON.stringify({ ...record, observedAt });
  }
}

function formatText(record: WaitRecord): string {
  const stamp = `[${iso(record.observedAt).slice(11, 19)}]`;
  switch (record.type) {
    case 'state': {
      const details: string[] = [];
      if (record.upgrade) {
        details.push(
          `upgrade ${record.upgrade.number} ${record.upgrade.state}`,
        );
      }
      if (record.ready) details.push('ready');
      if (record.exitCode !== undefined) {
        details.push(`exit ${record.exitCode}`);
      }
      if (record.reason) details.push(record.reason);
      if (record.jobsAhead !== undefined) {
        details.push(
          `${record.jobsAhead} Job${record.jobsAhead === 1 ? '' : 's'} ahead`,
        );
      }
      const retry = retryFacts(record);
      if (retry) {
        const due = retryWhen(retry, record.observedAt);
        const parts = [`attempt ${retry.attempt}`];
        if (retry.cause) parts.push(retry.cause.label);
        if (retry.cause && retry.cause.target.length > 0) {
          parts.push(retry.cause.target.join(' '));
        }
        details.push(`${parts.join(', ')}; ${due}`);
      }
      const suffix = details.length > 0 ? ` (${details.join(', ')})` : '';
      const message = record.message ? `: ${record.message}` : '';
      return `${stamp} ${record.ref} ${record.state}${suffix}${message}`;
    }
    case 'heartbeat': {
      const states =
        Object.entries(record.states)
          .map(([state, count]) => `${count} ${state}`)
          .join(', ') || 'no state yet';
      return `${stamp} observing: ${states}; elapsed ${formatDurationCompact(record.elapsedMs)}`;
    }
    case 'observer':
      return record.status === 'degraded'
        ? `${stamp} observer degraded: ${record.error}; retrying`
        : `${stamp} observer recovered`;
    case 'result': {
      switch (record.outcome) {
        case 'succeeded':
          return `${stamp} succeeded: ${record.succeeded.join(', ')}`;
        case 'failed':
          return `${stamp} failed: ${record.failed.join(', ')}${record.succeeded.length > 0 ? `; succeeded: ${record.succeeded.join(', ')}` : ''}`;
        case 'timeout':
          return `${stamp} timed out after ${formatDurationCompact(record.timeoutMs ?? 0)}; still waiting on: ${record.pending.join(', ')}`;
        case 'observer-error':
          return `${stamp} observer error: ${record.error?.ref}: ${record.error?.message}`;
      }
    }
  }
}

/** One `wait` record as a timestamped line, or as one NDJSON object. */
export function formatWaitRecord(record: WaitRecord, json: boolean): string {
  return json ? formatJson(record) : formatText(record);
}

#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const NUKE_OUTCOME_CATEGORIES = [
  'completed',
  'quota-blocked',
  'provider-capacity',
  'storage-blocked',
  'api-health',
  'memory',
  'invalid-workload',
  'cleanup',
  'active-deadline',
  'active-at-abort',
  'terminated',
  'failed-unknown',
  'missing',
];

export const ACTIVE_STATES = new Set([
  'queued',
  'provisioning',
  'initializing',
  'downloading',
  'syncing',
  'starting',
  'running',
  'retrying',
  'recovering',
  'finalizing',
]);

const WORKLOAD_MESSAGE_CLASSIFIERS = [
  {
    category: 'memory',
    pattern:
      /\b(heap out of memory|out of memory|oom|killed process|memory endpoint|memory budget)\b/i,
  },
  {
    category: 'api-health',
    pattern:
      /\b(uncaught exception|fatal sqlite|sqlite_(corrupt|ioerr|full|cantopen)|api .*unavailable|http 5\d\d|econnrefused)\b/i,
  },
  {
    category: 'cleanup',
    pattern:
      /\b(manual cleanup|cleanup .*failed|failed .*cleanup|orphan .*failed|delete .*failed|leak(?:ed)?)\b/i,
  },
  {
    category: 'storage-blocked',
    pattern:
      /\b(bucket|blob|s3|gcs|storage|rclone|upload object|download object|upsert bucket|shared output bucket|err_stream_premature_close|premature close|oauth2\/v4\/token)\b/i,
  },
  {
    category: 'quota-blocked',
    pattern:
      /\b(quota|quotaexhausted|resource_exhausted|exceeding approved|limit exceeded|lowprioritycores|regional vm-family|regional quota|account-wide quota|vcpu quota)\b/i,
  },
  {
    category: 'provider-capacity',
    pattern:
      /\b(capacity|insufficient resources|insufficient-capacity|overconstrainedallocationrequest|no spot capacity|no capacity|resource pool exhausted)\b/i,
  },
];

// API logs contain normal lifecycle messages such as "Output bucket ready" and
// "Starting quota-monitor". Keep their classifiers separate from the looser
// workload-message patterns so ordinary INFO logs cannot invent failures.
const API_LOG_CLASSIFIERS = [
  {
    category: 'memory',
    pattern: /\b(heap out of memory|out of memory|oom|killed process)\b/i,
  },
  {
    category: 'api-health',
    pattern:
      /\b(uncaught exception|fatal sqlite|sqlite_(corrupt|ioerr|full|cantopen)|api .*unavailable|http 5\d\d|econnrefused)\b/i,
  },
  {
    category: 'cleanup',
    pattern:
      /\b(manual cleanup|cleanup .*failed|failed .*cleanup|orphan .*failed|delete .*failed|leak(?:ed)?)\b/i,
  },
  {
    category: 'storage-blocked',
    pattern:
      /\b(err_stream_premature_close|premature close|oauth2\/v4\/token|(?:bucket|blob|s3|gcs|storage|rclone|upload object|download object|upsert bucket|shared output bucket).*(?:fail(?:ed|ure)?|error|unavailable|timed? ?out|denied|forbidden)|(?:fail(?:ed|ure)?|error|unavailable|timed? ?out|denied|forbidden).*(?:bucket|blob|s3|gcs|storage|rclone|upload object|download object|upsert bucket|shared output bucket))\b/i,
  },
  {
    category: 'quota-blocked',
    pattern:
      /\b(quotaexhausted|resource_exhausted|lowprioritycores|operationnotallowed|quota (?:exhausted|exhaustion|exceeded|blocked|denied)|(?:regional|account-wide|vcpu) quota (?:exhausted|exhaustion|exceeded|blocked|denied)|exceeding approved|limit exceeded|vcpu limit)\b/i,
  },
  {
    category: 'provider-capacity',
    pattern:
      /\b(insufficient resources|insufficient-capacity|overconstrainedallocationrequest|no spot capacity|no capacity|resource pool exhausted|capacity exhaustion|capacity (?:unavailable|exhausted|blocked|failed))\b/i,
  },
];

const SNAPSHOT_KINDS = new Set(['complete', 'deadline', 'early-abort']);

function die(message) {
  throw new Error(message);
}

function emptyCounts() {
  return Object.fromEntries(NUKE_OUTCOME_CATEGORIES.map((key) => [key, 0]));
}

function categoryForText(text, classifiers = WORKLOAD_MESSAGE_CLASSIFIERS) {
  for (const classifier of classifiers) {
    if (classifier.pattern.test(text)) return classifier.category;
  }
  return null;
}

function reasonForWorkload(workload) {
  const fields = [
    workload.latestMessage,
    workload.state,
    workload.cloudProvider,
    workload.region,
    Array.isArray(workload.vmType)
      ? workload.vmType.join(' ')
      : workload.vmType,
  ]
    .filter((value) => typeof value === 'string' && value.length > 0)
    .join(' ');
  return fields || workload.state || 'unknown';
}

export function classifyWorkload(workload, { snapshotKind = 'deadline' } = {}) {
  const state = String(workload?.state ?? '').toLowerCase();
  const reason = reasonForWorkload(workload ?? {});

  if (state === 'completed') {
    return { category: 'completed', reason };
  }
  if (state === 'invalid') {
    return { category: 'invalid-workload', reason };
  }

  // Match the failure CAUSE on the human-readable message only. Identity fields
  // (provider/region/vmType) stay in `reason` for display but are never matched
  // against the classifiers, so a region or VM family that happens to contain a
  // keyword cannot invent a category.
  const message =
    typeof workload?.latestMessage === 'string' ? workload.latestMessage : '';
  const category = categoryForText(message);
  if (category) return { category, reason };

  if (ACTIVE_STATES.has(state)) {
    return {
      category:
        snapshotKind === 'deadline' ? 'active-deadline' : 'active-at-abort',
      reason,
    };
  }
  if (state === 'terminated') {
    return { category: 'terminated', reason };
  }
  return { category: 'failed-unknown', reason };
}

export function parseWorkloadsJson(text, file = 'nuke list JSON') {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    die(`Malformed workload list JSON in ${file}: ${detail}`);
  }
  if (!Array.isArray(parsed)) {
    die(`Workload list JSON in ${file} must be an array`);
  }
  return parsed;
}

function apiLogEntry(rawLine) {
  try {
    const parsed = JSON.parse(rawLine);
    if (!parsed || typeof parsed !== 'object') {
      return { id: null, text: rawLine };
    }
    const diagnosticFieldNames = [
      'message',
      'error',
      'err',
      'errorMessage',
      'logs',
      'stderr',
      'reason',
      'details',
      'cause',
      'providerError',
      'latestMessage',
      'code',
    ];
    const diagnosticText = diagnosticFieldNames
      .map((name) => parsed[name])
      .filter((value) => value !== undefined && value !== null)
      .map((value) =>
        typeof value === 'string' ? value : JSON.stringify(value),
      )
      .join(' ');
    return {
      id: typeof parsed.id === 'string' ? parsed.id : null,
      // Some structured loggers put the useful provider/rclone diagnostic in
      // fields such as `logs`, `reason`, or `details` instead of `message` or
      // `error`. Avoid scanning unrelated metadata fields because a generic
      // ERROR level next to a benign `storage` field would create a false match.
      text: diagnosticText || rawLine,
    };
  } catch {
    return { id: null, text: rawLine };
  }
}

function signalBelongsToRun(entry, category, workloadIdPrefix) {
  if (!workloadIdPrefix) return true;
  if (category === 'api-health' || category === 'memory') return true;
  if (entry.id) return entry.id.startsWith(workloadIdPrefix);
  if (entry.text.includes(workloadIdPrefix)) return true;
  return false;
}

export function analyzeApiLogSignals(text, { workloadIdPrefix = '' } = {}) {
  const counts = emptyCounts();
  /** @type {Record<string, string>} */
  const examples = {};
  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const entry = apiLogEntry(line);
    const category = categoryForText(entry.text, API_LOG_CLASSIFIERS);
    if (!category) continue;
    if (!signalBelongsToRun(entry, category, workloadIdPrefix)) continue;
    counts[category] += 1;
    if (!examples[category]) examples[category] = line.slice(0, 240);
  }
  return { counts, examples };
}

function memoryGateSignals(memoryReport) {
  const counts = emptyCounts();
  /** @type {Record<string, string>} */
  const examples = {};
  if (memoryReport?.ok === false) {
    counts.memory = 1;
    const firstFailure = Array.isArray(memoryReport.failures)
      ? memoryReport.failures.find((failure) => typeof failure === 'string')
      : null;
    examples.memory = firstFailure ?? 'memory budget failed';
  }
  return { counts, examples };
}

function mergeSignals(...signals) {
  const counts = emptyCounts();
  /** @type {Record<string, string>} */
  const examples = {};
  for (const signal of signals) {
    for (const category of NUKE_OUTCOME_CATEGORIES) {
      counts[category] += signal?.counts?.[category] ?? 0;
      if (!examples[category] && signal?.examples?.[category]) {
        examples[category] = signal.examples[category];
      }
    }
  }
  return { counts, examples };
}

/**
 * @param {Array<{ id?: string | null, state?: string | null, latestMessage?: string | null } | null>} workloads
 * @param {{
 *   expectedCount?: number,
 *   apiLogText?: string,
 *   workloadIdPrefix?: string,
 *   memoryReport?: { ok?: boolean, failures?: string[] } | null,
 *   snapshotKind?: string,
 * }} [options]
 */
export function analyzeNukeOutcomes(
  workloads,
  {
    expectedCount,
    apiLogText = '',
    workloadIdPrefix = '',
    memoryReport = null,
    snapshotKind = 'deadline',
  } = {},
) {
  const counts = emptyCounts();
  const classified = workloads.map((workload) => {
    const outcome = classifyWorkload(workload, { snapshotKind });
    counts[outcome.category] += 1;
    return {
      id: workload?.id ?? null,
      state: workload?.state ?? null,
      category: outcome.category,
      reason: outcome.reason,
    };
  });

  const missing =
    Number.isFinite(expectedCount) && expectedCount > workloads.length
      ? expectedCount - workloads.length
      : 0;
  counts.missing += missing;

  const apiLogSignals = analyzeApiLogSignals(apiLogText, {
    workloadIdPrefix,
  });
  const diagnosticSignals = mergeSignals(
    apiLogSignals,
    memoryGateSignals(memoryReport),
  );
  return {
    snapshotKind,
    counts,
    classified,
    missing,
    apiLogSignals,
    memoryReport,
    diagnosticSignals,
  };
}

function nonZeroPairs(counts) {
  return NUKE_OUTCOME_CATEGORIES.filter((category) => counts[category] > 0).map(
    (category) => `${category}=${counts[category]}`,
  );
}

export function formatNukeOutcomeSummary(report) {
  const lines = [
    `nuke classification: ${nonZeroPairs(report.counts).join(' ') || 'none'}`,
  ];
  const signalPairs = nonZeroPairs(report.diagnosticSignals.counts);
  if (signalPairs.length > 0) {
    lines.push(`nuke diagnostic signals: ${signalPairs.join(' ')}`);
  }

  const interesting = report.classified.filter(
    (item) => item.category !== 'completed',
  );
  if (interesting.length > 0) {
    lines.push(
      `nuke classification examples: ${interesting
        .slice(0, 8)
        .map((item) => `${item.id ?? '<missing>'}:${item.category}`)
        .join(', ')}`,
    );
  }
  if (report.missing > 0) {
    lines.push(
      `warning: nuke list is missing ${report.missing} expected row(s)`,
    );
  }
  return lines.join('\n');
}

function numberEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    die(`${name} must be a non-negative number`);
  }
  return value;
}

function snapshotKindEnv() {
  const value = process.env.NUKE_SNAPSHOT_KIND || 'deadline';
  if (!SNAPSHOT_KINDS.has(value)) {
    die(`NUKE_SNAPSHOT_KIND must be one of ${[...SNAPSHOT_KINDS].join(', ')}`);
  }
  return value;
}

function optionalJsonFile(file, label) {
  if (!file || !existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    die(`Malformed ${label} JSON in ${file}: ${detail}`);
  }
}

export function readNukeOutcomeInputsFromEnv() {
  const listFile = process.env.NUKE_LIST_FILE;
  if (!listFile) die('NUKE_LIST_FILE is required');
  const apiLogFile = process.env.NUKE_API_LOG_FILE;
  const memoryReportFile = process.env.NUKE_MEMORY_REPORT_FILE;
  const workloads = parseWorkloadsJson(
    readFileSync(listFile, 'utf8'),
    listFile,
  );
  const apiLogText = apiLogFile ? readFileSync(apiLogFile, 'utf8') : '';
  return {
    workloads,
    options: {
      expectedCount: numberEnv('NUKE_EXPECTED_COUNT', workloads.length),
      apiLogText,
      workloadIdPrefix: process.env.NUKE_WORKLOAD_ID_PREFIX ?? '',
      memoryReport: optionalJsonFile(memoryReportFile, 'memory report'),
      snapshotKind: snapshotKindEnv(),
    },
  };
}

function main() {
  const { workloads, options } = readNukeOutcomeInputsFromEnv();
  const report = analyzeNukeOutcomes(workloads, options);
  const outputFile = process.env.NUKE_CLASSIFICATION_FILE;
  if (outputFile) {
    writeFileSync(outputFile, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(formatNukeOutcomeSummary(report));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

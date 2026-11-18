#!/usr/bin/env node
/**
 * Post-process /tmp/api-e2e.log (JSONL from the conductor) into two
 * debugging aids that ship inside the CI e2e artifact:
 *
 *   <outDir>/per-workload/<id>.log   — one readable timeline per workload
 *   <outDir>/workloads-index.md      — top-level scan of all workloads
 *   <outDir>/unattributed.log          — lines we couldn't tie to a workload
 *
 * Invoked from test/integration/e2e.sh:
 *   npx tsx test/integration/helpers/process-e2e-logs.ts "$RESULTS_DIR"
 *
 * Runner metadata, its declared log, and the constrained fixture's records under
 * <outDir>/vitest-fixture/ are protocol inputs. Missing or malformed inputs fail
 * closed so a green leg cannot silently omit its evidence.
 */

import {
  createReadStream,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  appendFileSync,
} from 'node:fs';
import { createInterface } from 'node:readline';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  E2E_FIXTURE_ARTIFACT_DIRECTORY,
  readE2EFixtureEvidence,
  type E2EFixtureEvidence,
} from './e2e-fixture-record.js';
import {
  E2E_RUN_RECORD_FILE,
  readE2ERunRecord,
  type E2ERunRecord,
} from './e2e-run-record.js';

const INPUT_LOG = '/tmp/api-e2e.log';

interface LogLine {
  timestamp?: string;
  level?: string;
  message?: string;
  id?: string;
  ip?: string;
  host?: string;
  cloudId?: string;
  state?: string;
  [key: string]: unknown;
}

export interface WorkloadSummary {
  id: string;
  firstTs: string;
  lastTs: string;
  finalState: string | null;
  firstError: string | null;
  lastError: string | null;
}

export interface TestJob {
  name: string;
  implementation: 'bash' | 'vitest';
  exitCode: number;
  durationSeconds: number;
  testLog: string;
}

interface FailureWorkload {
  id: string;
  state: string | null;
  firstError: string | null;
  lastError: string | null;
  /** Timeline file, or null when the API log never mentioned this workload. */
  log: string | null;
}

interface FixtureTestEvidence {
  directory: string;
  testName: string;
  outcome: 'passed' | 'failed';
  failures: string[];
  workloads: Array<{
    id: string;
    status: 'found' | 'absent' | 'error';
    /** Artifact paths relative to the results directory. */
    artifacts: string[];
  }>;
  diagnosticErrors: Array<{
    workloadId: string;
    operation: string;
    error: string;
  }>;
}

interface FixtureEvidence {
  tests: FixtureTestEvidence[];
  incompleteDirectories: string[];
}

interface FailedTest {
  name: string;
  implementation: 'bash' | 'vitest';
  exitCode: number;
  durationSeconds: number;
  testLog: string;
  failureLines: string[];
  workloads: FailureWorkload[];
  /** Fixture-owned evidence, or null for a substrate that has no fixture. */
  fixture: FixtureEvidence | null;
}

export interface FailureReport {
  failedTests: FailedTest[];
}

export interface ProcessE2ELogsOptions {
  inputLog?: string;
  githubActions?: boolean;
  githubStepSummary?: string;
  emitConsole?: boolean;
}

function logLine(enabled: boolean, message: string): void {
  if (enabled) console.log(message);
}

function formatPretty(line: LogLine): string {
  const ts = line.timestamp ?? '';
  const hhmmss = ts.length >= 19 ? ts.slice(11, 19) : ts;
  const level = (line.level ?? '').padEnd(5);
  const msg = line.message ?? '';
  const extras: Record<string, unknown> = { ...line };
  delete extras.timestamp;
  delete extras.level;
  delete extras.message;
  const extraStr = Object.keys(extras).length
    ? '  ' + JSON.stringify(extras)
    : '';
  return `${hhmmss}  ${level}  ${msg}${extraStr}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeMarkdownCell(value: string | null | undefined): string {
  return (value ?? '').replace(/\|/g, '\\|');
}

function githubCommandValue(value: string): string {
  return value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function githubCommandProperty(value: string): string {
  return githubCommandValue(value).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

// The useful root cause usually lives in the line's `error` extra (a string, or
// an object with a `.message`), not the generic `message` ("Provisioning
// scheduler error"). Combine them so the section shows the real cause.
function errorDetail(l: LogLine): string {
  const base = typeof l.message === 'string' ? l.message : '';
  const e = (l as Record<string, unknown>).error;
  let detail = '';
  if (typeof e === 'string') detail = e;
  else if (e && typeof e === 'object') {
    const m = (e as Record<string, unknown>).message;
    detail = typeof m === 'string' ? m : JSON.stringify(e);
  }
  return detail && detail !== base ? `${base}: ${detail}` : base;
}

function testIdentityFromCommand(
  command: string,
): Pick<TestJob, 'name' | 'implementation' | 'testLog'> | null {
  const fromIntegrationPath = command.match(
    /test\/integration\/([^/'"\s]+)\.test\.sh\b/,
  );
  if (fromIntegrationPath) {
    const name = fromIntegrationPath[1];
    return { name, implementation: 'bash', testLog: `${name}-bash.log` };
  }

  const fromBasename = command.match(/([^/'"\s]+)\.test\.sh\b/);
  if (fromBasename) {
    const name = fromBasename[1];
    return { name, implementation: 'bash', testLog: `${name}-bash.log` };
  }

  const fromVitestSpec = command.match(/([^/'"\s]+)\.spec\.ts\b/);
  if (fromVitestSpec) {
    const name = fromVitestSpec[1];
    return { name, implementation: 'vitest', testLog: `${name}-vitest.log` };
  }

  return null;
}

export function parseJoblog(content: string): TestJob[] {
  return content
    .split('\n')
    .slice(1)
    .map((row) => {
      if (!row.trim()) return null;
      const cols = row.split('\t');
      const command = cols.slice(8).join('\t');
      const identity = testIdentityFromCommand(command);
      if (!identity) {
        throw new Error(`Unrecognized E2E joblog command: ${command}`);
      }
      const exitCode = Number.parseInt(cols[6] ?? '', 10);
      const durationSeconds = Number.parseFloat(cols[3] ?? '');
      return {
        ...identity,
        exitCode: Number.isFinite(exitCode) ? exitCode : 1,
        durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : 0,
      };
    })
    .filter((job): job is TestJob => job !== null);
}

function jobFromRunRecord(record: E2ERunRecord): TestJob {
  return {
    name: record.testName,
    implementation: record.implementation,
    exitCode: record.exitCode,
    durationSeconds: record.durationSeconds,
    testLog: record.logFile,
  };
}

function readJobs(outDir: string): TestJob[] {
  let jobs: TestJob[];
  if (existsSync(join(outDir, E2E_RUN_RECORD_FILE))) {
    jobs = [jobFromRunRecord(readE2ERunRecord(outDir))];
  } else {
    const joblog = join(outDir, 'joblog.txt');
    if (!existsSync(joblog)) {
      throw new Error(
        `Missing ${E2E_RUN_RECORD_FILE} and compatibility joblog.txt in ${outDir}`,
      );
    }
    jobs = parseJoblog(readFileSync(joblog, 'utf8'));
  }
  if (jobs.length === 0) {
    throw new Error('E2E runner metadata did not declare a test job');
  }
  for (const job of jobs) {
    if (!existsSync(join(outDir, job.testLog))) {
      throw new Error(`Declared test log is missing: ${job.testLog}`);
    }
  }
  return jobs;
}

function extractFailureLines(content: string, limit = 8): string[] {
  const lines = content
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const matches = lines.filter(
    (line) =>
      line.includes('✗') ||
      /\b(assert|failed|failure|timed out|timeout|did not|not found|required)\b|returned HTTP [45]\d{2}/i.test(
        line,
      ),
  );
  const source = matches.length > 0 ? matches : lines.slice(-limit);
  return Array.from(new Set(source)).slice(-limit);
}

function workloadMentioned(content: string, id: string): boolean {
  const pattern = new RegExp(
    `(^|[^A-Za-z0-9_-])${escapeRegExp(id)}(?:-\\d+)?($|[^A-Za-z0-9_-])`,
  );
  return pattern.test(content);
}

// Bash prints its diagnostics into the declared log, so triage sees them by
// scanning. The constrained Vitest fixture files them instead, so triage must
// read its record or the same evidence disappears from the artifact.
function attributeFixtureEvidence(
  jobs: TestJob[],
  evidence: E2EFixtureEvidence,
): FixtureEvidence | null {
  const vitestJobs = jobs.filter(
    (job) => job.implementation === 'vitest',
  ).length;
  const directories =
    evidence.entries.length + evidence.incompleteDirectories.length;
  if (directories === 0) {
    return vitestJobs > 0 ? { tests: [], incompleteDirectories: [] } : null;
  }
  if (vitestJobs !== 1) {
    throw new Error(
      `${E2E_FIXTURE_ARTIFACT_DIRECTORY}/ holds fixture diagnostics but the run declared ${vitestJobs} constrained Vitest jobs; evidence cannot be attributed`,
    );
  }

  return {
    tests: evidence.entries.map((entry) => ({
      directory: entry.directory,
      testName: entry.record.testName,
      outcome: entry.record.outcome,
      failures: entry.record.failures,
      workloads: entry.record.workloads.map((workload) => ({
        id: workload.id,
        status: workload.status,
        artifacts: workload.artifacts.map(
          (artifact) => `${entry.directory}/${artifact}`,
        ),
      })),
      diagnosticErrors: entry.record.diagnosticErrors,
    })),
    incompleteDirectories: [...evidence.incompleteDirectories],
  };
}

function trackedWorkloadIds(fixture: FixtureEvidence | null): string[] {
  if (!fixture) return [];
  return fixture.tests.flatMap((entry) =>
    entry.workloads.map((workload) => workload.id),
  );
}

export function buildFailureReport(
  outDir: string,
  summaries: WorkloadSummary[],
  jobs: TestJob[],
  evidence: E2EFixtureEvidence,
): FailureReport {
  const summariesById = new Map(summaries.map((s) => [s.id, s]));
  const sortedIds = summaries
    .map((s) => s.id)
    .sort((a, b) => b.length - a.length || a.localeCompare(b));
  const fixtureEvidence = attributeFixtureEvidence(jobs, evidence);

  const failedTests = jobs
    .filter((job) => job.exitCode !== 0)
    .map((job) => {
      const testLogPath = join(outDir, job.testLog);
      const testLogExists = existsSync(testLogPath);
      const testLog = testLogExists ? readFileSync(testLogPath, 'utf8') : '';
      const fixture = job.implementation === 'vitest' ? fixtureEvidence : null;
      // A tracked workload can fail before the API log ever attributes a
      // line to it, so the fixture's own ids join the scanned ones.
      const workloadIds = [
        ...new Set([
          ...sortedIds.filter((id) => workloadMentioned(testLog, id)),
          ...trackedWorkloadIds(fixture),
        ]),
      ];
      return {
        name: job.name,
        implementation: job.implementation,
        exitCode: job.exitCode,
        durationSeconds: Math.round(job.durationSeconds),
        testLog: job.testLog,
        failureLines: testLogExists
          ? extractFailureLines(testLog)
          : [`Declared test log is missing: ${job.testLog}`],
        workloads: workloadIds.map((id) => {
          const summary = summariesById.get(id);
          return {
            id,
            state: summary?.finalState ?? null,
            firstError: summary?.firstError ?? null,
            lastError: summary?.lastError ?? null,
            log: summary ? `per-workload/${id}.log` : null,
          };
        }),
        fixture,
      };
    });

  return { failedTests };
}

function fixtureFailures(test: FailedTest): string[] {
  return (test.fixture?.tests ?? [])
    .filter((entry) => entry.outcome === 'failed')
    .flatMap((entry) => entry.failures);
}

function fixtureIsEmpty(fixture: FixtureEvidence): boolean {
  return (
    fixture.tests.length === 0 && fixture.incompleteDirectories.length === 0
  );
}

function rootCauseFor(test: FailedTest): string {
  // The fixture holds the error the test actually threw; the log scan only
  // approximates it, and Vitest never prints the Bash-shaped markers.
  const fixtureFailure = fixtureFailures(test)[0];
  if (fixtureFailure) {
    return fixtureFailure;
  }

  const explicitTestFailures = test.failureLines.filter((line) =>
    line.includes('✗'),
  );
  const explicitTestFailure =
    explicitTestFailures[explicitTestFailures.length - 1];
  if (explicitTestFailure) {
    return explicitTestFailure;
  }

  const workloadWithCause = test.workloads.find(
    (d) => d.lastError || d.firstError,
  );
  if (workloadWithCause) {
    return (
      workloadWithCause.lastError ??
      workloadWithCause.firstError ??
      'No workload error recorded'
    );
  }
  return test.failureLines[0] ?? 'No failure line found in test log';
}

function appendFixtureDiagnostics(lines: string[], test: FailedTest): void {
  const fixture = test.fixture;
  if (!fixture) return;
  if (fixtureIsEmpty(fixture)) {
    lines.push(
      '- Fixture diagnostics: not captured — the run failed before the fixture initialized',
    );
    return;
  }

  lines.push('- Fixture diagnostics:');
  for (const entry of fixture.tests) {
    lines.push(
      `  - ${entry.testName} (${entry.outcome}) — \`${entry.directory}/\``,
    );
    for (const failure of entry.failures) {
      lines.push(`    - Failure: ${failure}`);
    }
    for (const workload of entry.workloads) {
      const artifacts = workload.artifacts
        .map((artifact) => `[${basename(artifact)}](${artifact})`)
        .join(', ');
      lines.push(
        `    - Tracked \`${workload.id}\` [${workload.status}]${
          artifacts ? ` — ${artifacts}` : ''
        }`,
      );
    }
    for (const diagnosticError of entry.diagnosticErrors) {
      lines.push(
        `    - Diagnostic error (${diagnosticError.operation}) for \`${diagnosticError.workloadId}\`: ${diagnosticError.error}`,
      );
    }
  }
  for (const directory of fixture.incompleteDirectories) {
    lines.push(
      `  - \`${directory}/\` — the fixture never finalized, so this test was interrupted`,
    );
  }
}

function renderFailureSummary(report: FailureReport): string {
  const lines: string[] = ['# E2E Failure Summary', ''];

  if (report.failedTests.length === 0) {
    lines.push('No failed tests.');
    return lines.join('\n') + '\n';
  }

  lines.push(`Failed tests: ${report.failedTests.length}`, '');

  for (const test of report.failedTests) {
    lines.push(`## ${test.name} (${test.implementation})`);
    lines.push('');
    lines.push(`- Exit: ${test.exitCode}`);
    lines.push(`- Duration: ${test.durationSeconds}s`);
    lines.push(`- Test log: \`${test.testLog}\``);
    if (test.failureLines.length > 0) {
      lines.push('- Key failure lines:');
      for (const line of test.failureLines) {
        lines.push(`  - ${line}`);
      }
    }
    if (test.workloads.length === 0) {
      lines.push('- Related workloads: none found in the test log');
    } else {
      lines.push('- Related workloads:');
      for (const workload of test.workloads) {
        const timeline = workload.log
          ? `\`${workload.log}\``
          : 'no API log timeline';
        lines.push(
          `  - \`${workload.id}\` [${workload.state ?? '?'}] — ${timeline}`,
        );
        if (workload.firstError) {
          lines.push(`    - First error: ${workload.firstError}`);
        }
        if (workload.lastError && workload.lastError !== workload.firstError) {
          lines.push(`    - Last error: ${workload.lastError}`);
        }
      }
    }
    appendFixtureDiagnostics(lines, test);
    lines.push('');
  }

  return lines.join('\n') + '\n';
}

function fixtureConsoleLine(test: FailedTest): string | null {
  const fixture = test.fixture;
  if (!fixture) return null;
  if (fixtureIsEmpty(fixture)) {
    return 'fixture diagnostics: not captured (failed before fixture setup)';
  }

  const tracked = fixture.tests.reduce(
    (total, entry) => total + entry.workloads.length,
    0,
  );
  const diagnosticErrors = fixture.tests.reduce(
    (total, entry) => total + entry.diagnosticErrors.length,
    0,
  );
  const counts = [
    `${tracked} tracked`,
    `${diagnosticErrors} diagnostic errors`,
  ];
  if (fixture.incompleteDirectories.length > 0) {
    counts.push(`${fixture.incompleteDirectories.length} incomplete`);
  }
  const directories = [
    ...fixture.tests.map((entry) => entry.directory),
    ...fixture.incompleteDirectories,
  ];
  return `fixture: ${directories.join(', ')} (${counts.join(', ')})`;
}

function renderConsoleTriage(report: FailureReport): string | null {
  if (report.failedTests.length === 0) return null;
  const lines = [
    '',
    '=== E2E failure triage ===',
    `Failed tests: ${report.failedTests.length}`,
  ];
  for (const test of report.failedTests) {
    lines.push(
      `  ${test.name} (${test.implementation}) failed after ${test.durationSeconds}s (exit ${test.exitCode})`,
    );
    const workload = test.workloads[0];
    const logs = [test.testLog, workload?.log].filter(Boolean).join(', ');
    if (workload) {
      lines.push(`    workload: ${workload.id} [${workload.state ?? '?'}]`);
    }
    lines.push(`    root cause: ${rootCauseFor(test)}`);
    lines.push(`    logs: ${logs}`);
    const fixtureLine = fixtureConsoleLine(test);
    if (fixtureLine) lines.push(`    ${fixtureLine}`);
    if (test.workloads.length > 1) {
      lines.push(`    related workloads: ${test.workloads.length}`);
    }
  }
  lines.push(
    'Artifact: test-logs-e2e-<test>* (per-test matrix leg and attempt)',
  );
  lines.push('Start here: START_HERE.md');
  return lines.join('\n');
}

function emitGithubAnnotations(report: FailureReport): void {
  for (const test of report.failedTests) {
    const workload = test.workloads[0];
    const title = `${test.name} (${test.implementation}) failed`;
    const parts = [
      workload
        ? `${workload.id} [${workload.state ?? '?'}]`
        : 'No related workload found',
      rootCauseFor(test),
      `See ${test.testLog}`,
      workload?.log ? `and ${workload.log}` : '',
    ].filter(Boolean);
    console.log(
      `::error title=${githubCommandProperty(title)}::${githubCommandValue(parts.join(' — '))}`,
    );
  }
}

async function readLines(path: string): Promise<string[]> {
  const lines: string[] = [];
  const rl = createInterface({
    input: createReadStream(path),
    crlfDelay: Infinity,
  });
  for await (const line of rl) lines.push(line);
  return lines;
}

export async function processE2ELogs(
  outDir: string,
  options: ProcessE2ELogsOptions = {},
): Promise<FailureReport> {
  const inputLog = options.inputLog ?? INPUT_LOG;
  const emitConsole = options.emitConsole ?? true;
  const inputLogExists = existsSync(inputLog);
  if (!inputLogExists && emitConsole) {
    console.warn(
      `[process-e2e-logs] ${inputLog} not found; continuing without API logs`,
    );
  }

  const rawLines = inputLogExists ? await readLines(inputLog) : [];
  const parsed: Array<LogLine | null> = rawLines.map((raw) => {
    try {
      return JSON.parse(raw) as LogLine;
    } catch {
      return null;
    }
  });

  // Pass 1: IP / host / cloudId → workload id
  const ipToId = new Map<string, string>();
  const knownIds = new Set<string>();
  for (const line of parsed) {
    if (!line || !line.id) continue;
    knownIds.add(line.id);
    for (const key of ['ip', 'host', 'cloudId'] as const) {
      const v = line[key];
      if (typeof v === 'string' && v && !ipToId.has(v)) ipToId.set(v, line.id);
    }
  }
  const sortedKnownIds = Array.from(knownIds).sort(
    (a, b) => b.length - a.length || a.localeCompare(b),
  );

  // Pass 2: attribute each line
  const byWorkload = new Map<string, LogLine[]>();
  const unattributed: string[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const line = parsed[i];
    const raw = rawLines[i];
    if (!line) {
      unattributed.push(raw);
      continue;
    }
    let id = line.id;
    if (!id) {
      for (const key of ['ip', 'host', 'cloudId'] as const) {
        const v = line[key];
        if (typeof v === 'string' && ipToId.has(v)) {
          id = ipToId.get(v);
          break;
        }
      }
    }
    if (!id) {
      id = sortedKnownIds.find((candidate) =>
        workloadMentioned(raw, candidate),
      );
    }
    if (!id) {
      unattributed.push(raw);
      continue;
    }
    const list = byWorkload.get(id) ?? [];
    list.push(line);
    byWorkload.set(id, list);
  }

  // Write per-workload files and build summaries
  const perDir = join(outDir, 'per-workload');
  mkdirSync(perDir, { recursive: true });
  const summaries: WorkloadSummary[] = [];
  for (const [id, lines] of byWorkload) {
    lines.sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''));
    writeFileSync(
      join(perDir, `${id}.log`),
      lines.map(formatPretty).join('\n') + '\n',
    );

    let finalState: string | null = null;
    let firstError: string | null = null;
    let lastError: string | null = null;
    for (const l of lines) {
      if (typeof l.state === 'string') finalState = l.state;
      if (l.level === 'ERROR' && typeof l.message === 'string') {
        const detail = errorDetail(l);
        if (firstError === null) firstError = detail;
        lastError = detail;
      }
    }
    summaries.push({
      id,
      firstTs: lines[0]?.timestamp ?? '',
      lastTs: lines[lines.length - 1]?.timestamp ?? '',
      finalState,
      // Full (untruncated) — both the markdown row and the stdout root-cause
      // section slice for width; the whole message stays in the per-workload
      // timeline file.
      firstError,
      lastError,
    });
  }

  // Sort by ID — the test-kind prefix (bsync-, invbk-, secrets-, …) naturally
  // groups related workloads, so no separate categorization is needed.
  summaries.sort((a, b) => a.id.localeCompare(b.id));
  const header =
    '| Workload ID | First | Last | Final state | Error |\n' +
    '| --- | --- | --- | --- | --- |\n';
  const rows = summaries.map((s) => {
    const link = `[${s.id}](per-workload/${s.id}.log)`;
    const err = escapeMarkdownCell((s.lastError ?? '').slice(0, 120));
    return `| ${link} | ${s.firstTs} | ${s.lastTs} | ${s.finalState ?? ''} | ${err} |`;
  });
  writeFileSync(
    join(outDir, 'workloads-index.md'),
    `# E2E workloads (${summaries.length})\n\n${header}${rows.join('\n')}\n`,
  );

  // Write unattributed
  writeFileSync(
    join(outDir, 'unattributed.log'),
    unattributed.join('\n') + '\n',
  );

  const jobs = readJobs(outDir);
  const report = buildFailureReport(
    outDir,
    summaries,
    jobs,
    readE2EFixtureEvidence(outDir),
  );
  const summaryMarkdown = renderFailureSummary(report);
  writeFileSync(join(outDir, 'START_HERE.md'), summaryMarkdown);
  writeFileSync(
    join(outDir, 'failures.json'),
    JSON.stringify(report, null, 2) + '\n',
  );

  logLine(
    emitConsole,
    `[process-e2e-logs] ${summaries.length} workloads, ${unattributed.length} unattributed lines`,
  );

  const consoleTriage = renderConsoleTriage(report);
  if (consoleTriage) {
    logLine(emitConsole, consoleTriage);
  }

  // A provisioning failure can be logged before the workload row is
  // attributable by id/ip — leave those in the artifact and point at them.
  const unattributedErrors = unattributed
    .map((raw) => {
      try {
        return JSON.parse(raw) as LogLine;
      } catch {
        return null;
      }
    })
    .filter((l): l is LogLine => l?.level === 'ERROR');
  if (unattributedErrors.length > 0) {
    logLine(
      emitConsole,
      `Unattributed ERRORs: ${unattributedErrors.length} (see unattributed.log)`,
    );
  }

  if (options.githubStepSummary) {
    appendFileSync(options.githubStepSummary, `${summaryMarkdown}\n`);
  }
  if (options.githubActions) {
    emitGithubAnnotations(report);
  }

  return report;
}

async function main() {
  const outDir = process.argv[2];
  if (!outDir) {
    console.error('usage: process-e2e-logs.ts <output-dir>');
    process.exit(2);
  }

  await processE2ELogs(outDir, {
    inputLog: process.env.E2E_API_LOG,
    githubActions: process.env.GITHUB_ACTIONS === 'true',
    githubStepSummary: process.env.GITHUB_STEP_SUMMARY,
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((err) => {
    console.error('[process-e2e-logs] failed:', err);
    process.exit(1);
  });
}

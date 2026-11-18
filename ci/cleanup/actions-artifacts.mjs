import { execFileSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { retryAfterMs } from '../../src/shared/retry-after.ts';
import {
  artifactKind,
  isQualification,
  planArtifactCleanup,
} from './actions-artifact-policy.mjs';

/** @typedef {import('./actions-artifact-policy.mjs').Artifact} Artifact */
/** @typedef {import('./actions-artifact-policy.mjs').Run} Run */

/** @param {(delay: number) => Promise<void>} sleep */
export function githubApi(
  token,
  fetcher = fetch,
  sleep = (delay) => setTimeout(delay),
) {
  const cache = new Map();
  return async (method, path, { retry = true } = {}) => {
    for (let attempt = 0; ; attempt++) {
      const cached = method === 'GET' ? cache.get(path) : undefined;
      const response = await fetcher('https://api.github.com/' + path, {
        method,
        headers: {
          Authorization: 'Bearer ' + token,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(cached ? { 'If-None-Match': cached.etag } : {}),
        },
        signal: AbortSignal.timeout(30_000),
      });
      const { status, headers } = response;
      // A 304 is a fresh server confirmation, not a skipped status check.
      // Authenticated 304 responses do not consume the primary API allowance.
      if (status === 304 && cached) return cached.body;
      if (status === 404 || status === 204) {
        cache.delete(path);
        return undefined;
      }
      const body = await response.json().catch(() => ({}));
      if (response.ok) {
        if (method === 'GET') {
          const etag = headers.get('etag');
          if (etag) cache.set(path, { etag, body });
          else cache.delete(path);
        }
        return body;
      }
      const error = new Error(
        `${method} ${path}: ${status} ${body.message ?? response.statusText}`,
      );
      // Retrying a deletion would bypass the caller's fresh run-status check.
      if (method !== 'GET' || !retry || attempt >= 3) throw error;
      const limited =
        status === 429 ||
        (status === 403 && /rate limit/i.test(body.message ?? ''));
      if (!limited && ![502, 503, 504].includes(status)) throw error;

      let delay = (limited ? 60_000 : 1000) * 2 ** attempt;
      const reset =
        Number(headers.get('x-ratelimit-reset')) * 1000 - Date.now();
      if (limited && headers.get('x-ratelimit-remaining') === '0' && reset > 0)
        delay = reset;
      const hint = retryAfterMs(headers, Date.now());
      if (hint) delay = hint;
      if (delay > 60_000) throw error;
      await sleep(delay);
    }
  };
}

// Bound concurrent reads for both artifact pages and owner lookups.
async function readInBatches(items, read) {
  const results = [];
  for (let offset = 0; offset < items.length; offset += 4)
    results.push(
      ...(await Promise.all(items.slice(offset, offset + 4).map(read))),
    );
  return results;
}

async function paginate(api, path, key) {
  const readPage = async (page) => {
    const result = await api(
      'GET',
      `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`,
    );
    if (!result || !Array.isArray(result[key]))
      throw new Error('Incomplete GitHub inventory: ' + path);
    return result;
  };
  const first = await readPage(1);
  // Filtered run listings stop at 1,000 results. A truncated active-run
  // inventory cannot establish that no qualification needs release bytes.
  if (key === 'workflow_runs' && first.total_count >= 1000)
    throw new Error(
      'Active-run inventory exceeds GitHub’s 1,000-result limit: ' + path,
    );
  if (first[key].length < 100) return first[key];
  const lastPage = Math.ceil(first.total_count / 100);
  if (!Number.isSafeInteger(lastPage) || lastPage < 1)
    throw new Error('Missing GitHub inventory count: ' + path);
  const pages = Array.from({ length: lastPage - 1 }, (_, index) => index + 2);
  return [first, ...(await readInBatches(pages, readPage))].flatMap(
    (result) => result[key],
  );
}

async function activeQualifications(api, base) {
  const runs = [];
  for (const status of [
    'queued',
    'in_progress',
    'waiting',
    'pending',
    'requested',
  ]) {
    runs.push(
      ...(await paginate(
        api,
        `${base}/actions/runs?status=${status}&exclude_pull_requests=true`,
        'workflow_runs',
      )),
    );
  }
  return runs.filter(isQualification);
}

/**
 * Full inventories include expired metadata dating back years. Bound owner
 * lookups/deletions per invocation; later sweeps continue with remaining runs.
 * Resolve large and retry-sensitive cohorts first. Never infer completion from age.
 */
async function inventory(api, base, runId, maxRuns) {
  const path = `${base}/actions/${runId ? `runs/${runId}/` : ''}artifacts`;
  const unique = new Map(
    (await paginate(api, path, 'artifacts')).map((artifact) => [
      artifact.id,
      artifact,
    ]),
  );
  /** @type {Artifact[]} */
  const artifacts = [...unique.values()].map((artifact) => ({
    ...artifact,
    workflow_run: artifact.workflow_run ?? (runId ? { id: runId } : undefined),
  }));
  const owners = new Map();
  for (const artifact of artifacts) {
    if (artifact.expired || !artifact.workflow_run?.id) continue;
    if (['unknown', 'recovery'].includes(artifactKind(artifact.name))) continue;
    const id = artifact.workflow_run.id;
    owners.set(id, (owners.get(id) ?? 0) + artifact.size_in_bytes);
  }
  const selected = [...owners].sort((a, b) => b[1] - a[1]).slice(0, maxRuns);
  const resolved = await readInBatches(selected, async ([id]) => [
    id,
    await api('GET', `${base}/actions/runs/${id}`),
  ]);
  /** @type {Map<number, Run>} */
  const runs = new Map(resolved.filter(([, run]) => run));
  const qualifications = artifacts.some(
    (artifact) =>
      !artifact.expired && artifactKind(artifact.name) === 'release',
  )
    ? await activeQualifications(api, base)
    : [];
  for (const run of qualifications) runs.set(run.id, run);
  return {
    artifacts,
    runs,
    qualificationActive: qualifications.length > 0,
    pendingRuns: Math.max(0, owners.size - selected.length),
  };
}

/**
 * @param {ReturnType<typeof githubApi>} api
 * @param {{repository: string, apply?: boolean, runId?: number, now?: number, targetBytes?: number, maxRuns?: number, maxDeletes?: number}} options
 */
export async function cleanupArtifacts(
  api,
  {
    repository,
    apply = false,
    runId,
    now = Date.now(),
    targetBytes,
    maxRuns = 80,
    maxDeletes = 100,
  },
) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository))
    throw new Error('Expected --repo OWNER/REPO');
  const base = 'repos/' + repository;
  const state = await inventory(api, base, runId, maxRuns);
  const plan = planArtifactCleanup({ ...state, now, targetBytes });
  const selected = [];
  let count = 0;
  for (const group of plan.groups) {
    if (count + group.artifacts.length > maxDeletes) continue;
    selected.push(group);
    count += group.artifacts.length;
  }
  /** @type {{id: number, name: string, runId: number, bytes: number, reason: string}[]} */
  const deleted = [];
  const skipped = [];
  let lastDeletionAt = 0;
  let failure;
  if (apply) {
    // Backoff here would invalidate earlier checks. Re-plan on the next pass.
    const validationApi = (method, path) => api(method, path, { retry: false });
    try {
      for (const group of selected) {
        for (const artifact of group.artifacts) {
          // Pace mutations before eligibility checks so a pause never
          // sits between verification and deletion.
          const delay = 1000 - (Date.now() - lastDeletionAt);
          if (delay > 0) await setTimeout(delay);
          // Cross-run release downloads can start after the initial inventory.
          if (
            group.kind === 'release' &&
            (await activeQualifications(validationApi, base)).length
          ) {
            skipped.push({
              group: group.key,
              reason: 'managed qualification became active',
            });
            break;
          }
          const run = await validationApi(
            'GET',
            base + '/actions/runs/' + group.run.id,
          );
          if (
            !run ||
            run.status !== 'completed' ||
            run.run_attempt !== group.run.run_attempt ||
            run.updated_at !== group.run.updated_at
          ) {
            skipped.push({
              group: group.key,
              reason: 'run changed or is no longer completed',
            });
            break;
          }
          await api('DELETE', base + '/actions/artifacts/' + artifact.id);
          lastDeletionAt = Date.now();
          deleted.push({
            id: artifact.id,
            name: artifact.name,
            runId: run.id,
            bytes: artifact.size_in_bytes,
            reason: group.reason,
          });
        }
      }
    } catch (error) {
      // Keep an audit of partial progress when GitHub asks us to stop.
      failure = error instanceof Error ? error.message : String(error);
    }
  }
  const deletedIds = new Set(deleted.map((artifact) => artifact.id));
  return {
    repository,
    scope: runId ? 'run ' + runId : 'repository',
    mode: apply ? 'apply' : 'dry-run',
    asOf: new Date(now).toISOString(),
    beforeBytes: plan.beforeBytes,
    afterBytes:
      plan.beforeBytes -
      deleted.reduce((sum, artifact) => sum + artifact.bytes, 0),
    plannedAfterBytes:
      plan.beforeBytes - selected.reduce((sum, group) => sum + group.bytes, 0),
    targetBytes: plan.targetBytes,
    activeBytes: plan.activeBytes,
    protectedBytes: plan.protectedBytes,
    pendingRuns: state.pendingRuns,
    remainingGroups: apply
      ? plan.groups.filter((group) =>
          group.artifacts.some((artifact) => !deletedIds.has(artifact.id)),
        ).length
      : plan.groups.length - selected.length,
    unknown: plan.unknown.map(({ id, name, size_in_bytes }) => ({
      id,
      name,
      bytes: size_in_bytes,
    })),
    selected: selected.flatMap((group) =>
      group.artifacts.map((artifact) => ({
        id: artifact.id,
        name: artifact.name,
        runId: group.run.id,
        bytes: artifact.size_in_bytes,
        reason: group.reason,
      })),
    ),
    deleted,
    skipped,
    failure,
  };
}

function summary(report) {
  const mib = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
  const clean = (name) => name.replace(/[|`\r\n]/g, '');
  const rows = report.mode === 'apply' ? report.deleted : report.selected;
  const unknown = [...new Set(report.unknown.map((artifact) => artifact.name))];
  return [
    `## Actions artifact cleanup (${report.mode})`,
    '',
    `${report.repository}, ${report.scope}: ${mib(report.beforeBytes)} before; ${mib(report.afterBytes)} after accounted deletions.`,
    ...(report.mode === 'dry-run'
      ? [`Projected after this pass: ${mib(report.plannedAfterBytes)}.`]
      : []),
    `Completed-run target: ${mib(report.targetBytes)}. Active inputs: ${mib(report.activeBytes)}; protected/unresolved: ${mib(report.protectedBytes)}.`,
    `Unknown artifacts: ${report.unknown.length}; uninspected runs: ${report.pendingRuns}; remaining candidate groups: ${report.remainingGroups}.`,
    ...unknown
      .slice(0, 20)
      .map((name) => `Review unknown category: ${clean(name)}.`),
    '',
    '| Artifact | Run | Size | Reason |',
    '| --- | --- | --- | --- |',
    ...rows.map(
      ({ id, name, runId, bytes, reason }) =>
        `| ${id} ${clean(name)} | ${runId} | ${mib(bytes)} | ${reason} |`,
    ),
    ...report.skipped.map(
      ({ group, reason }) => `Skipped ${group}: ${reason}.`,
    ),
    ...(report.failure ? ['', `Cleanup stopped: ${report.failure}`] : []),
    '',
    'Concurrent uploads and GitHub billing delays are not reflected in accounted deletions. Cleanup never restores accrued monthly usage.',
    '',
  ].join('\n');
}

async function main() {
  const { values } = parseArgs({
    options: {
      repo: { type: 'string', default: process.env.GITHUB_REPOSITORY },
      apply: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      'run-id': { type: 'string' },
      'max-runs': { type: 'string', default: '80' },
      'max-deletes': { type: 'string', default: '100' },
      output: { type: 'string' },
    },
  });
  if (values.apply && values['dry-run'])
    throw new Error('Choose --apply or --dry-run, not both');
  const positive = (value) => {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number <= 0)
      throw new Error('Expected a positive integer: ' + value);
    return number;
  };
  const token =
    process.env.GH_TOKEN ||
    process.env.GITHUB_TOKEN ||
    execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  const report = await cleanupArtifacts(githubApi(token), {
    repository: values.repo ?? '',
    apply: values.apply,
    runId: values['run-id'] ? positive(values['run-id']) : undefined,
    maxRuns: positive(values['max-runs']),
    maxDeletes: positive(values['max-deletes']),
  });
  if (values.output)
    writeFileSync(values.output, JSON.stringify(report, null, 2) + '\n');
  const markdown = summary(report);
  console.log(markdown);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  if (report.failure) process.exitCode = 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

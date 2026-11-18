import { ORPCError } from '@orpc/client';
import {
  API_URL_PATH,
  getDefaultApiUrl,
  getApiUrlSource,
  normalizeApiUrl,
  resolveApiTarget,
  resolveLocalApiTarget,
  writePersistedApiUrl,
  type ApiUrlSource,
} from '../../shared/config.js';
import { isJsonMode, printSuccess, printWarning } from '../utils/output.js';
import { suggestFilter } from '../utils/suggest-filter.js';
import { safePrompts } from '../utils/safe-prompts.js';
import { checkApiVersion } from '../../shared/services/api-client/runtime.js';
import { createApiClient } from '../../shared/services/api-client/rpc.js';
import { readLocalApiToken } from '../../shared/services/auth.js';
import { type StatusWorkloadMetadata as StoredWorkload } from '../../shared/api-contract/workload-management-schemas.js';
import { WorkloadState, WorkloadType } from '../../shared/workload.js';
import { isHostedApiImage } from '../../shared/hosted-api.js';
import type { LocalApiContainerInspection } from '../../shared/local-api-container.js';
import { errorMessage } from '../../shared/log-diagnostics.js';

const HEALTH_TIMEOUT_MS = 5000;
const DISCOVERY_TIMEOUT_MS = 6000;

export interface ApiTargetCandidate {
  id: string;
  label: string;
  url: string;
  source: 'local' | 'manual';
  apiVersion?: string;
}

export type ApiTargetKind = 'local' | 'manual';
export type ApiTargetHealth = 'healthy' | 'unreachable';
export type ApiTargetSource = ApiUrlSource | 'manual';

export interface ApiTargetRow {
  current: boolean;
  kind: ApiTargetKind;
  id: string;
  label: string;
  url: string;
  health: ApiTargetHealth;
  apiVersion?: string;
  compatible: boolean;
  source: ApiTargetSource;
  reason?: string;
}

/** A Service of the removed `anycloud api serve` path that the local API still manages. */
export interface VmHostedApi {
  id: string;
  url: string;
  installerUrl: string;
}

/**
 * `anycloud api serve` is gone; an API it left on a VM is retired with
 * `anycloud terminate` and replaced by a cluster-hosted one.
 */
export function vmHostedApiMigrationMessage(api: VmHostedApi): string {
  return (
    `${api.url} is a VM-hosted API (the removed anycloud api serve); it can no longer be updated. ` +
    'Create its successor with "anycloud api create <name> --cloud <cloud> --region <region> --vm-type <type>", ' +
    'select it with "anycloud api use https://<cluster-id>.anycloud.sh" (then "anycloud credentials new" and "anycloud api access add" there), ' +
    `and retire the VM-hosted API through its installer API with "API_URL=${api.installerUrl} anycloud terminate ${api.id}".`
  );
}

export interface ApiTargetDiscovery {
  activeUrl: string;
  activeSource: ApiUrlSource;
  targets: ApiTargetRow[];
  warnings: string[];
}

export interface ApiTargetInfo {
  url: string;
  source: ApiUrlSource;
  sourceLabel: string;
  healthy: boolean;
  cliVersion: string;
  apiVersion?: string;
  compatible: boolean;
  compatibilityReason?: string;
}

export function describeApiUrlSource(source = getApiUrlSource()): string {
  switch (source) {
    case 'env':
      return 'API_URL env override';
    case 'file':
      return API_URL_PATH;
    case 'default':
      return 'default local API';
  }
}

export function sameApiUrl(a: string, b: string): boolean {
  try {
    return normalizeApiUrl(a) === normalizeApiUrl(b);
  } catch {
    return a === b;
  }
}

function sourceForUrl(
  url: string,
  activeUrl: string,
  activeSource: ApiUrlSource,
) {
  return sameApiUrl(url, activeUrl) ? activeSource : undefined;
}

export async function checkApiHealth(url: string): Promise<boolean> {
  const normalized = normalizeApiUrl(url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(`${normalized}/health`, {
      signal: controller.signal,
    });
    return response.status === 200;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getActiveApiTargetInfo(): Promise<ApiTargetInfo> {
  const { source, url } = resolveApiTarget();
  const version = await checkApiVersion(url);
  return {
    url,
    source,
    sourceLabel: describeApiUrlSource(source),
    healthy: await checkApiHealth(url),
    cliVersion: version.cliVersion,
    apiVersion: version.apiVersion,
    compatible: version.compatible,
    compatibilityReason: version.reason,
  };
}

function hostedApiUrlForWorkload(workload: StoredWorkload): string {
  return `https://${workload.id}.anycloud.sh`;
}

function isVmHostedApiWorkload(workload: StoredWorkload): boolean {
  return (
    workload.workloadType === WorkloadType.Service &&
    workload.state === WorkloadState.Running &&
    workload.image !== null &&
    isHostedApiImage(workload.image)
  );
}

/**
 * The active target when it is a VM-hosted API the local API still manages
 * (its Service carries the API image and answers at `https://<id>.anycloud.sh`),
 * or null. Read from the local API, which is the registry of such Services.
 */
export async function activeVmHostedApi(
  targets: { activeUrl: string; localUrl: string } = resolvedTargetUrls(),
): Promise<VmHostedApi | null> {
  if (sameApiUrl(targets.localUrl, targets.activeUrl)) return null;
  const accessToken = await readLocalApiToken();
  if (!accessToken) return null;
  const id = new URL(targets.activeUrl).hostname.match(
    /^([a-zA-Z0-9-]+)\.anycloud\.sh$/u,
  )?.[1];
  if (!id || !sameApiUrl(`https://${id}.anycloud.sh`, targets.activeUrl))
    return null;
  const match = await readLegacyApiWorkload(targets.localUrl, accessToken, id);
  return match && isVmHostedApiWorkload(match)
    ? {
        id: match.id,
        url: hostedApiUrlForWorkload(match),
        installerUrl: targets.localUrl,
      }
    : null;
}

function resolvedTargetUrls(): { activeUrl: string; localUrl: string } {
  const activeTarget = resolveApiTarget();
  const localUrl =
    activeTarget.source === 'default'
      ? activeTarget.url
      : resolveLocalApiTarget().url;
  return { activeUrl: activeTarget.url, localUrl };
}

async function inspectApiTarget(params: {
  kind: ApiTargetKind;
  id: string;
  label: string;
  url: string;
  source: ApiTargetSource;
  activeUrl: string;
}): Promise<ApiTargetRow> {
  const url = normalizeApiUrl(params.url);
  const [healthy, version] = await Promise.all([
    checkApiHealth(url),
    checkApiVersion(url),
  ]);
  const compatible = healthy && version.compatible;
  return {
    current: sameApiUrl(url, params.activeUrl),
    kind: params.kind,
    id: params.id,
    label: params.label,
    url,
    health: healthy ? 'healthy' : 'unreachable',
    apiVersion: version.apiVersion,
    compatible,
    source: params.source,
    reason: compatible
      ? undefined
      : healthy
        ? (version.reason ?? 'version mismatch')
        : 'health check failed',
  };
}

async function readLegacyApiWorkload(
  apiUrl: string,
  accessToken: string,
  id: string,
): Promise<StoredWorkload | null> {
  const url = normalizeApiUrl(apiUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);

  try {
    const client = createApiClient(accessToken, {
      apiUrl: url,
      requestTimeoutMs: null,
    });
    const result = await client.workloads.status(
      { params: { id }, query: {} },
      { signal: controller.signal },
    );
    return result.workload;
  } catch (error) {
    // No local API answered (not running, or timed out): it holds no
    // VM-hosted API to report.
    if (!(error instanceof ORPCError)) return null;
    if (error.status === 404) return null;
    throw new Error(
      `Could not inspect API ${id} through ${url}: ${errorMessage(error)}`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

function defaultLocalApiUnavailableWarning(
  url: string,
  inspection: LocalApiContainerInspection | undefined,
): string {
  switch (inspection?.failure) {
    case 'timeout':
      return `Timed out checking the local API container for ${url}. Check that Docker is responsive.`;
    case 'unavailable':
      return `Docker is unavailable, so the local API container at ${url} could not be checked. Start Docker and try again.`;
    case 'malformed':
      return `Docker returned an invalid response while checking the local API container for ${url}.`;
    case 'missing':
      return `No local API server is running at ${url}. Start one with: anycloud api start`;
    case undefined:
      break;
  }

  if (inspection?.running) {
    return `Local API server at ${url} is unreachable. Check logs with: anycloud api logs`;
  }

  return `No local API server is running at ${url}. Start one with: anycloud api start`;
}

export async function discoverApiTargetRows(): Promise<ApiTargetDiscovery> {
  const activeTarget = resolveApiTarget();
  const activeSource = activeTarget.source;
  const activeUrl = activeTarget.url;
  // The active API and its local lifecycle manager are independent targets:
  // API_URL may point at a cluster-hosted API while the Docker-backed local
  // API is the installer's.
  const localTarget =
    activeSource === 'default' ? activeTarget : resolveLocalApiTarget();
  const localUrl = localTarget.url;
  const localApiContainer = localTarget.localApiContainer;
  const hasRunningLocalContainer = !!localApiContainer?.running;
  const warnings: string[] = [];
  const rows: ApiTargetRow[] = [];

  const localRow = await inspectApiTarget({
    kind: 'local',
    id: 'local',
    label: 'local',
    url: localUrl,
    source: sourceForUrl(localUrl, activeUrl, activeSource) ?? 'default',
    activeUrl,
  });
  const localUnavailable = localRow.health === 'unreachable';
  const missingLocal = localUnavailable && !hasRunningLocalContainer;

  if (!missingLocal) {
    rows.push(localRow);
  }

  if (localUnavailable) {
    warnings.push(
      defaultLocalApiUnavailableWarning(localUrl, localApiContainer),
    );
  } else {
    // One release of courtesy: an API that `anycloud api serve` left on a VM
    // is named for what it is, with the way to its successor.
    try {
      const legacy = await activeVmHostedApi({ activeUrl, localUrl });
      if (legacy) warnings.push(vmHostedApiMigrationMessage(legacy));
    } catch (error) {
      warnings.push((error as Error).message);
    }
  }

  const activeIsMissingLocal = missingLocal && sameApiUrl(localUrl, activeUrl);
  if (
    !activeIsMissingLocal &&
    !rows.some((row) => sameApiUrl(row.url, activeUrl))
  ) {
    rows.unshift(
      await inspectApiTarget({
        kind: 'manual',
        id: '-',
        label: 'active',
        url: activeUrl,
        source: activeSource,
        activeUrl,
      }),
    );
  }

  return {
    activeUrl,
    activeSource,
    targets: rows,
    warnings,
  };
}

function rowToCandidate(row: ApiTargetRow): ApiTargetCandidate {
  return {
    id: row.id,
    label: row.label,
    url: row.url,
    source: row.kind,
    apiVersion: row.apiVersion,
  };
}

export function selectableApiTargets(
  rows: ApiTargetRow[],
): ApiTargetCandidate[] {
  return rows
    .filter((row) => row.health === 'healthy' && row.compatible)
    .map(rowToCandidate);
}

export async function selectApiTarget(
  candidates: ApiTargetCandidate[],
  message = 'Select API server',
): Promise<ApiTargetCandidate | undefined> {
  const urlWidth = Math.max(...candidates.map((c) => c.url.length), 12);
  const choices = candidates.map((candidate) => ({
    title: `${candidate.url.padEnd(urlWidth)}  ${candidate.label}`,
    value: candidate,
  }));

  const selection = await safePrompts<'target'>({
    type: 'autocomplete',
    name: 'target',
    message,
    hint: 'Type to filter',
    choices,
    suggest: suggestFilter,
  });

  return selection.target;
}

/** `local`, or an API URL as given; anything else is not a target. */
export function resolveApiTargetArgument(target: string): ApiTargetCandidate {
  if (target === 'local') {
    return {
      id: 'local',
      label: 'local',
      url: getDefaultApiUrl(),
      source: 'local',
    };
  }
  if (/^https?:\/\//i.test(target)) {
    return {
      id: normalizeApiUrl(target),
      label: 'manual URL',
      url: normalizeApiUrl(target),
      source: 'manual',
    };
  }
  throw new Error(
    `"${target}" is not an API URL. Pass https://<cluster-id>.anycloud.sh (anycloud cluster list names it) or "local".`,
  );
}

export async function persistApiTarget(
  candidate: ApiTargetCandidate,
): Promise<void> {
  if (candidate.source !== 'local') {
    const healthy = await checkApiHealth(candidate.url);
    if (!healthy) {
      throw new Error(`${candidate.url}/health did not return 200`);
    }
    const version = await checkApiVersion(candidate.url);
    if (!version.compatible) {
      throw new Error(
        `Cannot select incompatible API ${candidate.url}: ${version.reason ?? 'version mismatch'}`,
      );
    }
  }

  const normalized = writePersistedApiUrl(candidate.url);
  printSuccess(`Active API set to ${normalized}.`);
  if (!isJsonMode() && process.env.API_URL) {
    printWarning(
      'API_URL is currently set; it will override this selection until you unset it.',
    );
  }
}

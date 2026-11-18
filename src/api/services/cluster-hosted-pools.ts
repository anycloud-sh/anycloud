import { ANYCLOUD_CLIENT_VERSION_HEADER } from '../../shared/api-version.js';
import { apiTokenResponseSchema } from '../../shared/api-contract/api-access-schemas.js';
import { listNodePoolsResponseSchema } from '../../shared/api-contract/node-pools-schemas.js';
import { systemBackupResponseSchema } from '../../shared/api-contract/system-release-schemas.js';
import { errorMessage } from '../../shared/log-diagnostics.js';
import { WorkloadState } from '../../shared/workload.js';
import {
  hostedVersionFix,
  type HostedNodePoolInventory,
  type HostedNodePoolInventorySource,
} from './clusters-domain.js';
import { HostedApiAccessError } from './cluster-errors.js';
import type { GithubOwner } from './api-authentication.js';
import type { StoredCluster } from './cluster-installer-store.js';
import { clusterApiUrl } from '../../shared/api-ingress.js';

const REQUEST_TIMEOUT_MS = 10_000;
/**
 * A backup copies and uploads the database, normally in seconds. The wait is
 * best effort: the route's 90 s bounds only its client, so a backup past 95 s
 * is reported failed while it may still run. Both stay under Cloudflare's
 * 100 s proxy read timeout on the hostname.
 */
const BACKUP_TIMEOUT_MS = 95_000;

/**
 * The installer asks the hosted API — at the installation's hostname, with
 * the owner's API token, exchanged and never rotated (404: an older API takes
 * the sign-in) — which node pools it still manages and which of them live
 * Deployments or Workloads still reference.
 * Network failures, timeouts
 * and 5xx (after one retry) are `unreachable`; 401/403 and a version
 * mismatch are hard errors that name the fix.
 */
export interface HostedNodePoolInventoryClient
  extends HostedNodePoolInventorySource {
  inventory(
    installation: Pick<StoredCluster, 'id'>,
    owner: Pick<GithubOwner, 'token'>,
  ): Promise<HostedNodePoolInventory>;
  backup(
    installation: Pick<StoredCluster, 'id'>,
    owner: Pick<GithubOwner, 'token'>,
  ): Promise<{ backedUpAt: string }>;
}

export function createHostedNodePoolInventory(deps: {
  clientVersion: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): HostedNodePoolInventoryClient {
  const fetchImpl = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const call = (url: string, bearer: string, method = 'GET', ms = timeoutMs) =>
    fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${bearer}`,
        [ANYCLOUD_CLIENT_VERSION_HEADER]: deps.clientVersion,
      },
      signal: AbortSignal.timeout(ms),
    });
  /** The owner's API token, or the answer the rest of the loop reports. */
  async function exchange(url: string, githubToken: string) {
    const response = await call(`${url}/v1/api-token`, githubToken, 'POST');
    if (response.ok) {
      return apiTokenResponseSchema.parse(await response.json()).token;
    }
    return response.status === 404 ? githubToken : response;
  }
  return {
    /** One attempt: a failed backup is reported, and delete goes on. */
    async backup(installation, owner) {
      const url = clusterApiUrl(installation.id);
      const exchanged = await exchange(url, owner.token);
      const response =
        typeof exchanged === 'string'
          ? await call(
              `${url}/v1/system-release/backup`,
              exchanged,
              'POST',
              BACKUP_TIMEOUT_MS,
            )
          : exchanged;
      if (!response.ok) {
        const body = (await response.text().catch(() => '')).trim();
        const { message } = errorBody(body);
        throw new Error(
          `the hosted API answered HTTP ${response.status}${typeof message === 'string' ? `: ${message}` : body ? `: ${body.slice(0, 200)}` : ''}`,
        );
      }
      return systemBackupResponseSchema.parse(await response.json());
    },

    async inventory(
      installation: Pick<StoredCluster, 'id'>,
      owner: Pick<GithubOwner, 'token'>,
    ): Promise<HostedNodePoolInventory> {
      const url = clusterApiUrl(installation.id);
      let reason = 'not attempted';
      let bearer: string | undefined;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        let response: Response;
        try {
          const exchanged = bearer ?? (await exchange(url, owner.token));
          if (typeof exchanged === 'string') {
            bearer = exchanged;
            response = await call(`${url}/v1/node-pools`, bearer);
          } else {
            response = exchanged;
          }
        } catch (error) {
          reason = errorMessage(error);
          continue;
        }
        if (response.ok) {
          const pools = listNodePoolsResponseSchema.parse(
            await response.json(),
          ).nodePools;
          return {
            kind: 'pools',
            pools: pools
              .filter(
                (pool) =>
                  pool.state !== WorkloadState.Terminated || pool.releasing,
              )
              .map((pool) => ({
                id: pool.id,
                name: pool.name,
                liveReferences: pool.liveReferences,
              })),
          };
        }
        const body = await response.text().catch(() => '');
        if (
          response.status === 400 &&
          errorBody(body).code === 'CLIENT_VERSION_MISMATCH'
        ) {
          // Name the side that is behind: read the version the hosted API
          // serves (unknown when that read fails).
          const served = await fetchImpl(`${url}/v1/version`, {
            signal: AbortSignal.timeout(timeoutMs),
          })
            .then((version) => version.json() as Promise<{ version?: unknown }>)
            .then(({ version }) =>
              typeof version === 'string' ? version : null,
            )
            .catch(() => null);
          throw new HostedApiAccessError(
            url,
            400,
            body,
            hostedVersionFix(url, deps.clientVersion, served),
          );
        }
        if ([400, 401, 403].includes(response.status)) {
          throw new HostedApiAccessError(url, response.status, body);
        }
        reason = `HTTP ${response.status}${body ? `: ${body.trim().slice(0, 200)}` : ''}`;
      }
      return { kind: 'unreachable', reason };
    },
  };
}

/** An error body's code and message (native and oRPC alike), when JSON. */
function errorBody(body: string): { code?: unknown; message?: unknown } {
  try {
    return JSON.parse(body) as { code?: unknown; message?: unknown };
  } catch {
    return {};
  }
}

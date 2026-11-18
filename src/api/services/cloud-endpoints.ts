import { log } from './logger.js';

/**
 * Provider endpoint configuration (RFC 0034). Every overridable provider URL
 * resolves here and nowhere else: each accessor returns its environment
 * variable when set, otherwise the production default, and reads the
 * variable on every call so a value set mid-process reaches the next client
 * built. Only the provider client factories and the Lambda gateway may
 * call these. AWS has no accessor because the AWS SDK natively honors
 * `AWS_ENDPOINT_URL` and its per-service variants.
 *
 * The CLI's seed (RFC 0049 C26 (e)) runs the user's cloud CLIs, which honor
 * their own overrides; its one direct call, GCP Resource Manager's
 * `testIamPermissions`, takes `GCP_RESOURCE_MANAGER_ENDPOINT`
 * (src/cli/seed/accounts.ts).
 */

export const AZURE_PUBLIC_AUTHORITY_HOST = 'https://login.microsoftonline.com';

const loggedOverrides = new Set<string>();

function noteOverride(name: string, value: string): string {
  if (!loggedOverrides.has(name)) {
    loggedOverrides.add(name);
    // A redirected control plane must be diagnosable from its own logs.
    log.info('Cloud endpoint override active', { name, value });
  }
  return value;
}

function resolveEndpoint(
  name: string,
  raw: string | undefined,
  fallback: string,
): string {
  if (raw === undefined || raw === '') return fallback;
  return noteOverride(name, raw.replace(/\/+$/, ''));
}

function resolveOptionalEndpoint(
  name: string,
  raw: string | undefined,
): string | undefined {
  if (raw === undefined || raw === '') return undefined;
  return noteOverride(name, raw.replace(/\/+$/, ''));
}

/** Azure Resource Manager base URL, shared by every ARM management client. */
export function armEndpoint(): string {
  return resolveEndpoint(
    'AZURE_RESOURCE_MANAGER_ENDPOINT',
    process.env.AZURE_RESOURCE_MANAGER_ENDPOINT,
    'https://management.azure.com',
  );
}

/** Microsoft Entra login host used to mint ARM bearer tokens. */
export function azureAuthorityHost(): string {
  return resolveEndpoint(
    'AZURE_AUTHORITY_HOST',
    process.env.AZURE_AUTHORITY_HOST,
    AZURE_PUBLIC_AUTHORITY_HOST,
  );
}

const GCP_API_ENDPOINT_ERROR =
  'GCP_API_ENDPOINT must be an http(s) origin without credentials, path, query, fragment, or port 0';

function resolveGcpApiEndpoint(): URL | undefined {
  const raw = process.env.GCP_API_ENDPOINT;
  if (raw === undefined || raw === '') return undefined;

  const conflicts: string[] = [];
  if (process.env.STORAGE_EMULATOR_HOST) {
    conflicts.push('STORAGE_EMULATOR_HOST');
  }
  if (process.env.BIGQUERY_EMULATOR_HOST) {
    conflicts.push('BIGQUERY_EMULATOR_HOST');
  }
  if (conflicts.length > 0) {
    throw new Error(
      `GCP_API_ENDPOINT cannot be combined with ${conflicts.join(', ')}; ` +
        'the Google SDK emulator variables take precedence over constructor options',
    );
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(GCP_API_ENDPOINT_ERROR);
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.port === '0'
  ) {
    throw new Error(GCP_API_ENDPOINT_ERROR);
  }
  noteOverride('GCP_API_ENDPOINT', url.origin);
  return url;
}

/**
 * GCP API origin for compute, storage, and BigQuery clients. No production
 * default exists here: unset means each Google SDK computes its own
 * per-service host.
 */
export function gcpApiEndpoint(): string | undefined {
  return resolveGcpApiEndpoint()?.origin;
}

/**
 * The GCP endpoint override translated for the GAPIC compute clients, which
 * take a bare hostname plus separate port and protocol options — handing
 * them a full URL produces requests against "https://https://…". Storage and
 * BigQuery parse the full URL from gcpApiEndpoint() instead.
 */
export function gcpGapicEndpointOptions():
  | { apiEndpoint: string; port: number; protocol: string }
  | undefined {
  const url = resolveGcpApiEndpoint();
  if (url === undefined) return undefined;
  const defaultPort = url.protocol === 'https:' ? 443 : 80;
  return {
    apiEndpoint: url.hostname,
    port: url.port === '' ? defaultPort : Number(url.port),
    protocol: url.protocol.slice(0, -1),
  };
}

/**
 * GCP universe domain. A non-default universe switches service-account auth
 * to self-signed tokens that never contact Google's token service, which is
 * what lets a fake receive authenticated calls; Google's token URL itself is
 * hardcoded in its auth library. The compute clients honor this variable
 * natively; it is passed explicitly so storage and BigQuery match.
 */
export function gcpUniverseDomain(): string | undefined {
  return resolveOptionalEndpoint(
    'GOOGLE_CLOUD_UNIVERSE_DOMAIN',
    process.env.GOOGLE_CLOUD_UNIVERSE_DOMAIN,
  );
}

/** Lambda cloud API base URL. */
export function lambdaApiBase(): string {
  return resolveEndpoint(
    'LAMBDA_API_BASE_URL',
    process.env.LAMBDA_API_BASE_URL,
    'https://cloud.lambda.ai/api/v1',
  );
}

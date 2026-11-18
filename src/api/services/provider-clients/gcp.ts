import { BigQuery } from '@google-cloud/bigquery';
import {
  DisksClient,
  FirewallsClient,
  GlobalOperationsClient,
  ImagesClient,
  InstancesClient,
  MachineTypesClient,
  ZoneOperationsClient,
} from '@google-cloud/compute';
import { Storage } from '@google-cloud/storage';
import {
  Compute,
  DownscopedClient,
  IdentityPoolClient,
  JWT,
} from 'google-auth-library';

import type {
  GCPCreds,
  GCPInstanceCreds,
  GCPRoleCreds,
} from '../../../shared/cloud.js';
import { DeployError } from '../../../shared/errors.js';
import { errorMessage } from '../../../shared/log-diagnostics.js';
import {
  gcpApiEndpoint,
  gcpGapicEndpointOptions,
  gcpUniverseDomain,
} from '../cloud-endpoints.js';
import { apiServiceAccountToken } from '../kubernetes/service-account-token.js';

/**
 * A key, a role connection (RFC 0047 amendment 9), or the management VM's
 * attached service account (RFC 0049 C26 (e)).
 */
type GcpCredentials = GCPCreds | GCPRoleCreds | GCPInstanceCreds;

function isGcpRole(credentials: GcpCredentials): credentials is GCPRoleCreds {
  return 'kind' in credentials && credentials.kind === 'role';
}

function isGcpInstance(
  credentials: GcpCredentials,
): credentials is GCPInstanceCreds {
  return 'kind' in credentials && credentials.kind === 'instance';
}

const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

// Compute's gax bundles its own google-auth-library: with no credentials
// its GoogleAuth resolves to the metadata server on the management VM, where
// nothing else is configured (GOOGLE_APPLICATION_CREDENTIALS is unset in
// the API's Pod). Only an instance credential reaches this.
let instanceComputeAuth: InstancesClient['auth'] | undefined;
function gcpInstanceComputeAuth(): InstancesClient['auth'] {
  return (instanceComputeAuth ??= new InstancesClient({
    ...(gcpGapicEndpointOptions() ?? {}),
    scopes: [CLOUD_PLATFORM_SCOPE],
  }).auth);
}

// One metadata-server client per process: it caches its token.
let instanceClient: Compute | undefined;
function gcpInstanceClient(): Compute {
  return (instanceClient ??= new Compute({ scopes: [CLOUD_PLATFORM_SCOPE] }));
}

type ComputeClientOptions = Omit<
  NonNullable<ConstructorParameters<typeof InstancesClient>[0]>,
  'credentials' | 'projectId'
>;
type ComputeConstructorOptions = NonNullable<
  ConstructorParameters<typeof InstancesClient>[0]
>;
type StorageConstructorOptions = NonNullable<
  ConstructorParameters<typeof Storage>[0]
>;
type BigQueryOptions = Omit<
  NonNullable<ConstructorParameters<typeof BigQuery>[0]>,
  'credentials' | 'projectId'
>;
type BigQueryConstructorOptions = NonNullable<
  ConstructorParameters<typeof BigQuery>[0]
>;

/** A key's project, or the project a role's service account belongs to. */
export function gcpProjectId(credentials: GcpCredentials): string {
  return isGcpRole(credentials)
    ? credentials.serviceAccountEmail.split('@')[1]!.split('.')[0]!
    : credentials.projectId;
}

/** Storage and BigQuery take a role connection's client as is. */
function explicitOptions<T extends object>(
  credentials: GcpCredentials,
  options: T,
) {
  if (!('kind' in credentials)) return keyOptions(credentials, options);
  const universeDomain = gcpUniverseDomain();
  return {
    ...(universeDomain === undefined ? {} : { universeDomain }),
    ...options,
    projectId: gcpProjectId(credentials),
    authClient: isGcpInstance(credentials)
      ? gcpInstanceClient()
      : gcpRoleClient(credentials),
  };
}

function keyOptions<T extends object>(credentials: GCPCreds, options: T) {
  const universeDomain = gcpUniverseDomain();
  return {
    ...(universeDomain === undefined ? {} : { universeDomain }),
    ...options,
    projectId: credentials.projectId,
    credentials: {
      private_key: credentials.privateKey,
      client_email: credentials.clientEmail,
      // A non-default universe must also appear in the credential material,
      // or the SDK rejects the client/credential universe mismatch.
      ...(universeDomain === undefined
        ? {}
        : { universe_domain: universeDomain }),
    },
  };
}

function buildComputeClientOptions(
  credentials: GcpCredentials,
  options: ComputeClientOptions,
): ComputeConstructorOptions {
  if (isGcpInstance(credentials))
    return {
      ...(gcpGapicEndpointOptions() ?? {}),
      ...options,
      projectId: credentials.projectId,
      auth: gcpInstanceComputeAuth(),
    };
  if (isGcpRole(credentials))
    return {
      ...(gcpGapicEndpointOptions() ?? {}),
      ...options,
      projectId: gcpProjectId(credentials),
      auth: gcpRoleComputeAuth(credentials),
    };
  return keyOptions(credentials, {
    ...(gcpGapicEndpointOptions() ?? {}),
    ...options,
    // Canonical Compute must exchange the key through OAuth so invalid_grant
    // retains its structured cause. Non-default universes still use JWT auth.
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
}

function buildStorageClientOptions(
  credentials: GcpCredentials,
  options: ComputeClientOptions,
): StorageConstructorOptions {
  const apiEndpoint = gcpApiEndpoint();
  return explicitOptions(credentials, {
    ...(apiEndpoint === undefined
      ? {}
      : {
          apiEndpoint,
        }),
    ...options,
    // Storage assumes custom endpoints are unauthenticated emulators unless
    // authentication is explicitly retained. Keep this authoritative over
    // any shared client option when the environment override is active.
    ...(apiEndpoint === undefined ? {} : { useAuthWithCustomEndpoint: true }),
  });
}

function buildBigQueryClientOptions(
  credentials: GcpCredentials,
  options: BigQueryOptions,
): BigQueryConstructorOptions {
  const apiEndpoint = gcpApiEndpoint();
  return explicitOptions(credentials, {
    ...(apiEndpoint === undefined ? {} : { apiEndpoint }),
    ...options,
  });
}

export function createGcpImagesClient(
  credentials: GcpCredentials,
  options: ComputeClientOptions = {},
): ImagesClient {
  return new ImagesClient(buildComputeClientOptions(credentials, options));
}

export function createGcpGatewayClients(
  credentials: GcpCredentials,
  options: ComputeClientOptions,
): {
  instances: InstancesClient;
  firewalls: FirewallsClient;
  globalOperations: GlobalOperationsClient;
  zoneOperations: ZoneOperationsClient;
  images: ImagesClient;
  disks: DisksClient;
  machineTypes: MachineTypesClient;
  storage: Storage;
} {
  // The GAPIC compute clients treat apiEndpoint as a bare hostname and read
  // protocol and port separately; Storage and BigQuery parse a full URL. The
  // same override reaches each client in the shape it expects.
  const gapicOptions = buildComputeClientOptions(credentials, options);
  const storageOptions = buildStorageClientOptions(credentials, options);
  return {
    instances: new InstancesClient(gapicOptions),
    firewalls: new FirewallsClient(gapicOptions),
    globalOperations: new GlobalOperationsClient(gapicOptions),
    zoneOperations: new ZoneOperationsClient(gapicOptions),
    images: new ImagesClient(gapicOptions),
    disks: new DisksClient(gapicOptions),
    machineTypes: new MachineTypesClient(gapicOptions),
    storage: new Storage(storageOptions),
  };
}

/** The management VM's attached service account, through the metadata server. */
export function createGcpInstanceComputeClients(): {
  instances: InstancesClient;
} {
  return { instances: new InstancesClient() };
}

export function createGcpBigQueryClient(
  credentials: GcpCredentials,
  options: BigQueryOptions = {},
): BigQuery {
  return new BigQuery(buildBigQueryClientOptions(credentials, options));
}

/**
 * A Cloud Storage token limited by a Credential Access Boundary to the granted
 * buckets: object read and list, or object read, write and list. A prefix
 * limits a rule to the objects under it and to listings of it (RFC 0043).
 * Overwriting an object needs delete, so a readwrite rule deletes inside its
 * prefix or bucket, which is how GCS serves `noDelete`. It expires with its
 * source token, so each call signs a new one from the key to give it the full
 * hour. A role connection's impersonated token takes `lifetimeMs` instead,
 * floored at 10 minutes; a key's always lasts the hour. The exchange needs no
 * IAM permission, but the project must have the Security Token Service API
 * enabled.
 */
export async function mintGcpDownscopedToken(
  credentials: GcpCredentials,
  grants: ReadonlyArray<{
    bucket: string;
    prefix?: string;
    mode: 'read' | 'readwrite';
  }>,
  lifetimeMs?: number,
): Promise<{ token: string; expiresAt: number }> {
  // A new role client, like a newly signed key token, gives the full hour.
  const source = isGcpInstance(credentials)
    ? gcpInstanceClient()
    : isGcpRole(credentials)
      ? newGcpRoleClient(
          credentials,
          lifetimeMs === undefined
            ? undefined
            : Math.min(
                Math.max(Math.round(lifetimeMs / 1000), GCP_ROLE_MIN_SECONDS),
                3_600,
              ),
        )
      : gcpKeyClient(credentials);
  const accessBoundaryRules = grants.map(({ bucket, prefix, mode }) => ({
    availableResource: `//storage.googleapis.com/projects/_/buckets/${bucket}`,
    availablePermissions: [
      mode === 'read'
        ? 'inRole:roles/storage.objectViewer'
        : 'inRole:roles/storage.objectUser',
    ],
    // A list's resource is the bucket, so its prefix is an API attribute.
    ...(prefix && {
      availabilityCondition: {
        expression: `resource.name.startsWith('projects/_/buckets/${bucket}/objects/${prefix}') || api.getAttribute('storage.googleapis.com/objectListPrefix', '').startsWith('${prefix}')`,
      },
    }),
  }));
  let response: { token?: string | null; expirationTime?: number | null };
  try {
    response = await new DownscopedClient(source, {
      accessBoundary: { accessBoundaryRules },
    }).getAccessToken();
  } catch (error) {
    if (/SERVICE_DISABLED|Security Token Service API/.test(errorDetail(error)))
      throw new DeployError(
        `Enable the Security Token Service API (sts.googleapis.com) in GCP project ${gcpProjectId(credentials)}: Anycloud uses it to mint each Bucket's sync token.`,
        400,
      );
    throw error;
  }
  const { token, expirationTime } = response;
  if (!token || !expirationTime)
    throw new Error('GCP returned a downscoped token without an expiry');
  return { token, expiresAt: expirationTime };
}

/**
 * The project number behind a key's project ID, which GCS bucket metadata
 * names instead (Resource Manager `projects.get`, needing
 * `resourcemanager.projects.get`).
 */
export async function readGcpProjectNumber(
  credentials: GcpCredentials,
): Promise<string> {
  const projectId = gcpProjectId(credentials);
  const client = isGcpInstance(credentials)
    ? gcpInstanceClient()
    : isGcpRole(credentials)
      ? gcpRoleClient(credentials)
      : gcpKeyClient(credentials);
  const { data } = await client.request<{ name?: string }>({
    url: `https://cloudresourcemanager.${gcpUniverseDomain() ?? 'googleapis.com'}/v3/projects/${projectId}`,
  });
  const number = data.name?.match(/^projects\/(\d+)$/)?.[1];
  if (!number) {
    throw new Error(`GCP project ${projectId} has no number`);
  }
  return number;
}

/**
 * A role connection's client (RFC 0047 amendment 9): STS exchanges the
 * subject token at the workload identity provider, then impersonates the
 * service account. It asks for a new subject token at every exchange.
 */
export function createGcpRoleConnectionClient(
  connection: {
    readonly workloadIdentityProvider: string;
    readonly serviceAccountEmail: string;
  },
  subjectToken: () => Promise<string>,
  lifetimeSeconds?: number,
): IdentityPoolClient {
  return new IdentityPoolClient({
    ...gcpRoleConnectionOptions(connection, subjectToken),
    ...(lifetimeSeconds === undefined
      ? {}
      : {
          service_account_impersonation: {
            token_lifetime_seconds: lifetimeSeconds,
          },
        }),
  });
}

function gcpRoleConnectionOptions(
  connection: {
    readonly workloadIdentityProvider: string;
    readonly serviceAccountEmail: string;
  },
  subjectToken: () => Promise<string>,
) {
  const universeDomain = gcpUniverseDomain();
  const domain = universeDomain ?? 'googleapis.com';
  return {
    ...(universeDomain === undefined
      ? {}
      : { universe_domain: universeDomain }),
    type: 'external_account' as const,
    audience: `//iam.${domain}/${connection.workloadIdentityProvider}`,
    subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
    token_url: `https://sts.${domain}/v1/token`,
    service_account_impersonation_url: `https://iamcredentials.${domain}/v1/projects/-/serviceAccounts/${connection.serviceAccountEmail}:generateAccessToken`,
    subject_token_supplier: { getSubjectToken: subjectToken },
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  };
}

// For Storage and BigQuery, one client per role and trust: it caches its
// access token, and gateways are rebuilt on every node pool pass.
const roleClients = new Map<string, IdentityPoolClient>();

function gcpRoleClient(role: GCPRoleCreds): IdentityPoolClient {
  const key = roleKey(role);
  let client = roleClients.get(key);
  if (!client) roleClients.set(key, (client = newGcpRoleClient(role)));
  return client;
}

// Compute's gax bundles its own google-auth-library, whose clients ours can't
// stand in for, so gax builds one GoogleAuth per role and every Compute client
// shares it, with its token.
const roleComputeAuths = new Map<string, InstancesClient['auth']>();

function gcpRoleComputeAuth(role: GCPRoleCreds): InstancesClient['auth'] {
  const key = roleKey(role);
  let auth = roleComputeAuths.get(key);
  if (!auth) {
    const universeDomain = gcpUniverseDomain();
    auth = new InstancesClient({
      ...(gcpGapicEndpointOptions() ?? {}),
      ...(universeDomain === undefined ? {} : { universeDomain }),
      credentials: gcpRoleConnectionOptions(role, () =>
        apiServiceAccountToken(role.audience),
      ),
    }).auth;
    roleComputeAuths.set(key, auth);
  }
  return auth;
}

/** A role and the trust it is exchanged under. */
function roleKey(role: GCPRoleCreds): string {
  return JSON.stringify([
    role.workloadIdentityProvider,
    role.serviceAccountEmail,
    role.issuer,
    role.audience,
  ]);
}

/** A storage token's floor: short enough to bound a leak. */
const GCP_ROLE_MIN_SECONDS = 600;

function newGcpRoleClient(
  role: GCPRoleCreds,
  lifetimeSeconds?: number,
): IdentityPoolClient {
  return createGcpRoleConnectionClient(
    role,
    () => apiServiceAccountToken(role.audience),
    lifetimeSeconds,
  );
}

function gcpKeyClient(credentials: GCPCreds): JWT {
  const universeDomain = gcpUniverseDomain();
  return new JWT({
    ...(universeDomain === undefined ? {} : { universeDomain }),
    email: credentials.clientEmail,
    key: credentials.privateKey,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
}

function errorDetail(error: unknown): string {
  const response = (error as { response?: { data?: unknown } } | null)
    ?.response;
  return `${errorMessage(error)} ${JSON.stringify(response?.data ?? '')}`;
}

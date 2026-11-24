/** Provider identities and provider-neutral cloud configuration values. */

export enum CloudType {
  AWS = 'AWS',
  GCP = 'GCP',
  Azure = 'Azure',
  Lambda = 'Lambda',
  Cloudflare = 'Cloudflare',
  Local = 'Local',
}

/** Accelerator software stack required by a resolved compute target. */
export enum GpuRuntime {
  Cuda = 'cuda',
  Rocm = 'rocm',
  Neuron = 'neuron',
  Unsupported = 'unsupported',
}

// Provider-neutral cloud failure diagnosis persisted in workload events and
// rendered by both the API and CLI. Gateways translate raw provider errors into
// these shared values; orchestration never parses provider error strings.
export type CloudFailureDiagnosis =
  | 'invalid-target'
  | 'quota-exhausted-region'
  | 'quota-exhausted-account'
  | 'account-regional-spot-quota-exhausted'
  | 'capacity-exhausted'
  | 'bad-credential'
  | 'permission-denied'
  | 'invalid-request'
  | 'temporary-provider-failure'
  | 'provisioning-rejected';

export const CloudFailureDiagnosis = {
  InvalidTarget: 'invalid-target',
  QuotaExhaustedRegion: 'quota-exhausted-region',
  QuotaExhaustedAccount: 'quota-exhausted-account',
  AccountRegionalSpotQuotaExhausted: 'account-regional-spot-quota-exhausted',
  CapacityExhausted: 'capacity-exhausted',
  BadCredential: 'bad-credential',
  PermissionDenied: 'permission-denied',
  InvalidRequest: 'invalid-request',
  TemporaryProviderFailure: 'temporary-provider-failure',
  ProvisioningRejected: 'provisioning-rejected',
} as const satisfies Record<string, CloudFailureDiagnosis>;

export enum DiskTier {
  Medium = 'medium',
  High = 'high',
  Ultra = 'ultra',
}

export const DISK_TIER_VALUES = Object.values(DiskTier) as readonly DiskTier[];

export function isDiskTier(value: unknown): value is DiskTier {
  return (
    typeof value === 'string' &&
    (DISK_TIER_VALUES as readonly string[]).includes(value)
  );
}

export class AWSCreds {
  accessKeyId!: string;
  secretAccessKey!: string;
  // Set only for short-lived STS creds (e.g. the scoped GetFederationToken
  // minted for cross-cloud S3 bucket sync).
  sessionToken?: string;
}

/**
 * An AWS role connection (RFC 0047 amendment 8): the API assumes the role with
 * its own ServiceAccount token, so it holds no secret. The issuer, audience and
 * subject are what the role trusts.
 */
export class AWSRoleCreds {
  kind!: 'role';
  roleArn!: string;
  issuer!: string;
  audience!: string;
  subject!: string;
}

export class GCPCreds {
  projectId!: string;
  privateKey!: string;
  clientEmail!: string;
  // "project.dataset" pointing at the customer's Cloud Billing BigQuery
  // export. Unset means per-VM billing reconciliation is skipped.
  billingExportDataset?: string;
}

/**
 * A GCP role connection (RFC 0047 amendment 9): STS exchanges the API's
 * ServiceAccount token at the provider, then impersonates the account.
 */
export class GCPRoleCreds {
  kind!: 'role';
  workloadIdentityProvider!: string;
  serviceAccountEmail!: string;
  issuer!: string;
  audience!: string;
  subject!: string;
}

export class AzureCreds {
  applicationId!: string;
  secret!: string;
  directoryId!: string;
  subscriptionId!: string;
}

/**
 * An Azure role connection (RFC 0047 amendment 9): the API's ServiceAccount
 * token is the client assertion, so there is no secret.
 */
export class AzureRoleCreds {
  kind!: 'role';
  applicationId!: string;
  directoryId!: string;
  subscriptionId!: string;
  issuer!: string;
  audience!: string;
  subject!: string;
}

/**
 * The management VM's own identity (RFC 0049 C26 (e), owner question 10): the
 * credential a seeded hosted API uses for its backups and its own teardown,
 * from the instance profile (IMDSv2), the attached service account (the
 * metadata server) or the user-assigned managed identity. No user selects
 * it; only the API on the management VM, whose other Pods are kept off the
 * metadata service, can use it.
 */
export class AWSInstanceCreds {
  kind!: 'instance';
}

export class GCPInstanceCreds {
  kind!: 'instance';
  projectId!: string;
}

/**
 * No client ID: the management VM has exactly one user-assigned identity and
 * no system-assigned one, so IMDS issues that identity's token unasked.
 */
class AzureInstanceCreds {
  kind!: 'instance';
  directoryId!: string;
  subscriptionId!: string;
}

/** An Azure key, role connection or VM identity, as the API's Azure clients take it. */
export type AzureConnectionCreds =
  | AzureCreds
  | AzureRoleCreds
  | AzureInstanceCreds;

export class LambdaCreds {
  apiKey!: string;
}

/** R2 jurisdictions; each has its own S3 endpoint. */
export const CLOUDFLARE_JURISDICTIONS = ['default', 'eu', 'fedramp'] as const;
export type CloudflareJurisdiction = (typeof CLOUDFLARE_JURISDICTIONS)[number];

export class CloudflareCreds {
  accountId!: string;
  apiToken!: string;
  // Omitted means 'default'.
  jurisdiction?: CloudflareJurisdiction;
}

export interface AWSCredentials extends AWSCreds {
  cloudProvider: CloudType.AWS;
}

interface AWSRoleCredentials extends AWSRoleCreds {
  cloudProvider: CloudType.AWS;
}

export interface GCPCredentials extends GCPCreds {
  cloudProvider: CloudType.GCP;
}

interface GCPRoleCredentials extends GCPRoleCreds {
  cloudProvider: CloudType.GCP;
}

export interface AzureCredentials extends AzureCreds {
  cloudProvider: CloudType.Azure;
}

interface AzureRoleCredentials extends AzureRoleCreds {
  cloudProvider: CloudType.Azure;
}

export interface LambdaCredentials extends LambdaCreds {
  cloudProvider: CloudType.Lambda;
}

interface CloudflareCredentials extends CloudflareCreds {
  cloudProvider: CloudType.Cloudflare;
}

interface AWSInstanceCredentials extends AWSInstanceCreds {
  cloudProvider: CloudType.AWS;
}

interface GCPInstanceCredentials extends GCPInstanceCreds {
  cloudProvider: CloudType.GCP;
}

interface AzureInstanceCredentials extends AzureInstanceCreds {
  cloudProvider: CloudType.Azure;
}

/**
 * The management VM's identity as the API's gateways take it (RFC 0049 C26
 * (e)); never a saved credential, so apart from `CloudCredentials`.
 */
export type InstanceCloudCredentials =
  | AWSInstanceCredentials
  | GCPInstanceCredentials
  | AzureInstanceCredentials;

export type CloudCredentials =
  | AWSCredentials
  | AWSRoleCredentials
  | GCPCredentials
  | GCPRoleCredentials
  | AzureCredentials
  | AzureRoleCredentials
  | LambdaCredentials
  | CloudflareCredentials;

/**
 * A short-lived credential minted for one bucket sync: an S3 session (AWS
 * STS, Cloudflare R2), an Azure container SAS query string, or a downscoped
 * GCP access token.
 */
export type ScopedStorageCredentials =
  | AWSCredentials
  | { cloudProvider: CloudType.Azure; sasToken: string }
  | { cloudProvider: CloudType.GCP; accessToken: string };

/** Credentials that can run compute; Cloudflare's hold storage only. */
export type ComputeCloudCredentials = Exclude<
  CloudCredentials,
  CloudflareCredentials
>;
export type ComputeCreds =
  | AWSCreds
  | AWSRoleCreds
  | AWSInstanceCreds
  | GCPCreds
  | GCPRoleCreds
  | GCPInstanceCreds
  | AzureCreds
  | AzureRoleCreds
  | AzureInstanceCreds
  | LambdaCreds;

export interface CloudConfig {
  region?: string;
  /** A scalar VM type or an ordered fallback list before placement. */
  vmType?: string | string[];
  cloudProvider: CloudType;
  credentials?: ComputeCreds | CloudflareCreds;
  inputStorageCredentials?: CloudCredentials;
  inputStorageRegion?: string;
  outputStorageCredentials?: CloudCredentials;
  outputStorageRegion?: string;
  checkpointStorageCredentials?: CloudCredentials;
  checkpointStorageRegion?: string;
  spot?: boolean;
  inputBucket?: string;
  outputBucket?: string;
  checkpointBucket?: string;
  /** A Spot VM Job without the managed checkpoint bucket. */
  noCheckpoint?: boolean;
  diskSizeGb?: number;
  /** Without diskSizeGb, the smallest OS disk; the cloud may give more. */
  minimumDiskSizeGb?: number;
  diskTier?: DiskTier;
  /** AWS gp3 or GCP Hyperdisk Balanced root IOPS, overriding the disk tier's (a VM Job). */
  diskIops?: number;
  /** Its throughput in MiB/s, overriding the disk tier's. */
  diskThroughputMibps?: number;
  /** A VM Job: the regions it may launch in, instead of one `region`. */
  regions?: string[];
  /** GCP: launch with nested virtualization on; AWS follows the catalog. */
  nestedVirtualization?: boolean;
  availabilityZone?: string;
  minVmCount?: number;
  maxVmCount?: number;
}

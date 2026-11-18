import { createHmac } from 'node:crypto';
import {
  ComputeManagementClient,
  type ComputeManagementClientOptionalParams,
} from '@azure/arm-compute';
import {
  CostManagementClient,
  type CostManagementClientOptionalParams,
} from '@azure/arm-costmanagement';
import {
  NetworkManagementClient,
  type NetworkManagementClientOptionalParams,
} from '@azure/arm-network';
import {
  AzureQuotaExtensionAPI,
  type AzureQuotaExtensionAPIOptionalParams,
} from '@azure/arm-quota';
import {
  ResourceManagementClient,
  type ResourceManagementClientOptionalParams,
} from '@azure/arm-resources';
import {
  StorageManagementClient,
  type StorageManagementClientOptionalParams,
} from '@azure/arm-storage';
import {
  MicrosoftSupport,
  type MicrosoftSupportOptionalParams,
} from '@azure/arm-support';
import {
  AuthenticationError,
  AuthenticationRequiredError,
  ClientAssertionCredential,
  ClientSecretCredential,
  ManagedIdentityCredential,
  type TokenCredential,
} from '@azure/identity';
import {
  BlobServiceClient,
  ContainerSASPermissions,
  generateBlobSASQueryParameters,
  SASProtocol,
  StorageSharedKeyCredential,
} from '@azure/storage-blob';

import type {
  AzureConnectionCreds,
  AzureCreds,
} from '../../../shared/cloud.js';
import { apiServiceAccountToken } from '../kubernetes/service-account-token.js';
import {
  AZURE_PUBLIC_AUTHORITY_HOST,
  armEndpoint,
  azureAuthorityHost,
} from '../cloud-endpoints.js';

/** ARM endpoint options shared by every management client built here. */
function armEndpointOptions(): { endpoint: string; $host: string } {
  const endpoint = armEndpoint();
  return { endpoint, $host: endpoint };
}

/**
 * A role connection's credential (RFC 0047 amendment 9): the assertion is the
 * API's ServiceAccount token, asked for anew at every exchange.
 */
export function createAzureClientAssertionCredential(
  connection: { readonly directoryId: string; readonly applicationId: string },
  assertion: () => Promise<string>,
): ClientAssertionCredential {
  const authorityHost = azureAuthorityHost();
  return new ClientAssertionCredential(
    connection.directoryId,
    connection.applicationId,
    assertion,
    authorityHost === AZURE_PUBLIC_AUTHORITY_HOST
      ? {}
      : { authorityHost, disableInstanceDiscovery: true },
  );
}

/**
 * Whether Entra ID itself refused a token request. @azure/identity reports
 * every MSAL failure, a network one too, as AuthenticationRequired; only Entra
 * ID's own answers carry an AADSTS code.
 */
export function isAzureAuthRefusal(error: unknown): boolean {
  return (
    error instanceof AuthenticationError ||
    (error instanceof AuthenticationRequiredError &&
      /AADSTS\d+/.test(error.message))
  );
}

/** The scope a management token is requested for. */
export function azureManagementScope(): string {
  return `${armEndpoint()}/.default`;
}

// One credential per role and trust: MSAL caches its token, and gateways are
// rebuilt on every node pool pass.
const roleCredentials = new Map<string, ClientAssertionCredential>();

/** A key's secret credential, or a role connection's client assertion. */
export function createAzureCredential(
  credentials: AzureConnectionCreds,
): TokenCredential {
  if (!('kind' in credentials))
    return createAzureClientSecretCredential(credentials);
  if (credentials.kind === 'instance') return createAzureInstanceCredential();
  const key = JSON.stringify([
    credentials.directoryId,
    credentials.applicationId,
    credentials.issuer,
    credentials.audience,
  ]);
  let credential = roleCredentials.get(key);
  if (!credential)
    roleCredentials.set(
      key,
      (credential = createAzureClientAssertionCredential(credentials, () =>
        apiServiceAccountToken(credentials.audience),
      )),
    );
  return credential;
}

function createAzureClientSecretCredential(
  credentials: AzureCreds,
): ClientSecretCredential {
  const authorityHost = azureAuthorityHost();
  if (authorityHost === AZURE_PUBLIC_AUTHORITY_HOST) {
    return new ClientSecretCredential(
      credentials.directoryId,
      credentials.applicationId,
      credentials.secret,
    );
  }
  return new ClientSecretCredential(
    credentials.directoryId,
    credentials.applicationId,
    credentials.secret,
    // MSAL instance discovery only resolves against the public cloud, so a
    // redirected authority must also disable it.
    { authorityHost, disableInstanceDiscovery: true },
  );
}

export function createAzureComputeManagementClient(
  credential: TokenCredential,
  subscriptionId: string,
  options?: ComputeManagementClientOptionalParams,
): ComputeManagementClient {
  return new ComputeManagementClient(credential, subscriptionId, {
    ...armEndpointOptions(),
    ...options,
  });
}

export function createAzureNetworkManagementClient(
  credential: TokenCredential,
  subscriptionId: string,
  options?: NetworkManagementClientOptionalParams,
): NetworkManagementClient {
  return new NetworkManagementClient(credential, subscriptionId, {
    ...armEndpointOptions(),
    ...options,
  });
}

export function createAzureResourceManagementClient(
  credential: TokenCredential,
  subscriptionId: string,
  options?: ResourceManagementClientOptionalParams,
): ResourceManagementClient {
  return new ResourceManagementClient(credential, subscriptionId, {
    ...armEndpointOptions(),
    ...options,
  });
}

export function createAzureStorageManagementClient(
  credential: TokenCredential,
  subscriptionId: string,
  options?: StorageManagementClientOptionalParams,
): StorageManagementClient {
  return new StorageManagementClient(credential, subscriptionId, {
    ...armEndpointOptions(),
    ...options,
  });
}

export function createAzureCostManagementClient(
  credential: TokenCredential,
  options?: CostManagementClientOptionalParams,
): CostManagementClient {
  return new CostManagementClient(credential, {
    ...armEndpointOptions(),
    ...options,
  });
}

export function createAzureQuotaExtensionClient(
  credential: TokenCredential,
  options?: AzureQuotaExtensionAPIOptionalParams,
): AzureQuotaExtensionAPI {
  return new AzureQuotaExtensionAPI(credential, {
    ...armEndpointOptions(),
    ...options,
  });
}

export function createAzureSupportClient(
  credential: TokenCredential,
  subscriptionId: string,
  options?: MicrosoftSupportOptionalParams,
): MicrosoftSupport {
  return new MicrosoftSupport(credential, subscriptionId, {
    ...armEndpointOptions(),
    ...options,
  });
}

export function createAzureBlobServiceClient(
  storageAccountName: string,
  accountKey: string,
): BlobServiceClient {
  const credential = new StorageSharedKeyCredential(
    storageAccountName,
    accountKey,
  );
  return new BlobServiceClient(
    `https://${storageAccountName}.blob.core.windows.net`,
    credential,
  );
}

/** An HTTPS-only service SAS query for one container, signed with the account key. */
export function azureContainerSas(
  storageAccountName: string,
  accountKey: string,
  containerName: string,
  grant: { permissions: string; startsOn: Date; expiresOn: Date },
): string {
  const query = generateBlobSASQueryParameters(
    {
      containerName,
      permissions: ContainerSASPermissions.parse(grant.permissions),
      startsOn: grant.startsOn,
      expiresOn: grant.expiresOn,
      protocol: SASProtocol.Https,
    },
    new StorageSharedKeyCredential(storageAccountName, accountKey),
  );
  return query.toString();
}

const sasTime = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * An HTTPS-only service SAS for one directory (`sr=d`), signed with the
 * account key. `@azure/storage-blob` signs no directory SAS, so this follows
 * an earlier spike's signer, which Azure enforced on flat and hierarchical
 * accounts alike.
 */
export function azureDirectorySas(
  storageAccountName: string,
  accountKey: string,
  containerName: string,
  prefix: string,
  grant: { permissions: string; startsOn: Date; expiresOn: Date },
): string {
  const directory = prefix.replace(/\/+$/, '');
  const fields = {
    sp: grant.permissions,
    st: sasTime(grant.startsOn),
    se: sasTime(grant.expiresOn),
    spr: 'https',
    sv: '2021-08-06',
    sr: 'd',
  };
  // The string-to-sign since 2020-12-06. The blanks are the identifier and
  // IP, then the snapshot time, encryption scope and five response headers.
  const { sp, st, se, spr, sv, sr } = fields;
  const resource = `/blob/${storageAccountName}/${containerName}/${directory}`;
  const signed = [sp, st, se, resource, '', '', spr, sv, sr].join('\n');
  const sig = createHmac('sha256', Buffer.from(accountKey, 'base64'))
    .update(signed + '\n'.repeat(7), 'utf8')
    .digest('base64');
  return new URLSearchParams({
    ...fields,
    sdd: String(directory.split('/').length),
    sig,
  }).toString();
}

/**
 * The management VM's user-assigned managed identity (RFC 0049 C26 (e),
 * owner question 10), for the hosted API's backups: Storage Blob Data
 * Contributor on the checkpoint container only, so blobs are reached with
 * its token, never an account key.
 */
export function createAzureInstanceCredential(): TokenCredential {
  // The VM's one user-assigned identity, with no system-assigned one beside
  // it, so IMDS needs no client ID (the Azure seed guarantees both).
  return (instanceCredential ??= new ManagedIdentityCredential());
}

let instanceCredential: TokenCredential | undefined;

/** A blob client signed with an OAuth token rather than the account key. */
export function createAzureTokenBlobServiceClient(
  storageAccountName: string,
  credential: TokenCredential,
): BlobServiceClient {
  return new BlobServiceClient(
    `https://${storageAccountName}.blob.core.windows.net`,
    credential,
  );
}

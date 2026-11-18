import { ManagedIdentityCredential } from '@azure/identity';
import { describe, expect, it } from 'vitest';
import { CloudType } from '../../../src/shared/cloud.js';
import { bindInlineCredentials } from '../../../src/shared/cloud-config.js';
import { awsClientCredentials } from '../../../src/api/services/provider-clients/aws.js';
import { createAzureCredential } from '../../../src/api/services/provider-clients/azure.js';
import { createGcpGatewayClients } from '../../../src/api/services/provider-clients/gcp.js';

describe('the management VM’s identity in every gateway’s clients', () => {
  it('AWS: one instance-profile session provider per process', () => {
    const first = awsClientCredentials({ kind: 'instance' });
    expect(typeof first).toBe('function');
    expect(awsClientCredentials({ kind: 'instance' })).toBe(first);
  });

  it('Azure: the VM’s one managed identity, asked for without a client ID', () => {
    const credential = createAzureCredential({
      kind: 'instance',
      subscriptionId: 'sub-1',
      directoryId: 'tenant-1',
    });
    expect(credential).toBeInstanceOf(ManagedIdentityCredential);
  });

  it('GCP: the metadata server for Storage and Compute, in the named project', () => {
    const clients = createGcpGatewayClients(
      { kind: 'instance', projectId: 'proj-1' },
      {},
    );
    expect(clients.storage.projectId).toBe('proj-1');
    expect(clients.storage.authClient.cachedCredential?.constructor.name).toBe(
      'Compute',
    );
    // Compute shares one ambient auth, resolved only on the management VM.
    expect(
      createGcpGatewayClients({ kind: 'instance', projectId: 'proj-1' }, {})
        .instances.auth,
    ).toBe(clients.instances.auth);
  });

  it('never accepts an instance identity inline', () => {
    expect(() =>
      bindInlineCredentials(CloudType.GCP, {
        kind: 'instance',
        projectId: 'proj-1',
      }),
    ).toThrow('cannot name an instance identity');
  });
});

describe('gateways on the management VM’s identity', () => {
  it('build AWS and GCP storage on it, and refuse to mint pool bucket tokens from it', async () => {
    const { createStorageProvider } = await import(
      '../../../src/api/services/cloud-config.js'
    );
    const { canMintScopedStorageToken } = await import(
      '../../../src/api/services/gateways/cloud.js'
    );
    const aws = createStorageProvider({
      cloudProvider: CloudType.AWS,
      credentials: { kind: 'instance' },
      region: 'us-east-2',
    });
    expect(canMintScopedStorageToken(aws)).toBe(true);
    if (!canMintScopedStorageToken(aws)) return;
    expect(() => aws.validateScopedStorageTokenSource()).toThrow(
      'does not mint bucket-sync tokens',
    );
    const gcp = createStorageProvider({
      cloudProvider: CloudType.GCP,
      credentials: { kind: 'instance', projectId: 'proj-1' },
      region: 'us-central1',
    });
    expect(gcp.type).toBe(CloudType.GCP);
  });
});

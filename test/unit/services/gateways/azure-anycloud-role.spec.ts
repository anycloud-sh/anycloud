import { describe, expect, it } from 'vitest';
import anycloudRole from '../../../../src/shared/cloud-policies/azure-anycloud-role.json' with { type: 'json' };
import {
  permissionsFor,
  scanSdkOperations,
  scanSdkSnippet,
  sourceFiles,
  type SdkPermissionScan,
} from '../../helpers/sdk-permission-scan.js';

/**
 * RFC 0047 (Tracking item 3): the published Azure role grants exactly the ARM
 * actions Anycloud's API sends with the customer's service principal, as read
 * by the shared SDK permission scan.
 */

// Every ARM SDK operation the API may send, with the actions Azure checks for
// it. An operation missing here fails the scan instead of passing unseen.
const ACTIONS_BY_OPERATION: Record<string, string[]> = {
  'arm-compute:Disks.beginDelete': ['Microsoft.Compute/disks/delete'],
  'arm-compute:Disks.beginUpdate': ['Microsoft.Compute/disks/write'],
  'arm-compute:Disks.listByResourceGroup': ['Microsoft.Compute/disks/read'],
  'arm-compute:ResourceSkus.list': ['Microsoft.Compute/skus/read'],
  'arm-compute:UsageOperations.list': [
    'Microsoft.Compute/locations/usages/read',
  ],
  'arm-compute:VirtualMachineImages.list': [
    'Microsoft.Compute/locations/publishers/artifacttypes/offers/skus/versions/read',
  ],
  // Creating a VM also creates its OS disk, joins its NIC, and reads a
  // community-gallery image for GPU shapes.
  'arm-compute:VirtualMachines.beginCreateOrUpdate': [
    'Microsoft.Compute/virtualMachines/write',
    'Microsoft.Compute/disks/write',
    'Microsoft.Network/networkInterfaces/join/action',
    'Microsoft.Compute/locations/communityGalleries/images/versions/read',
  ],
  'arm-compute:VirtualMachines.beginDelete': [
    'Microsoft.Compute/virtualMachines/delete',
  ],
  'arm-compute:VirtualMachines.beginPowerOff': [
    'Microsoft.Compute/virtualMachines/powerOff/action',
  ],
  'arm-compute:VirtualMachines.beginStart': [
    'Microsoft.Compute/virtualMachines/start/action',
  ],
  'arm-compute:VirtualMachines.beginUpdate': [
    'Microsoft.Compute/virtualMachines/write',
  ],
  'arm-compute:VirtualMachines.get': ['Microsoft.Compute/virtualMachines/read'],
  'arm-compute:VirtualMachines.list': [
    'Microsoft.Compute/virtualMachines/read',
  ],
  'arm-compute:VirtualMachines.listAll': [
    'Microsoft.Compute/virtualMachines/read',
  ],
  // The cost query and its next-page POSTs.
  'arm-costmanagement:Query.usage': [
    'Microsoft.CostManagement/query/read',
    'Microsoft.CostManagement/query/action',
  ],
  'arm-costmanagement:CostManagementClient.sendRequest': [
    'Microsoft.CostManagement/query/read',
    'Microsoft.CostManagement/query/action',
  ],
  // A NIC references the subnet, public IP and network security group.
  'arm-network:NetworkInterfaces.beginCreateOrUpdate': [
    'Microsoft.Network/networkInterfaces/write',
    'Microsoft.Network/virtualNetworks/subnets/join/action',
    'Microsoft.Network/publicIPAddresses/join/action',
    'Microsoft.Network/networkSecurityGroups/join/action',
  ],
  'arm-network:NetworkInterfaces.beginDelete': [
    'Microsoft.Network/networkInterfaces/delete',
  ],
  'arm-network:NetworkInterfaces.get': [
    'Microsoft.Network/networkInterfaces/read',
  ],
  'arm-network:NetworkInterfaces.list': [
    'Microsoft.Network/networkInterfaces/read',
  ],
  'arm-network:NetworkInterfaces.updateTags': [
    'Microsoft.Network/networkInterfaces/write',
  ],
  'arm-network:NetworkSecurityGroups.beginCreateOrUpdate': [
    'Microsoft.Network/networkSecurityGroups/write',
  ],
  'arm-network:NetworkSecurityGroups.beginDelete': [
    'Microsoft.Network/networkSecurityGroups/delete',
  ],
  'arm-network:NetworkSecurityGroups.get': [
    'Microsoft.Network/networkSecurityGroups/read',
  ],
  'arm-network:NetworkSecurityGroups.list': [
    'Microsoft.Network/networkSecurityGroups/read',
  ],
  'arm-network:NetworkSecurityGroups.updateTags': [
    'Microsoft.Network/networkSecurityGroups/write',
  ],
  'arm-network:PublicIPAddresses.beginCreateOrUpdate': [
    'Microsoft.Network/publicIPAddresses/write',
  ],
  'arm-network:PublicIPAddresses.beginDelete': [
    'Microsoft.Network/publicIPAddresses/delete',
  ],
  'arm-network:PublicIPAddresses.get': [
    'Microsoft.Network/publicIPAddresses/read',
  ],
  'arm-network:PublicIPAddresses.list': [
    'Microsoft.Network/publicIPAddresses/read',
  ],
  'arm-network:PublicIPAddresses.updateTags': [
    'Microsoft.Network/publicIPAddresses/write',
  ],
  'arm-network:Subnets.get': ['Microsoft.Network/virtualNetworks/subnets/read'],
  'arm-network:VirtualNetworks.beginCreateOrUpdate': [
    'Microsoft.Network/virtualNetworks/write',
  ],
  'arm-network:VirtualNetworks.beginDelete': [
    'Microsoft.Network/virtualNetworks/delete',
  ],
  'arm-network:VirtualNetworks.get': ['Microsoft.Network/virtualNetworks/read'],
  'arm-network:VirtualNetworks.list': [
    'Microsoft.Network/virtualNetworks/read',
  ],
  'arm-network:VirtualNetworks.updateTags': [
    'Microsoft.Network/virtualNetworks/write',
  ],
  'arm-quota:QuotaOperations.list': ['Microsoft.Quota/quotas/read'],
  'arm-quota:QuotaRequestStatusOperations.list': [
    'Microsoft.Quota/quotaRequests/read',
  ],
  'arm-quota:UsagesOperations.list': ['Microsoft.Quota/usages/read'],
  'arm-resources:Providers.get': [
    'Microsoft.Resources/subscriptions/providers/read',
  ],
  // The gateway registers only these namespaces.
  'arm-resources:Providers.register': [
    'Microsoft.Compute/register/action',
    'Microsoft.Network/register/action',
    'Microsoft.Storage/register/action',
  ],
  'arm-resources:ResourceGroups.createOrUpdate': [
    'Microsoft.Resources/subscriptions/resourceGroups/write',
  ],
  'arm-resources:ResourceGroups.get': [
    'Microsoft.Resources/subscriptions/resourceGroups/read',
  ],
  'arm-resources:ResourceGroups.list': [
    'Microsoft.Resources/subscriptions/resourceGroups/read',
  ],
  'arm-storage:BlobServices.getServiceProperties': [
    'Microsoft.Storage/storageAccounts/blobServices/read',
  ],
  'arm-storage:BlobServices.setServiceProperties': [
    'Microsoft.Storage/storageAccounts/blobServices/write',
  ],
  'arm-storage:StorageAccounts.beginCreateAndWait': [
    'Microsoft.Storage/storageAccounts/write',
  ],
  'arm-storage:StorageAccounts.getProperties': [
    'Microsoft.Storage/storageAccounts/read',
  ],
  // The account key signs container SAS tokens and the API's own Blob calls,
  // so Blob data needs no data action.
  'arm-storage:StorageAccounts.listKeys': [
    'Microsoft.Storage/storageAccounts/listkeys/action',
  ],
  'arm-support:SupportTickets.list': ['Microsoft.Support/supportTickets/read'],
};

const ARM: SdkPermissionScan = {
  label: 'ARM',
  sdkPackage: /\/node_modules\/@azure\/(?<package>arm-[a-z]+)\//,
  sdkImport: /^@azure\/arm-/,
  endpointCalls: ['armEndpoint'],
  endpointLiterals: ['management.azure.com'],
  // Only the ARM client factory names the management endpoint.
  literalArguments: ['registerResourceProviders', 'ensureProviderRegistered'],
  // `run` is better-sqlite3's untyped statement call (db.ts) and `usages` a
  // quota response field (quota/azure.ts), both read off any in src/api.
  genericNames: new Set([
    'get',
    'list',
    'delete',
    'create',
    'update',
    'run',
    'usages',
  ]),
  endpointOwners: new Set([
    'src/api/services/cloud-endpoints.ts',
    'src/api/services/provider-clients/azure.ts',
    // Names only the ARM template schema; the user deploys the template.
    'src/api/services/role-connection-setup-templates.ts',
  ]),
};

const actionsFor = (operations: Map<string, string>) =>
  permissionsFor(operations, ACTIONS_BY_OPERATION, 'the published role');
const scanSnippet = (text: string) => scanSdkSnippet(ARM, text).operations;

// The hosted API's self-delete acts as the management VM's managed identity
// (Contributor on its own group), never as the published role.
const scan = scanSdkOperations(
  ARM,
  sourceFiles('src/api').filter(
    (file) => file !== 'src/api/services/gateways/self-delete.ts',
  ),
);
const operations = scan.operations;
const granted = anycloudRole.Actions;

describe('Anycloud Azure role', () => {
  it('0047/S11 grants exactly the ARM actions the API sends', () => {
    expect([...new Set(granted)].sort()).toEqual(
      [...new Set(actionsFor(operations))].sort(),
    );
    expect(granted).toHaveLength(new Set(granted).size);
  });

  it('0047/S4 needs no role assignment or managed identity', () => {
    expect(
      granted.filter((action) =>
        /^Microsoft\.(Authorization|ManagedIdentity)\//.test(action),
      ),
    ).toEqual([]);
    expect(anycloudRole.DataActions).toEqual([]);
  });

  const LIST_KEYS = ['Microsoft.Storage/storageAccounts/listkeys/action'];
  const STORAGE = `import type { StorageManagementClient } from '@azure/arm-storage';`;
  it.each([
    [
      'an optional chain',
      `${STORAGE} export const f = (c?: StorageManagementClient) => c?.storageAccounts.listKeys('rg', 'a');`,
    ],
    [
      'a Pick<> receiver',
      `${STORAGE} export const f = (c: Pick<StorageManagementClient, 'storageAccounts'>) => c.storageAccounts.listKeys('rg', 'a');`,
    ],
    [
      'a destructured method',
      `${STORAGE} export const f = (c: StorageManagementClient) => { const { listKeys } = c.storageAccounts; return listKeys('rg', 'a'); };`,
    ],
    [
      'element access',
      `${STORAGE} export const f = (c: StorageManagementClient) => c.storageAccounts['listKeys']('rg', 'a');`,
    ],
  ])('counts a call through %s', (_shape, source) => {
    expect(actionsFor(scanSnippet(source))).toEqual(LIST_KEYS);
  });

  it.each([
    [
      `import { ComputeManagementClient } from '@azure/arm-compute'; export const f = (c: ComputeManagementClient) => c.virtualMachines.beginDeallocate('rg', 'vm');`,
      /no permission mapping/,
    ],
    [
      `${STORAGE} export const f = (c: StorageManagementClient) => (c as any).storageAccounts.listKeys('rg', 'a');`,
      /casts a typed ARM SDK value/,
    ],
    [
      `import type { Missing } from '@azure/arm-missing'; export type T = Missing;`,
      /cannot resolve @azure\/arm-missing/,
    ],
    [
      `import { armEndpoint } from './services/cloud-endpoints.js'; export const f = () => fetch(armEndpoint() + '/subscriptions');`,
      /armEndpoint\(\)/,
    ],
    [
      `export const f = () => fetch('https://management.azure.com/subscriptions');`,
      /names the ARM endpoint/,
    ],
    [
      `${STORAGE} export const f = (c: StorageManagementClient) => { const x: any = c; return x.storageAccounts.listKeys('rg', 'a'); };`,
      /widens a typed ARM SDK value|reaches a typed ARM SDK operation through any/,
    ],
    [
      `${STORAGE} const send = (x: any) => x.storageAccounts.listKeys('rg', 'a'); export const f = (c: StorageManagementClient) => send(c);`,
      /widens a typed ARM SDK value|reaches a typed ARM SDK operation through any/,
    ],
    [
      `${STORAGE} const g = <T,>(x: T) => (x as any).storageAccounts.listKeys('rg', 'a'); export const f = (c: StorageManagementClient) => g(c);`,
      /widens a typed ARM SDK value|reaches a typed ARM SDK operation through any/,
    ],
    [
      `${STORAGE} const g = <T extends unknown>(x: T) => (x as any).listKeys('rg', 'a'); export const f = (c: StorageManagementClient) => g(c.storageAccounts);`,
      /widens a typed ARM SDK value|reaches a typed ARM SDK operation through any/,
    ],
    [
      `${STORAGE} export const f = (c: StorageManagementClient) => { const o: Record<string, any> = { ...c }; return o.storageAccounts.listKeys('rg', 'a'); };`,
      /widens a typed ARM SDK value|reaches a typed ARM SDK operation through any/,
    ],
    [
      `${STORAGE} export const f = (c: StorageManagementClient) => (Object.values(c)[0] as any).listKeys('rg', 'a');`,
      /widens a typed ARM SDK value|reaches a typed ARM SDK operation through any/,
    ],
    [
      `declare function registerResourceProviders(names: string[]): void; const name = 'Microsoft.Compute'; registerResourceProviders([name]);`,
      /non-literal argument/,
    ],
  ])('fails closed on %s', (source, reason) => {
    expect(() => actionsFor(scanSnippet(source))).toThrow(reason);
  });

  const blob: SdkPermissionScan = {
    ...ARM,
    sdkPackage: /\/node_modules\/@azure\/(?<package>storage-blob)\//,
    sdkImport: /^@azure\/storage-blob$/,
  };

  it('names an inherited method by the SDK class it is called on', () => {
    const operations = scanSdkSnippet(
      blob,
      `import type { BlockBlobClient } from '@azure/storage-blob'; export const f = (c: BlockBlobClient) => c.download();`,
    ).operations;
    expect([...operations.keys()]).toEqual([
      'storage-blob:BlockBlobClient.download',
    ]);
  });

  it('records a member read through a union receiver on every client', () => {
    const operations = scanSdkSnippet(
      blob,
      `import type { BlobClient, ContainerClient } from '@azure/storage-blob'; export const f = (c: BlobClient | ContainerClient) => c.exists();`,
    ).operations;
    expect([...operations.keys()].sort()).toEqual([
      'storage-blob:BlobClient.exists',
      'storage-blob:ContainerClient.exists',
    ]);
  });

  it.each([
    /\/node_modules\/@azure\/arm-[a-z]+\//,
    /\/node_modules\/@azure\/(arm-[a-z]+)\//,
  ])(
    'refuses a package pattern without a named package group: %s',
    (sdkPackage) => {
      expect(() =>
        scanSdkSnippet({ ...ARM, sdkPackage }, 'export {};'),
      ).toThrow('sdkPackage must capture the package name in (?<package>…)');
    },
  );

  const CLIENT = `${STORAGE} export const f = (c: StorageManagementClient) =>`;
  it.each([
    [
      'Map.set',
      `${STORAGE} const m = new Map<string, StorageManagementClient>(); export const f = (c: StorageManagementClient) => m.set('a', c);`,
    ],
    [
      'Array.push',
      `${STORAGE} const xs: StorageManagementClient[] = []; export const f = (c: StorageManagementClient) => xs.push(c);`,
    ],
    ['Promise.resolve', `${CLIENT} Promise.resolve(c);`],
    [
      'an identity generic',
      `${STORAGE} const id = <T,>(x: T): T => x; export const f = (c: StorageManagementClient) => id(c).storageAccounts.listKeys('rg', 'a');`,
    ],
    ['Object.keys', `${CLIENT} Object.keys(c);`],
  ])('accepts a type-safe use through %s', (_shape, source) => {
    expect(() => actionsFor(scanSnippet(source))).not.toThrow();
  });

  it.each([
    [
      'first([c])',
      `${STORAGE} const first = <T,>(xs: T[]) => (xs[0] as any).storageAccounts.listKeys('rg', 'a'); export const f = (c: StorageManagementClient) => first([c]);`,
    ],
    [
      'pick({ v: c })',
      `${STORAGE} const pick = <T,>(o: { v: T }) => (o.v as any).storageAccounts.listKeys('rg', 'a'); export const f = (c: StorageManagementClient) => pick({ v: c });`,
    ],
    [
      'run(() => c)',
      `${STORAGE} const run = <T,>(get: () => T) => (get() as any).storageAccounts.listKeys('rg', 'a'); export const f = (c: StorageManagementClient) => run(() => c);`,
    ],
  ])('fails on an SDK operation reached through %s', (_shape, source) => {
    expect(() => actionsFor(scanSnippet(source))).toThrow(
      /reaches a typed ARM SDK operation through any|widens a typed ARM SDK value/,
    );
  });

  it('refuses a package pattern that matches an SDK file with an empty name', () => {
    expect(() =>
      scanSdkSnippet(
        { ...ARM, sdkPackage: /\/node_modules\/@azure\/(?<package>x?)arm-/ },
        `${CLIENT} c.storageAccounts.listKeys('rg', 'a');`,
      ),
    ).toThrow(/matched .* without a package name/);
  });

  it('maps provider registration to the namespaces the API registers', () => {
    expect([...scan.literals].sort()).toEqual(
      ACTIONS_BY_OPERATION['arm-resources:Providers.register']!.map((action) =>
        action.replace('/register/action', ''),
      ),
    );
  });
});

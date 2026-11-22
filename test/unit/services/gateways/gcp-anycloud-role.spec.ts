import { readFileSync } from 'fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import anycloudRole from '../../../../src/shared/cloud-policies/gcp-anycloud-role.json' with { type: 'json' };
import {
  permissionsFor,
  scanSdkOperations,
  scanSdkSnippet,
  sourceFiles,
  type SdkPermissionScan,
} from '../../helpers/sdk-permission-scan.js';

/**
 * RFC 0047 scope item (h): the published GCP role grants exactly the
 * permissions Anycloud's API uses with the customer's service-account key, as
 * read by the shared SDK permission scan.
 */

// Every SDK operation the API may send, with the permissions GCP checks for
// it. An operation missing here fails the scan instead of passing unseen.
const PERMISSIONS: Record<string, string[]> = {
  '@google-cloud/bigquery:BigQuery.query': [
    'bigquery.jobs.create',
    'bigquery.tables.getData',
  ],
  '@google-cloud/compute:DisksClient.delete': ['compute.disks.delete'],
  '@google-cloud/compute:DisksClient.aggregatedListAsync': [
    'compute.disks.list',
  ],
  '@google-cloud/compute:DisksClient.listAsync': ['compute.disks.list'],
  '@google-cloud/compute:FirewallsClient.delete': [
    'compute.firewalls.delete',
    'compute.networks.updatePolicy',
  ],
  '@google-cloud/compute:FirewallsClient.insert': [
    'compute.firewalls.create',
    'compute.networks.updatePolicy',
  ],
  '@google-cloud/compute:FirewallsClient.listAsync': ['compute.firewalls.list'],
  '@google-cloud/compute:GlobalOperationsClient.wait': [
    'compute.globalOperations.get',
  ],
  '@google-cloud/compute:ImagesClient.getFromFamily': [
    'compute.images.getFromFamily',
  ],
  // VM Jobs' own network, made on first use (RFC 0053).
  '@google-cloud/compute:NetworksClient.get': ['compute.networks.get'],
  '@google-cloud/compute:NetworksClient.insert': ['compute.networks.create'],
  '@google-cloud/compute:InstancesClient.aggregatedListAsync': [
    'compute.instances.list',
  ],
  '@google-cloud/compute:InstancesClient.delete': ['compute.instances.delete'],
  '@google-cloud/compute:InstancesClient.get': ['compute.instances.get'],
  // A new boot disk on the default network's subnet, with an external IP,
  // the startup script, tags and labels, and labels on the boot disk;
  // scheduling for Spot and GPU VMs. Google lists each request field's
  // permission under "Required roles" for creating a VM.
  '@google-cloud/compute:InstancesClient.insert': [
    'compute.instances.create',
    'compute.disks.create',
    'compute.disks.setLabels',
    'compute.instances.setScheduling',
    'compute.subnetworks.use',
    'compute.subnetworks.useExternalIp',
    'compute.instances.setMetadata',
    'compute.instances.setTags',
    'compute.instances.setLabels',
  ],
  '@google-cloud/compute:InstancesClient.list': ['compute.instances.list'],
  '@google-cloud/compute:InstancesClient.listAsync': ['compute.instances.list'],
  '@google-cloud/compute:InstancesClient.setLabels': [
    'compute.instances.setLabels',
  ],
  '@google-cloud/compute:InstancesClient.start': ['compute.instances.start'],
  '@google-cloud/compute:MachineTypesClient.get': ['compute.machineTypes.get'],
  '@google-cloud/compute:ZoneOperationsClient.wait': [
    'compute.zoneOperations.get',
  ],
  '@google-cloud/storage:Bucket.deleteFiles': [
    'storage.objects.list',
    'storage.objects.delete',
  ],
  '@google-cloud/storage:Bucket.file': [],
  '@google-cloud/storage:Bucket.getFiles': ['storage.objects.list'],
  '@google-cloud/storage:Bucket.setMetadata': ['storage.buckets.update'],
  '@google-cloud/storage:File.createReadStream': ['storage.objects.get'],
  // Replacing an existing object also needs delete.
  '@google-cloud/storage:File.createWriteStream': [
    'storage.objects.create',
    'storage.objects.delete',
  ],
  '@google-cloud/storage:File.delete': ['storage.objects.delete'],
  // Bucket and File inherit these from ServiceObject; each keeps its caller.
  '@google-cloud/storage:Bucket.delete': ['storage.buckets.delete'],
  '@google-cloud/storage:Bucket.exists': ['storage.buckets.get'],
  '@google-cloud/storage:Bucket.getMetadata': ['storage.buckets.get'],
  '@google-cloud/storage:File.getMetadata': ['storage.objects.get'],
  '@google-cloud/storage:Storage.bucket': [],
  '@google-cloud/storage:Storage.createBucket': ['storage.buckets.create'],
  '@google-cloud/storage:Storage.getBuckets': ['storage.buckets.list'],
  // STS exchanges a token for a downscoped one without an IAM check.
  'google-auth-library:DownscopedClient.getAccessToken': [],
  // Only Resource Manager's `projects.get`, for the project number.
  'google-auth-library:JWT.request': ['resourcemanager.projects.get'],
  'google-auth-library:IdentityPoolClient.request': [
    'resourcemanager.projects.get',
  ],
  // The management VM's attached service account (RFC 0049 C26 (e)): the
  // same read, under its own rights.
  'google-auth-library:Compute.request': ['resourcemanager.projects.get'],
  // A role connection's exchange: STS checks the provider's trust, and the
  // impersonation binding, not the published role, grants the token.
  'google-auth-library:IdentityPoolClient.getAccessToken': [],
};

// Request fields that need more than their call does: attaching a VM identity
// needs `actAs` on it (RFC 0047 S8).
const FIELD_PERMISSIONS: Record<string, string[]> = {
  serviceAccounts: [
    'compute.instances.setServiceAccount',
    'iam.serviceAccounts.actAs',
  ],
};

const GOOGLE: SdkPermissionScan = {
  label: 'Google Cloud',
  sdkPackage:
    /\/node_modules\/(?<package>@google-cloud\/[a-z-]+|google-auth-library|google-gax|gaxios)\//,
  sdkImport:
    /^(@google-cloud\/|google-auth-library$|google-gax$|gaxios$|googleapis($|\/))/,
  endpointCalls: ['gcpApiEndpoint', 'gcpGapicEndpointOptions'],
  endpointLiterals: ['googleapis.com'],
  // Only the client factory names Google endpoints, auth scopes and the
  // Cloud Storage resource names a token is bounded to.
  endpointOwners: new Set([
    'src/api/services/cloud-endpoints.ts',
    'src/api/services/provider-clients/gcp.ts',
  ]),
  // Names GCP's SDK shares with untyped reads elsewhere in src/api: a SQLite
  // connection's close (repositories/db.ts), Azure's config credentials
  // (gateways/azure.ts) and a foreign-key pragma row's from
  // (database-domain.ts).
  genericNames: new Set(['close', 'credentials', 'from']),
};

/** Request fields in `text` that `FIELD_PERMISSIONS` names, in any form. */
function requestFields(file: string, text: string): string[] {
  const found: string[] = [];
  const named = (name: ts.Node | undefined): string | undefined =>
    name && ts.isComputedPropertyName(name)
      ? named(name.expression)
      : name &&
          (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) &&
          Object.hasOwn(FIELD_PERMISSIONS, name.text)
        ? name.text
        : undefined;
  const visit = (node: ts.Node): void => {
    const field =
      (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)
        ? named(node.name)
        : undefined) ??
      (ts.isPropertyAccessExpression(node) ? named(node.name) : undefined) ??
      (ts.isElementAccessExpression(node)
        ? named(node.argumentExpression)
        : undefined);
    if (field) found.push(field);
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(file, text, ts.ScriptTarget.Latest));
  return found;
}

const required = (
  operations: Map<string, string>,
  texts: [file: string, text: string][],
) => [
  ...permissionsFor(operations, PERMISSIONS, 'the published role'),
  ...texts.flatMap(([file, text]) =>
    requestFields(file, text).flatMap((field) => FIELD_PERMISSIONS[field]!),
  ),
];
const probe = (text: string) =>
  required(scanSdkSnippet(GOOGLE, text).operations, [['probe.ts', text]]);

// The hosted API's backups run as the management VM's own service account,
// granted only the checkpoint bucket, never under the published role (RFC
// 0049 C26 (e), owner question 10).
const VM_IDENTITY_FILES = new Set([
  'src/api/services/gateways/instance-backup-storage.ts',
]);
const apiFiles = sourceFiles('src/api').filter(
  (file) => !VM_IDENTITY_FILES.has(file),
);
const granted = anycloudRole.includedPermissions;

describe('Anycloud GCP role', () => {
  it('0047/S8 0047/S11 grants exactly the GCP permissions the API uses', () => {
    const needed = required(
      scanSdkOperations(GOOGLE, apiFiles).operations,
      apiFiles.map((file) => [file, readFileSync(file, 'utf8')]),
    );
    expect([...granted].sort()).toEqual([...new Set(needed)].sort());
    expect(granted).toHaveLength(new Set(granted).size);
  }, 120_000);

  const COMPUTE = `import type { InstancesClient } from '@google-cloud/compute';`;
  it.each([
    [
      'an optional chain on a possibly undefined client',
      `${COMPUTE} export const f = (c: InstancesClient | undefined) => c?.start({});`,
    ],
    [
      'a destructured method',
      `${COMPUTE} export const f = (c: InstancesClient) => { const { start } = c; return start({}); };`,
    ],
  ])(
    'counts a call through %s',
    (_shape, source) => {
      expect(probe(source)).toEqual(['compute.instances.start']);
    },
    60_000,
  );

  it('keys a method Bucket and File inherit by the class it is called on', () => {
    expect(
      probe(
        `import type { Storage } from '@google-cloud/storage';
export const f = (s: Storage) => Promise.all([s.bucket('b').getMetadata(), s.bucket('b').file('o').getMetadata()]);`,
      ).sort(),
    ).toEqual(['storage.buckets.get', 'storage.objects.get']);
  }, 60_000);

  it('counts every client a union receiver can be', () => {
    expect(
      probe(
        `import type { GlobalOperationsClient, ZoneOperationsClient } from '@google-cloud/compute';
export const f = (c: GlobalOperationsClient | ZoneOperationsClient) => c.wait({});`,
      ).sort(),
    ).toEqual(['compute.globalOperations.get', 'compute.zoneOperations.get']);
  }, 60_000);

  it.each([
    ['a property', `export const r = { serviceAccounts: [] };`],
    [
      'a shorthand property',
      `const serviceAccounts: unknown[] = []; export const r = { serviceAccounts };`,
    ],
    ['a computed key', `export const r = { ['serviceAccounts']: [] };`],
    [
      'an element assignment',
      `export const f = (r: Record<string, unknown>) => { r['serviceAccounts'] = []; };`,
    ],
    [
      'an assignment',
      `export const f = (r: { serviceAccounts?: unknown[] }) => { r.serviceAccounts = []; };`,
    ],
  ])(
    '0047/S8 needs actAs for serviceAccounts set as %s',
    (_shape, source) => {
      expect(probe(source)).toEqual(FIELD_PERMISSIONS.serviceAccounts);
    },
    60_000,
  );

  it.each([
    [
      'an unmapped operation',
      `${COMPUTE} export const f = (c: InstancesClient) => c.stop({});`,
      /no permission mapping/,
    ],
    [
      '.call',
      `${COMPUTE} export const f = (c: InstancesClient) => c.start.call(c, {});`,
      /start\.call has no permission mapping/,
    ],
    [
      'a bound method passed to a helper',
      `${COMPUTE} const run = (op: (r: object) => unknown) => op({}); export const f = (c: InstancesClient) => run(c.start.bind(c));`,
      /widens a typed Google Cloud SDK value|start\.bind has no permission mapping/,
    ],
    [
      'as any',
      `${COMPUTE} export const f = (c: InstancesClient) => (c as any).stop({});`,
      /casts a typed Google Cloud SDK value/,
    ],
    [
      'a cast to a local interface',
      `${COMPUTE} interface Stoppable { stop(r: object): unknown } export const f = (c: InstancesClient) => (c as unknown as Stoppable).stop({});`,
      /casts a typed Google Cloud SDK value/,
    ],
    [
      'an unresolved import',
      `import type { Missing } from '@google-cloud/missing'; export type T = Missing;`,
      /cannot resolve @google-cloud\/missing/,
    ],
    [
      'a raw URL',
      `export const f = () => fetch('https://compute.googleapis.com/compute/v1/projects/p/zones/z/instances');`,
      /names the Google Cloud endpoint/,
    ],
  ])(
    'fails closed on %s',
    (_shape, source, reason) => {
      expect(() => probe(source)).toThrow(reason);
    },
    60_000,
  );
});

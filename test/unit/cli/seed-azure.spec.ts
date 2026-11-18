import { readFileSync, writeFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import template from '../../../src/cli/seed/azure-template.json' with { type: 'json' };
import {
  azureStorageAccountName,
  createAzureSeed,
} from '../../../src/cli/seed/azure.js';
import {
  CloudCliError,
  type CloudCli,
  type SeedParams,
} from '../../../src/cli/seed/types.js';
import { CloudType } from '../../../src/shared/cloud.js';
import { CLOUDFLARE_IPV4_RANGES } from '../../../src/shared/cloudflare-ips.js';

const SUBSCRIPTION = '1234abcd-0000-0000-0000-000000000000';
const ID = 'c0ffee';
const GROUP = `anycloud-${ID}`;
const VM = `anycloud-cluster-${ID}`;
const ACCOUNT = azureStorageAccountName(SUBSCRIPTION);
const BUCKET = `anycloud-checkpoint-${ID}`;

type Reply = string | object | CloudCliError | ((args: string[]) => string);

const notFound = (what = 'ResourceNotFound') =>
  new CloudCliError('az', [], 3, `(${what}) The resource was not found.`);

/** A fake `az`: the first route whose prefix starts the argv answers. */
function fakeAz(routes: Array<[string, Reply]>) {
  const calls: string[][] = [];
  const cli: CloudCli = {
    async run({ args }) {
      calls.push([...args]);
      const line = args.join(' ');
      const route = routes.find(([prefix]) => line.startsWith(prefix));
      if (!route) throw new Error(`unexpected az ${line}`);
      const reply = route[1];
      if (reply instanceof CloudCliError) throw reply;
      if (typeof reply === 'function') return reply([...args]);
      return typeof reply === 'string' ? reply : JSON.stringify(reply);
    },
  };
  const ran = (prefix: string) =>
    calls.filter((args) => args.join(' ').startsWith(prefix));
  return { cli, calls, ran };
}

const accountShow: [string, Reply] = [
  'account show',
  { id: SUBSCRIPTION, user: { name: 'ops@example.com' } },
];

const deployment = {
  properties: {
    provisioningState: 'Succeeded',
    outputs: {
      publicIp: { type: 'String', value: '20.1.2.3' },
      instanceId: { type: 'String', value: VM },
      bucket: { type: 'String', value: BUCKET },
      identity: { type: 'String', value: 'client-id-1' },
    },
  },
};

const checkpointDeployment = (create: boolean) => ({
  name: `${VM}-checkpoint`,
  properties: {
    parameters: {
      account: { value: ACCOUNT },
      container: { value: BUCKET },
      create: { value: create },
      managed: { value: create },
    },
    outputs: { roleAssignmentId: { value: '/grant/1' } },
  },
});

const params: SeedParams = {
  clusterId: ID,
  clusterName: 'prod',
  region: 'eastus2',
  zone: null,
  vmType: 'Standard_D2s_v5',
  bucket: { name: BUCKET, managed: true },
  releaseValues: {
    selfDelete: { cloud: 'azure', resourceGroup: GROUP },
    backup: {
      bucket: BUCKET,
      region: 'eastus2',
      cloudProvider: CloudType.Azure,
      credentials: {
        cloudProvider: CloudType.Azure,
        kind: 'instance',
        subscriptionId: SUBSCRIPTION,
        directoryId: 'tenant-1',
      },
    },
  },
  startupScript: '#!/bin/bash\necho boot\n',
  tags: { anycloud_cluster: ID, anycloud_cluster_name: 'prod' },
};

/** The parameters file `deployment group create` was given. */
function deployRoute(capture: (parameters: any) => void): [string, Reply] {
  return [
    'deployment group create',
    (args) => {
      const file = args[args.indexOf('--parameters') + 1]!.slice(1);
      capture(JSON.parse(readFileSync(file, 'utf8')).parameters);
      return JSON.stringify(deployment);
    },
  ];
}

const resources = template.resources as any[];
const byType = (type: string) => resources.filter((r) => r.type === type);
const nested = byType('Microsoft.Resources/deployments')[0];
const inner = nested.properties.template;
const innerResources = inner.resources as any[];

/** Every string in `node`, skipping a nested deployment's own template. */
function strings(node: unknown, skip?: unknown): string[] {
  if (node === skip) return [];
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap((n) => strings(n, skip));
  if (node && typeof node === 'object') {
    return Object.entries(node).flatMap(([k, v]) => [k, ...strings(v, skip)]);
  }
  return [];
}

describe('Azure seed template', () => {
  it.each([
    ['outer', template, inner],
    ['nested', inner, undefined],
  ])('%s scope references only what it defines', (_, scope: any, skip) => {
    const all = strings(scope, skip).join('\n');
    for (const [, ref] of all.matchAll(/parameters\('(\w+)'\)/g)) {
      expect(scope.parameters, ref).toHaveProperty(ref!);
    }
    for (const [, ref] of all.matchAll(/variables\('(\w+)'\)/g)) {
      expect(scope.variables, ref).toHaveProperty(ref!);
    }
    // Each dependsOn names a resource type this scope deploys.
    const types = new Set(scope.resources.map((r: any) => r.type));
    for (const resource of scope.resources) {
      for (const dep of resource.dependsOn ?? []) {
        const variable = /^\[variables\('(\w+)'\)\]$/.exec(dep)?.[1];
        const expression = variable ? scope.variables[variable] : dep;
        const type = /'(Microsoft\.[\w./]+)'/.exec(expression)?.[1];
        expect(types, `${resource.type} → ${dep}`).toContain(type);
      }
    }
  });

  it('opens 6443 to everyone and 80/443 to Cloudflare only, never 22', () => {
    const rules = byType('Microsoft.Network/networkSecurityGroups')[0]
      .properties.securityRules;
    const ports = rules.map((r: any) => r.properties.destinationPortRange);
    expect(ports.sort()).toEqual(['443', '6443', '80']);
    for (const rule of rules) {
      if (rule.properties.destinationPortRange === '6443') continue;
      expect(rule.properties.sourceAddressPrefixes).toBe(
        "[parameters('cloudflareRanges')]",
      );
    }
  });

  it('boots Ubuntu 24.04 on IPv4 only, so the VM reaches the DNS Worker over IPv4', () => {
    const vm = byType('Microsoft.Compute/virtualMachines')[0];
    expect(vm.properties.storageProfile.imageReference.offer).toBe(
      'ubuntu-24_04-lts',
    );
    const ipv4 = /^\d+\.\d+\.\d+\.\d+\/\d+$/;
    const vnet = byType('Microsoft.Network/virtualNetworks')[0].properties;
    for (const prefix of [
      ...vnet.addressSpace.addressPrefixes,
      ...vnet.subnets.map((subnet: any) => subnet.properties.addressPrefix),
    ]) {
      expect(prefix).toMatch(ipv4);
    }
    const pip = byType('Microsoft.Network/publicIPAddresses')[0].properties;
    expect(pip.publicIPAddressVersion ?? 'IPv4').toBe('IPv4');
    const nic = byType('Microsoft.Network/networkInterfaces')[0].properties;
    expect(nic.ipConfigurations).toHaveLength(1);
    expect(
      nic.ipConfigurations[0].properties.privateIPAddressVersion ?? 'IPv4',
    ).toBe('IPv4');
  });

  it('gives the VM the managed identity, Contributor on its own group only', () => {
    const vm = byType('Microsoft.Compute/virtualMachines')[0];
    // One user-assigned identity and no system-assigned one, so the API's
    // token request needs no client ID.
    expect(vm.identity.type).toBe('UserAssigned');
    expect(Object.keys(vm.identity.userAssignedIdentities)).toEqual([
      "[variables('identityId')]",
    ]);
    // IMDS omits a Standard public IP from the VM's network data; the boot
    // script reads it from userData (IMDS compute/userData), which, unlike
    // tags, may hold a reference().
    expect(vm.properties.userData).toBe(
      "[base64(reference(resourceId('Microsoft.Network/publicIPAddresses', variables('name')), '2023-09-01').ipAddress)]",
    );
    expect(vm.properties.osProfile.customData).toBe(
      "[parameters('customData')]",
    );
    const [contributor] = byType('Microsoft.Authorization/roleAssignments');
    // No `scope`: the assignment sits on the deployment's resource group.
    expect(contributor.scope).toBeUndefined();
    expect(template.variables.contributorRole).toBe(
      'b24988ac-6180-42a0-ab88-20f7382dd24c',
    );
  });

  it('grants blob data rights on the checkpoint container alone, in the storage group', () => {
    expect(nested.resourceGroup).toBe("[parameters('storageResourceGroup')]");
    const role = innerResources.find(
      (r) => r.type === 'Microsoft.Authorization/roleAssignments',
    );
    expect(role.scope).toMatch(/\/blobServices\/default\/containers\//);
    // Storage Blob Data Contributor: no deleteBlobVersion data action.
    expect(inner.variables.blobDataContributorRole).toBe(
      'ba92f5b4-2d11-453d-a403-e96b0029c9fe',
    );
    // The storage account is never in the installation group.
    expect(byType('Microsoft.Storage/storageAccounts')).toEqual([]);
  });

  it('tags every taggable resource and outputs what the seed pins', () => {
    for (const resource of resources) {
      if (/roleAssignments|deployments/.test(resource.type)) continue;
      expect(resource.tags, resource.type).toBe("[parameters('tags')]");
    }
    expect(Object.keys(template.outputs).sort()).toEqual([
      'bucket',
      'identity',
      'instanceId',
      'publicIp',
    ]);
  });
});

describe('Azure seed driver', () => {
  it('creates the storage account outside the group, then deploys the template', async () => {
    let sent: any;
    const az = fakeAz([
      accountShow,
      [`group create -n ${GROUP}`, ''],
      ['storage account show', notFound()],
      ['group exists -n anycloud-storage', 'false'],
      ['group create -n anycloud-storage', ''],
      ['storage account create', ''],
      ['storage account blob-service-properties update', ''],
      ['vm list', []],
      deployRoute((p) => (sent = p)),
    ]);
    const result = await createAzureSeed(az.cli).deploy(params);

    expect(result).toEqual({
      publicIp: '20.1.2.3',
      instanceId: VM,
      bucket: BUCKET,
      identity: 'client-id-1',
    });
    expect(Object.keys(sent).sort()).toEqual(
      Object.keys(template.parameters).sort(),
    );
    expect(az.ran(`group create -n ${GROUP}`)[0]).toEqual(
      expect.arrayContaining(['--tags', `anycloud_cluster=${ID}`]),
    );
    expect(az.ran('storage account create')[0]).toEqual(
      expect.arrayContaining(['-g', 'anycloud-storage', '-n', ACCOUNT]),
    );
    expect(az.ran('storage account blob-service-properties update')[0]).toEqual(
      expect.arrayContaining(['--enable-versioning', 'true']),
    );
    expect(Buffer.from(sent.customData.value, 'base64').toString()).toMatch(
      /^#!/,
    );
    expect(sent.deployVm.value).toBe(true);
    expect(sent.createCheckpointContainer.value).toBe(true);
    expect(sent.checkpointManaged.value).toBe(true);
    expect(sent.cloudflareRanges.value).toEqual([...CLOUDFLARE_IPV4_RANGES]);
    expect(sent.adminPublicKey.value).toMatch(/^ssh-rsa AAAAB3NzaC1yc2E/);
  });

  it('resumes without touching an existing VM or storage account', async () => {
    let sent: any;
    const az = fakeAz([
      accountShow,
      [`group create -n ${GROUP}`, ''],
      ['storage account show', ''],
      ['storage account blob-service-properties update', ''],
      ['vm list', [{ name: VM, provisioningState: 'Succeeded' }]],
      deployRoute((p) => (sent = p)),
    ]);
    await createAzureSeed(az.cli).deploy({
      ...params,
      bucket: { name: 'mine', managed: false },
    });
    expect(sent.deployVm.value).toBe(false);
    expect(sent.createCheckpointContainer.value).toBe(false);
    expect(sent.checkpointManaged.value).toBe(false);
    expect(az.ran('storage account create')).toEqual([]);
  });

  it('restores into an existing managed bucket: no create, still managed', async () => {
    let sent: any;
    const az = fakeAz([
      accountShow,
      [`group create -n ${GROUP}`, ''],
      ['storage account show', ''],
      ['storage account blob-service-properties update', ''],
      ['vm list', []],
      deployRoute((p) => (sent = p)),
    ]);
    await createAzureSeed(az.cli).deploy({
      ...params,
      bucket: { name: BUCKET, managed: true, exists: true },
    });
    expect(sent.createCheckpointContainer.value).toBe(false);
    expect(sent.checkpointManaged.value).toBe(true);

    // Its deployment records create=false, managed=true; --delete-buckets deletes it.
    const cleanup = fakeAz([
      [
        'deployment group show -g anycloud-storage',
        {
          name: `${VM}-checkpoint`,
          properties: {
            parameters: {
              account: { value: ACCOUNT },
              container: { value: BUCKET },
              create: { value: false },
              managed: { value: true },
            },
          },
        },
      ],
      ['storage container delete', ''],
      ['deployment group delete', ''],
    ]);
    const result = await createAzureSeed(cleanup.cli).afterSelfDelete(
      ID,
      'eastus2',
      { deleteBuckets: true },
    );
    expect(result.deleted).toEqual([{ kind: 'bucket', id: BUCKET }]);
  });

  it('refuses an oversized script or a failed VM before deploying', async () => {
    const empty = fakeAz([]);
    await expect(
      createAzureSeed(empty.cli).deploy({
        ...params,
        startupScript: '#!'.padEnd(70_000, 'x'),
      }),
    ).rejects.toThrow(/customData/);
    expect(empty.calls).toEqual([]);

    const failed = fakeAz([
      accountShow,
      ['group create', ''],
      ['storage account', ''],
      ['vm list', [{ name: VM, provisioningState: 'Failed' }]],
    ]);
    await expect(createAzureSeed(failed.cli).deploy(params)).rejects.toThrow(
      /failed to provision/,
    );
    expect(failed.ran('deployment group create')).toEqual([]);
  });

  it('reports status from the group and the deployment', async () => {
    const status = (routes: Array<[string, Reply]>) =>
      createAzureSeed(fakeAz(routes).cli).status(ID, 'eastus2');
    const group = (state: string): [string, Reply] => [
      'group show',
      { properties: { provisioningState: state } },
    ];
    expect(await status([['group show', notFound()]])).toEqual({
      kind: 'absent',
    });
    expect((await status([group('Deleting')])).kind).toBe('in-progress');
    expect(
      await status([
        group('Succeeded'),
        [
          'deployment group show',
          {
            properties: {
              provisioningState: 'Failed',
              error: { message: 'quota' },
            },
          },
        ],
      ]),
    ).toEqual({ kind: 'failed', detail: 'quota' });
    expect(
      await status([
        group('Succeeded'),
        ['deployment group show', deployment],
        ['vm get-instance-view', ['PowerState/deallocated']],
      ]),
    ).toMatchObject({ kind: 'deployed', stopped: true });
  });

  it('finds an installation by name, refusing two', async () => {
    let args: string[] = [];
    const find = (groups: object[]) =>
      createAzureSeed(
        fakeAz([
          [
            'group list',
            (argv) => {
              args = argv;
              return JSON.stringify(groups);
            },
          ],
        ]).cli,
      ).findByName('prod', 'eastus2');
    expect(await find([])).toBeNull();
    expect(args).toEqual(
      expect.arrayContaining(['--tag', 'anycloud_cluster_name=prod']),
    );
    expect(await find([{ tags: { anycloud_cluster: ID } }])).toBe(ID);
    await expect(
      find([
        { tags: { anycloud_cluster: 'a' } },
        { tags: { anycloud_cluster: 'b' } },
      ]),
    ).rejects.toThrow(/2 installations/);
  });

  it('deletes pool resources VM first, then the group, and reports what it left', async () => {
    const pool = (name: string, type: string, group = 'anycloud-eastus2') => ({
      id: `/subscriptions/s/resourceGroups/${group}/providers/${type}/${name}`,
      type,
      resourceGroup: group,
    });
    const az = fakeAz([
      ['deployment group show -g anycloud-storage', checkpointDeployment(true)],
      [
        'resource list',
        [
          pool('nic1', 'Microsoft.Network/networkInterfaces'),
          pool('nic2', 'Microsoft.Network/networkInterfaces'),
          pool('disk1', 'Microsoft.Compute/disks'),
          pool('vm1', 'Microsoft.Compute/virtualMachines'),
          pool(VM, 'Microsoft.Compute/virtualMachines', GROUP.toUpperCase()),
        ],
      ],
      // The disk went with its VM.
      [
        'resource delete -o none --ids /subscriptions/s/resourceGroups/anycloud-eastus2/providers/Microsoft.Compute/disks',
        notFound(),
      ],
      [
        'resource delete -o none --ids /subscriptions/s/resourceGroups/anycloud-eastus2/providers/Microsoft.Network/networkInterfaces/nic2',
        new CloudCliError('az', [], 1, '(Conflict) NIC in use'),
      ],
      ['resource delete', ''],
      ['group show', { properties: { provisioningState: 'Succeeded' } }],
      ['group delete', ''],
      ['group wait', ''],
      [
        'role assignment delete',
        new CloudCliError('az', [], 1, '(AuthorizationFailed) denied'),
      ],
    ]);
    const result = await createAzureSeed(az.cli).deleteFallback(ID, 'eastus2', {
      deleteBuckets: false,
    });
    const deletes = az.ran('resource delete').map((args) => args.at(-1));
    expect(deletes).toEqual([
      expect.stringMatching(/virtualMachines\/vm1$/),
      expect.stringMatching(/disks\/disk1$/),
      expect.stringMatching(/networkInterfaces\/nic1$/),
      expect.stringMatching(/networkInterfaces\/nic2$/),
    ]);
    expect(az.ran('group delete')[0]).toEqual(
      expect.arrayContaining(['-n', GROUP, '--yes', '--no-wait']),
    );
    expect(az.ran('group wait')[0]).toContain('--deleted');
    expect(az.ran('role assignment delete')[0]).toContain('/grant/1');
    expect(az.ran('storage container delete')).toEqual([]);
    expect(result.deleted.map((r) => r.kind)).toEqual([
      'vm',
      'disk',
      'network',
      'group',
    ]);
    expect(result.remaining).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/nic2$/),
        selector: `anycloud_cluster=${ID}`,
      }),
      expect.objectContaining({ kind: 'identity', id: '/grant/1' }),
      expect.objectContaining({ kind: 'bucket', id: BUCKET }),
    ]);
  });

  it('deletes a managed bucket only with deleteBuckets, even after a failed create', async () => {
    const run = async (create: boolean) => {
      const az = fakeAz([
        [
          'deployment group show -g anycloud-storage',
          checkpointDeployment(create),
        ],
        ['resource list', []],
        // The installation group is already gone.
        ['group show', notFound('ResourceGroupNotFound')],
        ['role assignment delete', notFound()],
        ['storage container delete', ''],
        ['deployment group delete -g anycloud-storage', ''],
      ]);
      const result = await createAzureSeed(az.cli).deleteFallback(
        ID,
        'eastus2',
        { deleteBuckets: true },
      );
      return {
        result,
        deleted: az.ran('storage container delete'),
        retired: az.ran('deployment group delete'),
      };
    };
    const managed = await run(true);
    expect(managed.deleted[0]).toEqual(
      expect.arrayContaining(['--account-name', ACCOUNT, '--name', BUCKET]),
    );
    expect(managed.result.remaining).toEqual([]);
    expect(managed.retired[0]).toContain(`${VM}-checkpoint`);
    const supplied = await run(false);
    expect(supplied.deleted).toEqual([]);
    expect(supplied.retired).toEqual([]);
    expect(supplied.result.remaining.map((r) => r.kind)).toEqual(['bucket']);
  });

  it('after the self-delete, removes the grant and the bucket only when asked', async () => {
    const after = async (
      deleteBuckets: boolean,
      checkpoint: Reply = checkpointDeployment(true),
      container: Reply = '',
      record: Reply = '',
    ) => {
      const az = fakeAz([
        ['deployment group show -g anycloud-storage', checkpoint],
        ['role assignment delete', ''],
        ['storage container delete', container],
        ['deployment group delete', record],
      ]);
      const result = await createAzureSeed(az.cli).afterSelfDelete(
        ID,
        'eastus2',
        { deleteBuckets },
      );
      return { ...result, retired: az.ran('deployment group delete') };
    };
    const grant = { kind: 'identity', id: '/grant/1', selector: '/grant/1' };
    const kept = await after(false);
    expect(kept.deleted).toEqual([grant]);
    expect(kept.remaining.map((r) => r.kind)).toEqual(['bucket']);
    expect(kept.retired).toEqual([]);

    const emptied = await after(true);
    expect(emptied.deleted).toEqual([grant, { kind: 'bucket', id: BUCKET }]);
    expect(emptied.retired[0]).toContain(`${VM}-checkpoint`);

    // A supplied bucket stays; a container still being deleted is reported.
    const supplied = await after(true, checkpointDeployment(false));
    expect(supplied.remaining.map((r) => r.kind)).toEqual(['bucket']);
    const busy = await after(
      true,
      checkpointDeployment(true),
      new CloudCliError('az', [], 1, '(ContainerBeingDeleted) busy'),
    );
    expect(busy.remaining.map((r) => r.kind)).toEqual(['bucket']);
    expect(busy.retired).toEqual([]);
    // A record left behind is only bookkeeping: the bucket is gone.
    const stale = await after(
      true,
      checkpointDeployment(true),
      '',
      new CloudCliError('az', [], 1, '(Conflict) busy'),
    );
    expect(stale.deleted.map((r) => r.kind)).toEqual(['identity', 'bucket']);
    expect(stale.remaining).toEqual([]);
    expect(stale.retired).toHaveLength(1);
    // No checkpoint deployment: nothing to do.
    expect(await after(true, notFound('DeploymentNotFound'))).toMatchObject({
      deleted: [],
      remaining: [],
    });
  });

  it('backs up through the VM identity, with no client ID', () => {
    const values = createAzureSeed(fakeAz([]).cli).backupValues(params, {
      account: SUBSCRIPTION,
      principal: 'ops',
      directory: 'tenant-1',
    });
    expect(values).toEqual({
      bucket: BUCKET,
      region: 'eastus2',
      cloudProvider: 'Azure',
      credentials: {
        cloudProvider: 'Azure',
        kind: 'instance',
        subscriptionId: SUBSCRIPTION,
        directoryId: 'tenant-1',
      },
    });
  });

  it('reads an object, or null when it is absent', async () => {
    const read = (reply: Reply) =>
      createAzureSeed(
        fakeAz([accountShow, ['storage blob download', reply]]).cli,
      ).readObject('bucket', 'backup.json', 'eastus2');
    expect(
      await read((args) => {
        writeFileSync(args[args.indexOf('--file') + 1]!, '{"v":1}');
        return '';
      }),
    ).toBe('{"v":1}');
    expect(await read(notFound('BlobNotFound'))).toBeNull();
  });
});

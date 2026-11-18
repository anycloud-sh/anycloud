import { describe, expect, it, vi } from 'vitest';
import { completeCloudConfig } from '../../../src/shared/cloud-config.js';
import { CloudType, type CloudCredentials } from '../../../src/shared/cloud.js';
import { createClusterInfrastructure } from '../../../src/api/services/cluster-installer-runtime.js';
import { AWS } from '../../../src/api/services/gateways/aws.js';
import { GCP } from '../../../src/api/services/gateways/gcp.js';
import { Azure } from '../../../src/api/services/gateways/azure.js';
import { CLOUDFLARE_IP_RANGES } from '../../../src/shared/cloudflare-ips.js';
import { fakeSdkClient } from '../helpers/sdk-client';

/**
 * `ensureManagementIngress` over a management scope created before origin TLS
 * (22, 6443, 80): each cloud's real gateway must add 443 from Cloudflare and
 * leave the existing rules working.
 */
const scope = { id: 'anycloud-cluster-c1', tags: { anycloud_user: 'owner' } };

function reconcile(
  compute: ReturnType<AWS['compute']>,
  cloudProvider: CloudType,
) {
  // The gateway is already built, so the decrypted material is never read.
  const decrypted: CloudCredentials = {
    cloudProvider: CloudType.AWS,
    accessKeyId: 'a',
    secretAccessKey: 's',
  };
  return createClusterInfrastructure('0.1.68', {
    createCompute: () => compute,
    decryptCredential: async () => decrypted,
  }).ensureManagementIngress({
    credential: {
      id: 'cred-1',
      encryptedData: 'x',
      cloudProvider,
      authFailedAt: null,
    },
    target: { region: 'r', zone: null, vmType: 'v' },
    scope,
  });
}

describe('reconciling an existing management scope to admit 443', () => {
  it('AWS authorizes 443 on the existing security group, tolerating the rules it has', async () => {
    const aws = new AWS(
      completeCloudConfig({
        cloudProvider: CloudType.AWS,
        region: 'us-east-1',
        vmType: 't3.medium',
        credentials: { accessKeyId: 'a', secretAccessKey: 's' },
      }),
    );
    const authorized: number[] = [];
    const ec2Client = {
      send: vi.fn(
        async (command: { constructor: { name: string }; input: any }) => {
          switch (command.constructor.name) {
            case 'DescribeVpcsCommand':
              return { Vpcs: [{ VpcId: 'vpc-1', IsDefault: true }] };
            case 'DescribeSecurityGroupsCommand':
              return {
                SecurityGroups: [{ GroupId: 'sg-1', GroupName: scope.id }],
              };
            case 'AuthorizeSecurityGroupIngressCommand': {
              const port = command.input.IpPermissions[0].FromPort as number;
              if (port !== 443) throw { Code: 'InvalidPermission.Duplicate' };
              authorized.push(port);
              return {};
            }
            default:
              throw new Error(`unexpected ${command.constructor.name}`);
          }
        },
      ),
    };
    aws.ec2client = ec2Client as unknown as typeof aws.ec2client;

    await reconcile(aws.compute(), CloudType.AWS);

    expect(new Set(authorized)).toEqual(new Set([443]));
    expect(authorized).toHaveLength(CLOUDFLARE_IP_RANGES.length);
  });

  it('GCP creates the missing 443 rules beside the existing per-port ones', async () => {
    const gcp = new GCP(
      completeCloudConfig({
        cloudProvider: CloudType.GCP,
        region: 'us-central1',
        availabilityZone: 'a',
        vmType: 'e2-standard-2',
        credentials: {
          projectId: 'p',
          privateKey: 'k',
          clientEmail: 'e@p.iam.gserviceaccount.com',
        },
      }),
    );
    const created: string[] = [];
    gcp.firewallsClient = fakeSdkClient({
      insert: vi.fn(async ({ firewallResource }: any) => {
        if (!firewallResource.name.startsWith(`${scope.id}443`)) {
          throw { code: 409 };
        }
        created.push(firewallResource.name);
        return [{}];
      }),
    });
    vi.spyOn(gcp as any, 'waitForOperation').mockResolvedValue(undefined);

    await reconcile(gcp.compute(), CloudType.GCP);

    expect(created.length).toBeGreaterThan(0);
  });

  type Rule = { name: string; priority: number; direction: string };
  const inbound = (name: string, priority: number): Rule => ({
    name,
    priority,
    direction: 'Inbound',
  });

  async function azureReconcile(securityRules: Rule[]) {
    const azure = new Azure(
      completeCloudConfig({
        cloudProvider: CloudType.Azure,
        region: 'westus2',
        vmType: 'Standard_D2s_v5',
        credentials: {
          subscriptionId: '12345678-1234-1234-1234-123456789012',
          directoryId: 'd',
          applicationId: 'a',
          secret: 's',
        },
      }),
    );
    const nsgCreate = vi.fn().mockResolvedValue({
      pollUntilDone: vi.fn().mockResolvedValue({ id: '/test/nsg' }),
    });
    azure.networkClient = fakeSdkClient({
      networkSecurityGroups: {
        get: vi.fn().mockResolvedValue({
          id: '/test/nsg',
          tags: { anycloud_resource: scope.id },
          securityRules,
        }),
        beginCreateOrUpdate: nsgCreate,
      },
      virtualNetworks: {
        get: vi.fn().mockResolvedValue({ id: '/test/vnet' }),
        beginCreateOrUpdate: vi.fn().mockResolvedValue({
          pollUntilDone: vi.fn().mockResolvedValue({ id: '/test/vnet' }),
        }),
      },
      subnets: { get: vi.fn().mockResolvedValue({ id: '/test/subnet' }) },
    });
    vi.spyOn(azure as any, 'upsertResourceGroup').mockResolvedValue(undefined);
    await reconcile(azure.compute(), CloudType.Azure);
    return (nsgCreate.mock.calls[0][2].securityRules as Rule[]).map(
      ({ name, priority, direction }) => ({ name, priority, direction }),
    );
  }

  it.each([
    ['positional', [101, 102, 103, 104], [105, 106]],
    // An NSG whose rules were renumbered or hand-edited: the lowest free.
    ['sparse', [101, 102, 120, 110], [103, 104]],
  ])(
    'Azure adds 443 at the lowest inbound priorities the old NSG leaves free (%s)',
    async (_label, held, added) => {
      const old = [
        inbound('Allow22InBound', held[0]),
        inbound('Allow6443InBound', held[1]),
        inbound('Allow80InBound', held[2]),
        inbound('Allow80InBoundIpv6', held[3]),
      ];
      const rules = await azureReconcile(old);
      const priorities = rules.map((rule) => rule.priority);
      expect(new Set(priorities).size).toBe(priorities.length);
      expect(rules).toEqual([
        ...old,
        inbound('Allow443InBound', added[0]),
        inbound('Allow443InBoundIpv6', added[1]),
      ]);
    },
  );

  it('Azure ignores outbound priorities when picking an inbound one', async () => {
    const rules = await azureReconcile([
      inbound('Allow22InBound', 101),
      inbound('Allow6443InBound', 102),
      { name: 'DenyOut', priority: 103, direction: 'Outbound' },
      inbound('Allow80InBound', 104),
      inbound('Allow80InBoundIpv6', 105),
    ]);
    expect(rules.slice(-2).map((rule) => rule.priority)).toEqual([103, 106]);
  });

  it('Azure uses priority 4096, the last one, when it is the only one free', async () => {
    const taken = Array.from({ length: 4095 - 100 }, (_, i) =>
      inbound(`Custom${i}`, 101 + i),
    );
    const rules = await azureReconcile([
      ...taken,
      inbound('Allow22InBound', 4097),
      inbound('Allow6443InBound', 4098),
      inbound('Allow80InBound', 4099),
      inbound('Allow80InBoundIpv6', 4100),
      inbound('Allow443InBoundIpv6', 4101),
    ]);
    expect(rules.at(-1)).toEqual(inbound('Allow443InBound', 4096));
  });

  it('Azure refuses with a clear error when no inbound priority is free', async () => {
    const full = Array.from({ length: 4096 - 100 }, (_, i) =>
      inbound(`Custom${i}`, 101 + i),
    );
    await expect(
      azureReconcile([
        ...full,
        inbound('Allow22InBound', 4097),
        inbound('Allow6443InBound', 4098),
      ]),
    ).rejects.toThrow(
      `NSG ${scope.id} has no free inbound priority between 101 and 4096`,
    );
  });
});

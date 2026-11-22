import { describe, expect, it, vi } from 'vitest';
import { completeCloudConfig } from '../../../../src/shared/cloud-config.js';
import { CloudType } from '../../../../src/shared/cloud.js';
import { AWS } from '../../../../src/api/services/gateways/aws.js';
import { buildJobIngressSpec } from '../../../../src/api/services/network.js';
import { log } from '../../../../src/api/services/logger.js';
import { internalsOf } from '../../helpers/internals.js';
import {
  makeNewVMProps,
  requirePrepareNetwork,
} from '../../helpers/fixtures.js';

vi.mock('../../../../src/api/services/logger', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

type Tag = { Key: string; Value: string };
type Filter = { Name: string; Values: string[] };

/**
 * EC2 as these calls see it: VPCs with a main route table each, internet
 * gateways, subnets, security groups and launches. Every call yields first,
 * so concurrent gateways interleave the way separate requests do.
 */
class FakeEc2 {
  vpcs: { VpcId: string; CidrBlock: string; Tags: Tag[] }[] = [];
  gateways: {
    InternetGatewayId: string;
    Tags: Tag[];
    Attachments: { VpcId: string }[];
  }[] = [];
  tables: {
    RouteTableId: string;
    vpcId: string;
    Routes: { DestinationCidrBlock: string; GatewayId: string }[];
  }[] = [];
  subnets: {
    SubnetId: string;
    VpcId: string;
    AvailabilityZone: string;
    CidrBlock: string;
  }[] = [];
  groups: { GroupId: string; GroupName: string; VpcId: string }[] = [];
  launches: Record<string, any>[] = [];
  calls: string[] = [];
  zones = [
    { ZoneName: 'us-east-1b', ZoneType: 'availability-zone' },
    { ZoneName: 'us-east-1a', ZoneType: 'availability-zone' },
    { ZoneName: 'us-east-1-bos-1a', ZoneType: 'local-zone' },
  ];
  /** Zones whose RunInstances fails with this code. */
  refusals: Record<string, string> = {};
  failures: Record<string, Error> = {};
  /** Fails the next call to that command only. */
  once: Record<string, Error> = {};
  /** Zones where CreateSubnet is refused. */
  subnetRefusals = new Set<string>();
  /** DescribeSubnets doesn't show subnets made from now on. */
  subnetsLag = false;
  #next = 0;

  #id(prefix: string) {
    return `${prefix}-${++this.#next}`;
  }

  send = async (command: { constructor: { name: string }; input: any }) => {
    await Promise.resolve();
    const name = command.constructor.name.replace(/Command$/, '');
    const input = command.input;
    this.calls.push(name);
    if (this.failures[name]) throw this.failures[name];
    const once = this.once[name];
    if (once) {
      delete this.once[name];
      throw once;
    }
    const value = (filters: Filter[] | undefined, key: string) =>
      filters?.find((filter) => filter.Name === key)?.Values;
    switch (name) {
      case 'DescribeVpcs':
        return {
          Vpcs: this.vpcs.filter((vpc) =>
            (input.Filters as Filter[]).every(
              (filter) =>
                filter.Name.startsWith('tag:') &&
                vpc.Tags.some(
                  (tag) =>
                    tag.Key === filter.Name.slice(4) &&
                    filter.Values.includes(tag.Value),
                ),
            ),
          ),
        };
      case 'CreateVpc': {
        const vpc = {
          VpcId: this.#id('vpc'),
          CidrBlock: input.CidrBlock,
          Tags: input.TagSpecifications[0].Tags,
        };
        this.vpcs.push(vpc);
        this.tables.push({
          RouteTableId: this.#id('rtb'),
          vpcId: vpc.VpcId,
          Routes: [],
        });
        return { Vpc: vpc };
      }
      case 'CreateTags':
        for (const vpc of this.vpcs)
          if (input.Resources.includes(vpc.VpcId)) vpc.Tags.push(...input.Tags);
        return {};
      case 'DescribeInternetGateways':
        return {
          InternetGateways: this.gateways.filter((igw) =>
            (input.Filters as Filter[]).every((filter) =>
              igw.Tags.some(
                (tag) =>
                  tag.Key === filter.Name.slice(4) &&
                  filter.Values.includes(tag.Value),
              ),
            ),
          ),
        };
      case 'CreateInternetGateway': {
        const igw = {
          InternetGatewayId: this.#id('igw'),
          Tags: input.TagSpecifications[0].Tags,
          Attachments: [],
        };
        this.gateways.push(igw);
        return { InternetGateway: igw };
      }
      case 'AttachInternetGateway':
        this.gateways
          .find((igw) => igw.InternetGatewayId === input.InternetGatewayId)!
          .Attachments.push({ VpcId: input.VpcId });
        return {};
      case 'DescribeRouteTables': {
        const vpcId = value(input.Filters, 'vpc-id')![0];
        expect(value(input.Filters, 'association.main')).toEqual(['true']);
        return {
          RouteTables: this.tables.filter((table) => table.vpcId === vpcId),
        };
      }
      case 'CreateRoute':
        this.tables
          .find((table) => table.RouteTableId === input.RouteTableId)!
          .Routes.push({
            DestinationCidrBlock: input.DestinationCidrBlock,
            GatewayId: input.GatewayId,
          });
        return {};
      case 'DescribeAvailabilityZones':
        return {
          AvailabilityZones: this.zones.filter((zone) =>
            value(input.Filters, 'zone-type')!.includes(zone.ZoneType),
          ),
        };
      case 'DescribeSubnets': {
        const vpcId = value(input.Filters, 'vpc-id')![0];
        return {
          Subnets: this.subnets.filter((subnet) => subnet.VpcId === vpcId),
        };
      }
      case 'CreateSubnet': {
        if (this.subnetRefusals.has(input.AvailabilityZone))
          throw Object.assign(
            new Error(
              'Subnets can currently only be created in the following availability zones: us-east-1a.',
            ),
            { name: 'InvalidParameterValue' },
          );
        if (
          this.subnets.some(
            (subnet) =>
              subnet.VpcId === input.VpcId &&
              subnet.CidrBlock === input.CidrBlock,
          )
        )
          throw Object.assign(new Error('conflict'), {
            name: 'InvalidSubnet.Conflict',
          });
        const subnet = { SubnetId: this.#id('subnet'), ...input };
        if (!this.subnetsLag) this.subnets.push(subnet);
        return { Subnet: subnet };
      }
      case 'DescribeSecurityGroups':
        return {
          SecurityGroups: this.groups.filter(
            (group) =>
              group.GroupName === value(input.Filters, 'group-name')![0] &&
              group.VpcId === value(input.Filters, 'vpc-id')![0],
          ),
        };
      case 'CreateSecurityGroup': {
        if (
          this.groups.some(
            (group) =>
              group.GroupName === input.GroupName &&
              group.VpcId === input.VpcId,
          )
        )
          throw Object.assign(new Error('duplicate'), {
            name: 'InvalidGroup.Duplicate',
          });
        const group = {
          GroupId: this.#id('sg'),
          GroupName: input.GroupName,
          VpcId: input.VpcId,
        };
        this.groups.push(group);
        return { GroupId: group.GroupId };
      }
      case 'AuthorizeSecurityGroupIngress':
        return {};
      case 'RunInstances': {
        const subnet = this.subnets.find(
          (row) => row.SubnetId === input.NetworkInterfaces?.[0]?.SubnetId,
        );
        this.launches.push(input);
        const refusal = subnet && this.refusals[subnet.AvailabilityZone];
        if (refusal)
          throw Object.assign(new Error(`refused: ${refusal}`), {
            name: refusal,
          });
        return { Instances: [{ InstanceId: 'i-0123456789abcdef0' }] };
      }
      case 'DescribeInstances':
        return {
          Reservations: [
            {
              Instances: [
                {
                  InstanceId: 'i-0123456789abcdef0',
                  State: { Name: 'running' },
                  PublicIpAddress: '203.0.113.7',
                  PrivateIpAddress: '10.1.0.7',
                },
              ],
            },
          ],
        };
    }
    throw new Error(`FakeEc2 does not serve ${name}`);
  };
}

let accounts = 0;
/** A gateway on its own account, so the process-wide VPC lock starts empty. */
function gateway(ec2: FakeEc2, account = `AKIA-${++accounts}`) {
  const aws = new AWS(
    completeCloudConfig({
      cloudProvider: CloudType.AWS,
      region: 'us-east-1',
      vmType: 'm7i.large',
      credentials: { accessKeyId: account, secretAccessKey: 'secret' },
    }),
  );
  aws.ec2client = ec2 as any;
  vi.spyOn(
    internalsOf<{ resolveAmi: AWS['resolveAmi'] }>(aws),
    'resolveAmi',
  ).mockResolvedValue({
    imageId: 'ami-123',
    rootDeviceName: '/dev/sda1',
    rootVolumeSizeGb: 8,
  });
  return aws;
}

const jobSpec = () => buildJobIngressSpec([], true);
const prepare = (aws: AWS) =>
  requirePrepareNetwork(aws.compute())(jobSpec(), 'job-1', '0.0.0', 'user-1');

describe('AWS Jobs network (RFC 0053)', () => {
  it('0053/S1 launches a VM Job into a new VPC with a public subnet per zone', async () => {
    const ec2 = new FakeEc2();
    const aws = gateway(ec2);

    const network = await prepare(aws);

    expect(ec2.vpcs).toEqual([
      {
        VpcId: expect.any(String),
        CidrBlock: '10.1.0.0/16',
        Tags: [
          { Key: 'Name', Value: 'anycloud-jobs' },
          { Key: 'anycloud_managed', Value: 'shared' },
          { Key: 'anycloud_jobs_network', Value: 'ready' },
        ],
      },
    ]);
    const vpcId = ec2.vpcs[0].VpcId;
    expect(ec2.gateways).toEqual([
      {
        InternetGatewayId: expect.any(String),
        Tags: [
          { Key: 'Name', Value: 'anycloud-jobs' },
          { Key: 'anycloud_managed', Value: 'shared' },
        ],
        Attachments: [{ VpcId: vpcId }],
      },
    ]);
    expect(ec2.tables[0].Routes).toEqual([
      {
        DestinationCidrBlock: '0.0.0.0/0',
        GatewayId: ec2.gateways[0].InternetGatewayId,
      },
    ]);
    // Standard zones only: the Local Zone gets no subnet.
    expect(
      ec2.subnets.map(({ AvailabilityZone, CidrBlock }) => [
        AvailabilityZone,
        CidrBlock,
      ]),
    ).toEqual([
      ['us-east-1a', '10.1.0.0/20'],
      ['us-east-1b', '10.1.16.0/20'],
    ]);
    // The VM SG is recreated inside the Jobs VPC.
    expect(ec2.groups).toEqual([
      {
        GroupId: network!.securityGroupId,
        GroupName: 'anycloud-vm',
        VpcId: vpcId,
      },
    ]);
    expect(network!.subnets).toEqual([
      { id: ec2.subnets[0].SubnetId, zone: 'us-east-1a' },
      { id: ec2.subnets[1].SubnetId, zone: 'us-east-1b' },
    ]);

    const vm = await aws
      .compute()
      .newVM(makeNewVMProps({ vmId: 'job-1-0', network, jobHost: true }));

    expect(vm.ip).toBe('203.0.113.7');
    expect(ec2.launches).toHaveLength(1);
    expect(ec2.launches[0]).toMatchObject({
      ClientToken: 'job-1-0.us-east-1a',
      NetworkInterfaces: [
        {
          DeviceIndex: 0,
          SubnetId: ec2.subnets[0].SubnetId,
          Groups: [network!.securityGroupId],
          AssociatePublicIpAddress: true,
          DeleteOnTermination: true,
        },
      ],
    });
    // The interface carries the group; EC2 refuses both together.
    expect(ec2.launches[0]).not.toHaveProperty('SecurityGroupIds');
  });

  it('0053/S4 makes one VPC for eight concurrent Jobs across gateways', async () => {
    const ec2 = new FakeEc2();
    const account = `AKIA-${++accounts}`;
    const networks = await Promise.all(
      Array.from({ length: 8 }, () => prepare(gateway(ec2, account))),
    );

    expect(ec2.vpcs).toHaveLength(1);
    expect(ec2.gateways).toHaveLength(1);
    expect(ec2.subnets).toHaveLength(2);
    expect(
      new Set(networks.map((network) => network!.securityGroupId)).size,
    ).toBe(1);
  });

  it('resumes an unready VPC instead of making another', async () => {
    const ec2 = new FakeEc2();
    ec2.vpcs.push({
      VpcId: 'vpc-crashed',
      CidrBlock: '10.1.0.0/16',
      Tags: [
        { Key: 'Name', Value: 'anycloud-jobs' },
        { Key: 'anycloud_managed', Value: 'shared' },
      ],
    });
    ec2.tables.push({
      RouteTableId: 'rtb-main',
      vpcId: 'vpc-crashed',
      Routes: [],
    });
    ec2.subnets.push({
      SubnetId: 'subnet-a',
      VpcId: 'vpc-crashed',
      AvailabilityZone: 'us-east-1a',
      CidrBlock: '10.1.0.0/20',
    });

    const network = await prepare(gateway(ec2));

    expect(ec2.calls).not.toContain('CreateVpc');
    expect(ec2.vpcs[0].Tags).toContainEqual({
      Key: 'anycloud_jobs_network',
      Value: 'ready',
    });
    expect(ec2.tables[0].Routes).toHaveLength(1);
    // The new zone's subnet takes the next free range.
    expect(network!.subnets).toEqual([
      { id: 'subnet-a', zone: 'us-east-1a' },
      { id: expect.any(String), zone: 'us-east-1b' },
    ]);
    expect(ec2.subnets[1].CidrBlock).toBe('10.1.16.0/20');
  });

  it('uses the ready VPC over a duplicate, and reports the duplicate', async () => {
    const ec2 = new FakeEc2();
    const tags = (ready: boolean) => [
      { Key: 'Name', Value: 'anycloud-jobs' },
      { Key: 'anycloud_managed', Value: 'shared' },
      ...(ready ? [{ Key: 'anycloud_jobs_network', Value: 'ready' }] : []),
    ];
    ec2.vpcs.push(
      { VpcId: 'vpc-a-unready', CidrBlock: '10.1.0.0/16', Tags: tags(false) },
      { VpcId: 'vpc-b-ready', CidrBlock: '10.1.0.0/16', Tags: tags(true) },
    );

    await prepare(gateway(ec2));

    expect(ec2.calls).not.toContain('CreateVpc');
    expect(ec2.calls).not.toContain('CreateInternetGateway');
    expect(ec2.groups[0].VpcId).toBe('vpc-b-ready');
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('2 anycloud Jobs VPCs; using vpc-b-ready'),
      expect.anything(),
    );
  });

  it('0053/S5 tries the next subnet when a zone refuses the type', async () => {
    const ec2 = new FakeEc2();
    const aws = gateway(ec2);
    const network = await prepare(aws);
    ec2.refusals['us-east-1a'] = 'Unsupported';

    await aws
      .compute()
      .newVM(makeNewVMProps({ vmId: 'job-1-0', network, jobHost: true }));

    expect(
      ec2.launches.map((launch) => [
        launch.ClientToken,
        launch.NetworkInterfaces[0].SubnetId,
      ]),
    ).toEqual([
      ['job-1-0.us-east-1a', network!.subnets![0].id],
      ['job-1-0.us-east-1b', network!.subnets![1].id],
    ]);

    // When every zone refuses, the last refusal fails the launch.
    ec2.launches = [];
    ec2.refusals['us-east-1b'] = 'InsufficientInstanceCapacity';
    await expect(
      aws
        .compute()
        .newVM(makeNewVMProps({ vmId: 'job-1-1', network, jobHost: true })),
    ).rejects.toThrow('InsufficientInstanceCapacity');
    expect(ec2.launches).toHaveLength(2);
  });

  it('0053/I3 fails the Job when the VPC cannot be made, never using the default VPC', async () => {
    const ec2 = new FakeEc2();
    ec2.failures.CreateVpc = Object.assign(
      new Error('The maximum number of VPCs has been reached.'),
      { name: 'VpcLimitExceeded' },
    );

    await expect(prepare(gateway(ec2))).rejects.toThrow(
      /maximum number of VPCs.*raise the "VPCs per Region" quota/,
    );
    expect(ec2.groups).toEqual([]);
    expect(ec2.launches).toEqual([]);
  });

  it('launches in the other zones when AWS refuses a subnet in one', async () => {
    const ec2 = new FakeEc2();
    ec2.subnetRefusals.add('us-east-1b');

    const network = await prepare(gateway(ec2));

    expect(network!.subnets).toEqual([
      { id: expect.any(String), zone: 'us-east-1a' },
    ]);
    expect(log.warn).toHaveBeenCalledWith(
      'AWS refused a Jobs subnet in us-east-1b',
      expect.anything(),
    );

    // With no zone at all, the refusal fails the Job.
    const none = new FakeEc2();
    none.subnetRefusals.add('us-east-1a').add('us-east-1b');
    await expect(prepare(gateway(none))).rejects.toThrow(
      'Subnets can currently only be created',
    );
  });

  it('waits out a new VPC that EC2 does not show yet', async () => {
    const ec2 = new FakeEc2();
    ec2.once.AttachInternetGateway = Object.assign(new Error('not yet'), {
      name: 'InvalidVpcID.NotFound',
    });

    const network = await prepare(gateway(ec2));

    expect(network!.subnets).toHaveLength(2);
    expect(ec2.gateways).toHaveLength(1);
    expect(ec2.tables[0].Routes).toHaveLength(1);
  });

  it('attaches a gateway left unattached by a crash instead of making another', async () => {
    const ec2 = new FakeEc2();
    ec2.gateways.push({
      InternetGatewayId: 'igw-orphan',
      Tags: [
        { Key: 'Name', Value: 'anycloud-jobs' },
        { Key: 'anycloud_managed', Value: 'shared' },
      ],
      Attachments: [],
    });

    await prepare(gateway(ec2));

    expect(ec2.calls).not.toContain('CreateInternetGateway');
    expect(ec2.gateways[0].Attachments).toEqual([{ VpcId: ec2.vpcs[0].VpcId }]);
    expect(ec2.tables[0].Routes).toEqual([
      { DestinationCidrBlock: '0.0.0.0/0', GatewayId: 'igw-orphan' },
    ]);
  });

  it('launches in the subnets it just made while DescribeSubnets lags', async () => {
    const ec2 = new FakeEc2();
    ec2.subnetsLag = true;

    const network = await prepare(gateway(ec2));

    expect(network!.subnets!.map((subnet) => subnet.zone)).toEqual([
      'us-east-1a',
      'us-east-1b',
    ]);
  });

  it('looks again when another API process attached the gateway first', async () => {
    const ec2 = new FakeEc2();
    ec2.once.AttachInternetGateway = Object.assign(new Error('associated'), {
      name: 'Resource.AlreadyAssociated',
    });

    await prepare(gateway(ec2));

    expect(ec2.gateways).toHaveLength(1);
    expect(ec2.gateways[0].Attachments).toHaveLength(1);
    expect(ec2.tables[0].Routes).toHaveLength(1);
  });
});

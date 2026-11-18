import { describe, expect, it } from 'vitest';

import stackTemplate from '../../../../src/cli/seed/aws-stack.json' with { type: 'json' };
import {
  MAX_TEMPLATE_BYTES,
  renderStackTemplate,
} from '../../../../src/cli/seed/aws.js';
import {
  CLOUDFLARE_IPV4_RANGES,
  CLOUDFLARE_IPV6_RANGES,
} from '../../../../src/shared/cloudflare-ips.js';

type Json = Record<string, any>;

/** Expands `Fn::ForEach` the way `AWS::LanguageExtensions` does, for the collections the CLI passes. */
function expand(resources: Json, lists: Record<string, string[]>): Json {
  const out: Json = {};
  for (const [key, value] of Object.entries(resources)) {
    if (!key.startsWith('Fn::ForEach::')) {
      out[key] = value;
      continue;
    }
    const [name, collection, fragment] = value as [string, any, Json];
    const items: string[] = Array.isArray(collection)
      ? collection
      : lists[collection.Ref];
    for (const item of items) {
      const bound = JSON.parse(
        JSON.stringify(fragment)
          .replaceAll(`\${${name}}`, item)
          .replaceAll(`&{${name}}`, item.replace(/[^A-Za-z0-9]/g, ''))
          .replaceAll(`{"Ref":"${name}"}`, JSON.stringify(item)),
      );
      Object.assign(out, expand(bound, lists));
    }
  }
  return out;
}

const resources = expand(stackTemplate.Resources, {
  CloudflareIpv4: [...CLOUDFLARE_IPV4_RANGES],
  CloudflareIpv6: [...CLOUDFLARE_IPV6_RANGES],
});
const ofType = (type: string) =>
  Object.entries(resources).filter(([, r]) => r.Type === type);
const statements = (role: string): Json[] =>
  resources[role].Properties.Policies.flatMap(
    (p: Json) => p.PolicyDocument.Statement,
  );
const actions = (role: string): string[] =>
  statements(role).flatMap((s) => [s.Action].flat());

describe('AWS stack template', () => {
  it('opens only 6443 publicly and 80/443 to Cloudflare, never SSH', () => {
    const group = resources.SecurityGroup.Properties.SecurityGroupIngress;
    expect(group.map((r: Json) => r.FromPort)).toEqual([6443, 6443]);
    const cloudflare = ofType('AWS::EC2::SecurityGroupIngress').map(
      ([, r]) => r.Properties,
    );
    expect(new Set(cloudflare.map((r) => r.FromPort))).toEqual(
      new Set(['80', '443']),
    );
    for (const port of ['80', '443']) {
      const rules = cloudflare.filter((r) => r.FromPort === port);
      expect(rules.map((r) => r.CidrIp).filter(Boolean)).toEqual([
        ...CLOUDFLARE_IPV4_RANGES,
      ]);
      expect(rules.map((r) => r.CidrIpv6).filter(Boolean)).toEqual([
        ...CLOUDFLARE_IPV6_RANGES,
      ]);
    }
    const ports = [...group, ...cloudflare].map((r) => Number(r.FromPort));
    expect(ports).not.toContain(22);
    // Loop names are unique in the template and clash with no resource or parameter.
    const loops = JSON.stringify(stackTemplate).match(/Fn::ForEach::\w+/g)!;
    expect(new Set(loops).size).toBe(loops.length);
    for (const loop of loops) {
      const name = loop.slice('Fn::ForEach::'.length);
      expect(Object.keys(resources)).not.toContain(name);
      expect(Object.keys(stackTemplate.Parameters)).not.toContain(name);
    }
    // Every generated logical ID is a distinct, valid one.
    for (const id of Object.keys(resources)) {
      expect(id).toMatch(/^[A-Za-z0-9]+$/);
    }
  });

  it('requires IMDSv2 with two hops and keeps the bucket and delete role', () => {
    // S5's boot needs Ubuntu 24.04 (python3, OpenSSL 3), and reaches the DNS
    // Worker over IPv4 only: the Worker matches the caller against the A record.
    expect(stackTemplate.Parameters.ImageId.Default).toContain(
      '/ubuntu/server/24.04/',
    );
    expect(resources.Instance.Properties.Ipv6AddressCount).toBe(0);
    expect(resources.Instance.Properties.MetadataOptions).toMatchObject({
      HttpTokens: 'required',
      HttpPutResponseHopLimit: 2,
    });
    // Kept by the stack's delete; a rolled-back create removes them, so a re-run can recreate them.
    for (const name of ['Bucket', 'StackDeleteRole']) {
      expect(resources[name]).toMatchObject({
        DeletionPolicy: 'RetainExceptOnCreate',
        UpdateReplacePolicy: 'Retain',
      });
    }
    expect(resources.Bucket.Condition).toBe('CreateBucket');
    expect(resources.Bucket.Properties.VersioningConfiguration.Status).toBe(
      'Enabled',
    );
    expect(Object.keys(stackTemplate.Outputs).sort()).toEqual([
      'Bucket',
      'InstanceId',
      'PublicIp',
      'RoleArn',
    ]);
  });

  it("boots the management VM on gp3's baseline 3,000 IOPS and 125 MiB/s", () => {
    // A t3 can't sustain more, and provisioned IOPS and MiB/s bill monthly.
    expect(resources.Instance.Properties.BlockDeviceMappings).toEqual([
      {
        DeviceName: '/dev/sda1',
        Ebs: { VolumeType: 'gp3', VolumeSize: 16, DeleteOnTermination: true },
      },
    ]);
  });

  it('grants no wildcard actions, and "*" resources only to Describe', () => {
    for (const role of ['VmRole', 'StackDeleteRole']) {
      for (const statement of statements(role)) {
        for (const action of [statement.Action].flat()) {
          expect(action).toMatch(/^[a-z0-9]+:[A-Za-z]+$/);
        }
        if (statement.Resource === '*') {
          // Describe calls take no resource-level permissions.
          expect(statement.Sid).toBe('Describe');
          expect(
            [statement.Action]
              .flat()
              .every((a: string) => a.startsWith('ec2:Describe')),
          ).toBe(true);
        }
      }
    }
  });

  it('limits the VM role to sweeping what its cluster or API tagged, its bucket and its stack', () => {
    const vm = statements('VmRole');
    expect(actions('VmRole')).not.toContain('s3:DeleteObjectVersion');
    expect(actions('VmRole')).not.toContain('s3:DeleteBucket');
    // Pools and VM Jobs launch on the user's connections, never on this role:
    // it only sweeps, keeps its bucket, and deletes its stack.
    const sweep = [
      'ec2:CancelSpotInstanceRequests',
      'ec2:DeleteNetworkInterface',
      'ec2:DeleteSecurityGroup',
      'ec2:DeleteVolume',
      'ec2:TerminateInstances',
    ];
    expect([...new Set(actions('VmRole'))].sort()).toEqual(
      [
        'account:ListRegions',
        'cloudformation:DeleteStack',
        'cloudformation:DescribeStacks',
        'ec2:DescribeInstances',
        'ec2:DescribeNetworkInterfaces',
        'ec2:DescribeSecurityGroups',
        'ec2:DescribeSpotInstanceRequests',
        'ec2:DescribeVolumes',
        'iam:PassRole',
        's3:AbortMultipartUpload',
        's3:DeleteObject',
        's3:GetBucketLocation',
        's3:GetBucketVersioning',
        's3:GetObject',
        's3:ListBucket',
        's3:ListBucketMultipartUploads',
        's3:ListMultipartUploadParts',
        's3:PutObject',
        ...sweep,
      ].sort(),
    );
    const sweeps = vm.filter(
      (s) =>
        s.Sid !== 'Describe' &&
        [s.Action].flat().some((a: string) => a.startsWith('ec2:')),
    );
    for (const statement of sweeps) {
      expect([...statement.Action].sort()).toEqual(sweep);
    }
    expect(sweeps.map((s) => s.Condition.StringEquals)).toEqual([
      { 'aws:ResourceTag/anycloud_cluster': { Ref: 'ClusterId' } },
      { 'aws:ResourceTag/anycloud_owner_api': { Ref: 'OwnerApiIdentity' } },
    ]);
    const passRole = vm.filter((s) => s.Action === 'iam:PassRole');
    expect(passRole).toEqual([
      expect.objectContaining({
        Resource: { 'Fn::GetAtt': ['StackDeleteRole', 'Arn'] },
      }),
    ]);
    for (const statement of vm.filter((s) =>
      [s.Action].flat().some((a: string) => a.startsWith('s3:')),
    )) {
      expect(statement.Resource['Fn::Sub']).toContain('${CheckpointBucket}');
    }
    expect(vm.find((s) => s.Sid === 'DeleteOwnStack')?.Resource).toEqual({
      Ref: 'AWS::StackId',
    });
  });

  it('renders user-data from the startup script within the template limit', () => {
    // S5's script is a ~5 KB bash wrapper around a gzip+base64 payload.
    const payload = Buffer.from(
      Array.from({ length: 4500 }, (_, i) => (i * 7919) % 256),
    )
      .toString('base64')
      .replace(/.{1,76}/g, '$&\n');
    const script = `#!/bin/bash\nset -euo pipefail\nbase64 -d <<'ANYCLOUD_BOOT' | gunzip > /run/anycloud-boot.sh\n${payload}ANYCLOUD_BOOT\nexec bash /run/anycloud-boot.sh\n`;
    const body = renderStackTemplate(script);
    expect(Buffer.byteLength(body)).toBeLessThan(MAX_TEMPLATE_BYTES);
    const userData = JSON.parse(body).Resources.Instance.Properties.UserData;
    expect(Buffer.from(userData, 'base64').toString()).toBe(script);
    expect(() => renderStackTemplate('#!'.repeat(30_000))).toThrow(
      /at most 51200/,
    );
  });
});

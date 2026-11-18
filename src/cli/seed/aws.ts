import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CloudType } from '../../shared/cloud.js';
import stackTemplate from './aws-stack.json' with { type: 'json' };
import {
  discoverAccount as discoverCliAccount,
  missingRights,
} from './accounts.js';
import {
  CLOUDFLARE_IPV4_RANGES,
  CLOUDFLARE_IPV6_RANGES,
} from '../../shared/cloudflare-ips.js';
import {
  CloudCliError,
  seedStackName,
  type CloudCli,
  type CloudSeed,
  type SeedAccount,
  type SeedDeleteResult,
  type SeedOutputs,
  type SeedParams,
  type SeedResource,
  type SeedSelfDelete,
  type SeedStatus,
} from './types.js';

/**
 * The AWS seed: one CloudFormation stack (`aws-stack.json`) deployed through
 * the user's `aws` CLI. Every command asks for `--output json` and reads only
 * the fields it names, so a CLI upgrade that adds fields changes nothing.
 */

/** `cloudformation deploy --template-file` takes no larger body without an S3 staging bucket. */
export const MAX_TEMPLATE_BYTES = 51_200;

const serviceRoleName = (clusterId: string) => `anycloud-${clusterId}-cfn`;
const SERVICE_ROLE_POLICY = 'anycloud-stack-delete';

interface StackDescription {
  StackStatus: string;
  StackStatusReason?: string;
  Outputs?: { OutputKey: string; OutputValue: string }[];
}

/** The stack the CLI deploys: the committed template plus the VM's user-data. */
export function renderStackTemplate(startupScript: string): string {
  const body = JSON.stringify({
    ...stackTemplate,
    Resources: {
      ...stackTemplate.Resources,
      Instance: {
        ...stackTemplate.Resources.Instance,
        Properties: {
          ...stackTemplate.Resources.Instance.Properties,
          // Encoded here rather than by Fn::Base64, so no intrinsic reads the script.
          UserData: Buffer.from(startupScript).toString('base64'),
        },
      },
    },
  });
  if (Buffer.byteLength(body) > MAX_TEMPLATE_BYTES) {
    throw new Error(
      `The AWS stack template is ${Buffer.byteLength(body)} bytes; CloudFormation takes at most ${MAX_TEMPLATE_BYTES}`,
    );
  }
  return body;
}

/** The stack and the role its delete runs under (lane S6); pure, from the ID and account. */
export function awsSelfDelete(
  clusterId: string,
  account: SeedAccount,
): Extract<SeedSelfDelete, { cloud: 'aws' }> {
  return {
    cloud: 'aws',
    stackName: seedStackName(clusterId),
    roleArn: `arn:${partitionOf(account.principal)}:iam::${account.account}:role/${serviceRoleName(clusterId)}`,
  };
}

function partitionOf(principal: string): string {
  return principal.split(':')[1] || 'aws';
}

function isMissing(error: unknown, pattern: RegExp): boolean {
  return error instanceof CloudCliError && pattern.test(error.stderr);
}

/** Runs `aws <words> <values…> --output json`; the fixed words split on spaces, values never do. */
function awsCli(cli: CloudCli) {
  const run = (words: string, ...values: string[]) =>
    cli.run({ args: [...words.split(' '), ...values, '--output', 'json'] });
  const json = async <T>(words: string, ...values: string[]) =>
    JSON.parse(await run(words, ...values)) as T;
  return { run, json };
}

const STACK_QUERY =
  'Stacks[0].{StackStatus:StackStatus,StackStatusReason:StackStatusReason,Outputs:Outputs[].{OutputKey:OutputKey,OutputValue:OutputValue}}';
const COMPLETE = [
  'CREATE_COMPLETE',
  'UPDATE_COMPLETE',
  'UPDATE_ROLLBACK_COMPLETE',
];

export function createAwsSeed(cli: CloudCli): CloudSeed {
  const { run, json } = awsCli(cli);
  const stackArgs = (clusterId: string, region: string) => [
    '--stack-name',
    seedStackName(clusterId),
    '--region',
    region,
  ];
  const tagFilter = (clusterId: string) =>
    `Name=tag:anycloud_cluster,Values=${clusterId}`;

  async function describeStack(clusterId: string, region: string) {
    try {
      return await json<StackDescription>(
        'cloudformation describe-stacks --query',
        STACK_QUERY,
        ...stackArgs(clusterId, region),
      );
    } catch (error) {
      if (isMissing(error, /does not exist/)) return null;
      throw error;
    }
  }

  function outputsOf(stack: StackDescription): SeedOutputs {
    const value = (key: string) => {
      const found = stack.Outputs?.find((o) => o.OutputKey === key);
      if (!found) throw new Error(`The AWS stack has no ${key} output`);
      return found.OutputValue;
    };
    return {
      publicIp: value('PublicIp'),
      instanceId: value('InstanceId'),
      bucket: value('Bucket'),
      identity: value('RoleArn'),
    };
  }

  /** The earliest resource failure in the stack's events (newest first), for the user's error. */
  async function firstFailure(
    clusterId: string,
    region: string,
    suffix = '_FAILED',
  ) {
    const events = await json<
      { status: string; reason?: string; id: string }[]
    >(
      'cloudformation describe-stack-events --query',
      'StackEvents[].{status:ResourceStatus,reason:ResourceStatusReason,id:LogicalResourceId}',
      ...stackArgs(clusterId, region),
    ).catch(() => []);
    const failed = events
      .filter((event) => event.status.endsWith(suffix) && event.reason)
      .at(-1);
    return failed ? `${failed.id}: ${failed.reason}` : null;
  }

  /**
   * Waits out an operation in progress. The create waiter also covers a
   * create's rollback, and fails (caught here) when the rollback completes.
   */
  async function settledStack(clusterId: string, region: string) {
    const stack = await describeStack(clusterId, region);
    const status = stack?.StackStatus ?? '';
    if (!status.endsWith('_IN_PROGRESS') || status === 'REVIEW_IN_PROGRESS') {
      return stack;
    }
    const waiter = status.startsWith('UPDATE_')
      ? 'stack-update-complete'
      : status.startsWith('DELETE_')
        ? 'stack-delete-complete'
        : 'stack-create-complete';
    await run(
      `cloudformation wait ${waiter}`,
      ...stackArgs(clusterId, region),
    ).catch((error: unknown) => {
      // A failed operation's state and events are read next.
      if (!(error instanceof CloudCliError)) throw error;
    });
    return describeStack(clusterId, region);
  }

  /** Deletes the stack and waits; a failure names the resource that failed. */
  async function deleteStack(
    clusterId: string,
    region: string,
    roleArn?: string,
  ) {
    try {
      await run(
        'cloudformation delete-stack',
        ...(roleArn ? ['--role-arn', roleArn] : []),
        ...stackArgs(clusterId, region),
      );
      await run(
        'cloudformation wait stack-delete-complete',
        ...stackArgs(clusterId, region),
      );
    } catch (error) {
      const failure = await firstFailure(clusterId, region, 'DELETE_FAILED');
      if (failure) throw new Error(`The AWS stack delete failed: ${failure}`);
      throw error;
    }
  }

  /**
   * What the stack's delete keeps: its delete role, and the managed bucket,
   * found by the cluster tag the stack gave it (a supplied bucket has none).
   */
  async function deleteRetained(
    clusterId: string,
    region: string,
    deleteBuckets: boolean,
  ): Promise<SeedDeleteResult> {
    const deleted: SeedResource[] = [];
    const remaining: SeedDeleteResult['remaining'][number][] = [];
    if (await deleteServiceRole(cli, clusterId)) {
      deleted.push({ kind: 'identity', id: serviceRoleName(clusterId) });
    }
    const buckets = await json<string[]>(
      'resourcegroupstaggingapi get-resources --resource-type-filters s3:bucket --query ResourceTagMappingList[].ResourceARN --tag-filters',
      `Key=anycloud_cluster,Values=${clusterId}`,
      '--region',
      region,
    );
    for (const arn of buckets) {
      const resource = {
        kind: 'bucket' as const,
        id: arn.slice(arn.lastIndexOf(':') + 1),
        location: region,
      };
      if (deleteBuckets) {
        await deleteVersionedBucket(cli, resource.id, region);
        deleted.push(resource);
      } else {
        remaining.push({
          ...resource,
          selector: `anycloud_cluster=${clusterId}`,
          reason: 'kept',
        });
      }
    }
    return { deleted, remaining };
  }

  const discoverAccount = () => discoverCliAccount('aws', cli);

  return {
    cloud: 'aws',
    discoverAccount,

    async checkRights(account: SeedAccount) {
      try {
        return await missingRights('aws', cli, account);
      } catch (error) {
        // A caller that may not simulate its own policy goes on unchecked.
        if (error instanceof CloudCliError) return null;
        throw error;
      }
    },

    // The API backs up as the VM's own role (IMDSv2), never a saved credential.
    backupValues: (params) => ({
      bucket: params.bucket.name,
      region: params.region,
      cloudProvider: CloudType.AWS,
      credentials: { cloudProvider: CloudType.AWS, kind: 'instance' },
    }),

    selfDeleteValues: (params, account) =>
      awsSelfDelete(params.clusterId, account),

    async findByName(clusterName: string, region: string) {
      // Filtered here, not in the query, so a name is never JMESPath.
      const stacks = await json<{ Key: string; Value: string }[][]>(
        "cloudformation describe-stacks --query Stacks[?starts_with(StackName,'anycloud-')].Tags",
        '--region',
        region,
      );
      const tag = (tags: { Key: string; Value: string }[], key: string) =>
        tags.find((t) => t.Key === key)?.Value;
      const ids = stacks
        .filter((tags) => tag(tags, 'anycloud_cluster_name') === clusterName)
        .map((tags) => tag(tags, 'anycloud_cluster'))
        .filter((id): id is string => id !== undefined);
      if (ids.length > 1) {
        throw new Error(
          `Clusters ${ids.join(', ')} in ${region} are both named ${clusterName}; name one by its ID`,
        );
      }
      return ids[0] ?? null;
    },

    async deploy(params: SeedParams, signal?: AbortSignal) {
      const body = renderStackTemplate(params.startupScript);
      // The VM role may sweep what its API tagged (VM Jobs) besides the cluster's own.
      const ownerApi = params.tags.anycloud_owner_api;
      if (!ownerApi) throw new Error('The seed tags lack anycloud_owner_api');
      // A complete stack is adopted as is: an update could replace the VM
      // (a newer AMI behind the SSM parameter) or stop it (new user-data).
      const existing = await settledStack(params.clusterId, params.region);
      const status = existing?.StackStatus;
      if (status && COMPLETE.includes(status)) return outputsOf(existing!);
      if (status === 'ROLLBACK_COMPLETE') {
        // A rolled-back create can't be updated, only replaced; its
        // RetainExceptOnCreate resources went with the rollback.
        await deleteStack(params.clusterId, params.region);
      } else if (status && status !== 'REVIEW_IN_PROGRESS') {
        throw new Error(
          `The AWS stack ${seedStackName(params.clusterId)} is ${status}; delete the cluster, then create it again`,
        );
      }
      const dir = await mkdtemp(join(tmpdir(), 'anycloud-stack-'));
      const tags = {
        ...params.tags,
        anycloud_cluster: params.clusterId,
        anycloud_cluster_name: params.clusterName,
      };
      try {
        const templateFile = join(dir, 'stack.json');
        await writeFile(templateFile, body);
        await cli.run(
          {
            args: [
              ...'cloudformation deploy --capabilities CAPABILITY_NAMED_IAM CAPABILITY_AUTO_EXPAND'.split(
                ' ',
              ),
              ...stackArgs(params.clusterId, params.region),
              '--template-file',
              templateFile,
              '--parameter-overrides',
              `ClusterId=${params.clusterId}`,
              `InstanceType=${params.vmType}`,
              `AvailabilityZone=${params.zone ?? ''}`,
              `CloudflareIpv4=${CLOUDFLARE_IPV4_RANGES.join(',')}`,
              `CloudflareIpv6=${CLOUDFLARE_IPV6_RANGES.join(',')}`,
              `OwnerApiIdentity=${ownerApi}`,
              `CheckpointBucket=${params.bucket.name}`,
              // A restore's managed bucket survived the lost stack, with its
              // cluster tag, so delete still finds it.
              `CreateBucket=${params.bucket.managed && !params.bucket.exists}`,
              '--tags',
              ...Object.entries(tags).map(([key, value]) => `${key}=${value}`),
            ],
          },
          { signal },
        );
      } catch (error) {
        const failure = await firstFailure(params.clusterId, params.region);
        if (failure) throw new Error(`The AWS stack failed: ${failure}`);
        throw error;
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
      const stack = await describeStack(params.clusterId, params.region);
      if (!stack) throw new Error('The AWS stack is missing after deploy');
      return outputsOf(stack);
    },

    async status(clusterId: string, region: string): Promise<SeedStatus> {
      const stack = await describeStack(clusterId, region);
      if (!stack) return { kind: 'absent' };
      const status = stack.StackStatus;
      const detail = [status, stack.StackStatusReason]
        .filter(Boolean)
        .join(': ');
      if (status.endsWith('_IN_PROGRESS'))
        return { kind: 'in-progress', detail };
      if (!COMPLETE.includes(status)) return { kind: 'failed', detail };
      const outputs = outputsOf(stack);
      const state = await json<string | null>(
        'ec2 describe-instances --query Reservations[0].Instances[0].State.Name --instance-ids',
        outputs.instanceId,
        '--region',
        region,
      ).catch((error: unknown) => {
        if (isMissing(error, /InvalidInstanceID\.NotFound/)) return null;
        throw error;
      });
      if (
        state === null ||
        state === 'terminated' ||
        state === 'shutting-down'
      ) {
        return {
          kind: 'failed',
          detail: `management VM ${outputs.instanceId} is ${state ?? 'gone'}`,
        };
      }
      return {
        kind: 'deployed',
        outputs,
        stopped: state === 'stopped' || state === 'stopping',
      };
    },

    async readObject(bucket: string, key: string, region: string) {
      // The listing tells an absent object from a denied read.
      const found = await json<string | null>(
        's3api list-objects-v2 --max-items 1 --query Contents[0].Key --bucket',
        bucket,
        '--prefix',
        key,
        '--region',
        region,
      );
      if (found !== key) return null;
      return cli.run({
        args: ['s3', 'cp', `s3://${bucket}/${key}`, '-', '--region', region],
      });
    },

    async deleteFallback(
      clusterId,
      region,
      { deleteBuckets },
    ): Promise<SeedDeleteResult> {
      const deleted: SeedResource[] = [];
      // Pool VMs first: they are tagged with the cluster but outside the stack.
      const vms = await json<string[]>(
        'ec2 describe-instances --query Reservations[].Instances[].InstanceId --filters Name=instance-state-name,Values=pending,running,stopping,stopped',
        tagFilter(clusterId),
        '--region',
        region,
      );
      if (vms.length > 0) {
        await run(
          'ec2 terminate-instances --region',
          region,
          '--instance-ids',
          ...vms,
        );
        await run(
          'ec2 wait instance-terminated --region',
          region,
          '--instance-ids',
          ...vms,
        );
        deleted.push(
          ...vms.map((id) => ({ kind: 'vm' as const, id, location: region })),
        );
      }
      const stack = await settledStack(clusterId, region);
      if (stack) {
        // A failed create removed its delete role first, and an unexecuted
        // change set never made it;
        // the user's own rights delete it.
        const { roleArn } = awsSelfDelete(clusterId, await discoverAccount());
        await deleteStack(
          clusterId,
          region,
          /^(ROLLBACK_|CREATE_FAILED|REVIEW_IN_PROGRESS)/.test(
            stack.StackStatus,
          )
            ? undefined
            : roleArn,
        );
        deleted.push({
          kind: 'stack',
          id: seedStackName(clusterId),
          location: region,
        });
      }
      // Node pools' own groups, free once their VMs are gone.
      const groups = await json<string[]>(
        'ec2 describe-security-groups --query SecurityGroups[].GroupId --filters',
        tagFilter(clusterId),
        '--region',
        region,
      );
      for (const id of groups) {
        await run(
          'ec2 delete-security-group --region',
          region,
          '--group-id',
          id,
        );
        deleted.push({ kind: 'firewall', id, location: region });
      }
      const retained = await deleteRetained(clusterId, region, deleteBuckets);
      return {
        deleted: [...deleted, ...retained.deleted],
        remaining: retained.remaining,
      };
    },

    async afterSelfDelete(clusterId, region, { deleteBuckets }) {
      // The stack's delete runs under the role removed here.
      const stack = await settledStack(clusterId, region);
      if (stack) {
        throw new Error(
          `The AWS stack ${seedStackName(clusterId)} is still ${stack.StackStatus}; its delete role stays until it is gone`,
        );
      }
      return deleteRetained(clusterId, region, deleteBuckets);
    },
  };
}

/**
 * Removes the stack's delete role, which the stack's own delete keeps
 * (`DeletionPolicy: Retain`) because it runs under it. True when it existed.
 * The CLI calls this after the API has deleted its stack (lane S6).
 */
export async function deleteServiceRole(
  cli: CloudCli,
  clusterId: string,
): Promise<boolean> {
  const { run } = awsCli(cli);
  const role = serviceRoleName(clusterId);
  const ignoreMissing = (error: unknown) => {
    if (!isMissing(error, /NoSuchEntity/)) throw error;
    return null;
  };
  await run(
    'iam delete-role-policy --policy-name',
    SERVICE_ROLE_POLICY,
    '--role-name',
    role,
  ).catch(ignoreMissing);
  const removed = await run('iam delete-role --role-name', role).catch(
    ignoreMissing,
  );
  return removed !== null;
}

/**
 * Empties a versioned bucket, every version and delete marker, then deletes
 * it. Only the user's CLI can: the management VM's role holds no
 * `s3:DeleteObjectVersion`.
 */
async function deleteVersionedBucket(
  cli: CloudCli,
  bucket: string,
  region: string,
): Promise<void> {
  type Version = { Key: string; VersionId: string };
  const { run, json } = awsCli(cli);
  const dir = await mkdtemp(join(tmpdir(), 'anycloud-bucket-'));
  try {
    for (;;) {
      // Each page is deleted before the next listing, so no token is kept.
      const page = await json<{ v: Version[] | null; d: Version[] | null }>(
        's3api list-object-versions --max-keys 1000 --no-paginate --query {v:Versions[].{Key:Key,VersionId:VersionId},d:DeleteMarkers[].{Key:Key,VersionId:VersionId}} --bucket',
        bucket,
        '--region',
        region,
      );
      const objects = [...(page.v ?? []), ...(page.d ?? [])].slice(0, 1000);
      if (objects.length === 0) break;
      const file = join(dir, 'delete.json');
      await writeFile(file, JSON.stringify({ Objects: objects, Quiet: true }));
      const errors = await json<{ Key: string; Code: string }[] | null>(
        's3api delete-objects --query Errors[].{Key:Key,Code:Code} --delete',
        `file://${file}`,
        '--bucket',
        bucket,
        '--region',
        region,
      );
      // Quiet mode lists only the objects it couldn't delete, with exit 0.
      if (errors?.length) {
        throw new Error(
          `Couldn't empty bucket ${bucket}: ${errors
            .slice(0, 3)
            .map((e) => `${e.Key} (${e.Code})`)
            .join(', ')}`,
        );
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  await run('s3api delete-bucket --bucket', bucket, '--region', region);
}

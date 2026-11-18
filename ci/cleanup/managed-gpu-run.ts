#!/usr/bin/env node
/** Manual recovery of one completed qualification attempt, without its runner. */
import {
  EC2Client,
  DescribeInstancesCommand,
  DescribeVolumesCommand,
  DescribeNetworkInterfacesCommand,
  DescribeAddressesCommand,
  DeleteVolumeCommand,
  DeleteNetworkInterfaceCommand,
  ReleaseAddressCommand,
  type Tag,
} from '@aws-sdk/client-ec2';
import {
  GetBucketTaggingCommand,
  HeadBucketCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { Octokit } from '@octokit/rest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { hostedApiIdentity } from '../../src/shared/hosted-api-identity.js';
import { AWS } from '../../src/api/services/gateways/aws.js';
import { deleteDNSRecordBySubdomain } from '../../src/shared/dns-worker.js';
import { completeCloudConfig } from '../../src/shared/cloud-config.js';
import { CloudType } from '../../src/shared/cloud.js';
import { cleanupAzureManagedGpuOwner } from './azure-nuke-run.js';

const sha = (value: Buffer | string) =>
  createHash('sha256').update(value).digest('hex');
const region = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const positiveId = z
  .string()
  .regex(/^[1-9]\d*$/)
  .refine((value) => Number.isSafeInteger(Number(value)));
const authoritySchema = z.strictObject({
  schemaVersion: z.literal(1),
  repository: z.string().regex(/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/),
  workflowRunId: positiveId,
  workflowRunAttempt: z.number().int().positive().safe(),
  workflowSourceSha: z.string().regex(/^[a-f0-9]{40}$/),
  candidateSourceSha: z.string().regex(/^[a-f0-9]{40}$/),
  candidateManifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  fixtureRunId: z.string().regex(/^[a-f0-9]{10}$/),
  createdAt: z.iso.datetime(),
  host: z.strictObject({ provider: z.literal('aws'), region }),
  state: z.strictObject({ provider: z.literal('aws'), region }),
  capacity: z.strictObject({ provider: z.literal('azure'), region }),
  awsAccountId: z.string().regex(/^\d{12}$/),
  azureSubscriptionId: z
    .string()
    .regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i),
});
export type ManagedGpuCleanupAuthority = z.infer<typeof authoritySchema>;

export function validateManagedGpuCleanupAuthority(
  raw: unknown,
  candidateBytes: Buffer,
): ManagedGpuCleanupAuthority {
  const parsed = authoritySchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Recovery requires explicit AWS host/state and Azure capacity placement: ${parsed.error.message}`,
    );
  }
  const authority = parsed.data;
  const candidate = z
    .object({ sourceSha: z.string().regex(/^[a-f0-9]{40}$/) })
    .parse(JSON.parse(candidateBytes.toString('utf8')));
  if (
    authority.repository.split('/')[1] === '.' ||
    authority.repository.split('/')[1] === '..' ||
    authority.fixtureRunId !==
      sha(
        `managed-gpu:${authority.workflowRunId}:${authority.workflowRunAttempt}`,
      ).slice(0, 10) ||
    sha(candidateBytes) !== authority.candidateManifestSha256 ||
    candidate.sourceSha !== authority.candidateSourceSha
  )
    throw new Error(
      'Cleanup authority does not match its run scope or immutable candidate',
    );
  return authority;
}

export function managedGpuRunOwners(authority: ManagedGpuCleanupAuthority) {
  const host = `mk8s-host-${authority.fixtureRunId}`;
  const reservation = `mk8s-store-${authority.fixtureRunId}`;
  return {
    host,
    reservation,
    workloads: [host, reservation],
    hostedApiIdentity: hostedApiIdentity(host),
    bucket: `anycloud-mk8s-${authority.fixtureRunId}`,
    subdomains: [host, reservation],
  };
}

interface AuthoritySelection {
  repository: string;
  runId: string;
  attempt: number;
}

function paginationCount(
  previous: number | undefined,
  current: number,
): number {
  if (
    !Number.isSafeInteger(current) ||
    current < 0 ||
    (previous !== undefined && previous !== current)
  )
    throw new Error(
      'GitHub inventory count is missing or changed during recovery authorization',
    );
  return current;
}

/** GitHub, not resource tags or a local JSON file, establishes abandonment. */
export async function fetchManagedGpuCleanupAuthority(
  selection: AuthoritySelection,
  token: string,
  fetcher: typeof fetch = fetch,
  download: (artifactId: number) => Buffer = (artifactId) =>
    execFileSync(
      'gh',
      [
        'api',
        `repos/${selection.repository}/actions/artifacts/${artifactId}/zip`,
      ],
      {
        env: { ...process.env, GH_TOKEN: token },
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      },
    ),
) {
  positiveId.parse(selection.runId);
  z.number().int().positive().safe().parse(selection.attempt);
  if (
    !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(selection.repository) ||
    !token
  ) {
    throw new Error('A repository and authenticated GitHub token are required');
  }
  const github = new Octokit({
    auth: token,
    request: {
      fetch: fetcher,
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    },
  });
  const [owner, repo] = selection.repository.split('/');
  const params = {
    owner,
    repo,
    run_id: Number(selection.runId),
    attempt_number: selection.attempt,
  };
  const { data: run } = await github.rest.actions.getWorkflowRunAttempt(params);
  if (
    run.id !== params.run_id ||
    run.run_attempt !== params.attempt_number ||
    run.repository?.full_name !== selection.repository ||
    run.head_repository?.full_name !== selection.repository ||
    ![
      '.github/workflows/managed-kubernetes-qualification.yml',
      '.github/workflows/release.yml',
    ].includes(run.path?.split('@')[0] ?? '') ||
    !['workflow_dispatch', 'push'].includes(run.event) ||
    !/^[a-f0-9]{40}$/.test(run.head_sha) ||
    run.status !== 'completed' ||
    !run.conclusion
  )
    throw new Error(
      'Original qualification run/attempt is not a completed same-repository workflow',
    );
  let expectedJobs: number | undefined;
  const jobs = await github.paginate(
    github.rest.actions.listJobsForWorkflowRunAttempt,
    { ...params, per_page: 100 },
    (response) => {
      expectedJobs = paginationCount(expectedJobs, response.data.total_count);
      return response.data;
    },
  );
  const provisions = jobs.flatMap((job) =>
    (job.steps ?? [])
      .filter(
        (step) =>
          step.name ===
          'Run the RFC 0029 production topology and tracked teardown',
      )
      .map((step) => ({ job, step })),
  );
  if (
    jobs.length !== expectedJobs ||
    provisions.length !== 1 ||
    new Set(jobs.map((job) => job.id)).size !== jobs.length ||
    jobs.some(
      (job) => job.run_id !== run.id || job.head_sha !== run.head_sha,
    ) ||
    provisions[0].job.status !== 'completed' ||
    provisions[0].job.head_sha !== run.head_sha ||
    !Number.isFinite(Date.parse(provisions[0].step.started_at ?? ''))
  ) {
    throw new Error(
      'Original qualification provisioning job is not conclusively completed',
    );
  }
  let expectedArtifacts: number | undefined;
  const artifacts = await github.paginate(
    github.rest.actions.listWorkflowRunArtifacts,
    { owner, repo, run_id: params.run_id, per_page: 100 },
    (response) => {
      expectedArtifacts = paginationCount(
        expectedArtifacts,
        response.data.total_count,
      );
      return response.data;
    },
  );
  if (
    artifacts.length !== expectedArtifacts ||
    new Set(artifacts.map((entry) => entry.id)).size !== artifacts.length
  )
    throw new Error(
      'GitHub cleanup authority artifact inventory is incomplete',
    );
  const matches = artifacts.filter(
    (artifact) =>
      artifact.name ===
      `managed-gpu-cleanup-authority-${selection.runId}-${selection.attempt}`,
  );
  const artifact = matches[0];
  if (
    matches.length !== 1 ||
    artifact.expired ||
    artifact.workflow_run?.id !== run.id ||
    artifact.workflow_run.head_sha !== run.head_sha ||
    !/^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? '') ||
    !artifact.created_at ||
    !Number.isFinite(Date.parse(artifact.created_at)) ||
    Date.parse(artifact.created_at) > Date.parse(provisions[0].step.started_at!)
  ) {
    throw new Error(
      'Immutable cleanup authority was not retained before provisioning',
    );
  }
  const archive = download(artifact.id);
  if (`sha256:${sha(archive)}` !== artifact.digest)
    throw new Error('Cleanup authority archive digest mismatch');
  const root = await mkdtemp(join(tmpdir(), 'managed-gpu-authority-'));
  try {
    const file = join(root, 'authority.zip');
    await writeFile(file, archive);
    const entries = execFileSync('unzip', ['-Z1', file], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    })
      .trim()
      .split('\n')
      .sort();
    if (
      JSON.stringify(entries) !==
      JSON.stringify(['authority.json', 'candidate.json'])
    )
      throw new Error('Unexpected cleanup authority archive contents');
    const authorityBytes = execFileSync(
      'unzip',
      ['-p', file, 'authority.json'],
      { maxBuffer: 1024 * 1024 },
    );
    const candidateBytes = execFileSync(
      'unzip',
      ['-p', file, 'candidate.json'],
      { maxBuffer: 1024 * 1024 },
    );
    const authority = validateManagedGpuCleanupAuthority(
      JSON.parse(authorityBytes.toString('utf8')),
      candidateBytes,
    );
    if (
      authority.repository !== selection.repository ||
      authority.workflowRunId !== selection.runId ||
      authority.workflowRunAttempt !== selection.attempt ||
      authority.workflowSourceSha !== run.head_sha ||
      Date.parse(authority.createdAt) > Date.parse(artifact.created_at) + 1000
    ) {
      throw new Error(
        'Downloaded cleanup authority does not match the original run/attempt/source',
      );
    }
    return {
      authority,
      artifactId: artifact.id,
      archiveDigest: artifact.digest!,
      authoritySha256: sha(authorityBytes),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

type AwsOwnedResource = { id: string; removable: boolean };
export async function observeManagedGpuAws(
  ec2: Pick<EC2Client, 'send'>,
  authority: ManagedGpuCleanupAuthority,
) {
  const owners = managedGpuRunOwners(authority);
  const Filters = [
    { Name: 'tag:anycloud_deployment', Values: owners.workloads },
  ];
  const owned = (tags: Tag[] | undefined) => {
    const values = Object.fromEntries(
      (tags ?? []).map((tag) => [tag.Key, tag.Value]),
    );
    if (
      !owners.workloads.includes(values.anycloud_deployment ?? '') ||
      values.anycloud_resource ||
      !/^[a-f0-9]{32}$/.test(values.anycloud_owner_api ?? '') ||
      (values.anycloud_deployment === owners.reservation &&
        values.anycloud_owner_api !== owners.hostedApiIdentity)
    ) {
      throw new Error(
        'AWS inventory returned a resource outside the exact qualification owners',
      );
    }
  };
  const instances: string[] = [];
  const volumes: AwsOwnedResource[] = [];
  const interfaces: AwsOwnedResource[] = [];
  let NextToken: string | undefined;
  do {
    const page = await ec2.send(
      new DescribeInstancesCommand({ Filters, NextToken }),
    );
    for (const reservation of page.Reservations ?? [])
      for (const instance of reservation.Instances ?? []) {
        owned(instance.Tags);
        if (!instance.InstanceId || !instance.State?.Name)
          throw new Error('AWS instance observation omitted identity/state');
        if (instance.State.Name !== 'terminated')
          instances.push(instance.InstanceId);
      }
    NextToken = page.NextToken;
  } while (NextToken);
  do {
    const page = await ec2.send(
      new DescribeVolumesCommand({ Filters, NextToken }),
    );
    for (const volume of page.Volumes ?? []) {
      owned(volume.Tags);
      if (!volume.VolumeId)
        throw new Error('AWS volume observation omitted identity');
      volumes.push({
        id: volume.VolumeId,
        removable: volume.State === 'available' && !volume.Attachments?.length,
      });
    }
    NextToken = page.NextToken;
  } while (NextToken);
  do {
    const page = await ec2.send(
      new DescribeNetworkInterfacesCommand({ Filters, NextToken }),
    );
    for (const nic of page.NetworkInterfaces ?? []) {
      owned(nic.TagSet);
      if (!nic.NetworkInterfaceId)
        throw new Error('AWS interface observation omitted identity');
      interfaces.push({
        id: nic.NetworkInterfaceId,
        removable: nic.Status === 'available' && !nic.Attachment,
      });
    }
    NextToken = page.NextToken;
  } while (NextToken);
  const addresses =
    (await ec2.send(new DescribeAddressesCommand({ Filters }))).Addresses ?? [];
  for (const address of addresses) {
    owned(address.Tags);
    if (!address.AllocationId)
      throw new Error('AWS address observation omitted allocation identity');
  }
  return { instances, volumes, interfaces, addresses };
}

export interface ManagedGpuRecoveryOperations {
  stopHosts(): Promise<void>;
  cleanupAzure(): Promise<string[]>;
  cleanupAwsSupporting(): Promise<string[]>;
  cleanupDns(): Promise<void>;
  cleanupState(): Promise<void>;
}

/** State remains recoverable until the original controller and capacity are gone. */
export async function recoverManagedGpuRun(
  operations: ManagedGpuRecoveryOperations,
) {
  const completed: string[] = [];
  const residualResources: string[] = [];
  const errors: string[] = [];
  try {
    await operations.stopHosts();
    completed.push('aws-hosts');
    const azureResiduals = await operations.cleanupAzure();
    residualResources.push(...azureResiduals);
    if (!azureResiduals.length) completed.push('azure-capacity');
    const awsResiduals = await operations.cleanupAwsSupporting();
    residualResources.push(...awsResiduals);
    if (!awsResiduals.length) completed.push('aws-supporting-resources');
    if (residualResources.length)
      throw new Error(
        'Owned provider resources remain; retaining checkpoint state',
      );
    await operations.cleanupDns();
    completed.push('dns');
    await operations.cleanupState();
    completed.push('aws-state');
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return {
    confirmed: errors.length === 0,
    completed,
    residualResources,
    errors,
  };
}

async function untilEmpty(observe: () => Promise<string[]>): Promise<string[]> {
  const deadline = Date.now() + 120_000;
  let emptyObservations = 0;
  for (;;) {
    const residuals = await observe();
    emptyObservations = residuals.length ? 0 : emptyObservations + 1;
    if (emptyObservations >= 2) return [];
    if (Date.now() >= deadline) {
      if (!residuals.length)
        throw new Error('Repeated provider absence is not confirmed');
      return residuals;
    }
    await delay(Math.min(5000, deadline - Date.now()));
  }
}

function credentials(env: NodeJS.ProcessEnv) {
  if (
    !env.AWS_ACCESS_KEY_ID ||
    !env.AWS_SECRET_ACCESS_KEY ||
    !env.AZURE_SUBSCRIPTION_ID ||
    !env.AZURE_TENANT_ID ||
    !env.AZURE_CLIENT_ID ||
    !env.AZURE_CLIENT_SECRET
  ) {
    throw new Error(
      'Explicit AWS and Azure credentials are required for manual recovery',
    );
  }
  return {
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}),
  };
}

export async function cleanupManagedGpuCheckpoint(
  s3: Pick<S3Client, 'send'>,
  storage: { deleteBucket(bucketName: string): Promise<void> },
  authority: ManagedGpuCleanupAuthority,
): Promise<void> {
  const bucket = managedGpuRunOwners(authority).bucket;
  const request = {
    Bucket: bucket,
    ExpectedBucketOwner: authority.awsAccountId,
  };
  try {
    await s3.send(new HeadBucketCommand(request));
  } catch (error) {
    if (
      (error as { $metadata?: { httpStatusCode?: number } }).$metadata
        ?.httpStatusCode === 404
    )
      return;
    throw error;
  }
  const tagged = await s3.send(new GetBucketTaggingCommand(request));
  const tags = Object.fromEntries(
    (tagged.TagSet ?? []).map((tag) => [tag.Key, tag.Value]),
  );
  if (
    !/^[a-f0-9]{32}$/.test(tags.anycloud_owner_api ?? '') ||
    !Number.isFinite(Number(tags.anycloud_created_at)) ||
    Number(tags.anycloud_created_at) < Date.parse(authority.createdAt)
  ) {
    throw new Error(
      'Checkpoint bucket does not have ownership from this reserved run',
    );
  }
  await storage.deleteBucket(bucket);
  try {
    await s3.send(new HeadBucketCommand(request));
  } catch (error) {
    if (
      (error as { $metadata?: { httpStatusCode?: number } }).$metadata
        ?.httpStatusCode === 404
    )
      return;
    throw error;
  }
  throw new Error('Checkpoint bucket absence is not confirmed');
}

async function recoveryOperations(
  authority: ManagedGpuCleanupAuthority,
  env: NodeJS.ProcessEnv,
): Promise<ManagedGpuRecoveryOperations> {
  const awsCredentials = credentials(env);
  if (
    env.AZURE_SUBSCRIPTION_ID?.toLowerCase() !==
    authority.azureSubscriptionId.toLowerCase()
  )
    throw new Error(
      'Azure credentials do not match the authorized subscription',
    );
  const account = await new STSClient({
    credentials: awsCredentials,
    region: authority.host.region,
  }).send(new GetCallerIdentityCommand({}));
  if (account.Account !== authority.awsAccountId)
    throw new Error('AWS credentials do not match the authorized account');
  const ec2 = new EC2Client({
    credentials: awsCredentials,
    region: authority.host.region,
  });
  const compute = new AWS(
    completeCloudConfig({
      cloudProvider: CloudType.AWS,
      credentials: awsCredentials,
      region: authority.host.region,
    }),
  ).compute();
  const s3 = new S3Client({
    credentials: awsCredentials,
    region: authority.state.region,
  });
  const storage = new AWS(
    completeCloudConfig({
      cloudProvider: CloudType.AWS,
      credentials: awsCredentials,
      region: authority.state.region,
    }),
  ).storage();
  const owners = managedGpuRunOwners(authority);
  const observeAws = () => observeManagedGpuAws(ec2, authority);
  return {
    stopHosts: async () => {
      const { instances } = await observeAws();
      if (instances.length) {
        const terminated = await compute.terminateVMs(instances);
        if (instances.some((id) => !terminated.includes(id)))
          throw new Error(
            'AWS did not confirm every API host/reservation terminated',
          );
      }
      if ((await untilEmpty(async () => (await observeAws()).instances)).length)
        throw new Error('AWS API host absence is not confirmed');
    },
    cleanupAzure: async () => {
      const result = await cleanupAzureManagedGpuOwner(
        authority.capacity.region,
        owners.hostedApiIdentity,
        env,
      );
      if (result.summary.errors.length)
        throw new Error(
          `Azure cleanup failed: ${JSON.stringify(result.summary.errors)}`,
        );
      return result.residualResources;
    },
    cleanupAwsSupporting: async () => {
      const observed = await observeAws();
      for (const nic of observed.interfaces)
        if (nic.removable)
          await ec2.send(
            new DeleteNetworkInterfaceCommand({ NetworkInterfaceId: nic.id }),
          );
      for (const address of observed.addresses)
        if (!address.AssociationId)
          await ec2.send(
            new ReleaseAddressCommand({ AllocationId: address.AllocationId }),
          );
      for (const volume of observed.volumes)
        if (volume.removable)
          await ec2.send(new DeleteVolumeCommand({ VolumeId: volume.id }));
      // API-host Jobs use shared groups, subnets and IAM; none belong to this run.
      return untilEmpty(async () => {
        const remaining = await observeAws();
        return [
          ...remaining.instances,
          ...remaining.volumes.map((item) => item.id),
          ...remaining.interfaces.map((item) => item.id),
          ...remaining.addresses.map((item) => item.AllocationId!),
        ];
      });
    },
    cleanupDns: async () => {
      const token = env.E2E_SERVE_GITHUB_TOKEN;
      if (!token)
        throw new Error(
          'E2E_SERVE_GITHUB_TOKEN is required for owned DNS cleanup',
        );
      for (const subdomain of owners.subdomains)
        await deleteDNSRecordBySubdomain(subdomain, token);
    },
    cleanupState: () => cleanupManagedGpuCheckpoint(s3, storage, authority),
  };
}

async function main(): Promise<void> {
  const [operation, runId, attempt, output] = process.argv.slice(2);
  if (
    operation !== 'cleanup' ||
    !runId ||
    !attempt ||
    !output ||
    process.argv.length !== 6
  )
    throw new Error(
      'Usage: managed-gpu-run.ts cleanup <original-run-id> <original-attempt> <receipt.json>',
    );
  const env = process.env;
  const selection = {
    repository: env.GITHUB_REPOSITORY ?? '',
    runId,
    attempt: Number(attempt),
  };
  const retained = await fetchManagedGpuCleanupAuthority(
    selection,
    env.GH_TOKEN ?? env.GITHUB_TOKEN ?? '',
  );
  const outcome = await recoverManagedGpuRun(
    await recoveryOperations(retained.authority, env),
  );
  const receipt = {
    schemaVersion: 1,
    kind: 'manual-managed-gpu-recovery',
    ...retained,
    ...outcome,
    recovery: {
      runId: env.GITHUB_RUN_ID ?? null,
      runAttempt: env.GITHUB_RUN_ATTEMPT ?? null,
      sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }).trim(),
    },
    coverage: {
      aws: [
        'instances',
        'volumes',
        'network-interfaces',
        'addresses',
        'checkpoint-bucket',
      ],
      azure: [
        'virtual-machines',
        'disks',
        'network-interfaces',
        'public-ips',
        'network-security-groups',
        'virtual-networks',
      ],
      dns: managedGpuRunOwners(retained.authority).subdomains,
    },
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`);
  if (!outcome.confirmed)
    throw new Error(`Manual recovery incomplete: ${outcome.errors.join('; ')}`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

#!/usr/bin/env tsx
// Reproduce the AWS pilot failures with a released anycloud binary and an IAM
// user restricted to EC2 in three regions. See README.md.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CreateAccessKeyCommand,
  CreateUserCommand,
  DeleteAccessKeyCommand,
  DeleteUserCommand,
  DeleteUserPolicyCommand,
  IAMClient,
  ListAccessKeysCommand,
  ListUserPoliciesCommand,
  ListUserTagsCommand,
  ListUsersCommand,
  PutUserPolicyCommand,
} from '@aws-sdk/client-iam';
import {
  DescribeInstancesCommand,
  DescribeVpcsCommand,
  EC2Client,
  TerminateInstancesCommand,
} from '@aws-sdk/client-ec2';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';

const ALLOWED_REGIONS = ['us-east-1', 'us-east-2', 'us-west-2'];
const DENIED_PROBE_REGION = 'ap-south-1';
const API_PORT = 18080;
const CREDENTIAL = 'pilot-aws';
const POLICY_NAME = 'pilot-ec2-three-regions';
const IAM_POLICY_NAME = 'control-anycloud-vm-profile';

// Mirrors the pilot: EC2 only, in three regions, plus the Spot service-linked
// role. No other IAM action.
const PILOT_POLICY = {
  Version: '2012-10-17',
  Statement: [
    {
      Effect: 'Allow',
      Action: 'ec2:*',
      Resource: '*',
      Condition: { StringEquals: { 'aws:RequestedRegion': ALLOWED_REGIONS } },
    },
    {
      Effect: 'Allow',
      Action: 'iam:CreateServiceLinkedRole',
      Resource:
        'arn:aws:iam::*:role/aws-service-role/spot.amazonaws.com/AWSServiceRoleForEC2Spot',
      Condition: { StringLike: { 'iam:AWSServiceName': 'spot.amazonaws.com' } },
    },
  ],
};

// Control: only the IAM actions the shared VM role and instance profile
// bootstrap uses, scoped to those two resources. If the pilot failure is that
// bootstrap, this grant alone lets the same Job run.
const IAM_CONTROL_POLICY = {
  Version: '2012-10-17',
  Statement: [
    {
      Effect: 'Allow',
      Action: [
        'iam:GetRole',
        'iam:CreateRole',
        'iam:PutRolePolicy',
        'iam:PassRole',
      ],
      Resource: 'arn:aws:iam::*:role/anycloud-vm-role',
    },
    {
      Effect: 'Allow',
      Action: [
        'iam:GetInstanceProfile',
        'iam:CreateInstanceProfile',
        'iam:AddRoleToInstanceProfile',
      ],
      Resource: 'arn:aws:iam::*:instance-profile/anycloud-vm-profile',
    },
  ],
};

interface Case {
  name: string;
  args: string[];
  // Grant IAM_CONTROL_POLICY before this case.
  grantIam?: boolean;
}

const CASES: Case[] = [
  // Pilot item 2: no region, so anycloud picks the cheapest catalog region.
  { name: 'noreg', args: ['--vm-type', 't3.small'] },
  // The catalog's cheapest c6i.xlarge region is ap-south-1, outside the policy.
  { name: 'c6i-noreg', args: ['--vm-type', 'c6i.xlarge'] },
  // Pilot item 1: pinned to an allowed region.
  { name: 't3', args: ['--vm-type', 't3.small', '--region', 'us-east-1'] },
  { name: 'c6i', args: ['--vm-type', 'c6i.xlarge', '--region', 'us-east-1'] },
  // Pilot item 5: does a GPU Job reach a quota check before IAM?
  { name: 'g4dn', args: ['--vm-type', 'g4dn.xlarge', '--region', 'us-east-1'] },
  {
    name: 't3-iam',
    args: ['--vm-type', 't3.small', '--region', 'us-east-1'],
    grantIam: true,
  },
];

// Every workload ID starts with this, so the sweep matches only this
// experiment's instances.
const WORKLOAD_PREFIX = 'riam-';

interface Inventory {
  userName?: string;
  workloadIds: string[];
  anycloudDir?: string;
  bin?: string;
}

const output = process.env.SPIKE_OUTPUT_DIR ?? '';
if (!output) throw new Error('SPIKE_OUTPUT_DIR is required');
const inventoryPath = join(output, 'inventory.json');
const secrets: string[] = [];
// Set when the account ID is unknown, so every 12-digit number is redacted.
let redactAllAccountIds = false;

function redact(text: string): string {
  let result = text;
  for (const secret of secrets)
    result = result.split(secret).join('<redacted>');
  if (redactAllAccountIds)
    result = result.replace(/\b\d{12}\b/g, '<account-id>');
  return result.replace(/AKIA[0-9A-Z]{16}/g, '<access-key-id>');
}

function readInventory(): Inventory {
  try {
    return JSON.parse(readFileSync(inventoryPath, 'utf8')) as Inventory;
  } catch {
    return { workloadIds: [] };
  }
}

function saveInventory(inventory: Inventory): void {
  writeFileSync(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
}

function evidence(name: string, text: string): void {
  writeFileSync(join(output, name), redact(text));
}

function run(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
  timeoutMs = 15 * 60_000,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: `${result.stderr ?? ''}${result.error ? `\n${result.error.message}` : ''}`,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Every phase redacts the account ID before it logs anything. If the lookup
// fails, redact every 12-digit number instead and carry on, so cleanup still
// runs.
async function redactAccount(): Promise<void> {
  try {
    const sts = new STSClient({ region: 'us-east-1' });
    const account = (await sts.send(new GetCallerIdentityCommand({}))).Account;
    if (account) secrets.push(account);
    else redactAllAccountIds = true;
  } catch {
    redactAllAccountIds = true;
  }
}

async function waitForRestrictedKey(credentials: {
  accessKeyId: string;
  secretAccessKey: string;
}): Promise<void> {
  const ec2 = new EC2Client({ region: ALLOWED_REGIONS[0], credentials });
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      await ec2.send(new DescribeVpcsCommand({}));
      return;
    } catch (error) {
      if (attempt === 30) throw error;
      await sleep(5_000);
    }
  }
}

async function probeDeniedRegion(credentials: {
  accessKeyId: string;
  secretAccessKey: string;
}): Promise<string> {
  const ec2 = new EC2Client({ region: DENIED_PROBE_REGION, credentials });
  try {
    await ec2.send(new DescribeVpcsCommand({}));
    return 'allowed';
  } catch (error) {
    return (error as { name?: string }).name ?? 'error';
  }
}

async function runPhase(): Promise<void> {
  const version = process.argv[2] ?? '0.1.66';
  const inventory = readInventory();
  await redactAccount();

  const iam = new IAMClient({ region: 'us-east-1' });
  // A rerun of the same workflow run gets its own user.
  const runAttempt = process.env.GITHUB_RUN_ATTEMPT
    ? `-${process.env.GITHUB_RUN_ATTEMPT}`
    : '';
  const userName = `anycloud-spike-restricted-${process.env.GITHUB_RUN_ID ?? Date.now()}${runAttempt}`;
  await iam.send(
    new CreateUserCommand({
      UserName: userName,
      Tags: [{ Key: 'anycloud_spike', Value: 'aws-restricted-iam' }],
    }),
  );
  inventory.userName = userName;
  saveInventory(inventory);
  await iam.send(
    new PutUserPolicyCommand({
      UserName: userName,
      PolicyName: POLICY_NAME,
      PolicyDocument: JSON.stringify(PILOT_POLICY),
    }),
  );
  const key = (
    await iam.send(new CreateAccessKeyCommand({ UserName: userName }))
  ).AccessKey;
  if (!key?.AccessKeyId || !key.SecretAccessKey)
    throw new Error('CreateAccessKey returned no key');
  secrets.push(key.AccessKeyId, key.SecretAccessKey);
  const restricted = {
    accessKeyId: key.AccessKeyId,
    secretAccessKey: key.SecretAccessKey,
  };
  await waitForRestrictedKey(restricted);
  const deniedRegionProbe = await probeDeniedRegion(restricted);

  // The released binary and its published API image, as the pilot ran them.
  const work = mkdtempSync(join(tmpdir(), 'aws-restricted-iam-'));
  const bin = join(work, 'bin');
  const anycloudDir = join(work, 'anycloud');
  inventory.anycloudDir = anycloudDir;
  inventory.bin = join(bin, 'anycloud');
  saveInventory(inventory);
  const install = run('sh', [
    '-c',
    `curl -fsSL https://get.anycloud.sh | sh -s -- --version ${version} --install-dir ${bin} --no-modify-path`,
  ]);
  evidence('install.log', install.stdout + install.stderr);
  if (install.status !== 0) throw new Error('install failed; see install.log');

  const cliEnv = {
    ANYCLOUD_DIR: anycloudDir,
    API_URL: `http://localhost:${API_PORT}`,
    IS_TEST: 'true',
    GITHUB_TOKEN: 'dummy-token-for-test',
    // Keep the runner's admin keys away from the CLI.
    AWS_ACCESS_KEY_ID: '',
    AWS_SECRET_ACCESS_KEY: '',
    CI: 'true',
  };
  const cli = (args: string[], timeoutMs?: number) =>
    run(inventory.bin!, args, cliEnv, timeoutMs);

  const start = cli(['api', 'start', '--port', String(API_PORT)]);
  evidence('api-start.log', start.stdout + start.stderr);
  if (start.status !== 0)
    throw new Error('api start failed; see api-start.log');

  const credential = cli([
    'credentials',
    'new',
    CREDENTIAL,
    '--provider',
    'aws',
    '--access-key-id',
    restricted.accessKeyId,
    '--secret-access-key',
    restricted.secretAccessKey,
  ]);
  evidence('credentials-new.log', credential.stdout + credential.stderr);

  const results = [];
  // Workload IDs are limited to 28 characters.
  const suffix = String(process.env.GITHUB_RUN_ID ?? Date.now()).slice(-8);
  // Optional case names after the version select a subset.
  const selected = process.argv.slice(3);
  for (const testCase of CASES.filter(
    (c) => !selected.length || selected.includes(c.name),
  )) {
    if (testCase.grantIam) {
      await iam.send(
        new PutUserPolicyCommand({
          UserName: userName,
          PolicyName: IAM_POLICY_NAME,
          PolicyDocument: JSON.stringify(IAM_CONTROL_POLICY),
        }),
      );
      await sleep(30_000);
    }
    const id = `${WORKLOAD_PREFIX}${testCase.name}-${suffix}`;
    inventory.workloadIds.push(id);
    saveInventory(inventory);
    const submit = cli([
      'job',
      'ubuntu:24.04',
      '--id',
      id,
      '--credentials',
      CREDENTIAL,
      ...testCase.args,
      '--',
      'echo',
      'ok',
    ]);
    const wait = cli(['wait', id, '--json', '--timeout', '20m'], 22 * 60_000);
    const status = cli(['status', id, '--json']);
    const history = cli(['status', id, '--history']);
    evidence(
      `case-${testCase.name}.log`,
      [
        `$ anycloud job ubuntu:24.04 --id ${id} --credentials ${CREDENTIAL} ${testCase.args.join(' ')} -- echo ok`,
        `exit ${submit.status}`,
        submit.stdout,
        submit.stderr,
        `$ anycloud wait ${id} --json --timeout 20m`,
        `exit ${wait.status}`,
        wait.stdout,
        wait.stderr,
        `$ anycloud status ${id} --json`,
        status.stdout,
        status.stderr,
        `$ anycloud status ${id} --history`,
        history.stdout,
        history.stderr,
      ].join('\n'),
    );
    results.push({
      case: testCase.name,
      args: testCase.args,
      submitExit: submit.status,
      submitOutput: redact(`${submit.stdout}${submit.stderr}`.trim()).slice(
        -2000,
      ),
      waitExit: wait.status,
      status: redact(status.stdout.trim()).slice(-4000),
    });
  }

  const logs = run('docker', ['logs', 'anycloud-api'], {}, 60_000);
  const apiLog = `${logs.stdout}${logs.stderr}`;
  evidence('api.log', apiLog);
  const iamLines = apiLog
    .split('\n')
    .filter((line) =>
      /iam\.amazonaws\.com|AccessDenied|UnauthorizedOperation|instance profile|IAM role|could not conclusively|ap-south-1/i.test(
        line,
      ),
    );
  evidence('api-iam-lines.log', iamLines.join('\n'));

  const report = {
    anycloudVersion: version,
    restrictedPolicy: PILOT_POLICY,
    iamControlPolicy: IAM_CONTROL_POLICY,
    deniedRegionProbe: {
      region: DENIED_PROBE_REGION,
      result: deniedRegionProbe,
    },
    credentialNewExit: credential.status,
    apiLogMentionsIam: iamLines.some((line) =>
      /iam\.amazonaws\.com|IAM role|instance profile/i.test(line),
    ),
    cases: results,
  };
  evidence('report.json', `${JSON.stringify(report, null, 2)}\n`);
  console.log(redact(JSON.stringify(report, null, 2)));
}

async function cleanupPhase(): Promise<void> {
  await redactAccount();
  const inventory = readInventory();
  const failures: string[] = [];

  if (inventory.bin) {
    const stop = run(inventory.bin, ['api', 'stop'], {
      ANYCLOUD_DIR: inventory.anycloudDir,
    });
    if (stop.status !== 0) run('docker', ['rm', '-f', 'anycloud-api']);
  }

  // Terminate any VM a case managed to launch, in every region it could pick.
  if (inventory.workloadIds.length) {
    failures.push(
      ...(await terminateInstances(
        [{ Name: 'tag:anycloud_deployment', Values: inventory.workloadIds }],
        () => true,
      )),
    );
  }

  if (inventory.userName) {
    try {
      await deleteSpikeUser(inventory.userName);
    } catch (error) {
      failures.push(
        `IAM user ${inventory.userName}: ${(error as Error).message}`,
      );
    }
  }

  if (failures.length) {
    evidence('cleanup-failures.log', failures.join('\n'));
    throw new Error(`Cleanup incomplete:\n${failures.join('\n')}`);
  }
}

const SPIKE_REGIONS = [...ALLOWED_REGIONS, DENIED_PROBE_REGION];

// Terminates live instances matching the filter and the predicate in every
// region a case could reach; returns one failure line per failed region.
async function terminateInstances(
  filters: { Name: string; Values: string[] }[],
  owned: (tags: Record<string, string>) => boolean,
): Promise<string[]> {
  const failures: string[] = [];
  for (const region of SPIKE_REGIONS) {
    const ec2 = new EC2Client({ region });
    try {
      const described = await ec2.send(
        new DescribeInstancesCommand({
          Filters: [
            ...filters,
            {
              Name: 'instance-state-name',
              Values: ['pending', 'running', 'stopping', 'stopped'],
            },
          ],
        }),
      );
      const ids = (described.Reservations ?? [])
        .flatMap((r) => r.Instances ?? [])
        .filter((i) =>
          owned(
            Object.fromEntries(
              (i.Tags ?? []).map((tag) => [tag.Key ?? '', tag.Value ?? '']),
            ),
          ),
        )
        .map((i) => i.InstanceId)
        .filter((id): id is string => Boolean(id));
      if (ids.length) {
        await ec2.send(new TerminateInstancesCommand({ InstanceIds: ids }));
        console.log(`Terminated ${ids.length} instance(s) in ${region}`);
      }
    } catch (error) {
      failures.push(`${region}: ${redact((error as Error).message)}`);
    }
  }
  return failures;
}

const isNoSuchEntity = (error: unknown) =>
  ['NoSuchEntity', 'NoSuchEntityException'].includes(
    (error as { name?: string }).name ?? '',
  );

async function deleteSpikeUser(userName: string): Promise<void> {
  const iam = new IAMClient({ region: 'us-east-1' });
  try {
    const keys = await iam.send(
      new ListAccessKeysCommand({ UserName: userName }),
    );
    for (const key of keys.AccessKeyMetadata ?? []) {
      await iam.send(
        new DeleteAccessKeyCommand({
          UserName: userName,
          AccessKeyId: key.AccessKeyId,
        }),
      );
    }
    const policies = await iam.send(
      new ListUserPoliciesCommand({ UserName: userName }),
    );
    for (const policyName of policies.PolicyNames ?? []) {
      await iam.send(
        new DeleteUserPolicyCommand({
          UserName: userName,
          PolicyName: policyName,
        }),
      );
    }
    await iam.send(new DeleteUserCommand({ UserName: userName }));
    console.log(`Deleted IAM user ${userName}`);
  } catch (error) {
    if (!isNoSuchEntity(error)) throw error;
  }
}

// Workload IDs are `riam-<case>-<8 digits>`; the Name tag is
// `<workload ID>-<index>`.
const CASE_ID = new RegExp(
  `^${WORKLOAD_PREFIX}(?:${CASES.map((c) => c.name).join('|')})-\\d{8}(?:-\\d+)?$`,
);

// Delete every leftover spike user and terminate every instance a case could
// have launched, for resuming after a failed cleanup.
async function sweepPhase(): Promise<void> {
  await redactAccount();
  const patterns = [`${WORKLOAD_PREFIX}*`];
  const terminateFailures = [
    ...(await terminateInstances(
      [{ Name: 'tag:anycloud_deployment', Values: patterns }],
      (tags) => CASE_ID.test(tags.anycloud_deployment ?? ''),
    )),
    ...(await terminateInstances(
      [{ Name: 'tag:Name', Values: patterns }],
      (tags) => CASE_ID.test(tags.Name ?? ''),
    )),
  ];
  // Record these before an IAM error below can end the sweep.
  if (terminateFailures.length)
    evidence('cleanup-failures.log', terminateFailures.join('\n'));
  const iam = new IAMClient({ region: 'us-east-1' });
  const deleted: string[] = [];
  let marker: string | undefined;
  do {
    const page = await iam.send(new ListUsersCommand({ Marker: marker }));
    for (const user of page.Users ?? []) {
      if (!user.UserName?.startsWith('anycloud-spike-restricted-')) continue;
      const tags = await iam.send(
        new ListUserTagsCommand({ UserName: user.UserName }),
      );
      const owned = (tags.Tags ?? []).some(
        (tag) =>
          tag.Key === 'anycloud_spike' && tag.Value === 'aws-restricted-iam',
      );
      if (!owned) continue;
      await deleteSpikeUser(user.UserName);
      deleted.push(user.UserName);
    }
    marker = page.IsTruncated ? page.Marker : undefined;
  } while (marker);
  evidence('sweep.json', `${JSON.stringify({ deleted }, null, 2)}\n`);
  if (terminateFailures.length) {
    throw new Error(`Sweep incomplete:\n${terminateFailures.join('\n')}`);
  }
}

const phase =
  process.env.SPIKE_PHASE === 'cleanup'
    ? cleanupPhase
    : process.argv[2] === 'sweep'
      ? sweepPhase
      : runPhase;
phase().catch((error: unknown) => {
  console.error(redact(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});

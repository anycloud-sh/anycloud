import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  azureStorageAccount,
  parseOneDocument,
  seedInstallation,
  type SeedRun,
} from '../integration/e2e/internal/substrates/cloud-cluster/seed.js';
import type { CommandResult } from '../integration/e2e/internal/types.js';
import type { SeedCloud } from '../../src/cli/seed/types.js';

function result(stdout: string, exitCode = 0, stderr = ''): CommandResult {
  return {
    executable: '',
    args: [],
    exitCode,
    signal: null,
    stdout,
    stderr,
    combined: stdout + stderr,
    durationMs: 1,
    timedOut: false,
    aborted: false,
    outputTruncated: false,
  };
}

const SUBSCRIPTION = 'abcdef12-3456-7890-abcd-ef1234567890';
/** S4's service account for cluster c-1 in proj-1: sha256('c-1'), first 20 hex digits. */
const SA = `anycloud-${createHash('sha256').update('c-1').digest('hex').slice(0, 20)}@proj-1.iam.gserviceaccount.com`;

/** A fake runner answering by the command line, recording each call. */
function fake(answers: Record<string, CommandResult>) {
  const calls: { line: string; recordArtifact: boolean }[] = [];
  const run: SeedRun = async (executable, args, options) => {
    const line = [executable, ...args].join(' ');
    calls.push({ line, recordArtifact: options?.recordArtifact !== false });
    const key = Object.keys(answers).find((prefix) => line.startsWith(prefix));
    if (!key) throw new Error(`unexpected command: ${line}`);
    return answers[key]!;
  };
  return { run, calls };
}

function seed(cloud: SeedCloud, run: SeedRun, downloaded = '') {
  return seedInstallation(
    cloud,
    run,
    { region: 'r-1', account: cloud === 'gcp' ? 'proj-1' : SUBSCRIPTION },
    async () => ({ path: '/tmp/blob', read: async () => downloaded }),
  );
}

describe('seed installation through the cloud CLIs', () => {
  it('reads the AWS stack by its seed name; only a missing stack is absent, a setup error throws', async () => {
    const present = fake({
      'aws cloudformation describe-stacks': result(
        JSON.stringify({ Stacks: [{ StackStatus: 'CREATE_COMPLETE' }] }),
      ),
    });
    expect(await seed('aws', present.run).installation('c-1')).toEqual({
      kind: 'present',
      detail: 'stack CREATE_COMPLETE',
    });
    expect(present.calls[0]!.line).toContain(
      '--stack-name anycloud-c-1 --output json --region r-1',
    );

    const absent = fake({
      'aws cloudformation': result(
        '',
        254,
        'An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id anycloud-c-1 does not exist',
      ),
    });
    expect(await seed('aws', absent.run).installation('c-1')).toEqual({
      kind: 'absent',
    });

    for (const stderr of [
      'An error occurred (AccessDenied) when calling the DescribeStacks operation',
      'The config profile (e2e) could not be found',
    ]) {
      const broken = fake({ 'aws cloudformation': result('', 254, stderr) });
      await expect(seed('aws', broken.run).installation('c-1')).rejects.toThrow(
        /describe-stacks failed/,
      );
    }
  });

  it('pins Azure to the subscription and GCP to the project; a missing subscription is never a missing group', async () => {
    const gone = fake({
      'az group show': result(
        '',
        3,
        "(ResourceGroupNotFound) Resource group 'anycloud-c-1' could not be found.",
      ),
      'gcloud compute instances list': result('[]'),
    });
    expect(await seed('azure', gone.run).installation('c-1')).toEqual({
      kind: 'absent',
    });
    expect(await seed('gcp', gone.run).installation('c-1')).toEqual({
      kind: 'absent',
    });
    expect(gone.calls.map((call) => call.line)).toEqual([
      `az group show --name anycloud-c-1 --output json --subscription ${SUBSCRIPTION}`,
      'gcloud compute instances list --filter=name=anycloud-cluster-c-1 --format=json --project=proj-1 --quiet',
    ]);

    const wrongSubscription = fake({
      'az group show': result(
        '',
        1,
        `(SubscriptionNotFound) The subscription '${SUBSCRIPTION}' could not be found.`,
      ),
    });
    await expect(
      seed('azure', wrongSubscription.run).installation('c-1'),
    ).rejects.toThrow(/az group show failed/);
  });

  it('lists what is still tagged for the cluster, but ended AWS instances and the buckets delete keeps', async () => {
    const arn = (rest: string) => `arn:aws:ec2:r-1:1:${rest}`;
    const aws = fake({
      'aws resourcegroupstaggingapi': result(
        JSON.stringify({
          // The tagging API still lists what was deleted within the hour.
          ResourceTagMappingList: [
            { ResourceARN: arn('instance/i-ended') },
            { ResourceARN: arn('instance/i-live') },
            { ResourceARN: arn('volume/vol-gone') },
            { ResourceARN: arn('volume/vol-1') },
            { ResourceARN: arn('network-interface/eni-gone') },
            { ResourceARN: arn('security-group/sg-gone') },
            { ResourceARN: arn('elastic-ip/eipalloc-1') },
            { ResourceARN: 'arn:aws:s3:::anycloud-checkpoint-c-1' },
            { ResourceARN: 'arn:aws:s3:::anycloud-gone' },
            {
              ResourceARN:
                'arn:aws:cloudformation:r-1:1:stack/anycloud-c-1/uuid-1',
            },
          ],
        }),
      ),
      'aws iam get-role --role-name anycloud-c-1-cfn': result(
        '{"Role":{"RoleName":"anycloud-c-1-cfn"}}',
      ),
      // Describes filter by id: what is gone is simply not returned.
      'aws ec2 describe-instances --filters Name=instance-id,Values=i-ended,i-live':
        result('["i-live"]'),
      'aws ec2 describe-volumes --filters Name=volume-id,Values=vol-gone,vol-1':
        result('["vol-1"]'),
      'aws ec2 describe-network-interfaces --filters Name=network-interface-id,Values=eni-gone':
        result('[]'),
      'aws ec2 describe-security-groups --filters Name=group-id,Values=sg-gone':
        result('[]'),
      'aws s3api head-bucket --bucket anycloud-checkpoint-c-1': result(
        '{"BucketRegion":"r-1"}',
      ),
      'aws s3api head-bucket --bucket anycloud-gone': result(
        '',
        254,
        'An error occurred (404) when calling the HeadBucket operation: Not Found',
      ),
      'aws cloudformation describe-stacks --stack-name arn:aws:cloudformation':
        result(
          JSON.stringify({ Stacks: [{ StackStatus: 'DELETE_COMPLETE' }] }),
        ),
    });
    expect(
      await seed('aws', aws.run).leftovers('c-1', ['anycloud-checkpoint-c-1']),
    ).toEqual([
      { kind: 'iam', id: 'role/anycloud-c-1-cfn' },
      { kind: 'ec2', id: arn('instance/i-live') },
      { kind: 'ec2', id: arn('volume/vol-1') },
      // A type with no describe here still counts.
      { kind: 'ec2', id: arn('elastic-ip/eipalloc-1') },
    ]);
    // A stack short of DELETE_COMPLETE counts; one its describe no longer
    // knows does not.
    const stack = (answer: CommandResult) =>
      seed(
        'aws',
        fake({
          'aws resourcegroupstaggingapi': result(
            JSON.stringify({
              ResourceTagMappingList: [
                {
                  ResourceARN:
                    'arn:aws:cloudformation:r-1:1:stack/anycloud-c-1/uuid-1',
                },
              ],
            }),
          ),
          'aws iam get-role': result(
            '',
            254,
            'An error occurred (NoSuchEntity)',
          ),
          'aws cloudformation describe-stacks': answer,
        }).run,
      ).leftovers('c-1');
    expect(
      await stack(
        result(JSON.stringify({ Stacks: [{ StackStatus: 'DELETE_FAILED' }] })),
      ),
    ).toHaveLength(1);
    expect(
      await stack(
        result(
          '',
          254,
          'An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id x does not exist',
        ),
      ),
    ).toEqual([]);

    // A describe that fails is a setup error, never a clean sweep.
    const denied = fake({
      'aws resourcegroupstaggingapi': result(
        JSON.stringify({
          ResourceTagMappingList: [{ ResourceARN: arn('volume/vol-1') }],
        }),
      ),
      'aws iam get-role': result('', 254, 'An error occurred (NoSuchEntity)'),
      'aws ec2 describe-volumes': result(
        '',
        254,
        'An error occurred (UnauthorizedOperation)',
      ),
    });
    await expect(seed('aws', denied.run).leftovers('c-1')).rejects.toThrow(
      /describe-volumes failed/,
    );
    const refusedBucket = fake({
      'aws resourcegroupstaggingapi': result(
        JSON.stringify({
          ResourceTagMappingList: [{ ResourceARN: 'arn:aws:s3:::anycloud-x' }],
        }),
      ),
      'aws iam get-role': result('', 254, 'An error occurred (NoSuchEntity)'),
      'aws s3api head-bucket': result(
        '',
        254,
        'An error occurred (403) when calling the HeadBucket operation: Forbidden',
      ),
    });
    await expect(
      seed('aws', refusedBucket.run).leftovers('c-1'),
    ).rejects.toThrow(/head-bucket failed/);
    expect(aws.calls[0]!.line).toContain('Key=anycloud_cluster,Values=c-1');

    const azure = fake({
      'az resource list --tag anycloud_cluster=c-1': result(
        JSON.stringify([
          {
            id: '/subscriptions/s/vm',
            type: 'Microsoft.Compute/virtualMachines',
          },
        ]),
      ),
    });
    expect(await seed('azure', azure.run).leftovers('c-1')).toEqual([
      { kind: 'Microsoft.Compute/virtualMachines', id: '/subscriptions/s/vm' },
    ]);

    const gcp = fake({
      'gcloud compute instances list': result('[]'),
      'gcloud compute disks list': result('[{"name":"d-1"}]'),
      'gcloud storage buckets list': result(
        '[{"name":"anycloud-checkpoint-c-1"}]',
      ),
      'gcloud compute firewall-rules list': result(
        '[{"name":"anycloud-cluster-c-1-api"}]',
      ),
      'gcloud iam service-accounts list': result(
        `[{"name":"projects/proj-1/serviceAccounts/${SA}","email":"${SA}"}]`,
      ),
      'gcloud projects get-iam-policy proj-1': result(
        JSON.stringify({
          bindings: [
            {
              role: 'roles/storage.admin',
              members: [`serviceAccount:${SA}`, 'user:x'],
            },
            {
              role: 'roles/compute.admin',
              members: [`deleted:serviceAccount:${SA}?uid=1`],
            },
            {
              role: 'roles/viewer',
              members: ['serviceAccount:other@proj-1.iam.gserviceaccount.com'],
            },
          ],
        }),
      ),
    });
    expect(
      await seed('gcp', gcp.run).leftovers('c-1', ['anycloud-checkpoint-c-1']),
    ).toEqual([
      { kind: 'serviceAccount', id: SA },
      { kind: 'binding', id: `roles/storage.admin serviceAccount:${SA}` },
      {
        kind: 'binding',
        id: `roles/compute.admin deleted:serviceAccount:${SA}?uid=1`,
      },
      { kind: 'disk', id: 'd-1' },
      { kind: 'firewall', id: 'anycloud-cluster-c-1-api' },
    ]);
    expect(gcp.calls.map((call) => call.line)).toContainEqual(
      expect.stringContaining(`--filter=email=${SA}`),
    );
    expect(gcp.calls.map((call) => call.line)).toContainEqual(
      expect.stringContaining('--filter=labels.anycloud_cluster=c-1'),
    );
    expect(gcp.calls.map((call) => call.line)).toContainEqual(
      expect.stringContaining('--filter=name~^anycloud-cluster-c-1-'),
    );
  });

  it('stops, never deletes, the one management VM on each cloud', async () => {
    const aws = fake({
      'aws ec2 describe-instances': result('i-0abc\n'),
      'aws ec2 stop-instances --instance-ids i-0abc': result('{}'),
      'aws ec2 wait instance-stopped --instance-ids i-0abc': result(''),
    });
    await seed('aws', aws.run).stopManagementVm('c-1');
    expect(aws.calls[0]!.line).toContain(
      'Name=tag:anycloud_cluster,Values=c-1',
    );
    const azure = fake({
      'az vm list --resource-group anycloud-c-1': result('/sub/vm-1\n'),
      'az vm deallocate --ids /sub/vm-1': result(''),
    });
    await seed('azure', azure.run).stopManagementVm('c-1');
    const gcp = fake({
      'gcloud compute instances list --filter=name=anycloud-cluster-c-1':
        result(
          '[{"name":"anycloud-cluster-c-1","zone":"https://x/zones/us-central1-b"}]',
        ),
      'gcloud compute instances stop anycloud-cluster-c-1 --zone=us-central1-b':
        result(''),
    });
    await seed('gcp', gcp.run).stopManagementVm('c-1');
    // Two candidates are a wrong cluster, never a guess.
    const two = fake({ 'aws ec2 describe-instances': result('i-1 i-2\n') });
    await expect(seed('aws', two.run).stopManagementVm('c-1')).rejects.toThrow(
      'found 2',
    );
  });

  it("reads the management VM's boot output on each cloud; Azure adds the boot script's log, or why it couldn't", async () => {
    const aws = fake({
      'aws ec2 describe-instances': result('i-0abc\n'),
      'aws ec2 get-console-output --instance-id i-0abc --latest':
        result('kernel\n'),
    });
    expect(await seed('aws', aws.run).consoleOutput('c-1')).toBe('kernel\n');
    expect(aws.calls.at(-1)).toMatchObject({ recordArtifact: false });
    const gcp = fake({
      'gcloud compute instances list --filter=name=anycloud-cluster-c-1':
        result(
          '[{"name":"anycloud-cluster-c-1","zone":"https://x/zones/us-central1-b"}]',
        ),
      'gcloud compute instances get-serial-port-output anycloud-cluster-c-1 --zone=us-central1-b --project=proj-1':
        result('serial\n'),
    });
    expect(await seed('gcp', gcp.run).consoleOutput('c-1')).toBe('serial\n');
    const azure = fake({
      'az vm list --resource-group anycloud-c-1': result('/sub/vm-1\n'),
      'az vm boot-diagnostics get-boot-log --ids /sub/vm-1': result('serial\n'),
      'az vm run-command invoke --ids /sub/vm-1 --command-id RunShellScript':
        result('', 1, 'VM agent not ready'),
    });
    expect(await seed('azure', azure.run).consoleOutput('c-1')).toBe(
      'serial\n\n--- /var/log/anycloud-boot.log ---\n(vm run-command invoke failed: VM agent not ready)',
    );
    const none = fake({ 'aws ec2 describe-instances': result('\n') });
    expect(await seed('aws', none.run).consoleOutput('c-1')).toBeNull();
  });

  it('reads the access kubeconfig from the checkpoint bucket, null until written, and never into an artifact', async () => {
    const reads: Record<SeedCloud, [string, string]> = {
      aws: [
        'aws s3 cp s3://ck/e2e/access-kubeconfig - --region r-1',
        'An error occurred (404) when calling the HeadObject operation: Key "e2e/access-kubeconfig" does not exist',
      ],
      gcp: [
        'gcloud storage cat gs://ck/e2e/access-kubeconfig --project=proj-1',
        'ERROR: (gcloud.storage.cat) The following URLs matched no objects or files:\n-gs://ck/e2e/access-kubeconfig',
      ],
      azure: [
        `az storage blob download --account-name ${azureStorageAccount(SUBSCRIPTION)} --container-name ck --name e2e/access-kubeconfig --auth-mode key --file /tmp/blob`,
        'The specified blob does not exist.\nErrorCode:BlobNotFound',
      ],
    };
    for (const [cloud, [prefix, missing]] of Object.entries(reads) as [
      SeedCloud,
      [string, string],
    ][]) {
      const ready = fake({
        [prefix]: result(cloud === 'azure' ? '' : 'apiVersion: v1\n'),
      });
      expect(
        await seed(cloud, ready.run, 'apiVersion: v1\n').accessKubeconfig('ck'),
      ).toBe('apiVersion: v1\n');
      expect(ready.calls).toEqual([
        expect.objectContaining({ recordArtifact: false }),
      ]);
      const notYet = fake({ [prefix]: result('', 1, missing) });
      expect(await seed(cloud, notYet.run).accessKubeconfig('ck')).toBeNull();
      const denied = fake({ [prefix]: result('', 1, 'AccessDenied (403)') });
      await expect(
        seed(cloud, denied.run).accessKubeconfig('ck'),
      ).rejects.toThrow(/failed/);
    }
    expect(azureStorageAccount(SUBSCRIPTION)).toBe('anycloudabcdef12');
  });

  it('takes a --json command only as one document on stdout', () => {
    expect(parseOneDocument(result('{"id":"c-1"}\n'), 'api create')).toEqual({
      id: 'c-1',
    });
    expect(() =>
      parseOneDocument(
        result('{"level":"info"}\n{"id":"c-1"}\n'),
        'api delete',
      ),
    ).toThrow(/no single JSON document/);
  });
});

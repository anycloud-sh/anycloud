import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import { createCloudCli } from '../../../../src/cli/seed/cloud-cli.js';
import { installFakeCloudClis } from '../../../helpers/fake-cloud-cli.js';

import { CloudType } from '../../../../src/shared/cloud.js';
import { CLOUDFLARE_IPV4_RANGES } from '../../../../src/shared/cloudflare-ips.js';
import {
  createGcpSeed,
  gcpServiceAccountEmail,
} from '../../../../src/cli/seed/gcp.js';
import {
  CloudCliError,
  type CloudCli,
  type SeedParams,
} from '../../../../src/cli/seed/types.js';

const ID = 'ci-1790000000000-a3f9';
const PROJECT = 'acme-prod';
const ZONE = 'us-central1-a';
const VM = `anycloud-cluster-${ID}`;
const EMAIL = gcpServiceAccountEmail(ID, PROJECT);
const P = `--project=${PROJECT}`;
const MEMBER = `--member=serviceAccount:${EMAIL}`;
const LABELS = `--labels=anycloud_cluster_name=ci,anycloud_cluster=${ID}`;
const SCRIPT = '#!/bin/bash\necho "a,b"\n';

const params: SeedParams = {
  clusterId: ID,
  clusterName: 'ci',
  region: 'us-central1',
  zone: ZONE,
  vmType: 'e2-standard-4',
  bucket: { name: 'acme-checkpoints', managed: true },
  releaseValues: {
    selfDelete: {
      cloud: 'gcp',
      instanceName: VM,
      zone: ZONE,
    },
    backup: {
      bucket: 'acme-checkpoints',
      region: 'us-central1',
      cloudProvider: CloudType.GCP,
      credentials: {
        cloudProvider: CloudType.GCP,
        kind: 'instance',
        projectId: PROJECT,
      },
    },
  },
  startupScript: SCRIPT,
  tags: { anycloud_cluster_name: 'ci' },
};

const instance = (status = 'RUNNING') => ({
  id: '4711',
  name: VM,
  zone: `https://www.googleapis.com/compute/v1/projects/${PROJECT}/zones/${ZONE}`,
  status,
  networkInterfaces: [{ accessConfigs: [{ natIP: '34.1.2.3' }] }],
  serviceAccounts: [{ email: EMAIL }],
  metadata: { items: [{ key: 'anycloud-bucket', value: 'acme-checkpoints' }] },
});

const failure = (stderr: string) =>
  new CloudCliError('gcloud', [], 1, `ERROR: ${stderr}`);

class Seq {
  constructor(readonly answers: (string | object | Error)[]) {}
}
/** Answers in turn, repeating the last. */
const seq = (...answers: (string | object | Error)[]) => new Seq(answers);

/**
 * A fake `gcloud`: answers each argv by its leading words and records the
 * argv, with temp-file paths replaced by the files' contents.
 */
function fakeGcloud(answers: Record<string, string | object | Seq>) {
  const calls: string[] = [];
  const queues = new Map<string, (string | object | Error)[]>();
  const cli: CloudCli = {
    run: async ({ args }) => {
      const shown = args.map((arg) =>
        arg.replace(
          /(\/[^=]*anycloud-seed-[^/]+\/value)$/,
          (path) => `<${readFileSync(path, 'utf8')}>`,
        ),
      );
      calls.push(shown.join(' '));
      const key = Object.keys(answers)
        .filter((prefix) => shown.join(' ').startsWith(prefix))
        .sort((a, b) => b.length - a.length)[0];
      const answer = key === undefined ? '' : answers[key];
      if (answer instanceof Seq) {
        const queue = queues.get(key!) ?? [...answer.answers];
        queues.set(key!, queue);
        const next = queue.length > 1 ? queue.shift()! : queue[0];
        if (next instanceof Error) throw next;
        return typeof next === 'string' ? next : JSON.stringify(next);
      }
      return typeof answer === 'string' ? answer : JSON.stringify(answer);
    },
  };
  return { cli, calls };
}

/** S1's `discoverAccount`, once per seed. */
const DISCOVERY = [
  'config get project',
  'auth print-access-token',
  'config get account',
];
const signedIn = {
  'config get project': `${PROJECT}\n`,
  'config get account': 'me@acme.com\n',
  'auth print-access-token': 'tok\n',
};
const sleep = vi.fn(async () => {});

const instanceBinding = `<{"title":"anycloud-instance","expression":"resource.name.endsWith(\\"/zones/${ZONE}/instances/${VM}\\") || resource.name.endsWith(\\"/zones/${ZONE}/disks/${VM}\\")"}>`;
const k8sShape = `--allow=tcp:6443 --source-ranges=0.0.0.0/0 --target-tags=${VM}`;
const apiShape = `--allow=tcp:80,tcp:443 --source-ranges=${CLOUDFLARE_IPV4_RANGES.join(',')} --target-tags=${VM}`;

const deployCalls = (bucketCalls: string[]) => [
  ...DISCOVERY,
  `iam service-accounts create ${EMAIL.split('@')[0]} ${P} --display-name=AnyCloud cluster ${ID} --description=anycloud_cluster=${ID} anycloud_cluster_name=ci anycloud_bucket=acme-checkpoints --quiet`,
  `projects add-iam-policy-binding ${PROJECT} ${MEMBER} --role=roles/compute.instanceAdmin.v1 --condition-from-file=${instanceBinding} --quiet`,
  `compute firewall-rules create ${VM}-k8s ${P} --network=default --direction=INGRESS ${k8sShape} --quiet`,
  `compute firewall-rules create ${VM}-api ${P} --network=default --direction=INGRESS ${apiShape} --quiet`,
  ...bucketCalls,
  `storage buckets add-iam-policy-binding gs://acme-checkpoints ${MEMBER} --role=roles/storage.objectUser --quiet`,
  `compute instances create ${VM} ${P} --zone=${ZONE} --machine-type=e2-standard-4 --image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud --boot-disk-size=20GB --boot-disk-type=pd-balanced --service-account=${EMAIL} --scopes=cloud-platform --stack-type=IPV4_ONLY --tags=${VM} ${LABELS} --metadata=anycloud-bucket=acme-checkpoints --metadata-from-file=startup-script=<${SCRIPT}> --quiet`,
  `compute instances describe ${VM} ${P} --zone=${ZONE} --format=json --quiet`,
];

const managedBucketCalls = [
  `storage buckets create gs://acme-checkpoints ${P} --location=us-central1 --uniform-bucket-level-access --public-access-prevention --quiet`,
  `storage buckets describe gs://acme-checkpoints ${P} --format=json --quiet`,
  `storage buckets update gs://acme-checkpoints ${P} --versioning --update-labels=${LABELS.slice('--labels='.length)} --quiet`,
];

const outputs = {
  publicIp: '34.1.2.3',
  instanceId: '4711',
  bucket: 'acme-checkpoints',
  identity: EMAIL,
};

describe('GCP seed', () => {
  it('names the service account within the 30-character account ID limit', () => {
    expect(EMAIL).toMatch(
      /^anycloud-[0-9a-f]{20}@acme-prod\.iam\.gserviceaccount\.com$/,
    );
    expect(gcpServiceAccountEmail(ID, PROJECT)).toBe(EMAIL);
  });

  it('creates every resource with the exact gcloud calls', async () => {
    const { cli, calls } = fakeGcloud({
      ...signedIn,
      'storage buckets describe': { labels: { anycloud_cluster: ID } },
      'compute instances describe': instance(),
    });
    await expect(createGcpSeed(cli, { sleep }).deploy(params)).resolves.toEqual(
      outputs,
    );
    expect(calls).toEqual(deployCalls(managedBucketCalls));
  });

  it('adopts what a previous run created, converging the firewall rules', async () => {
    const exists = seq(failure("The resource 'x' already exists"));
    const { cli, calls } = fakeGcloud({
      ...signedIn,
      'iam service-accounts create': exists,
      'compute firewall-rules create': exists,
      'storage buckets create': seq(
        failure('HTTPError 409: ... you already own it.'),
      ),
      'compute instances create': exists,
      'storage buckets describe': { labels: { anycloud_cluster: ID } },
      'compute instances describe': instance(),
    });
    await expect(createGcpSeed(cli, { sleep }).deploy(params)).resolves.toEqual(
      outputs,
    );
    const expected = deployCalls(managedBucketCalls);
    for (const [rule, shape] of [
      ['k8s', k8sShape],
      ['api', apiShape],
    ]) {
      const create = expected.findIndex((call) =>
        call.startsWith(`compute firewall-rules create ${VM}-${rule} `),
      );
      expected.splice(
        create + 1,
        0,
        `compute firewall-rules update ${VM}-${rule} ${P} ${shape} --quiet`,
      );
    }
    expect(calls).toEqual(expected);
  });

  it('refuses to adopt a bucket of the project that is not this installation’s', async () => {
    // Another installation's, or unlabelled under a name not the cluster's.
    for (const labels of [{ anycloud_cluster: 'other' }, undefined]) {
      const { cli, calls } = fakeGcloud({
        ...signedIn,
        'storage buckets create': seq(failure('you already own it')),
        'storage buckets describe': { labels },
      });
      await expect(
        createGcpSeed(cli, { sleep }).deploy(params),
      ).rejects.toThrow();
      expect(calls.at(-1)).toMatch(/^storage buckets describe /);
    }
  });

  it('adopts and labels its own bucket a failed run left unlabelled', async () => {
    const own = { name: ID, managed: true } as const;
    const { cli, calls } = fakeGcloud({
      ...signedIn,
      'storage buckets create': seq(failure('you already own it')),
      'storage buckets describe': {},
      'compute instances describe': {
        ...instance(),
        metadata: { items: [{ key: 'anycloud-bucket', value: ID }] },
      },
    });
    await createGcpSeed(cli, { sleep }).deploy({ ...params, bucket: own });
    expect(calls).toContain(
      `storage buckets update gs://${ID} ${P} --versioning --update-labels=${LABELS.slice('--labels='.length)} --quiet`,
    );
  });

  it('refuses an adopted instance that runs as another identity', async () => {
    const { cli } = fakeGcloud({
      ...signedIn,
      'storage buckets describe': { labels: { anycloud_cluster: ID } },
      'compute instances describe': {
        ...instance(),
        serviceAccounts: [{ email: 'x@y' }],
      },
    });
    await expect(
      createGcpSeed(cli, { sleep }).deploy(params),
    ).rejects.toThrow();
  });

  it('uses a supplied bucket as is', async () => {
    const { cli, calls } = fakeGcloud({
      ...signedIn,
      'compute instances describe': instance(),
    });
    await createGcpSeed(cli, { sleep }).deploy({
      ...params,
      bucket: { name: 'acme-checkpoints', managed: false },
    });
    expect(calls).toEqual(deployCalls([]));
  });

  it('relabels an existing managed bucket on restore instead of creating it', async () => {
    const { cli, calls } = fakeGcloud({
      ...signedIn,
      'compute instances describe': instance(),
    });
    await createGcpSeed(cli, { sleep }).deploy({
      ...params,
      bucket: { name: 'acme-checkpoints', managed: true, exists: true },
    });
    expect(calls).toEqual(
      deployCalls([
        `storage buckets update gs://acme-checkpoints ${P} --versioning --update-labels=${LABELS.slice('--labels='.length)} --quiet`,
      ]),
    );
  });

  it('retries while the new service account propagates, then gives up', async () => {
    const absent = failure('Service account x does not exist.');
    const { cli, calls } = fakeGcloud({
      ...signedIn,
      'projects add-iam-policy-binding': seq(absent, absent, ''),
      'storage buckets describe': { labels: { anycloud_cluster: ID } },
      'compute instances describe': instance(),
    });
    sleep.mockClear();
    await createGcpSeed(cli, { sleep }).deploy(params);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(calls.filter((c) => c.includes('instanceAdmin'))).toHaveLength(3);

    const stuck = fakeGcloud({
      ...signedIn,
      'projects add-iam-policy-binding': seq(absent),
    });
    await expect(
      createGcpSeed(stuck.cli, { sleep }).deploy(params),
    ).rejects.toBe(absent);
    expect(stuck.calls.filter((c) => c.includes('instanceAdmin'))).toHaveLength(
      8,
    );

    // Any other absence (an unknown machine type) fails at once.
    const noType = failure("The resource 'machineTypes/x' was not found");
    const other = fakeGcloud({
      ...signedIn,
      'storage buckets describe': { labels: { anycloud_cluster: ID } },
      'compute instances create': seq(noType),
    });
    sleep.mockClear();
    await expect(
      createGcpSeed(other.cli, { sleep }).deploy(params),
    ).rejects.toBe(noType);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('reports status from the instance', async () => {
    const statusOf = async (answer: object[]) =>
      createGcpSeed(
        fakeGcloud({ ...signedIn, 'compute instances list': answer }).cli,
      ).status(ID, 'us-central1');
    expect(await statusOf([])).toEqual({ kind: 'absent' });
    expect(await statusOf([instance()])).toEqual({
      kind: 'deployed',
      outputs,
      stopped: false,
    });
    for (const state of ['STOPPING', 'TERMINATED', 'SUSPENDING', 'SUSPENDED'])
      expect(await statusOf([instance(state)])).toEqual({
        kind: 'deployed',
        outputs,
        stopped: true,
      });
    expect(await statusOf([instance('PROVISIONING')])).toEqual({
      kind: 'in-progress',
      detail: `${VM} is PROVISIONING`,
    });
    expect(await statusOf([{ ...instance(), networkInterfaces: [] }])).toEqual({
      kind: 'failed',
      detail: `${VM} lacks its outputs`,
    });
  });

  it('reads an object, and null when it is absent', async () => {
    const present = fakeGcloud({ ...signedIn, 'storage cat': '{"v":1}' });
    const seed = createGcpSeed(present.cli);
    await expect(
      seed.readObject('b', 'backup.json', 'us-central1'),
    ).resolves.toBe('{"v":1}');
    expect(present.calls.at(-1)).toBe(
      `storage cat gs://b/backup.json ${P} --quiet`,
    );
    const absent = fakeGcloud({
      ...signedIn,
      'storage cat': seq(
        failure('The following URLs matched no objects or files'),
      ),
    });
    await expect(
      createGcpSeed(absent.cli).readObject('b', 'backup.json', 'us-central1'),
    ).resolves.toBeNull();
  });

  const fallbackAnswers = {
    ...signedIn,
    'compute instances list': [
      instance(),
      { name: 'pool-1', zone: `projects/${PROJECT}/zones/us-central1-b` },
    ],
    'compute firewall-rules delete': seq(
      failure("The resource 'x' was not found"),
      '',
    ),
    'storage buckets list': [
      { name: 'acme-checkpoints', location: 'US-CENTRAL1' },
    ],
    'iam service-accounts describe': {
      description: `anycloud_cluster=${ID} anycloud_cluster_name=ci anycloud_bucket=acme-checkpoints`,
    },
    [`storage buckets describe gs://${ID}`]: seq(
      failure('HTTPError 404: The specified bucket does not exist.'),
    ),
  };
  const describeAccount = `iam service-accounts describe ${EMAIL} ${P} --format=json --quiet`;
  const fallbackHead = [
    ...DISCOVERY,
    `compute instances list ${P} --filter=name=${VM} OR labels.anycloud_cluster=${ID} --format=json --quiet`,
    `compute instances delete ${VM} ${P} --zone=${ZONE} --quiet`,
    `compute instances delete pool-1 ${P} --zone=us-central1-b --quiet`,
    `compute firewall-rules delete ${VM}-k8s ${P} --quiet`,
    `compute firewall-rules delete ${VM}-api ${P} --quiet`,
    `storage buckets list ${P} --filter=labels.anycloud_cluster=${ID} --format=json --quiet`,
    `storage buckets describe gs://${ID} ${P} --format=json --quiet`,
  ];
  const fallbackTail = [
    `projects remove-iam-policy-binding ${PROJECT} ${MEMBER} --role=roles/compute.instanceAdmin.v1 --all --quiet`,
    `iam service-accounts delete ${EMAIL} ${P} --quiet`,
  ];
  const deletedVms = [
    { kind: 'vm', id: VM, location: ZONE },
    { kind: 'vm', id: 'pool-1', location: 'us-central1-b' },
    { kind: 'firewall', id: `${VM}-api` },
  ];

  it('deletes the installation directly and keeps the bucket', async () => {
    const { cli, calls } = fakeGcloud(fallbackAnswers);
    await expect(
      createGcpSeed(cli).deleteFallback(ID, 'us-central1', {
        deleteBuckets: false,
      }),
    ).resolves.toEqual({
      deleted: [...deletedVms, { kind: 'serviceAccount', id: EMAIL }],
      remaining: [
        {
          kind: 'bucket',
          id: 'acme-checkpoints',
          location: 'us-central1',
          selector: `labels.anycloud_cluster=${ID}`,
        },
      ],
    });
    expect(calls).toEqual([
      ...fallbackHead,
      describeAccount,
      `storage buckets remove-iam-policy-binding gs://acme-checkpoints ${MEMBER} --role=roles/storage.objectUser --quiet`,
      ...fallbackTail,
    ]);
  });

  it('deletes the bucket with --delete-buckets, and resumes past what is gone', async () => {
    const gone = failure('NOT_FOUND: Service account does not exist');
    const { cli, calls } = fakeGcloud({
      ...fallbackAnswers,
      'projects remove-iam-policy-binding': seq(
        failure('Policy binding ... not found!'),
      ),
      'iam service-accounts describe': seq(gone),
      'iam service-accounts delete': seq(gone),
    });
    await expect(
      createGcpSeed(cli).deleteFallback(ID, 'us-central1', {
        deleteBuckets: true,
      }),
    ).resolves.toEqual({
      deleted: [
        ...deletedVms,
        { kind: 'bucket', id: 'acme-checkpoints', location: 'us-central1' },
      ],
      remaining: [],
    });
    expect(calls).toEqual([
      ...fallbackHead,
      `storage rm --recursive gs://acme-checkpoints ${P} --quiet`,
      describeAccount,
      ...fallbackTail,
    ]);
  });

  it('unbinds a supplied bucket the service account names, keeping it', async () => {
    const { cli, calls } = fakeGcloud({
      ...fallbackAnswers,
      'storage buckets list': [],
    });
    await createGcpSeed(cli).deleteFallback(ID, 'us-central1', {
      deleteBuckets: true,
    });
    expect(calls).toContain(
      `storage buckets remove-iam-policy-binding gs://acme-checkpoints ${MEMBER} --role=roles/storage.objectUser --quiet`,
    );
    expect(calls.some((call) => call.startsWith('storage rm'))).toBe(false);
  });

  it('finds an installation by its service account, refusing two', async () => {
    const find = (found: object[]) => {
      const fake = fakeGcloud({
        ...signedIn,
        'iam service-accounts list': found,
      });
      return {
        calls: fake.calls,
        result: createGcpSeed(fake.cli).findByName('CI Box', 'us-central1'),
      };
    };
    const named = (id: string, name: string) => ({
      description: `anycloud_cluster=${id} anycloud_cluster_name=${name}`,
    });
    const one = find([
      named(ID, 'ci_box'),
      named('x', 'ci_box_2'),
      { description: 'unrelated' },
      {},
    ]);
    await expect(one.result).resolves.toBe(ID);
    expect(one.calls.at(-1)).toBe(
      `iam service-accounts list ${P} --filter=email~^anycloud- --format=json --quiet`,
    );
    await expect(find([]).result).resolves.toBeNull();
    await expect(
      find([named(ID, 'ci_box'), named('other', 'ci_box')]).result,
    ).rejects.toThrow();
  });

  it('derives the self-delete values, picking a catalog zone when none is given', () => {
    const seed = createGcpSeed(fakeGcloud({}).cli);
    const account = { account: PROJECT, principal: 'me' };
    expect(
      seed.selfDeleteValues(
        { clusterId: ID, region: 'us-central1', zone: ZONE },
        account,
      ),
    ).toEqual(params.releaseValues.selfDelete);
    const picked = seed.selfDeleteValues(
      { clusterId: ID, region: 'us-central1', zone: null },
      account,
    );
    expect(picked).toMatchObject({
      cloud: 'gcp',
      zone: expect.stringMatching(/^us-central1-[a-z]$/),
    });
    expect(
      seed.selfDeleteValues(
        { clusterId: ID, region: 'us-central1', zone: 'c' },
        account,
      ),
    ).toMatchObject({ zone: 'us-central1-c' });
  });

  it('backs up to the bucket as the VM’s own service account', () => {
    const seed = createGcpSeed(fakeGcloud({}).cli);
    expect(
      seed.backupValues(params, { account: PROJECT, principal: 'me' }),
    ).toEqual(params.releaseValues.backup);
  });

  it('finds the cluster’s unlabelled bucket, but not another installation’s', async () => {
    const run = async (described: object | Seq) => {
      const { cli, calls } = fakeGcloud({
        ...fallbackAnswers,
        'storage buckets list': [],
        [`storage buckets describe gs://${ID}`]: described,
      });
      const { remaining } = await createGcpSeed(cli).deleteFallback(
        ID,
        'us-central1',
        { deleteBuckets: true },
      );
      return {
        removed: calls.filter((call) => call.startsWith('storage rm')),
        remaining,
      };
    };
    expect(await run({ location: 'US-CENTRAL1' })).toEqual({
      removed: [`storage rm --recursive gs://${ID} ${P} --quiet`],
      remaining: [],
    });
    expect(
      await run({ location: 'US', labels: { anycloud_cluster: 'other' } }),
    ).toEqual({ removed: [], remaining: [] });
    // Unreadable (another project's of the same global name, or the user's
    // own without access): reported, never deleted.
    expect(
      await run(
        seq(
          failure(
            'HTTPError 403: x does not have storage.buckets.get access to the Google Cloud Storage bucket.',
          ),
        ),
      ),
    ).toEqual({
      removed: [],
      remaining: [
        {
          kind: 'bucket',
          id: ID,
          selector: `gs://${ID}`,
          reason: expect.any(String),
        },
      ],
    });
  });

  it('counts a confirmed "denied (or it may not exist)" service account as gone', async () => {
    const deniedOrGone = (verb: string) =>
      seq(
        failure(
          `PERMISSION_DENIED: Permission 'iam.serviceAccounts.${verb}' denied on resource (or it may not exist). reason: IAM_PERMISSION_DENIED`,
        ),
      );
    const answers = {
      ...fallbackAnswers,
      'compute firewall-rules delete': '',
      'iam service-accounts describe': deniedOrGone('get'),
      'iam service-accounts delete': deniedOrGone('delete'),
    };
    const rights = (permissions: string[]) =>
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json({ permissions })),
      );
    try {
      // The caller holds both rights, so the account is gone.
      rights(['iam.serviceAccounts.get', 'iam.serviceAccounts.delete']);
      const { deleted } = await createGcpSeed(
        fakeGcloud(answers).cli,
      ).afterSelfDelete(ID, 'us-central1', { deleteBuckets: false });
      expect(deleted).not.toContainEqual(
        expect.objectContaining({ kind: 'serviceAccount' }),
      );
      // Without the rights, it's a real denial.
      rights([]);
      await expect(
        createGcpSeed(fakeGcloud(answers).cli).deleteFallback(
          ID,
          'us-central1',
          { deleteBuckets: false },
        ),
      ).rejects.toThrow(/PERMISSION_DENIED/);
      // Nor when Resource Manager can't say.
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('', { status: 403 })),
      );
      await expect(
        createGcpSeed(fakeGcloud(answers).cli).afterSelfDelete(
          ID,
          'us-central1',
          { deleteBuckets: false },
        ),
      ).rejects.toThrow(/PERMISSION_DENIED/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('cleans up after a self-delete without touching pool VMs', async () => {
    // A pool VM still listed: only deleteFallback may delete it.
    const { cli, calls } = fakeGcloud({
      ...fallbackAnswers,
      'compute firewall-rules delete': '',
    });
    const result = await createGcpSeed(cli).afterSelfDelete(ID, 'us-central1', {
      deleteBuckets: true,
    });
    expect(result).toEqual({
      deleted: [
        { kind: 'firewall', id: `${VM}-k8s` },
        { kind: 'firewall', id: `${VM}-api` },
        { kind: 'bucket', id: 'acme-checkpoints', location: 'us-central1' },
        { kind: 'serviceAccount', id: EMAIL },
      ],
      remaining: [],
    });
    expect(
      calls.filter((call) => call.startsWith('compute instances')),
    ).toEqual([]);
  });

  it('adopts through a fake gcloud executable on PATH', async () => {
    const exists = {
      stderr: "ERROR: The resource 'x' already exists",
      exitCode: 1,
    };
    const clis = installFakeCloudClis({
      gcloud: [
        { match: ['config', 'get', 'project'], stdout: `${PROJECT}\n` },
        { match: ['config', 'get', 'account'], stdout: 'me@acme.com\n' },
        { match: ['iam', 'service-accounts', 'create'], ...exists },
        { match: ['compute', 'firewall-rules', 'create'], ...exists },
        { match: ['compute', 'instances', 'create'], ...exists },
        {
          match: ['storage', 'buckets', 'describe'],
          stdout: { labels: { anycloud_cluster: ID } },
        },
        { match: ['compute', 'instances', 'describe'], stdout: instance() },
        { match: /./, stdout: '' },
      ],
    });
    vi.stubEnv('PATH', clis.env.PATH);
    const cli = createCloudCli('gcp');
    try {
      await expect(
        createGcpSeed(cli, { sleep }).deploy(params),
      ).resolves.toEqual(outputs);
      const commands = clis
        .calls()
        .map(({ args }) => args.slice(0, 3).join(' '));
      expect(commands).toEqual([
        ...DISCOVERY,
        'iam service-accounts create',
        'projects add-iam-policy-binding acme-prod',
        'compute firewall-rules create',
        'compute firewall-rules update',
        'compute firewall-rules create',
        'compute firewall-rules update',
        'storage buckets create',
        'storage buckets describe',
        'storage buckets update',
        'storage buckets add-iam-policy-binding',
        'compute instances create',
        'compute instances describe',
      ]);
    } finally {
      vi.unstubAllEnvs();
      clis.cleanup();
    }
  });
});

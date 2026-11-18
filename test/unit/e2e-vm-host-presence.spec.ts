import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, onTestFinished, test, vi } from 'vitest';

import type { CloudCredential } from '../../src/shared/api-contract/credentials-schemas.js';
import { CloudType } from '../../src/shared/cloud.js';
import { FixtureFiles } from '../integration/e2e/internal/files.js';
import {
  ArtifactStore,
  Redactor,
} from '../integration/e2e/internal/artifacts.js';
import type { VmProfile } from '../integration/e2e/internal/profiles.js';
import type {
  CommandOptions,
  CommandResult,
} from '../integration/e2e/internal/types.js';
import {
  TargetHttpProtocolError,
  type TargetHttpClient,
} from '../integration/e2e/internal/transports/http.js';
import {
  awsInstanceStates,
  combineLambdaHostPresence,
  interpretAwsHostPresence,
  interpretLambdaListHostPresence,
  interpretLambdaPointHostPresence,
  parseLambdaInstanceInventory,
  PublicCloudVmHostPresenceProbe,
  PublicCloudVmHostPresenceProbeFactory,
  VmHostPresenceDeadlineError,
  VmHostPresenceProtocolError,
  type VmHostLocation,
} from '../integration/e2e/internal/transports/public-cloud-vm-host-presence.js';
import { commandResultForTest } from './helpers/e2e.js';

const awsId = 'i-0123456789abcdef0';
const lambdaId = 'a'.repeat(32);

describe('Lambda exact-name inventory projection', () => {
  test('retains only validated identity, state, placement and optional name', () => {
    const response = {
      status: 200,
      body: {
        data: [
          {
            id: lambdaId,
            name: 'exact-probe-name',
            status: 'active',
            region: { name: 'us-east-1' },
            jupyter_token: 'PRIVATE-NOTEBOOK-TOKEN',
            jupyter_url:
              'https://notebook.invalid/?token=PRIVATE-NOTEBOOK-TOKEN',
          },
        ],
      },
    };
    expect(parseLambdaInstanceInventory(response)).toEqual([
      {
        id: lambdaId,
        name: 'exact-probe-name',
        status: 'active',
        region: 'us-east-1',
      },
    ]);
    expect(
      JSON.stringify(parseLambdaInstanceInventory(response)),
    ).not.toContain('PRIVATE');
  });

  test.each([
    { data: [{ id: lambdaId, status: 'active', name: null }] },
    {
      data: [
        { id: lambdaId, status: 'active' },
        { id: lambdaId, status: 'terminated' },
      ],
    },
    { data: [], next: 'another-page' },
    { data: [], next_token: null },
    { data: [], partial: true },
    { data: [{ id: 'malformed', status: 'terminated' }] },
  ])('rejects malformed, duplicate or incomplete inventory %j', (body) => {
    expect(() => parseLambdaInstanceInventory({ status: 200, body })).toThrow(
      VmHostPresenceProtocolError,
    );
  });

  test('distinguishes authenticated empty inventory from unavailable or rejected reads', () => {
    expect(
      parseLambdaInstanceInventory({ status: 200, body: { data: [] } }),
    ).toEqual([]);
    expect(
      parseLambdaInstanceInventory({
        status: 503,
        body: 'unvalidated provider failure',
      }),
    ).toBeNull();
    expect(() =>
      parseLambdaInstanceInventory({ status: 403, body: { data: [] } }),
    ).toThrow('authentication');
  });

  test('keeps preempted instances present until independent native absence', () => {
    const row = { id: lambdaId, status: 'preempted' };
    expect(
      interpretLambdaPointHostPresence(
        { status: 200, body: { data: row } },
        lambdaId,
      ),
    ).toBe('present');
    expect(
      interpretLambdaListHostPresence(
        { status: 200, body: { data: [row] } },
        lambdaId,
      ),
    ).toBe('present');
  });
});

const location: VmHostLocation = {
  availabilityZone: 'b',
  cloudId: awsId,
  region: 'us-east-1',
};
const azureLocation: VmHostLocation = {
  availabilityZone: '1',
  cloudId: 'ac-native-vm',
  region: 'eastus',
};
const gcpLocation: VmHostLocation = {
  availabilityZone: 'b',
  cloudId: 'ac-native-vm',
  region: 'us-east1',
};
const lambdaLocation: VmHostLocation = {
  availabilityZone: null,
  cloudId: lambdaId,
  region: 'us-east-1',
};

function profile(
  provider: VmProfile['provider'],
  credential: CloudCredential,
): VmProfile {
  return {
    credential,
    credentialName: `${provider}-test`,
    provider,
    slug: provider.toLowerCase() as VmProfile['slug'],
    vmTypes: ['test-machine'],
  };
}
const awsProfile = profile(CloudType.AWS, {
  accessKeyId: 'AKIA-TEST',
  cloudProvider: CloudType.AWS,
  secretAccessKey: 'aws-secret',
});
const azureProfile = profile(CloudType.Azure, {
  applicationId: 'azure-app',
  cloudProvider: CloudType.Azure,
  directoryId: 'azure-tenant',
  secret: 'azure-secret',
  subscriptionId: 'azure-subscription',
});
const gcpProfile = profile(CloudType.GCP, {
  clientEmail: 'robot@example.iam.gserviceaccount.com',
  cloudProvider: CloudType.GCP,
  privateKey: 'gcp-key',
  projectId: 'gcp-project',
});
const lambdaProfile = profile(CloudType.Lambda, {
  apiKey: 'lambda-secret',
  cloudProvider: CloudType.Lambda,
});

function awsBody(state = 'running') {
  return {
    Reservations: [
      {
        Instances: [
          {
            InstanceId: awsId,
            State: { Name: state },
            Placement: { AvailabilityZone: 'us-east-1b' },
          },
        ],
      },
    ],
  };
}
function azureBody(subscription = 'azure-subscription') {
  return {
    id: `/subscriptions/${subscription}/resourceGroups/anycloud-eastus/providers/Microsoft.Compute/virtualMachines/ac-native-vm`,
    name: 'ac-native-vm',
    resourceGroup: 'anycloud-eastus',
    location: 'eastus',
    provisioningState: 'Succeeded',
    zones: ['1'],
  };
}
function gcpBody(project = 'gcp-project') {
  return {
    name: 'ac-native-vm',
    status: 'RUNNING',
    selfLink: `https://www.googleapis.com/compute/v1/projects/${project}/zones/us-east1-b/instances/ac-native-vm`,
    zone: `https://www.googleapis.com/compute/v1/projects/${project}/zones/us-east1-b`,
  };
}
function lambdaRow(status = 'active', id = lambdaId) {
  return { id, status, region: { name: 'us-east-1' } };
}
const lambdaMissing = {
  status: 404,
  body: {
    error: {
      code: 'global/object-does-not-exist',
      message: 'Instance does not exist',
    },
  },
};
const awsMissing = `An error occurred (InvalidInstanceID.NotFound) when calling the DescribeInstances operation: The instance ID '${awsId}' does not exist`;
const azureMissing =
  "(ResourceNotFound) The Resource 'Microsoft.Compute/virtualMachines/ac-native-vm' under resource group 'anycloud-eastus' was not found.";
const gcpMissing =
  "ERROR: (gcloud.compute.instances.describe) Could not fetch resource:\n - The resource 'projects/gcp-project/zones/us-east1-b/instances/ac-native-vm' was not found";

class RecordingCommands {
  readonly calls: {
    executable: string;
    args: readonly string[];
    options: CommandOptions;
  }[] = [];
  constructor(readonly results: Record<string, unknown> = {}) {}
  async run(
    executable: string,
    args: readonly string[],
    options: CommandOptions = {},
  ) {
    this.calls.push({ executable, args, options });
    const result = this.results[options.label ?? ''];
    return commandResultForTest({
      executable,
      args,
      ...(result === undefined
        ? {}
        : typeof result === 'object' && result !== null && 'exitCode' in result
          ? (result as Partial<CommandResult>)
          : {
              stdout: JSON.stringify(result),
              combined: JSON.stringify(result),
            }),
    });
  }
}
function failed(stderr: string): Partial<CommandResult> {
  return { exitCode: 1, stdout: '', stderr, combined: stderr };
}
const files = {
  directory: async (name: string) => `/tmp/${name}`,
  privateText: async (name: string) => `/tmp/${name}`,
};
const unusedHttp = {
  get: async () => {
    throw new Error('CLI-backed presence issued HTTP');
  },
};
function awsProbe(
  result: unknown,
  artifacts?: ConstructorParameters<typeof PublicCloudVmHostPresenceProbe>[4],
) {
  const commands = new RecordingCommands({
    'aws-observe-vm-host-presence': result,
  });
  return {
    commands,
    probe: new PublicCloudVmHostPresenceProbe(
      awsProfile,
      commands,
      files,
      unusedHttp,
      artifacts,
    ),
  };
}

describe('complete provider identity responses', () => {
  test('keeps only exact AWS instances and distinguishes terminated from releasing', () => {
    expect(awsInstanceStates(awsBody('terminated'), awsId, location)).toEqual([
      'terminated',
    ]);
    expect(interpretAwsHostPresence(['terminated'])).toBe('absent');
    expect(
      interpretAwsHostPresence(awsInstanceStates({ Reservations: [] }, awsId)),
    ).toBe('absent');
    expect(interpretAwsHostPresence(['shutting-down'])).toBe('present');
    expect(interpretAwsHostPresence(['running'])).toBe('present');
  });

  test.each([
    ['missing Instances', { Reservations: [{}] }],
    ['partial reservation', { Reservations: [null] }],
    ['malformed Reservations', { Reservations: 'nope' }],
    ['malformed Instances', { Reservations: [{ Instances: null }] }],
    [
      'foreign identity',
      {
        Reservations: [
          {
            Instances: [
              { InstanceId: 'i-11111111', State: { Name: 'terminated' } },
            ],
          },
        ],
      },
    ],
    [
      'duplicate identity',
      { Reservations: [awsBody().Reservations[0], awsBody().Reservations[0]] },
    ],
    ['unknown state', awsBody('not-a-provider-state')],
    ['partial inventory', { ...awsBody(), NextToken: 'more-results' }],
    ['contradictory error', { Reservations: [], error: 'upstream' }],
  ])('rejects AWS %s instead of fabricating absence', (_name, body) => {
    expect(() => awsInstanceStates(body, awsId)).toThrow(
      VmHostPresenceProtocolError,
    );
  });

  test('rejects malformed requested IDs and foreign original placement before absence', async () => {
    const { probe, commands } = awsProbe({ Reservations: [] });
    await expect(
      probe.observe({ ...location, cloudId: 'i-expected' }),
    ).rejects.toThrow('malformed');
    expect(commands.calls).toHaveLength(0);
    expect(() =>
      awsInstanceStates(awsBody('terminated'), awsId, {
        ...location,
        availabilityZone: 'c',
      }),
    ).toThrow('original placement');
  });

  test.each(['f', '1f', 'us-east-1f'])(
    'accepts the original AWS zone %s while requiring its exact native placement',
    async (availabilityZone) => {
      const original = { ...location, availabilityZone };
      const body = awsBody('terminated');
      body.Reservations[0].Instances[0].Placement.AvailabilityZone =
        'us-east-1f';
      await expect(
        awsProbe(body).probe.observe(original),
      ).resolves.toMatchObject({
        cloudId: awsId,
        provider: CloudType.AWS,
        presence: 'absent',
      });
      await expect(
        awsProbe({ Reservations: [] }).probe.observe(original),
      ).resolves.toMatchObject({ presence: 'absent' });
      await expect(
        awsProbe(awsBody('terminated')).probe.observe(original),
      ).rejects.toThrow('original placement');
    },
  );

  test.each(['', '2f', '01f', '10f', 'us-east-10a', 'us-west-2b'])(
    'rejects unresolved or foreign AWS zone %s before an empty read',
    async (availabilityZone) => {
      const { probe, commands } = awsProbe({ Reservations: [] });
      await expect(
        probe.observe({ ...location, availabilityZone }),
      ).rejects.toThrow('original region');
      expect(commands.calls).toHaveLength(0);
    },
  );

  test.each([false, 0, [], {}])(
    'rejects malformed pagination metadata %j before absence',
    (continuation) => {
      expect(() =>
        awsInstanceStates({ Reservations: [], NextToken: continuation }, awsId),
      ).toThrow(VmHostPresenceProtocolError);
      expect(() =>
        interpretLambdaListHostPresence(
          { status: 200, body: { data: [], page_token: continuation } },
          lambdaId,
        ),
      ).toThrow(VmHostPresenceProtocolError);
    },
  );

  test('retains observations from distinct probes in the same artifact directory', async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), 'native-observation-records-'),
    );
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const artifacts = new ArtifactStore(directory, new Redactor());
    const first = awsProbe({ Reservations: [] }, artifacts).probe;
    const second = awsProbe({ Reservations: [] }, artifacts).probe;
    const locations = [
      location,
      { ...location, cloudId: 'i-11111111111111111' },
    ];
    await Promise.all([
      first.observe(locations[0]),
      second.observe(locations[1]),
    ]);
    const filenames = await readdir(directory);
    expect(filenames).toHaveLength(2);
    const recorded = await Promise.all(
      filenames.map(
        async (name) =>
          JSON.parse(await readFile(path.join(directory, name), 'utf8')) as {
            cloudId: string;
          },
      ),
    );
    expect(recorded.map((record) => record.cloudId).sort()).toEqual(
      locations.map((target) => target.cloudId).sort(),
    );
  });

  test('gives Lambda HTTP error status precedence over a missing-object substring', () => {
    expect(
      interpretLambdaPointHostPresence(
        { status: 500, body: { error: 'upstream object-does-not-exist' } },
        lambdaId,
      ),
    ).toBe('unknown');
    expect(() =>
      interpretLambdaPointHostPresence(
        { status: 401, body: { error: 'object-does-not-exist' } },
        lambdaId,
      ),
    ).toThrow('authentication');
    expect(() =>
      interpretLambdaPointHostPresence(
        { status: 400, body: { error: 'object-does-not-exist' } },
        lambdaId,
      ),
    ).toThrow();
    expect(() =>
      interpretLambdaPointHostPresence({ status: 404, body: null }, lambdaId),
    ).toThrow();
    expect(interpretLambdaPointHostPresence(lambdaMissing, lambdaId)).toBe(
      'absent',
    );
  });

  test.each(['active', 'terminating', 'terminated'])(
    'requires the requested Lambda point ID for %s',
    (status) => {
      expect(
        interpretLambdaPointHostPresence(
          { status: 200, body: { data: lambdaRow(status) } },
          lambdaId,
          'us-east-1',
        ),
      ).toBe(status === 'terminated' ? 'absent' : 'present');
      expect(() =>
        interpretLambdaPointHostPresence(
          { status: 200, body: { data: lambdaRow(status, 'b'.repeat(32)) } },
          lambdaId,
        ),
      ).toThrow('foreign identity');
      expect(() =>
        interpretLambdaPointHostPresence(
          { status: 200, body: { data: lambdaRow(status) } },
          lambdaId,
          'us-west-1',
        ),
      ).toThrow('placement');
    },
  );

  test.each([
    ['malformed row', [null]],
    ['missing identity', [{ status: 'terminated' }]],
    ['missing state', [{ id: lambdaId }]],
    ['unknown state', [lambdaRow('gone')]],
    ['duplicate identity', [lambdaRow('terminated'), lambdaRow('terminated')]],
    [
      'duplicate foreign identity',
      [
        lambdaRow('active', 'b'.repeat(32)),
        lambdaRow('active', 'b'.repeat(32)),
      ],
    ],
  ])('rejects Lambda %s anywhere in its inventory', (_name, data) => {
    expect(() =>
      interpretLambdaListHostPresence(
        { status: 200, body: { data } },
        lambdaId,
      ),
    ).toThrow(VmHostPresenceProtocolError);
  });

  test('requires complete Lambda lists and point/list agreement', () => {
    expect(
      interpretLambdaListHostPresence(
        { status: 200, body: { data: [] } },
        lambdaId,
      ),
    ).toBe('absent');
    expect(
      interpretLambdaListHostPresence(
        { status: 200, body: { data: [lambdaRow('active', 'b'.repeat(32))] } },
        lambdaId,
      ),
    ).toBe('absent');
    expect(
      interpretLambdaListHostPresence(
        { status: 200, body: { data: [lambdaRow('terminating')] } },
        lambdaId,
      ),
    ).toBe('present');
    // Lambda's last page carries `page_token: null`; any other page is partial.
    expect(
      interpretLambdaListHostPresence(
        { status: 200, body: { data: [], page_token: null } },
        lambdaId,
      ),
    ).toBe('absent');
    expect(() =>
      interpretLambdaListHostPresence(
        { status: 200, body: { data: [], page_token: 'more' } },
        lambdaId,
      ),
    ).toThrow('not a complete instance inventory');
    expect(() =>
      interpretLambdaListHostPresence(
        { status: 200, body: { data: [], next_page_token: null } },
        lambdaId,
      ),
    ).toThrow('not a complete instance inventory');
    expect(() =>
      interpretLambdaListHostPresence(
        { status: 200, body: { data: [], error: 'missing' } },
        lambdaId,
      ),
    ).toThrow();
    expect(combineLambdaHostPresence('absent', 'present')).toBe('present');
    expect(combineLambdaHostPresence('absent', 'absent')).toBe('absent');
    expect(combineLambdaHostPresence('unknown', 'absent')).toBe('unknown');
  });
});

describe('native process and credential authority', () => {
  test('binds AWS exact action, original credential, placement and endpoint without raw artifacts', async () => {
    vi.stubEnv('AWS_PROFILE', 'foreign');
    vi.stubEnv('AWS_ENDPOINT_URL_EC2', 'https://foreign.example');
    vi.stubEnv('AWS_WEB_IDENTITY_TOKEN_FILE', '/foreign/token');
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    const { probe, commands } = awsProbe(awsBody());
    await expect(probe.observe(location)).resolves.toEqual({
      cloudId: awsId,
      diagnostic: 'running',
      presence: 'present',
      provider: CloudType.AWS,
    });
    expect(commands.calls[0]).toMatchObject({
      executable: 'aws',
      args: [
        'ec2',
        'describe-instances',
        '--instance-ids',
        awsId,
        '--region',
        'us-east-1',
        '--output',
        'json',
        '--no-cli-pager',
        '--endpoint-url',
        'https://ec2.us-east-1.amazonaws.com',
      ],
      options: {
        recordArtifact: false,
        env: {
          AWS_ACCESS_KEY_ID: 'AKIA-TEST',
          AWS_SECRET_ACCESS_KEY: 'aws-secret',
          AWS_PROFILE: undefined,
          AWS_ENDPOINT_URL_EC2: undefined,
          AWS_WEB_IDENTITY_TOKEN_FILE: undefined,
          AWS_CONFIG_FILE: '/dev/null',
          AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
          AWS_EC2_METADATA_DISABLED: 'true',
        },
      },
    });
  });

  test.each([
    ['AWS', awsProfile, location, 'aws-observe-vm-host-presence', awsMissing],
    [
      'Azure',
      azureProfile,
      azureLocation,
      'azure-observe-vm-host-presence',
      azureMissing,
    ],
    [
      'GCP',
      gcpProfile,
      gcpLocation,
      'gcp-observe-vm-host-presence',
      gcpMissing,
    ],
  ] as const)(
    'accepts only a complete exact %s native NotFound receipt',
    async (_provider, selected, target, label, message) => {
      const commands = new RecordingCommands({ [label]: failed(message) });
      await expect(
        new PublicCloudVmHostPresenceProbe(
          selected,
          commands,
          files,
          unusedHttp,
        ).observe(target),
      ).resolves.toMatchObject({ presence: 'absent' });
      const bad = new RecordingCommands({
        [label]: failed(message.replace(target.cloudId, 'foreign')),
      });
      await expect(
        new PublicCloudVmHostPresenceProbe(
          selected,
          bad,
          files,
          unusedHttp,
        ).observe(target),
      ).rejects.toThrow();
    },
  );

  test.each([
    ['truncated', { outputTruncated: true }],
    ['signal', { signal: 'SIGTERM' }],
    ['null exit', { exitCode: null }],
    ['spawn failure', { spawnError: 'failure' }],
    ['contradictory stdout', { stdout: '{"Reservations":[]}' }],
  ] as const)(
    'rejects a %s CLI receipt that otherwise resembles absence',
    async (_name, fault) => {
      const { probe } = awsProbe({ ...failed(awsMissing), ...fault });
      await expect(probe.observe(location)).rejects.toThrow(
        VmHostPresenceProtocolError,
      );
    },
  );

  test.each([
    'AuthFailure',
    'UnauthorizedOperation',
    'Unable to locate credentials',
    'InvalidInstanceID.Malformed',
  ])('does not hide %s behind NotFound text', async (failure) => {
    const { probe } = awsProbe(failed(`${failure}\n${awsMissing}`));
    await expect(probe.observe(location)).rejects.toThrow(
      VmHostPresenceProtocolError,
    );
  });

  test.each([{ timedOut: true }, { aborted: true }])(
    'does not classify interrupted output as absence: %j',
    async (fault) => {
      const { probe } = awsProbe({ ...failed(awsMissing), ...fault });
      await expect(probe.observe(location)).resolves.toMatchObject({
        presence: 'unknown',
      });
    },
  );

  test('reports a completed throttled request as unknown', async () => {
    const { probe } = awsProbe(
      failed(
        'An error occurred (RequestLimitExceeded) when calling the DescribeInstances operation: rate exceeded',
      ),
    );
    await expect(probe.observe(location)).resolves.toMatchObject({
      presence: 'unknown',
    });
  });

  test.each([
    [
      'Azure',
      azureProfile,
      azureLocation,
      'azure-observe-vm-host-presence',
      azureBody(),
    ],
    ['GCP', gcpProfile, gcpLocation, 'gcp-observe-vm-host-presence', gcpBody()],
  ] as const)(
    'validates the full %s native identity with the original placement',
    async (_name, selected, target, label, body) => {
      const commands = new RecordingCommands({ [label]: body });
      const probe = new PublicCloudVmHostPresenceProbe(
        selected,
        commands,
        files,
        unusedHttp,
      );
      await expect(probe.observe(target)).resolves.toMatchObject({
        presence: 'present',
      });
      await expect(probe.observe(target)).resolves.toMatchObject({
        presence: 'present',
      });
      expect(
        commands.calls.filter(
          (call) =>
            call.options.label?.endsWith('login') ||
            call.options.label?.endsWith('auth'),
        ),
      ).toHaveLength(1);
      expect(
        commands.calls.every((call) => call.options.recordArtifact === false),
      ).toBe(true);
      expect(commands.calls.at(-1)?.args).toEqual(
        expect.arrayContaining(
          _name === 'Azure'
            ? [
                '--subscription',
                'azure-subscription',
                '--resource-group',
                'anycloud-eastus',
                '--name',
                target.cloudId,
              ]
            : [
                '--project=gcp-project',
                '--account=robot@example.iam.gserviceaccount.com',
                '--zone=us-east1-b',
              ],
        ),
      );
      for (const invalidBody of [
        '',
        {},
        { ...body, name: 'foreign' },
        _name === 'Azure'
          ? azureBody('foreign-subscription')
          : gcpBody('foreign-project'),
      ]) {
        const broken = new RecordingCommands({ [label]: invalidBody });
        await expect(
          new PublicCloudVmHostPresenceProbe(
            selected,
            broken,
            files,
            unusedHttp,
          ).observe(target),
        ).rejects.toThrow(VmHostPresenceProtocolError);
      }
    },
  );

  test.each([
    ['Azure', azureProfile, azureLocation, 'azure-host-presence-login'],
    ['GCP', gcpProfile, gcpLocation, 'gcp-host-presence-auth'],
  ] as const)(
    'treats %s authentication and partial auth output as errors before reading',
    async (_name, selected, target, label) => {
      for (const result of [
        failed('Authentication failed'),
        { exitCode: 0, outputTruncated: true },
        { exitCode: null, signal: 'SIGTERM' },
      ]) {
        const commands = new RecordingCommands({ [label]: result });
        await expect(
          new PublicCloudVmHostPresenceProbe(
            selected,
            commands,
            files,
            unusedHttp,
          ).observe(target),
        ).rejects.toThrow(VmHostPresenceProtocolError);
        expect(commands.calls.map((call) => call.options.label)).toEqual([
          label,
        ]);
      }
    },
  );

  test('does not silently change original credentials when caller objects mutate', async () => {
    const credential = {
      cloudProvider: CloudType.AWS as const,
      accessKeyId: 'original-id',
      secretAccessKey: 'original-secret',
    };
    const commands = new RecordingCommands({
      'aws-observe-vm-host-presence': awsBody(),
    });
    const probe = new PublicCloudVmHostPresenceProbe(
      profile(CloudType.AWS, credential),
      commands,
      files,
      unusedHttp,
    );
    credential.secretAccessKey = 'replacement-secret';
    await probe.observe(location);
    expect(commands.calls[0]?.options.env?.AWS_SECRET_ACCESS_KEY).toBe(
      'original-secret',
    );
    expect(
      () =>
        new PublicCloudVmHostPresenceProbe(
          { ...awsProfile, credential: lambdaProfile.credential },
          commands,
          files,
          unusedHttp,
        ),
    ).toThrow('disagree');
  });

  test('isolates concurrent Azure and GCP credential sessions in private directories', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'native-sessions-'));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const selectedFiles = new FixtureFiles(root);
    const sessions = new Map<string, string>();
    const keys = new Map<string, string>();
    const capturedFiles = {
      directory: selectedFiles.directory.bind(selectedFiles),
      privateText: async (name: string, value: string) => {
        const filename = await selectedFiles.privateText(name, value);
        keys.set(
          filename,
          (JSON.parse(value) as { project_id: string }).project_id,
        );
        return filename;
      },
    };
    const run = vi.fn(
      async (
        executable: string,
        args: readonly string[],
        options: CommandOptions = {},
      ) => {
        const directory =
          options.env?.AZURE_CONFIG_DIR ?? options.env?.CLOUDSDK_CONFIG ?? '';
        if (args[0] === 'account') sessions.set(directory, args[3]);
        if (args[0] === 'auth')
          sessions.set(
            directory,
            keys.get(
              args
                .find((arg) => arg.startsWith('--key-file='))!
                .slice('--key-file='.length),
            )!,
          );
        const body =
          args[0] === 'vm'
            ? azureBody(sessions.get(directory))
            : args[0] === 'compute'
              ? gcpBody(sessions.get(directory))
              : undefined;
        return commandResultForTest({
          executable,
          args,
          stdout: body ? JSON.stringify(body) : '',
        });
      },
    );
    const factory = new PublicCloudVmHostPresenceProbeFactory(
      { run },
      capturedFiles,
      unusedHttp,
    );
    const otherAzure = profile(CloudType.Azure, {
      ...(azureProfile.credential as Extract<
        CloudCredential,
        { cloudProvider: CloudType.Azure }
      >),
      subscriptionId: 'other-subscription',
    });
    const otherGcp = profile(CloudType.GCP, {
      ...(gcpProfile.credential as Extract<
        CloudCredential,
        { cloudProvider: CloudType.GCP }
      >),
      projectId: 'other-project',
    });
    const probes = [
      factory.create(azureProfile),
      factory.create(otherAzure),
      factory.create(gcpProfile),
      factory.create(otherGcp),
    ];
    for (let round = 0; round < 2; round++)
      await Promise.all(
        probes.map(async (probe, index) => {
          await expect(
            probe.observe(index < 2 ? azureLocation : gcpLocation),
          ).resolves.toMatchObject({ presence: 'present' });
        }),
      );
    expect(sessions.size).toBe(4);
    for (const directory of sessions.keys())
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
    for (const key of keys.keys())
      expect((await stat(key)).mode & 0o777).toBe(0o600);
    expect(await readdir(path.join(root, 'native-host-presence'))).toHaveLength(
      4,
    );
  });

  test('clears ambient GCP token, impersonation and API endpoint overrides', async () => {
    for (const name of [
      'CLOUDSDK_AUTH_ACCESS_TOKEN',
      'CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT',
      'CLOUDSDK_API_ENDPOINT_OVERRIDES_COMPUTE',
      'GOOGLE_APPLICATION_CREDENTIALS',
    ])
      vi.stubEnv(name, 'foreign');
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    const commands = new RecordingCommands({
      'gcp-observe-vm-host-presence': gcpBody(),
    });
    await new PublicCloudVmHostPresenceProbe(
      gcpProfile,
      commands,
      files,
      unusedHttp,
    ).observe(gcpLocation);
    expect(commands.calls.at(-1)?.options.env).toMatchObject({
      CLOUDSDK_AUTH_ACCESS_TOKEN: undefined,
      CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT: '',
      CLOUDSDK_API_ENDPOINT_OVERRIDES_COMPUTE: undefined,
      GOOGLE_APPLICATION_CREDENTIALS: undefined,
      CLOUDSDK_CORE_UNIVERSE_DOMAIN: 'googleapis.com',
    });
  });

  test('does not authenticate or read when original placement is unavailable', async () => {
    const commands = new RecordingCommands();
    await expect(
      new PublicCloudVmHostPresenceProbe(
        gcpProfile,
        commands,
        files,
        unusedHttp,
      ).observe({ ...gcpLocation, availabilityZone: null }),
    ).rejects.toThrow('availability zone is missing');
    expect(commands.calls).toHaveLength(0);
  });
});

describe('native deadlines, retention and cancellation', () => {
  test('rejects a native receipt from a different command or requested identity', async () => {
    for (const fault of [
      { executable: 'foreign-aws' },
      { args: ['ec2', 'describe-instances', '--instance-ids', 'i-11111111'] },
    ]) {
      const { probe } = awsProbe({ ...failed(awsMissing), ...fault });
      await expect(probe.observe(location)).rejects.toThrow(
        'exact requested native operation',
      );
    }
  });

  test('does not expose authentication arguments from a process transport exception', async () => {
    const run = vi.fn(async () => {
      throw Object.assign(
        new Error('az login --password unregistered-auth-secret'),
        { code: 'EAGAIN' },
      );
    });
    const probe = new PublicCloudVmHostPresenceProbe(
      azureProfile,
      { run },
      files,
      unusedHttp,
    );
    let failure: unknown;
    try {
      await probe.observe(azureLocation);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(VmHostPresenceProtocolError);
    expect(String(failure)).not.toContain('unregistered-auth-secret');
    expect(String(failure)).toMatch(
      /elapsed=\d+ms, aborted=false, error=Error\/EAGAIN\)/u,
    );
  });

  test('spends one remaining deadline across Azure authentication and observation', async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    vi.setSystemTime(new Date('2026-09-18T12:00:00Z'));
    const started = Date.now();
    const budgets: number[] = [];
    const commands = {
      run: async (
        executable: string,
        args: readonly string[],
        options: CommandOptions = {},
      ) => {
        budgets.push(options.timeoutMs!);
        vi.setSystemTime(Date.now() + 100);
        return commandResultForTest({
          executable,
          args,
          stdout: args[0] === 'vm' ? JSON.stringify(azureBody()) : '',
        });
      },
    };
    await new PublicCloudVmHostPresenceProbe(
      azureProfile,
      commands,
      files,
      unusedHttp,
    ).observe(azureLocation, { deadlineAt: started + 500 });
    expect(budgets).toEqual([500, 400, 300]);
  });

  test('cannot start an observation after authentication consumed the remaining deadline', async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const started = Date.now();
    const run = vi.fn(async (executable: string, args: readonly string[]) => {
      vi.setSystemTime(started + 501);
      return commandResultForTest({ executable, args });
    });
    await expect(
      new PublicCloudVmHostPresenceProbe(
        azureProfile,
        { run },
        files,
        unusedHttp,
      ).observe(azureLocation, { deadlineAt: started + 500 }),
    ).rejects.toThrow('deadline');
    expect(run).toHaveBeenCalledTimes(1);
  });

  test('forwards cancellation to pending authentication and never starts a native read', async () => {
    const controller = new AbortController();
    const run = vi.fn(
      async (
        executable: string,
        args: readonly string[],
        options: CommandOptions = {},
      ) => {
        controller.abort(new Error('cancel original observation'));
        expect(options.signal?.aborted).toBe(true);
        return commandResultForTest({
          executable,
          args,
          aborted: true,
          exitCode: null,
        });
      },
    );
    await expect(
      new PublicCloudVmHostPresenceProbe(
        azureProfile,
        { run },
        files,
        unusedHttp,
      ).observe(azureLocation, { signal: controller.signal }),
    ).rejects.toThrow();
    expect(run).toHaveBeenCalledTimes(1);
  });

  test.each([
    { profile: azureProfile, location: azureLocation },
    { profile: gcpProfile, location: gcpLocation },
  ])(
    'bounds stalled $profile.provider authentication by the caller deadline',
    async ({ profile, location }) => {
      let signal: AbortSignal | undefined;
      const run = vi.fn(
        (
          _executable: string,
          _args: readonly string[],
          options: CommandOptions = {},
        ) => {
          signal = options.signal;
          return new Promise<CommandResult>(() => {});
        },
      );
      const observation = new PublicCloudVmHostPresenceProbe(
        profile,
        { run },
        files,
        unusedHttp,
      ).observe(location, { deadlineAt: Date.now() + 25 });
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      try {
        expect(
          await Promise.race([
            observation.then(
              () => 'unexpected success',
              () => 'request rejected',
            ),
            new Promise<string>((resolve) => {
              watchdog = setTimeout(
                () => resolve('authentication still pending'),
                1_000,
              );
            }),
          ]),
        ).toBe('request rejected');
        expect(signal?.aborted).toBe(true);
        expect(run).toHaveBeenCalledTimes(1);
      } finally {
        clearTimeout(watchdog);
      }
    },
  );

  test('bounds Lambda point/list reads by the same remaining deadline and rejects redirects', async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const deadlineAt = Date.now() + 500;
    const budgets: number[] = [];
    const get = vi.fn(async (_label, _url, options) => {
      expect(options.redirect).toBe('error');
      expect(options.deadlineAt).toBe(deadlineAt);
      budgets.push(options.timeoutMs);
      vi.setSystemTime(Date.now() + 100);
      return budgets.length === 1
        ? lambdaMissing
        : { status: 200, body: { data: [] } };
    });
    await expect(
      new PublicCloudVmHostPresenceProbe(
        lambdaProfile,
        new RecordingCommands(),
        files,
        { get },
      ).observe(lambdaLocation, { deadlineAt }),
    ).resolves.toMatchObject({ presence: 'unknown' });
    expect(budgets).toEqual([500, 400]);
    get.mockRejectedValue(new TargetHttpProtocolError('redirect refused'));
    await expect(
      new PublicCloudVmHostPresenceProbe(
        lambdaProfile,
        new RecordingCommands(),
        files,
        { get },
      ).observe(lambdaLocation),
    ).rejects.toThrow('redirect');
  });

  test('types an expired native deadline while preserving caller cancellation', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const cancellation = new AbortController();
    const cancelled = new Error('Original cleanup scope was cancelled');
    const get = vi.fn(async () => {
      vi.setSystemTime(Date.now() + 30_000);
      return lambdaMissing;
    });
    const probe = new PublicCloudVmHostPresenceProbe(
      lambdaProfile,
      new RecordingCommands(),
      files,
      { get },
    );
    await expect(probe.observe(lambdaLocation)).rejects.toBeInstanceOf(
      VmHostPresenceDeadlineError,
    );
    get.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 30_000);
      cancellation.abort(cancelled);
      return lambdaMissing;
    });
    await expect(
      probe.observe(lambdaLocation, { signal: cancellation.signal }),
    ).rejects.toBe(cancelled);
    expect(get).toHaveBeenCalledTimes(2);
  });

  test('retains only validated metadata, including when provider payloads contain unrelated credentials', async () => {
    const retained: unknown[] = [];
    const artifacts = {
      json: async (_name: string, value: unknown) => {
        retained.push(value);
        return 'artifact';
      },
    };
    const body = {
      data: {
        ...lambdaRow(),
        jupyter_token: 'unrelated-notebook-secret',
        secret: 'unregistered-provider-secret',
      },
    };
    const probe = new PublicCloudVmHostPresenceProbe(
      lambdaProfile,
      new RecordingCommands(),
      files,
      { get: async () => ({ status: 200, body }) },
      artifacts,
    );
    await probe.observe(lambdaLocation);
    expect(retained).toEqual([
      {
        cloudId: lambdaId,
        diagnostic: 'exact instance present',
        presence: 'present',
        provider: CloudType.Lambda,
        region: 'us-east-1',
        availabilityZone: null,
      },
    ]);
    const broken = awsProbe(
      { ...failed(awsMissing), stdout: 'unregistered-process-secret' },
      artifacts,
    );
    await expect(broken.probe.observe(location)).rejects.toThrow();
    expect(JSON.stringify(retained)).not.toMatch(/secret|token|credential/u);
    expect(broken.commands.calls[0]?.options.recordArtifact).toBe(false);
  });

  test('keeps Lambda present until point/list views agree stably for ten seconds, resetting after failure', async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    let inventory: unknown[] = [lambdaRow('terminating')];
    let fail = false;
    const probe = new PublicCloudVmHostPresenceProbe(
      lambdaProfile,
      new RecordingCommands(),
      files,
      {
        get: async (label) => {
          if (fail) throw new Error('network failure');
          return label === 'lambda-vm-host-presence'
            ? lambdaMissing
            : { status: 200, body: { data: inventory } };
        },
      },
    );
    await expect(probe.observe(lambdaLocation)).resolves.toMatchObject({
      presence: 'present',
    });
    inventory = [];
    await expect(probe.observe(lambdaLocation)).resolves.toMatchObject({
      presence: 'unknown',
    });
    vi.setSystemTime(Date.now() + 9_999);
    await expect(probe.observe(lambdaLocation)).resolves.toMatchObject({
      presence: 'unknown',
    });
    vi.setSystemTime(Date.now() + 1);
    await expect(probe.observe(lambdaLocation)).resolves.toMatchObject({
      presence: 'absent',
    });
    fail = true;
    await expect(probe.observe(lambdaLocation)).resolves.toMatchObject({
      presence: 'unknown',
    });
    fail = false;
    await expect(probe.observe(lambdaLocation)).resolves.toMatchObject({
      presence: 'unknown',
    });
  });
});

function reservationLocation(
  cloudId: string,
  region: string | null = null,
  availabilityZone: string | null = null,
): VmHostLocation {
  return { cloudId, region, availabilityZone };
}

describe('boot disk absence after the VM is gone', () => {
  const owner = 'j-disk-owner';
  const azureDisk = (name: string, group = 'anycloud-eastus') => ({
    id: `/subscriptions/azure-subscription/resourceGroups/${group}/providers/Microsoft.Compute/disks/${name}`,
    name,
  });
  const awsVolume = (value = owner) => ({
    VolumeId: 'vol-0123456789abcdef0',
    Tags: [{ Key: 'anycloud_deployment', Value: value }],
  });
  const gcpDisk = (zone = 'us-east1-b') => ({
    name: 'ac-native-vm',
    selfLink: `https://www.googleapis.com/compute/v1/projects/gcp-project/zones/${zone}/disks/ac-native-vm`,
  });
  // Each cloud: the VM read, a leaked disk, absent disk answers and a foreign one.
  const cases = [
    {
      name: 'AWS',
      selected: awsProfile,
      target: location,
      host: [failed(awsMissing), awsBody()],
      leaked: { Volumes: [awsVolume()] },
      gone: [{ Volumes: [] }],
      foreign: [
        { Volumes: [awsVolume('other')] },
        { Volumes: [], NextToken: 'x' },
      ],
      args: [
        'describe-volumes',
        JSON.stringify([{ Name: 'tag:anycloud_deployment', Values: [owner] }]),
        'us-east-1',
      ],
    },
    {
      name: 'Azure',
      selected: azureProfile,
      target: azureLocation,
      host: [failed(azureMissing), azureBody()],
      leaked: [azureDisk('ac-native-vm_OsDisk_1_0123abcd')],
      gone: [
        [azureDisk('ac-native-vm2_OsDisk_1_0123abcd')],
        failed(
          "(ResourceGroupNotFound) Resource group 'anycloud-eastus' could not be found.",
        ),
      ],
      foreign: [[azureDisk('ac-native-vm_OsDisk_1_0123abcd', 'foreign')]],
      args: ['disk', 'list', '--resource-group', 'anycloud-eastus'],
    },
    {
      name: 'GCP',
      selected: gcpProfile,
      target: gcpLocation,
      host: [failed(gcpMissing), gcpBody()],
      leaked: [gcpDisk()],
      // A list answers a missing disk with `[]`; e2e-job run 37823759546 showed
      // describe's one-line not-found stderr also matches the auth pattern.
      gone: [[]],
      foreign: [
        [gcpDisk('us-east1-c')],
        [{ ...gcpDisk(), name: 'ac-native-vm2' }],
        gcpDisk(),
      ],
      args: [
        'disks',
        'list',
        '--zones=us-east1-b',
        '--filter=name=ac-native-vm',
      ],
    },
  ];
  const observe = (
    { name, selected, target }: (typeof cases)[number],
    host: unknown,
    disk?: unknown,
    options: { bootDiskOwner?: string } = { bootDiskOwner: owner },
  ) => {
    const slug = name.toLowerCase();
    const commands = new RecordingCommands({
      [`${slug}-observe-vm-host-presence`]: host,
      [`${slug}-observe-boot-disk-presence`]: disk,
    });
    const probe = new PublicCloudVmHostPresenceProbe(
      selected,
      commands,
      files,
      unusedHttp,
    );
    return {
      result: probe.observe(target, options),
      diskCalls: () =>
        commands.calls.filter(({ options }) =>
          options.label?.endsWith('boot-disk-presence'),
        ),
    };
  };

  test.each(cases)(
    'keeps an absent $name VM present while its boot disk remains',
    async (selected) => {
      const leak = observe(selected, selected.host[0], selected.leaked);
      await expect(leak.result).resolves.toMatchObject({
        cloudId: selected.target.cloudId,
        presence: 'present',
      });
      expect(leak.diskCalls()[0].args).toEqual(
        expect.arrayContaining(selected.args),
      );
      for (const disk of selected.gone)
        await expect(
          observe(selected, selected.host[0], disk).result,
        ).resolves.toMatchObject({ presence: 'absent' });
    },
  );

  test.each(cases)(
    'reads no $name disk while the VM is present or when the caller does not ask',
    async (selected) => {
      for (const read of [
        observe(selected, selected.host[1]),
        observe(selected, selected.host[0], undefined, {}),
      ]) {
        await read.result;
        expect(read.diskCalls()).toEqual([]);
      }
    },
  );

  test.each(cases)(
    'never turns a rejected, foreign or throttled $name disk read into absence',
    async (selected) => {
      for (const disk of [
        failed('AuthorizationFailed: denied'),
        ...selected.foreign,
      ])
        await expect(
          observe(selected, selected.host[0], disk).result,
        ).rejects.toThrow(VmHostPresenceProtocolError);
      await expect(
        observe(selected, selected.host[0], failed('Throttling: slow down'))
          .result,
      ).resolves.toMatchObject({ presence: 'unknown' });
    },
  );
});

test('unsupported reservation observers fail without treating reservations as native IDs', async () => {
  const get = vi.fn<TargetHttpClient['get']>();
  const commands = { run: vi.fn() };
  const probe = new PublicCloudVmHostPresenceProbe(
    lambdaProfile,
    commands,
    { directory: vi.fn(), privateText: vi.fn() },
    { get },
  );
  await expect(
    probe.observeReservations([reservationLocation('owned-vm-0')]),
  ).rejects.toThrow('provider cannot observe reserved VM identities');
  expect(get).not.toHaveBeenCalled();
  expect(commands.run).not.toHaveBeenCalled();
});

describe('AWS reservation inventory through the shared native observer', () => {
  const attemptId = 'd-gpu-owned-0';
  const reservation = reservationLocation(attemptId, 'us-east-1');
  const secondId = 'i-fedcba98765432100';

  function inventory(instances: unknown[] = [], nextToken?: unknown) {
    return {
      Reservations: instances.length ? [{ Instances: instances }] : [],
      ...(nextToken === undefined ? {} : { NextToken: nextToken }),
    };
  }

  function instance(overrides: Record<string, unknown> = {}) {
    return {
      InstanceId: awsId,
      ClientToken: attemptId,
      State: { Name: 'running' },
      Placement: { AvailabilityZone: 'us-east-1b' },
      ...overrides,
    };
  }

  function harness() {
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    onTestFinished(() => clock.mockRestore());
    const original = structuredClone(awsProfile);
    const commands = new RecordingCommands({
      'aws-observe-vm-reservation-presence': inventory(),
    });
    const execute = commands.run.bind(commands);
    const run = vi.spyOn(commands, 'run');
    const probe = new PublicCloudVmHostPresenceProbe(
      original,
      commands,
      files,
      unusedHttp,
    );
    return {
      commands,
      original,
      probe,
      run,
      execute,
      advance: (ms: number) => {
        now += ms;
      },
      respond: (body: unknown) => {
        commands.results['aws-observe-vm-reservation-presence'] = body;
      },
    };
  }

  test('binds exact tokens to original region and immutable credentials, with two complete empty inventories ten seconds apart', async () => {
    const h = harness();
    if (h.original.credential.cloudProvider !== CloudType.AWS)
      throw new Error('test credential');
    h.original.credential.accessKeyId = 'replacement-access';
    h.original.credential.secretAccessKey = 'replacement-secret';
    Object.assign(h.original, { region: 'us-west-2' });
    vi.stubEnv('AWS_ENDPOINT_URL_EC2', 'https://foreign.invalid');
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    const first = await h.probe.observeReservations([reservation]);
    expect(first.attempts[0]?.presence).toBe('unknown');
    h.advance(9_999);
    expect(
      (await h.probe.observeReservations([reservation])).attempts[0]?.presence,
    ).toBe('unknown');
    h.advance(1);
    expect(await h.probe.observeReservations([reservation])).toMatchObject({
      kind: 'exact-attempt-current-presence',
      provider: CloudType.AWS,
      credentialName: 'AWS-test',
      inventory: { pages: 1, instances: 0, complete: true },
      attempts: [
        {
          attemptId,
          region: 'us-east-1',
          availabilityZone: null,
          presence: 'absent',
          instanceIds: [],
        },
      ],
    });
    expect(h.commands.calls[0]?.args).toEqual([
      'ec2',
      'describe-instances',
      '--filters',
      JSON.stringify([{ Name: 'client-token', Values: [attemptId] }]),
      '--no-paginate',
      '--max-results',
      '100',
      '--region',
      'us-east-1',
      '--output',
      'json',
      '--no-cli-pager',
      '--endpoint-url',
      'https://ec2.us-east-1.amazonaws.com',
    ]);
    expect(h.commands.calls[0]?.options).toMatchObject({
      env: {
        AWS_ACCESS_KEY_ID: 'AKIA-TEST',
        AWS_SECRET_ACCESS_KEY: 'aws-secret',
        AWS_ENDPOINT_URL_EC2: undefined,
        AWS_CONFIG_FILE: '/dev/null',
        AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
        AWS_EC2_METADATA_DISABLED: 'true',
        AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true',
      },
      recordArtifact: false,
    });
    expect(JSON.stringify(first)).not.toContain('secret');
  });

  test('does not transfer absence agreement across original regions or zones', async () => {
    const h = harness();
    await h.probe.observeReservations([reservation]);
    h.advance(10_000);
    expect(
      (
        await h.probe.observeReservations([
          { ...reservation, region: 'us-east-2' },
          { ...reservation, availabilityZone: '1b' },
        ])
      ).attempts.map((attempt) => attempt.presence),
    ).toEqual(['unknown', 'unknown']);
    expect(
      h.commands.calls
        .slice(1)
        .map((call) => call.args[call.args.indexOf('--region') + 1]),
    ).toEqual(['us-east-2', 'us-east-1']);
  });

  test.each(['pending', 'running', 'shutting-down', 'terminated', 'stopped'])(
    'retains a %s token match regardless of mutable tags for native ledger reconciliation',
    async (state) => {
      const h = harness();
      h.respond(
        inventory([
          instance({
            State: { Name: state },
            Tags: [{ Key: 'Name', Value: 'foreign-name' }],
            Secret: 'unvalidated-canary',
          }),
        ]),
      );
      const result = await h.probe.observeReservations([reservation]);
      expect(result.attempts).toEqual([
        {
          attemptId,
          region: 'us-east-1',
          availabilityZone: null,
          presence: 'present',
          instanceIds: [awsId],
        },
      ]);
      expect(JSON.stringify(result)).not.toContain('unvalidated-canary');
      expect(JSON.stringify(result)).not.toContain('foreign-name');
    },
  );

  test('reads every page and retains exact IDs before requesting a later page', async () => {
    const h = harness();
    const partial = vi.fn();
    h.respond(inventory([instance()], 'next-page'));
    const run = h.execute;
    h.run
      .mockImplementationOnce(run)
      .mockImplementationOnce(async (executable, args, options) => {
        expect(partial).toHaveBeenCalledWith(
          expect.objectContaining({
            inventory: { pages: 1, instances: 1, complete: false },
            attempts: [expect.objectContaining({ instanceIds: [awsId] })],
          }),
        );
        expect(
          args.slice(
            args.indexOf('--next-token'),
            args.indexOf('--next-token') + 2,
          ),
        ).toEqual(['--next-token', 'next-page']);
        h.respond(inventory([instance({ InstanceId: secondId })]));
        return run(executable, args, options);
      });
    const result = await h.probe.observeReservations([reservation], {
      onPartialObservation: partial,
    });
    expect(result.inventory).toEqual({
      pages: 2,
      instances: 2,
      complete: true,
    });
    expect(result.attempts[0]?.instanceIds).toEqual([awsId, secondId]);
    expect(partial).toHaveBeenCalledTimes(2);
  });

  test.each([
    'authentication',
    'transient',
    'truncated',
    'foreign token',
    'cancellation',
  ] as const)(
    'retains validated first-page matches when a later page has %s',
    async (failure) => {
      const h = harness();
      const controller = new AbortController();
      const partial = vi.fn();
      h.respond(inventory([instance()], 'next-page'));
      const run = h.execute;
      h.run
        .mockImplementationOnce(run)
        .mockImplementationOnce(async (executable, args, options) => {
          expect(partial).toHaveBeenCalledOnce();
          if (failure === 'cancellation') {
            controller.abort(new Error('teardown stopped'));
            return new Promise(() => {});
          }
          h.respond(
            failure === 'authentication'
              ? failed('AuthFailure: synthetic-secret')
              : failure === 'transient'
                ? failed('RequestLimitExceeded')
                : failure === 'truncated'
                  ? { stdout: '{}', outputTruncated: true, exitCode: 0 }
                  : inventory([
                      instance({
                        InstanceId: secondId,
                        ClientToken: 'foreign-0',
                      }),
                    ]),
          );
          return run(executable, args, options);
        });
      const pending = h.probe.observeReservations([reservation], {
        onPartialObservation: partial,
        signal: controller.signal,
      });
      if (failure === 'transient')
        expect(await pending).toMatchObject({
          inventory: { complete: false },
          attempts: [{ presence: 'present', instanceIds: [awsId] }],
        });
      else await expect(pending).rejects.toThrow();
      expect(partial.mock.calls[0]?.[0]).toMatchObject({
        inventory: { pages: 1, instances: 1, complete: false },
        attempts: [{ attemptId, region: 'us-east-1', instanceIds: [awsId] }],
      });
      expect(JSON.stringify(partial.mock.calls)).not.toContain(
        'synthetic-secret',
      );
    },
  );

  test.each(['present', 'throttled', 'malformed'] as const)(
    '%s inventory resets absence agreement',
    async (interruption) => {
      const h = harness();
      await h.probe.observeReservations([reservation]);
      h.advance(10_000);
      h.respond(
        interruption === 'present'
          ? inventory([instance()])
          : interruption === 'throttled'
            ? failed('RequestLimitExceeded')
            : { Reservations: null },
      );
      if (interruption === 'malformed')
        await expect(
          h.probe.observeReservations([reservation]),
        ).rejects.toThrow();
      else
        expect(
          (await h.probe.observeReservations([reservation])).attempts[0]
            ?.presence,
        ).toBe(interruption === 'present' ? 'present' : 'unknown');
      h.respond(inventory());
      expect(
        (await h.probe.observeReservations([reservation])).attempts[0]
          ?.presence,
      ).toBe('unknown');
      h.advance(10_000);
      expect(
        (await h.probe.observeReservations([reservation])).attempts[0]
          ?.presence,
      ).toBe('absent');
    },
  );

  test.each([
    ['foreign token', inventory([instance({ ClientToken: 'foreign-0' })])],
    ['missing token', inventory([instance({ ClientToken: undefined })])],
    [
      'malformed native ID',
      inventory([instance({ InstanceId: 'request-token' })]),
    ],
    [
      'foreign region',
      inventory([instance({ Placement: { AvailabilityZone: 'us-east-2b' } })]),
    ],
    ['missing placement', inventory([instance({ Placement: undefined })])],
    ['unknown state', inventory([instance({ State: { Name: 'deleted' } })])],
    ['missing state', inventory([instance({ State: undefined })])],
    ['duplicate ID', inventory([instance(), instance()])],
    ['missing instances', { Reservations: [{}] }],
    ['error envelope', { Reservations: [], Errors: [] }],
    ['explicit truncation', { Reservations: [], truncated: true }],
    ['malformed cursor', inventory([], 10)],
    ['empty cursor', inventory([], '')],
  ])('rejects %s without minting absence', async (_label, body) => {
    const h = harness();
    h.respond(body);
    await expect(
      h.probe.observeReservations([reservation]),
    ).rejects.toBeInstanceOf(VmHostPresenceProtocolError);
  });

  test('requires original zone agreement even when the token and region match', async () => {
    const h = harness();
    h.respond(inventory([instance()]));
    await expect(
      h.probe.observeReservations([{ ...reservation, availabilityZone: '1a' }]),
    ).rejects.toThrow('foreign, duplicate, or malformed instance');
  });

  test.each(['duplicate identity', 'repeated cursor'] as const)(
    'rejects pagination with %s',
    async (fault) => {
      const h = harness();
      h.respond(inventory([instance()], 'page-2'));
      const run = h.execute;
      h.run
        .mockImplementationOnce(run)
        .mockImplementationOnce(async (executable, args, options) => {
          h.respond(
            inventory(
              [
                instance({
                  InstanceId: fault === 'duplicate identity' ? awsId : secondId,
                }),
              ],
              fault === 'repeated cursor' ? 'page-2' : undefined,
            ),
          );
          return run(executable, args, options);
        });
      await expect(
        h.probe.observeReservations([reservation]),
      ).rejects.toBeInstanceOf(VmHostPresenceProtocolError);
      expect(h.run).toHaveBeenCalledTimes(2);
    },
  );

  test('bounds pagination with continually changing cursors', async () => {
    const h = harness();
    const run = h.execute;
    let count = 0;
    h.run.mockImplementation(async (executable, args, options) => {
      h.respond(inventory([], `cursor-${++count}`));
      return run(executable, args, options);
    });
    await expect(h.probe.observeReservations([reservation])).rejects.toThrow(
      'page bound',
    );
    expect(h.run).toHaveBeenCalledTimes(100);
  });

  test.each([
    [],
    [reservation, reservation],
    [{ ...reservation, region: null }],
    [{ ...reservation, region: 'not-a-region' }],
    [{ ...reservation, cloudId: awsId }],
    [{ ...reservation, cloudId: 'foreign|a=attempt-0' }],
    [{ ...reservation, availabilityZone: 'us-east-2b' }],
  ])(
    'rejects invalid original scope %j before any provider read',
    async (...attempts) => {
      const h = harness();
      await expect(
        h.probe.observeReservations(attempts),
      ).rejects.toBeInstanceOf(VmHostPresenceProtocolError);
      expect(h.run).not.toHaveBeenCalled();
    },
  );
});

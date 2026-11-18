/**
 * The release-built CLI's `api create --cloud <c> --json` (the seed, RFC
 * 0049 C26 (e)) against fake `aws` and `az` on PATH (S1's fake-CLI kit):
 * it discovers the account and checks the rights through the user's CLI,
 * then submits the installation under its seed name. The fake refuses the
 * submission, so the one `--json` document is the error. Runs
 * `release/build-binaries.sh`'s linux-x64 output, or `ANYCLOUD_CLI_BINARY`.
 * GCP's rights check goes to Resource Manager over HTTP, so a local server
 * stands in for it (`GCP_RESOURCE_MANAGER_ENDPOINT`).
 */
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { SEED_RIGHTS } from '../../src/cli/seed/accounts.js';
import {
  installFakeCloudClis,
  type FakeCloudClis,
  type FakeCliResponder,
} from '../helpers/fake-cloud-cli.js';

const cli = process.env.ANYCLOUD_CLI_BINARY ?? 'binaries/anycloud-linux-x64';

const SUBSCRIPTION = 'abcdef12-3456-7890-abcd-ef1234567890';

const cases: {
  cloud: 'aws' | 'azure' | 'gcp';
  region: string;
  vmType: string;
  responders: Partial<Record<'aws' | 'az' | 'gcloud', FakeCliResponder[]>>;
  /** The submission (a write, never a read), naming the installation by its seed name. */
  submitted: (args: readonly string[]) => boolean;
}[] = [
  {
    cloud: 'aws',
    region: 'us-east-1',
    vmType: 't3.medium',
    responders: {
      aws: [
        {
          match: ['sts', 'get-caller-identity'],
          stdout: {
            Account: '123456789012',
            Arn: 'arn:aws:iam::123456789012:user/ops',
          },
        },
        {
          match: ['iam', 'simulate-principal-policy'],
          stdout: {
            EvaluationResults: SEED_RIGHTS.aws.map((name) => ({
              EvalActionName: name,
              EvalDecision: 'allowed',
            })),
          },
        },
      ],
    },
    submitted: (args) =>
      args[0] === 'cloudformation' &&
      ['deploy', 'create-change-set'].includes(args[1] ?? '') &&
      (args[args.indexOf('--stack-name') + 1] ?? '').startsWith('anycloud-'),
  },
  {
    cloud: 'azure',
    region: 'eastus',
    vmType: 'Standard_D2s_v5',
    responders: {
      az: [
        {
          match: ['account', 'show'],
          stdout: { id: SUBSCRIPTION, user: { name: 'ops@example.com' } },
        },
        {
          match: ['rest', '--method', 'get'],
          stdout: { value: [{ actions: ['*'], notActions: [] }] },
        },
      ],
    },
    submitted: (args) =>
      (args.slice(0, 2).join(' ') === 'group create' ||
        args.slice(0, 3).join(' ') === 'deployment group create') &&
      args.some((arg) => arg.startsWith('anycloud-')),
  },
  {
    cloud: 'gcp',
    region: 'us-central1',
    vmType: 'e2-standard-2',
    responders: {
      gcloud: [
        { match: ['config', 'get', 'project'], stdout: 'proj-smoke\n' },
        { match: ['auth', 'print-access-token'], stdout: 'smoke-token\n' },
        { match: ['config', 'get', 'account'], stdout: 'ops@example.com\n' },
      ],
    },
    submitted: (args) =>
      args.slice(0, 3).join(' ') === 'compute instances create' &&
      (args[3] ?? '').startsWith('anycloud-cluster-'),
  },
];

/**
 * A local server for what the CLI asks over HTTP before the cloud: GitHub's
 * `/user` (the caller, `ANYCLOUD_GITHUB_URL` under `IS_TEST`) and Resource
 * Manager's testIamPermissions, granting what it is asked for.
 */
async function resourceManager(): Promise<{ url: string; close(): void }> {
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      if (request.url === '/user') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id: 1, login: 'smoke' }));
        return;
      }
      const { permissions = [] } = JSON.parse(body || '{}') as {
        permissions?: string[];
      };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ permissions }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => server.close(),
  };
}

describe('compiled seed cluster create', () => {
  let clis: FakeCloudClis | undefined;
  let home: string | undefined;
  afterEach(() => {
    clis?.cleanup();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it.each(cases)(
    "creates on $cloud through the user's CLI: discovery, rights, then the installation under its seed name, with one --json document",
    async ({ cloud, region, vmType, responders, submitted }) => {
      clis = installFakeCloudClis(responders);
      home = mkdtempSync(join(tmpdir(), 'cli-seed-smoke-'));
      const rights = await resourceManager();
      onTestFinished(() => rights.close());
      const result = await promisify(execFile)(
        cli,
        [
          'cluster',
          'create',
          'smoke',
          '--cloud',
          cloud,
          '--region',
          region,
          '--vm-type',
          vmType,
          '--json',
        ],
        {
          env: {
            PATH: clis.env.PATH,
            HOME: home,
            ANYCLOUD_DIR: join(home, '.anycloud'),
            GITHUB_TOKEN: 'smoke-token',
            GCP_RESOURCE_MANAGER_ENDPOINT: rights.url,
            IS_TEST: 'true',
            ANYCLOUD_GITHUB_URL: rights.url,
            // Every other route goes to a closed port: no cloud, no metadata
            // service, no local API.
            HTTPS_PROXY: 'http://127.0.0.1:9',
            HTTP_PROXY: 'http://127.0.0.1:9',
            NO_PROXY: '127.0.0.1',
            AWS_EC2_METADATA_DISABLED: 'true',
          },
        },
      ).catch(
        (error: { code: number; stdout: string; stderr: string }) => error,
      );
      // The fake refuses the submission: a refused run, not a usage error.
      expect('code' in result ? result.code : 0).toBe(1);
      const lines = result.stdout.trim().split('\n');
      expect(lines, result.stderr).toHaveLength(1);
      const document = JSON.parse(lines[0] ?? '') as {
        error?: { code?: unknown; message?: unknown };
      };
      expect(typeof document.error?.code).toBe('string');
      expect(typeof document.error?.message).toBe('string');
      const calls = clis
        .calls()
        .map(({ cli: name, args }) => [name, ...args].join(' '));
      expect(calls[0]).toMatch(
        /^(aws sts get-caller-identity|az account show|gcloud config get project)/,
      );
      if (cloud !== 'gcp')
        expect(calls).toContainEqual(
          expect.stringMatching(/simulate-principal-policy|^az rest/),
        );
      expect(clis.calls().some(({ args }) => submitted(args))).toBe(true);
    },
  );
});

/**
 * The `role-apply` live check: on the hosted API, for each of
 * AWS, GCP and Azure, `credentials new --role --apply` through the runner's
 * signed-in cloud CLI, the same again (it converges), then
 * `credentials delete --apply`, and the cloud's own CLI shows it all gone.
 * GCP uses the run's own `ANYCLOUD_ROLE_*` IDs, since deleted ones are kept.
 */
import assert from 'node:assert/strict';

import { completedCommand } from '../../api-assertions.js';
import type { ArtifactStore } from '../../artifacts.js';
import type { CleanupStack } from '../../cleanup.js';
import type { ProcessRunner } from '../../process.js';
import type { CommandResult } from '../../types.js';

export interface RoleApplyCheckOptions {
  /** The CLI against the hosted API. */
  readonly send: (
    args: readonly string[],
    label: string,
    timeoutMs: number,
  ) => Promise<CommandResult>;
  readonly runner: Pick<ProcessRunner, 'run'>;
  readonly artifacts: Pick<ArtifactStore, 'json'>;
  readonly cleanup: Pick<CleanupStack, 'defer'>;
  readonly env: NodeJS.ProcessEnv;
}

const APPLY_MS = 20 * 60_000;

const required = (env: NodeJS.ProcessEnv, name: string) => {
  const value = env[name];
  assert.ok(value, `role-apply needs ${name}`);
  return value;
};

/** Each cloud's flags, and how its CLI shows the setup gone. */
function clouds(env: NodeJS.ProcessEnv) {
  const project = required(env, 'GCP_PROJECT_ID');
  const subscription = required(env, 'AZURE_SUBSCRIPTION_ID');
  const pool = required(env, 'ANYCLOUD_ROLE_POOL');
  const provider = required(env, 'ANYCLOUD_ROLE_PROVIDER');
  const account = `${required(env, 'ANYCLOUD_ROLE_SERVICE_ACCOUNT')}@${project}.iam.gserviceaccount.com`;
  return [
    {
      cloud: 'aws',
      flags: [],
      gone: (apiHost: string) => [
        [
          'aws',
          [
            'cloudformation',
            'describe-stacks',
            '--stack-name',
            `anycloud-role-${apiHost.replace(/[^A-Za-z0-9-]/g, '-')}`,
          ],
          /does not exist/,
        ] as const,
      ],
    },
    {
      cloud: 'gcp',
      flags: ['--project-id', project],
      gone: () => [
        [
          'gcloud',
          [
            'iam',
            'workload-identity-pools',
            'providers',
            'describe',
            provider,
            '--workload-identity-pool',
            pool,
            '--location=global',
            `--project=${project}`,
            '--format=value(state)',
          ],
          /^DELETED$|NOT_FOUND/,
        ] as const,
        [
          'gcloud',
          [
            'iam',
            'service-accounts',
            'describe',
            account,
            `--project=${project}`,
          ],
          // A deleted account reads as denied "(or it may not exist)"; the
          // preflight showed CI holds iam.serviceAccounts.get.
          /NOT_FOUND|denied on resource \(or it may not exist\)/,
        ] as const,
      ],
    },
    {
      cloud: 'azure',
      flags: ['--subscription-id', subscription],
      gone: () => [
        [
          'az',
          [
            'group',
            'exists',
            '--name',
            'anycloud-role',
            '--subscription',
            subscription,
          ],
          /^false$/,
        ] as const,
        [
          'az',
          [
            'deployment',
            'sub',
            'show',
            '--name',
            'anycloud-role',
            '--subscription',
            subscription,
          ],
          /DeploymentNotFound/,
        ] as const,
      ],
    },
  ];
}

const json = (result: CommandResult, label: string) =>
  JSON.parse(completedCommand(result, label)) as Record<string, unknown>;

export async function roleApplyCheck(
  options: RoleApplyCheckOptions,
  apiUrl: string,
): Promise<void> {
  const apiHost = new URL(apiUrl).hostname;
  const records: Record<string, unknown> = {};
  for (const { cloud, flags, gone } of clouds(options.env)) {
    const name = `e2e-role-${cloud}`;
    const create = [
      'credentials',
      'new',
      name,
      '--provider',
      cloud,
      '--role',
      '--apply',
      '--json',
      ...flags,
    ];
    // Torn down even when the check fails part way.
    const owed = options.cleanup.defer(`role-apply ${cloud}`, async () => {
      await options.send(
        ['credentials', 'delete', name, '--apply', '--json', '--force'],
        `role-delete-${cloud}-cleanup`,
        APPLY_MS,
      );
    });
    const first = json(
      await options.send(create, `role-apply-${cloud}`, APPLY_MS),
      `credentials new --role --apply (${cloud})`,
    );
    assert.equal(first.name, name);
    assert.ok(first.account, `${cloud}: the result names its account`);
    const again = json(
      await options.send(
        [...create, '--overwrite'],
        `role-apply-${cloud}-again`,
        APPLY_MS,
      ),
      `credentials new --role --apply again (${cloud})`,
    );
    // It converges on the same cloud side.
    assert.deepEqual(again, first);
    // The checks below find it now, so "gone" later isn't a wrong name.
    for (const [executable, args, absent] of gone(apiHost)) {
      const read = await options.runner.run(executable, args, {
        label: `role-present-${cloud}`,
        timeoutMs: 120_000,
      });
      assert.doesNotMatch(
        `${read.stdout}${read.stderr}`.trim(),
        absent,
        `${cloud}: ${executable} ${args.slice(0, 3).join(' ')} doesn't find it after the apply`,
      );
    }
    const teardown = json(
      await options.send(
        ['credentials', 'delete', name, '--apply', '--json'],
        `role-delete-${cloud}`,
        APPLY_MS,
      ),
      `credentials delete --apply (${cloud})`,
    );
    owed.complete();
    for (const [executable, args, absent] of gone(apiHost)) {
      const read = await options.runner.run(executable, args, {
        label: `role-gone-${cloud}`,
        timeoutMs: 120_000,
      });
      assert.match(
        `${read.stdout}${read.stderr}`.trim(),
        absent,
        `${cloud}: ${executable} ${args.slice(0, 3).join(' ')} still finds it`,
      );
    }
    records[cloud] = { created: first, teardown };
  }
  await options.artifacts.json('role-apply-check', records);
}

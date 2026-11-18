import { describe, expect, it, vi } from 'vitest';

import { roleApplyCheck } from '../integration/e2e/internal/substrates/cloud-cluster/role-apply-check.js';
import type { CommandResult } from '../integration/e2e/internal/types.js';

function result(stdout: string, stderr = '', exitCode = 0): CommandResult {
  const command: CommandResult = {
    executable: 'x',
    args: [],
    exitCode,
    signal: null,
    stdout,
    stderr,
    combined: `${stdout}${stderr}`,
    durationMs: 1,
    timedOut: false,
    aborted: false,
    outputTruncated: false,
  };
  return command;
}

const env = {
  GCP_PROJECT_ID: 'acme',
  AZURE_SUBSCRIPTION_ID: 'sub-1',
  ANYCLOUD_ROLE_POOL: 'e2e-r1-1',
  ANYCLOUD_ROLE_PROVIDER: 'e2e-r1-1',
  ANYCLOUD_ROLE_SERVICE_ACCOUNT: 'e2e-r1-1',
};

/** The hosted CLI and each cloud's CLI, answering as after a clean run. */
/** Each cloud's CLI: found until the delete, then as `goneFor` answers. */
function harness(
  goneFor: (executable: string, args: readonly string[]) => CommandResult,
) {
  let deleted = false;
  const sent: string[][] = [];
  const completes: string[] = [];
  const send = vi.fn(async (args: readonly string[]) => {
    sent.push([...args]);
    deleted = args[1] === 'delete';
    const name = args[2]!;
    return args[1] === 'new'
      ? result(JSON.stringify({ name, account: 'a', kind: 'role' }))
      : result(JSON.stringify({ name, deleted: ['x'], kept: [] }));
  });
  const options = {
    send,
    runner: {
      run: vi.fn(async (executable: string, args: readonly string[]) => {
        const answer = goneFor(executable, args);
        if (deleted) return answer;
        return args.includes('exists')
          ? result('true\n')
          : args.includes('providers')
            ? result('ACTIVE\n')
            : result('{"found":true}\n');
      }),
    },
    artifacts: { json: vi.fn(async () => '') },
    cleanup: {
      defer: vi.fn((label: string) => ({
        complete: () => completes.push(label),
      })),
    },
    env,
  };
  return { options, sent, completes };
}

/** Each cloud's CLI as it answers once the setup is gone. */
const gone = (executable: string, args: readonly string[]) =>
  executable === 'aws'
    ? result('', 'Stack with id anycloud-role-c-1 does not exist', 254)
    : executable === 'gcloud'
      ? args.includes('providers')
        ? result('DELETED\n')
        : result('', 'NOT_FOUND: gone', 1)
      : args.includes('exists')
        ? result('false\n')
        : result('', 'ERROR: (DeploymentNotFound) gone', 3);

describe('the role-apply live check', () => {
  it('creates, converges and deletes each cloud, then finds it gone', async () => {
    const { options, sent, completes } = harness(gone);
    await roleApplyCheck(options, 'https://c-1.anycloud.sh');
    expect(sent.map((args) => args.slice(0, 3).join(' '))).toEqual([
      'credentials new e2e-role-aws',
      'credentials new e2e-role-aws',
      'credentials delete e2e-role-aws',
      'credentials new e2e-role-gcp',
      'credentials new e2e-role-gcp',
      'credentials delete e2e-role-gcp',
      'credentials new e2e-role-azure',
      'credentials new e2e-role-azure',
      'credentials delete e2e-role-azure',
    ]);
    expect(sent[1]).toContain('--overwrite');
    expect(sent[3]).toEqual(expect.arrayContaining(['--project-id', 'acme']));
    expect(sent[6]).toEqual(
      expect.arrayContaining(['--subscription-id', 'sub-1']),
    );
    // Each cloud's torn-down state releases its cleanup.
    expect(completes).toEqual([
      'role-apply aws',
      'role-apply gcp',
      'role-apply azure',
    ]);
  });

  it('fails when a cloud still finds what it should have deleted', async () => {
    const { options } = harness((executable, args) =>
      executable === 'aws'
        ? result('{"Stacks":[{"StackName":"anycloud-role-c-1"}]}')
        : gone(executable, args),
    );
    await expect(
      roleApplyCheck(options, 'https://c-1.anycloud.sh'),
    ).rejects.toThrow(/^aws: .*still finds it/);
  });

  it('fails when a re-apply lands on another cloud side', async () => {
    const { options } = harness(gone);
    let applied = 0;
    options.send.mockImplementation(async (args: readonly string[]) =>
      result(
        JSON.stringify(
          args[1] === 'new'
            ? { name: args[2], account: `a${applied++}` }
            : { deleted: [], kept: [] },
        ),
      ),
    );
    await expect(
      roleApplyCheck(options, 'https://c-1.anycloud.sh'),
    ).rejects.toMatchObject({
      code: 'ERR_ASSERTION',
      actual: expect.anything(),
    });
  });

  it('keeps the cleanup owed when the delete fails', async () => {
    const { options, completes } = harness(gone);
    options.send.mockImplementation(async (args: readonly string[]) =>
      args[1] === 'new'
        ? result(JSON.stringify({ name: args[2], account: 'a' }))
        : result('', 'boom', 1),
    );
    await expect(
      roleApplyCheck(options, 'https://c-1.anycloud.sh'),
    ).rejects.toMatchObject({ code: 'ERR_ASSERTION' });
    expect(completes).toEqual([]);
  });
});

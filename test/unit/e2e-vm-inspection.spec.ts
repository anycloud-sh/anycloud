import { describe, expect, test } from 'vitest';

import { RemoteExecutor } from '../integration/e2e/internal/remote.js';
import { VmHarness } from '../integration/e2e/internal/vm.js';
import { Waiter } from '../integration/e2e/internal/wait.js';
import { commandResultForTest } from './helpers/e2e.js';

function fixture(
  overrides: {
    readonly args?: unknown;
    readonly user?: unknown;
    readonly portBindings?: unknown;
  } = {},
) {
  const payload = [
    {
      Args: Object.hasOwn(overrides, 'args')
        ? overrides.args
        : ['-c', 'while :; do sleep 3600; done'],
      State: { Running: true },
      Config: {
        User: Object.hasOwn(overrides, 'user') ? overrides.user : '',
      },
      HostConfig: {
        RestartPolicy: { Name: 'unless-stopped' },
        PortBindings: Object.hasOwn(overrides, 'portBindings')
          ? overrides.portBindings
          : {},
      },
    },
  ];
  const commands: string[] = [];
  const remote = new RemoteExecutor(
    {
      sshAccess: async (workloadId) => ({
        workloadId,
        vmIp: '127.0.0.1',
        sshPrivateKey: 'test-key',
      }),
    },
    { privateText: async () => '/unused-e2e-vm-inspection/key' },
    {
      run: async (_executable, args) => {
        const command = args.at(-1) ?? '';
        commands.push(command);
        const stdout = command.startsWith('docker inspect ')
          ? JSON.stringify(payload)
          : command === "stat -c '%g' /var/run/docker.sock"
            ? '999'
            : command === "stat -c '%a' /workspace"
              ? '777'
              : '';
        return commandResultForTest({ stdout });
      },
    },
    { add: () => undefined },
  );
  return {
    commands,
    vm: new VmHarness(remote, new Waiter(new AbortController().signal)),
  };
}

describe('VM Docker inspection assertions', () => {
  test.each([{}, null])(
    'accepts explicit empty bindings %j and image-default user',
    async (portBindings) => {
      const { vm } = fixture({ portBindings });
      await expect(vm.inspectWorkload('vm-test')).resolves.toMatchObject({
        args: ['-c', 'while :; do sleep 3600; done'],
        user: '',
        publishedPortCount: 0,
      });
    },
  );

  test.each([
    {
      label: 'R01 appended null argument',
      args: ['-c', 'while :; do sleep 3600; done', null],
    },
    { label: 'numeric argument', args: ['-c', 1] },
    { label: 'string instead of arguments', args: '-c' },
    { label: 'missing arguments', args: undefined },
    { label: 'null arguments', args: null },
  ])('rejects $label before executing the runtime probe', async ({ args }) => {
    const { vm, commands } = fixture({ args });
    await expect(vm.inspectWorkload('vm-test')).rejects.toThrow(
      'container.Args',
    );
    expect(commands.some((command) => command.startsWith('docker exec '))).toBe(
      false,
    );
  });

  test.each([
    { label: 'R02 missing User', user: undefined },
    { label: 'null User', user: null },
    { label: 'numeric User', user: 0 },
    { label: 'object User', user: {} },
  ])('rejects $label', async ({ user }) => {
    await expect(
      fixture({ user }).vm.inspectWorkload('vm-test'),
    ).rejects.toThrow('container.Config.User');
  });

  test.each([
    { label: 'R03 nonempty string bindings', portBindings: 'malformed' },
    { label: 'array bindings', portBindings: [] },
    { label: 'missing bindings', portBindings: undefined },
    { label: 'numeric bindings', portBindings: 0 },
    { label: 'boolean bindings', portBindings: false },
  ])('rejects $label', async ({ portBindings }) => {
    await expect(
      fixture({ portBindings }).vm.inspectWorkload('vm-test'),
    ).rejects.toThrow('container.HostConfig.PortBindings');
  });

  test('preserves valid but incorrect values for the lifecycle assertions to reject', async () => {
    const { vm } = fixture({
      args: ['-c', 'exit 0'],
      user: 'nobody',
      portBindings: { '80/tcp': [{ HostPort: '8080' }] },
    });
    await expect(vm.inspectWorkload('vm-test')).resolves.toMatchObject({
      args: ['-c', 'exit 0'],
      user: 'nobody',
      publishedPortCount: 1,
    });
  });
});

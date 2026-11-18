import { describe, expect, test } from 'vitest';

import { createPersistentVmFixture } from './persistent-vm-fixture.js';

describe('persistent VM fixture isolation', () => {
  test('copies observation overrides without changing another fixture or its defaults', async () => {
    const observations = {
      sshDefaults: {},
      inspection: { running: false, args: ['stopped-command'] },
      fixtureObservation: { secretPresent: false, secretDigestMatches: false },
    };
    const failing = createPersistentVmFixture('vm-fixture', observations);
    const healthy = createPersistentVmFixture('vm-fixture');
    observations.inspection.args[0] = 'changed-after-creation';
    observations.inspection.running = true;
    observations.fixtureObservation.secretPresent = true;

    await expect(
      failing.dependencies.vm.inspectWorkload('vm-fixture'),
    ).resolves.toMatchObject({ running: false, args: ['stopped-command'] });
    await expect(
      healthy.dependencies.vm.inspectWorkload('vm-fixture'),
    ).resolves.toMatchObject({
      running: true,
      args: ['-c', 'while :; do sleep 3600; done'],
    });
    const omittedSsh = await failing.dependencies.sshAccess.summary(
      'vm-fixture',
      'container',
    );
    expect(omittedSsh).not.toHaveProperty('port');
    expect(omittedSsh).not.toHaveProperty('username');
    await expect(
      healthy.dependencies.sshAccess.summary('vm-fixture', 'container'),
    ).resolves.toMatchObject({ port: 2222, username: 'root' });
    await expect(
      failing.dependencies.vm.probeWorkloadFixture(
        'vm-fixture',
        'env',
        'digest',
      ),
    ).resolves.toMatchObject({
      secretPresent: false,
      secretDigestMatches: false,
    });
    await expect(
      healthy.dependencies.vm.probeWorkloadFixture(
        'vm-fixture',
        'env',
        'digest',
      ),
    ).resolves.toMatchObject({
      secretPresent: true,
      secretDigestMatches: true,
    });
  });

  test('keeps calls and cleanup registrations independent even for identical resource names', async () => {
    const first = createPersistentVmFixture('vm-fixture');
    const second = createPersistentVmFixture('vm-fixture');
    await first.dependencies.secrets.create('fixture-secret', {});
    await second.dependencies.secrets.create('fixture-secret', {});
    await first.dependencies.kernel.reserve('vm-fixture', 1_000);
    await second.dependencies.kernel.reserve('vm-fixture', 1_000);

    await first.dependencies.secrets.delete('fixture-secret');
    await first.cleanup.run();

    expect(first.calls).toEqual([
      'secret-create',
      'reserve',
      'secret-delete',
      'cleanup-workload',
    ]);
    expect(second.calls).toEqual(['secret-create', 'reserve']);
    expect(second.cleanup.observations()).toEqual([
      { label: 'secret:fixture-secret', completed: false },
      { label: 'workload:vm-fixture', completed: false },
    ]);

    await second.cleanup.run();

    expect(second.calls).toEqual([
      'secret-create',
      'reserve',
      'cleanup-workload',
      'cleanup-secret',
    ]);
    expect(second.cleanup.observations()).toEqual([
      { label: 'secret:fixture-secret', completed: true },
      { label: 'workload:vm-fixture', completed: true },
    ]);
  });
});

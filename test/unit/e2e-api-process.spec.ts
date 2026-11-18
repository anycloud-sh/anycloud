import { describe, expect, test } from 'vitest';

import {
  assertLocalContainer,
  parseContainerInspection,
} from '../integration/helpers/api-process.js';
import {
  containerAbsenceTargets,
  processReceiptSchema,
  verifyProcessReceipts,
  type ApiProcessMember,
  type ProcessReceipt,
} from '../integration/helpers/api-process-receipts.js';

function container() {
  return {
    Id: 'new-container-id',
    State: { Status: 'running', Running: true, ExitCode: 0 },
    Config: { Labels: { 'sh.anycloud.version': '0.0.2' } },
    HostConfig: {
      Binds: ['/private/api-state:/root/.anycloud'],
      RestartPolicy: { Name: 'unless-stopped' },
    },
    NetworkSettings: {
      Ports: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '8123' }] },
    },
  };
}

describe('retained API process assertions', () => {
  test('rejects empty, malformed, or ambiguous Docker inventories', () => {
    expect(parseContainerInspection([container()]).Id).toBe('new-container-id');
    for (const invalid of [
      [],
      [container(), container()],
      {},
      [{ ...container(), State: { Running: 'true' } }],
      [{ Id: 'container' }],
    ]) {
      expect(() => parseContainerInspection(invalid)).toThrow();
    }
  });

  test('checks local binding, original state mount, and restart behavior together', () => {
    expect(() =>
      assertLocalContainer(
        container(),
        '/private/api-state',
        '8123',
        'unless-stopped',
      ),
    ).not.toThrow();
    for (const change of [
      { State: { Status: 'exited', Running: false, ExitCode: 0 } },
      {
        NetworkSettings: {
          Ports: { '8080/tcp': [{ HostIp: '0.0.0.0', HostPort: '8123' }] },
        },
      },
      {
        NetworkSettings: {
          Ports: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '9999' }] },
        },
      },
      {
        HostConfig: {
          Binds: ['/different:/root/.anycloud'],
          RestartPolicy: { Name: 'unless-stopped' },
        },
      },
      {
        HostConfig: {
          Binds: [
            '/private/api-state:/root/.anycloud',
            '/var/run/docker.sock:/var/run/docker.sock',
          ],
          RestartPolicy: { Name: 'unless-stopped' },
        },
      },
      {
        HostConfig: {
          Binds: ['/private/api-state:/root/.anycloud'],
          RestartPolicy: { Name: 'always' },
        },
      },
    ]) {
      expect(() =>
        assertLocalContainer(
          { ...container(), ...change },
          '/private/api-state',
          '8123',
          'unless-stopped',
        ),
      ).toThrow();
    }
  });
});

describe('retained process cleanup receipts', () => {
  const id = 'a'.repeat(64);
  function receipts(
    member: ApiProcessMember = 'api-image',
    mode: 'normal' | 'forced' = 'forced',
  ): ProcessReceipt[] {
    const names =
      member === 'api-image'
        ? [
            'api-test-41',
            'api-heap-41',
            'api-heap-override-41',
            'api-heap-default-41',
            'api-durable-41',
          ]
        : ['anycloud-api', 'api-startup-durable-41'];
    const common = {
      schemaVersion: 1 as const,
      member,
      mode,
      startedAt: 1,
      completedAt: 2,
      completed: true,
      injectedFailure: false,
      containers: [],
    };
    const records: ProcessReceipt[] = [
      { ...common, action: 'register-owned', ownedNames: names },
      {
        ...common,
        action: 'after-running',
        completed: mode === 'normal',
        injectedFailure: mode === 'forced',
        containers: [
          {
            name: member === 'api-image' ? 'api-heap-41' : 'anycloud-api',
            id,
            running: true,
          },
        ],
      },
    ];
    records.push({
      ...common,
      action: 'containers-absent',
      absence: containerAbsenceTargets(records, member).map((target) => ({
        ...target,
        observation: 'absent',
      })),
    });
    records.push({ ...common, action: 'launcher-finished' });
    return records;
  }

  test.each(['api-image', 'api-startup'] as const)(
    'requires exact identities in normal and forced %s evidence',
    (member) => {
      for (const mode of ['normal', 'forced'] as const) {
        const outcome = mode === 'normal' ? 'success' : 'failure';
        expect(
          verifyProcessReceipts(receipts(member, mode), member, outcome, mode),
        ).toMatchObject({
          member,
          mode,
          outcome,
          completed: true,
          capturedContainerIds: [id],
        });
      }
    },
  );

  test('rejects a copied receipt from another member or launcher attempt', () => {
    expect(() =>
      verifyProcessReceipts(receipts(), 'api-startup', 'failure', 'forced'),
    ).toThrow('Foreign member');
    const otherAttempt = receipts();
    otherAttempt[0].ownedNames = [
      'api-test-41',
      'api-heap-42',
      'api-heap-override-41',
      'api-heap-default-41',
      'api-durable-41',
    ];
    expect(() =>
      verifyProcessReceipts(otherAttempt, 'api-image', 'failure', 'forced'),
    ).toThrow('different launcher attempts');
  });

  test('a name-only cleanup receipt cannot hide an old captured container ID', () => {
    const missingId = receipts();
    missingId[2].absence = missingId[2].absence?.filter(
      (entry) => entry.kind !== 'id',
    );
    expect(() =>
      verifyProcessReceipts(missingId, 'api-image', 'failure', 'forced'),
    ).toThrow('omitted or duplicated');
  });

  test.each(['present', 'unknown'] as const)(
    'refuses native %s even with a successful cleanup step',
    (observation) => {
      const unresolved = receipts();
      unresolved[2].absence = unresolved[2].absence?.map((entry) =>
        entry.kind === 'id' ? { ...entry, observation } : entry,
      );
      expect(() =>
        verifyProcessReceipts(unresolved, 'api-image', 'failure', 'forced'),
      ).toThrow('Native cleanup is unresolved');
    },
  );

  test('a forced run cannot accept an earlier assertion failure or missing checkpoint', () => {
    const earlier = receipts();
    earlier[1].action = 'health';
    expect(() =>
      verifyProcessReceipts(earlier, 'api-image', 'failure', 'forced'),
    ).toThrow('after-Running checkpoint');
    const extra = receipts();
    extra.splice(2, 0, {
      ...extra[0],
      action: 'file-nonempty',
      completed: false,
      ownedNames: undefined,
    });
    expect(() =>
      verifyProcessReceipts(extra, 'api-image', 'failure', 'forced'),
    ).toThrow('Failure was not limited');
  });

  test('cleanup failure and missing final status stay red after an expected injection', () => {
    const failed = receipts();
    failed[3].completed = false;
    expect(() =>
      verifyProcessReceipts(failed, 'api-image', 'failure', 'forced'),
    ).toThrow('Launcher cleanup failed');
    expect(() =>
      verifyProcessReceipts(
        receipts().slice(0, 3),
        'api-image',
        'failure',
        'forced',
      ),
    ).toThrow('Missing final launcher');
    const omitted = receipts();
    omitted.splice(2, 1);
    expect(() =>
      verifyProcessReceipts(omitted, 'api-image', 'failure', 'forced'),
    ).toThrow('native cleanup receipt');
  });

  test('outer success cannot hide a failure, and a normal run cannot claim injected evidence', () => {
    expect(() =>
      verifyProcessReceipts(receipts(), 'api-image', 'success', 'forced'),
    ).toThrow('unexpectedly succeeded');
    expect(() =>
      verifyProcessReceipts(receipts(), 'api-image', 'success', 'normal'),
    ).toThrow('declared fault mode');
    expect(() =>
      verifyProcessReceipts(
        receipts('api-image', 'normal'),
        'api-image',
        'failure',
        'normal',
      ),
    ).toThrow('Normal process suite failed');
  });

  test('schema rejects malformed identities and unexpected provider bodies', () => {
    expect(() =>
      processReceiptSchema.parse({
        ...receipts()[1],
        containers: [
          { name: 'api-heap-41', id: 'not-a-docker-id', running: true },
        ],
      }),
    ).toThrow();
    expect(() =>
      processReceiptSchema.parse({
        ...receipts()[1],
        providerBody: { credentials: 'unvalidated' },
      }),
    ).toThrow();
  });
});

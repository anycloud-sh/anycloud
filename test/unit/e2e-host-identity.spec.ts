import { createHash } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import {
  HostIdentityHarness,
  classifySshHostIdentity,
  parseCapturedSshHostIdentity,
  parseSshKeyscanOutput,
  type CapturedSshHostIdentity,
  type SshHostEndpoint,
  type SshHostEndpointObservation,
  type SshHostIdentityTransport,
} from '../integration/e2e/internal/host-identity.js';
import {
  waitForPersistentVmHostRelease,
  type SshHostReleaseEvidence,
} from '../integration/e2e/internal/contracts/persistent-vm-host-release.js';
import { Waiter } from '../integration/e2e/internal/wait.js';

const endpoint: SshHostEndpoint = { host: '203.0.113.10', port: 22 };
const originalFingerprint = 'ssh-ed25519 SHA256:b3JpZ2luYWw';
const replacementFingerprint = 'ssh-ed25519 SHA256:cmVwbGFjZW1lbnQ';

class SequenceTransport implements SshHostIdentityTransport {
  readonly #observations: SshHostEndpointObservation[];
  readonly calls: SshHostEndpoint[] = [];

  constructor(observations: readonly SshHostEndpointObservation[]) {
    this.#observations = [...observations];
  }

  async observe(received: SshHostEndpoint) {
    this.calls.push(received);
    const observation = this.#observations.shift();
    if (!observation) throw new Error('No controlled host observation remains');
    return observation;
  }
}

function controlledHarness(
  observations: readonly SshHostEndpointObservation[],
): {
  readonly artifacts: Array<{ name: string; value: unknown }>;
  readonly harness: HostIdentityHarness;
  readonly release: (
    label: string,
    captured: CapturedSshHostIdentity,
    timeoutMs: number,
  ) => Promise<SshHostReleaseEvidence>;
  readonly transport: SequenceTransport;
} {
  const transport = new SequenceTransport(observations);
  const artifacts: Array<{ name: string; value: unknown }> = [];
  const artifactStore = {
    json: async (name: string, value: unknown) => {
      artifacts.push({ name, value });
      return `/tmp/${name}.json`;
    },
  };
  const waiter = new Waiter(new AbortController().signal);
  let now = 100;
  const harness = new HostIdentityHarness(
    transport,
    waiter,
    artifactStore,
    () => now++,
  );
  return {
    artifacts,
    harness,
    release: (label, captured, timeoutMs) =>
      waitForPersistentVmHostRelease(
        { artifacts: artifactStore, hostIdentity: harness, wait: waiter },
        label,
        captured,
        timeoutMs,
      ),
    transport,
  };
}

function fingerprints(...values: string[]): SshHostEndpointObservation {
  return { kind: 'fingerprints', fingerprints: values };
}

describe('SSH host-key fingerprint protocol', () => {
  test('normalizes, hashes, sorts, and deduplicates keyscan output', () => {
    const firstKey = Buffer.from('first-host-key').toString('base64');
    const secondKey = Buffer.from('second-host-key').toString('base64');
    const keys: ReadonlyArray<readonly [string, string]> = [
      ['ssh-ed25519', firstKey],
      ['ssh-rsa', secondKey],
    ];
    const expected = keys
      .map(
        ([type, key]) =>
          `${type} SHA256:${createHash('sha256')
            .update(Buffer.from(key, 'base64'))
            .digest('base64')
            .replace(/=+$/u, '')}`,
      )
      .sort();

    expect(
      parseSshKeyscanOutput(
        [
          '# 203.0.113.10:22 SSH-2.0-OpenSSH',
          `203.0.113.10 ssh-rsa ${secondKey}`,
          `203.0.113.10 ssh-ed25519 ${firstKey}`,
          `203.0.113.10 ssh-ed25519 ${firstKey}`,
          '',
        ].join('\n'),
      ),
    ).toEqual({ kind: 'fingerprints', fingerprints: expected });
  });

  test('distinguishes empty and malformed handshakes', () => {
    expect(parseSshKeyscanOutput('# banner only\n')).toEqual({
      kind: 'empty',
    });
    expect(parseSshKeyscanOutput('not-an-ssh-key')).toEqual({
      kind: 'malformed',
      line: 'not-an-ssh-key',
    });
  });

  test('rejects unknown versions, extra fields, and unordered fingerprints', () => {
    const valid = {
      version: 1,
      endpoint,
      fingerprints: [originalFingerprint],
      capturedAt: 100,
    };
    expect(parseCapturedSshHostIdentity(valid)).toEqual(valid);
    expect(() =>
      parseCapturedSshHostIdentity({ ...valid, version: 2 }),
    ).toThrow('malformed or unsupported');
    expect(() =>
      parseCapturedSshHostIdentity({ ...valid, unexpected: true }),
    ).toThrow('malformed or unsupported');
    expect(() =>
      parseCapturedSshHostIdentity({
        ...valid,
        fingerprints: [replacementFingerprint, originalFingerprint],
      }),
    ).toThrow('unique and sorted');
  });

  test('uses fingerprint intersection rather than endpoint address as identity', () => {
    const captured = parseCapturedSshHostIdentity({
      version: 1,
      endpoint,
      fingerprints: [originalFingerprint],
      capturedAt: 100,
    });

    expect(
      classifySshHostIdentity(
        captured,
        fingerprints(originalFingerprint, replacementFingerprint),
        101,
      ),
    ).toMatchObject({ kind: 'same' });
    expect(
      classifySshHostIdentity(
        captured,
        fingerprints(replacementFingerprint),
        102,
      ),
    ).toMatchObject({ kind: 'different' });
    expect(
      classifySshHostIdentity(
        captured,
        { kind: 'fingerprints', fingerprints: ['not-a-fingerprint'] },
        103,
      ),
    ).toMatchObject({
      kind: 'inconclusive',
      reason: 'ssh-handshake-malformed',
    });
  });
});

describe('identity-aware original-host release', () => {
  test('accepts a valid different identity immediately', async () => {
    const controlled = controlledHarness([
      fingerprints(originalFingerprint),
      fingerprints(replacementFingerprint),
    ]);
    const captured = await controlled.harness.capture('vm-lambda', endpoint);

    await expect(
      controlled.release('vm-lambda', captured, 100),
    ).resolves.toMatchObject({
      outcome: 'identity-changed',
      observation: { kind: 'different' },
    });
    expect(controlled.transport.calls).toEqual([endpoint, endpoint]);
    expect(controlled.artifacts.map(({ name }) => name)).toEqual([
      'vm-lambda-ssh-host-identity',
      'vm-lambda-ssh-host-release',
    ]);
  });

  test('requires stable endpoint unreachability', async () => {
    const controlled = controlledHarness([
      fingerprints(originalFingerprint),
      { kind: 'unreachable', reason: 'connection-timeout' },
      { kind: 'unreachable', reason: 'connection-refused' },
    ]);
    const captured = await controlled.harness.capture('vm-aws', endpoint);

    await expect(
      controlled.release('vm-aws', captured, 100),
    ).resolves.toMatchObject({
      outcome: 'endpoint-unreachable',
      observation: { kind: 'unreachable', reason: 'connection-refused' },
    });
    expect(controlled.transport.calls).toHaveLength(3);
  });

  test('does not let a transient network failure satisfy release', async () => {
    const controlled = controlledHarness([
      fingerprints(originalFingerprint),
      {
        kind: 'inconclusive',
        reason: 'network-error',
        detail: 'ENETUNREACH',
      },
      fingerprints(originalFingerprint),
      fingerprints(replacementFingerprint),
    ]);
    const captured = await controlled.harness.capture('vm-gcp', endpoint);

    await expect(
      controlled.release('vm-gcp', captured, 100),
    ).resolves.toMatchObject({ outcome: 'identity-changed' });
    expect(controlled.transport.calls).toHaveLength(4);
  });

  test('requires unreachable observations to be consecutive', async () => {
    const controlled = controlledHarness([
      fingerprints(originalFingerprint),
      { kind: 'unreachable', reason: 'connection-timeout' },
      fingerprints(originalFingerprint),
      { kind: 'unreachable', reason: 'connection-timeout' },
      { kind: 'unreachable', reason: 'connection-refused' },
    ]);
    const captured = await controlled.harness.capture('vm-azure', endpoint);

    await expect(
      controlled.release('vm-azure', captured, 100),
    ).resolves.toMatchObject({ outcome: 'endpoint-unreachable' });
    expect(controlled.transport.calls).toHaveLength(5);
  });

  test.each([
    [
      'the same identity',
      fingerprints(originalFingerprint),
      'same SSH host identity',
    ],
    [
      'a malformed handshake',
      {
        kind: 'inconclusive' as const,
        reason: 'ssh-handshake-malformed' as const,
        detail: 'invalid key line',
      },
      'ssh-handshake-malformed',
    ],
  ])(
    'fails closed when %s persists through the deadline',
    async (_label, held, message) => {
      const observations = [
        fingerprints(originalFingerprint),
        ...Array.from({ length: 20 }, () => held),
      ];
      const controlled = controlledHarness(observations);
      const captured = await controlled.harness.capture('vm-lambda', endpoint);

      await expect(
        controlled.release('vm-lambda', captured, 20),
      ).rejects.toThrow(message);
      expect(controlled.artifacts.at(-1)).toMatchObject({
        name: 'vm-lambda-ssh-host-release',
        value: { outcome: 'not-observed' },
      });
    },
  );
});

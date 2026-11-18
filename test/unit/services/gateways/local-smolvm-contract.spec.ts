import { describe, expect, it, vi } from 'vitest';
import { LOCAL_SMOLVM_CONTRACT } from '../../../../src/api/services/gateways/local-smolvm-contract';
import { localSmolvmPreflightChecks } from '../../../../src/api/services/gateways/local';

// The contract reads its bucket root once, at import: these assertions are of
// the default, whatever a developer's shell exports.
vi.hoisted(() => {
  vi.stubEnv('ANYCLOUD_TEST_LOCAL_BUCKET_ROOT', '');
});

describe('Local SmolVM host contract', () => {
  it('contains only the fixed facts shared by the gateway and CI host setup', () => {
    expect(LOCAL_SMOLVM_CONTRACT).toEqual({
      supportedVersion: '1.9.0',
      host: '127.0.0.1',
      port: 18089,
      baseUrl: 'http://127.0.0.1:18089',
      runnerVersion: 'anycloud-local-runner-cow-v2',
      runnerSidecarPath:
        '/var/lib/anycloud-test/local/runner-cow-v1.smolmachine',
      bucketHostPath: '/var/lib/anycloud-test/local/buckets',
    });
    expect(Object.isFrozen(LOCAL_SMOLVM_CONTRACT)).toBe(true);
    expect(LOCAL_SMOLVM_CONTRACT.baseUrl).toBe(
      `http://${LOCAL_SMOLVM_CONTRACT.host}:${LOCAL_SMOLVM_CONTRACT.port}`,
    );
  });
});

describe('Local SmolVM preflight checks', () => {
  const checks = localSmolvmPreflightChecks('ssh-ed25519 AAAA-test key');

  it('does not require a private key on the guest', () => {
    expect(checks.join(' && ')).not.toContain('/etc/anycloud-key');
  });

  it('still asserts the guest invariants that matter', () => {
    const joined = checks.join(' && ');

    expect(joined).toContain('/etc/anycloud-image-version');
    expect(joined).toContain('test -d /storage/docker');
    expect(joined).toContain('test -x /usr/sbin/sshd');
    expect(joined).toContain('/root/.ssh/authorized_keys');
  });
});

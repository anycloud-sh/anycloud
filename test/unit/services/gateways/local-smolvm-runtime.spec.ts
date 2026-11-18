import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultLocalSmolvmRuntime } from '../../../../src/api/services/gateways/local-smolvm-runtime';

// The contract reads its bucket root once, at import: these assertions are of
// the default, whatever a developer's shell exports.
vi.hoisted(() => {
  vi.stubEnv('ANYCLOUD_TEST_LOCAL_BUCKET_ROOT', '');
});

describe('Local SmolVM gateway runtime', () => {
  afterEach(() => vi.restoreAllMocks());

  it('constructs the fixed gateway defaults without contacting SmolVM', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const runtime = createDefaultLocalSmolvmRuntime();

    expect(runtime.config).toEqual({
      baseUrl: 'http://127.0.0.1:18089',
      sidecarPath: '/var/lib/anycloud-test/local/runner-cow-v1.smolmachine',
      sshHost: 'localhost',
      sshUsername: 'root',
      machinePrefix: 'ac-local-',
      networkBackend: 'virtio-net',
      requestTimeoutMs: 30_000,
      provisionTimeoutMs: 180_000,
      setupTimeoutSecs: 120,
      bucketHostPath: '/var/lib/anycloud-test/local/buckets',
      cpus: 1,
      memoryMb: 512,
      overlayGb: 4,
      storageGb: 4,
    });
    expect(Object.isFrozen(runtime.config)).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

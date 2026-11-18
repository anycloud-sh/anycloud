import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkVMRelease,
  clearVMReleaseTracking,
  resetVMReleaseObserverForTests,
} from '../../../../src/api/services/host-runtime/vm-release-observer.js';
import { bindVmCompute } from '../../../../src/api/services/vm-compute.js';
import {
  VM_RELEASE_CANDIDATE,
  VM_RELEASED,
} from '../../../../src/api/services/gateways/cloud.js';
import { CloudType } from '../../../../src/shared/cloud.js';
import { makeMockCloudCompute } from '../../helpers/fixtures.js';

function releasedVm() {
  const observeVMReleaseOnce = vi.fn().mockResolvedValue(VM_RELEASE_CANDIDATE);
  const vm = bindVmCompute(makeMockCloudCompute({ observeVMReleaseOnce }), {
    cloudId: 'vm-1',
    provider: CloudType.GCP,
    credential: { source: 'attempt', credentialId: 'cred-1' },
    region: 'us-central1',
    availabilityZone: null,
  });
  return { vm, observeVMReleaseOnce };
}

describe('VM release observer', () => {
  afterEach(() => {
    resetVMReleaseObserverForTests();
    vi.useRealTimers();
  });

  it('remembers a confirmed release until its expiry timer fires', async () => {
    vi.useFakeTimers();
    const { vm, observeVMReleaseOnce } = releasedVm();

    expect(await checkVMRelease('w1', vm)).toEqual(VM_RELEASED);
    expect(await checkVMRelease('w1', vm)).toEqual(VM_RELEASED);
    expect(observeVMReleaseOnce).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
    await checkVMRelease('w1', vm);
    expect(observeVMReleaseOnce).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1);
    expect(await checkVMRelease('w1', vm)).toEqual(VM_RELEASED);
    expect(observeVMReleaseOnce).toHaveBeenCalledTimes(2);
  });

  it('clears only the named workload memo and aborts its in-flight read', async () => {
    const { vm, observeVMReleaseOnce } = releasedVm();
    await checkVMRelease('w1', vm);
    await checkVMRelease('w10', vm);

    clearVMReleaseTracking('w1');
    await checkVMRelease('w10', vm);
    expect(observeVMReleaseOnce).toHaveBeenCalledTimes(2);
    await checkVMRelease('w1', vm);
    expect(observeVMReleaseOnce).toHaveBeenCalledTimes(3);

    let signal: AbortSignal | undefined;
    observeVMReleaseOnce.mockImplementationOnce(
      (_id: string, options: { signal: AbortSignal }) => {
        signal = options.signal;
        return new Promise(() => {});
      },
    );
    clearVMReleaseTracking('w1');
    void checkVMRelease('w1', vm);
    await vi.waitFor(() => expect(signal).toBeDefined());
    clearVMReleaseTracking('w1');
    expect(signal!.aborted).toBe(true);
    expect(await checkVMRelease('w1', vm)).toEqual(VM_RELEASED);
  });
});

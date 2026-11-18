import { describe, it, expect } from 'vitest';
import { looksLikeMissingGPU } from '../../../../src/api/services/workload-workflows/missing-gpu';
import { GpuRuntime } from '../../../../src/shared/cloud.js';

describe('looksLikeMissingGPU', () => {
  it('matches CUDA_ERROR_NO_DEVICE from cuInit failure', () => {
    const logs =
      'Jax plugin configuration error: Exception when calling jax_plugins.xla_cuda12.initialize()\n' +
      'RuntimeError: jaxlib/cuda/versions_helpers.cc:113: operation cuInit(0) failed: CUDA_ERROR_NO_DEVICE';
    expect(looksLikeMissingGPU(logs)).toBe(true);
  });

  it('matches the bare cuInit(0) failed string', () => {
    expect(looksLikeMissingGPU('something cuInit(0) failed: ...')).toBe(true);
  });

  it('matches nvidia-smi output when no GPU devices are visible', () => {
    expect(looksLikeMissingGPU('Container logs:\nNo devices were found')).toBe(
      true,
    );
  });

  it('matches CUDA error 802 (NVSwitch fabric not ready)', () => {
    // Verbatim shape of a customer training crash on a Lambda H100:2 slice whose
    // NVSwitch fabric was not registered: the GPUs enumerate but CUDA init 802s.
    const logs =
      'RuntimeError: Unexpected error from cudaGetDeviceCount(). Did you run ' +
      'some cuda functions before calling NumCudaDevices() that might have ' +
      'already set an error? Error 802: system not yet initialized';
    expect(looksLikeMissingGPU(logs)).toBe(true);
  });

  it('matches the symbolic CUDA_ERROR_SYSTEM_NOT_READY name', () => {
    expect(
      looksLikeMissingGPU('cuInit failed: CUDA_ERROR_SYSTEM_NOT_READY'),
    ).toBe(true);
  });

  it('matches an explicit Fabric Manager not-running message', () => {
    expect(looksLikeMissingGPU('NVIDIA Fabric Manager is not running')).toBe(
      true,
    );
  });

  // Verbatim from GPU Jobs whose Spot VM came back from an in-place restart,
  // or a fresh node, with no usable GPU.
  it.each([
    'torch.AcceleratorError: CUDA error: CUDA-capable device(s) is/are busy or unavailable',
    'Warp CUDA error 100: no CUDA-capable device is detected',
    'Failed to initialize NVML: Unknown Error',
    'RuntimeError: No CUDA GPUs are available',
    'RuntimeError: Attempting to deserialize object on a CUDA device but torch.cuda.is_available() is False.',
  ])('matches an unusable GPU: %s', (line) => {
    expect(looksLikeMissingGPU(`Error logs:\n${line}`)).toBe(true);
  });

  // Verbatim from T4 Spot Jobs whose GPU failed XLA's autotuning checks.
  it.each([
    'JaxRuntimeError: INTERNAL: Autotuning failed for HLO ... custom_call_target="__cublas$gemm" ... NOT_FOUND: No valid config found!',
    'redzone_allocator.cc:247] Check failed: ... Mismatched results with host and device comparison',
    'redzone_allocator.cc:248] Check failed: ... Mismatched results with host and device comparison',
  ])('matches a faulty GPU: %s', (line) => {
    expect(looksLikeMissingGPU(`Error logs:\n${line}`)).toBe(true);
  });

  it.each([
    'JaxRuntimeError: INTERNAL: Autotuning failed for HLO: RESOURCE_EXHAUSTED: Out of memory',
    'NOT_FOUND: No valid config found for the requested kernel',
    'redzone_allocator.cc:247] Check failed: buffer overwritten',
  ])('does not match half of a faulty-GPU signature: %s', (line) => {
    expect(looksLikeMissingGPU(`Error logs:\n${line}`)).toBe(false);
  });

  it('does not match application-level CUDA errors', () => {
    const logs =
      'Error logs:\nRESOURCE_EXHAUSTED: Out of memory while trying to allocate 5.43GiB.';
    expect(looksLikeMissingGPU(logs)).toBe(false);
  });

  it('handles missing logs', () => {
    expect(looksLikeMissingGPU(undefined)).toBe(false);
    expect(looksLikeMissingGPU('')).toBe(false);
  });

  it('CUDA patterns match regardless of the resolved runtime', () => {
    const logs = 'operation cuInit(0) failed: CUDA_ERROR_NO_DEVICE';
    expect(looksLikeMissingGPU(logs, GpuRuntime.Cuda)).toBe(true);
    expect(looksLikeMissingGPU(logs, GpuRuntime.Rocm)).toBe(true);
    expect(looksLikeMissingGPU(logs, null)).toBe(true);
    expect(looksLikeMissingGPU(logs)).toBe(true);
  });

  it.each([
    'hipErrorNoDevice while initializing HIP',
    'RuntimeError: No ROCm-capable device is detected',
    'HSA_STATUS_ERROR: queue create failed',
    'failed to open /dev/kfd: No such file or directory',
  ])(
    'matches ROCm missing-device log "%s" only when runtime is rocm',
    (log) => {
      expect(looksLikeMissingGPU(log, GpuRuntime.Rocm)).toBe(true);
      // The same line on a CUDA job must NOT be treated as a missing GPU.
      expect(looksLikeMissingGPU(log, GpuRuntime.Cuda)).toBe(false);
      // …nor when the runtime is unresolved (no arg / null).
      expect(looksLikeMissingGPU(log)).toBe(false);
      expect(looksLikeMissingGPU(log, null)).toBe(false);
    },
  );
});

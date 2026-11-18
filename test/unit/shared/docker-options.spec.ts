import { describe, expect, it } from 'vitest';
import {
  validateDockerOptionsForKubernetes,
  validateDockerOptionsForResolvedTarget,
  validateDockerOptionsRequest,
} from '../../../src/shared/docker-options';
import {
  bindTargetsContainerPath,
  parseDockerVolumeBind,
} from '../../../src/shared/docker-volume';
import { CloudType } from '../../../src/shared/cloud.js';
import { InvalidAnycloudConfigError } from '../../../src/shared/errors.js';
import { type DockerOptions } from '../../../src/shared/runtime.js';

describe('Docker option validation', () => {
  it('accepts explicit privilege and disposable Deployment volumes', () => {
    expect(() =>
      validateDockerOptionsForKubernetes({
        privileged: true,
        binds: ['/var/lib/docker', '/workspace'],
      }),
    ).not.toThrow();
    expect(() =>
      validateDockerOptionsRequest({ privileged: false }),
    ).not.toThrow();
    expect(() => validateDockerOptionsRequest({ privileged: 'true' })).toThrow(
      'must be a boolean',
    );
  });

  it('refuses CPU finer than a millicore on Kubernetes only', () => {
    expect(() =>
      validateDockerOptionsForKubernetes({ cpus: '0.2500' }),
    ).not.toThrow();
    for (const cpus of ['0.0005', '1.0005']) {
      expect(() => validateDockerOptionsForKubernetes({ cpus })).toThrow(
        InvalidAnycloudConfigError,
      );
      expect(() => validateDockerOptionsRequest({ cpus })).not.toThrow();
    }
  });

  it.each([
    ['/host:/data'],
    ['cache:/data'],
    ['/var/run/secrets/anycloud'],
    ['/var//run/secrets/anycloud'],
    ['/run/secrets'],
    ['/var/lib/../run/secrets'],
    ['/'],
    ['/data', '/data/child'],
    ['/data', '/data'],
    ['/dev/shm'],
  ])('rejects unsafe or ambiguous Deployment volumes %j', (...binds) => {
    expect(() => validateDockerOptionsForKubernetes({ binds })).toThrow();
  });

  it('accepts the Docker options implemented by VM-host targets', () => {
    expect(() =>
      validateDockerOptionsRequest({
        shmSize: '8GiB',
        gpus: '2',
        ipc: 'host',
        ulimits: ['memlock=-1:-1', 'stack=67108864'],
        memory: '32g',
        cpus: '3.5',
        runtime: 'nvidia',
        binds: ['/models:/models:ro', 'model-cache:/cache'],
        network: 'anycloud-control',
      }),
    ).not.toThrow();
  });

  it.each([
    ['an array', [], 'must be an object'],
    ['an unknown field', { gpu: 'all' }, 'Unknown dockerOptions field'],
    ['a non-string value', { cpus: 4 }, 'cpus must be a non-empty string'],
    ['zero shared memory', { shmSize: '0g' }, 'positive integer'],
    ['too little memory', { memory: '4m' }, 'at least 6m'],
    ['invalid CPUs', { cpus: 'zero' }, 'positive number'],
    ['zero CPUs', { cpus: '0' }, 'positive number'],
    ['invalid GPUs', { gpus: 'device=0' }, 'positive GPU count'],
    ['zero GPUs', { gpus: '0' }, 'positive GPU count'],
    ['an unmanaged runtime', { runtime: 'kata' }, 'support runc and nvidia'],
    ['an invalid IPC mode', { ipc: 'shared' }, '--ipc must be'],
    [
      'an invalid ulimit',
      { ulimits: ['nofile=4096:1024'] },
      'soft limit exceeds hard limit',
    ],
    [
      'a relative bind target',
      { binds: ['/models:models'] },
      'expected source:/absolute/container/path',
    ],
    [
      'an invalid bind mode',
      { binds: ['/models:/models:maybe'] },
      'unsupported mount mode',
    ],
    ['an invalid network', { network: 'bad network' }, 'Docker network name'],
  ] as const)('rejects %s', (_name, value, message) => {
    expect(() => validateDockerOptionsRequest(value)).toThrow(message);
  });

  it.each([
    '/tmp/data:/mnt/output',
    '/tmp/data:/mnt/output/cache',
    '/tmp/data:/mnt',
  ])('rejects bind %s overlapping a managed bucket mount', (bind) => {
    expect(() =>
      validateDockerOptionsRequest(
        { binds: [bind] },
        { outputBucket: 'results' },
      ),
    ).toThrow('conflicts with Anycloud-managed /mnt/output');
  });

  it('allows a bind that does not overlap a configured bucket mount', () => {
    expect(() =>
      validateDockerOptionsRequest(
        { binds: ['/tmp/models:/models:ro'] },
        { outputBucket: 'results' },
      ),
    ).not.toThrow();
  });

  it('rejects a bind on the implicit checkpoint mount a spot request creates', () => {
    expect(() =>
      validateDockerOptionsRequest(
        { binds: ['/tmp/ckpt:/mnt/checkpoint'] },
        { spot: true },
      ),
    ).toThrow('conflicts with Anycloud-managed /mnt/checkpoint');
  });

  it('allows that same bind when no checkpoint bucket is mounted', () => {
    expect(() =>
      validateDockerOptionsRequest(
        { binds: ['/tmp/ckpt:/mnt/checkpoint'] },
        { spot: false },
      ),
    ).not.toThrow();
  });

  it('parses bind targets for hosted API conflict checks', () => {
    expect(parseDockerVolumeBind('cache:/var/lib/anycloud:ro')).toEqual({
      source: 'cache',
      target: '/var/lib/anycloud',
      mode: 'ro',
    });
    expect(
      bindTargetsContainerPath(
        '/tmp/state:/mnt/checkpoint/state',
        '/mnt/checkpoint',
      ),
    ).toBe(true);
  });

  it('applies the VM-host option set to a catalog-less substrate', () => {
    expect(() =>
      validateDockerOptionsForResolvedTarget(
        {
          gpus: 'all',
          shmSize: '1g',
          memory: '2g',
          cpus: '1',
          runtime: 'nvidia',
        },
        { cloudProvider: CloudType.Local, vmType: 'local' },
      ),
    ).not.toThrow();
  });

  it('accepts NVIDIA options on a CUDA VM and runc on a CPU VM', () => {
    expect(() =>
      validateDockerOptionsForResolvedTarget(
        { gpus: '8', runtime: 'nvidia' },
        { cloudProvider: CloudType.AWS, vmType: 'p5.48xlarge' },
      ),
    ).not.toThrow();
    expect(() =>
      validateDockerOptionsForResolvedTarget(
        { runtime: 'runc' },
        { cloudProvider: CloudType.AWS, vmType: 't3.medium' },
      ),
    ).not.toThrow();
  });

  it.each([
    { gpus: 'all' },
    { runtime: 'nvidia' },
    { gpus: 'all', runtime: 'nvidia' },
  ] satisfies DockerOptions[])(
    'rejects NVIDIA option %j on a CPU VM',
    (options) => {
      expect(() =>
        validateDockerOptionsForResolvedTarget(options, {
          cloudProvider: CloudType.AWS,
          vmType: 't3.medium',
        }),
      ).toThrow('require an NVIDIA CUDA VM');
    },
  );

  it.each([{ gpus: 'all' }, { runtime: 'nvidia' }] satisfies DockerOptions[])(
    'allows NVIDIA option %j on a VM whose accelerator the catalog never named',
    (options) => {
      // Azure ships this real SKU with a blank AcceleratorName, so its runtime
      // is unknown rather than absent. Forcing GPU access is the escape hatch.
      expect(() =>
        validateDockerOptionsForResolvedTarget(options, {
          cloudProvider: CloudType.Azure,
          vmType: 'Standard_NC144ds_xl_RTXPRO6000BSE_v6',
        }),
      ).not.toThrow();
    },
  );

  it('still rejects NVIDIA options on a known non-CUDA accelerator', () => {
    expect(() =>
      validateDockerOptionsForResolvedTarget(
        { gpus: 'all' },
        { cloudProvider: CloudType.AWS, vmType: 'trn1.2xlarge' },
      ),
    ).toThrow('require an NVIDIA CUDA VM');
  });

  it('rejects a GPU count larger than the resolved host', () => {
    expect(() =>
      validateDockerOptionsForResolvedTarget(
        { gpus: '2' },
        { cloudProvider: CloudType.AWS, vmType: 'g4dn.xlarge' },
      ),
    ).toThrow('exceeds the 1 GPU(s)');
  });
});

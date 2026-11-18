import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BUCKET_HOST_PATHS,
  NEURON_RUNTIME_UNSUPPORTED_MESSAGE,
  computeProviderData,
  isComputeProvider,
  acceleratorRuntimeForProviderVMType,
  acceleratorRuntimeRejectionMessage,
  bucketHostPathsForProvider,
  spotNoReclaimNoticeCommand,
  supportsAcceleratorFailureRetry,
  usesAvailabilityZoneTargets,
} from '../../../src/shared/providers';
import { CloudType, GpuRuntime } from '../../../src/shared/cloud.js';

describe('provider bucket host clusterRecords', () => {
  it('keeps providers on the default host root unless their provider data opts out', () => {
    const defaultClouds = [
      CloudType.AWS,
      CloudType.GCP,
      CloudType.Lambda,
      CloudType.Local,
    ];

    for (const cloud of defaultClouds) {
      expect(bucketHostPathsForProvider(cloud)).toEqual(
        DEFAULT_BUCKET_HOST_PATHS,
      );
    }
  });

  it('expands the provider root into explicit bucket host paths', () => {
    expect(bucketHostPathsForProvider(CloudType.Azure)).toEqual({
      input: '/var/lib/anycloud/deployments/input',
      output: '/var/lib/anycloud/deployments/output',
      checkpoint: '/var/lib/anycloud/deployments/checkpoint',
    });
    expect(bucketHostPathsForProvider(CloudType.Local)).toEqual(
      DEFAULT_BUCKET_HOST_PATHS,
    );
  });
});

describe('provider provisioning-target scope', () => {
  it('keeps GCP zone-aware while AWS and Azure remain region-scoped', () => {
    expect(usesAvailabilityZoneTargets(CloudType.GCP)).toBe(true);
    expect(usesAvailabilityZoneTargets(CloudType.AWS)).toBe(false);
    expect(usesAvailabilityZoneTargets(CloudType.Azure)).toBe(false);
  });
});

describe('provider accelerator-runtime capabilities', () => {
  it('requires every cloud to make an explicit capability choice', () => {
    for (const cloud of Object.values(CloudType).filter(isComputeProvider)) {
      expect(
        computeProviderData(cloud).acceleratorRuntimeCapability,
      ).toBeDefined();
    }
  });

  it('declares Lambda as CUDA-only instead of relying on a gateway branch', () => {
    expect(
      acceleratorRuntimeRejectionMessage(CloudType.Lambda, GpuRuntime.Cuda),
    ).toBeNull();
    expect(
      acceleratorRuntimeRejectionMessage(CloudType.Lambda, GpuRuntime.Neuron),
    ).toBe(NEURON_RUNTIME_UNSUPPORTED_MESSAGE);
  });

  it('owns AWS family fallback recognition without leaking it to other clouds', () => {
    expect(
      acceleratorRuntimeForProviderVMType(CloudType.AWS, 'trn3.48xlarge'),
    ).toBe(GpuRuntime.Neuron);
    expect(
      acceleratorRuntimeForProviderVMType(CloudType.AWS, 'trn2u.48xlarge'),
    ).toBe(GpuRuntime.Neuron);
    expect(
      acceleratorRuntimeForProviderVMType(CloudType.AWS, 'INF2.8XLARGE'),
    ).toBe(GpuRuntime.Neuron);
    expect(
      acceleratorRuntimeForProviderVMType(CloudType.AWS, 'inf1.xlarge'),
    ).toBe(GpuRuntime.Unsupported);
    expect(
      acceleratorRuntimeForProviderVMType(CloudType.GCP, 'trn3.48xlarge'),
    ).toBeNull();
  });

  it('does not retry missing accelerators on the fixed Local harness', () => {
    expect(supportsAcceleratorFailureRetry(CloudType.Local)).toBe(false);
    expect(supportsAcceleratorFailureRetry(CloudType.AWS)).toBe(true);
  });

  it("reads a spot VM's reclaim notice only where it's posted before the shutdown", async () => {
    const { execFile } = await import('node:child_process');
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { createServer } = await import('node:http');
    // Azure's Scheduled Events can take two minutes to answer a first request.
    for (const cloud of [CloudType.Azure, CloudType.Lambda, CloudType.Local])
      expect(spotNoReclaimNoticeCommand(cloud)).toBeUndefined();
    // A metadata server: AWS's token and spot path, and GCP's preempted flag.
    let notice = false;
    const server = createServer((request, response) => {
      if (request.url?.endsWith('/api/token')) return response.end('token');
      if (request.url?.endsWith('/spot/instance-action')) {
        response.statusCode = notice ? 200 : 404;
        return response.end(notice ? '{"action":"terminate"}' : '');
      }
      response.end(notice ? 'TRUE' : 'FALSE');
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const { port } = server.address() as { port: number };
    // A host whose systemd reports SYSTEM_STATE.
    const bin = mkdtempSync(join(tmpdir(), 'systemctl-'));
    writeFileSync(join(bin, 'systemctl'), '#!/bin/sh\necho "$SYSTEM_STATE"\n', {
      mode: 0o755,
    });
    const probe = (cloud: CloudType, base: string, state = 'running') =>
      new Promise<string>((resolve) =>
        execFile(
          'bash',
          [
            '-c',
            spotNoReclaimNoticeCommand(cloud)!.replaceAll(
              /http:\/\/[^/]+/g,
              base,
            ),
          ],
          {
            env: {
              ...process.env,
              PATH: `${bin}:${process.env.PATH}`,
              SYSTEM_STATE: state,
            },
          },
          (_error, stdout) => resolve(stdout.trim()),
        ),
      );
    try {
      for (const cloud of [CloudType.AWS, CloudType.GCP]) {
        notice = false;
        const base = `http://127.0.0.1:${port}`;
        expect(await probe(cloud, base)).toBe('no-notice');
        expect(await probe(cloud, base, 'degraded')).toBe('no-notice');
        // Shutting down, as in a reclaim with no notice yet: not final.
        expect(await probe(cloud, base, 'stopping')).toBe('');
        notice = true;
        expect(await probe(cloud, `http://127.0.0.1:${port}`)).toBe('');
        // Fail closed: no metadata server to answer.
        expect(await probe(cloud, 'http://127.0.0.1:9')).toBe('');
      }
    } finally {
      server.close();
    }
  });
});

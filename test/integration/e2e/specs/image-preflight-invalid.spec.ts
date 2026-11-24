import { test, expect } from '../fixture.js';

test('image preflight rejects invalid images before provisioning', async ({
  e2e,
}) => {
  const arm64OnlyRepository = e2e.env.optional(
    'ARM64_ONLY_REPO',
    'ghcr.io/anycloud-sh/arm64-only-test',
  );
  const largeAmd64Image = e2e.env.optional(
    'LARGE_AMD64_IMAGE',
    'mirror.gcr.io/nvidia/cuda@sha256:0a1cb6e7bd047a1067efe14efdf0276352d5ca643dfd77963dab1a4f05a003a4',
  );
  const awsVmType = e2e.env.optional(
    'AWS_IMAGE_PREFLIGHT_VM_TYPE',
    'm3.medium',
  );

  await e2e.api.saveCredential('preflight-aws', {
    cloudProvider: 'AWS',
    accessKeyId: 'dummy-not-validated',
    secretAccessKey: 'dummy-not-validated',
  });

  const rejectsBeforeProvision = async (
    id: string,
    expectedText: string,
    args: readonly string[],
  ): Promise<void> => {
    const result = await e2e.cli.run(args, { timeoutMs: 180_000 });
    expect(result.spawnError).toBeUndefined();
    expect(result.aborted).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(result.combined).toContain(expectedText);
    expect(await e2e.workloadFacts.liveVmCount(id)).toBe(0);
    expect(await e2e.workloadFacts.provisioningRecordCounts(id)).toEqual({
      workloadRows: 0,
      vmRows: 0,
    });
  };

  const architectureId = e2e.names.workload('imgpf-arch');
  await rejectsBeforeProvision(architectureId, 'has no linux/amd64 build', [
    'job',
    '--id',
    architectureId,
    '--credentials',
    'preflight-aws',
    '--vm-type',
    awsVmType,
    `${arm64OnlyRepository}:latest`,
    '--',
    'sh',
    '-c',
    'echo should-not-provision',
  ]);

  const missingTagId = e2e.names.workload('imgpf-nf');
  await rejectsBeforeProvision(missingTagId, 'not found', [
    'job',
    '--id',
    missingTagId,
    '--credentials',
    'preflight-aws',
    '--vm-type',
    awsVmType,
    `${arm64OnlyRepository}:no-such-tag-${e2e.runId}`,
    '--',
    'sh',
    '-c',
    'echo should-not-provision',
  ]);

  const explicitDiskId = e2e.names.workload('imgpf-explicit');
  await rejectsBeforeProvision(explicitDiskId, 'requested 1 GB disk', [
    'job',
    '--id',
    explicitDiskId,
    '--credentials',
    'preflight-aws',
    '--vm-type',
    awsVmType,
    '--disk-size',
    '1',
    largeAmd64Image,
    '--',
    'sh',
    '-c',
    'echo should-not-provision',
  ]);

  const catalogDiskId = e2e.names.workload('imgpf-catalog');
  await rejectsBeforeProvision(
    catalogDiskId,
    `catalog disk for VM type "${awsVmType}"`,
    [
      'job',
      '--id',
      catalogDiskId,
      '--credentials',
      'preflight-aws',
      '--vm-type',
      awsVmType,
      largeAmd64Image,
      '--',
      'sh',
      '-c',
      'echo should-not-provision',
    ],
  );
});

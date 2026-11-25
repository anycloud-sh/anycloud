import { describe, it, expect } from 'vitest';
import { inspectImage } from '../../src/shared/image-registry.js';
import { ImageRuntime, ImageVerdict } from '../../src/shared/image.js';

// Real-network integration test — hits live GHCR, GCR, Quay, and NVCR
// (no mocks, no cloud creds). Proves the ACTUAL registry bearer-auth dance and
// digest resolution, which the unit tests can only approximate. Docker Hub's
// shared-IP path remains covered with mocked HTTP contracts so persistent CI
// runners cannot exhaust its anonymous quota. Regression guard for the GHCR-auth
// bug: a bad/no token must not turn a PUBLIC image into 'unauthorized'.
//
// Depends on the public fixture ghcr.io/anycloud-sh/arm64-only-test:latest
// (built from test/docker/Dockerfile.arm64-only).
const ARM64_ONLY_REPO = 'ghcr.io/anycloud-sh/arm64-only-test';
const SINGLE_AMD64_IMAGE = 'quay.io/quay/busybox:latest';
const SINGLE_AMD64_DIGEST =
  'sha256:92f3298bf80a1ba949140d77987f5de081f010337880cd771f7e7fc928f8c74d';
const SINGLE_ARM64_DIGEST_REF =
  'mirror.gcr.io/library/busybox@sha256:bd44eb136a95dcc8dc58995e43abc40a413f2e8e3d4a2aae6bccbe94686acb05';
const SINGLE_WINDOWS_AMD64_DIGEST_REF =
  'mirror.gcr.io/library/hello-world@sha256:fc346caeedb367cd9a9a25fa9bd72ad6e10c49282a68f53f720c695c31e0d433';
const CUDA_RUNTIME_DIGEST_REF =
  'nvcr.io/nvidia/cuda@sha256:6e6bcc811b807465076444f7018330976d56d7a6fc41574b4bc3babf411a7a98';
const ROCM_RUNTIME_DIGEST_REF =
  'ghcr.io/rocm/therock_build_manylinux_x86_64@sha256:cf4f6d9909056906e4a1c0bc4c245658a0af4c6a6174082a86adfa2d518b7aeb';
// Each inspectImage may do several sequential fetches (401 → token → retry,
// platform manifest, config blob), each with a 5s cap — give the network room.
const NET_TIMEOUT_MS = 30_000;
const expectPositiveCompressedLayerBytes = (value: number | null) => {
  expect(value).not.toBeNull();
  expect(value).toBeGreaterThan(0);
};

describe('inspectImage (real registries)', () => {
  it(
    'public ghcr arm64-only image → no_platform, with no token AND with a dummy token',
    async () => {
      expect((await inspectImage(`${ARM64_ONLY_REPO}:latest`)).verdict).toBe(
        ImageVerdict.NoPlatform,
      );
      // The reported bug: a dummy/no-access token must not flip a public image
      // to 'unauthorized'.
      expect(
        (
          await inspectImage(
            `${ARM64_ONLY_REPO}:latest`,
            'dummy-token-for-test',
          )
        ).verdict,
      ).toBe(ImageVerdict.NoPlatform);
    },
    NET_TIMEOUT_MS,
  );

  it(
    'public single-manifest amd64 image → ok, with its manifest digest',
    async () => {
      const result = await inspectImage(SINGLE_AMD64_IMAGE);
      expect(result.verdict).toBe(ImageVerdict.Ok);
      expect(result.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(result.imageRuntime).toBe(ImageRuntime.Unknown);
      expectPositiveCompressedLayerBytes(result.compressedLayerBytes);
    },
    NET_TIMEOUT_MS,
  );

  it(
    'public digest-pinned single-manifest amd64 image → ok, preserving the pinned digest',
    async () => {
      const result = await inspectImage(
        `quay.io/quay/busybox@${SINGLE_AMD64_DIGEST}`,
      );
      expect(result.verdict).toBe(ImageVerdict.Ok);
      expect(result.digest).toBe(SINGLE_AMD64_DIGEST);
      expect(result.imageRuntime).toBe(ImageRuntime.Unknown);
      expectPositiveCompressedLayerBytes(result.compressedLayerBytes);
    },
    NET_TIMEOUT_MS,
  );

  it(
    'public digest-pinned single-manifest arm64 image → no_platform',
    async () => {
      expect((await inspectImage(SINGLE_ARM64_DIGEST_REF)).verdict).toBe(
        ImageVerdict.NoPlatform,
      );
    },
    NET_TIMEOUT_MS,
  );

  it(
    'public digest-pinned single-manifest windows/amd64 image → no_platform',
    async () => {
      expect(
        (await inspectImage(SINGLE_WINDOWS_AMD64_DIGEST_REF)).verdict,
      ).toBe(ImageVerdict.NoPlatform);
    },
    NET_TIMEOUT_MS,
  );

  it(
    'public multi-arch GCR mirror image → ok, with a resolved amd64 digest',
    async () => {
      const result = await inspectImage('mirror.gcr.io/library/alpine:latest');
      expect(result.verdict).toBe(ImageVerdict.Ok);
      expect(result.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(result.imageRuntime).toBe(ImageRuntime.Unknown);
      expectPositiveCompressedLayerBytes(result.compressedLayerBytes);
    },
    NET_TIMEOUT_MS,
  );

  it(
    'public CUDA image → ok, with runtime cuda',
    async () => {
      const result = await inspectImage(CUDA_RUNTIME_DIGEST_REF);
      expect(result.verdict).toBe(ImageVerdict.Ok);
      expect(result.digest).toBe(CUDA_RUNTIME_DIGEST_REF.split('@')[1]);
      expect(result.imageRuntime).toBe(ImageRuntime.Cuda);
      expectPositiveCompressedLayerBytes(result.compressedLayerBytes);
    },
    NET_TIMEOUT_MS,
  );

  it(
    'public ROCm image → ok, with runtime rocm',
    async () => {
      const result = await inspectImage(ROCM_RUNTIME_DIGEST_REF);
      expect(result.verdict).toBe(ImageVerdict.Ok);
      expect(result.digest).toBe(ROCM_RUNTIME_DIGEST_REF.split('@')[1]);
      expect(result.imageRuntime).toBe(ImageRuntime.Rocm);
      expectPositiveCompressedLayerBytes(result.compressedLayerBytes);
    },
    NET_TIMEOUT_MS,
  );

  it(
    'missing tag on a public repo → not_found',
    async () => {
      expect(
        (await inspectImage(`${ARM64_ONLY_REPO}:no-such-tag-xyz`)).verdict,
      ).toBe(ImageVerdict.NotFound);
    },
    NET_TIMEOUT_MS,
  );
});

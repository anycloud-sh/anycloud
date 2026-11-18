import { describe, expect, it } from 'vitest';
import {
  assessReleaseGuard,
  assessReleaseReadiness,
  type ObservedApiPod,
} from '../../../../src/api/services/system-release/release-readiness.js';

const DIGEST = `sha256:${'d'.repeat(64)}`;
const expected = {
  revision: 2,
  operationId: 'op-2',
  image: `ghcr.io/anycloud-sh/api:0.1.65@${DIGEST}`,
  version: '0.1.65',
};

function pod(overrides: Partial<ObservedApiPod> = {}): ObservedApiPod {
  return {
    name: 'anycloud-api-abc',
    podIp: '10.42.0.5',
    ready: true,
    annotations: {
      'anycloud.sh/release-revision': '2',
      'anycloud.sh/release-operation': 'op-2',
    },
    imageIds: [`ghcr.io/anycloud-sh/api@${DIGEST}`],
    ...overrides,
  };
}

describe('release readiness', () => {
  it('is complete only with the requested operation, pinned digest, readiness and served version together', () => {
    expect(
      assessReleaseReadiness([pod()], expected, {
        healthy: true,
        servedVersion: '0.1.65',
      }),
    ).toEqual({ ready: true, pod: 'anycloud-api-abc' });
  });

  it('does not accept a Pod from another operation even when it is healthy', () => {
    const stale = pod({
      annotations: {
        'anycloud.sh/release-revision': '1',
        'anycloud.sh/release-operation': 'op-1',
      },
    });
    expect(
      assessReleaseReadiness([stale], expected, {
        healthy: true,
        servedVersion: '0.1.65',
      }),
    ).toMatchObject({
      ready: false,
      reason: expect.stringContaining('no API Pod carries revision 2'),
    });
  });

  it('requires the exact image digest', () => {
    expect(
      assessReleaseReadiness(
        [
          pod({
            imageIds: [`ghcr.io/anycloud-sh/api@sha256:${'e'.repeat(64)}`],
          }),
        ],
        expected,
        { healthy: true, servedVersion: '0.1.65' },
      ),
    ).toMatchObject({
      ready: false,
      reason: expect.stringContaining('does not run image digest'),
    });
    expect(
      assessReleaseReadiness(
        [pod()],
        { ...expected, image: 'ghcr.io/anycloud-sh/api:0.1.65' },
        {
          healthy: true,
          servedVersion: '0.1.65',
        },
      ),
    ).toMatchObject({
      ready: false,
      reason: 'expected image is not digest-pinned',
    });
  });

  it('requires a ready Pod, a healthy endpoint and the expected served version', () => {
    expect(
      assessReleaseReadiness([pod({ ready: false })], expected, {
        healthy: true,
        servedVersion: '0.1.65',
      }),
    ).toMatchObject({
      ready: false,
      reason: expect.stringContaining('not ready'),
    });
    expect(assessReleaseReadiness([pod()], expected, null)).toMatchObject({
      ready: false,
      reason: expect.stringContaining('/health'),
    });
    expect(
      assessReleaseReadiness([pod()], expected, {
        healthy: true,
        servedVersion: '0.1.64',
      }),
    ).toMatchObject({
      ready: false,
      reason: expect.stringContaining('serves version 0.1.64'),
    });
  });
});

describe('in-cluster release guard', () => {
  const incoming = { revision: 3, operationId: 'op-3' };
  const running = (revision: string, operation = 'op-old') => ({
    'anycloud.sh/release-revision': revision,
    'anycloud.sh/release-operation': operation,
  });

  it('allows a first install and a strictly newer revision', () => {
    expect(assessReleaseGuard(null, incoming)).toEqual({ allowed: true });
    expect(assessReleaseGuard(running('2'), incoming)).toEqual({
      allowed: true,
    });
  });

  it('allows a replay of the same revision and operation only', () => {
    expect(assessReleaseGuard(running('3', 'op-3'), incoming)).toEqual({
      allowed: true,
    });
    expect(
      assessReleaseGuard(running('3', 'op-other'), incoming),
    ).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('different operation'),
    });
  });

  it('refuses an older incoming revision and an unlabelled or malformed running release', () => {
    expect(assessReleaseGuard(running('4'), incoming)).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('newer than incoming 3'),
    });
    expect(assessReleaseGuard({}, incoming)).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('no AnyCloud revision'),
    });
    expect(assessReleaseGuard(running('x'), incoming)).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('not a number'),
    });
  });
});

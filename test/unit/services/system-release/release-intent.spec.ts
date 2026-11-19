import { describe, expect, it } from 'vitest';
import {
  buildSystemReleaseHelmChart,
  compareReleaseIntent,
  systemReleaseValues,
  valuesSha256,
  type SystemReleaseIntentInput,
} from '../../../../src/shared/system-release-values.js';
import {
  RELEASE_INSTALLATION_ANNOTATION,
  RELEASE_OPERATION_ANNOTATION,
  RELEASE_REVISION_ANNOTATION,
} from '../../../../src/shared/system-release.js';
import { SYSTEM_RELEASE_HELM_JOB_IMAGE } from '../../../../src/shared/system-release.js';

const DIGEST = `sha256:${'b'.repeat(64)}`;
const input: SystemReleaseIntentInput = {
  installationId: 'install-1',
  cluster: {
    name: 'production',
    kubernetesIdentity: 'uid-production',
    joinEndpoint: 'https://203.0.113.9:6443',
    certificateAuthorityData: Buffer.from('ca').toString('base64'),
    record: null,
  },
  revision: 3,
  operationId: 'op-3',
  apiImage: `ghcr.io/anycloud-sh/api:0.1.64@${DIGEST}`,
  apiVersion: '0.1.64',
  ownerUsername: 'owner',
  ownerUserId: '42',
  githubAppIds: [5622376],
  apiUrl: 'http://203.0.113.9:30080',
  chart: `oci://ghcr.io/anycloud-sh/api-k8-chart@sha256:${'c'.repeat(64)}`,
  helmJobImage: SYSTEM_RELEASE_HELM_JOB_IMAGE,
  backup: null,
  restoreFromBackup: false,
};

function observed(annotations: Record<string, string>) {
  return {
    metadata: {
      name: 'anycloud-api',
      namespace: 'anycloud-system',
      annotations,
    },
  };
}

describe('system release intent', () => {
  it('builds one HelmChart carrying revision, operation and installation with abort failure policy', () => {
    const chart = buildSystemReleaseHelmChart(input);
    expect(chart.metadata).toEqual({
      name: 'anycloud-api',
      namespace: 'anycloud-system',
      annotations: {
        [RELEASE_REVISION_ANNOTATION]: '3',
        [RELEASE_OPERATION_ANNOTATION]: 'op-3',
        [RELEASE_INSTALLATION_ANNOTATION]: 'install-1',
      },
    });
    expect(chart.spec).toMatchObject({
      bootstrap: true,
      failurePolicy: 'abort',
      backOffLimit: 0,
      jobImage: SYSTEM_RELEASE_HELM_JOB_IMAGE,
      targetNamespace: 'anycloud-system',
      chart: input.chart,
    });
    expect(chart.spec).not.toHaveProperty('chartContent');
    expect(JSON.parse(chart.spec.valuesContent)).toEqual(
      systemReleaseValues(input),
    );
  });

  it('carries the GitHub Apps whose user tokens the API exchanges', () => {
    expect(systemReleaseValues(input).installation.githubAppIds).toEqual([
      5622376,
    ]);
  });

  it('refuses a tag-only image or chart and a non-positive revision', () => {
    for (const chart of [
      'oci://ghcr.io/anycloud-sh/api-k8-chart:0.1.64',
      // A tag next to the digest makes Helm resolve the tag as well.
      `oci://ghcr.io/anycloud-sh/api-k8-chart:0.1.64@sha256:${'c'.repeat(64)}`,
      `ghcr.io/anycloud-sh/api-k8-chart@sha256:${'c'.repeat(64)}`,
    ]) {
      expect(() => systemReleaseValues({ ...input, chart })).toThrow(
        'digest-pinned API chart',
      );
    }
    expect(() =>
      systemReleaseValues({
        ...input,
        apiImage: 'ghcr.io/anycloud-sh/api:0.1.64',
      }),
    ).toThrow('digest-pinned');
    expect(() => systemReleaseValues({ ...input, revision: 0 })).toThrow(
      'positive',
    );
  });

  it('hashes values deterministically', () => {
    expect(valuesSha256(systemReleaseValues(input))).toBe(
      valuesSha256(systemReleaseValues({ ...input })),
    );
    expect(valuesSha256(systemReleaseValues(input))).not.toBe(
      valuesSha256(systemReleaseValues({ ...input, revision: 4 })),
    );
  });

  describe('comparison against the cluster', () => {
    const desired = buildSystemReleaseHelmChart(input);

    it('applies when the cluster has no release', () => {
      expect(compareReleaseIntent(null, desired)).toEqual({ action: 'apply' });
    });

    it('applies a strictly newer revision of the same installation', () => {
      expect(
        compareReleaseIntent(
          observed({
            [RELEASE_REVISION_ANNOTATION]: '2',
            [RELEASE_OPERATION_ANNOTATION]: 'op-2',
            [RELEASE_INSTALLATION_ANNOTATION]: 'install-1',
          }),
          desired,
        ),
      ).toEqual({ action: 'apply' });
    });

    it('treats the same revision and operation as current', () => {
      expect(
        compareReleaseIntent(
          observed({
            [RELEASE_REVISION_ANNOTATION]: '3',
            [RELEASE_OPERATION_ANNOTATION]: 'op-3',
            [RELEASE_INSTALLATION_ANNOTATION]: 'install-1',
          }),
          desired,
        ),
      ).toEqual({ action: 'current' });
    });

    it('refuses an older revision, a different operation at the same revision, a foreign installation and an unlabelled release', () => {
      expect(
        compareReleaseIntent(
          observed({
            [RELEASE_REVISION_ANNOTATION]: '4',
            [RELEASE_OPERATION_ANNOTATION]: 'op-4',
            [RELEASE_INSTALLATION_ANNOTATION]: 'install-1',
          }),
          desired,
        ),
      ).toMatchObject({
        action: 'refuse',
        reason: expect.stringContaining('newer'),
      });
      expect(
        compareReleaseIntent(
          observed({
            [RELEASE_REVISION_ANNOTATION]: '3',
            [RELEASE_OPERATION_ANNOTATION]: 'op-other',
            [RELEASE_INSTALLATION_ANNOTATION]: 'install-1',
          }),
          desired,
        ),
      ).toMatchObject({
        action: 'refuse',
        reason: expect.stringContaining('different operation'),
      });
      expect(
        compareReleaseIntent(
          observed({
            [RELEASE_REVISION_ANNOTATION]: '1',
            [RELEASE_OPERATION_ANNOTATION]: 'op-1',
            [RELEASE_INSTALLATION_ANNOTATION]: 'install-other',
          }),
          desired,
        ),
      ).toMatchObject({
        action: 'refuse',
        reason: expect.stringContaining('install-other'),
      });
      expect(compareReleaseIntent(observed({}), desired)).toMatchObject({
        action: 'refuse',
        reason: expect.stringContaining('no AnyCloud revision'),
      });
    });
  });
});

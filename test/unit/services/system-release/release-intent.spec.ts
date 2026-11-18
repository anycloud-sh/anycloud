import { describe, expect, it } from 'vitest';
import {
  buildSystemReleaseHelmChart,
  systemReleaseValues,
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
  apiUrl: 'http://203.0.113.9:30080',
  chart: `oci://ghcr.io/anycloud-sh/api-k8-chart@sha256:${'c'.repeat(64)}`,
  helmJobImage: SYSTEM_RELEASE_HELM_JOB_IMAGE,
  backup: null,
  restoreFromBackup: false,
};

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
});

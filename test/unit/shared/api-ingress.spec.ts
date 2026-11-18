import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { API_TLS_SECRET } from '../../../src/shared/system-release.js';
import {
  API_INGRESS_RELEASE,
  apiIngressHelmChart,
  helmJobName,
  clusterApiUrl,
  clusterHostname,
  TRAEFIK_CHART_VERSION,
} from '../../../src/shared/api-ingress.js';
import { generateClusterId } from '../../../src/shared/id-generator.js';

describe('API ingress on the management Node', () => {
  it('names the API after the installation id under anycloud.sh, which is DNS-safe and unique', () => {
    const id = generateClusterId('Production API!');
    expect(clusterHostname(id)).toBe(`${id}.anycloud.sh`);
    expect(clusterApiUrl(id)).toBe(`https://${id}.anycloud.sh`);
    expect(id).toMatch(/^[a-z0-9-]+$/);
  });

  it("renders the API's own bootstrap Traefik release on the management Node, host ports 443 and 80, API namespace only", () => {
    const chart = apiIngressHelmChart();
    // A bootstrap chart: helm-controller's install Job tolerates the
    // control-plane taint only for those (F run 13: K3s's packaged traefik,
    // not bootstrap, never scheduled). The Job name stays under 63 bytes.
    expect(chart).toMatchObject({
      apiVersion: 'helm.cattle.io/v1',
      kind: 'HelmChart',
      metadata: { name: API_INGRESS_RELEASE, namespace: 'kube-system' },
      spec: {
        repo: 'https://traefik.github.io/charts',
        chart: 'traefik',
        version: TRAEFIK_CHART_VERSION,
        targetNamespace: API_INGRESS_RELEASE,
        createNamespace: true,
        bootstrap: true,
      },
    });
    expect(TRAEFIK_CHART_VERSION).toBe('37.1.1');
    expect(helmJobName(API_INGRESS_RELEASE).length).toBeLessThanOrEqual(63);
    const values = chart.spec.valuesContent;
    expect(values).toContain(`fullnameOverride: ${API_INGRESS_RELEASE}`);
    // The label only the API sets, never the Node's own.
    expect(load(values)).toMatchObject({
      nodeSelector: {
        'node-restriction.kubernetes.io/anycloud-management': 'true',
      },
    });
    expect(values).not.toContain('anycloud.sh/cluster-management');
    // The API and its hook Jobs select the same label.
    const chartValues = load(
      readFileSync(
        new URL('../../../charts/anycloud-api/values.yaml', import.meta.url),
        'utf8',
      ),
    ) as { api: { nodeSelector: Record<string, string> } };
    expect(chartValues.api.nodeSelector).toEqual(
      (load(values) as { nodeSelector: Record<string, string> }).nodeSelector,
    );
    expect(values).toContain(
      '- { key: node-role.kubernetes.io/control-plane, operator: Exists, effect: NoSchedule }',
    );
    expect(values).toContain(
      'web: { port: 8000, hostPort: 80, expose: { default: true } }',
    );
    expect(values).toContain(
      'websecure: { port: 8443, hostPort: 443, expose: { default: true } }',
    );
    // The host ports leave no room for a surge Pod: replace, don't surge.
    expect(load(values)).toMatchObject({
      updateStrategy: {
        type: 'RollingUpdate',
        rollingUpdate: { maxUnavailable: 1, maxSurge: 0 },
      },
    });
    expect(values).toContain('service: { type: ClusterIP }');
    expect(values).toContain('dashboard: { enabled: false }');
    expect(values).toContain(
      'kubernetesCRD: { enabled: true, namespaces: [anycloud-system] }',
    );
    expect(values).toContain('kubernetesIngress: { enabled: false }');
  });

  it("routes the hostname on 443 with the installer's certificate Secret, and on 80 until the flip", () => {
    const routes = readFileSync(
      new URL(
        '../../../charts/anycloud-api/templates/ingress.yaml',
        import.meta.url,
      ),
      'utf8',
    ).split('\n---\n');
    expect(routes).toHaveLength(2);
    expect(routes[0]).toContain('- websecure');
    expect(routes[0]).toContain(`secretName: ${API_TLS_SECRET}`);
    expect(routes[1]).toContain('- web\n');
    expect(routes[1]).not.toContain('tls:');
    for (const route of routes) {
      expect(route).toContain(
        'match: Host({{ .Values.ingress.host | quote }})',
      );
    }
  });
});

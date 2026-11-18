import {
  CONTROL_PLANE_TAINT_KEY,
  MANAGEMENT_MEMBER_LABEL,
  SYSTEM_RELEASE_NAMESPACE,
} from './system-release.js';

/** Public DNS zone every hosted API is published under. */
const API_HOSTNAME_ZONE = 'anycloud.sh';

/**
 * The installation id is the subdomain: ids are lowercase, digits and
 * hyphens and unique, so the record cannot collide at the DNS Worker and is
 * DNS-safe. The management VM's address is stable for its life, so the record
 * is created once at bootstrap and never re-pointed.
 */
export function clusterHostname(installationId: string): string {
  return `${installationId}.${API_HOSTNAME_ZONE}`;
}

export function clusterApiUrl(installationId: string): string {
  return `https://${clusterHostname(installationId)}`;
}

/**
 * Pinned Traefik chart for the API's ingress release; content-pinned after the first
 * live run. helm-controller derives its install Job from the release name
 * (`helm-install-<name>`, 63-byte cap), so release names stay short.
 */
const TRAEFIK_CHART_REPO = 'https://traefik.github.io/charts';
export const TRAEFIK_CHART_VERSION = '37.1.1';
/** helm-controller's install Job for a HelmChart; the one place the rule lives. */
export function helmJobName(release: string): string {
  return `helm-install-${release}`;
}

/** The API's own Traefik release: HelmChart, Helm release and target namespace. */
export const API_INGRESS_RELEASE = 'anycloud-api-ingress';

/** The Traefik CRD the API chart's IngressRoutes need, Established before it installs. */
export const API_INGRESS_CRD = 'ingressroutes.traefik.io';

export interface HelmChartResource {
  apiVersion: 'helm.cattle.io/v1';
  kind: 'HelmChart';
  metadata: { name: string; namespace: string; labels: Record<string, string> };
  spec: {
    repo: string;
    chart: string;
    version: string;
    targetNamespace: string;
    createNamespace: boolean;
    /**
     * helm-controller gives its install Job tolerations only for bootstrap
     * charts; the management Node carries the control-plane taint, so a
     * non-bootstrap Job (K3s's own packaged traefik included) never schedules.
     */
    bootstrap: true;
    valuesContent: string;
  };
}

/**
 * Traefik for the API only, on the management Node: tolerate the control-plane
 * taint, select the management Node, serve the installation's Origin CA
 * certificate on host port 443 and plain HTTP on 80 until the zone flip,
 * ClusterIP (servicelb stays disabled), no dashboard, and only the
 * API namespace's IngressRoutes — pool ingress is each pool's own release. The
 * CRDs come from this release. The Pod holds the host ports on the one Node,
 * so a surge Pod could never bind them and a values change would stall: the
 * rollout replaces the Pod instead, costing a few seconds on 80 and 443.
 */
function apiIngressTraefikValues(): string {
  return [
    `fullnameOverride: ${API_INGRESS_RELEASE}`,
    `nodeSelector: { ${MANAGEMENT_MEMBER_LABEL}: 'true' }`,
    'tolerations:',
    `  - { key: ${CONTROL_PLANE_TAINT_KEY}, operator: Exists, effect: NoSchedule }`,
    'ports:',
    '  web: { port: 8000, hostPort: 80, expose: { default: true } }',
    '  websecure: { port: 8443, hostPort: 443, expose: { default: true } }',
    '  traefik: { expose: { default: false } }',
    'updateStrategy:',
    '  type: RollingUpdate',
    '  rollingUpdate: { maxUnavailable: 1, maxSurge: 0 }',
    'service: { type: ClusterIP }',
    'ingressClass: { enabled: false }',
    'ingressRoute: { dashboard: { enabled: false } }',
    'providers:',
    `  kubernetesCRD: { enabled: true, namespaces: [${SYSTEM_RELEASE_NAMESPACE}] }`,
    '  kubernetesIngress: { enabled: false }',
    'globalArguments: []',
    '',
  ].join('\n');
}

export function apiIngressHelmChart(): HelmChartResource {
  if (helmJobName(API_INGRESS_RELEASE).length > 63) {
    throw new Error('API ingress release name overflows the Job name cap');
  }
  return {
    apiVersion: 'helm.cattle.io/v1',
    kind: 'HelmChart',
    metadata: {
      name: API_INGRESS_RELEASE,
      namespace: 'kube-system',
      labels: { 'app.kubernetes.io/name': API_INGRESS_RELEASE },
    },
    spec: {
      repo: TRAEFIK_CHART_REPO,
      chart: 'traefik',
      version: TRAEFIK_CHART_VERSION,
      targetNamespace: API_INGRESS_RELEASE,
      createNamespace: true,
      bootstrap: true,
      valuesContent: apiIngressTraefikValues(),
    },
  };
}

import packageJson from '../../package.json' with { type: 'json' };

/**
 * Pinned toolchain for the API system release on a shared cluster.
 *
 * Every value here is an exact, immutable input: the K3s binary is verified by
 * SHA-256 before it runs, the bundled helm-controller version follows from that
 * K3s build, and the Helm Job image is digest-pinned. Bootstrap copies these
 * into the durable installation record before it mutates anything, so a later
 * CLI or API version cannot silently change what an existing cluster runs.
 *
 * Sources: the API Helm release proof (evidence commit 2d6ea4ce) and the
 * shared-cluster multicloud proof (a9780a90) both executed this exact K3s build
 * and Helm Job image. A bump re-captures `USER_NAMESPACE_BASE_SPEC` from its
 * containerd's `ctr oci spec` (RFC 0049 C32); the cloud check's drift row
 * fails until it does.
 */
export const SYSTEM_RELEASE_K3S_VERSION = 'v1.35.5+k3s1';
export const SYSTEM_RELEASE_K3S_SHA256 =
  '267d18da7b3c837d82283f0588fb9031a8a6ff3c0dac772c260c40852ce515f6';
// The bundled helm-controller (v0.17.1 in this K3s build) follows the K3s pin
// and is not installed separately.
export const SYSTEM_RELEASE_HELM_JOB_IMAGE =
  'mirror.gcr.io/rancher/klipper-helm:v0.10.0-build20260513@sha256:aa6dc50066508ce3940f511c318b810046c4f336c5c5edd3469c2f146a13731b';

/**
 * Where an API image names its own chart: a digest-pinned OCI reference
 * (`oci://<registry>/<path>/api-k8-chart@sha256:<digest>`), set when the image
 * is built (release.yml publishes the chart first). Bootstrap and an upgrade
 * read it from the target image's config, so the pinned image digest pins
 * its chart too; the running API reads its own from the environment.
 */
export const SYSTEM_RELEASE_CHART_ENV = 'ANYCLOUD_API_CHART';
/** The chart's name, and so its OCI package: `ghcr.io/anycloud-sh/api-k8-chart`. */
export const SYSTEM_RELEASE_CHART_NAME = 'api-k8-chart';
export const SYSTEM_RELEASE_NAMESPACE = 'anycloud-system';
export const SYSTEM_RELEASE_HELM_CHART_NAME = 'anycloud-api';
/** Container port the API listens on inside its Pod. */
export const SYSTEM_RELEASE_API_PORT = 8080;
export const SYSTEM_RELEASE_KUBERNETES_PORT = 6443;

/**
 * Set by the API, never the Node: NodeRestriction refuses a kubelet any
 * `node-restriction.kubernetes.io/` label on its own Node, so a pool Node
 * that re-registers with the control-plane taint still doesn't attract the
 * API, its hook Jobs or its Traefik, which select it.
 */
export const MANAGEMENT_MEMBER_LABEL =
  'node-restriction.kubernetes.io/anycloud-management';
/** The management VM's Node, which bootstrap names. */
export const MANAGEMENT_NODE_NAME = 'anycloud-management';
/** The `k3s` arguments that set the label, as root on the management VM. */
export const MANAGEMENT_LABEL_ARGS = `kubectl label node ${MANAGEMENT_NODE_NAME} ${MANAGEMENT_MEMBER_LABEL}=true --overwrite`;

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

function isImageDigest(value: string): boolean {
  return DIGEST_PATTERN.test(value);
}

/**
 * The digest-pinned API image reference recorded as release intent. Tags are
 * how a version is *found*; the digest is what the cluster is told to run.
 */
export function pinnedApiImage(version: string, digest: string): string {
  if (!isImageDigest(digest)) {
    throw new Error(`API image digest must be sha256:<64 hex>, got ${digest}`);
  }
  return `${packageJson.apiImage}:${version}@${digest}`;
}

export function apiImageTagReference(version: string): string {
  return `${packageJson.apiImage}:${version}`;
}

/** `oci://…/api-k8-chart@sha256:<digest>`: how a HelmChart names its chart. */
export function isPinnedChartReference(reference: string): boolean {
  const at = reference.lastIndexOf('@');
  return (
    reference.startsWith('oci://') &&
    reference.slice(0, at).endsWith(`/${SYSTEM_RELEASE_CHART_NAME}`) &&
    isImageDigest(reference.slice(at + 1))
  );
}

export function isPinnedApiImage(image: string): boolean {
  const at = image.lastIndexOf('@');
  return (
    at > 0 &&
    image.startsWith(`${packageJson.apiImage}:`) &&
    isImageDigest(image.slice(at + 1))
  );
}

/**
 * The standard control-plane taint keeps the management Node to the system
 * release while K3s's packaged CoreDNS, local-path provisioner and the helm-controller's bootstrap
 * install Job all tolerate it. A custom key would leave those Pending on a
 * single-node cluster (found by F run 4).
 */
export const CONTROL_PLANE_TAINT_KEY = 'node-role.kubernetes.io/control-plane';

/**
 * The apiserver dials kubelets (logs, exec, port-forward) by Node name. With
 * `egress-selector-mode: cluster` a name rides that Node's own tunnel session
 * and is never resolved in DNS; an address goes through K3s's address→Node
 * map, where the last Node to report an address wins. Azure pools and an
 * Azure management VM share 10.0.0.x private addresses, so an address dial
 * reached another pool's kubelet or, once that Node was deleted, hung.
 */
export const KUBELET_PREFERRED_ADDRESS_TYPES =
  'kubelet-preferred-address-types=Hostname,InternalIP,ExternalIP';

/** Where the hosted API serves its ServiceAccount issuer's keys (RFC 0047). */
export const SERVICE_ACCOUNT_ISSUER_JWKS_PATH = '/openid/v1/jwks';

/** The origin certificate Traefik serves, and anycloud's origin pull CA. */
export const API_TLS_SECRET = 'anycloud-api-tls';
export const API_TLS_CA_SECRET = 'anycloud-api-origin-pull-ca';

/** The API HelmChart's release annotations. */
export const RELEASE_REVISION_ANNOTATION = 'anycloud.sh/release-revision';
export const RELEASE_OPERATION_ANNOTATION = 'anycloud.sh/release-operation';
export const RELEASE_INSTALLATION_ANNOTATION = 'anycloud.sh/installation';

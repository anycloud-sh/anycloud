import { generateStartupScript } from '../vm-startup-script.js';
import {
  CONTROL_PLANE_TAINT_KEY,
  KUBELET_PREFERRED_ADDRESS_TYPES,
  MANAGEMENT_LABEL_ARGS,
  MANAGEMENT_NODE_NAME,
  SYSTEM_RELEASE_KUBERNETES_PORT,
} from '../../../shared/system-release.js';
import type { ClusterConnectionDocument } from '../kubernetes/cluster-connection.js';
import { SERVICE_ACCOUNT_ISSUER_JWKS_PATH } from '../../../shared/system-release.js';

/**
 * Shell delivered to the management VM. The startup script only prepares the host
 * (SSH access, verified K3s binary, disabled unit); Kubernetes is configured
 * and started over SSH once the public address is known, so the server
 * certificate carries the address the installer and workers connect to.
 * Every command here is idempotent: a resumed bootstrap re-runs it safely.
 */
const CONTROL_PLANE_TAINT = `${CONTROL_PLANE_TAINT_KEY}=true:NoSchedule`;
const MANAGEMENT_K3S_UNIT = 'k3s-anycloud.service';
const INSTALLER_SERVICE_ACCOUNT = 'anycloud-installer';
const INSTALLER_TOKEN_SECRET = 'anycloud-installer-token';
const K3S_BINARY = '/usr/local/bin/k3s';
const K3S_CONFIG = '/etc/rancher/k3s/config.yaml';
const K3S_SERVER_CA = '/var/lib/rancher/k3s/server/tls/server-ca.crt';
/** Present from a configuration change until K3s has restarted onto it. */
const K3S_RESTART_PENDING = `${K3S_CONFIG}.restart-pending`;

/** K3s's issuer when none is configured (`https://kubernetes.default.svc.<cluster-domain>`). */
const K3S_DEFAULT_SERVICE_ACCOUNT_ISSUER =
  'https://kubernetes.default.svc.cluster.local';

function shellQuote(value: string): string {
  return `'${value.split("'").join(`'"'"'`)}'`;
}

export interface ManagementHostStartupInput {
  sshPublicKey: string;
  k3sVersion: string;
  k3sSha256: string;
}

export function managementHostStartupScript(
  input: ManagementHostStartupInput,
): string {
  if (!/^v\d+\.\d+\.\d+\+k3s\d+$/.test(input.k3sVersion)) {
    throw new Error(`Unexpected K3s version ${input.k3sVersion}`);
  }
  if (!/^[a-f0-9]{64}$/.test(input.k3sSha256)) {
    throw new Error('K3s SHA-256 must be 64 hex characters');
  }
  const download = `https://github.com/k3s-io/k3s/releases/download/${encodeURIComponent(input.k3sVersion)}/k3s`;
  return `${generateStartupScript({ publicKey: input.sshPublicKey, privateKey: '' })}
set -euo pipefail
umask 077
if ! echo ${shellQuote(`${input.k3sSha256}  ${K3S_BINARY}`)} | sha256sum -c - >/dev/null 2>&1; then
  curl --fail --location --retry 5 --max-time 300 ${shellQuote(download)} -o ${K3S_BINARY}.download
  echo ${shellQuote(`${input.k3sSha256}  ${K3S_BINARY}.download`)} | sha256sum -c -
  chmod 755 ${K3S_BINARY}.download
  mv -f ${K3S_BINARY}.download ${K3S_BINARY}
fi
mkdir -p /etc/rancher/k3s
cat > /etc/systemd/system/${MANAGEMENT_K3S_UNIT} <<'UNIT'
[Unit]
Description=AnyCloud cluster
After=network-online.target
Wants=network-online.target
[Service]
Type=notify
ExecStart=${K3S_BINARY} server
KillMode=process
Delegate=yes
Restart=always
RestartSec=5
LimitNOFILE=1048576
LimitNPROC=infinity
TasksMax=infinity
TimeoutStartSec=300
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
echo "management host prepared"
`;
}

export interface ManagementKubernetesConfigureInput {
  serverToken: string;
  publicIp: string;
  /** The hosted API's public URL, which serves the ServiceAccount issuer. */
  issuerUrl: string;
}

/**
 * Write the K3s server configuration and start it. Public ingress components
 * are disabled: the API's public route is an open decision and Jobs capacity
 * is outbound-only. CoreDNS and the local-path provisioner stay on for the
 * API release's own DNS and retained state claim.
 */
/** Where the staged K3s server configuration is written over the transport's stdin channel. */
export const MANAGEMENT_K3S_CONFIG_STAGING_PATH = `${K3S_CONFIG}.new`;

/**
 * The K3s server configuration, written to the staging path over
 * `writeFile` (channel stdin) so the server token never appears on a remote
 * command line or in a process list.
 */
export function managementKubernetesConfig(
  input: ManagementKubernetesConfigureInput,
): string {
  if (!SERVER_TOKEN_PATTERN.test(input.serverToken)) {
    throw new Error('Management server token contains unexpected characters');
  }
  return `token: ${input.serverToken}\n${managementKubernetesConfigBody(input)}`;
}

/** The characters bootstrap's server token is drawn from. */
const SERVER_TOKEN_PATTERN = /^[A-Za-z0-9._:-]+$/;

/** The configuration after its `token:` line, which carries no secret. */
function managementKubernetesConfigBody(
  input: Omit<ManagementKubernetesConfigureInput, 'serverToken'>,
): string {
  if (!/^[A-Za-z0-9._:-]+$/.test(input.publicIp)) {
    throw new Error('Management public address contains unexpected characters');
  }
  if (!/^https:\/\/[a-z0-9.-]+$/.test(input.issuerUrl)) {
    throw new Error('Management issuer URL contains unexpected characters');
  }
  return [
    `node-name: ${MANAGEMENT_NODE_NAME}`,
    'node-taint:',
    `  - '${CONTROL_PLANE_TAINT}'`,
    // K3s's own traefik is off: its install Job is not a bootstrap chart, so
    // it never schedules onto the tainted management Node. Bootstrap renders
    // the API's own Traefik release instead (src/shared/api-ingress.ts).
    'disable:',
    '  - traefik',
    '  - servicelb',
    '  - metrics-server',
    'disable-cloud-controller: true',
    // Agents join through the address they are given and then re-point their
    // supervisor tunnel to the address the apiserver advertises; without these
    // it advertises the private interface, unreachable from a pool in another
    // cloud, and the tunnel dies. With `cluster` mode apiserver → kubelet reads
    // ride that tunnel, so nothing ever needs 10250 ingress into pool VMs.
    `advertise-address: ${input.publicIp}`,
    `node-external-ip: ${input.publicIp}`,
    'egress-selector-mode: cluster',
    'kube-apiserver-arg:',
    `  - ${KUBELET_PREFERRED_ADDRESS_TYPES}`,
    // Role connections trust the public issuer, which the API serves (RFC
    // 0047 § Issuer prerequisite). Kubernetes signs with the first issuer and
    // accepts every one listed, so K3s's own default stays second and tokens
    // already issued stay valid.
    `  - service-account-issuer=${input.issuerUrl}`,
    `  - service-account-issuer=${K3S_DEFAULT_SERVICE_ACCOUNT_ISSUER}`,
    `  - service-account-jwks-uri=${input.issuerUrl}${SERVICE_ACCOUNT_ISSUER_JWKS_PATH}`,
    // Pod traffic between the cluster and a pool in another cloud has to use the
    // public addresses; that needs 8472/udp between cluster and pool public IPs
    // only when Pods talk across clouds, which Jobs and node-pool Services do
    // not today.
    'flannel-external-ip: true',
    'tls-san:',
    `  - ${input.publicIp}`,
    '',
  ].join('\n');
}

/**
 * Activate the staged configuration. Carries no secret: the configuration
 * itself arrived through `writeFile`. Exit 64 while the boot-time preparation
 * has not produced the binary yet. A changed configuration leaves a marker
 * until K3s has restarted onto it, so a run interrupted between the two
 * restarts on the next one.
 */
export const MANAGEMENT_KUBERNETES_CONFIGURE_COMMAND = `set -euo pipefail
umask 077
if [ ! -x ${K3S_BINARY} ]; then echo 'k3s binary is not prepared' >&2; exit 64; fi
if [ ! -s ${MANAGEMENT_K3S_CONFIG_STAGING_PATH} ]; then echo 'staged configuration is missing' >&2; exit 66; fi
if ! cmp -s ${MANAGEMENT_K3S_CONFIG_STAGING_PATH} ${K3S_CONFIG} 2>/dev/null; then
  touch ${K3S_RESTART_PENDING}
  mv -f ${MANAGEMENT_K3S_CONFIG_STAGING_PATH} ${K3S_CONFIG}
else
  rm -f ${MANAGEMENT_K3S_CONFIG_STAGING_PATH}
fi
systemctl daemon-reload
systemctl enable --now ${MANAGEMENT_K3S_UNIT}
if [ -e ${K3S_RESTART_PENDING} ]; then
  systemctl restart ${MANAGEMENT_K3S_UNIT}
  rm -f ${K3S_RESTART_PENDING}
fi`;

/** Label the management Node with what only the API sets, as root. */
export const MANAGEMENT_LABEL_COMMAND = `${K3S_BINARY} ${MANAGEMENT_LABEL_ARGS}`;

/**
 * Poll the API server's readiness endpoint through the local kubectl. Once it
 * answers, label the management Node, so create and every reconfigure set it
 * before a release depends on it.
 */
export const MANAGEMENT_KUBERNETES_READY_COMMAND = `set -eu
if [ "$(${K3S_BINARY} kubectl get --raw=/readyz --request-timeout=10s 2>/dev/null)" = "ok" ]; then
  ${MANAGEMENT_LABEL_COMMAND} --request-timeout=10s >/dev/null
  ${K3S_BINARY} kubectl get node ${MANAGEMENT_NODE_NAME} --request-timeout=10s -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}'
else
  echo NotReady
fi`;

/** How long the host-step reconfiguration waits for `/readyz`, as create does. */
const MANAGEMENT_RECONFIGURE_READY_SECONDS = 300;
/** The server token in the host's configuration is missing or malformed. */
const MANAGEMENT_RECONFIGURE_TOKEN_EXIT = 65;
/** Another step held the lock too long, or Kubernetes wasn't ready in time. */
const MANAGEMENT_RECONFIGURE_TIMEOUT_EXIT = 75;
/** The step ends itself by then, under the unit's limit (host-step.ts). */
const MANAGEMENT_RECONFIGURE_MAX_SECONDS = 13 * 60;

/**
 * The K3s step of `api upgrade` (RFC 0049 C26 (b)), run as root on the
 * management host by the host-step Job. It labels the management Node,
 * renders this release's server configuration with the `token:`
 * the host's own configuration holds, so no copy of the token travels, then
 * activates it and waits for `/readyz`. One step runs at a time; it prints
 * `configuration=changed` or `configuration=current`.
 */
export function managementKubernetesReconfigureScript(
  input: Omit<ManagementKubernetesConfigureInput, 'serverToken'>,
): string {
  const body = managementKubernetesConfigBody(input);
  return `set -euo pipefail
umask 077
started=$(date +%s)
exec 9>/run/anycloud-kubernetes-reconfigure.lock
if ! flock -w 120 9; then echo 'another K3s step held the lock for 2 minutes' >&2; exit ${MANAGEMENT_RECONFIGURE_TIMEOUT_EXIT}; fi
${MANAGEMENT_LABEL_COMMAND} --request-timeout=30s >/dev/null
token=$( (sed -n 's/^token: //p' ${K3S_CONFIG} | head -n 1) 2>/dev/null || true)
if ! [[ $token =~ ${SERVER_TOKEN_PATTERN.source} ]]; then
  echo 'the server token in ${K3S_CONFIG} is missing or malformed' >&2
  exit ${MANAGEMENT_RECONFIGURE_TOKEN_EXIT}
fi
{ printf 'token: %s\n' "$token"; cat <<'CONFIG'
${body}CONFIG
} > ${MANAGEMENT_K3S_CONFIG_STAGING_PATH}
if cmp -s ${MANAGEMENT_K3S_CONFIG_STAGING_PATH} ${K3S_CONFIG} && [ ! -e ${K3S_RESTART_PENDING} ]; then
  echo configuration=current
else
  echo configuration=changed
fi
${MANAGEMENT_KUBERNETES_CONFIGURE_COMMAND}
deadline=$(( $(date +%s) + ${MANAGEMENT_RECONFIGURE_READY_SECONDS} ))
if [ "$deadline" -gt $(( started + ${MANAGEMENT_RECONFIGURE_MAX_SECONDS} )) ]; then deadline=$(( started + ${MANAGEMENT_RECONFIGURE_MAX_SECONDS} )); fi
until [ "$( (${MANAGEMENT_KUBERNETES_READY_COMMAND}) 2>/dev/null || true)" = True ]; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo 'Kubernetes did not become ready within ${MANAGEMENT_RECONFIGURE_READY_SECONDS / 60} minutes' >&2
    exit ${MANAGEMENT_RECONFIGURE_TIMEOUT_EXIT}
  fi
  sleep 5
done`;
}

/** Whether the K3s step changed the configuration; null when it didn't say. */
export function parseManagementReconfigure(
  output: string,
): 'changed' | 'current' | null {
  const match = /^configuration=(changed|current)$/m.exec(output);
  return (match?.[1] as 'changed' | 'current' | undefined) ?? null;
}

/**
 * Create the installer's installer access identity and print the material for an
 * allow-listed kubeconfig: inline CA and an inline ServiceAccount token. The
 * cluster-admin client certificate K3s writes for its own kubectl never
 * leaves the host.
 */
export const INSTALLER_ACCESS_READ_COMMAND = `set -euo pipefail
${K3S_BINARY} kubectl apply -f - >/dev/null <<'ACCESS'
apiVersion: v1
kind: ServiceAccount
metadata:
  name: ${INSTALLER_SERVICE_ACCOUNT}
  namespace: kube-system
---
apiVersion: v1
kind: Secret
metadata:
  name: ${INSTALLER_TOKEN_SECRET}
  namespace: kube-system
  annotations:
    kubernetes.io/service-account.name: ${INSTALLER_SERVICE_ACCOUNT}
type: kubernetes.io/service-account-token
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: ${INSTALLER_SERVICE_ACCOUNT}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: cluster-admin
subjects:
  - kind: ServiceAccount
    name: ${INSTALLER_SERVICE_ACCOUNT}
    namespace: kube-system
ACCESS
for attempt in $(seq 1 60); do
  token=$(${K3S_BINARY} kubectl -n kube-system get secret ${INSTALLER_TOKEN_SECRET} -o jsonpath='{.data.token}' 2>/dev/null || true)
  if [ -n "$token" ]; then break; fi
  sleep 1
done
if [ -z "$token" ]; then echo 'installer access token was not issued' >&2; exit 65; fi
printf '{"certificateAuthorityData":"%s","token":"%s"}\\n' "$(base64 -w0 < ${K3S_SERVER_CA})" "$(printf '%s' "$token" | base64 -d)"`;

export interface InstallerAccessMaterial {
  certificateAuthorityData: string;
  token: string;
}

export function parseInstallerAccessMaterial(
  stdout: string,
): InstallerAccessMaterial {
  const line = stdout.trim().split('\n').pop() ?? '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error('Installer access material is not valid JSON');
  }
  const record = parsed as Record<string, unknown>;
  const ca = record.certificateAuthorityData;
  const token = record.token;
  if (typeof ca !== 'string' || !ca || typeof token !== 'string' || !token) {
    throw new Error('Installer access material is incomplete');
  }
  return { certificateAuthorityData: ca, token };
}

/** The installer's own connection: the public endpoint and the installer ServiceAccount token. */
export function installerConnectionDocument(input: {
  publicIp: string;
  material: InstallerAccessMaterial;
}): ClusterConnectionDocument {
  return {
    kind: 'installer',
    server: `https://${input.publicIp}:${SYSTEM_RELEASE_KUBERNETES_PORT}`,
    certificateAuthorityData: input.material.certificateAuthorityData,
    credential: { kind: 'token', token: input.material.token },
  };
}

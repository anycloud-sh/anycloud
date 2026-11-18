import { gzipSync } from 'node:zlib';
import {
  API_TLS_CA_SECRET,
  API_TLS_SECRET,
  CONTROL_PLANE_TAINT_KEY,
  KUBELET_PREFERRED_ADDRESS_TYPES,
  MANAGEMENT_LABEL_ARGS,
  MANAGEMENT_NODE_NAME,
  RELEASE_INSTALLATION_ANNOTATION,
  RELEASE_OPERATION_ANNOTATION,
  RELEASE_REVISION_ANNOTATION,
  SERVICE_ACCOUNT_ISSUER_JWKS_PATH,
  SYSTEM_RELEASE_HELM_CHART_NAME,
  SYSTEM_RELEASE_KUBERNETES_PORT,
  SYSTEM_RELEASE_NAMESPACE,
} from './system-release.js';
import {
  API_INGRESS_CRD,
  API_INGRESS_RELEASE,
  apiIngressHelmChart,
  clusterApiUrl,
  clusterHostname,
} from './api-ingress.js';

/**
 * The management VM's whole bootstrap (RFC 0049 C26 (e), the seed design of
 * 2026-11-07): one script the cloud runs at first boot (AWS user-data, Azure
 * customData, the GCP startup-script), with no SSH and nothing secret in it.
 * It installs the pinned K3s with a server token it makes itself, renders the
 * API's Traefik and HelmChart (created once, never re-applied), labels the
 * Node, keeps every Pod but the API's off the cloud's metadata service,
 * makes its own TLS key and CSR, and asks the DNS Worker for the origin
 * certificate, which the Worker issues only to the hostname's A record IP.
 * Every step is idempotent: a reboot re-runs the script safely.
 */

type BootCloud = 'aws' | 'gcp' | 'azure';

/** Filled in on the VM, where K3s first knows them. */
export const BOOT_PLACEHOLDERS = {
  publicIp: '@@ANYCLOUD_PUBLIC_IP@@',
  /** As the gateways record it: the AWS instance ID, the GCP or Azure VM name. */
  managementVmId: '@@ANYCLOUD_MANAGEMENT_VM_ID@@',
  kubernetesIdentity: '@@ANYCLOUD_KUBE_SYSTEM_UID@@',
  certificateAuthorityData: '@@ANYCLOUD_CLUSTER_CA@@',
} as const;

export interface ManagementBootInput {
  cloud: BootCloud;
  clusterId: string;
  k3sVersion: string;
  k3sSha256: string;
  /**
   * The API's release: the chart values (never secret; `selfDelete`
   * included), which may carry `BOOT_PLACEHOLDERS` the VM fills in, and the
   * HelmChart's pinned chart, helm Job image, revision and operation.
   */
  release: {
    values: Readonly<Record<string, unknown>>;
    chart: string;
    jobImage: string;
    revision: number;
    operationId: string;
  };
  /** The DNS Worker's base URL. */
  workerUrl: string;
  /**
   * Test-only (`ANYCLOUD_E2E_ACCESS`): a ServiceAccount for the e2e harness,
   * whose kubeconfig the API hands to the harness (lane S7).
   */
  e2eAccess?: boolean;
}

/**
 * Where the e2e harness's kubeconfig waits on the host for the API to collect.
 * @public (lane S7)
 */
export const E2E_ACCESS_KUBECONFIG_PATH =
  '/var/lib/anycloud/e2e-access/kubeconfig';

const K3S_BINARY = '/usr/local/bin/k3s';
const K3S_CONFIG = '/etc/rancher/k3s/config.yaml';
const K3S_SERVER_CA = '/var/lib/rancher/k3s/server/tls/server-ca.crt';
const K3S_UNIT = 'k3s-anycloud.service';
const STATE = '/var/lib/anycloud/boot';
/** How long the boot waits for Traefik's CRD, as the 0.1.73 installer did. */
const CRD_WAIT_SECONDS = 180;
/** helm-controller's 600 s install timeout, plus the Job's start. */
const RELEASE_WAIT_SECONDS = 15 * 60;
/** The boot's exit when the API release failed; the unit doesn't restart on it. */
const RELEASE_FAILED_EXIT = 70;
const HELM_INSTALL_JOB_NAME = `helm-install-${SYSTEM_RELEASE_HELM_CHART_NAME}`;
const BOOT_UNIT = 'anycloud-boot.service';
/** The API's Pods, which alone reach the metadata service (the chart's selector label). */
const API_POD_LABEL = 'app.kubernetes.io/name';
const API_POD_NAME = 'anycloud-api';
const METADATA_IP = '169.254.169.254/32';

function shellQuote(value: string): string {
  return `'${value.split("'").join(`'"'"'`)}'`;
}

/** Logged on Azure only, to show what IMDS reports for a Standard SKU address. */
const AZURE_IMDS_PUBLIC_IP = `curl -sf -H 'Metadata: true' 'http://169.254.169.254/metadata/instance/network/interface/0/ipv4/ipAddress/0/publicIpAddress?api-version=2021-02-01&format=text'`;

/** The VM's public address from its cloud's metadata service, as the host sees it. */
const PUBLIC_IP_COMMAND: Record<BootCloud, string> = {
  aws: `t=$(curl -sf -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token) && curl -sf -H "X-aws-ec2-metadata-token: $t" http://169.254.169.254/latest/meta-data/public-ipv4`,
  gcp: `curl -sf -H 'Metadata-Flavor: Google' http://169.254.169.254/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip`,
  // IMDS leaves a Standard SKU address out of the network data, so the seed
  // passes it in the VM's userData.
  azure: `curl -sf -H 'Metadata: true' 'http://169.254.169.254/metadata/instance/compute/userData?api-version=2021-01-01&format=text' | base64 -d`,
};

/**
 * The VM's native ID in the gateways' own form (`cloudId`): the EC2 instance
 * ID on AWS, the instance name on GCP and the VM name on Azure.
 */
const VM_ID_COMMAND: Record<BootCloud, string> = {
  aws: `t=$(curl -sf -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token) && curl -sf -H "X-aws-ec2-metadata-token: $t" http://169.254.169.254/latest/meta-data/instance-id`,
  gcp: `curl -sf -H 'Metadata-Flavor: Google' http://169.254.169.254/computeMetadata/v1/instance/name`,
  azure: `curl -sf -H 'Metadata: true' 'http://169.254.169.254/metadata/instance/compute/name?api-version=2021-02-01&format=text'`,
};

/**
 * Every Pod on the management Node except the API's loses the metadata
 * service, which hands out the VM identity that writes the checkpoint bucket.
 * K3s enforces NetworkPolicy (kube-router); pool Pods run on pool VMs.
 */
/** Every namespace whose Pods run on the management Node. */
const MANAGEMENT_NAMESPACES = [
  'kube-system',
  SYSTEM_RELEASE_NAMESPACE,
  API_INGRESS_RELEASE,
  'default',
];

function metadataPolicies(): object[] {
  return MANAGEMENT_NAMESPACES.map((namespace) => ({
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: { name: 'anycloud-no-metadata', namespace },
    spec: {
      podSelector: {
        matchExpressions: [
          { key: API_POD_LABEL, operator: 'NotIn', values: [API_POD_NAME] },
        ],
      },
      policyTypes: ['Egress'],
      egress: [
        { to: [{ ipBlock: { cidr: '0.0.0.0/0', except: [METADATA_IP] } }] },
        // On GCP the same address is the VPC's DNS resolver, which
        // CoreDNS forwards to: only its DNS stays open.
        {
          to: [{ ipBlock: { cidr: METADATA_IP } }],
          ports: [
            { protocol: 'UDP', port: 53 },
            { protocol: 'TCP', port: 53 },
          ],
        },
      ],
    },
  }));
}

/** The API's HelmChart, as system-release-values.ts builds it for an upgrade. */
function apiHelmChart(input: ManagementBootInput): object {
  const { release } = input;
  return {
    apiVersion: 'helm.cattle.io/v1',
    kind: 'HelmChart',
    metadata: {
      name: SYSTEM_RELEASE_HELM_CHART_NAME,
      namespace: SYSTEM_RELEASE_NAMESPACE,
      annotations: {
        [RELEASE_REVISION_ANNOTATION]: String(release.revision),
        [RELEASE_OPERATION_ANNOTATION]: release.operationId,
        [RELEASE_INSTALLATION_ANNOTATION]: input.clusterId,
      },
    },
    spec: {
      chart: release.chart,
      targetNamespace: SYSTEM_RELEASE_NAMESPACE,
      createNamespace: true,
      jobImage: release.jobImage,
      bootstrap: true,
      failurePolicy: 'abort',
      backOffLimit: 0,
      timeout: '600s',
      valuesContent: JSON.stringify(release.values),
    },
  };
}

/** A namespace manifest, so the policies and Secrets apply before the chart. */
function namespaceManifests(): object[] {
  return [SYSTEM_RELEASE_NAMESPACE, API_INGRESS_RELEASE].map((name) => ({
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: { name },
  }));
}

/**
 * Every object of the e2e access identity carries it: the cluster shows it ran e2e.
 * @public (lane S7)
 */
export const E2E_ACCESS_LABEL = 'anycloud.sh/e2e-access';
const E2E_ACCESS_NAME = 'anycloud-e2e-access';

/**
 * Exactly what the e2e harness's checks call (test/integration/e2e), as
 * `[apiGroup, resource, verbs]`, no wildcards: cluster-wide reads, Pod
 * deletion and ServiceAccount tokens; a namespaced Role for the rest.
 * kube-system holds the host shell and victim Pods and the victim's Secret;
 * the role live checks mint the API's and the trust probe's tokens in
 * anycloud-system, plus the Helm state a timed-out hosted upgrade's capture
 * lists.
 */
const E2E_ACCESS_ROLES: Record<string, [string, string, string[]][]> = {
  '': [
    ['', 'nodes', ['get', 'list']],
    ['', 'pods', ['get', 'list', 'delete']],
    ['', 'pods/log', ['get']],
    ['', 'events', ['list']],
    ['', 'secrets', ['list']],
    ['', 'serviceaccounts/token', ['create']],
  ],
  'kube-system': [
    ['', 'pods', ['create']],
    ['', 'secrets', ['create', 'delete']],
    // What a timed-out hosted upgrade's capture reads: helm-controller's state.
    ['batch', 'jobs', ['list']],
    ['helm.cattle.io', 'helmcharts', ['list']],
  ],
  'kube-node-lease': [['coordination.k8s.io', 'leases', ['get']]],
  [SYSTEM_RELEASE_NAMESPACE]: [
    ['batch', 'jobs', ['list']],
    ['helm.cattle.io', 'helmcharts', ['list']],
  ],
};

function e2eAccessManifest(): string {
  const rbac = 'rbac.authorization.k8s.io/v1';
  const metadata = (namespace: string) => ({
    name: E2E_ACCESS_NAME,
    ...(namespace ? { namespace } : {}),
    labels: { [E2E_ACCESS_LABEL]: 'true' },
  });
  const items = Object.entries(E2E_ACCESS_ROLES).flatMap(
    ([namespace, rules]) => {
      const kind = namespace ? 'Role' : 'ClusterRole';
      return [
        {
          apiVersion: rbac,
          kind,
          metadata: metadata(namespace),
          rules: rules.map(([group, resource, verbs]) => ({
            apiGroups: [group],
            resources: [resource],
            verbs,
          })),
        },
        {
          apiVersion: rbac,
          kind: `${kind}Binding`,
          metadata: metadata(namespace),
          roleRef: {
            apiGroup: rbac.split('/')[0],
            kind,
            name: E2E_ACCESS_NAME,
          },
          subjects: [
            {
              kind: 'ServiceAccount',
              name: E2E_ACCESS_NAME,
              namespace: 'kube-system',
            },
          ],
        },
      ];
    },
  );
  const account = {
    apiVersion: 'v1',
    kind: 'ServiceAccount',
    metadata: metadata('kube-system'),
  };
  const secret = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      ...metadata('kube-system'),
      annotations: { 'kubernetes.io/service-account.name': E2E_ACCESS_NAME },
    },
    type: 'kubernetes.io/service-account-token',
  };
  return JSON.stringify({
    apiVersion: 'v1',
    kind: 'List',
    items: [account, secret, ...items],
  });
}

/** With an origin pull CA, the API's Traefik requires Cloudflare's client certificate. */
const ORIGIN_PULL_OPTION = {
  apiVersion: 'traefik.io/v1alpha1',
  kind: 'TLSOption',
  metadata: { name: 'default', namespace: SYSTEM_RELEASE_NAMESPACE },
  spec: {
    minVersion: 'VersionTLS12',
    clientAuth: {
      secretNames: [API_TLS_CA_SECRET],
      clientAuthType: 'RequireAndVerifyClientCert',
    },
  },
};

/**
 * The management VM's startup script: a pure function of the release, which
 * every cloud's seed embeds unchanged.
 */
export function managementBootScript(input: ManagementBootInput): string {
  // AWS user-data holds 16 KB raw; gzip keeps the script and its release
  // values well inside it, and every image has base64 and gunzip.
  const body = gzipSync(managementBootBody(input), { level: 9 }).toString(
    'base64',
  );
  // A systemd unit runs it, not cloud-init: AWS user-data and Azure
  // customData run once, and the unit retries a failed step and runs again
  // at every boot, as GCP's startup-script does.
  return `#!/bin/bash
# anycloud management VM bootstrap (${input.clusterId}), gzip and base64.
set -euo pipefail
umask 077
mkdir -p ${STATE}
base64 -d <<'ANYCLOUD_BOOT' | gunzip > ${STATE}/boot.sh.new
${body.replace(/.{1,76}/g, '$&\n')}ANYCLOUD_BOOT
mv -f ${STATE}/boot.sh.new ${STATE}/boot.sh
cat > /etc/systemd/system/${BOOT_UNIT} <<'UNIT'
[Unit]
Description=anycloud management VM bootstrap
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0
[Service]
Type=simple
ExecStart=/bin/bash ${STATE}/boot.sh
Restart=on-failure
RestartSec=15
RestartPreventExitStatus=${RELEASE_FAILED_EXIT}
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable ${BOOT_UNIT}
systemctl start --no-block ${BOOT_UNIT}
`;
}

/** The uncompressed script, which the VM runs. */
export function managementBootBody(input: ManagementBootInput): string {
  if (!/^v\d+\.\d+\.\d+\+k3s\d+$/.test(input.k3sVersion))
    throw new Error(`Unexpected K3s version ${input.k3sVersion}`);
  if (!/^[a-f0-9]{64}$/.test(input.k3sSha256))
    throw new Error('K3s SHA-256 must be 64 hex characters');
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(input.clusterId))
    throw new Error(`Unexpected cluster ID ${input.clusterId}`);
  if (!/^https:\/\/[a-z0-9.-]+$/.test(input.workerUrl))
    throw new Error(`Unexpected DNS Worker URL ${input.workerUrl}`);

  const hostname = clusterHostname(input.clusterId);
  const issuer = clusterApiUrl(input.clusterId);
  const download = `https://github.com/k3s-io/k3s/releases/download/${encodeURIComponent(input.k3sVersion)}/k3s`;
  // Created once if absent, never re-applied: the API upgrades its own
  // HelmChart, and a reboot must not roll that back.
  const manifests: Record<string, object> = {
    '20-ingress': apiIngressHelmChart(),
    '30-api': apiHelmChart(input),
  };
  // Applied on every run: nothing else owns them, and a partial apply heals.
  const applied: Record<string, object[]> = {
    '00-namespaces': namespaceManifests(),
    '10-no-metadata': metadataPolicies(),
  };
  // JSON is YAML; a list becomes one document per item.
  const render = (dir: string, set: Record<string, object | object[]>) =>
    Object.entries(set)
      .map(([name, documents]) => {
        const body = (Array.isArray(documents) ? documents : [documents])
          .map((document) => JSON.stringify(document))
          .join('\n---\n');
        return `cat > ${STATE}/${dir}/${name}.yaml <<'ANYCLOUD_MANIFEST'\n${body}\nANYCLOUD_MANIFEST`;
      })
      .join('\n');
  const appliedFiles = render('applied', applied);
  const files = render('manifests', manifests);
  const {
    publicIp,
    managementVmId,
    kubernetesIdentity,
    certificateAuthorityData,
  } = BOOT_PLACEHOLDERS;

  return `#!/bin/bash
# anycloud management VM bootstrap (${input.clusterId}); re-runnable.
set -euo pipefail
umask 077
mkdir -p ${STATE}/manifests ${STATE}/applied /etc/rancher/k3s
# Also to the serial console, where a failed create's capture reads it.
# Nothing here may print a secret: the console is readable with cloud read
# access. Without a console, the file alone.
if { echo "anycloud boot log: /var/log/anycloud-boot.log" >/dev/ttyS0; } 2>/dev/null; then
  exec > >(tee -a /var/log/anycloud-boot.log >/dev/ttyS0) 2>&1
  # systemd stops the unit's leftovers once this exits; let tee drain first.
  tee_pid=$!
  trap 'exec >&- 2>&-; wait "$tee_pid" || true' EXIT
else
  exec >>/var/log/anycloud-boot.log 2>&1
fi
log() { echo "$(date -u +%FT%TZ) $*"; }

# 1. The pinned K3s binary.
if ! echo ${shellQuote(`${input.k3sSha256}  ${K3S_BINARY}`)} | sha256sum -c - >/dev/null 2>&1; then
  curl -sS --fail --location --retry 5 --max-time 300 ${shellQuote(download)} -o ${K3S_BINARY}.download
  echo ${shellQuote(`${input.k3sSha256}  ${K3S_BINARY}.download`)} | sha256sum -c -
  chmod 755 ${K3S_BINARY}.download
  mv -f ${K3S_BINARY}.download ${K3S_BINARY}
fi

# 2. The server configuration, with a token made here and kept on this disk.
vm_id=""
until [[ "$vm_id" =~ ^[A-Za-z0-9._-]+$ ]]; do vm_id=$(${VM_ID_COMMAND[input.cloud]} || true); [[ "$vm_id" =~ ^[A-Za-z0-9._-]+$ ]] || sleep 5; done
public_ip=""
${
  input.cloud === 'azure'
    ? `log "IMDS publicIpAddress: '$(${AZURE_IMDS_PUBLIC_IP} || true)'"
`
    : ''
}for attempt in $(seq 1 60); do
  public_ip=$(${PUBLIC_IP_COMMAND[input.cloud]} || true)
  if [[ "$public_ip" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+$ ]]; then break; fi
  sleep 5
done
[[ "$public_ip" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+$ ]] || { log "no public address"; exit 1; }
[ -s ${STATE}/server-token ] || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \\n' > ${STATE}/server-token
cat > ${K3S_CONFIG}.new <<CONFIG
token: $(cat ${STATE}/server-token)
node-name: ${MANAGEMENT_NODE_NAME}
node-taint:
  - '${CONTROL_PLANE_TAINT_KEY}=true:NoSchedule'
disable:
  - traefik
  - servicelb
  - metrics-server
disable-cloud-controller: true
advertise-address: $public_ip
node-external-ip: $public_ip
egress-selector-mode: cluster
kube-apiserver-arg:
  - ${KUBELET_PREFERRED_ADDRESS_TYPES}
  - service-account-issuer=${issuer}
  - service-account-issuer=https://kubernetes.default.svc.cluster.local
  - service-account-jwks-uri=${issuer}${SERVICE_ACCOUNT_ISSUER_JWKS_PATH}
flannel-external-ip: true
tls-san:
  - $public_ip
CONFIG
restart=0
if ! cmp -s ${K3S_CONFIG}.new ${K3S_CONFIG} 2>/dev/null; then mv -f ${K3S_CONFIG}.new ${K3S_CONFIG}; restart=1; else rm -f ${K3S_CONFIG}.new; fi
cat > /etc/systemd/system/${K3S_UNIT} <<'UNIT'
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
systemctl enable --now ${K3S_UNIT}
[ "$restart" = 0 ] || systemctl restart ${K3S_UNIT}
for attempt in $(seq 1 120); do
  [ "$(${K3S_BINARY} kubectl get --raw=/readyz --request-timeout=10s 2>/dev/null)" = "ok" ] && break
  sleep 5
done

# 3. The Node label only the API selects on, then the manifests, with
#    what only this host knows filled in.
until ${K3S_BINARY} ${MANAGEMENT_LABEL_ARGS} >/dev/null 2>&1; do sleep 5; done
uid=$(${K3S_BINARY} kubectl get namespace kube-system -o jsonpath='{.metadata.uid}')
ca=$(base64 -w0 < ${K3S_SERVER_CA})
${appliedFiles}
until ${K3S_BINARY} kubectl apply -f ${STATE}/applied/ >/dev/null; do sleep 5; done
${
  input.e2eAccess
    ? `
# Test-only: the e2e harness's own access, which the API hands over (S7).
until ${K3S_BINARY} kubectl apply -f - <<'E2E'
${e2eAccessManifest()}
E2E
do sleep 5; done
mkdir -p $(dirname ${E2E_ACCESS_KUBECONFIG_PATH})
for attempt in $(seq 1 60); do
  token=$(${K3S_BINARY} kubectl -n kube-system get secret ${E2E_ACCESS_NAME} -o jsonpath='{.data.token}' 2>/dev/null | base64 -d || true)
  [ -n "$token" ] && break
  sleep 2
done
cat > ${E2E_ACCESS_KUBECONFIG_PATH} <<KUBECONFIG
apiVersion: v1
kind: Config
clusters: [{ name: anycloud, cluster: { server: "https://$public_ip:${SYSTEM_RELEASE_KUBERNETES_PORT}", certificate-authority-data: "$ca" } }]
users: [{ name: e2e, user: { token: "$token" } }]
contexts: [{ name: anycloud, context: { cluster: anycloud, user: e2e } }]
current-context: anycloud
KUBECONFIG
`
    : ''
}
${files}
create() {
  local file=${STATE}/manifests/$1.yaml
  sed -e "s|${publicIp}|$public_ip|g" -e "s|${managementVmId}|$vm_id|g" -e "s|${kubernetesIdentity}|$uid|g" -e "s|${certificateAuthorityData}|$ca|g" "$file" > "$file.rendered"
  until out=$(${K3S_BINARY} kubectl create -f "$file.rendered" 2>&1) || grep -q AlreadyExists <<<"$out"; do
    log "$out"; sleep 5
  done
}
create 20-ingress
# An IngressRoute before its CRD fails the release (abort: no upgrade).
crd_deadline=$(( $(date +%s) + ${CRD_WAIT_SECONDS} ))
until ${K3S_BINARY} kubectl wait --for=condition=established crd/${API_INGRESS_CRD} --timeout=10s >/dev/null 2>&1; do
  if [ "$(date +%s)" -ge "$crd_deadline" ]; then log "${API_INGRESS_CRD} not Established in ${CRD_WAIT_SECONDS / 60} minutes"; exit 1; fi
  sleep 5
done
create 30-api
# Deployed once (latest revision); failed stops the unit, slow retries.
if [ ! -e ${STATE}/release-deployed ]; then
  release_deadline=$(( $(date +%s) + ${RELEASE_WAIT_SECONDS} ))
  while :; do
    status=$(${K3S_BINARY} kubectl -n ${SYSTEM_RELEASE_NAMESPACE} get secret -l owner=helm,name=${SYSTEM_RELEASE_HELM_CHART_NAME} -o jsonpath='{range .items[*]}{.metadata.labels.version} {.metadata.labels.status}{"\\n"}{end}' 2>/dev/null | sort -n | tail -n 1 | cut -d' ' -f2 || true)
    case "$status" in
      deployed) touch ${STATE}/release-deployed; break ;;
      failed) log "the API's Helm release failed (${HELM_INSTALL_JOB_NAME})"; exit ${RELEASE_FAILED_EXIT} ;;
    esac
    if [ "$(date +%s)" -ge "$release_deadline" ]; then log "the API's Helm release is '$status' after ${RELEASE_WAIT_SECONDS / 60} minutes"; exit 1; fi
    sleep 5
  done
fi
# 4. Origin TLS: the key stays on this host; the Worker signs the CSR only
#    for the hostname's A record IP, which is this VM's, while it awaits
#    bootstrap (the CLI publishes it once the cloud reports the address).
if ! ${K3S_BINARY} kubectl -n ${SYSTEM_RELEASE_NAMESPACE} get secret ${API_TLS_SECRET} >/dev/null 2>&1; then
  [ -s ${STATE}/tls.key ] || openssl req -new -newkey rsa:2048 -nodes -keyout ${STATE}/tls.key -out ${STATE}/tls.csr -subj ${shellQuote(`/CN=${hostname}`)} -addext ${shellQuote(`subjectAltName=DNS:${hostname}`)}
  until python3 - ${STATE} <<'PY'
import json, sys, urllib.request
state = sys.argv[1]
csr = open(state + '/tls.csr').read()
request = urllib.request.Request(
    ${JSON.stringify(`${input.workerUrl}/v1/api-tls/bootstrap/certificates`)},
    data=json.dumps({'subdomain': ${JSON.stringify(input.clusterId)}, 'csr': csr}).encode(),
    headers={'content-type': 'application/json'}, method='POST')
issued = json.load(urllib.request.urlopen(request, timeout=30))
open(state + '/tls.crt', 'w').write(issued['certificate'])
open(state + '/ca.crt', 'w').write(issued.get('originPullCa') or '')
PY
  do log "origin certificate not issued yet"; sleep 15; done
  ${K3S_BINARY} kubectl -n ${SYSTEM_RELEASE_NAMESPACE} create secret tls ${API_TLS_SECRET} --cert=${STATE}/tls.crt --key=${STATE}/tls.key --dry-run=client -o yaml | ${K3S_BINARY} kubectl apply -f -
  if [ -s ${STATE}/ca.crt ]; then
    ${K3S_BINARY} kubectl -n ${SYSTEM_RELEASE_NAMESPACE} create secret generic ${API_TLS_CA_SECRET} --from-file=ca.crt=${STATE}/ca.crt --dry-run=client -o yaml | ${K3S_BINARY} kubectl apply -f -
    # Then Traefik requires Cloudflare's client certificate (api-tls.ts).
    until ${K3S_BINARY} kubectl apply -f - <<'OPTION'
${JSON.stringify(ORIGIN_PULL_OPTION)}
OPTION
    do sleep 10; done
  fi
fi
# Full (strict) only once 443 serves the certificate just issued.
until [ -e ${STATE}/tls-active ]; do
  # s_client may exit non-zero on the client-certificate alert after
  # printing the certificate, so only the certificate counts.
  served=$(echo | openssl s_client -connect 127.0.0.1:443 -servername ${hostname} 2>/dev/null || true)
  if openssl x509 -noout -fingerprint <<<"$served" >${STATE}/served 2>/dev/null &&
     [ "$(cat ${STATE}/served)" = "$(openssl x509 -in ${STATE}/tls.crt -noout -fingerprint)" ] &&
     curl -sf -X POST -H 'content-type: application/json' -d ${shellQuote(JSON.stringify({ subdomain: input.clusterId }))} ${shellQuote(`${input.workerUrl}/v1/api-tls/bootstrap/activate`)} >/dev/null; then
    touch ${STATE}/tls-active
  else
    sleep 15
  fi
done
log "management VM bootstrapped"
`;
}

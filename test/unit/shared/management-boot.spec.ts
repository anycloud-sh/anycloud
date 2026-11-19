import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { API_INGRESS_RELEASE } from '../../../src/shared/api-ingress.js';
import {
  buildSystemReleaseHelmChart,
  systemReleaseValues,
  type SystemReleaseIntentInput,
} from '../../../src/shared/system-release-values.js';
import {
  SYSTEM_RELEASE_HELM_JOB_IMAGE,
  SYSTEM_RELEASE_NAMESPACE,
} from '../../../src/shared/system-release.js';
import {
  BOOT_PLACEHOLDERS,
  managementBootBody,
  managementBootScript,
  type ManagementBootInput,
} from '../../../src/shared/management-boot.js';

const CLUSTER = 'prod-1762500000000-a3f9';

/** Release values about as large as a real cluster's, `selfDelete` included. */
const input = (
  overrides: Partial<ManagementBootInput> = {},
): ManagementBootInput => ({
  cloud: 'aws',
  clusterId: CLUSTER,
  k3sVersion: 'v1.35.5+k3s1',
  k3sSha256: 'a'.repeat(64),
  release: {
    values: {
      release: {
        revision: 1,
        operationId: 'op-1762500000000-0a1b2c3d',
        image: `ghcr.io/anycloud-sh/api:0.1.74@sha256:${'b'.repeat(64)}`,
        version: '0.1.74',
      },
      installation: {
        id: CLUSTER,
        ownerUsername: 'octocat-with-a-long-name',
        ownerUserId: '1234567890',
        apiUrl: `https://${CLUSTER}.anycloud.sh`,
      },
      cluster: {
        name: 'production',
        kubernetesIdentity: BOOT_PLACEHOLDERS.kubernetesIdentity,
        joinEndpoint: `https://${BOOT_PLACEHOLDERS.publicIp}:6443`,
        certificateAuthorityData: BOOT_PLACEHOLDERS.certificateAuthorityData,
      },
      ingress: { mode: 'traefik', host: `${CLUSTER}.anycloud.sh` },
      api: { port: 8080 },
      backup: {
        bucket: CLUSTER,
        region: 'us-east-1',
        cloudProvider: 'AWS',
        credentials: { cloudProvider: 'AWS', kind: 'instance' },
        account: '123456789012',
      },
      state: { restoreFromBackup: false },
      selfDelete: {
        stackName: `anycloud-${CLUSTER}`,
        serviceRoleArn: `arn:aws:iam::123456789012:role/anycloud-${CLUSTER}-cfn`,
      },
    },
    chart: `oci://ghcr.io/anycloud-sh/api-k8-chart@sha256:${'c'.repeat(64)}`,
    jobImage: `rancher/klipper-helm:v0.9.4-build20250113@sha256:${'d'.repeat(64)}`,
    revision: 1,
    operationId: 'op-1762500000000-0a1b2c3d',
  },
  workerUrl: 'https://dns.anycloud.sh',
  ...overrides,
});

describe('management VM boot script', () => {
  it.each(['aws', 'gcp', 'azure'] as const)(
    'is valid bash on %s, unpacks to the script the VM runs, and fits AWS user-data’s 16 KB with room to spare',
    (cloud) => {
      const wrapped = managementBootScript(input({ cloud, e2eAccess: true }));
      execFileSync('bash', ['-n'], { input: wrapped });
      // AWS takes 16 KB; 10 KB leaves room for larger release values.
      expect(Buffer.byteLength(wrapped)).toBeLessThan(10 * 1024);
      const packed = /<<'ANYCLOUD_BOOT'[^\n]*\n([\s\S]*)ANYCLOUD_BOOT/.exec(
        wrapped,
      )![1]!;
      const body = gunzipSync(Buffer.from(packed, 'base64')).toString();
      expect(body).toBe(managementBootBody(input({ cloud, e2eAccess: true })));
      execFileSync('bash', ['-n'], { input: body });
      expect(body.startsWith('#!/bin/bash\n')).toBe(true);
    },
  );

  it('reads the public address from each cloud’s own metadata service', () => {
    expect(managementBootBody(input({ cloud: 'aws' }))).toContain(
      'latest/meta-data/public-ipv4',
    );
    expect(managementBootBody(input({ cloud: 'gcp' }))).toContain(
      'access-configs/0/external-ip',
    );
    expect(managementBootBody(input({ cloud: 'azure' }))).toContain(
      'metadata/instance/compute/userData?api-version',
    );
  });

  it('reads the Azure public address from the userData the seed sets, logging what IMDS’s network data reports first', () => {
    const body = managementBootBody(input({ cloud: 'azure' }));
    const lookup = /public_ip=\$\((.*) \|\| true\)/.exec(body)![1]!;
    // Diagnosis only: IMDS omits a Standard SKU address from the network data.
    const logged = body.indexOf('log "IMDS publicIpAddress:');
    expect(logged).toBeGreaterThan(
      body.indexOf('exec >>/var/log/anycloud-boot.log 2>&1\nfi'),
    );
    expect(logged).toBeLessThan(body.indexOf(lookup));
    expect(managementBootBody(input({ cloud: 'aws' }))).not.toContain(
      'IMDS publicIpAddress',
    );
    const bin = mkdtempSync(join(tmpdir(), 'boot-imds-'));
    const run = (userData: string) => {
      writeFileSync(join(bin, 'curl'), `#!/bin/sh\nprintf %s '${userData}'\n`, {
        mode: 0o755,
      });
      return spawnSync('bash', ['-c', `set -o pipefail; ${lookup}`], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        encoding: 'utf8',
      });
    };
    try {
      // ARM's base64(ipAddress); IMDS serves userData as stored.
      const filled = run(Buffer.from('203.0.113.7').toString('base64'));
      expect(filled.status).toBe(0);
      expect(filled.stdout).toBe('203.0.113.7');
      // Without userData nothing comes back, which the boot loop's IPv4 check rejects.
      expect(run('').stdout).toBe('');
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it.each([
    ['aws', 'latest/meta-data/instance-id'],
    ['gcp', 'computeMetadata/v1/instance/name'],
    ['azure', 'metadata/instance/compute/name?api-version'],
  ] as const)(
    'fills the management VM ID on %s from its metadata, in the gateways’ form',
    (cloud, path) => {
      const script = managementBootBody(input({ cloud }));
      expect(script).toContain(path);
      expect(script).toContain('s|@@ANYCLOUD_MANAGEMENT_VM_ID@@|$vm_id|g');
      // Read before anything is rendered with it.
      expect(script.indexOf(path)).toBeLessThan(
        script.indexOf('s|@@ANYCLOUD_MANAGEMENT_VM_ID@@|'),
      );
    },
  );

  it('logs to the serial console as well as the file, and to the file alone without a console', () => {
    const body = managementBootBody(input());
    const redirect = /\nif \{ echo [^\n]*\/dev\/ttyS0;[\s\S]*?\nfi\n/.exec(
      body,
    )![0];
    const dir = mkdtempSync(join(tmpdir(), 'boot-log-'));
    const run = (consolePath: string, teeConsole = consolePath) => {
      const script = redirect
        .replaceAll('/var/log/anycloud-boot.log', join(dir, 'boot.log'))
        .replace('/dev/ttyS0', consolePath)
        .replace('/dev/ttyS0', teeConsole);
      return spawnSync(
        'bash',
        ['-c', `set -euo pipefail\n${script}echo step one\nexit 1`],
        // Nothing holds a pipe open after bash exits, so only the exit's
        // wait for tee gets the last line written.
        { stdio: 'ignore' },
      );
    };
    try {
      // A failed step's last line still reaches both: the exit waits for tee.
      expect(run(join(dir, 'console')).status).toBe(1);
      expect(readFileSync(join(dir, 'boot.log'), 'utf8')).toBe('step one\n');
      expect(readFileSync(join(dir, 'console'), 'utf8')).toContain(
        'step one\n',
      );
      rmSync(join(dir, 'boot.log'));
      expect(run(join(dir, 'missing', 'ttyS0')).status).toBe(1);
      expect(readFileSync(join(dir, 'boot.log'), 'utf8')).toBe('step one\n');
      rmSync(join(dir, 'boot.log'));
      // A console that stops taking writes neither stops the file nor the script.
      expect(run(join(dir, 'console'), '/dev/full').status).toBe(1);
      expect(readFileSync(join(dir, 'boot.log'), 'utf8')).toBe('step one\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('makes its own server token and TLS key on the host, and carries no secret', () => {
    const script = managementBootBody(input());
    expect(script).toContain('/dev/urandom');
    expect(script).toContain('openssl req -new -newkey rsa:2048');
    // Nothing secret travels in the script: no token, key or certificate.
    expect(script).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY|token: [0-9a-f]{16}/);
  });

  it('creates the API’s HelmChart once, from the release values, and never re-applies it', () => {
    const script = managementBootBody(input());
    expect(script).toContain('kubectl create -f "$file.rendered"');
    expect(script).not.toContain('/var/lib/rancher/k3s/server/manifests');
    const chart =
      /"kind":"HelmChart","metadata":\{"name":"anycloud-api".*$/m.exec(
        script,
      )?.[0];
    expect(chart).toBeDefined();
    const parsed = JSON.parse(`{"apiVersion":"helm.cattle.io/v1",${chart!}`);
    expect(parsed.metadata.annotations).toMatchObject({
      'anycloud.sh/release-revision': '1',
      'anycloud.sh/installation': CLUSTER,
    });
    expect(JSON.parse(parsed.spec.valuesContent).selfDelete).toEqual(
      input().release.values.selfDelete,
    );
    // What only the host knows is filled in there.
    for (const placeholder of Object.values(BOOT_PLACEHOLDERS))
      expect(script).toContain(`s|${placeholder}|`);
  });

  it('keeps every Pod but the API’s off the metadata service, in every namespace on the management Node, and leaves GCP’s DNS open', () => {
    const script = managementBootBody(input());
    const policies = script
      .split('\n')
      .filter((line) => line.includes('"kind":"NetworkPolicy"'))
      .map((line) => JSON.parse(line));
    // K3s's add-ons, the API and its hooks, the API's Traefik, and default.
    expect(policies.map((p) => p.metadata.namespace).sort()).toEqual(
      [
        'kube-system',
        SYSTEM_RELEASE_NAMESPACE,
        API_INGRESS_RELEASE,
        'default',
      ].sort(),
    );
    // The API Pod's own label, as the chart sets it.
    const chart = readFileSync(
      new URL(
        '../../../charts/anycloud-api/templates/_helpers.tpl',
        import.meta.url,
      ),
      'utf8',
    );
    expect(chart).toContain('app.kubernetes.io/name: anycloud-api');
    for (const policy of policies) {
      expect(policy.spec.podSelector.matchExpressions).toEqual([
        {
          key: 'app.kubernetes.io/name',
          operator: 'NotIn',
          values: ['anycloud-api'],
        },
      ]);
      expect(policy.spec.egress).toEqual([
        {
          to: [
            { ipBlock: { cidr: '0.0.0.0/0', except: ['169.254.169.254/32'] } },
          ],
        },
        {
          to: [{ ipBlock: { cidr: '169.254.169.254/32' } }],
          ports: [
            { protocol: 'UDP', port: 53 },
            { protocol: 'TCP', port: 53 },
          ],
        },
      ]);
    }
    // Applied on every run, so a partial apply heals; namespaces first.
    expect(script).toContain(
      'kubectl apply -f /var/lib/anycloud/boot/applied/',
    );
  });

  it('runs as a systemd unit that retries a failed step and runs at every boot', () => {
    const wrapped = managementBootScript(input());
    expect(wrapped).toContain('Restart=on-failure');
    // Not oneshot: nothing waits on it, so a long boot never holds multi-user.target.
    expect(wrapped).toContain('Type=simple');
    expect(wrapped).toContain('WantedBy=multi-user.target');
    expect(wrapped).toContain(
      'ExecStart=/bin/bash /var/lib/anycloud/boot/boot.sh',
    );
    expect(wrapped).toContain(
      'systemctl start --no-block anycloud-boot.service',
    );
  });

  it('labels the management Node before the API is created', () => {
    const script = managementBootBody(input());
    expect(
      script.indexOf('kubectl label node anycloud-management'),
    ).toBeLessThan(script.indexOf('kubectl create -f'));
  });

  it('asks the Worker for the origin certificate, then activates Full (strict) once 443 serves it', () => {
    const script = managementBootBody(input());
    const issue = script.indexOf('/v1/api-tls/bootstrap/certificates');
    const activate = script.indexOf('/v1/api-tls/bootstrap/activate');
    expect(issue).toBeGreaterThan(0);
    expect(activate).toBeGreaterThan(issue);
    expect(script).toContain('openssl s_client -connect 127.0.0.1:443');
  });

  it('adds the e2e harness’s access only when asked', () => {
    expect(managementBootBody(input())).not.toContain('anycloud-e2e');
    const script = managementBootBody(input({ e2eAccess: true }));
    const list = JSON.parse(/<<'E2E'\n(.*)\nE2E/.exec(script)![1]!) as {
      items: {
        kind: string;
        metadata: { namespace?: string };
        rules?: unknown[];
      }[];
    };
    // The exact verbs, including what the capacity checks read the API's log with.
    const cluster = list.items.find((item) => item.kind === 'ClusterRole')!;
    expect(cluster.rules).toEqual([
      { apiGroups: [''], resources: ['nodes'], verbs: ['get', 'list'] },
      {
        apiGroups: [''],
        resources: ['pods'],
        verbs: ['get', 'list', 'delete'],
      },
      { apiGroups: [''], resources: ['pods/log'], verbs: ['get'] },
      { apiGroups: [''], resources: ['events'], verbs: ['list'] },
      { apiGroups: [''], resources: ['secrets'], verbs: ['list'] },
      // The role check's signer token, in a node pool namespace named at run time.
      {
        apiGroups: [''],
        resources: ['serviceaccounts/token'],
        verbs: ['create'],
      },
    ]);
    // And list-only Helm state, which a timed-out hosted upgrade's capture reads.
    for (const namespace of ['kube-system', SYSTEM_RELEASE_NAMESPACE]) {
      const role = list.items.find(
        (item) => item.kind === 'Role' && item.metadata.namespace === namespace,
      )!;
      expect(role.rules).toEqual(
        expect.arrayContaining([
          { apiGroups: ['batch'], resources: ['jobs'], verbs: ['list'] },
          {
            apiGroups: ['helm.cattle.io'],
            resources: ['helmcharts'],
            verbs: ['list'],
          },
        ]),
      );
    }
    expect(JSON.stringify(list)).not.toContain('"*"');
    expect(script).toContain('/var/lib/anycloud/e2e-access/kubeconfig');
    // Written before the API is created, so a fast-starting API finds it.
    expect(
      script.indexOf('cat > /var/lib/anycloud/e2e-access/kubeconfig'),
    ).toBeLessThan(script.indexOf('kubectl create -f "$file.rendered"'));
    execFileSync('bash', ['-n'], { input: script });
  });

  it('creates the API HelmChart the upgrade path reads and rewrites, once the VM fills it in', () => {
    const live = {
      [BOOT_PLACEHOLDERS.kubernetesIdentity]: 'uid-production',
      [BOOT_PLACEHOLDERS.publicIp]: '203.0.113.9',
      [BOOT_PLACEHOLDERS.certificateAuthorityData]:
        Buffer.from('ca').toString('base64'),
    };
    const intent = (
      cluster: SystemReleaseIntentInput['cluster'],
    ): SystemReleaseIntentInput => ({
      installationId: CLUSTER,
      cluster,
      revision: 1,
      operationId: 'op-1762500000000-0a1b2c3d',
      apiImage: `ghcr.io/anycloud-sh/api:0.1.74@sha256:${'e'.repeat(64)}`,
      apiVersion: '0.1.74',
      ownerUsername: 'owner',
      ownerUserId: '42',
      githubAppIds: [],
      apiUrl: `https://${CLUSTER}.anycloud.sh`,
      chart: `oci://ghcr.io/anycloud-sh/api-k8-chart@sha256:${'c'.repeat(64)}`,
      helmJobImage: SYSTEM_RELEASE_HELM_JOB_IMAGE,
      backup: null,
      restoreFromBackup: false,
    });
    // What the seed passes: the values the VM completes.
    const seeded = intent({
      name: 'production',
      kubernetesIdentity: BOOT_PLACEHOLDERS.kubernetesIdentity,
      joinEndpoint: `https://${BOOT_PLACEHOLDERS.publicIp}:6443`,
      certificateAuthorityData: BOOT_PLACEHOLDERS.certificateAuthorityData,
      record: null,
    });
    const script = managementBootBody(
      input({
        release: {
          values: { ...systemReleaseValues(seeded) },
          chart: seeded.chart,
          jobImage: seeded.helmJobImage,
          revision: seeded.revision,
          operationId: seeded.operationId,
        },
      }),
    );
    // The script's own sed, with what the VM reads in place of each placeholder.
    const sed = /sed (-e "s\|[^"]+" ?)+/.exec(script)![0];
    const manifest =
      /manifests\/30-api\.yaml <<'ANYCLOUD_MANIFEST'\n(.*)\nANYCLOUD_MANIFEST/.exec(
        script,
      )![1]!;
    const rendered = execFileSync(
      'bash',
      [
        '-c',
        `public_ip=$1 vm_id=i-0 uid=$2 ca=$3; ${sed}`,
        '_',
        live[BOOT_PLACEHOLDERS.publicIp]!,
        live[BOOT_PLACEHOLDERS.kubernetesIdentity]!,
        live[BOOT_PLACEHOLDERS.certificateAuthorityData]!,
      ],
      { input: manifest, encoding: 'utf8' },
    );
    // The object the API builds for that cluster: an upgrade patches this one.
    expect(JSON.parse(rendered)).toEqual(
      buildSystemReleaseHelmChart(
        intent({
          name: 'production',
          kubernetesIdentity: 'uid-production',
          joinEndpoint: 'https://203.0.113.9:6443',
          certificateAuthorityData: Buffer.from('ca').toString('base64'),
          record: null,
        }),
      ),
    );
  });

  it('creates the API HelmChart only once Traefik’s IngressRoute CRD is Established, then checks its first release before TLS', () => {
    const script = managementBootBody(input());
    const at = (needle: string) => {
      const index = script.indexOf(needle);
      expect(index, needle).toBeGreaterThan(0);
      return index;
    };
    const ingress = at('create 20-ingress');
    const crd = at(
      'kubectl wait --for=condition=established crd/ingressroutes.traefik.io',
    );
    const api = at('create 30-api');
    const release = at('owner=helm,name=anycloud-api');
    const tls = at('# 4. Origin TLS');
    expect([ingress, crd, api, release, tls]).toEqual(
      [ingress, crd, api, release, tls].sort((a, b) => a - b),
    );
    // A failed first release stops the unit instead of retrying it forever.
    expect(managementBootScript(input())).toContain(
      'RestartPreventExitStatus=70',
    );
  });

  // Each read answers with the release's revisions as Helm labels them.
  it.each([
    [
      'deployed once installed',
      [[], ['1 pending-install'], ['1 deployed']],
      0,
      true,
    ],
    [
      'an upgraded release by its latest revision',
      [['1 superseded', '2 deployed']],
      0,
      true,
    ],
    [
      'an operator-repaired release',
      [['10 deployed', '9 failed', '1 failed']],
      0,
      true,
    ],
    [
      'a failed release, stopping the unit',
      [['1 pending-install'], ['1 failed']],
      70,
      false,
    ],
    [
      'a release still pending at the deadline, retrying',
      [['1 pending-install']],
      1,
      false,
    ],
  ] as const)('checks the API release: %s', (_name, reads, code, marked) => {
    const check =
      /\nif \[ ! -e \/var\/lib\/anycloud\/boot\/release-deployed \]; then\n[\s\S]*?\nfi\n/.exec(
        managementBootBody(input()),
      )![0];
    const dir = mkdtempSync(join(tmpdir(), 'boot-release-'));
    try {
      reads.forEach((revisions, index) =>
        writeFileSync(
          join(dir, `read-${index}`),
          revisions.map((line) => `${line}\n`).join(''),
        ),
      );
      // A fake k3s that answers only the release query, then the next read.
      writeFileSync(
        join(dir, 'k3s'),
        [
          '#!/bin/bash',
          `[ "$*" = "kubectl -n ${SYSTEM_RELEASE_NAMESPACE} get secret -l owner=helm,name=anycloud-api -o jsonpath={range .items[*]}{.metadata.labels.version} {.metadata.labels.status}{\\"\\\\n\\"}{end}" ] || exit 9`,
          `n=$(cat ${dir}/n 2>/dev/null || echo 0); echo $((n + 1)) > ${dir}/n`,
          `f=${dir}/read-$n; [ -e $f ] || f=$(ls ${dir}/read-* | sort -V | tail -n 1)`,
          'cat $f | shuf',
        ].join('\n'),
        { mode: 0o755 },
      );
      const run = (script: string) =>
        spawnSync(
          'bash',
          ['-c', `set -euo pipefail\nlog() { echo "$*"; }\n${script}`],
          { encoding: 'utf8' },
        );
      const local = check
        .replaceAll('/usr/local/bin/k3s', join(dir, 'k3s'))
        .replaceAll('/var/lib/anycloud/boot', dir)
        .replaceAll('sleep 5', 'sleep 0')
        // The deadline arrives once every read has been answered.
        .replace(
          /release_deadline=\$\(\( \$\(date \+%s\) \+ \d+ \)\)/,
          `release_deadline=$(( $(date +%s) + 5 ))`,
        );
      const result = run(local);
      expect(result.status, result.stdout + result.stderr).toBe(code);
      expect(existsSync(join(dir, 'release-deployed'))).toBe(marked);
      if (code === 70) expect(result.stdout).toContain('Helm release failed');
      // Once marked, a later boot doesn't ask again.
      if (marked) {
        rmSync(join(dir, 'k3s'));
        expect(run(local).status).toBe(0);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    [{ k3sVersion: 'latest' }, 'K3s version'],
    [{ k3sSha256: 'nope' }, 'SHA-256'],
    [{ clusterId: "x'; rm -rf /" }, 'cluster ID'],
    [{ workerUrl: 'http://evil' }, 'Worker URL'],
  ] as const)(
    'refuses an input it would interpolate unsafely (%o)',
    (bad, message) => {
      expect(() => managementBootScript(input(bad))).toThrow(message);
    },
  );
});

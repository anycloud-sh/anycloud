import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import {
  parseClusterConnection,
  serializeClusterConnection,
} from '../../../../src/api/services/kubernetes/cluster-connection.js';
import {
  parseInstallerAccessMaterial,
  managementHostStartupScript,
  installerConnectionDocument,
  managementKubernetesConfig,
  INSTALLER_ACCESS_READ_COMMAND,
  MANAGEMENT_K3S_CONFIG_STAGING_PATH,
  MANAGEMENT_KUBERNETES_CONFIGURE_COMMAND,
  MANAGEMENT_KUBERNETES_READY_COMMAND,
  managementKubernetesReconfigureScript,
  parseManagementReconfigure,
} from '../../../../src/api/services/system-release/management-host.js';
import {
  HOST_STEP_RUNNER,
  parseHostStepReport,
} from '../../../../src/api/services/system-release/host-step.js';
import {
  SYSTEM_RELEASE_K3S_SHA256,
  SYSTEM_RELEASE_K3S_VERSION,
} from '../../../../src/shared/system-release.js';

const CA = Buffer.from('ca').toString('base64');

describe('management host scripts', () => {
  it('prepares the host with the pinned, checksum-verified K3s binary and a disabled unit', () => {
    const script = managementHostStartupScript({
      sshPublicKey: 'ssh-ed25519 AAAA anycloud',
      k3sVersion: SYSTEM_RELEASE_K3S_VERSION,
      k3sSha256: SYSTEM_RELEASE_K3S_SHA256,
    });
    expect(script).toContain('ssh-ed25519 AAAA anycloud');
    expect(script).toContain(
      `https://github.com/k3s-io/k3s/releases/download/${encodeURIComponent(SYSTEM_RELEASE_K3S_VERSION)}/k3s`,
    );
    expect(script).toContain(
      `${SYSTEM_RELEASE_K3S_SHA256}  /usr/local/bin/k3s.download`,
    );
    expect(script).toContain('sha256sum -c -');
    expect(script).not.toContain('systemctl enable');
    expect(script).not.toContain('get.k3s.io');
  });

  it('rejects an unpinned toolchain', () => {
    expect(() =>
      managementHostStartupScript({
        sshPublicKey: 'k',
        k3sVersion: 'latest',
        k3sSha256: SYSTEM_RELEASE_K3S_SHA256,
      }),
    ).toThrow('Unexpected K3s version');
    expect(() =>
      managementHostStartupScript({
        sshPublicKey: 'k',
        k3sVersion: SYSTEM_RELEASE_K3S_VERSION,
        k3sSha256: 'abc',
      }),
    ).toThrow('64 hex');
  });

  it('stages the server configuration with the management taint, disabled public components and the public address as a SAN', () => {
    const config = managementKubernetesConfig({
      serverToken: 'a1b2c3d4',
      publicIp: '203.0.113.5',
      issuerUrl: 'https://c-1.anycloud.sh',
    });
    expect(config).toContain('token: a1b2c3d4');
    expect(config).toContain(
      "'node-role.kubernetes.io/control-plane=true:NoSchedule'",
    );
    expect(config).not.toContain('dedicated');
    // The management label is the API's to set, never the Node's.
    expect(config).not.toContain('node-label');
    // K3s's own traefik is off (its non-bootstrap install Job never schedules
    // onto the tainted Node); the API renders its own Traefik release.
    expect(config).toContain('  - traefik');
    expect(config).toContain('  - servicelb');
    expect(config).not.toContain('  - coredns');
    expect(config).toContain('tls-san:\n  - 203.0.113.5');
    // Agents re-point their tunnel to the advertised address: it must be the
    // public one, kubelet reads must ride the agent tunnel, and cross-cloud
    // Pod traffic must use external IPs (found across runs 4–6 and 4–7).
    expect(config).toContain('advertise-address: 203.0.113.5');
    expect(config).toContain('node-external-ip: 203.0.113.5');
    expect(config).toContain('egress-selector-mode: cluster');
    expect(config).not.toContain('egress-selector-mode: agent');
    expect(config).toContain('flannel-external-ip: true');
    // Kubelets are dialled by Node name through their own tunnel.
    expect(config).toContain(
      'kube-apiserver-arg:\n  - kubelet-preferred-address-types=Hostname,InternalIP,ExternalIP',
    );
    // Tokens are signed by the public issuer the API serves; K3s's in-cluster
    // issuer stays accepted, and api-audiences stays K3s's.
    expect(config).toContain(
      [
        '  - service-account-issuer=https://c-1.anycloud.sh',
        '  - service-account-issuer=https://kubernetes.default.svc.cluster.local',
        '  - service-account-jwks-uri=https://c-1.anycloud.sh/openid/v1/jwks',
      ].join('\n'),
    );
    expect(config).not.toContain('api-audiences');
    expect(() =>
      managementKubernetesConfig({
        serverToken: 't',
        publicIp: '1.2.3.4; rm -rf /',
        issuerUrl: 'https://c-1.anycloud.sh',
      }),
    ).toThrow('unexpected characters');
    expect(() =>
      managementKubernetesConfig({
        serverToken: "tok'en",
        publicIp: '1.2.3.4',
        issuerUrl: 'https://c-1.anycloud.sh',
      }),
    ).toThrow('unexpected characters');
    expect(() =>
      managementKubernetesConfig({
        serverToken: 't',
        publicIp: '1.2.3.4',
        issuerUrl: 'https://c-1.anycloud.sh\n  - anonymous-auth=true',
      }),
    ).toThrow('unexpected characters');
  });

  it('activates the staged configuration with a command that carries no secret', () => {
    expect(MANAGEMENT_K3S_CONFIG_STAGING_PATH).toBe(
      '/etc/rancher/k3s/config.yaml.new',
    );
    expect(MANAGEMENT_KUBERNETES_CONFIGURE_COMMAND).toContain(
      `mv -f ${MANAGEMENT_K3S_CONFIG_STAGING_PATH} /etc/rancher/k3s/config.yaml`,
    );
    expect(MANAGEMENT_KUBERNETES_CONFIGURE_COMMAND).toContain(
      'systemctl enable --now k3s-anycloud.service',
    );
    expect(MANAGEMENT_KUBERNETES_CONFIGURE_COMMAND).not.toContain('token');
    expect(MANAGEMENT_KUBERNETES_CONFIGURE_COMMAND).not.toContain('cat >');
    expect(MANAGEMENT_KUBERNETES_CONFIGURE_COMMAND).toContain('exit 64');
    expect(MANAGEMENT_KUBERNETES_CONFIGURE_COMMAND).toContain('exit 66');
  });

  it('restarts K3s only for a changed configuration, and again after an interrupted restart', () => {
    // The command runs as written, with the host's paths moved under a
    // temporary root and systemctl replaced by a recorder.
    const root = mkdtempSync(path.join(tmpdir(), 'management-configure-'));
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(path.join(root, 'etc'));
    mkdirSync(path.join(root, 'bin'));
    const binary = path.join(root, 'k3s');
    writeFileSync(binary, '');
    chmodSync(binary, 0o755);
    const calls = path.join(root, 'systemctl.log');
    writeFileSync(
      path.join(root, 'bin', 'systemctl'),
      `#!/bin/sh\necho "$*" >> ${calls}\nif [ "$1" = restart ] && [ -e ${root}/fail-restart ]; then exit 1; fi\n`,
    );
    chmodSync(path.join(root, 'bin', 'systemctl'), 0o755);
    const command = MANAGEMENT_KUBERNETES_CONFIGURE_COMMAND.replaceAll(
      '/etc/rancher/k3s',
      path.join(root, 'etc'),
    ).replaceAll('/usr/local/bin/k3s', binary);
    const config = path.join(root, 'etc', 'config.yaml');
    const run = (staged: string) => {
      writeFileSync(`${config}.new`, staged);
      writeFileSync(calls, '');
      const result = spawnSync('bash', ['-c', command], {
        encoding: 'utf8',
        env: { PATH: `${path.join(root, 'bin')}:${process.env.PATH}` },
      });
      return {
        code: result.status,
        restarts: readFileSync(calls, 'utf8')
          .split('\n')
          .filter((line) => line.startsWith('restart')).length,
      };
    };

    expect(run('first')).toEqual({ code: 0, restarts: 1 });
    expect(readFileSync(config, 'utf8')).toBe('first');
    expect(run('first')).toEqual({ code: 0, restarts: 0 });
    expect(existsSync(`${config}.new`)).toBe(false);

    // The new configuration is in place but K3s never restarted onto it.
    writeFileSync(path.join(root, 'fail-restart'), '');
    expect(run('second').code).not.toBe(0);
    expect(readFileSync(config, 'utf8')).toBe('second');
    rmSync(path.join(root, 'fail-restart'));
    expect(run('second')).toEqual({ code: 0, restarts: 1 });
    expect(run('second')).toEqual({ code: 0, restarts: 0 });
  });

  describe('the host-step K3s reconfiguration (RFC 0049 C26 (b))', () => {
    // The script runs as written, with the host's paths under a temporary
    // root, and k3s, systemctl and sleep replaced by recorders.
    function sandbox(ready: boolean) {
      const root = mkdtempSync(path.join(tmpdir(), 'management-reconfigure-'));
      onTestFinished(() => rmSync(root, { recursive: true, force: true }));
      mkdirSync(path.join(root, 'etc'));
      mkdirSync(path.join(root, 'bin'));
      const log = path.join(root, 'calls.log');
      const k3s = path.join(root, 'k3s');
      const tool = (file: string, body: string) => {
        writeFileSync(
          file,
          `#!/bin/sh\necho "$(basename $0) $*" >> ${log}\n${body}`,
        );
        chmodSync(file, 0o755);
      };
      tool(
        k3s,
        ready
          ? `case "$*" in *readyz*) echo ok;; *jsonpath*) printf True;; esac\n`
          : '',
      );
      tool(path.join(root, 'bin', 'systemctl'), '');
      tool(path.join(root, 'bin', 'sleep'), '');
      // Each read of the clock is a minute later.
      tool(
        path.join(root, 'bin', 'date'),
        `n=$(cat ${root}/clock 2>/dev/null || echo 0)\necho $((n + 60)) > ${root}/clock\necho $n\n`,
      );
      const script = managementKubernetesReconfigureScript({
        publicIp: '203.0.113.5',
        issuerUrl: 'https://c-1.anycloud.sh',
      })
        .replaceAll('/etc/rancher/k3s', path.join(root, 'etc'))
        .replaceAll('/usr/local/bin/k3s', k3s)
        .replaceAll('/run/', `${root}/`);
      const config = path.join(root, 'etc', 'config.yaml');
      const run = () => {
        writeFileSync(log, '');
        const result = spawnSync('bash', ['-c', script], {
          encoding: 'utf8',
          env: { PATH: `${path.join(root, 'bin')}:${process.env.PATH}` },
        });
        return {
          code: result.status,
          stdout: result.stdout,
          stderr: result.stderr,
          calls: readFileSync(log, 'utf8').trim().split('\n'),
        };
      };
      return { config, run };
    }

    it('labels the Node, keeps the host token, restarts K3s only on a change and waits until it is ready', () => {
      const { config, run } = sandbox(true);
      writeFileSync(config, 'token: host-token-1\nnode-name: old\n');
      const first = run();
      expect(first.code).toBe(0);
      expect(parseManagementReconfigure(first.stdout)).toBe('changed');
      // The label comes before the configuration changes anything.
      expect(first.calls.find((call) => call.startsWith('k3s '))).toBe(
        'k3s kubectl label node anycloud-management node-restriction.kubernetes.io/anycloud-management=true --overwrite --request-timeout=30s',
      );
      expect(first.calls).toContain('systemctl restart k3s-anycloud.service');
      expect(readFileSync(config, 'utf8')).toBe(
        managementKubernetesConfig({
          serverToken: 'host-token-1',
          publicIp: '203.0.113.5',
          issuerUrl: 'https://c-1.anycloud.sh',
        }),
      );
      const second = run();
      expect(second.code).toBe(0);
      expect(parseManagementReconfigure(second.stdout)).toBe('current');
      expect(second.calls).not.toContain(
        'systemctl restart k3s-anycloud.service',
      );
    });

    it('changes nothing without a token, and fails when Kubernetes does not come back', () => {
      const missing = sandbox(true);
      writeFileSync(missing.config, 'node-name: old\n');
      const refused = missing.run();
      expect(refused.code).toBe(65);
      expect(refused.stderr).toContain('missing or malformed');
      expect(readFileSync(missing.config, 'utf8')).toBe('node-name: old\n');

      const absent = sandbox(true);
      expect(absent.run().code).toBe(65);

      const down = sandbox(false);
      writeFileSync(down.config, 'token: host-token-1\n');
      const timedOut = down.run();
      expect(timedOut.code).toBe(75);
      expect(timedOut.stderr).toContain(
        'did not become ready within 5 minutes',
      );
    });
  });

  describe('the host-step runner', () => {
    // systemd-run runs the unit at once; systemctl reports it inactive.
    function runner(active = false) {
      const root = mkdtempSync(path.join(tmpdir(), 'host-step-runner-'));
      onTestFinished(() => rmSync(root, { recursive: true, force: true }));
      mkdirSync(path.join(root, 'bin'));
      const runs = path.join(root, 'runs.log');
      const tool = (name: string, body: string) => {
        writeFileSync(path.join(root, 'bin', name), `#!/bin/bash\n${body}`);
        chmodSync(path.join(root, 'bin', name), 0o755);
      };
      // An active unit runs until its result appears; it never ends here.
      tool(
        'systemctl',
        active
          ? `[ "$1" = is-active ] && { touch ${root}/waited; mkdir -p ${root}/steps; echo 0 > ${root}/steps/\${3%.service}.code; echo kept > ${root}/steps/\${3%.service}.out; exit 0; }\nexit 3\n`
          : 'exit 3\n',
      );
      tool(
        'systemd-run',
        `echo "$*" >> ${runs}\nwhile [ "$1" != -- ]; do shift; done; shift\n[ -e ${root}/lose-result ] || "$@"\n`,
      );
      tool('sleep', '');
      const command = HOST_STEP_RUNNER.replaceAll(
        '/run/anycloud-host-steps',
        path.join(root, 'steps'),
      );
      return {
        root,
        runs: () => readFileSync(runs, 'utf8').trim().split('\n'),
        run: (unit: string, script: string) => {
          const result = spawnSync('bash', ['-c', command, 'runner', unit], {
            input: script,
            encoding: 'utf8',
            env: { PATH: `${path.join(root, 'bin')}:${process.env.PATH}` },
          });
          return {
            code: result.status,
            stdout: result.stdout,
            stderr: result.stderr,
          };
        },
      };
    }

    it('hands the script to a transient unit and reports its exit and output, once per unit', () => {
      const host = runner();
      const first = host.run(
        'anycloud-host-kubernetes-a',
        'echo configured; exit 3',
      );
      expect(first.code).toBe(0);
      expect(parseHostStepReport(first.stdout)).toEqual({
        code: 3,
        output: 'configured\n',
      });
      expect(host.runs()).toEqual([
        expect.stringContaining(
          '--unit=anycloud-host-kubernetes-a -p RuntimeMaxSec=840 --',
        ),
      ]);
      // A second Pod of the step reports the kept result and starts nothing.
      const again = host.run('anycloud-host-kubernetes-a', 'echo other');
      expect(parseHostStepReport(again.stdout)).toEqual(
        parseHostStepReport(first.stdout),
      );
      expect(host.runs()).toHaveLength(1);
    });

    it('waits for a unit another Pod started instead of starting a second', () => {
      const host = runner(true);
      const waiting = host.run('anycloud-host-kubernetes-c', 'echo second');
      expect(parseHostStepReport(waiting.stdout)).toEqual({
        code: 0,
        output: 'kept\n',
      });
      expect(existsSync(path.join(host.root, 'waited'))).toBe(true);
      expect(existsSync(path.join(host.root, 'runs.log'))).toBe(false);
    });

    it('fails when the unit ends without a result', () => {
      const host = runner();
      writeFileSync(path.join(host.root, 'lose-result'), '');
      const lost = host.run('anycloud-host-kubernetes-b', 'echo never');
      expect(lost.code).toBe(70);
      expect(lost.stderr).toContain('ended without a result');
    });
  });

  it('reads installer access as a ServiceAccount token plus inline CA, never the admin certificate', () => {
    expect(INSTALLER_ACCESS_READ_COMMAND).toContain('kind: ServiceAccount');
    expect(INSTALLER_ACCESS_READ_COMMAND).toContain(
      'kubernetes.io/service-account-token',
    );
    expect(INSTALLER_ACCESS_READ_COMMAND).toContain('server-ca.crt');
    expect(INSTALLER_ACCESS_READ_COMMAND).not.toContain('client-admin');
    expect(INSTALLER_ACCESS_READ_COMMAND).not.toContain('k3s.yaml');
    expect(MANAGEMENT_KUBERNETES_READY_COMMAND).toContain('/readyz');
  });

  it('builds the installer connection from the access material and the public endpoint', () => {
    const material = parseInstallerAccessMaterial(
      `noise\n${JSON.stringify({ certificateAuthorityData: CA, token: 'sa-token' })}\n`,
    );
    const document = installerConnectionDocument({
      publicIp: '203.0.113.5',
      material,
    });
    expect(document).toEqual({
      kind: 'installer',
      server: 'https://203.0.113.5:6443',
      certificateAuthorityData: CA,
      credential: { kind: 'token', token: 'sa-token' },
    });
    expect(
      parseClusterConnection(serializeClusterConnection(document)),
    ).toEqual(document);
  });

  it('rejects incomplete or non-JSON access material', () => {
    expect(() => parseInstallerAccessMaterial('not json')).toThrow(
      'not valid JSON',
    );
    expect(() =>
      parseInstallerAccessMaterial(
        JSON.stringify({ certificateAuthorityData: CA }),
      ),
    ).toThrow('incomplete');
  });
});

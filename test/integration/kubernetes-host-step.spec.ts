/**
 * The K3s step of `api upgrade` (RFC 0049 C26 (b)) against a real K3s server
 * at the management host's pinned version. The host is an Ubuntu container
 * running the pinned K3s release binary, verified as bootstrap verifies it,
 * with its processes moved out of the container's root cgroup as K3s's own
 * image does for its kubelet. It has
 * no systemd, so `systemctl` and `systemd-run` are small stand-ins: K3s and
 * the step's transient unit each run as a detached process recorded under
 * the unit's name, and a restart kills only the K3s server process, as
 * `KillMode=process` does. What runs is the host-step runner with the
 * reconfiguration script, both as the Job's Pod hands them to the host; the
 * Pod and `nsenter` around them, which only a live run covers, are not.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  HOST_STEP_RUNNER,
  parseHostStepReport,
} from '../../src/api/services/system-release/host-step.js';
import {
  managementKubernetesReconfigureScript,
  parseManagementReconfigure,
} from '../../src/api/services/system-release/management-host.js';
import {
  MANAGEMENT_MEMBER_LABEL,
  MANAGEMENT_NODE_NAME,
} from '../../src/shared/system-release.js';
import {
  SYSTEM_RELEASE_K3S_SHA256,
  SYSTEM_RELEASE_K3S_VERSION,
} from '../../src/shared/system-release.js';
import { retryTransientProbeError, Waiter } from './e2e/internal/wait.js';

const CONTAINER = `anycloud-kubernetes-host-step-${process.pid}`;
const HOST_IMAGE = 'mirror.gcr.io/library/ubuntu:24.04';
const TOKEN = 'hoststep-token.1';
const waiter = new Waiter(new AbortController().signal);
const scratch = mkdtempSync(path.join(tmpdir(), 'kubernetes-host-step-'));

/** systemctl and systemd-run for a host without systemd. */
const STAND_INS = String.raw`mkdir -p /sys/fs/cgroup/init /run/units
xargs -rn1 < /sys/fs/cgroup/cgroup.procs > /sys/fs/cgroup/init/cgroup.procs
sed -e 's/ / +/g' -e 's/^/+/' < /sys/fs/cgroup/cgroup.controllers > /sys/fs/cgroup/cgroup.subtree_control
cat > /usr/local/sbin/systemctl <<'TOOL'
#!/bin/bash
pid() { cat "/run/units/$1.pid" 2>/dev/null; }
alive() { [ -n "$(pid "$1")" ] && kill -0 "$(pid "$1")" 2>/dev/null; }
# systemd passes a unit none of its caller's file descriptors.
start() {
  alive "$1" && return 0
  (
    for fd in /proc/self/fd/*; do n=${'$'}{fd##*/}; [ "$n" -gt 2 ] && eval "exec $n>&-"; done
    exec setsid nohup /usr/local/bin/k3s server >> /var/log/k3s.log 2>&1 < /dev/null
  ) &
  echo $! > "/run/units/$1.pid"
}
case "$1" in
  is-active) alive "$3" ;;
  enable) start "$3" ;;
  restart) if alive "$2"; then kill "$(pid "$2")"; while alive "$2"; do sleep 1; done; fi; start "$2" ;;
  *) exit 0 ;;
esac
TOOL
cat > /usr/local/sbin/systemd-run <<'TOOL'
#!/bin/bash
while [ "$1" != -- ]; do case "$1" in --unit=*) unit=${'$'}{1#--unit=} ;; esac; shift; done
shift
setsid nohup "$@" > /dev/null 2>&1 < /dev/null &
echo $! > "/run/units/$unit.service.pid"
TOOL
chmod 755 /usr/local/sbin/systemctl /usr/local/sbin/systemd-run`;

function docker(args: string[], input?: string): string {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function sh(command: string, input?: string): string {
  return docker(['exec', '-i', CONTAINER, 'bash', '-c', command], input);
}

function k3sPid(): string {
  return sh('cat /run/units/k3s-anycloud.service.pid').trim();
}

async function waitReady(): Promise<void> {
  await waiter.for(
    'K3s ready with its management Node',
    () =>
      Promise.resolve(
        sh(
          `k3s kubectl get --raw /readyz 2>/dev/null && k3s kubectl get node ${MANAGEMENT_NODE_NAME} -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || true`,
        ).trim(),
      ),
    {
      timeoutMs: 240_000,
      probeError: retryTransientProbeError,
      unmet: (value) => (value === 'okTrue' ? undefined : `got: ${value}`),
    },
  );
}

/** One host step, as the Job's Pod runs it: the runner, with the script on stdin. */
function runStep(unit: string): { code: number; output: string } {
  const address = sh('getent hosts "$(cat /etc/hostname)"').split(' ')[0];
  const report = parseHostStepReport(
    docker(
      ['exec', '-i', CONTAINER, 'bash', '-c', HOST_STEP_RUNNER, 'runner', unit],
      managementKubernetesReconfigureScript({
        publicIp: address,
        issuerUrl: 'https://c-1.anycloud.sh',
      }),
    ),
  );
  if (!report) throw new Error('the runner reported no result');
  return report;
}

describe('the K3s host step on real K3s', () => {
  beforeAll(async () => {
    docker(['rm', '-f', '--volumes', CONTAINER]);
    // The binary bootstrap installs, checked against the pinned digest.
    const response = await fetch(
      `https://github.com/k3s-io/k3s/releases/download/${encodeURIComponent(SYSTEM_RELEASE_K3S_VERSION)}/k3s`,
    );
    if (!response.ok) throw new Error(`K3s download: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      SYSTEM_RELEASE_K3S_SHA256,
    );
    const binary = path.join(scratch, 'k3s');
    writeFileSync(binary, bytes, { mode: 0o755 });
    docker([
      'run',
      '-d',
      '--privileged',
      // An init that reaps, so a stopped K3s server doesn't linger as a zombie.
      '--init',
      '--tmpfs',
      '/run',
      '--tmpfs',
      '/var/run',
      // Volumes, as K3s's image declares, so containerd's overlays aren't nested.
      ...[
        '/var/lib/rancher/k3s',
        '/var/lib/kubelet',
        '/var/lib/cni',
        '/var/log',
      ].flatMap((volume) => ['--volume', volume]),
      '--name',
      CONTAINER,
      HOST_IMAGE,
      'sleep',
      'infinity',
    ]);
    docker(['cp', binary, `${CONTAINER}:/usr/local/bin/k3s`]);
    sh(STAND_INS);
    // What bootstrap leaves on a cluster: its token, before this release's settings.
    sh(
      `mkdir -p /etc/rancher/k3s && printf 'token: ${TOKEN}\\nnode-name: ${MANAGEMENT_NODE_NAME}\\ndisable:\\n  - traefik\\n' > /etc/rancher/k3s/config.yaml && systemctl enable --now k3s-anycloud.service`,
    );
    await waitReady();
  }, 300_000);

  afterAll(() => {
    docker(['rm', '-f', '--volumes', CONTAINER]);
    rmSync(scratch, { recursive: true, force: true });
  });

  it('labels the Node, restarts K3s onto the configuration with the host token, and is ready when it reports', () => {
    const before = k3sPid();
    expect(
      sh(
        `k3s kubectl get node ${MANAGEMENT_NODE_NAME} -o jsonpath='{.metadata.labels}'`,
      ),
    ).not.toContain(MANAGEMENT_MEMBER_LABEL);

    const result = runStep('anycloud-host-kubernetes-first');

    expect(result.code, result.output).toBe(0);
    expect(parseManagementReconfigure(result.output)).toBe('changed');
    expect(k3sPid()).not.toBe(before);
    // The step reports only once K3s is ready on the new configuration.
    expect(sh('k3s kubectl get --raw /readyz')).toBe('ok');
    const config = sh('cat /etc/rancher/k3s/config.yaml');
    expect(config.split('\n')[0]).toBe(`token: ${TOKEN}`);
    expect(config).toContain('egress-selector-mode: cluster');
    expect(
      sh(
        `k3s kubectl get node ${MANAGEMENT_NODE_NAME} -o jsonpath='{.metadata.labels}'`,
      ),
    ).toContain(`"${MANAGEMENT_MEMBER_LABEL}":"true"`);
    // The API server runs on the new configuration: it signs as the public issuer.
    expect(
      JSON.parse(sh('k3s kubectl get --raw /.well-known/openid-configuration')),
    ).toMatchObject({ issuer: 'https://c-1.anycloud.sh' });
  });

  it('leaves a current configuration and K3s as they are', () => {
    const before = k3sPid();
    const result = runStep('anycloud-host-kubernetes-second');
    expect(result.code, result.output).toBe(0);
    expect(parseManagementReconfigure(result.output)).toBe('current');
    expect(k3sPid()).toBe(before);
  });
});

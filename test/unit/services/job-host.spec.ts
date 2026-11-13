import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  generateJobHostUserData,
  JOB_HOST_DOCKER,
  JOB_HOST_UNPACKS,
  jobHostPrepare,
  jobHostPrePull,
  waitForJobHostDocker,
} from '../../../src/api/services/job-host.js';
import {
  CONTAINERD_STORE_DAEMON_CONFIG_COMMAND,
  DOCKER_DAEMON_CONFIG_COMMAND,
  IPTABLES_DEBS,
  JOB_HOST_DOCKER_VERSION,
  PIGZ_DEBS,
} from '../../../src/api/runtime-artifacts.js';
import { log } from '../../../src/api/services/logger.js';
import { CloudType, GpuRuntime } from '../../../src/shared/cloud.js';

const keys = { publicKey: 'ssh-ed25519 AAAAC3Nza anycloud', privateKey: '' };
const IMAGE = 'ghcr.io/acme/train:1';
/** A `sha256sum -c -` stub: the pinned hash for the file, and `ok` content. */
const PINNED_CHECK = `read -r h f
case "$h \${f##*/}" in ${[
  ...IPTABLES_DEBS.x86_64,
  ...IPTABLES_DEBS.aarch64,
  PIGZ_DEBS.x86_64,
  PIGZ_DEBS.aarch64,
]
  .map((d) => `"${d.sha256} ${d.url.split('/').pop()}"`)
  .join(
    '|',
  )}) ;; *"pigz.deb") [ "$h" = ${PIGZ_DEBS.x86_64.sha256} ] || exit 1 ;; *) exit 1 ;; esac
[ "$(cat "$f")" = ok ]`;
const host = (
  prePullImage: string | null,
  ubuntuMirror: string | null = null,
) => ({ prePullImage, ubuntuMirror });

/** The cloud-config's single bootcmd, and the preparation script it unpacks. */
function parse(userData: string): { bootcmd: string; script: string } {
  const [header, body] = userData.split('\n');
  expect(header).toBe('#cloud-config');
  const config = JSON.parse(body!) as { bootcmd: string[][] };
  const bootcmd = config.bootcmd[0]![2]!;
  const packed = /echo (\S+) \| base64 -d \| gunzip/.exec(bootcmd)![1]!;
  return {
    bootcmd,
    script: gunzipSync(Buffer.from(packed, 'base64')).toString('utf8'),
  };
}

describe('generateJobHostUserData', () => {
  it('adds the key, starts the preparation in its own unit and masks apt', () => {
    const { bootcmd, script } = parse(
      generateJobHostUserData(keys, host(IMAGE)),
    );
    expect(bootcmd).toContain(
      "echo 'ssh-ed25519 AAAAC3Nza anycloud' >> /root/.ssh/authorized_keys",
    );
    expect(bootcmd).toContain(
      'systemd-run --no-block --unit=anycloud-prepare -p DefaultDependencies=no',
    );
    expect(bootcmd).toMatch(
      /systemctl mask --now apt-daily\.timer .*unattended-upgrades\.service/,
    );
    // The unit starts before apt is masked, so masking never delays it.
    expect(bootcmd.indexOf('systemd-run')).toBeLessThan(
      bootcmd.indexOf('systemctl mask'),
    );
    execFileSync('bash', ['-n'], { input: script });
    expect(script).toContain(`docker pull '${IMAGE}'`);
    expect(script).toContain('/dev/disk/cloud/azure_resource-part1');
    // iptables comes from the pinned debs, checked, not from apt's sources.
    expect(script).toContain('iptables_1.8.10-3ubuntu2_amd64.deb');
    expect(script).toContain('sha256sum -c -');
    expect(script).not.toContain('apt-get');
    // Every download and pull attempt is bounded, so a stall hands over.
    expect(script).not.toMatch(/curl -fsSL --retry/);
    expect(script).toMatch(/timeout \d+ docker pull/);
    expect(script).toContain('[ "$rc" = 124 ] && break');
    // A failed prepare keeps its evidence for waitForJobHostDocker.
    expect(script).toContain('>"$dir/docker-install.log" 2>&1');
    expect(script).toMatch(/journalctl -u docker .*\} > "\$dir\/failure\.log"/);
  });

  it('installs Docker without a pull when there is no public image', () => {
    const { script } = parse(generateJobHostUserData(keys, host(null)));
    execFileSync('bash', ['-n'], { input: script });
    expect(script).toContain('systemctl enable --now docker');
    // The NIC's MTU and the open-file limit, written before dockerd starts.
    expect(
      script.indexOf(CONTAINERD_STORE_DAEMON_CONFIG_COMMAND),
    ).toBeGreaterThan(0);
    expect(script.indexOf(CONTAINERD_STORE_DAEMON_CONFIG_COMMAND)).toBeLessThan(
      script.indexOf('systemctl enable --now docker'),
    );
    expect(script).not.toContain('docker pull');
  });

  it("writes the host dockerd's config: NIC MTU, nofile and the Hub mirror", () => {
    const config = (command: string) =>
      JSON.parse(
        /printf '(\{.*\})\\n'/.exec(command)![1]!.replaceAll('%s', '1460'),
      ) as Record<string, unknown>;
    // A Job host's Docker 29 is on the containerd image store.
    expect(config(CONTAINERD_STORE_DAEMON_CONFIG_COMMAND)).toEqual({
      ...config(DOCKER_DAEMON_CONFIG_COMMAND),
      features: { 'containerd-snapshotter': true },
    });
    expect(config(DOCKER_DAEMON_CONFIG_COMMAND)).toEqual({
      mtu: 1460,
      'default-network-opts': {
        bridge: { 'com.docker.network.driver.mtu': '1460' },
      },
      'default-ulimits': {
        nofile: { Name: 'nofile', Soft: 1048576, Hard: 1048576 },
      },
      'registry-mirrors': ['https://mirror.gcr.io'],
    });
    // An image's own config stays.
    expect(DOCKER_DAEMON_CONFIG_COMMAND).toMatch(
      /^\[ -s \/etc\/docker\/daemon\.json \] \|\|/,
    );
  });

  /**
   * Runs the user data's install_iptables with stub tools: `curl` (each body
   * gets the URL and the output file), `sha256sum` (gets the check line) and
   * a `dpkg` that records the debs it installs.
   */
  function installIptables(
    ubuntuMirror: string | null,
    stubs: { curl: string; sha256sum: string; uname?: string },
  ) {
    const { script } = parse(
      generateJobHostUserData(keys, host(null, ubuntuMirror)),
    );
    const fns =
      /^fetch_deb\(\) \{\n[\s\S]*?\n\}\ninstall_iptables\(\) \{\n[\s\S]*?\n\}$/m.exec(
        script,
      )![0];
    const bin = mkdtempSync(join(tmpdir(), 'iptables-'));
    for (const [name, body] of Object.entries({
      uname: 'echo x86_64',
      ...stubs,
      curl: `for a; do [ "$a" = -o ] && break; url=$a; done
out=\${@: -1}
echo "$url" >> "$BIN/urls"
${stubs.curl}`,
      dpkg: 'shift; for f; do echo "${f##*/}"; done > "$BIN/installed"',
    }))
      writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`, {
        mode: 0o755,
      });
    const { status } = spawnSync('bash', ['-c', `${fns}\ninstall_iptables`], {
      env: { PATH: `${bin}:/usr/bin:/bin`, BIN: bin },
    });
    const lines = (file: string) =>
      existsSync(join(bin, file)) &&
      readFileSync(join(bin, file), 'utf8').trim().split('\n').sort();
    const result = {
      status,
      installed: lines('installed'),
      urls: lines('urls'),
    };
    rmSync(bin, { recursive: true });
    return result;
  }
  const names = (debs: readonly { url: string }[]) =>
    debs.map((d) => d.url.split('/').pop()).sort();

  it('fetches the iptables debs in parallel, and installs none when one fails its check', () => {
    const debs = IPTABLES_DEBS.x86_64.length;
    // Each download waits until all have started, so one-at-a-time fails.
    const curl = `touch "$BIN/started.\${out##*/}"
for _ in {1..100}; do
  started=("$BIN"/started.*)
  [ \${#started[@]} -ge ${debs} ] && { echo deb > "$out"; exit 0; }
  sleep 0.05
done
exit 1`;

    expect(
      installIptables(null, { curl, sha256sum: 'cat >/dev/null' }),
    ).toMatchObject({ status: 0, installed: names(IPTABLES_DEBS.x86_64) });
    expect(
      installIptables(null, {
        curl,
        sha256sum: 'read -r _ f; case $f in *libip4tc2*) exit 1 ;; esac',
      }),
    ).toMatchObject({ status: 1, installed: false });
  });

  it("fetches the debs from the cloud's mirror, and from the archive when it is down or serves another package", () => {
    // The mirror and the archive each serve `ok`, a package other than the
    // pinned one (`bad`), or nothing (`down`); only `ok` matches the pin.
    const serving = (mirror: string, archive: string) => ({
      curl: `case $url in http://us-east-1.ec2.*) s=${mirror} ;; *) s=${archive} ;; esac
[ "$s" = down ] && exit 7
echo "$s" > "$out"`,
      sha256sum: PINNED_CHECK,
    });
    const archive = IPTABLES_DEBS.x86_64.map((d) => d.url).sort();
    const mirrored = (debs: readonly { url: string }[], prefix: string) =>
      debs
        .map((d) => d.url.replace(/^https:\/\/[^/]+\/[^/]+\//, prefix))
        .sort();

    expect(installIptables('us-east-1.ec2', serving('ok', 'down'))).toEqual({
      status: 0,
      installed: names(IPTABLES_DEBS.x86_64),
      urls: mirrored(
        IPTABLES_DEBS.x86_64,
        'http://us-east-1.ec2.archive.ubuntu.com/ubuntu/',
      ),
    });
    expect(
      installIptables('us-east-1.ec2', {
        ...serving('ok', 'down'),
        uname: 'echo aarch64',
      }),
    ).toEqual({
      status: 0,
      installed: names(IPTABLES_DEBS.aarch64),
      urls: mirrored(
        IPTABLES_DEBS.aarch64,
        'http://us-east-1.ec2.ports.ubuntu.com/ubuntu-ports/',
      ),
    });
    for (const mirror of ['down', 'bad']) {
      const result = installIptables('us-east-1.ec2', serving(mirror, 'ok'));
      expect(result).toMatchObject({
        status: 0,
        installed: names(IPTABLES_DEBS.x86_64),
      });
      expect(result.urls).toEqual(expect.arrayContaining(archive));
    }
    // The archive's package must match the pin too.
    expect(
      installIptables('us-east-1.ec2', serving('bad', 'bad')),
    ).toMatchObject({ status: 1, installed: false });
    // Without a mirror, only the archive.
    expect(installIptables(null, serving('ok', 'ok'))).toMatchObject({
      status: 0,
      urls: archive,
    });
  });

  it('installs unpigz, from the mirror, before dockerd starts', () => {
    const { script } = parse(
      generateJobHostUserData(keys, host(null, 'us-east-1.ec2')),
    );
    const root = mkdtempSync(join(tmpdir(), 'job-host-unpigz-'));
    const bin = join(root, 'bin');
    const payload = join(root, 'payload');
    mkdirSync(bin);
    mkdirSync(join(payload, 'usr/bin'), { recursive: true });
    writeFileSync(
      join(payload, 'usr/bin/pigz'),
      '#!/bin/sh\nexec gzip "$@"\n',
      { mode: 0o755 },
    );
    const events = join(root, 'events');
    for (const [name, body] of Object.entries({
      // Docker and iptables are present, so only unpigz installs.
      dockerd: '',
      iptables: '',
      uname: 'echo x86_64',
      curl: `for a; do [ "$a" = -o ] && break; url=$a; done
echo "curl $url" >> '${events}'
for out; do :; done
case $url in http://us-east-1.ec2.*) echo ok > "$out" ;; *) exit 7 ;; esac`,
      sha256sum: PINNED_CHECK,
      'dpkg-deb': `tar -cf - -C '${payload}' ./usr/bin/pigz`,
      install: `echo "install $*" >> '${events}'`,
      systemctl: `echo "systemctl $*" >> '${events}'`,
      // Docker 29 on the containerd store, which start_docker checks.
      docker: `case "$1" in version) echo ${JOB_HOST_DOCKER_VERSION} ;; info) echo '[["driver-type","io.containerd.snapshotter.v1"]]' ;; esac`,
    }))
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    const dir = join(root, 'prepare');
    const { status } = spawnSync(
      'bash',
      ['-c', script.replaceAll('/run/anycloud/prepare', dir)],
      { env: { PATH: `${bin}:/usr/bin:/bin` } },
    );

    expect(status).toBe(0);
    expect(readFileSync(join(dir, 'docker'), 'utf8')).toBe('0\n');
    const log = readFileSync(events, 'utf8').split('\n');
    const unpigz = log.findIndex((e) => e.endsWith(' /usr/local/bin/unpigz'));
    expect(unpigz).toBeGreaterThanOrEqual(0);
    expect(unpigz).toBeLessThan(log.indexOf('systemctl enable --now docker'));
    expect(log).toContain(
      `curl ${PIGZ_DEBS.x86_64.url.replace('https://archive.', 'http://us-east-1.ec2.archive.')}`,
    );
    rmSync(root, { recursive: true });
  });

  it('refuses an empty key', () => {
    expect(() =>
      generateJobHostUserData({ publicKey: ' ', privateKey: '' }, host(IMAGE)),
    ).toThrow('SSH public key is required');
  });
});

/** The real tools the scripts below use, so a sandbox's PATH holds only them and stubs. */
const TOOLS = [
  'awk',
  'base64',
  'basename',
  'bash',
  'cat',
  'chmod',
  'cut',
  'env',
  'grep',
  'gzip',
  'head',
  'mkdir',
  'mktemp',
  'mv',
  'readlink',
  'rm',
  'sed',
  'seq',
  'tar',
  'timeout',
  'tr',
  'uname',
];

/**
 * A scratch root whose PATH has only TOOLS and these stub commands; each stub
 * logs its arguments to `calls` and runs its body.
 */
function sandbox(stubs: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'job-host-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  for (const tool of TOOLS.filter((t) => !(t in stubs)))
    symlinkSync(
      execFileSync('bash', ['-c', `command -v ${tool}`], {
        encoding: 'utf8',
      }).trim(),
      join(bin, tool),
    );
  const calls = join(root, 'calls');
  for (const [name, body] of Object.entries(stubs))
    writeFileSync(
      join(bin, name),
      `#!${join(bin, 'bash')}\necho "${name} $*" >> ${calls}\n${body}\n`,
      { mode: 0o755 },
    );
  return {
    root,
    run: (script: string) =>
      execFileSync(join(bin, 'bash'), ['-c', script], {
        encoding: 'utf8',
        env: { PATH: bin },
      }),
    calls: () => (existsSync(calls) ? readFileSync(calls, 'utf8') : ''),
  };
}

describe('JOB_HOST_DOCKER', () => {
  /** install_docker with / at a scratch root and a stub download of `files`. */
  function install(prepare?: (root: string) => void) {
    const archive = mkdtempSync(join(tmpdir(), 'docker-archive-'));
    mkdirSync(join(archive, 'docker'));
    for (const binary of ['dockerd', 'containerd', 'ctr'])
      writeFileSync(join(archive, 'docker', binary), '');
    execFileSync('tar', [
      'czf',
      join(archive, 'docker.tgz'),
      '-C',
      archive,
      'docker',
    ]);
    const host = sandbox({
      // The archive, at curl's -o.
      curl: `while [ "$1" != -o ]; do shift; done; cat ${join(archive, 'docker.tgz')} > "$2"`,
    });
    mkdirSync(join(host.root, 'usr/bin'), { recursive: true });
    prepare?.(host.root);
    const at = (path: string) => join(host.root, path);
    let status = 0;
    try {
      host.run(
        `${JOB_HOST_DOCKER.replaceAll('/etc/', `${at('etc')}/`).replaceAll('/usr/bin/', `${at('usr/bin')}/`)}\ninstall_docker`,
      );
    } catch (error) {
      status = (error as { status: number }).status;
    }
    return { status, at, calls: host.calls() };
  }

  it('installs Docker 29 on a containerd with parallel unpacks', () => {
    const { status, at, calls } = install();
    expect(status).toBe(0);
    expect(calls).toContain(`docker-${JOB_HOST_DOCKER_VERSION}.tgz`);
    expect(JOB_HOST_DOCKER_VERSION).toMatch(/^29\./);
    expect(existsSync(at('usr/bin/dockerd'))).toBe(true);
    expect(readFileSync(at('etc/containerd/config.toml'), 'utf8')).toMatch(
      new RegExp(
        `^version = 3\\n[^]*\\[plugins\\."io\\.containerd\\.transfer\\.v1\\.local"\\]\\n[^]*max_concurrent_unpacks = ${JOB_HOST_UNPACKS}\\n`,
      ),
    );
    expect(JOB_HOST_UNPACKS).toBe(4);
    const dropIn = readFileSync(
      at('etc/systemd/system/docker.service.d/anycloud-containerd.conf'),
      'utf8',
    );
    // Docker on the containerd that has that config, at Docker 27's minimum API.
    expect(dropIn).toContain('Requires=containerd.service');
    expect(dropIn).toMatch(
      /ExecStart=\n.*ExecStart=\S*dockerd --containerd=\/run\/containerd\/containerd\.sock/s,
    );
    expect(dropIn).toContain('Environment=DOCKER_MIN_API_VERSION=1.24');
    expect(
      readFileSync(at('etc/systemd/system/containerd.service'), 'utf8'),
    ).toMatch(/^ExecStart=\S*\/usr\/bin\/containerd$/m);
    expect(
      JSON.parse(readFileSync(at('etc/docker/daemon.json'), 'utf8')).features,
    ).toEqual({ 'containerd-snapshotter': true });
  });

  it("never lands dockerd without the containerd store's config", () => {
    // /etc/docker can't be made, so daemon.json can't be written.
    const { status, at } = install((root) => {
      mkdirSync(join(root, 'etc'));
      writeFileSync(join(root, 'etc/docker'), '');
    });
    expect(status).not.toBe(0);
    expect(existsSync(at('usr/bin/dockerd'))).toBe(false);
  });
});

/**
 * The preparation script on a host whose Docker is already installed, with
 * stub systemd, Docker and ctr: Docker `version` on store `driverStatus`, and
 * the transfer's and `docker pull`'s exit codes.
 */
function prepare(
  image: string | null,
  {
    version = JOB_HOST_DOCKER_VERSION,
    driverStatus = '[["driver-type","io.containerd.snapshotter.v1"]]',
    ctr = 0,
    pull = 0,
    transferTimesOut = false,
    resourceDisk = undefined as
      | { mounted: boolean; kib: number; rootKib: number }
      | undefined,
  } = {},
) {
  const realTimeout = execFileSync('bash', ['-c', 'command -v timeout'], {
    encoding: 'utf8',
  }).trim();
  const vm = sandbox({
    timeout: `case "$*" in *transfer-pull.sh*) ${transferTimesOut ? 'exit 124' : ''} ;; esac
exec ${realTimeout} "$@"`,
    dockerd: '',
    iptables: '',
    systemctl: '[ "$1" = is-active ] && exit 3; exit 0',
    findmnt: resourceDisk?.mounted ? 'echo /mnt' : '',
    df: `echo Filesystem; case "$2" in /) echo "root ${resourceDisk?.rootKib}" ;; *) echo "disk ${resourceDisk?.kib}" ;; esac`,
    journalctl: '',
    sync: '',
    sleep: '',
    ctr: `exit ${ctr}`,
    docker: `case "$1 $2 $3" in
  'version --format {{.Server.Version}}') echo ${version} ;;
  'info --format {{json .DriverStatus}}') echo '${driverStatus}' ;;
  'info --format {{.Driver}}') echo overlayfs ;;
  pull*) exit ${pull} ;;
esac`,
  });
  const dir = join(vm.root, 'prepare');
  const at = (path: string) => join(vm.root, path);
  mkdirSync(at('etc/systemd/system'), { recursive: true });
  if (resourceDisk) {
    mkdirSync(at('dev/disk/cloud'), { recursive: true });
    writeFileSync(at('dev/disk/cloud/azure_resource-part1'), '');
  }
  const { script } = parse(generateJobHostUserData(keys, host(image)));
  vm.run(
    script
      .replaceAll('/run/anycloud/prepare', dir)
      .replaceAll('/dev/disk/', `${at('dev/disk')}/`)
      .replaceAll('/etc/systemd/', `${at('etc/systemd')}/`),
  );
  const read = (name: string) =>
    existsSync(join(dir, name))
      ? readFileSync(join(dir, name), 'utf8').trim()
      : null;
  const storeUnit = at('etc/systemd/system/anycloud-image-store.service');
  return {
    read,
    calls: vm.calls(),
    storeUnit: existsSync(storeUnit) ? readFileSync(storeUnit, 'utf8') : null,
  };
}

describe('the Job host preparation', () => {
  it('pulls through containerd transfer into Docker 29 on the containerd store', () => {
    const { read, calls } = prepare('ubuntu:24.04');
    expect(read('docker')).toBe('0');
    expect(read('pull')).toBe('0');
    expect(read('method')).toBe('containerd-transfer');
    expect(calls).toContain(
      'ctr --address /run/containerd/containerd.sock --namespace moby images pull --snapshotter overlayfs docker.io/library/ubuntu:24.04',
    );
    expect(calls).not.toContain('docker pull');
  });

  it('falls back to docker pull when the transfer fails', () => {
    const { read, calls } = prepare(IMAGE, { ctr: 1 });
    expect(read('pull')).toBe('0');
    expect(read('method')).toBe('docker-fallback');
    expect(calls).toContain(`docker pull ${IMAGE}`);
    expect(calls.indexOf('ctr ')).toBeLessThan(calls.indexOf('docker pull'));
  });

  it('leaves a timed-out transfer to the SSH pull', () => {
    const { read, calls } = prepare(IMAGE, { transferTimesOut: true });
    expect(read('pull')).toBe('124');
    expect(calls).not.toContain('docker pull');
  });

  it('records a failed pull when both fail', () => {
    const { read } = prepare(IMAGE, { ctr: 1, pull: 1 });
    expect(read('docker')).toBe('0');
    expect(read('pull')).toBe('1');
  });

  it('stops a Docker 29 on overlay2 and pulls nothing', () => {
    const { read, calls } = prepare(IMAGE, {
      driverStatus: '[["Backing Filesystem","extfs"]]',
    });
    expect(read('docker')).not.toBe('0');
    expect(calls).toContain('systemctl disable --now docker');
    expect(read('pull')).toBeNull();
    expect(calls).not.toMatch(/^(ctr |docker pull)/m);
  });

  it("moves the image stores to Azure's resource disk before Docker starts, and pre-pulls there", () => {
    const { read, calls, storeUnit } = prepare(IMAGE, {
      resourceDisk: { mounted: true, kib: 157_286_400, rootKib: 30_408_704 },
    });
    expect(storeUnit).toContain('RequiresMountsFor=/mnt\n');
    expect(storeUnit).toContain(
      'mount --bind /mnt/anycloud/docker /var/lib/docker',
    );
    expect(calls).toContain(
      'systemctl start anycloud-image-store.service\nsystemctl daemon-reload\nsystemctl enable --now docker',
    );
    expect(read('docker')).toBe('0');
    expect(read('pull')).toBe('0');
  });

  it('pre-pulls on the OS disk beside a resource disk smaller than it', () => {
    const { read, calls, storeUnit } = prepare(IMAGE, {
      resourceDisk: { mounted: true, kib: 8_388_608, rootKib: 30_408_704 },
    });
    expect(storeUnit).toBeNull();
    expect(calls).not.toContain('anycloud-image-store');
    expect(read('pull')).toBe('0');
  });

  it('starts Docker but pulls nothing when the resource disk is never mounted', () => {
    // initializeVM's own store move would hide the pull.
    const { read, calls, storeUnit } = prepare(IMAGE, {
      resourceDisk: { mounted: false, kib: 0, rootKib: 30_408_704 },
    });
    expect(storeUnit).toBeNull();
    expect(read('docker')).toBe('0');
    expect(calls).toContain('systemctl enable --now docker');
    expect(read('image')).toBeNull();
    expect(calls).not.toMatch(/^(ctr |docker pull)/m);
  });

  it('keeps an older Docker an earlier release installed', () => {
    const { read, calls } = prepare(null, {
      version: '27.5.1',
      driverStatus: '[["Backing Filesystem","extfs"]]',
    });
    expect(read('docker')).toBe('0');
    expect(calls).not.toContain('systemctl disable');
  });
});

describe('jobHostPrepare', () => {
  const job = {
    workloadType: 'job',
    image: IMAGE,
    imageDigest: null,
    githubToken: null,
    registryUsername: null,
  } as const;
  const aws = { cloudProvider: CloudType.AWS };

  afterEach(() => vi.unstubAllEnvs());

  it("pre-pulls a public image for a CPU VM Job on a preparing cloud, from the cloud's Ubuntu mirror", () => {
    for (const [cloudProvider, region, ubuntuMirror] of [
      [CloudType.AWS, 'us-east-1', 'us-east-1.ec2'],
      [CloudType.GCP, 'us-central1', 'us-central1.gce'],
      [CloudType.Azure, 'eastus', 'azure'],
      // An unknown or unusable region has no mirror.
      [CloudType.AWS, undefined, null],
      [CloudType.GCP, 'us-central1; reboot', null],
    ] as const)
      expect(jobHostPrepare(job, { cloudProvider, region }, null)).toEqual({
        prePullImage: IMAGE,
        ubuntuMirror,
      });
  });

  it('pins a digest the Job resolved', () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    expect(jobHostPrepare({ ...job, imageDigest: digest }, aws, null)).toEqual({
      prePullImage: `ghcr.io/acme/train@${digest}`,
      ubuntuMirror: null,
    });
  });

  it('leaves an unparseable reference to the SSH pull', () => {
    expect(
      jobHostPrepare({ ...job, image: 'Acme/Train:1' }, aws, null),
    ).toEqual({ prePullImage: null, ubuntuMirror: null });
  });

  it('leaves a private image to the SSH pull', () => {
    vi.stubEnv('IS_TEST', 'false');
    expect(
      jobHostPrepare(
        { ...job, githubToken: 'ghp_x', registryUsername: 'acme' },
        aws,
        null,
      ),
    ).toEqual({ prePullImage: null, ubuntuMirror: null });
  });

  it('prepares no GPU host, other workload, or other cloud', () => {
    expect(jobHostPrepare(job, aws, GpuRuntime.Cuda)).toBeUndefined();
    expect(
      jobHostPrepare({ ...job, workloadType: 'service' }, aws, null),
    ).toBeUndefined();
    expect(
      jobHostPrepare(job, { cloudProvider: CloudType.Lambda }, null),
    ).toBeUndefined();
  });
});

/**
 * Runs a host command under bash with the preparation directory in a scratch
 * one and a stub `docker` whose `image inspect` succeeds when `present`.
 */
function onHost(files: Record<string, string>, present = true) {
  const root = mkdtempSync(join(tmpdir(), 'job-host-'));
  const dir = join(root, 'prepare');
  const bin = join(root, 'bin');
  // No files: no preparation ran, so there's no directory.
  if (Object.keys(files).length) mkdirSync(dir);
  mkdirSync(bin);
  for (const [name, content] of Object.entries(files))
    writeFileSync(join(dir, name), content);
  writeFileSync(join(bin, 'docker'), `#!/bin/sh\nexit ${present ? 0 : 1}\n`, {
    mode: 0o755,
  });
  return {
    exec: vi.fn(async (command: string) => ({
      stdout: execFileSync(
        'bash',
        ['-c', command.replaceAll('/run/anycloud/prepare', dir)],
        {
          encoding: 'utf8',
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        },
      ),
    })),
    bin,
  };
}

describe('jobHostPrePull', () => {
  it('uses a finished pull of the same image', async () => {
    const host = onHost({ image: `${IMAGE}\n`, pull: '0\n' });
    await expect(jobHostPrePull(host, 'job-a', IMAGE)).resolves.toMatchObject({
      method: 'docker',
      outcome: 'succeeded',
      alreadyPresent: true,
      reason: 'prepulled',
    });
  });

  it("reports the pull's method", async () => {
    for (const method of ['containerd-transfer', 'docker-fallback'] as const) {
      const host = onHost({
        image: `${IMAGE}\n`,
        pull: '0\n',
        method: `${method}\n`,
      });
      await expect(jobHostPrePull(host, 'job-a', IMAGE)).resolves.toMatchObject(
        { method, reason: 'prepulled' },
      );
    }
  });

  it('pulls again for another image, a failed pull, a missing image or no preparation', async () => {
    for (const host of [
      onHost({ image: 'ghcr.io/acme/other:1\n', pull: '0\n' }),
      onHost({ image: `${IMAGE}\n`, pull: '1\n' }),
      onHost({ image: `${IMAGE}\n`, pull: '0\n' }, false),
      onHost({}),
    ])
      await expect(jobHostPrePull(host, 'job-a', IMAGE)).resolves.toBeNull();
    const broken = {
      exec: vi.fn(async () => {
        throw new Error('ssh down');
      }),
    };
    await expect(jobHostPrePull(broken, 'job-a', IMAGE)).resolves.toBeNull();
  });

  it('waits out a pull in progress', async () => {
    const host = {
      exec: vi
        .fn()
        .mockResolvedValueOnce({ stdout: 'pending\n' })
        .mockResolvedValueOnce({ stdout: 'ready\n' }),
    };
    await expect(jobHostPrePull(host, 'job-a', IMAGE)).resolves.not.toBeNull();
    expect(host.exec).toHaveBeenCalledTimes(2);
  });
});

describe('waitForJobHostDocker', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns at once with no preparation, and when Docker is ready', async () => {
    for (const files of [{}, { docker: '0\n' }] as Record<string, string>[]) {
      const host = onHost(files);
      await waitForJobHostDocker(host.exec, 'job-a', '10.0.0.1');
      expect(host.exec).toHaveBeenCalledTimes(1);
    }
  });

  it("logs a failed prepare's evidence before installing over SSH", async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const host = onHost({
      docker: '1\n',
      'failure.log':
        'install_docker=22 install_iptables=0\nUnit docker.service could not be found.\n',
      'docker-install.log':
        'curl: (22) The requested URL returned error: 503\n',
    });
    // A stand-in iptables, so the probe's iptables fallback stays offline.
    writeFileSync(join(host.bin, 'iptables'), '#!/bin/sh\n', { mode: 0o755 });
    await waitForJobHostDocker(host.exec, 'job-a', '10.0.0.1');
    expect(warn).toHaveBeenCalledWith(
      'Job host Docker prepare failed; installing over SSH',
      expect.objectContaining({ status: '1' }),
    );
    const { evidence } = warn.mock.calls[0]![1] as { evidence: string };
    expect(evidence).toContain('install_docker=22 install_iptables=0');
    expect(evidence).toContain('returned error: 503');
  });

  it('is best-effort', async () => {
    const exec = vi.fn(async () => {
      throw new Error('ssh down');
    });
    await expect(
      waitForJobHostDocker(exec, 'job-a', '10.0.0.1'),
    ).resolves.toBeUndefined();
  });
});

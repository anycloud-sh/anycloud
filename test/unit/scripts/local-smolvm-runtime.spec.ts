import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildLocalSmolvmRunnerImageScript } from '../../../scripts/ci/local-smolvm-runner-image.js';
import { LOCAL_SMOLVM_CONTRACT } from '../../../src/api/services/gateways/local-smolvm-contract.js';
import {
  buildLocalSmolvmRuntimeSetupScript,
  localSmolvmRunnerBuildFingerprint,
} from '../../../scripts/ci/local-smolvm-runtime.js';

// The contract reads its bucket root once, at import: these assertions are of
// the default, whatever a developer's shell exports.
vi.hoisted(() => {
  vi.stubEnv('ANYCLOUD_TEST_LOCAL_BUCKET_ROOT', '');
});

describe('Local smolvm runtime setup', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('moves the bucket root to the directory CI shares with its Docker daemon', async () => {
    vi.stubEnv(
      'ANYCLOUD_TEST_LOCAL_BUCKET_ROOT',
      '/tmp/anycloud-local-buckets-1',
    );
    vi.resetModules();
    const { LOCAL_SMOLVM_CONTRACT: contract } = await import(
      '../../../src/api/services/gateways/local-smolvm-contract.js'
    );
    const { buildLocalSmolvmRuntimeSetupScript: setup } = await import(
      '../../../scripts/ci/local-smolvm-runtime.js'
    );
    expect(contract.bucketHostPath).toBe('/tmp/anycloud-local-buckets-1');
    expect(setup()).toContain("BUCKET_ROOT='/tmp/anycloud-local-buckets-1'");
    // SmolVM's own state stays inside the runner.
    expect(contract.runnerSidecarPath).toBe(
      '/var/lib/anycloud-test/local/runner-cow-v1.smolmachine',
    );
  });

  it.each(['relative/buckets', "/tmp/it's"])(
    'rejects a bucket root the setup script cannot quote: %s',
    async (root) => {
      vi.stubEnv('ANYCLOUD_TEST_LOCAL_BUCKET_ROOT', root);
      vi.resetModules();
      await expect(
        import('../../../src/api/services/gateways/local-smolvm-contract.js'),
      ).rejects.toThrow('must be an absolute path of plain characters');
    },
  );

  it('pins the verified release, runner image, and bucket mount contract', () => {
    const script = buildLocalSmolvmRuntimeSetupScript();

    expect(LOCAL_SMOLVM_CONTRACT.supportedVersion).toBe('1.9.0');
    expect(LOCAL_SMOLVM_CONTRACT.bucketHostPath).toBe(
      '/var/lib/anycloud-test/local/buckets',
    );
    expect(LOCAL_SMOLVM_CONTRACT.runnerVersion).toBe(
      'anycloud-local-runner-cow-v2',
    );
    expect(LOCAL_SMOLVM_CONTRACT.runnerSidecarPath).toBe(
      '/var/lib/anycloud-test/local/runner-cow-v1.smolmachine',
    );
    expect(script).toContain(
      "SMOLVM_DATA_DIR='/var/lib/anycloud-test/local/runtime'",
    );
    expect(script).toContain('export SMOLVM_DATA_DIR');
    expect(script).toContain('chmod 0777 "$BUCKET_ROOT"');
    expect(script).toMatch(/RUNNER_BUILD_FINGERPRINT='[0-9a-f]{64}'/);
    expect(script).toContain(
      '"$RUNNER_CACHE_KEY_FILE" 2>/dev/null || true)" = "$RUNNER_BUILD_FINGERPRINT"',
    );
    expect(script).toContain(
      'ef706143545b08801f31d447b1a45edaaad08c2733199bb8c10ef6dc2a50e40a',
    );
    expect(script).toContain(
      '04b67ec1905aa02fc0d0028f119d29c501502d73a9db6714436456c4fc0e4db7',
    );
  });

  it('runs smolvm as the invoking user after bounded host preparation', () => {
    const script = buildLocalSmolvmRuntimeSetupScript();
    const launcher = readFileSync(
      'scripts/ci/setup-local-smolvm-runtime.ts',
      'utf8',
    );

    expect(script).toContain('RUN_UID=$(id -u)');
    expect(script).toContain('RUN_GID=$(id -g)');
    expect(script).toContain('sudo install -d -m 0755');
    expect(script).toContain('User=$RUN_USER');
    expect(script).toContain('Group=$RUN_GROUP');
    expect(script).toContain('Environment=SMOLVM_DATA_DIR=$SMOLVM_DATA_DIR');
    expect(script).toContain('pgrep -u "$RUN_UID"');
    expect(script).not.toMatch(/sudo[^\n]*"\$SMOLVM"/);
    expect(launcher).toContain("spawnSync('/bin/sh', [scriptPath]");
    expect(launcher).not.toContain(
      "const command = isRoot ? '/bin/sh' : 'sudo'",
    );
  });

  it('invalidates the runner cache for every artifact-producing input', () => {
    const input = {
      smolvmVersion: '1.9.0',
      runnerVersion: 'runner-v2',
      cpus: 2,
      memoryMb: 1024,
      overlayGb: 4,
      storageGb: 4,
      imageScript: 'docker=27.5.1\nrclone=1.68.2',
    };
    const fingerprint = localSmolvmRunnerBuildFingerprint(input);

    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(localSmolvmRunnerBuildFingerprint({ ...input })).toBe(fingerprint);

    for (const changedInput of [
      { ...input, smolvmVersion: '1.9.1' },
      { ...input, runnerVersion: 'runner-v3' },
      { ...input, cpus: 3 },
      { ...input, memoryMb: 2048 },
      { ...input, overlayGb: 8 },
      { ...input, storageGb: 8 },
      { ...input, imageScript: 'docker=27.5.2\nrclone=1.68.2' },
      { ...input, imageScript: `${input.imageScript}\nnew-bootstrap-step` },
    ]) {
      expect(localSmolvmRunnerBuildFingerprint(changedInput)).not.toBe(
        fingerprint,
      );
    }
  });

  it('installs the pinned Docker and rclone archives in the image', () => {
    const script = buildLocalSmolvmRunnerImageScript();

    expect(script).toContain(
      'https://download.docker.com/linux/static/stable/x86_64/docker-27.5.1.tgz',
    );
    expect(script).toContain(
      'https://downloads.rclone.org/v1.68.2/rclone-v1.68.2-linux-amd64.zip',
    );
    for (const checksum of [
      '4f798b3ee1e0140eab5bf30b0edc4e84f4cdb53255a429dc3bbae9524845d640',
      'e6b53725a73763ab3f988c73f8772eaed429754c1a579db5ff11f21990fd1817',
      '0e6fa18051e67fc600d803a2dcb10ddedb092247fc6eee61be97f64ec080a13c',
      'c6e9d4cf9c88b279f6ad80cd5675daebc068e404890fa7e191412c1bc7a4ac5f',
    ]) {
      expect(script).toContain(checksum);
    }
    expect(script).toContain(
      'echo "$DOCKER_SHA256  docker.tgz" | sha256sum -c -',
    );
    expect(script).toContain(
      'echo "$RCLONE_SHA256  rclone.zip" | sha256sum -c -',
    );
    expect(script).toContain('install -m 0755 docker/* /usr/bin/');
    expect(script).toContain(
      'install -m 0755 "$RCLONE_DIR/rclone" /usr/bin/rclone',
    );
  });

  it('prepares overlay2 state and the nuke workload cache', () => {
    const script = buildLocalSmolvmRunnerImageScript();

    expect(script).toContain(
      "cat > /etc/docker/daemon.json <<'DOCKER_DAEMON_CONFIG'",
    );
    expect(script).toContain('"data-root": "/storage/docker"');
    expect(script).toContain('"storage-driver": "overlay2"');
    expect(script).toContain('"registry-mirrors": ["https://mirror.gcr.io"]');
    expect(script).toContain('dockerd >/tmp/dockerd.log 2>&1 &');
    expect(script).toContain(
      "docker pull 'mirror.gcr.io/library/busybox:1.36@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662'",
    );
    expect(script).toContain(
      "docker tag 'mirror.gcr.io/library/busybox:1.36@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662' 'busybox:1.36'",
    );
    expect(script).toContain("docker image inspect 'busybox:1.36'");
  });

  it('packs and validates a stopped runner image without fork support', () => {
    const script = buildLocalSmolvmRuntimeSetupScript();

    expect(script).toContain('--storage 4');
    expect(script).toContain('machine stop --name "$BUILD_VM"');
    expect(script).toContain('pack create --from-vm "$BUILD_VM"');
    expect(script).toContain('sha256sum "$(basename "$RUNNER_SIDECAR")"');
    expect(script).toContain('chmod 0444 "$RUNNER_SIDECAR"');
    expect(script).not.toContain('SMOLVM_FORKABLE');
    expect(script).toContain('--from "$RUNNER_SIDECAR"');
    expect(script).toContain('test -s /etc/docker/daemon.json');
    expect(script).toContain('dockerd >/tmp/dockerd-validation.log 2>&1 &');
    expect(script.indexOf('dockerd >/tmp/dockerd-validation.log')).toBeLessThan(
      script.lastIndexOf('docker image inspect busybox:1.36 >/dev/null'),
    );
    expect(script).toContain(
      "docker info --format '{{.Driver}} {{.DockerRootDir}}' | grep -Fx 'overlay2 /storage/docker'",
    );
    expect(script).toContain('docker image inspect busybox:1.36 >/dev/null');
    expect(script).toContain(
      "cannot restore the prepared image's cluster and storage disks",
    );
  });

  it('scrubs machine identity and credentials before packing', () => {
    const script = buildLocalSmolvmRunnerImageScript();

    expect(script).toContain('rm -f /etc/ssh/ssh_host_* /etc/machine-id');
    expect(script).toContain(
      'rm -f /root/.ssh/authorized_keys /etc/anycloud-key',
    );
    expect(script).toContain('rm -rf /root/.config/rclone');
    expect(script).toContain('rm -f /var/run/docker.pid /var/run/docker.sock');
    expect(script).toContain("printf '%s\\n' 'anycloud-local-runner-cow-v2'");
  });

  it('keeps the API and forwarded guest ports bound to loopback', () => {
    const script = buildLocalSmolvmRuntimeSetupScript();

    expect(script).toContain(
      `Environment=SMOLVM_PUBLISH_ADDR=${LOCAL_SMOLVM_CONTRACT.host}`,
    );
    expect(script).toContain(
      `SMOLVM_PUBLISH_ADDR="${LOCAL_SMOLVM_CONTRACT.host}" nohup`,
    );
    expect(script).toContain(
      `serve start -l ${LOCAL_SMOLVM_CONTRACT.host}:$SMOLVM_PORT`,
    );
  });

  it('generates valid POSIX shell syntax', () => {
    for (const script of [
      buildLocalSmolvmRunnerImageScript(),
      buildLocalSmolvmRuntimeSetupScript(),
    ]) {
      const result = spawnSync('/bin/sh', ['-n'], {
        input: script,
        encoding: 'utf8',
      });

      expect(result.status, result.stderr).toBe(0);
    }
  });
});

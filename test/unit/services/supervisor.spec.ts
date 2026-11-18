import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CloudType } from '../../../src/shared/cloud.js';
import { ServiceState } from '../../../src/shared/runtime.js';

const { hasSystemdMock } = vi.hoisted(() => ({
  hasSystemdMock: vi.fn(),
}));

vi.mock('../../../src/api/services/vm-initializer', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../../src/api/services/vm-initializer')
    >();
  return {
    ...actual,
    hasSystemd: hasSystemdMock,
    installRcloneCommand: () => 'echo install-rclone',
  };
});

// Shrink the detached-download control-loop timing so the input test runs in
// milliseconds instead of the 15s poll cadence.
vi.mock('../../../src/api/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/api/config')>()),
  FINAL_SYNC_TIMEOUT_MS: 400,
  PULL_POLL_INTERVAL_MS: 5,
  PULL_CONTROL_TIMEOUT_MS: 1000,
}));

// Pass-through spy on the detached-run helper so we can assert the final-sync
// budget is wired through (the rclone copy still runs via the real impl).
vi.mock('../../../src/api/services/vm-exec', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/api/services/vm-exec')>();
  return { ...actual, runDetachedOnVm: vi.fn(actual.runDetachedOnVm) };
});

import { SupervisorManager } from '../../../src/api/services/supervisor';
import { runDetachedOnVm } from '../../../src/api/services/vm-exec';
import { FINAL_SYNC_TIMEOUT_MS } from '../../../src/api/config';
import { bucketHostPathsForRoot } from '../../../src/shared/providers';

function createSupervisor() {
  const exec = vi.fn(async (cmd: string) => {
    if (cmd.includes('is-active') && /ac-(?:input|final|recovery)-/.test(cmd)) {
      return { stdout: 'DONE 0\n', stderr: '' };
    }
    if (cmd.includes('systemctl is-active')) {
      return { stdout: 'active\n', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  });
  const ssh = { exec };

  return {
    exec,
    supervisor: new SupervisorManager(
      ssh as unknown as ConstructorParameters<typeof SupervisorManager>[0],
    ),
  };
}

describe('SupervisorManager rclone status logs', () => {
  beforeEach(() => {
    hasSystemdMock.mockResolvedValue(true);
  });

  it('redacts verbose running-service logs before returning status', async () => {
    const { exec, supervisor } = createSupervisor();
    exec.mockImplementation(async (cmd: string) => {
      if (cmd.includes('systemctl is-active')) {
        return { stdout: 'active\n', stderr: '' };
      }
      if (cmd.includes('journalctl -u rclone-output')) {
        return {
          stdout: [
            'ERROR : upload failed',
            'AWS_SESSION_TOKEN=session-token-value',
            'https://bucket.s3.amazonaws.com/file?X-Amz-Credential=ASIAIOSFODNN7EXAMPLE%2F20260626%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Security-Token=security-token&X-Amz-Signature=abcdef1234567890',
          ].join('\n'),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    });

    const status = await supervisor.getRcloneStatus(true);
    const logs = status.output?.logs ?? '';

    expect(status.output?.status).toBe(ServiceState.Running);
    expect(logs).toContain('ERROR : upload failed');
    expect(logs).toContain('AWS_SESSION_TOKEN=<REDACTED>');
    expect(logs).toContain('X-Amz-Credential=<REDACTED>');
    expect(logs).toContain('X-Amz-Security-Token=<REDACTED>');
    expect(logs).toContain('X-Amz-Signature=<REDACTED>');
    expect(logs).not.toContain('session-token-value');
    expect(logs).not.toContain('ASIAIOSFODNN7EXAMPLE');
    expect(logs).not.toContain('security-token');
    expect(logs).not.toContain('abcdef1234567890');
  });

  it('redacts stopped-service logs returned without verbose', async () => {
    const { exec, supervisor } = createSupervisor();
    exec.mockImplementation(async (cmd: string) => {
      if (cmd.includes('systemctl is-active rclone-output')) {
        return { stdout: 'inactive\n', stderr: '' };
      }
      if (cmd.includes('systemctl is-active')) {
        return { stdout: 'unknown\n', stderr: '' };
      }
      if (cmd.includes('journalctl -u rclone-output')) {
        return {
          stdout:
            'ERROR : failed to copy: X-Amz-Signature=abcdef1234567890&X-Amz-Credential=ASIAIOSFODNN7EXAMPLE',
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    });

    const status = await supervisor.getRcloneStatus(false);
    const logs = status.output?.logs ?? '';

    expect(status.output?.status).toBe(ServiceState.Stopped);
    expect(logs).toContain('X-Amz-Signature=<REDACTED>');
    expect(logs).toContain('X-Amz-Credential=<REDACTED>');
    expect(logs).not.toContain('abcdef1234567890');
    expect(logs).not.toContain('ASIAIOSFODNN7EXAMPLE');
  });
});

describe('SupervisorManager rclone service state parsing', () => {
  beforeEach(() => {
    hasSystemdMock.mockResolvedValue(true);
  });

  // `systemctl is-active` prints its state word AND exits nonzero for anything
  // but active, so the shell's `|| echo unknown` fallback appends a second
  // line. The idealized single-line mocks above never exercise that.
  it('maps a stopped service to Stopped despite the two-line is-active output', async () => {
    const { exec, supervisor } = createSupervisor();
    exec.mockImplementation(async (cmd: string) => {
      if (cmd.includes('systemctl is-active rclone-output')) {
        return { stdout: 'inactive\nunknown\n', stderr: '' };
      }
      if (cmd.includes('systemctl is-active rclone-checkpoint')) {
        return { stdout: 'missing\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    const status = await supervisor.getRcloneStatus(false);

    // Previously "inactive\nunknown" missed the state map, so a stopped
    // service read as Unknown and vanished from status entirely.
    expect(status.output?.status).toBe(ServiceState.Stopped);
    // A unit that was never installed (checkpoint on non-spot jobs) must stay
    // absent, not surface as stopped noise.
    expect(status.checkpoint).toBeUndefined();
  });

  it('maps a failed service to Fatal despite the two-line is-active output', async () => {
    const { exec, supervisor } = createSupervisor();
    exec.mockImplementation(async (cmd: string) => {
      if (cmd.includes('systemctl is-active rclone-output')) {
        return { stdout: 'failed\nunknown\n', stderr: '' };
      }
      if (cmd.includes('systemctl is-active rclone-checkpoint')) {
        return { stdout: 'missing\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    const status = await supervisor.getRcloneStatus(false);
    expect(status.output?.status).toBe(ServiceState.Fatal);
  });

  it('reads service logs from the log file first, journalctl only as fallback', async () => {
    const { exec, supervisor } = createSupervisor();
    exec.mockImplementation(async (cmd: string) => {
      if (cmd.includes('systemctl is-active')) {
        return { stdout: 'active\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    await supervisor.getRcloneStatus(true);

    // The unit writes rclone output to the file via StandardOutput=append:
    // (bypassing journald), so the journal holds only systemd lifecycle noise
    // — reading it first is what turned cgroup warnings into sync "errors".
    const logCommands = exec.mock.calls
      .map((call) => String(call[0]))
      .filter((cmd) => cmd.includes('/var/log/rclone-output.log'));
    expect(logCommands.length).toBeGreaterThan(0);
    expect(logCommands[0]).toMatch(
      /^tail -200 \/var\/log\/rclone-output\.log .*\|\| journalctl -u rclone-output/,
    );
  });
});

describe('SupervisorManager checkpoint setup', () => {
  beforeEach(() => {
    hasSystemdMock.mockResolvedValue(true);
  });

  it('hydrates checkpoint from remote authoritatively by default', async () => {
    const { exec, supervisor } = createSupervisor();

    await supervisor.initRclone(
      { checkpoint: { name: 'dep-1', cloudType: CloudType.Azure } },
      'dep-1',
      '10.0.0.1',
    );

    const commands = exec.mock.calls.map(([cmd]) => cmd as string);

    expect(commands).toContain(
      'systemctl stop rclone-output rclone-checkpoint docker-logs 2>/dev/null || true',
    );
    expect(
      commands.some((cmd) =>
        cmd.includes('rm -rf /mnt/checkpoint && mkdir -p /mnt/checkpoint'),
      ),
    ).toBe(true);
    expect(
      commands.some((cmd) =>
        cmd.includes('rclone sync azureblob:dep-1 /mnt/checkpoint'),
      ),
    ).toBe(true);
    expect(
      commands.some((cmd) =>
        cmd.includes('rclone copy azureblob:dep-1 /mnt/checkpoint'),
      ),
    ).toBe(false);
    expect(
      commands.some((cmd) =>
        cmd.includes('rclone copy /mnt/checkpoint azureblob:dep-1'),
      ),
    ).toBe(true);
    // Checkpoint buckets are always minted read-write, so the connectivity
    // probe still needs to exercise write access.
    expect(
      commands.some((cmd) =>
        cmd.includes('rclone touch azureblob:dep-1/.rclone-keep'),
      ),
    ).toBe(true);
  });

  it('preserves local checkpoint state for in-place VM restart', async () => {
    const { exec, supervisor } = createSupervisor();

    await supervisor.initRclone(
      { checkpoint: { name: 'dep-1', cloudType: CloudType.Azure } },
      'dep-1',
      '10.0.0.1',
      { preserveLocalBuckets: true },
    );

    const commands = exec.mock.calls.map(([cmd]) => cmd as string);

    expect(commands.some((cmd) => cmd.includes('rm -rf /mnt/checkpoint'))).toBe(
      false,
    );
    expect(commands).toContain('mkdir -p /mnt/checkpoint');
    expect(
      commands.some((cmd) =>
        cmd.includes('rclone sync azureblob:dep-1 /mnt/checkpoint'),
      ),
    ).toBe(false);
    expect(
      commands.some((cmd) =>
        cmd.includes('rclone copy azureblob:dep-1 /mnt/checkpoint'),
      ),
    ).toBe(false);
    expect(
      commands.some((cmd) =>
        cmd.includes('rclone copy /mnt/checkpoint azureblob:dep-1'),
      ),
    ).toBe(true);
  });

  it('leaves the checkpoint mount readable for ordinary workloads', async () => {
    const { exec, supervisor } = createSupervisor();

    await supervisor.initRclone(
      { checkpoint: { name: 'dep-1', cloudType: CloudType.Azure } },
      'dep-1',
      '10.0.0.1',
    );

    const commands = exec.mock.calls.map(([cmd]) => cmd as string);

    // A workload image may declare a non-root USER and still has to read its
    // own checkpoint.
    expect(commands.some((cmd) => cmd.includes('chmod 700'))).toBe(false);
  });

  it('uses the managed workload root for every VM-host bucket', async () => {
    const { exec, supervisor } = createSupervisor();
    const hostRoot = '/var/lib/anycloud/deployments/test-workload';
    const bucketHostPaths = bucketHostPathsForRoot(hostRoot);

    await supervisor.initRclone(
      {
        input: { name: 'input-bucket', cloudType: CloudType.AWS },
        output: { name: 'output-bucket', cloudType: CloudType.AWS },
        checkpoint: { name: 'test-workload', cloudType: CloudType.AWS },
      },
      'test-workload',
      '10.0.0.1',
      { bucketHostPaths },
    );

    const commands = exec.mock.calls.map(([cmd]) => cmd as string);

    expect(commands).toContain(
      `mkdir -p ${hostRoot} && test "$(stat -c %d ${hostRoot})" = "$(stat -c %d /)"`,
    );
    expect(
      commands.some((cmd) =>
        cmd.includes(`rclone sync s3:input-bucket ${hostRoot}/input`),
      ),
    ).toBe(true);
    expect(
      commands.some((cmd) =>
        cmd.includes(`rclone copy ${hostRoot}/output s3:output-bucket`),
      ),
    ).toBe(true);
    expect(
      commands.some((cmd) =>
        cmd.includes(`rclone sync s3:test-workload ${hostRoot}/checkpoint`),
      ),
    ).toBe(true);
    expect(
      commands.some((cmd) =>
        cmd.includes(`rclone copy ${hostRoot}/checkpoint s3:test-workload`),
      ),
    ).toBe(true);
  });

  it('flushes managed output and checkpoint data before resuming their upload services', async () => {
    const { exec, supervisor } = createSupervisor();
    const hostRoot = '/var/lib/anycloud/deployments/test-workload';
    const bucketHostPaths = bucketHostPathsForRoot(hostRoot);
    exec.mockImplementation(async (cmd: string) => {
      if (
        cmd.includes(`${hostRoot}/checkpoint`) &&
        cmd.includes('find') &&
        cmd.includes('echo 1')
      ) {
        return { stdout: '1\n', stderr: '' };
      }
      if (cmd.includes('is-active') && /ac-recovery-/.test(cmd)) {
        return { stdout: 'DONE 0\n', stderr: '' };
      }
      if (cmd.includes('systemctl is-active')) {
        return { stdout: 'active\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    await supervisor.initRclone(
      {
        output: { name: 'output-bucket', cloudType: CloudType.AWS },
        checkpoint: { name: 'test-workload', cloudType: CloudType.AWS },
      },
      'test-workload',
      '10.0.0.1',
      {
        bucketHostPaths,
        preserveLocalBuckets: true,
      },
    );

    const commands = exec.mock.calls.map(([cmd]) => cmd as string);

    expect(commands).toContain(`mkdir -p ${hostRoot}/output`);
    expect(commands).toContain(`mkdir -p ${hostRoot}/checkpoint`);
    expect(
      commands.some((cmd) => cmd.includes(`rm -rf ${hostRoot}/output`)),
    ).toBe(false);
    expect(
      commands.some((cmd) => cmd.includes(`rm -rf ${hostRoot}/checkpoint`)),
    ).toBe(false);
    expect(
      commands.some(
        (cmd) =>
          cmd.includes('ac-recovery-output-test-workload') &&
          cmd.includes(`rclone copy ${hostRoot}/output s3:output-bucket`),
      ),
    ).toBe(true);
    expect(
      commands.some(
        (cmd) =>
          cmd.includes('ac-recovery-checkpoint-test-workload') &&
          cmd.includes(`rclone copy ${hostRoot}/checkpoint s3:test-workload`),
      ),
    ).toBe(true);
    expect(
      commands.some((cmd) =>
        cmd.includes(`rclone sync s3:test-workload ${hostRoot}/checkpoint`),
      ),
    ).toBe(false);
  });

  it('reconciles remote when a managed same-VM checkpoint cache is not trusted', async () => {
    const { exec, supervisor } = createSupervisor();
    const checkpointPath =
      '/var/lib/anycloud/deployments/test-workload/checkpoint';
    exec.mockImplementation(async (cmd: string) => {
      if (
        cmd.includes(checkpointPath) &&
        cmd.includes('find') &&
        cmd.includes('echo 1')
      ) {
        return { stdout: '0\n', stderr: '' };
      }
      if (cmd.includes('systemctl is-active')) {
        return { stdout: 'active\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    await supervisor.initRclone(
      {
        checkpoint: {
          name: 'test-workload',
          cloudType: CloudType.Azure,
        },
      },
      'test-workload',
      '10.0.0.1',
      {
        bucketHostPaths: bucketHostPathsForRoot(
          '/var/lib/anycloud/deployments/test-workload',
        ),
        preserveLocalBuckets: true,
      },
    );

    const commands = exec.mock.calls.map(([cmd]) => cmd as string);

    expect(commands).toContain(`mkdir -p ${checkpointPath}`);
    expect(
      commands.some((cmd) => cmd.includes(`rm -rf ${checkpointPath}`)),
    ).toBe(false);
    expect(
      commands.some((cmd) =>
        cmd.includes(`rclone sync azureblob:test-workload ${checkpointPath}`),
      ),
    ).toBe(true);
    expect(
      commands.some((cmd) =>
        cmd.includes('ac-recovery-checkpoint-test-workload'),
      ),
    ).toBe(false);
  });
});

describe('SupervisorManager output bucket setup', () => {
  beforeEach(() => {
    hasSystemdMock.mockResolvedValue(true);
  });

  it('wipes stale local state and verifies write access before starting the upload service', async () => {
    const { exec, supervisor } = createSupervisor();

    await supervisor.initRclone(
      { output: { name: 'dep-1', cloudType: CloudType.AWS } },
      'dep-1',
      '10.0.0.1',
    );

    const commands = exec.mock.calls.map(([cmd]) => cmd as string);

    expect(
      commands.some((cmd) =>
        cmd.includes('rm -rf /mnt/output && mkdir -p /mnt/output'),
      ),
    ).toBe(true);
    // Output buckets are always minted read-write, so the connectivity probe
    // still needs to exercise write access.
    expect(
      commands.some((cmd) =>
        cmd.includes('rclone touch s3:dep-1/.rclone-keep'),
      ),
    ).toBe(true);
    expect(commands.some((cmd) => cmd.includes('rclone lsf'))).toBe(false);
  });

  it('fully detaches no-systemd background services from the SSH channel', async () => {
    hasSystemdMock.mockResolvedValue(false);
    const { exec, supervisor } = createSupervisor();
    exec.mockImplementation(async (cmd: string) => {
      if (cmd.includes('pgrep -f')) {
        return { stdout: 'active\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    await supervisor.initRclone(
      { output: { name: 'dep-1', cloudType: CloudType.AWS } },
      'dep-1',
      '10.0.0.1',
    );

    const launches = exec.mock.calls
      .map(([cmd]) => cmd as string)
      .filter((cmd) => cmd.startsWith('nohup '));

    // Both the continuous rclone uploader and docker-log follower must close
    // fd 0. Redirecting only their output still leaves the SSH exec channel
    // owned by the background child on minimal guests without systemd.
    expect(launches).toHaveLength(2);
    expect(launches.every((cmd) => cmd.includes(' </dev/null > '))).toBe(true);
  });
});

describe('SupervisorManager input bucket (detached download)', () => {
  beforeEach(() => {
    hasSystemdMock.mockResolvedValue(true);
  });

  it('runs the input download detached (systemd-run) and polls to completion', async () => {
    const { exec, supervisor } = createSupervisor();
    // The detached unit's poll resolves immediately to a successful sentinel.
    exec.mockImplementation(async (cmd: string) => {
      if (cmd.includes('ac-input') && cmd.includes('is-active')) {
        return { stdout: 'DONE 0\n', stderr: '' };
      }
      if (cmd.includes('is-active')) return { stdout: 'active\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });

    await supervisor.initRclone(
      { input: { name: 'dep-1', cloudType: CloudType.AWS } },
      'dep-1',
      '10.0.0.1',
    );

    const commands = exec.mock.calls.map(([cmd]) => cmd as string);
    // The download ran as a VM-side systemd transient unit, not a blocking ssh.exec…
    expect(
      commands.some(
        (c) => c.includes('systemd-run') && c.includes('ac-input-dep-1'),
      ),
    ).toBe(true);
    // …executing the rclone input sync into /mnt/input.
    expect(
      commands.some(
        (c) => c.includes('rclone sync') && c.includes('/mnt/input'),
      ),
    ).toBe(true);
    const detachedCall = vi.mocked(runDetachedOnVm).mock.calls.at(-1);
    expect(detachedCall?.[1]).toMatchObject({
      inactivityTimeoutMs: expect.any(Number),
      runIdentity: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(detachedCall?.[1]).not.toHaveProperty('totalTimeoutMs');
  });

  it('verifies input bucket connectivity with a read-only list, not a write touch', async () => {
    const { exec, supervisor } = createSupervisor();
    exec.mockImplementation(async (cmd: string) => {
      if (cmd.includes('ac-input') && cmd.includes('is-active')) {
        return { stdout: 'DONE 0\n', stderr: '' };
      }
      if (cmd.includes('is-active')) return { stdout: 'active\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });

    await supervisor.initRclone(
      { input: { name: 'dep-1', cloudType: CloudType.AWS } },
      'dep-1',
      '10.0.0.1',
    );

    // Input buckets can be minted with read-only session policies (no
    // s3:PutObject) — the connectivity probe must not require write access.
    const commands = exec.mock.calls.map(([cmd]) => cmd as string);
    expect(
      commands.some((c) => c.includes('rclone lsf s3:dep-1 --max-depth 1')),
    ).toBe(true);
    expect(commands.some((c) => c.includes('rclone touch'))).toBe(false);
  });

  it('does not kill an active input sync before no-systemd adoption', async () => {
    hasSystemdMock.mockResolvedValue(false);
    const { exec, supervisor } = createSupervisor();
    let probes = 0;
    exec.mockImplementation(async (cmd: string) => {
      if (cmd.includes('kill -0')) {
        // First probe is the adoption check: report the still-running worker
        // under the identity this call is about to ask for.
        if (probes++ === 0) {
          const identity = vi
            .mocked(runDetachedOnVm)
            .mock.calls.at(-1)?.[1].runIdentity;
          return { stdout: `active\n128\n${identity ?? ''}\n`, stderr: '' };
        }
        return { stdout: 'DONE 0\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    await supervisor.initRclone(
      { input: { name: 'dep-1', cloudType: CloudType.AWS } },
      'dep-1',
      '10.0.0.1',
    );

    const commands = exec.mock.calls.map(([cmd]) => cmd as string);
    expect(commands.some((cmd) => cmd.includes('pkill -x rclone'))).toBe(false);
    expect(
      commands.some((cmd) =>
        cmd.includes('pkill -f "[/]usr/bin/rclone copy "'),
      ),
    ).toBe(true);
    expect(commands.some((cmd) => cmd.includes('nohup sh -c'))).toBe(false);
  });
});

describe('SupervisorManager final bucket sync', () => {
  beforeEach(() => {
    hasSystemdMock.mockResolvedValue(true);
  });

  it('atomically replaces short-lived credentials before a final copy', async () => {
    const { exec, supervisor } = createSupervisor();

    await supervisor.refreshRcloneCredentials({
      checkpoint: {
        name: 'state-bucket',
        cloudType: CloudType.AWS,
        region: 'us-east-1',
        credentials: {
          cloudProvider: CloudType.AWS,
          accessKeyId: 'fresh-access-key',
          secretAccessKey: 'fresh-secret-key',
          sessionToken: 'fresh-session-token',
        },
      },
    });

    const command = exec.mock.calls[0]?.[0] as string;
    expect(command).toContain('set -e');
    expect(command).toContain('umask 077');
    expect(command).toContain(
      'tmp=$(mktemp /etc/rclone-env-checkpoint.XXXXXX)',
    );
    expect(command).toContain("export AWS_SESSION_TOKEN='fresh-session-token'");
    expect(command).toContain('mv "$tmp" /etc/rclone-env-checkpoint');
  });

  it('0047/S11 writes a GCP token to the bucket rclone config, input included', async () => {
    const { exec, supervisor } = createSupervisor();

    await supervisor.refreshRcloneCredentials({
      input: {
        name: 'training-data',
        cloudType: CloudType.GCP,
        credentials: { cloudProvider: CloudType.GCP, accessToken: 'fresh' },
        credentialExpiresAt: Date.UTC(2026, 9, 9, 12),
      },
    });

    const commands = exec.mock.calls.map(([cmd]) => cmd as string).join('\n');
    expect(commands).toContain('umask 077');
    expect(commands).toContain('"access_token":"fresh"');
    expect(commands).toContain('mv "$tmp" /etc/rclone-input.conf');
    expect(commands).toContain("export RCLONE_CONFIG='/etc/rclone-input.conf'");
    expect(commands).toContain('tmp=$(mktemp /etc/rclone-input.conf.XXXXXX)');
    // A fixed temp name would let two renewers clobber each other's write.
    expect(commands).not.toContain('.tmp');
    expect(commands).not.toContain('RCLONE_CONFIG_GCS_TOKEN');
  });

  it('reloads a renewed token on the next pass of an already running upload loop', async () => {
    const { exec, supervisor } = createSupervisor();
    await supervisor.initRclone(
      { checkpoint: { name: 'state-bucket', cloudType: CloudType.AWS } },
      'service-1',
      '192.0.2.1',
      { preserveLocalBuckets: true },
    );
    const unit = exec.mock.calls
      .map(([cmd]) => cmd as string)
      .find(
        (cmd) =>
          cmd.includes('ExecStart=') &&
          cmd.includes('Description=rclone-checkpoint'),
      );
    const loop = unit?.match(/ExecStart=\/bin\/bash -c '(.*)'/)?.[1];
    if (!loop) throw new Error('Missing checkpoint upload service');
    const directory = mkdtempSync(join(tmpdir(), 'anycloud-renew-'));
    const file = join(directory, 'credentials');
    try {
      writeFileSync(file, 'export AWS_SESSION_TOKEN=first\n', { mode: 0o600 });
      const command = loop
        .replaceAll('/etc/rclone-env-checkpoint', '"$CREDENTIAL_FILE"')
        .replace('/usr/bin/rclone', 'rclone');
      const output = execFileSync(
        '/bin/bash',
        [
          '-c',
          `
        rclone() { printf '%s\\n' "$AWS_SESSION_TOKEN"; }
        count=0
        sleep() {
          count=$((count + 1))
          if [ "$count" = 2 ]; then exit; fi
          printf 'export AWS_SESSION_TOKEN=second\\n' > "$CREDENTIAL_FILE.tmp"
          mv "$CREDENTIAL_FILE.tmp" "$CREDENTIAL_FILE"
        }
        ${command}
      `,
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, CREDENTIAL_FILE: file },
          timeout: 5_000,
        },
      );
      expect(output.trim().split('\n')).toEqual(['first', 'second']);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('runs the final output sync detached (systemd-run) and polls to completion', async () => {
    const { exec, supervisor } = createSupervisor();
    // The detached unit's poll resolves immediately to a successful sentinel.
    exec.mockImplementation(async (cmd: string) => {
      if (cmd.includes('ac-final-output') && cmd.includes('is-active')) {
        return { stdout: 'DONE 0\n', stderr: '' };
      }
      if (cmd.includes('is-active')) return { stdout: 'active\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });

    await supervisor.runFinalOutputSync(
      'results-bucket',
      CloudType.AWS,
      'dep-1',
      '10.0.0.1',
    );

    const commands = exec.mock.calls.map(([cmd]) => cmd as string);
    // Ran detached as a VM-side systemd transient unit — not a single held
    // ssh.exec that a NAT/idle teardown could kill mid-copy and lose artifacts.
    expect(
      commands.some(
        (c) => c.includes('systemd-run') && c.includes('ac-final-output-dep-1'),
      ),
    ).toBe(true);
    expect(
      commands.some((c) =>
        c.includes('rclone copy /mnt/output s3:results-bucket'),
      ),
    ).toBe(true);
    // The detached run is bounded by the final-sync budget, not a default.
    const lastCall = vi.mocked(runDetachedOnVm).mock.calls.at(-1);
    expect(lastCall?.[1]?.totalTimeoutMs).toBe(FINAL_SYNC_TIMEOUT_MS);
  });

  it('runs the final checkpoint sync detached (systemd-run) and polls to completion', async () => {
    const { exec, supervisor } = createSupervisor();
    exec.mockImplementation(async (cmd: string) => {
      if (cmd.includes('ac-final-checkpoint') && cmd.includes('is-active')) {
        return { stdout: 'DONE 0\n', stderr: '' };
      }
      if (cmd.includes('is-active')) return { stdout: 'active\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });

    await supervisor.runFinalCheckpointSync(
      'dep-1',
      CloudType.Azure,
      'dep-1',
      '10.0.0.1',
    );

    const commands = exec.mock.calls.map(([cmd]) => cmd as string);
    expect(
      commands.some(
        (c) =>
          c.includes('systemd-run') && c.includes('ac-final-checkpoint-dep-1'),
      ),
    ).toBe(true);
    expect(
      commands.some((c) =>
        c.includes('rclone copy /mnt/checkpoint azureblob:dep-1'),
      ),
    ).toBe(true);
  });
});

describe('SupervisorManager docker-logs follower', () => {
  beforeEach(() => {
    hasSystemdMock.mockResolvedValue(true);
  });

  it('installs a docker-logs unit alongside rclone-output that dumps container logs into the synced dir', async () => {
    const { exec, supervisor } = createSupervisor();

    await supervisor.initRclone(
      { output: { name: 'results-bucket', cloudType: CloudType.AWS } },
      'dep-1',
      '10.0.0.1',
    );

    const unitWrite = exec.mock.calls
      .map(([cmd]) => cmd as string)
      .find(
        (c) =>
          c.includes('/etc/systemd/system/docker-logs.service') &&
          c.includes('docker logs'),
      );
    expect(unitWrite).toBeDefined();
    // Continuous loop (survives preemption), mkdir every attempt, bounded dump,
    // and a per-VM filename so a recovery on a fresh VM can't overwrite the old
    // log.
    expect(unitWrite).toContain('while true');
    expect(unitWrite).toContain('mkdir -p /mnt/output/.anycloud/logs');
    expect(unitWrite).toContain('docker logs --tail 50000 dep-1');
    expect(unitWrite).toContain(
      '/mnt/output/.anycloud/logs/dep-1-10.0.0.1.log',
    );
  });

  it('uses the shared storage cadence for Local without changing docker log dumps', async () => {
    const { exec, supervisor } = createSupervisor();

    await supervisor.initRclone(
      { output: { name: 'results-bucket', cloudType: CloudType.Local } },
      'dep-1',
      '10.0.0.1',
    );

    const commands = exec.mock.calls.map(([cmd]) => cmd as string);
    const outputUnit = commands.find((command) =>
      command.includes('/etc/systemd/system/rclone-output.service'),
    );
    const dockerLogsUnit = commands.find((command) =>
      command.includes('/etc/systemd/system/docker-logs.service'),
    );
    expect(outputUnit).toContain('sleep 60');
    expect(dockerLogsUnit).toContain('sleep 30');
  });

  it('dumps to a same-directory .partial then atomically renames, and excludes .partial from the output copy', async () => {
    const { exec, supervisor } = createSupervisor();

    await supervisor.initRclone(
      { output: { name: 'results-bucket', cloudType: CloudType.AWS } },
      'dep-1',
      '10.0.0.1',
    );

    const commands = exec.mock.calls.map(([cmd]) => cmd as string);

    // The .partial temp is a sibling of the final log (same dir => same
    // filesystem => `mv` is an atomic rename, never a torn cross-device copy).
    const dockerUnit = commands.find((c) =>
      c.includes('/etc/systemd/system/docker-logs.service'),
    );
    expect(dockerUnit).toContain(
      '> /mnt/output/.anycloud/logs/dep-1-10.0.0.1.log.partial 2>&1 && mv /mnt/output/.anycloud/logs/dep-1-10.0.0.1.log.partial /mnt/output/.anycloud/logs/dep-1-10.0.0.1.log',
    );

    // The output rclone unit excludes the in-flight .partial temp so rclone
    // never ships a half-written log.
    const outputUnit = commands.find(
      (c) =>
        c.includes('/etc/systemd/system/rclone-output.service') &&
        c.includes('rclone copy'),
    );
    expect(outputUnit).toContain('--exclude ".anycloud/logs/*.partial"');
  });

  it('stops docker-logs on reinit and restarts it so a rewritten unit takes effect', async () => {
    const { exec, supervisor } = createSupervisor();

    await supervisor.initRclone(
      { output: { name: 'results-bucket', cloudType: CloudType.AWS } },
      'dep-1',
      '10.0.0.1',
    );

    const commands = exec.mock.calls.map(([cmd]) => cmd as string);
    // Pre-stop clears any stale unit from the previous boot...
    expect(
      commands.some((c) =>
        c.includes(
          'systemctl stop rclone-output rclone-checkpoint docker-logs',
        ),
      ),
    ).toBe(true);
    // ...and install uses `restart` (not `start`) so the new unit definition
    // takes effect even if one was already active.
    expect(
      commands.some((c) => c.includes('systemctl restart docker-logs')),
    ).toBe(true);
  });

  it('final output sync dumps the container logs before the rclone copy', async () => {
    const { exec, supervisor } = createSupervisor();
    exec.mockImplementation(async (cmd: string) => {
      if (cmd.includes('ac-final-output') && cmd.includes('is-active')) {
        return { stdout: 'DONE 0\n', stderr: '' };
      }
      if (cmd.includes('is-active')) return { stdout: 'active\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });

    await supervisor.runFinalOutputSync(
      'results-bucket',
      CloudType.AWS,
      'dep-1',
      '10.0.0.1',
    );

    const commands = exec.mock.calls.map(([cmd]) => cmd as string);
    const dumpIdx = commands.findIndex((c) =>
      c.includes('docker logs --tail 50000 dep-1'),
    );
    const copyIdx = commands.findIndex((c) =>
      c.includes('rclone copy /mnt/output s3:results-bucket'),
    );
    expect(dumpIdx).toBeGreaterThanOrEqual(0);
    expect(copyIdx).toBeGreaterThanOrEqual(0);
    // The final flush must materialize the complete log before rclone ships it.
    expect(dumpIdx).toBeLessThan(copyIdx);
  });
});

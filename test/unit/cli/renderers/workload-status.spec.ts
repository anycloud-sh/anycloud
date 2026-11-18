import { stripVTControlCharacters } from 'node:util';
import { describe, it, expect, vi } from 'vitest';
import {
  formatEvents,
  formatLogs,
  formatServiceLogs,
  buildStatusLines,
} from '../../../../src/cli/renderers/workload-status.js';
import {
  formatQuotaHint,
  formatRetryHint,
} from '../../../../src/cli/renderers/workload-retry.js';
import { workloadStatusView } from '../../../../src/cli/use-cases/workload-status.js';
import { printWorkloadHeader } from '../../../../src/cli/utils/output.js';
import {
  type WorkloadEvent,
  type StoredWorkload,
} from '../../../../src/api/services/workload-record.js';
import {
  CloudFailureDiagnosis,
  CloudType,
} from '../../../../src/shared/cloud.js';
import {
  WorkloadState,
  WorkloadType,
} from '../../../../src/shared/workload.js';
import { type ImagePullTelemetry } from '../../../../src/shared/image.js';
import {
  ContainerState,
  WorkloadHealthStatus,
} from '../../../../src/shared/runtime.js';
import { errorForDiagnosticMetadata } from '../../../../src/shared/log-diagnostics.js';
import {
  makeStoredWorkload,
  makeWorkloadEvent,
  makeStatusWorkloadMetadata,
} from '../../helpers/fixtures.js';
import {
  type GpuHealth,
  type StatusWorkloadMetadata,
} from '../../../../src/shared/api-contract/workload-management-schemas.js';

const statusLines = (
  response: Parameters<typeof workloadStatusView>[0],
  options: { verbose?: boolean } = {},
): string[] => buildStatusLines(workloadStatusView(response, options), options);

const baseWorkload = (
  overrides: Partial<StatusWorkloadMetadata> = {},
): StatusWorkloadMetadata =>
  makeStatusWorkloadMetadata({
    state: WorkloadState.Retrying,
    cloudProvider: CloudType.AWS,
    vmType: 'g6e.48xlarge',
    spot: true,
    ...overrides,
  });

const retryingQuotaEvent: WorkloadEvent = makeWorkloadEvent({
  state: WorkloadState.Retrying,
  createdAt: new Date('2024-01-15T10:30:00Z').getTime(),
  metadata: { errorKind: 'quota-exhausted-region', error: 'limit exceeded' },
});

const pullEvents = (imagePull: ImagePullTelemetry): WorkloadEvent[] => [
  makeWorkloadEvent({
    state: WorkloadState.Downloading,
    createdAt: new Date('2024-01-15T10:30:00Z').getTime(),
    metadata: { imagePull },
  }),
];

describe('formatEvents', () => {
  it('should return "No events recorded" for empty array', () => {
    expect(formatEvents([], CloudType.AWS)).toBe('No events recorded');
  });

  it('should format basic event with timestamp and state', () => {
    const events: WorkloadEvent[] = [
      makeWorkloadEvent({
        state: WorkloadState.Provisioning,
        createdAt: new Date('2024-01-15T10:30:45Z').getTime(),
      }),
    ];
    expect(formatEvents(events, CloudType.AWS)).toBe('[10:30:45] provisioning');
  });

  it('should format multiple events', () => {
    const events: WorkloadEvent[] = [
      makeWorkloadEvent({
        state: WorkloadState.Provisioning,
        createdAt: new Date('2024-01-15T10:30:00Z').getTime(),
      }),
      makeWorkloadEvent({
        state: WorkloadState.Starting,
        createdAt: new Date('2024-01-15T10:31:00Z').getTime(),
      }),
      makeWorkloadEvent({
        state: WorkloadState.Running,
        createdAt: new Date('2024-01-15T10:32:00Z').getTime(),
      }),
    ];
    const result = formatEvents(events, CloudType.AWS);
    expect(result).toContain('[10:30:00] provisioning');
    expect(result).toContain('[10:31:00] starting');
    expect(result).toContain('[10:32:00] running');
  });

  it('shows compact pull telemetry in normal status', () => {
    const events = pullEvents({
      schemaVersion: 1,
      method: 'containerd-transfer',
      outcome: 'succeeded',
      elapsedMs: 128_000,
      containerdVersion: '2.2.1',
      snapshotter: 'overlayfs',
    });

    expect(formatEvents(events, CloudType.AWS)).toBe(
      '[10:30:00] downloading [pull: containerd transfer, 2m]',
    );
  });

  it('shows fallback details only in verbose status', () => {
    const events = pullEvents({
      schemaVersion: 1,
      method: 'docker-fallback',
      outcome: 'succeeded',
      elapsedMs: 221_000,
      reason: 'registry_throttled',
      containerdVersion: '2.2.1',
      snapshotter: 'overlayfs',
    });

    expect(formatEvents(events, CloudType.AWS)).toBe(
      '[10:30:00] downloading [pull: Docker fallback, 3m]',
    );
    const verbose = formatLogs(events, CloudType.AWS, { verbose: true });
    expect(verbose).toContain('transfer fallback: registry throttled');
    expect(verbose).toContain('containerd 2.2.1, snapshotter overlayfs');
  });

  it('shows bytes, time to last byte and unpack tail in verbose status', () => {
    const events = pullEvents({
      schemaVersion: 1,
      method: 'docker',
      outcome: 'succeeded',
      elapsedMs: 321_000,
      bytesFetched: 9_830_000_000,
      timeToLastByteMs: 144_000,
      unpackTailMs: 177_000,
    });

    expect(formatLogs(events, CloudType.Azure, { verbose: true })).toContain(
      'fetched 9.15 GB in 144s, then unpacked for 177s',
    );
  });

  it("shows a pool replica's kubelet pull, or that its Node had the image", () => {
    const pull = {
      schemaVersion: 1,
      method: 'kubelet',
      outcome: 'succeeded',
    } as const;

    expect(
      formatEvents(pullEvents({ ...pull, elapsedMs: 95_400 }), CloudType.AWS),
    ).toBe('[10:30:00] downloading [pull: kubelet, 1m]');
    expect(
      formatEvents(
        pullEvents({ ...pull, elapsedMs: 0, alreadyPresent: true }),
        CloudType.AWS,
      ),
    ).toBe('[10:30:00] downloading [pull: image already on Node]');
  });

  it('distinguishes an unavailable transfer runtime from a failed attempt', () => {
    const events = pullEvents({
      schemaVersion: 1,
      method: 'docker',
      outcome: 'succeeded',
      elapsedMs: 41_000,
      reason: 'transfer_plugin_unavailable',
    });

    expect(formatEvents(events, CloudType.AWS)).toBe(
      '[10:30:00] downloading [pull: Docker (transfer unavailable), 41s]',
    );
  });

  it('shows authentication failure telemetry in verbose status', () => {
    const events = pullEvents({
      schemaVersion: 1,
      method: 'docker',
      outcome: 'failed',
      elapsedMs: 1000,
      reason: 'registry_auth',
    });

    expect(formatEvents(events, CloudType.AWS)).toBe(
      '[10:30:00] downloading [pull: Docker failed, 1s]',
    );
    expect(formatLogs(events, CloudType.AWS, { verbose: true })).toContain(
      'pull failed: registry auth',
    );
  });

  it.each(['transport_error', 'auth_setup_failed'])(
    'renders %s as a pull failure rather than transfer unavailability',
    (reason) => {
      const events = pullEvents({
        schemaVersion: 1,
        method: 'docker',
        outcome: 'failed',
        elapsedMs: 1000,
        reason,
      });

      expect(formatEvents(events, CloudType.AWS)).toBe(
        '[10:30:00] downloading [pull: Docker failed, 1s]',
      );
      expect(formatLogs(events, CloudType.AWS, { verbose: true })).toContain(
        `pull failed: ${reason.replace(/_/g, ' ')}`,
      );
    },
  );

  it('should include message from metadata', () => {
    const events: WorkloadEvent[] = [
      makeWorkloadEvent({
        state: WorkloadState.Running,
        createdAt: new Date('2024-01-15T10:30:00Z').getTime(),
        metadata: { message: 'Container started successfully' },
      }),
    ];
    expect(formatEvents(events, CloudType.AWS)).toBe(
      '[10:30:00] running: Container started successfully',
    );
  });

  it('should include eligible regions from provisioning metadata', () => {
    const events: WorkloadEvent[] = [
      makeWorkloadEvent({
        state: WorkloadState.Provisioning,
        createdAt: new Date('2024-01-15T10:30:00Z').getTime(),
        metadata: {
          region: 'us-east-1',
          eligibleRegions: ['us-east-1', 'us-west-2'],
        },
      }),
    ];

    expect(formatEvents(events, CloudType.AWS)).toBe(
      '[10:30:00] provisioning (us-east-1): eligible regions: us-east-1, us-west-2',
    );
  });

  it('should call out a single eligible region from provisioning metadata', () => {
    const events: WorkloadEvent[] = [
      makeWorkloadEvent({
        state: WorkloadState.Provisioning,
        createdAt: new Date('2024-01-15T10:30:00Z').getTime(),
        metadata: {
          region: 'us-east-1',
          eligibleRegions: ['us-east-1'],
        },
      }),
    ];

    expect(formatEvents(events, CloudType.AWS)).toBe(
      '[10:30:00] provisioning (us-east-1): only eligible region: us-east-1',
    );
  });

  it('should display error from metadata for failed state', () => {
    const events: WorkloadEvent[] = [
      makeWorkloadEvent({
        state: WorkloadState.Failed,
        createdAt: new Date('2024-01-15T10:30:00Z').getTime(),
        metadata: { error: 'VM provisioning timed out' },
      }),
    ];
    expect(formatEvents(events, CloudType.AWS)).toBe(
      '[10:30:00] failed: VM provisioning timed out',
    );
  });

  it('should display error from metadata for errored state', () => {
    const events: WorkloadEvent[] = [
      makeWorkloadEvent({
        state: WorkloadState.Errored,
        createdAt: new Date('2024-01-15T10:30:00Z').getTime(),
        metadata: { error: 'Container failed to start' },
      }),
    ];
    expect(formatEvents(events, CloudType.AWS)).toBe(
      '[10:30:00] errored: Container failed to start',
    );
  });

  it('should handle error object with message property', () => {
    const events: WorkloadEvent[] = [
      makeWorkloadEvent({
        state: WorkloadState.Failed,
        createdAt: new Date('2024-01-15T10:30:00Z').getTime(),
        metadata: { error: { message: 'Connection refused' } },
      }),
    ];
    expect(formatEvents(events, CloudType.AWS)).toBe(
      '[10:30:00] failed: Connection refused',
    );
  });

  it('should JSON stringify complex error objects', () => {
    const events: WorkloadEvent[] = [
      makeWorkloadEvent({
        state: WorkloadState.Failed,
        createdAt: new Date('2024-01-15T10:30:00Z').getTime(),
        metadata: { error: { code: 'TIMEOUT', details: 'SSH failed' } },
      }),
    ];
    const result = formatEvents(events, CloudType.AWS);
    expect(result).toContain('[10:30:00] failed:');
    expect(result).toContain('TIMEOUT');
    expect(result).toContain('SSH failed');
  });

  it('should show error for any state that has error metadata', () => {
    const events: WorkloadEvent[] = [
      makeWorkloadEvent({
        state: WorkloadState.Running,
        createdAt: new Date('2024-01-15T10:30:00Z').getTime(),
        metadata: { error: 'Unexpected error during run' },
      }),
    ];
    expect(formatEvents(events, CloudType.AWS)).toBe(
      '[10:30:00] running: Unexpected error during run',
    );
  });

  it('should show reason for recovering state (preemption)', () => {
    const events: WorkloadEvent[] = [
      makeWorkloadEvent({
        state: WorkloadState.Recovering,
        createdAt: new Date('2024-01-15T10:30:00Z').getTime(),
        metadata: { reason: 'preemption during downloading' },
      }),
    ];
    expect(formatEvents(events, CloudType.AWS)).toBe(
      '[10:30:00] recovering: preemption during downloading',
    );
  });

  it('should show reason for retrying state', () => {
    const events: WorkloadEvent[] = [
      makeWorkloadEvent({
        state: WorkloadState.Retrying,
        createdAt: new Date('2024-01-15T10:30:00Z').getTime(),
        metadata: { reason: 'container restart after VM recovery failed' },
      }),
    ];
    expect(formatEvents(events, CloudType.AWS)).toBe(
      '[10:30:00] retrying: container restart after VM recovery failed',
    );
  });

  it('should show reason for failed state (retry exhausted)', () => {
    const events: WorkloadEvent[] = [
      makeWorkloadEvent({
        state: WorkloadState.Failed,
        createdAt: new Date('2024-01-15T10:30:00Z').getTime(),
        metadata: { reason: 'retry attempts exhausted' },
      }),
    ];
    expect(formatEvents(events, CloudType.AWS)).toBe(
      '[10:30:00] failed: retry attempts exhausted',
    );
  });

  it('should show error for retrying state (image pull failure)', () => {
    const events: WorkloadEvent[] = [
      makeWorkloadEvent({
        state: WorkloadState.Retrying,
        createdAt: new Date('2024-01-15T10:30:00Z').getTime(),
        metadata: {
          error: { message: 'Failed to pull image on 1.2.3.4: exit code 1' },
        },
      }),
    ];
    expect(formatEvents(events, CloudType.AWS)).toContain(
      '[10:30:00] retrying: Failed to pull image on 1.2.3.4: exit code 1',
    );
  });

  it('formats retry errors generically when the cloud provider is unknown', () => {
    const events: WorkloadEvent[] = [
      makeWorkloadEvent({
        state: WorkloadState.Retrying,
        createdAt: new Date('2024-01-15T10:30:00Z').getTime(),
        metadata: {
          error: { message: 'Provisioning failed before cloud selection' },
        },
      }),
    ];

    expect(formatEvents(events, null)).toContain(
      '[10:30:00] retrying: Provisioning failed before cloud selection',
    );
  });

  it('should show Docker daemon output from structured pull errors', () => {
    const events: WorkloadEvent[] = [
      makeWorkloadEvent({
        state: WorkloadState.Retrying,
        createdAt: new Date('2024-01-15T10:30:00Z').getTime(),
        metadata: {
          error: {
            message:
              "Failed to pull image 'ghcr.io/org/image:latest' on 1.2.3.4: exited with code 1",
            name: 'PullError',
            pullStdout:
              'Error response from daemon: manifest unknown: manifest unknown',
            pullStderr: '',
          },
        },
      }),
    ];

    expect(formatEvents(events, CloudType.AWS)).toBe(
      "[10:30:00] retrying: Failed to pull image 'ghcr.io/org/image:latest' on 1.2.3.4: exited with code 1\n\nDocker output:\nError response from daemon: manifest unknown: manifest unknown",
    );
  });

  it('should show detached command log tail from structured errors', () => {
    const events: WorkloadEvent[] = [
      makeWorkloadEvent({
        state: WorkloadState.Finalizing,
        createdAt: new Date('2024-01-15T10:30:00Z').getTime(),
        metadata: {
          error: {
            message: 'exited with code 1',
            name: 'DetachedRunError',
            logTail: 'rclone: Failed to copy: permission denied',
          },
        },
      }),
    ];

    expect(formatEvents(events, CloudType.AWS)).toBe(
      '[10:30:00] finalizing: exited with code 1\n\nCommand output:\nrclone: Failed to copy: permission denied',
    );
  });

  it('should show SSH stdout and stderr from structured errors', () => {
    const events: WorkloadEvent[] = [
      makeWorkloadEvent({
        state: WorkloadState.Syncing,
        createdAt: new Date('2024-01-15T10:30:00Z').getTime(),
        metadata: {
          error: {
            message: 'Command exited with code 7',
            name: 'SSHExecError',
            stderr: 'rclone: failed to list bucket',
            stdout: 'checking bucket',
          },
        },
      }),
    ];

    expect(formatEvents(events, CloudType.AWS)).toBe(
      '[10:30:00] syncing: Command exited with code 7\n\nCommand output:\nrclone: failed to list bucket\nchecking bucket',
    );
  });

  it('should show stall error for retrying state on GCP (exact redactValue output shape)', () => {
    // Simulates the exact metadata shape stored by redactValue when an Error object is passed:
    // redactValue({ error: new Error("...") }) → { error: { message: "...", name: "Error" } }
    const events: WorkloadEvent[] = [
      makeWorkloadEvent({
        state: WorkloadState.Retrying,
        createdAt: new Date('2024-01-15T10:30:00Z').getTime(),
        metadata: {
          error: {
            message:
              "Failed to pull image 'ghcr.io/org/image:latest' on 1.2.3.4: SSH command stalled (no output for 600000ms): docker pull ghcr.io",
            name: 'Error',
          },
        },
      }),
    ];
    expect(formatEvents(events, CloudType.GCP)).toContain(
      "[10:30:00] retrying: Failed to pull image 'ghcr.io/org/image:latest' on 1.2.3.4: SSH command stalled",
    );
  });

  it('uses message as the headline and keeps diagnostic error detail', () => {
    const events: WorkloadEvent[] = [
      makeWorkloadEvent({
        state: WorkloadState.Recovering,
        createdAt: new Date('2024-01-15T10:30:00Z').getTime(),
        metadata: { message: 'msg', reason: 'rsn', error: 'err' },
      }),
    ];
    expect(formatEvents(events, CloudType.AWS)).toBe(
      '[10:30:00] recovering: msg\nError:\nerr',
    );
  });

  it('should include diagnostic details when reason and error are both present', () => {
    const events: WorkloadEvent[] = [
      makeWorkloadEvent({
        state: WorkloadState.Finalizing,
        createdAt: new Date('2024-01-15T10:30:00Z').getTime(),
        metadata: {
          reason: 'final-bucket-sync-failed',
          error: {
            message: 'exited with code 1',
            logTail: 'rclone: failed to upload results.json',
          },
        },
      }),
    ];

    expect(formatEvents(events, CloudType.AWS)).toBe(
      '[10:30:00] finalizing: final-bucket-sync-failed\nError:\nexited with code 1\n\nCommand output:\nrclone: failed to upload results.json',
    );
  });

  it('renders complete large top-level finalization diagnostics', () => {
    const logs = `BEGIN ${'workload diagnostic 🚀; '.repeat(1024)} END`;
    const event = makeWorkloadEvent({
      state: WorkloadState.Finalizing,
      createdAt: new Date('2024-01-15T10:30:00Z').getTime(),
      metadata: {
        exitCode: 137,
        oomKilled: true,
        logs,
        targetState: WorkloadState.Errored,
        workloadExitCode: 137,
        attempt: 2,
        maxAttempts: 20,
        reason: 'final-bucket-sync-failed',
        error: { message: 'final output sync timed out' },
      },
    });

    const result = formatEvents([event], CloudType.AWS, { verbose: true });

    expect(Buffer.byteLength(logs)).toBeGreaterThan(16 * 1024);
    expect(result).toContain('[10:30:00] finalizing [exit: 137] [OOM]');
    expect(result).toContain('final-bucket-sync-failed');
    expect(result).toContain('final output sync timed out');
    expect(result).toContain(logs);
    expect(result.split(logs)).toHaveLength(2);
  });

  it('should render logs and error when both are present', () => {
    const events: WorkloadEvent[] = [
      makeWorkloadEvent({
        state: WorkloadState.Errored,
        createdAt: new Date('2024-01-15T10:30:00Z').getTime(),
        metadata: {
          logs: 'container booted\nError: application crashed',
          error: {
            message: 'container failed',
            stderr: 'stderr tail',
          },
        },
      }),
    ];

    expect(formatEvents(events, CloudType.AWS)).toBe(
      '[10:30:00] errored: container failed\n\nCommand output:\nstderr tail\n\nLogs:\ncontainer booted\nError: application crashed',
    );
  });

  it('removes an ignored systemd cleanup warning from persisted rclone diagnostics', () => {
    const warning =
      'Jul 10 23:26:13 vm-1 systemd[1]: rclone-output.service: Failed to kill control group /system.slice/rclone-output.service, ignoring: Invalid argument';
    const events: WorkloadEvent[] = [
      makeWorkloadEvent({
        state: WorkloadState.Errored,
        createdAt: new Date('2024-01-15T10:30:00Z').getTime(),
        metadata: {
          exitCode: 7,
          logs: `Fetching 17 files\nDownloaded\noutput-sync: running\n  ${warning}`,
        },
      }),
    ];

    const output = formatEvents(events, CloudType.AWS);
    expect(output).toContain(
      '[10:30:00] errored [exit: 7]: Fetching 17 files\nDownloaded',
    );
    expect(output).not.toContain('output-sync: running');
    expect(output).not.toContain('Failed to kill control group');
  });

  it('keeps genuine rclone errors beside an ignored systemd cleanup warning', () => {
    const warning =
      'Jul 10 23:26:13 vm-1 systemd[1]: rclone-output.service: Failed to kill control group /system.slice/rclone-output.service, ignoring: Invalid argument';
    const rcloneError =
      '2026/07/10 23:26:14 ERROR : results.json: Failed to copy: permission denied';
    const events: WorkloadEvent[] = [
      makeWorkloadEvent({
        state: WorkloadState.Errored,
        createdAt: new Date('2024-01-15T10:30:00Z').getTime(),
        metadata: {
          exitCode: 7,
          logs: `output-sync: running\n  ${warning}\n  ${rcloneError}`,
        },
      }),
    ];

    const output = formatEvents(events, CloudType.AWS);
    expect(output).toContain('output-sync: running');
    expect(output).toContain(rcloneError);
    expect(output).not.toContain('Failed to kill control group');
  });

  it('renders workload exit and final sync outcome separately on terminal events', () => {
    // The acceptance case: workload killed (exit 137) while the final output
    // sync succeeded on its first attempt — the sync result must not read as
    // part of the workload failure, and vice versa.
    const events: WorkloadEvent[] = [
      makeWorkloadEvent({
        state: WorkloadState.Errored,
        createdAt: new Date('2024-01-15T10:30:00Z').getTime(),
        metadata: {
          exitCode: 137,
          workloadExitCode: 137,
          finalSyncAttempts: 1,
        },
      }),
    ];

    expect(formatEvents(events, CloudType.AWS)).toBe(
      '[10:30:00] errored [exit: 137] [final sync: succeeded, attempt: 1]',
    );
  });

  it('should normalize ANSI and carriage-return progress output', () => {
    const events: WorkloadEvent[] = [
      makeWorkloadEvent({
        state: WorkloadState.Retrying,
        createdAt: new Date('2024-01-15T10:30:00Z').getTime(),
        metadata: {
          error: {
            message: 'pull failed',
            name: 'PullError',
            pullStdout: '\u001b[31mPulling layer\u001b[0m\rmanifest unknown',
          },
        },
      }),
    ];

    expect(formatEvents(events, CloudType.AWS)).toBe(
      '[10:30:00] retrying: pull failed\n\nDocker output:\nPulling layer\nmanifest unknown',
    );
  });

  it('renders metadata produced by the diagnostic mapper', () => {
    const mapped = errorForDiagnosticMetadata(
      Object.assign(new Error('pull failed'), {
        name: 'PullError',
        pullStderr: 'denied: requested access',
        pullStdout: '\u001b[31mmanifest unknown\u001b[0m',
        token: 'should-not-render',
      }),
    );
    const events: WorkloadEvent[] = [
      makeWorkloadEvent({
        state: WorkloadState.Retrying,
        createdAt: new Date('2024-01-15T10:30:00Z').getTime(),
        metadata: { error: mapped },
      }),
    ];

    const output = formatEvents(events, CloudType.AWS);
    expect(output).toBe(
      '[10:30:00] retrying: pull failed\n\nDocker output:\ndenied: requested access\nmanifest unknown',
    );
    expect(output).not.toContain('should-not-render');
  });

  describe('container exit metadata (job completion and startup failure paths)', () => {
    it('should display exit code indicator', () => {
      const events: WorkloadEvent[] = [
        makeWorkloadEvent({
          state: WorkloadState.Errored,
          createdAt: new Date('2024-01-15T10:30:00Z').getTime(),
          metadata: { exitCode: 1 },
        }),
      ];
      expect(formatEvents(events, CloudType.AWS)).toBe(
        '[10:30:00] errored [exit: 1]',
      );
    });

    it('should display OOM indicator', () => {
      const events: WorkloadEvent[] = [
        makeWorkloadEvent({
          state: WorkloadState.Errored,
          createdAt: new Date('2024-01-15T10:30:00Z').getTime(),
          metadata: { oomKilled: true },
        }),
      ];
      expect(formatEvents(events, CloudType.AWS)).toBe(
        '[10:30:00] errored [OOM]',
      );
    });

    it('should display both exit code and OOM indicators', () => {
      const events: WorkloadEvent[] = [
        makeWorkloadEvent({
          state: WorkloadState.Errored,
          createdAt: new Date('2024-01-15T10:30:00Z').getTime(),
          metadata: { exitCode: 137, oomKilled: true },
        }),
      ];
      expect(formatEvents(events, CloudType.AWS)).toBe(
        '[10:30:00] errored [exit: 137] [OOM]',
      );
    });

    it('should display logs from logs field', () => {
      const events: WorkloadEvent[] = [
        makeWorkloadEvent({
          state: WorkloadState.Errored,
          createdAt: new Date('2024-01-15T10:30:00Z').getTime(),
          metadata: { logs: 'Segmentation fault' },
        }),
      ];
      expect(formatEvents(events, CloudType.AWS)).toBe(
        '[10:30:00] errored: Segmentation fault',
      );
    });

    it('should render logs and error fields together', () => {
      const events: WorkloadEvent[] = [
        makeWorkloadEvent({
          state: WorkloadState.Errored,
          createdAt: new Date('2024-01-15T10:30:00Z').getTime(),
          metadata: { logs: 'New logs format', error: 'Old error format' },
        }),
      ];
      expect(formatEvents(events, CloudType.AWS)).toBe(
        '[10:30:00] errored: Old error format\nLogs:\nNew logs format',
      );
    });

    it('should dedupe matching reason and error when exit code is present', () => {
      const events: WorkloadEvent[] = [
        makeWorkloadEvent({
          state: WorkloadState.Errored,
          createdAt: new Date('2024-01-15T10:30:00Z').getTime(),
          metadata: {
            exitCode: 1,
            reason: 'boom',
            error: { message: 'boom' },
          },
        }),
      ];
      expect(formatEvents(events, CloudType.AWS)).toBe(
        '[10:30:00] errored [exit: 1]: boom',
      );
    });

    it('should fall back to error field when logs not present', () => {
      const events: WorkloadEvent[] = [
        makeWorkloadEvent({
          state: WorkloadState.Errored,
          createdAt: new Date('2024-01-15T10:30:00Z').getTime(),
          metadata: { error: 'Legacy error message' },
        }),
      ];
      expect(formatEvents(events, CloudType.AWS)).toBe(
        '[10:30:00] errored: Legacy error message',
      );
    });

    it('should display full container exit with all metadata', () => {
      const events: WorkloadEvent[] = [
        makeWorkloadEvent({
          state: WorkloadState.Errored,
          createdAt: new Date('2024-01-15T10:30:00Z').getTime(),
          metadata: {
            exitCode: 137,
            oomKilled: true,
            logs: 'Process killed by OOM killer',
          },
        }),
      ];
      expect(formatEvents(events, CloudType.AWS)).toBe(
        '[10:30:00] errored [exit: 137] [OOM]: Process killed by OOM killer',
      );
    });

    it('should display exit code 0 for completed jobs', () => {
      const events: WorkloadEvent[] = [
        makeWorkloadEvent({
          state: WorkloadState.Completed,
          createdAt: new Date('2024-01-15T10:30:00Z').getTime(),
          metadata: { exitCode: 0, logs: 'Job finished successfully' },
        }),
      ];
      expect(formatEvents(events, CloudType.AWS)).toBe(
        '[10:30:00] completed [exit: 0]: Job finished successfully',
      );
    });

    it('should not show OOM indicator when oomKilled is false', () => {
      const events: WorkloadEvent[] = [
        makeWorkloadEvent({
          state: WorkloadState.Errored,
          createdAt: new Date('2024-01-15T10:30:00Z').getTime(),
          metadata: { exitCode: 1, oomKilled: false },
        }),
      ];
      expect(formatEvents(events, CloudType.AWS)).toBe(
        '[10:30:00] errored [exit: 1]',
      );
    });
  });

  describe('event deduplication', () => {
    it('should collapse consecutive duplicate events without metadata', () => {
      const events: WorkloadEvent[] = [
        makeWorkloadEvent({
          state: WorkloadState.Retrying,
          createdAt: new Date('2024-01-15T10:30:00Z').getTime(),
        }),
        makeWorkloadEvent({
          state: WorkloadState.Retrying,
          createdAt: new Date('2024-01-15T10:30:15Z').getTime(),
        }),
        makeWorkloadEvent({
          state: WorkloadState.Retrying,
          createdAt: new Date('2024-01-15T10:30:30Z').getTime(),
        }),
      ];
      expect(formatEvents(events, CloudType.AWS)).toBe(
        '[10:30:00] retrying (×3)',
      );
    });

    it('should collapse many consecutive duplicates', () => {
      const events: WorkloadEvent[] = Array.from({ length: 15 }, (_, i) =>
        makeWorkloadEvent({
          state: WorkloadState.Retrying,
          createdAt: new Date('2024-01-15T10:30:00Z').getTime() + i * 2000,
        }),
      );
      expect(formatEvents(events, CloudType.AWS)).toBe(
        '[10:30:00] retrying (×15)',
      );
    });

    it('should NOT collapse duplicates with metadata', () => {
      const events: WorkloadEvent[] = [
        makeWorkloadEvent({
          state: WorkloadState.Failed,
          createdAt: new Date('2024-01-15T10:30:00Z').getTime(),
          metadata: { error: 'Error 1' },
        }),
        makeWorkloadEvent({
          state: WorkloadState.Failed,
          createdAt: new Date('2024-01-15T10:30:15Z').getTime(),
          metadata: { error: 'Error 2' },
        }),
      ];
      const result = formatEvents(events, CloudType.AWS);
      expect(result).toContain('[10:30:00] failed: Error 1');
      expect(result).toContain('[10:30:15] failed: Error 2');
      expect(result).not.toContain('×');
    });

    it('should NOT collapse non-consecutive duplicates', () => {
      const events: WorkloadEvent[] = [
        makeWorkloadEvent({
          state: WorkloadState.Retrying,
          createdAt: new Date('2024-01-15T10:30:00Z').getTime(),
        }),
        makeWorkloadEvent({
          state: WorkloadState.Running,
          createdAt: new Date('2024-01-15T10:31:00Z').getTime(),
        }),
        makeWorkloadEvent({
          state: WorkloadState.Retrying,
          createdAt: new Date('2024-01-15T10:32:00Z').getTime(),
        }),
      ];
      const result = formatEvents(events, CloudType.AWS);
      expect(result).toBe(
        '[10:30:00] retrying\n[10:31:00] running\n[10:32:00] retrying',
      );
    });

    it('should handle mixed scenario with duplicates and unique events', () => {
      const events: WorkloadEvent[] = [
        makeWorkloadEvent({
          state: WorkloadState.Provisioning,
          createdAt: new Date('2024-01-15T10:30:00Z').getTime(),
        }),
        makeWorkloadEvent({
          state: WorkloadState.Running,
          createdAt: new Date('2024-01-15T10:31:00Z').getTime(),
        }),
        makeWorkloadEvent({
          state: WorkloadState.Retrying,
          createdAt: new Date('2024-01-15T10:32:00Z').getTime(),
        }),
        makeWorkloadEvent({
          state: WorkloadState.Retrying,
          createdAt: new Date('2024-01-15T10:32:15Z').getTime(),
        }),
        makeWorkloadEvent({
          state: WorkloadState.Running,
          createdAt: new Date('2024-01-15T10:33:00Z').getTime(),
        }),
        makeWorkloadEvent({
          state: WorkloadState.Recovering,
          createdAt: new Date('2024-01-15T10:34:00Z').getTime(),
        }),
        makeWorkloadEvent({
          state: WorkloadState.Recovering,
          createdAt: new Date('2024-01-15T10:34:02Z').getTime(),
        }),
        makeWorkloadEvent({
          state: WorkloadState.Recovering,
          createdAt: new Date('2024-01-15T10:34:04Z').getTime(),
        }),
        makeWorkloadEvent({
          state: WorkloadState.Terminated,
          createdAt: new Date('2024-01-15T10:35:00Z').getTime(),
        }),
      ];
      const result = formatEvents(events, CloudType.AWS);
      expect(result).toContain('[10:30:00] provisioning');
      expect(result).toContain('[10:31:00] running');
      expect(result).toContain('[10:32:00] retrying (×2)');
      expect(result).toContain('[10:33:00] running');
      expect(result).toContain('[10:34:00] recovering (×3)');
      expect(result).toContain('[10:35:00] terminated');
    });

    it('should stop collapsing when metadata appears', () => {
      const events: WorkloadEvent[] = [
        makeWorkloadEvent({
          state: WorkloadState.Retrying,
          createdAt: new Date('2024-01-15T10:30:00Z').getTime(),
        }),
        makeWorkloadEvent({
          state: WorkloadState.Retrying,
          createdAt: new Date('2024-01-15T10:30:15Z').getTime(),
        }),
        makeWorkloadEvent({
          state: WorkloadState.Retrying,
          createdAt: new Date('2024-01-15T10:30:30Z').getTime(),
          metadata: { message: 'preemption: VM restart failed' },
        }),
      ];
      const result = formatEvents(events, CloudType.AWS);
      expect(result).toContain('[10:30:00] retrying (×2)');
      expect(result).toContain(
        '[10:30:30] retrying: preemption: VM restart failed',
      );
    });

    it('should consider empty metadata as no metadata', () => {
      const events: WorkloadEvent[] = [
        makeWorkloadEvent({
          state: WorkloadState.Retrying,
          createdAt: new Date('2024-01-15T10:30:00Z').getTime(),
        }),
        makeWorkloadEvent({
          state: WorkloadState.Retrying,
          createdAt: new Date('2024-01-15T10:30:15Z').getTime(),
          metadata: {},
        }),
        makeWorkloadEvent({
          state: WorkloadState.Retrying,
          createdAt: new Date('2024-01-15T10:30:30Z').getTime(),
        }),
      ];
      expect(formatEvents(events, CloudType.AWS)).toBe(
        '[10:30:00] retrying (×3)',
      );
    });
  });
});

describe('formatLogs', () => {
  it('should pass through non-error lines unchanged', () => {
    const events: WorkloadEvent[] = [
      makeWorkloadEvent({
        state: WorkloadState.Provisioning,
        createdAt: new Date('2024-01-15T10:30:00Z').getTime(),
      }),
      makeWorkloadEvent({
        state: WorkloadState.Running,
        createdAt: new Date('2024-01-15T10:31:00Z').getTime(),
      }),
    ];
    const result = formatLogs(events, CloudType.AWS);
    expect(result).toBe('[10:30:00] provisioning\n[10:31:00] running');
  });

  it('should format failed state with box drawing', () => {
    const events: WorkloadEvent[] = [
      makeWorkloadEvent({
        state: WorkloadState.Failed,
        createdAt: new Date('2024-01-15T10:30:00Z').getTime(),
        metadata: { error: 'VM creation failed' },
      }),
    ];
    const result = formatLogs(events, CloudType.AWS);
    expect(result).toContain('[10:30:00] failed');
    expect(result).toContain('│');
    expect(result).toContain('VM creation failed');
  });

  it('should format errored state with box drawing', () => {
    const events: WorkloadEvent[] = [
      makeWorkloadEvent({
        state: WorkloadState.Errored,
        createdAt: new Date('2024-01-15T10:30:00Z').getTime(),
        metadata: { error: 'Container crashed' },
      }),
    ];
    const result = formatLogs(events, CloudType.AWS);
    expect(result).toContain('[10:30:00] errored');
    expect(result).toContain('│');
    expect(result).toContain('Container crashed');
  });

  it('should box-draw recovering state with reason', () => {
    const events: WorkloadEvent[] = [
      makeWorkloadEvent({
        state: WorkloadState.Recovering,
        createdAt: new Date('2024-01-15T10:30:00Z').getTime(),
        metadata: { reason: 'preemption during downloading' },
      }),
    ];
    const result = formatLogs(events, CloudType.AWS);
    expect(result).toContain('[10:30:00] recovering');
    expect(result).toContain('│');
    expect(result).toContain('preemption during downloading');
  });

  it('should box-draw all lines of multiline logs', () => {
    const events: WorkloadEvent[] = [
      makeWorkloadEvent({
        state: WorkloadState.Errored,
        createdAt: new Date('2024-01-15T10:30:00Z').getTime(),
        metadata: { logs: 'Error logs:\nline one\nline two' },
      }),
    ];
    const result = formatLogs(events, CloudType.AWS);
    const lines = result.split('\n');
    // All content lines should have the │ prefix
    expect(
      lines.some((l) => l.includes('│') && l.includes('Error logs:')),
    ).toBe(true);
    expect(lines.some((l) => l.includes('│') && l.includes('line one'))).toBe(
      true,
    );
    expect(lines.some((l) => l.includes('│') && l.includes('line two'))).toBe(
      true,
    );
  });

  it('should preserve (×N) count suffix on lines with no message', () => {
    const events: WorkloadEvent[] = [
      makeWorkloadEvent({
        state: WorkloadState.Provisioning,
        createdAt: new Date('2024-01-15T10:30:00Z').getTime(),
      }),
      makeWorkloadEvent({
        state: WorkloadState.Provisioning,
        createdAt: new Date('2024-01-15T10:30:05Z').getTime(),
      }),
    ];
    const result = formatLogs(events, CloudType.AWS);
    expect(result).toBe('[10:30:00] provisioning (×2)');
    expect(result).not.toContain('│');
  });

  it('should handle full workload lifecycle with error', () => {
    const events: WorkloadEvent[] = [
      makeWorkloadEvent({
        state: WorkloadState.Provisioning,
        createdAt: new Date('2024-01-15T10:30:00Z').getTime(),
      }),
      makeWorkloadEvent({
        state: WorkloadState.Starting,
        createdAt: new Date('2024-01-15T10:31:00Z').getTime(),
      }),
      makeWorkloadEvent({
        state: WorkloadState.Errored,
        createdAt: new Date('2024-01-15T10:32:00Z').getTime(),
        metadata: { error: 'Health check failed' },
      }),
    ];
    const result = formatLogs(events, CloudType.AWS);
    expect(result).toContain('[10:30:00] provisioning');
    expect(result).toContain('[10:31:00] starting');
    expect(result).toContain('[10:32:00] errored');
    expect(result).toContain('Health check failed');
  });

  describe('container exit formatting with box drawing', () => {
    it('should format exit code and OOM indicators in header', () => {
      const events: WorkloadEvent[] = [
        makeWorkloadEvent({
          state: WorkloadState.Errored,
          createdAt: new Date('2024-01-15T10:30:00Z').getTime(),
          metadata: { exitCode: 137, oomKilled: true, logs: 'OOM killed' },
        }),
      ];
      const result = formatLogs(events, CloudType.AWS);
      expect(result).toContain('[10:30:00] errored [exit: 137] [OOM]');
      expect(result).toContain('│');
      expect(result).toContain('OOM killed');
    });

    it('should format logs field with box drawing', () => {
      const events: WorkloadEvent[] = [
        makeWorkloadEvent({
          state: WorkloadState.Errored,
          createdAt: new Date('2024-01-15T10:30:00Z').getTime(),
          metadata: { logs: 'Container crashed\nStack trace here' },
        }),
      ];
      const result = formatLogs(events, CloudType.AWS);
      expect(result).toContain('[10:30:00] errored');
      expect(result).toContain('│');
    });

    it('should format startup failure with container logs', () => {
      const events: WorkloadEvent[] = [
        makeWorkloadEvent({
          state: WorkloadState.Provisioning,
          createdAt: new Date('2024-01-15T10:30:00Z').getTime(),
        }),
        makeWorkloadEvent({
          state: WorkloadState.Starting,
          createdAt: new Date('2024-01-15T10:31:00Z').getTime(),
        }),
        makeWorkloadEvent({
          state: WorkloadState.Errored,
          createdAt: new Date('2024-01-15T10:32:00Z').getTime(),
          metadata: {
            exitCode: 1,
            oomKilled: false,
            logs: 'Error: Missing required env var',
          },
        }),
      ];
      const result = formatLogs(events, CloudType.AWS);
      expect(result).toContain('[10:30:00] provisioning');
      expect(result).toContain('[10:31:00] starting');
      expect(result).toContain('[10:32:00] errored [exit: 1]');
      expect(result).toContain('Missing required env var');
    });

    it('should format job completion with exit code 0', () => {
      const events: WorkloadEvent[] = [
        makeWorkloadEvent({
          state: WorkloadState.Provisioning,
          createdAt: new Date('2024-01-15T10:30:00Z').getTime(),
        }),
        makeWorkloadEvent({
          state: WorkloadState.Starting,
          createdAt: new Date('2024-01-15T10:31:00Z').getTime(),
        }),
        makeWorkloadEvent({
          state: WorkloadState.Completed,
          createdAt: new Date('2024-01-15T10:32:00Z').getTime(),
          metadata: { exitCode: 0, logs: 'Job completed successfully' },
        }),
      ];
      const result = formatLogs(events, CloudType.AWS);
      expect(result).toContain('[10:30:00] provisioning');
      expect(result).toContain('[10:31:00] starting');
      expect(result).toContain('[10:32:00] completed [exit: 0]');
      expect(result).toContain('Job completed successfully');
    });
  });
});

describe('formatServiceLogs', () => {
  const eventAt = (
    time: string,
    state: WorkloadState,
    metadata: Record<string, unknown> | null = null,
  ): WorkloadEvent =>
    makeWorkloadEvent({
      state,
      metadata,
      createdAt: new Date(`2024-01-15T${time}Z`).getTime(),
    });

  const upgradedServiceEvents = (): WorkloadEvent[] => [
    eventAt('10:30:00', WorkloadState.Provisioning),
    eventAt('10:31:00', WorkloadState.Running),
    eventAt('10:32:00', WorkloadState.Recovering, {
      reason: 'serve-upgrade',
      previousImage: 'app:v1',
      image: 'app:v2',
    }),
    eventAt('10:33:00', WorkloadState.Provisioning),
    eventAt('10:34:00', WorkloadState.Running),
  ];

  it('splits an upgraded service into chronological image sections', () => {
    expect(
      formatServiceLogs(upgradedServiceEvents(), CloudType.AWS, {
        history: true,
      }),
    ).toBe(
      [
        'Initial workload · app:v1',
        '[10:30:00] provisioning',
        '[10:31:00] running',
        '',
        'Upgrade 1 · app:v1 → app:v2',
        '[10:32:00] recovering',
        '  │ serve-upgrade',
        '[10:33:00] provisioning',
        '[10:34:00] running',
      ].join('\n'),
    );
  });

  it('shows only the latest upgrade by default', () => {
    const events = [
      ...upgradedServiceEvents(),
      eventAt('10:35:00', WorkloadState.Recovering, {
        reason: 'serve-upgrade',
        previousImage: 'app:v2',
        image: 'app:v3',
      }),
      eventAt('10:36:00', WorkloadState.Running),
    ];

    const result = formatServiceLogs(events, CloudType.AWS);
    expect(result).toMatch(/^Upgrade 2 · app:v2 → app:v3\n/);
    expect(result).toContain('[10:35:00] recovering');
    expect(result).toContain('[10:36:00] running');
    expect(result).not.toContain('Initial workload');
    expect(result).not.toContain('Upgrade 1 ·');
    expect(result).toContain(
      '2 earlier workload versions hidden. Run with --history to show all.',
    );
  });

  it('labels multiple upgrades and falls back for malformed image metadata', () => {
    const events = [
      ...upgradedServiceEvents(),
      eventAt('10:35:00', WorkloadState.Recovering, {
        reason: 'serve-upgrade',
        previousImage: 'app:v2',
        image: 3,
      }),
      eventAt('10:36:00', WorkloadState.Failed, {
        error: 'Replacement failed',
        logs: 'line one\nline two',
      }),
    ];

    const result = formatServiceLogs(events, CloudType.AWS, { history: true });
    expect(result).toContain('Upgrade 1 · app:v1 → app:v2');
    expect(result).toContain('\n\nUpgrade 2\n[10:35:00] recovering');
    expect(result).not.toContain('Upgrade 2 ·');
    expect(result).toContain('  │ line one');
    expect(result).toContain('  │ line two');
    for (const time of [
      '10:30:00',
      '10:31:00',
      '10:32:00',
      '10:33:00',
      '10:34:00',
      '10:35:00',
      '10:36:00',
    ]) {
      expect(result.split(`[${time}]`)).toHaveLength(2);
    }
  });

  it('does not split ordinary recovery or a marker on another state', () => {
    const events = [
      eventAt('10:30:00', WorkloadState.Recovering, {
        reason: 'preemption during downloading',
      }),
      eventAt('10:31:00', WorkloadState.Recovering),
      eventAt('10:32:00', WorkloadState.Running, {
        reason: 'serve-upgrade',
        previousImage: 'app:v1',
        image: 'app:v2',
      }),
    ];

    expect(formatServiceLogs(events, CloudType.AWS)).toBe(
      formatLogs(events, CloudType.AWS),
    );
  });

  it('omits an empty initial section when history starts at an upgrade', () => {
    const events = [
      eventAt('10:30:00', WorkloadState.Recovering, {
        reason: 'serve-upgrade',
        previousImage: 'app:v1',
        image: 'app:v2',
      }),
      eventAt('10:31:00', WorkloadState.Provisioning),
    ];

    const result = formatServiceLogs(events, CloudType.AWS);
    expect(result).toMatch(/^Upgrade 1 · app:v1 → app:v2\n/);
    expect(result).not.toContain('Initial workload');
  });

  it('preserves verbose event details inside their upgrade section', () => {
    const events = [
      eventAt('10:30:00', WorkloadState.Running),
      eventAt('10:31:00', WorkloadState.Recovering, {
        reason: 'serve-upgrade',
        previousImage: 'app:v1',
        image: 'app:v2',
      }),
      eventAt('10:32:00', WorkloadState.Downloading, {
        imagePull: {
          schemaVersion: 1,
          method: 'docker-fallback',
          outcome: 'succeeded',
          elapsedMs: 1_000,
          reason: 'registry_throttled',
          containerdVersion: '2.2.1',
          snapshotter: 'overlayfs',
        },
      }),
    ];

    const result = formatServiceLogs(events, CloudType.AWS, { verbose: true });
    expect(result.indexOf('Upgrade 1 · app:v1 → app:v2')).toBeLessThan(
      result.indexOf('transfer fallback: registry throttled'),
    );
    expect(result).toContain('containerd 2.2.1, snapshotter overlayfs');
  });

  it('is applied only when rendering Service status', () => {
    const render = (workloadType: WorkloadType): string =>
      statusLines({
        workload: makeStatusWorkloadMetadata({ workloadType }),
        events: upgradedServiceEvents(),
        status: WorkloadHealthStatus.Unknown,
        vms: [],
      }).join('\n');

    expect(render(WorkloadType.Service)).toContain(
      'Upgrade 1 · app:v1 → app:v2',
    );
    expect(render(WorkloadType.Service)).not.toContain('Initial workload');
    expect(render(WorkloadType.Job)).not.toContain('Initial workload');
    expect(render(WorkloadType.Vm)).not.toContain('Initial workload');
  });
});

describe('formatQuotaHint', () => {
  it('returns the quota CLI hint when any retrying event is quota-exhausted', () => {
    const hint = formatQuotaHint([retryingQuotaEvent], baseWorkload());
    expect(hint).toBe('→ Run: anycloud quota status --region us-east-1 --spot');
  });

  it('returns the quota CLI hint for an account-regional spot pool', () => {
    const event = makeWorkloadEvent({
      state: WorkloadState.Retrying,
      createdAt: 0,
      metadata: {
        diagnosis: CloudFailureDiagnosis.AccountRegionalSpotQuotaExhausted,
        targetVmType: 'p5.48xlarge',
      },
    });
    expect(
      formatQuotaHint(
        [event],
        baseWorkload({ vmType: ['g6.xlarge', 'p5.48xlarge'] }),
      ),
    ).toBe('→ Run: anycloud quota status --region us-east-1 --spot');
  });

  it('handles quota events that recorded no target', () => {
    const event = makeWorkloadEvent({
      state: WorkloadState.Retrying,
      createdAt: 0,
      metadata: {
        diagnosis: CloudFailureDiagnosis.AccountRegionalSpotQuotaExhausted,
      },
    });
    expect(
      formatQuotaHint(
        [event],
        baseWorkload({ vmType: ['g6.xlarge', 'p5.48xlarge'] }),
      ),
    ).toBe('→ Run: anycloud quota status --region us-east-1 --spot');
  });

  it('uses the target from the latest regional quota event', () => {
    const events = [
      makeWorkloadEvent({
        id: 1,
        state: WorkloadState.Retrying,
        createdAt: 1,
        metadata: {
          diagnosis: CloudFailureDiagnosis.QuotaExhaustedRegion,
          targetVmType: 'g6.xlarge',
        },
      }),
      makeWorkloadEvent({
        id: 2,
        state: WorkloadState.Retrying,
        createdAt: 2,
        metadata: {
          diagnosis: CloudFailureDiagnosis.AccountRegionalSpotQuotaExhausted,
          targetVmType: 'p5.48xlarge',
        },
      }),
    ];
    expect(formatQuotaHint(events, baseWorkload())).toBe(
      '→ Run: anycloud quota status --region us-east-1 --spot',
    );
  });

  it('returns the account-wide vCPU hint for a GCP account quota event', () => {
    const accountEvent = makeWorkloadEvent({
      state: WorkloadState.Retrying,
      createdAt: 0,
      metadata: { errorKind: 'quota-exhausted-account', error: 'globally' },
    });
    const hint = formatQuotaHint(
      [accountEvent],
      baseWorkload({ cloudProvider: CloudType.GCP }),
    );
    expect(hint).toContain('Account-wide vCPU quota');
  });

  it('describes Lambda account quota as an instance-launch limit', () => {
    const accountEvent = makeWorkloadEvent({
      state: WorkloadState.Retrying,
      createdAt: 0,
      metadata: {
        diagnosis: CloudFailureDiagnosis.QuotaExhaustedAccount,
        error: '[global/quota-exceeded] Quota exceeded',
      },
    });
    const hint = formatQuotaHint(
      [accountEvent],
      baseWorkload({ cloudProvider: CloudType.Lambda, spot: false }),
    );
    expect(hint).toBe(
      '→ Lambda account instance-launch limit reached. AnyCloud will retry; terminate another Lambda instance or contact Lambda support.',
    );
  });

  it('omits --spot when workload is on-demand', () => {
    const hint = formatQuotaHint(
      [retryingQuotaEvent],
      baseWorkload({ spot: false }),
    );
    expect(hint).toBe('→ Run: anycloud quota status --region us-east-1');
  });

  it('needs no VM type or cloud flag for Azure', () => {
    const hint = formatQuotaHint(
      [retryingQuotaEvent],
      baseWorkload({
        cloudProvider: CloudType.Azure,
        vmType: 'Standard_NC40ads_H100_v5',
        spot: false,
      }),
    );
    expect(hint).toBe('→ Run: anycloud quota status --region us-east-1');
  });

  it('returns null when no quota-exhausted retrying event exists', () => {
    const events: WorkloadEvent[] = [
      makeWorkloadEvent({
        state: WorkloadState.Retrying,
        createdAt: 0,
        metadata: { errorKind: 'transient', error: 'timeout' },
      }),
    ];
    expect(formatQuotaHint(events, baseWorkload())).toBeNull();
  });

  it('returns null for capacity-exhausted (anycloud quota cannot help with capacity)', () => {
    // Capacity errors look like quota errors but the CLI hint is misleading —
    // running `anycloud quota` won't conjure spare hardware out of AWS.
    const events: WorkloadEvent[] = [
      makeWorkloadEvent({
        state: WorkloadState.Retrying,
        createdAt: 0,
        metadata: {
          errorKind: CloudFailureDiagnosis.CapacityExhausted,
          error:
            'There is no Spot capacity available that matches your request',
        },
      }),
    ];
    expect(formatQuotaHint(events, baseWorkload())).toBeNull();
  });

  it('still surfaces the hint when workload is Running', () => {
    expect(
      formatQuotaHint(
        [retryingQuotaEvent],
        baseWorkload({ state: WorkloadState.Running }),
      ),
    ).toBe('→ Run: anycloud quota status --region us-east-1 --spot');
  });

  it('still surfaces the hint when workload is Completed', () => {
    expect(
      formatQuotaHint(
        [retryingQuotaEvent],
        baseWorkload({ state: WorkloadState.Completed }),
      ),
    ).toBe('→ Run: anycloud quota status --region us-east-1 --spot');
  });

  it('needs no VM type, since quota status lists every family', () => {
    expect(
      formatQuotaHint([retryingQuotaEvent], baseWorkload({ vmType: null })),
    ).toBe('→ Run: anycloud quota status --region us-east-1 --spot');
  });

  it('shows the hint regardless of cloud — the server gates quota support', () => {
    // formatQuotaHint no longer pre-filters by quota capability. Quota is a
    // server-side CloudQuota gate now (the CLI has no quota-support signal), so
    // the region-quota hint can appear for a cloud whose `anycloud quota` the
    // server would reject — it returns a clear "not supported" message then.
    expect(
      formatQuotaHint(
        [retryingQuotaEvent],
        baseWorkload({ cloudProvider: CloudType.GCP }),
      ),
    ).not.toBeNull();
    expect(
      formatQuotaHint(
        [retryingQuotaEvent],
        baseWorkload({ cloudProvider: CloudType.Lambda }),
      ),
    ).not.toBeNull();
  });

  it('still surfaces the hint when the latest event is not the quota one', () => {
    const events: WorkloadEvent[] = [
      retryingQuotaEvent,
      makeWorkloadEvent({
        state: WorkloadState.Provisioning,
        createdAt: new Date('2024-01-15T10:31:00Z').getTime(),
        metadata: { region: 'us-east-2' },
      }),
    ];
    expect(formatQuotaHint(events, baseWorkload())).toBe(
      '→ Run: anycloud quota status --region us-east-1 --spot',
    );
  });

  it('names the region the quota failure happened in', () => {
    const event = makeWorkloadEvent({
      state: WorkloadState.Retrying,
      createdAt: 0,
      metadata: {
        diagnosis: CloudFailureDiagnosis.AccountRegionalSpotQuotaExhausted,
        targetRegion: 'us-east-2',
      },
    });
    expect(formatQuotaHint([event], baseWorkload({ region: null }))).toBe(
      '→ Run: anycloud quota status --region us-east-2 --spot',
    );
    expect(
      formatQuotaHint([retryingQuotaEvent], baseWorkload({ region: null })),
    ).toBe('→ Run: anycloud quota status --spot');
  });
});

describe('formatRetryHint', () => {
  const at = (time: string) => new Date(`2026-10-02T${time}Z`).getTime();
  const capacityEvent = makeWorkloadEvent({
    state: WorkloadState.Retrying,
    createdAt: at('19:29:40'),
    metadata: {
      diagnosis: CloudFailureDiagnosis.CapacityExhausted,
      error: 'insufficient capacity',
      targetVmType: 'g5.xlarge',
      targetRegion: 'us-east-2',
      targetAvailabilityZone: 'us-east-2b',
      targetSpot: true,
    },
  });
  const retry = {
    attempt: 3,
    earliestAt: at('19:31:00'),
    latestAt: at('19:35:00'),
  };
  const retrying = baseWorkload({ vmType: 'g5.xlarge' });

  it('gives the attempt, the next-attempt window and the capacity cause', () => {
    expect(
      formatRetryHint([capacityEvent], retrying, retry, at('19:30:00')),
    ).toBe(
      '→ Attempt 3, next 19:31–19:35: Spot capacity unavailable (g5.xlarge, us-east-2b). Automatic.',
    );
  });

  it('says the retry is due once the window has passed', () => {
    expect(
      formatRetryHint([capacityEvent], retrying, retry, at('19:36:00')),
    ).toBe(
      '→ Attempt 3, retry due now: Spot capacity unavailable (g5.xlarge, us-east-2b). Automatic.',
    );
  });

  it('names a quota cause and leaves other causes to the event log', () => {
    const quota = makeWorkloadEvent({
      state: WorkloadState.Retrying,
      createdAt: at('19:29:40'),
      metadata: {
        diagnosis: CloudFailureDiagnosis.AccountRegionalSpotQuotaExhausted,
        targetVmType: 'p5.48xlarge',
        targetRegion: 'us-east-2',
        targetSpot: true,
      },
    });
    expect(formatRetryHint([quota], retrying, retry, at('19:30:00'))).toBe(
      '→ Attempt 3, next 19:31–19:35: Spot quota exhausted (p5.48xlarge, us-east-2). Automatic.',
    );
    const pull = makeWorkloadEvent({
      state: WorkloadState.Retrying,
      createdAt: at('19:29:40'),
      metadata: { error: 'manifest unknown' },
    });
    expect(formatRetryHint([pull], retrying, retry, at('19:30:00'))).toBe(
      '→ Attempt 3, next 19:31–19:35. Automatic.',
    );
  });

  it('shows nothing outside Retrying or without retry facts', () => {
    expect(
      formatRetryHint(
        [capacityEvent],
        baseWorkload({ state: WorkloadState.Running }),
        retry,
        at('19:30:00'),
      ),
    ).toBeNull();
    expect(
      formatRetryHint([capacityEvent], retrying, undefined, at('19:30:00')),
    ).toBeNull();
  });

  it('renders in human-readable status output', () => {
    expect(
      statusLines({
        workload: retrying,
        events: [capacityEvent],
        status: WorkloadHealthStatus.Unknown,
        vms: [],
        retry,
      }).join('\n'),
    ).toContain('→ Attempt 3, ');
  });
});

describe('successful exit and checkpoint lines', () => {
  const vm = (container?: { exitCode?: number; oomKilled?: boolean }) => ({
    ip: '10.0.0.1',
    endedAt: null,
    ...(container && {
      container: { state: ContainerState.Exited, ...container },
    }),
  });
  const render = (
    workloadType: WorkloadType,
    state: WorkloadState,
    container?: { exitCode?: number; oomKilled?: boolean },
  ) =>
    statusLines({
      workload: makeStatusWorkloadMetadata({ workloadType, state }),
      events: [],
      status: WorkloadHealthStatus.Unknown,
      vms: [vm(container)],
    }).join('\n');

  it('marks a Job that exited 0 as finished, before and after completion', () => {
    expect(
      render(WorkloadType.Job, WorkloadState.Running, { exitCode: 0 }),
    ).toContain('✓ container    finished, exit 0');
    expect(render(WorkloadType.Job, WorkloadState.Completed)).toContain(
      '✓ container    finished, exit 0',
    );
  });

  it('keeps failures and Service exits marked as failed', () => {
    expect(
      render(WorkloadType.Job, WorkloadState.Errored, { exitCode: 2 }),
    ).toContain('✗ container    exited [exit: 2]');
    expect(
      render(WorkloadType.Job, WorkloadState.Running, {
        exitCode: 0,
        oomKilled: true,
      }),
    ).toContain('✗ container    exited [exit: 0, OOM]');
    expect(
      render(WorkloadType.Service, WorkloadState.Running, { exitCode: 0 }),
    ).toContain('✗ container    exited [exit: 0]');
  });

  it('shows what has reached the checkpoint bucket', () => {
    const now = Date.now();
    const lines = statusLines({
      workload: makeStatusWorkloadMetadata({ spot: true }),
      events: [],
      status: WorkloadHealthStatus.Up,
      vms: [],
      checkpoint: {
        bucket: 'spot-job',
        mount: '/mnt/checkpoint',
        retained: false,
        health: {
          objects: 52,
          bytes: 105_906_176,
          lastModifiedAt: now - 40_000,
          truncated: false,
        },
      },
    });
    expect(lines).toContain(
      'Checkpoint: 52 objects, 101.0 MB in the bucket, newest 40s ago',
    );
  });

  it('marks capped and empty checkpoint listings', () => {
    const line = (health: {
      objects: number;
      bytes: number;
      lastModifiedAt: number | null;
      truncated: boolean;
    }) =>
      statusLines({
        workload: makeStatusWorkloadMetadata({ spot: true }),
        events: [],
        status: WorkloadHealthStatus.Up,
        vms: [],
        checkpoint: {
          bucket: 'b',
          mount: '/mnt/checkpoint',
          retained: true,
          health,
        },
      }).find((text) => text.startsWith('Checkpoint:'));
    expect(
      line({
        objects: 1000,
        bytes: 2048,
        lastModifiedAt: null,
        truncated: true,
      }),
    ).toBe('Checkpoint: at least 1000 objects, 2.0 KB in the bucket');
    expect(
      line({ objects: 0, bytes: 0, lastModifiedAt: null, truncated: false }),
    ).toBe('Checkpoint: nothing saved yet');
  });
});

/** What `printWorkloadHeader` prints, one entry per console line. */
function headerLines(
  ...args: Parameters<typeof printWorkloadHeader>
): string[] {
  const lines: string[] = [];
  const log = vi
    .spyOn(console, 'log')
    .mockImplementation((...parts: unknown[]) => {
      lines.push(parts.map(String).join(' '));
    });
  try {
    printWorkloadHeader(...args);
  } finally {
    log.mockRestore();
  }
  return lines;
}

describe('pending provider teardown', () => {
  const renderTerminated = (
    overrides: {
      cleanedAt?: number | null;
      vmCount?: number;
      endedAt?: number | null;
    } = {},
  ): string[] => {
    const workload = makeStatusWorkloadMetadata({
      state: WorkloadState.Terminated,
      completedAt: Date.now(),
      cleanedAt: overrides.cleanedAt ?? null,
      vmCount: overrides.vmCount ?? 1,
    });
    // The fixture defaults cleanedAt to null, so omitting it from the overrides
    // is not enough to reproduce a response that never carried the field.
    if ('cleanedAt' in overrides && overrides.cleanedAt === undefined) {
      delete workload.cleanedAt;
    }
    return [
      ...headerLines(workload, { verbose: true }),
      ...statusLines(
        {
          workload,
          events: [],
          status: WorkloadHealthStatus.Unknown,
          vms: [{ ip: '203.0.113.20', endedAt: overrides.endedAt ?? null }],
        },
        { verbose: true },
      ),
    ];
  };

  it('names the type each VM launched as, when the API reports it', () => {
    const lines = statusLines(
      {
        workload: makeStatusWorkloadMetadata({
          state: WorkloadState.Running,
          vmType: ['m7i.xlarge', 'm8i.xlarge'],
        }),
        events: [],
        status: WorkloadHealthStatus.Unknown,
        vms: [
          { ip: '10.0.0.7', vmType: 'm8i.xlarge', endedAt: null },
          { ip: '10.0.0.8', endedAt: null },
        ],
      },
      {},
    );
    expect(lines).toContain('  10.0.0.7 (m8i.xlarge)');
    expect(lines).toContain('  10.0.0.8');
  });

  // A terminated workload holding a live VM is a machine the user believes
  // they already stopped paying for. Both surfaces must say so.
  it('marks the state line and the VM while the provider VM is still up', () => {
    const lines = renderTerminated();
    expect(
      lines.some((line) => line.includes('releasing VM (still billing)')),
    ).toBe(true);
    expect(
      lines.some((line) =>
        line.includes('203.0.113.20 (still running — releasing)'),
      ),
    ).toBe(true);
  });

  it('renders a fully cleaned workload exactly as before', () => {
    const lines = renderTerminated({
      cleanedAt: Date.now(),
      vmCount: 0,
      endedAt: Date.now(),
    });
    expect(lines.some((line) => line.includes('releasing'))).toBe(false);
    expect(
      lines.some((line) => line.includes('203.0.113.20 (terminated)')),
    ).toBe(true);
  });

  // cleanedAt is absent on responses from older APIs; the live VM count is the
  // authority so an upgraded CLI still tells the truth against an old server.
  it('flags a live VM when the server omits cleanedAt', () => {
    const lines = renderTerminated({ cleanedAt: undefined });
    expect(
      lines.some((line) => line.includes('releasing VM (still billing)')),
    ).toBe(true);
  });
});

describe('RFC 0049 C15 end reason', () => {
  const header = (
    overrides: Parameters<typeof makeStatusWorkloadMetadata>[0],
  ) =>
    stripVTControlCharacters(
      headerLines(makeStatusWorkloadMetadata(overrides)).join('\n'),
    );

  it("shows why a Job ended, with the final attempt's reason after a spent budget", () => {
    expect(
      header({ state: WorkloadState.Terminated, endReason: 'cancelled' }),
    ).toMatch(/End reason\s+cancelled\n/);
    expect(
      header({
        state: WorkloadState.Failed,
        endReason: 'retries-exhausted',
        lastAttemptEndReason: 'reclaimed',
      }),
    ).toMatch(/End reason\s+retries-exhausted \(last attempt: reclaimed\)/);
  });
});

describe('GPU health lines', () => {
  const render = (gpu: GpuHealth) =>
    stripVTControlCharacters(
      statusLines({
        workload: makeStatusWorkloadMetadata({
          workloadType: WorkloadType.Job,
          state: WorkloadState.Running,
        }),
        events: [],
        status: WorkloadHealthStatus.Down,
        vms: [
          {
            ip: '10.0.0.1',
            endedAt: null,
            container: { state: ContainerState.Running },
            gpu,
          },
        ],
      }).join('\n'),
    );
  type Gpu = GpuHealth['gpus'][number];
  const gpu = (index: number | null, fields: Partial<Gpu> = {}): Gpu => ({
    index,
    pci: `00000000:${String(index ?? 9).padStart(2, '0')}:00.0`,
    resetRequired: false,
    recoveryAction: null,
    xids: [],
    ...fields,
  });
  const xid = (code: number, at: string, resetNeeded: boolean) => ({
    code,
    at,
    message: 'x',
    resetNeeded,
  });

  it('names each GPU that needs a reset with its latest such Xid, and a GPU nvidia-smi lost by its address', () => {
    const text = render({
      state: 'unhealthy',
      gpus: [
        gpu(0, { xids: [xid(31, '2026-11-08T01:00:00.000Z', false)] }),
        gpu(1, {
          resetRequired: true,
          xids: [
            xid(154, '2026-11-08T01:02:03.000Z', true),
            xid(13, '2026-11-08T01:03:00.000Z', false),
          ],
        }),
        gpu(null, {
          pci: '0000:2a:00',
          xids: [xid(79, '2026-11-08T01:05:00.000Z', true)],
        }),
      ],
    });
    expect(text).toContain(
      '✗ gpu          GPU 1 needs a reset (Xid 154 at 2026-11-08T01:02:03.000Z)',
    );
    expect(text).toContain(
      '✗ gpu          GPU at 0000:2a:00 needs a reset (Xid 79 at 2026-11-08T01:05:00.000Z)',
    );
    // A benign Xid on a working GPU is no fault.
    expect(text).not.toContain('GPU 0');
  });

  it('shows a healthy read, a hung nvidia-smi and an unread GPU', () => {
    expect(render({ state: 'healthy', gpus: [gpu(0), gpu(1)] })).toContain(
      '✓ gpu          healthy (2 GPUs)',
    );
    expect(
      render({
        state: 'unhealthy',
        gpus: [],
        detail: 'nvidia-smi did not answer within 3 s',
      }),
    ).toContain('✗ gpu          nvidia-smi did not answer within 3 s');
    expect(
      render({
        state: 'unknown',
        gpus: [],
        detail: 'could not read the kernel journal for Xid errors',
      }),
    ).toContain(
      '◌ gpu          unknown (could not read the kernel journal for Xid errors)',
    );
  });
});

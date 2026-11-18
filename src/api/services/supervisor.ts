/**
 * Service management for rclone sync on VMs.
 * Uses systemd on real VMs, falls back to direct process management in containers.
 */

import { posix as pathPosix } from 'path';
import { createHash } from 'crypto';
import type { VmTransport } from './gateways/transport-contract.js';
import { log } from './logger.js';
import { CloudType } from '../../shared/cloud.js';
import { ServiceState, type ServiceStatus } from '../../shared/runtime.js';
import { retryUntil, withTimeout } from '../../shared/utils.js';
import { hasSystemd, installRcloneCommand } from './vm-initializer.js';
import { runDetachedOnVm } from './vm-exec.js';
import {
  FINAL_SYNC_TIMEOUT_MS,
  INPUT_SYNC_INACTIVITY_TIMEOUT_MS,
  PULL_POLL_INTERVAL_MS,
  PULL_CONTROL_TIMEOUT_MS,
  RCLONE_INIT_TIMEOUT_MS,
} from '../config.js';
import {
  RCLONE_CONF_TEMPLATE,
  rcloneEnvVars,
  rcloneTokenConfig,
  rcloneCopyCommand,
  rcloneContinuousLoop,
  rcloneInputSyncCommand,
  getRemotePath,
  type BucketConfig,
} from './rclone-config.js';
import { redactSecrets } from './redact.js';
import {
  DEFAULT_BUCKET_HOST_PATHS,
  DEFAULT_BUCKET_HOST_ROOT,
  type BucketHostPaths,
} from '../../shared/providers.js';

export type BucketConfigs = {
  input?: BucketConfig;
  output?: BucketConfig;
  checkpoint?: BucketConfig;
};

export interface RcloneInitOptions {
  preserveLocalBuckets?: boolean;
  bucketHostPaths?: BucketHostPaths;
}

// How often the docker-logs unit re-dumps the container log into the synced
// output dir. Kept below the 60s rclone-output cadence so the shipped copy is
// never more than one rclone tick stale.
const DOCKER_LOG_DUMP_INTERVAL_SEC = 30;
// Line cap on each dump so a runaway log doesn't make the re-dump/re-upload
// unbounded on long, chatty training runs.
const DOCKER_LOG_TAIL_LINES = 50000;
// rclone exclude for the docker-logs unit's in-flight `.partial` temp files, so
// only completed (atomically renamed) log objects reach the output bucket. The
// docker-logs staging dir rides the output bucket, so only output copies use it.
const DOCKER_LOGS_PARTIAL_EXCLUDE = '.anycloud/logs/*.partial';

// Per-bucket env files for cross-cloud storage credentials.
// Each bucket can be on a different cloud, so each gets its own env file.
// Sourced by the corresponding rclone commands. No-ops when absent (same-cloud).
function rcloneEnvFile(bucket: 'input' | 'output' | 'checkpoint'): string {
  return `/etc/rclone-env-${bucket}`;
}
// A bucket's own rclone config, holding a GCP token a running sync reloads.
function rcloneConfigFile(bucket: 'input' | 'output' | 'checkpoint'): string {
  return `/etc/rclone-${bucket}.conf`;
}
function rcloneEnvPrefix(bucket: 'input' | 'output' | 'checkpoint'): string {
  // Guard the source. A *missing* env file (same-cloud buckets have none) makes
  // `. missing || true` EXIT a POSIX `sh`/dash shell before the `|| true` runs
  // (a special-builtin failure aborts a non-interactive shell) — which silently
  // killed the detached input sync (it runs under /bin/sh = dash, not the login
  // bash). `[ -f ] && .` is safe in both dash and bash.
  const envFile = rcloneEnvFile(bucket);
  return `[ -f ${envFile} ] && . ${envFile}; `;
}

export class SupervisorManager {
  private _hasSystemd: boolean | null = null;

  constructor(private ssh: VmTransport) {}

  private async useSystemd(): Promise<boolean> {
    if (this._hasSystemd === null) {
      this._hasSystemd = await hasSystemd(this.ssh);
    }
    return this._hasSystemd;
  }

  // ---- Static methods for config generation ----
  // Copy command + continuous loop come from ./rclone-config.js so the
  // rclone semantics live in one place and can't drift across consumers.

  private static getRcloneServiceConfig(
    bucket: 'output' | 'checkpoint',
    remotePath: string,
    localPath: string,
  ): string {
    // The output bucket also carries the docker-logs staging dir, so exclude
    // its in-flight `.partial` temp files from the copy.
    const excludes = bucket === 'output' ? [DOCKER_LOGS_PARTIAL_EXCLUDE] : [];
    const loop = rcloneContinuousLoop(
      `${rcloneEnvPrefix(bucket)}${rcloneCopyCommand(remotePath, localPath, undefined, excludes)}`,
    );
    const command = `/bin/bash -c '${loop}'`;
    return SupervisorManager.buildUnitFile(
      `rclone-${bucket}`,
      command,
      `/var/log/rclone-${bucket}.log`,
    );
  }

  /**
   * The single log-dump command shared by the continuous docker-logs unit and
   * the pre-teardown final flush, so the two can't drift.
   *
   * `mkdir -p` runs every attempt (a reinit may have wiped the dir). The dump
   * goes to a `.partial` SIBLING of the final log and is then atomically renamed
   * — same directory means same filesystem, so `mv` is an atomic rename and a
   * reader/rclone never sees a torn file (the earlier /tmp temp was a different
   * filesystem, making `mv` a non-atomic copy). The `&&` chain means a missing
   * container (before start / during an in-place restart) leaves the last good
   * log untouched rather than clobbering it. Logs are verbatim/unredacted — the
   * user's own container output in the user's own bucket. Filename is keyed to
   * the VM (`vmIp`) so a recovery on a fresh VM writes a distinct object and
   * never overwrites the preempted run's log.
   *
   * Values are shell-safe (a validated workload id + a sanitized vmIp + a
   * controlled host path), so — like getRcloneServiceConfig — they are inlined
   * without shellEscape, which would break the nested `bash -c '...'` quoting
   * the continuous unit wraps this in.
   */
  private static dockerLogsDumpCommand(
    workloadId: string,
    vmIp: string,
    outputHostPath: string,
  ): string {
    const incarnation = vmIp.replace(/[^a-zA-Z0-9_.-]/g, '-');
    const logDir = pathPosix.join(outputHostPath, '.anycloud', 'logs');
    const logFile = pathPosix.join(logDir, `${workloadId}-${incarnation}.log`);
    return (
      `mkdir -p ${logDir} && ` +
      `docker logs --tail ${DOCKER_LOG_TAIL_LINES} ${workloadId} > ${logFile}.partial 2>&1 && ` +
      `mv ${logFile}.partial ${logFile}`
    );
  }

  /**
   * Unit that continuously runs `dockerLogsDumpCommand` on a loop, so the
   * workload's stdout/stderr reach the user's output bucket — grep-able after
   * teardown and surviving a spot preemption (only the last dump interval is at
   * risk). A `while true` loop (same shape as the rclone units) rather than a
   * `docker logs -f` follower, so it stays reliably active for installService's
   * readiness wait instead of flapping while the container is still starting.
   */
  private static getDockerLogsServiceConfig(
    workloadId: string,
    vmIp: string,
    outputHostPath: string,
  ): string {
    const loop = rcloneContinuousLoop(
      SupervisorManager.dockerLogsDumpCommand(workloadId, vmIp, outputHostPath),
      DOCKER_LOG_DUMP_INTERVAL_SEC,
    );
    const command = `/bin/bash -c '${loop}'`;
    return SupervisorManager.buildUnitFile(
      'docker-logs',
      command,
      '/var/log/docker-logs.log',
    );
  }

  private static buildUnitFile(
    name: string,
    command: string,
    logFile: string,
  ): string {
    return `[Unit]
Description=${name}
After=network.target
StartLimitIntervalSec=0

[Service]
Type=simple
ExecStart=${command}
Restart=always
RestartSec=5
StandardOutput=append:${logFile}
StandardError=append:${logFile}

[Install]
WantedBy=multi-user.target`;
  }

  // ---- Instance methods for status checking ----

  private async getStatus(serviceName: string): Promise<ServiceState> {
    try {
      if (await this.useSystemd()) {
        // Unit-file check first: `is-active` prints "inactive" for units that
        // were never installed (for example, rclone-checkpoint without a
        // checkpoint target), which must stay Unknown (= service doesn't
        // exist) rather than become "stopped" noise in diagnostics.
        const { stdout } = await this.ssh.exec(
          `if [ -f /etc/systemd/system/${serviceName}.service ]; then systemctl is-active ${serviceName} 2>/dev/null || echo unknown; else echo missing; fi`,
          1,
        );
        // `is-active` prints the state AND exits nonzero for anything but
        // active, so the `|| echo unknown` fallback APPENDS a second line
        // ("inactive\nunknown"). Only the first line is the state; matching
        // on the full stdout made every stopped/failed service read as
        // Unknown and silently vanish from status.
        const state = stdout.trim().split('\n')[0];
        const stateMap: Record<string, ServiceState> = {
          active: ServiceState.Running,
          inactive: ServiceState.Stopped,
          activating: ServiceState.Starting,
          deactivating: ServiceState.Stopping,
          failed: ServiceState.Fatal,
        };
        return stateMap[state] || ServiceState.Unknown;
      } else {
        // No-systemd fallback: check if the unit's process is running. rclone
        // units match on the rclone binary + bucket; the docker-logs follower
        // is a bash loop with no 'rclone' in its cmdline, so match its dump
        // command instead (the 50000 tail is distinct from getContainerStatus's
        // one-shot `docker logs --tail 100`).
        const pattern =
          serviceName === 'docker-logs'
            ? `docker logs --tail ${DOCKER_LOG_TAIL_LINES}`
            : `rclone.*${serviceName.replace('rclone-', '')}`;
        const { stdout } = await this.ssh.exec(
          `pgrep -f "${pattern}" > /dev/null 2>&1 && echo active || echo inactive`,
          1,
        );
        return stdout.trim() === 'active'
          ? ServiceState.Running
          : ServiceState.Stopped;
      }
    } catch (error) {
      log.debug(`Failed to get ${serviceName} status`, { error });
      return ServiceState.Unknown;
    }
  }

  private async getLogs(serviceName: string): Promise<string | undefined> {
    try {
      // The unit writes rclone output straight to the log file via
      // `StandardOutput=append:`, which bypasses journald entirely — the
      // unit journal holds ONLY systemd lifecycle noise (start/stop lines,
      // cgroup cleanup warnings), never a single rclone line. Read the file;
      // keep journalctl as a fallback for old VMs whose unit predates the
      // log file.
      if (await this.useSystemd()) {
        const { stdout } = await this.ssh.exec(
          `tail -200 /var/log/${serviceName}.log 2>/dev/null || journalctl -u ${serviceName} --no-pager -n 200 2>/dev/null`,
        );
        return redactSecrets(stdout);
      } else {
        const { stdout } = await this.ssh.exec(
          `tail -200 /var/log/${serviceName}.log 2>/dev/null`,
        );
        return redactSecrets(stdout);
      }
    } catch (error) {
      log.debug('Failed to retrieve logs', { serviceName, error });
      return undefined;
    }
  }

  /**
   * Get rclone sync services status (output and checkpoint buckets have services)
   * Input bucket has no service (download-once only)
   */
  async getRcloneStatus(verbose = false): Promise<{
    output?: ServiceStatus;
    checkpoint?: ServiceStatus;
  }> {
    const getServiceStatus = async (
      serviceName: string,
    ): Promise<ServiceStatus | undefined> => {
      try {
        const status = await this.getStatus(serviceName);
        if (status === ServiceState.Unknown) return undefined;
        const logs =
          status === ServiceState.Running && !verbose
            ? undefined
            : await this.getLogs(serviceName);
        return { status, logs };
      } catch {
        return undefined; // Service doesn't exist
      }
    };

    const [output, checkpoint] = await Promise.all([
      getServiceStatus('rclone-output'),
      getServiceStatus('rclone-checkpoint'),
    ]);

    return { output, checkpoint };
  }

  /**
   * Wait for a service to reach RUNNING state
   */
  async waitForService(
    serviceName: string,
    maxAttempts = 10,
    intervalMs = 1000,
  ): Promise<void> {
    await retryUntil(
      async () => {
        const status = await this.getStatus(serviceName);
        return status;
      },
      (status) => status === ServiceState.Running,
      `Service ${serviceName} to reach RUNNING state`,
      { maxAttempts, waitMs: intervalMs },
    );
  }

  /**
   * Write per-bucket env file for rclone on the VM. Shells the same
   * env vars `rcloneEnvVars` returns through single-quoted exports so
   * they survive sourcing into the rclone systemd service (or the
   * no-systemd fallback) without re-expansion.
   */
  private async writeBucketEnvFile(
    bucket: 'input' | 'output' | 'checkpoint',
    config: BucketConfig,
  ): Promise<void> {
    const env = rcloneEnvVars(config);
    const tokenConfig = rcloneTokenConfig(config);
    if (tokenConfig) {
      const file = rcloneConfigFile(bucket);
      await this.ssh.exec(
        `set -e\numask 077\ntmp=$(mktemp ${file}.XXXXXX)\ncat > "$tmp" << 'RCLONE_CONF_EOF'\n${tokenConfig}RCLONE_CONF_EOF\nmv "$tmp" ${file}`,
      );
      env.RCLONE_CONFIG = file;
    }
    const lines = Object.entries(env).map(
      ([k, v]) => `export ${k}='${v.replace(/'/g, "'\\''")}'`,
    );
    if (lines.length === 0) return;

    const envFile = rcloneEnvFile(bucket);
    const envContent = lines.join('\n');
    await this.ssh.exec(
      `set -e\numask 077\ntmp=$(mktemp ${envFile}.XXXXXX)\ncat > "$tmp" << 'RCLONE_ENV_EOF'\n${envContent}\nRCLONE_ENV_EOF\nmv "$tmp" ${envFile}`,
    );
  }

  /**
   * Atomically replace credentials: each upload pass re-reads its env file,
   * and a running GCP sync reloads its token from the bucket's config.
   */
  async refreshRcloneCredentials(buckets: BucketConfigs): Promise<void> {
    const writes: Promise<void>[] = [];
    for (const [bucket, config] of Object.entries(buckets) as [
      'input' | 'output' | 'checkpoint',
      BucketConfig | undefined,
    ][]) {
      if (config) writes.push(this.writeBucketEnvFile(bucket, config));
    }
    await Promise.all(writes);
  }

  /**
   * Initialize rclone sync via SSH after bucket permissions are granted.
   * Creates rclone config and starts systemd services for each bucket type.
   */
  async initRclone(
    buckets: BucketConfigs,
    workloadId?: string,
    vmIp?: string,
    options: RcloneInitOptions = {},
  ): Promise<void> {
    const hostPaths = options.bucketHostPaths ?? DEFAULT_BUCKET_HOST_PATHS;
    const managedHostRoots = [
      ...new Set(
        Object.values(hostPaths)
          .map((path) => pathPosix.dirname(path))
          .filter((root) => root !== DEFAULT_BUCKET_HOST_ROOT),
      ),
    ];
    const usesManagedBucketRoot = managedHostRoots.length > 0;

    log.info('Initializing rclone for buckets', {
      id: workloadId,
      ip: vmIp,
      buckets: {
        input: buckets.input?.name,
        output: buckets.output?.name,
        checkpoint: buckets.checkpoint?.name,
      },
    });

    try {
      // Stop any running sync services before re-initializing.
      // On in-place VM restart recovery, these services may be running from the
      // previous boot. Uses 20 retries (100s) to wait for SSH readiness after restart.
      // On fresh VMs these services don't exist yet, which is suppressed by || true.
      if (await this.useSystemd()) {
        await this.ssh.exec(
          'systemctl stop rclone-output rclone-checkpoint docker-logs 2>/dev/null || true',
          20,
        );
      } else {
        // Stop only upload workers. An initial input sync may still be running
        // after an API restart and setupInputBucket will safely reattach to it.
        // Use the rclone binary path to avoid matching the SSH session.
        // The docker-logs follower has no distinct binary, so match its cmdline —
        // but the `[d]` bracket keeps the pattern from matching the shell running
        // THIS pkill (whose argv would otherwise contain the literal string),
        // which would signal-kill the exec (exit code null).
        await this.ssh.exec(
          `pkill -f "[/]usr/bin/rclone copy " 2>/dev/null || true; pkill -f "[d]ocker logs --tail ${DOCKER_LOG_TAIL_LINES}" 2>/dev/null || true`,
          20,
        );
      }

      if (usesManagedBucketRoot) {
        for (const root of managedHostRoots) {
          await this.ssh.exec(
            `mkdir -p ${root} && test "$(stat -c %d ${root})" = "$(stat -c %d /)"`,
          );
        }
      }

      // Ensure rclone is installed (normally done during initializeVM,
      // but re-install as fallback for recovery paths)
      await this.ssh.exec(`which rclone || (${installRcloneCommand()})`);

      // Check if any buckets need cloud remotes
      const allConfigs = [
        buckets.input,
        buckets.output,
        buckets.checkpoint,
      ].filter(Boolean) as BucketConfig[];
      const hasCloudBuckets = allConfigs.some(
        (b) => !getRemotePath(b.name, b.cloudType).startsWith('/'),
      );

      if (hasCloudBuckets) {
        await this.ssh.exec(`mkdir -p /root/.config/rclone`);

        // Write per-bucket env files for storage credentials / config.
        // Minted buckets get their scoped token; GCP same-cloud buckets get
        // none (auth via instance metadata).
        await Promise.all(
          (
            Object.entries(buckets) as [
              'input' | 'output' | 'checkpoint',
              BucketConfig | undefined,
            ][]
          )
            .filter(([, config]) => config)
            .map(([bucket, config]) =>
              this.writeBucketEnvFile(bucket, config!),
            ),
        );

        await this.ssh
          .exec(`cat > /root/.config/rclone/rclone.conf << 'RCLONE_CONF_EOF'
${RCLONE_CONF_TEMPLATE}RCLONE_CONF_EOF`);
      }

      // Setup all buckets in parallel
      const setupPromises: Promise<void>[] = [];

      if (buckets.input) {
        setupPromises.push(
          this.setupInputBucket(
            buckets.input.name,
            buckets.input.cloudType,
            workloadId,
            vmIp,
            hostPaths.input,
          ),
        );
      }

      // Only the input hydrate has a data-dependent duration (and its own
      // inactivity watchdog). Everything else here stays under the ordinary
      // rclone-setup ceiling so the enclosing step's exemption for large inputs
      // cannot leave an upload or a checkpoint restore wedged indefinitely.
      if (buckets.output) {
        setupPromises.push(
          withTimeout(
            this.setupOutputBucket(
              buckets.output.name,
              buckets.output.cloudType,
              workloadId,
              vmIp,
              options.preserveLocalBuckets ?? false,
              hostPaths.output,
            ),
            RCLONE_INIT_TIMEOUT_MS,
            'Output bucket setup',
          ),
        );
      }

      if (buckets.checkpoint) {
        setupPromises.push(
          withTimeout(
            this.setupCheckpointBucket(
              buckets.checkpoint.name,
              buckets.checkpoint.cloudType,
              workloadId,
              vmIp,
              options.preserveLocalBuckets ?? false,
              usesManagedBucketRoot,
              hostPaths.checkpoint,
            ),
            RCLONE_INIT_TIMEOUT_MS,
            'Checkpoint bucket setup',
          ),
        );
      }

      await Promise.all(setupPromises);

      log.info('Rclone initialization complete', {
        id: workloadId,
        ip: vmIp,
      });
    } catch (error) {
      // Enhance error with rclone logs if available
      const enhancedError = error as any;
      enhancedError.buckets = {
        input: buckets.input?.name,
        output: buckets.output?.name,
        checkpoint: buckets.checkpoint?.name,
      };
      throw enhancedError;
    }
  }

  /**
   * Verify bucket connectivity before the real sync/copy starts.
   * Retries cover cloud provider credential propagation delays
   * (GCP metadata). 30 retries * 15s = 450s (7.5 min).
   * SSH layer uses default retries (4 attempts, 5s wait).
   *
   * Input buckets get a read-only list instead of a write probe: cross-cloud
   * storage credentials mint input buckets with read-only session policies
   * (no s3:PutObject — see s3BucketStatement's 'read' mode), so a write-based
   * touch is guaranteed AccessDenied there. `lsf` only needs s3:ListBucket,
   * which 'read' mode already grants.
   */
  private async verifyBucketConnectivity(
    remotePath: string,
    bucket: 'input' | 'output' | 'checkpoint',
  ): Promise<void> {
    const envPrefix = rcloneEnvPrefix(bucket);
    const probe =
      bucket === 'input'
        ? `lsf ${remotePath} --max-depth 1`
        : `touch ${remotePath}/.rclone-keep`;
    await this.ssh.exec(
      `${envPrefix}/usr/bin/rclone ${probe} --retries 30 --retries-sleep 15s --verbose 2>&1`,
    );
  }

  /**
   * Install a systemd service and wait for it to reach RUNNING.
   * Falls back to direct process execution in containers without systemd.
   */
  private async installService(
    serviceName: string,
    unitFile: string,
  ): Promise<void> {
    if (await this.useSystemd()) {
      await this.ssh.exec(
        `cat > /etc/systemd/system/${serviceName}.service << 'UNIT_EOF'\n${unitFile}\nUNIT_EOF`,
      );
      // `restart`, not `start`: on a reinit (recovery) the unit file is
      // rewritten with possibly new paths/IPs, and `start` is a no-op on an
      // already-active unit — `restart` guarantees the new definition takes
      // effect.
      await this.ssh.exec(
        `systemctl daemon-reload && systemctl enable ${serviceName} && systemctl restart ${serviceName}`,
      );
    } else {
      // No-systemd fallback: extract ExecStart and run as a fully detached
      // background process. Explicitly close stdin as well as redirecting
      // stdout/stderr: otherwise the child can retain the SSH channel and make
      // ssh.exec wait until the pooled connection expires even though the
      // service itself is already running.
      const execMatch = unitFile.match(/ExecStart=(.+)/);
      if (execMatch) {
        const logFile =
          unitFile.match(/StandardOutput=append:(.+)/)?.[1] ||
          `/var/log/${serviceName}.log`;
        await this.ssh.exec(
          `nohup ${execMatch[1]} </dev/null > ${logFile} 2>&1 &`,
        );
      }
    }
    await this.waitForService(serviceName);
  }

  private async setupInputBucket(
    bucketName: string,
    cloudType: CloudType,
    workloadId?: string,
    vmIp?: string,
    localPath = '/mnt/input',
  ): Promise<void> {
    const remotePath = getRemotePath(bucketName, cloudType);

    log.info('Setting up input bucket', {
      id: workloadId,
      ip: vmIp,
      bucket: bucketName,
    });

    await this.ssh.exec(`mkdir -p ${localPath}`);
    await withTimeout(
      this.verifyBucketConnectivity(remotePath, 'input'),
      RCLONE_INIT_TIMEOUT_MS,
      'Input bucket connectivity',
    );

    // Download once — detached on the VM so a dropped SSH control stream (or an
    // input file larger than the ~5-min NAT window) can't wedge the sync, the same
    // failure the image pull hit. Input size and object count determine how long
    // this takes, so rclone owns its transfer/retry lifetime instead of an
    // arbitrary wall-clock deadline. Reattach after an API restart rather than
    // killing a healthy transfer and starting it over. Creds ride the sourced env
    // file, not argv.
    const safeId = (workloadId ?? 'sync').replace(/[^a-zA-Z0-9_.-]/g, '_');
    const command = `${rcloneEnvPrefix('input')}${rcloneInputSyncCommand(remotePath, localPath)}`;
    const runIdentity = createHash('sha256').update(command).digest('hex');
    await runDetachedOnVm(
      (cmd, timeoutMs) => this.ssh.exec(cmd, 4, false, timeoutMs),
      {
        unit: `ac-input-${safeId}`,
        command,
        pollIntervalMs: PULL_POLL_INTERVAL_MS,
        controlTimeoutMs: PULL_CONTROL_TIMEOUT_MS,
        inactivityTimeoutMs: INPUT_SYNC_INACTIVITY_TIMEOUT_MS,
        hasSystemd: await this.useSystemd(),
        runIdentity,
        logContext: { id: workloadId, ip: vmIp, bucket: bucketName },
      },
    );

    log.info('Input bucket downloaded', {
      id: workloadId,
      bucket: bucketName,
    });
  }

  /**
   * Setup output bucket: upload only, continuous sync
   */
  private async setupOutputBucket(
    bucketName: string,
    cloudType: CloudType,
    workloadId?: string,
    vmIp?: string,
    preserveLocalOutput = false,
    localPath = '/mnt/output',
  ): Promise<void> {
    const remotePath = getRemotePath(bucketName, cloudType);

    log.info('Setting up output bucket', {
      id: workloadId,
      ip: vmIp,
      bucket: bucketName,
      preserveLocalOutput,
    });

    // A same-VM restart can have output newer than the background uploader.
    // Fresh/replacement VMs still start empty so they cannot upload stale data.
    await this.ssh.exec(
      preserveLocalOutput
        ? `mkdir -p ${localPath}`
        : `rm -rf ${localPath} && mkdir -p ${localPath}`,
    );
    await this.verifyBucketConnectivity(remotePath, 'output');

    if (preserveLocalOutput) {
      await this.runFinalSync(
        'output',
        bucketName,
        cloudType,
        workloadId,
        vmIp,
        FINAL_SYNC_TIMEOUT_MS,
        localPath,
        'recovery',
      );
    }

    await this.installService(
      'rclone-output',
      SupervisorManager.getRcloneServiceConfig('output', remotePath, localPath),
    );

    // Ride the output sync to persist the workload's logs: a companion unit
    // dumps `docker logs` into the synced output dir, so the rclone-output loop
    // above (and the final sync at teardown) carry them to the user's bucket.
    await this.installService(
      'docker-logs',
      SupervisorManager.getDockerLogsServiceConfig(
        workloadId ?? 'job',
        vmIp ?? 'vm',
        localPath,
      ),
    );

    log.info('Output bucket sync started', {
      id: workloadId,
      bucket: bucketName,
    });
  }

  /**
   * Setup checkpoint bucket: hydrate from remote for new VMs, or preserve local
   * state for in-place restarts, then start continuous upload.
   */
  private async setupCheckpointBucket(
    bucketName: string,
    cloudType: CloudType,
    workloadId?: string,
    vmIp?: string,
    preserveLocalCheckpoint = false,
    managedHostRoot = false,
    localPath = '/mnt/checkpoint',
  ): Promise<void> {
    const remotePath = getRemotePath(bucketName, cloudType);

    log.info('Setting up checkpoint bucket', {
      id: workloadId,
      ip: vmIp,
      bucket: bucketName,
      preserveLocalCheckpoint,
    });

    const preserveLocal = await this.shouldPreserveCheckpointLocalState(
      preserveLocalCheckpoint,
      managedHostRoot,
      localPath,
    );

    // Managed clusterRecords are workload-specific, so an authoritative remote sync
    // can reuse a partial download. Legacy /mnt may contain unrelated data.
    const prepareDir =
      preserveLocal || managedHostRoot
        ? `mkdir -p ${localPath}`
        : `rm -rf ${localPath} && mkdir -p ${localPath}`;
    await this.ssh.exec(prepareDir);
    await this.verifyBucketConnectivity(remotePath, 'checkpoint');

    if (preserveLocal) {
      // Same-VM restart: the local disk may contain progress that has not yet
      // reached cloud storage. Do not run a remote->local hydrate that could
      // overwrite it.
      log.info('Checkpoint local state preserved', {
        id: workloadId,
        ip: vmIp,
        bucket: bucketName,
      });
      await this.runFinalSync(
        'checkpoint',
        bucketName,
        cloudType,
        workloadId,
        vmIp,
        FINAL_SYNC_TIMEOUT_MS,
        localPath,
        'recovery',
      );
    } else {
      // New/replacement VM: local checkpoint state is untrusted. Make the
      // directory exactly match cloud storage before uploads can resume.
      const envPrefix = rcloneEnvPrefix('checkpoint');
      await this.ssh.exec(
        `${envPrefix}${rcloneInputSyncCommand(remotePath, localPath)}`,
      );
      log.info('Checkpoint bucket hydrated from remote', {
        id: workloadId,
        ip: vmIp,
        bucket: bucketName,
      });
    }

    await this.logCheckpointSnapshot(localPath, workloadId, vmIp, bucketName);

    // Continuous upload: VM → bucket
    await this.installService(
      'rclone-checkpoint',
      SupervisorManager.getRcloneServiceConfig(
        'checkpoint',
        remotePath,
        localPath,
      ),
    );

    log.info('Checkpoint bucket sync started', {
      id: workloadId,
      bucket: bucketName,
    });
  }

  private async shouldPreserveCheckpointLocalState(
    preserveRequested: boolean,
    managedHostRoot: boolean,
    localPath: string,
  ): Promise<boolean> {
    if (!preserveRequested) return false;
    if (!managedHostRoot) return true;
    const { stdout } = await this.ssh.exec(
      `if [ -d ${localPath} ] && find ${localPath} -type f ! -name .rclone-keep -print -quit | grep -q .; then echo 1; else echo 0; fi`,
    );
    return stdout.trim() === '1';
  }

  private async logCheckpointSnapshot(
    localPath: string,
    workloadId?: string,
    vmIp?: string,
    bucketName?: string,
  ): Promise<void> {
    try {
      const { stdout } = await this.ssh.exec(
        [
          'set +e',
          `echo "checkpoint_dir=${localPath}"`,
          `find ${localPath} -maxdepth 1 -type f -printf '%f bytes=%s mtime=%T@\\n' 2>/dev/null | sort | head -20`,
          `if [ -f ${localPath}/results.json ]; then`,
          `  bytes=$(wc -c < ${localPath}/results.json 2>/dev/null | tr -d ' ')`,
          `  sha=$(sha256sum ${localPath}/results.json 2>/dev/null | awk '{print $1}')`,
          `  count=$(python3 -c "import json; d=json.load(open('${localPath}/results.json')); print(len(d.get('molecules', d)))" 2>/dev/null)`,
          `  echo "results.json bytes=$bytes sha256=$sha molecules=\${count:-unknown}"`,
          'fi',
          'true',
        ].join('\n'),
      );
      const snapshot = stdout.trim();
      if (snapshot) {
        log.info('Checkpoint local snapshot', {
          id: workloadId,
          ip: vmIp,
          bucket: bucketName,
          snapshot,
        });
      }
    } catch (error) {
      log.debug('Failed to collect checkpoint snapshot', {
        id: workloadId,
        ip: vmIp,
        bucket: bucketName,
        error: error,
      });
    }
  }

  /**
   * Flush a final bucket (output or checkpoint) before VM termination. The
   * rclone sidecar runs on a 60s cycle, so files the container writes at exit
   * (e.g. a final cp into /mnt/output) can be lost if the VM is torn down
   * mid-cycle; this forces a final upload to complete first.
   *
   * Runs the rclone copy DETACHED on the VM (systemd transient unit) and polls a
   * sentinel via short execs — a single held SSH exec for the whole copy dies on
   * the ~5-min NAT/idle teardown and loses the artifacts (the same failure the
   * image pull and input download hit). Resolves only after the detached copy
   * reports done and throws (DetachedRunError) on a non-zero exit, so the
   * caller's confirm-then-terminate ordering (finalizeJobArtifacts) is preserved.
   */
  private async runFinalSync(
    kind: 'output' | 'checkpoint',
    bucketName: string,
    cloudType: CloudType,
    workloadId?: string,
    vmIp?: string,
    commandTimeoutMs: number = FINAL_SYNC_TIMEOUT_MS,
    localPath: string = `/mnt/${kind}`,
    operation: 'final' | 'recovery' = 'final',
  ): Promise<void> {
    const remotePath = getRemotePath(bucketName, cloudType);

    log.info(`Running ${operation} ${kind} sync`, {
      id: workloadId,
      ip: vmIp,
      bucket: bucketName,
    });

    const safeId = (workloadId ?? 'sync').replace(/[^a-zA-Z0-9_.-]/g, '_');
    const excludes = kind === 'output' ? [DOCKER_LOGS_PARTIAL_EXCLUDE] : [];
    await runDetachedOnVm(
      (cmd, timeoutMs) => this.ssh.exec(cmd, 4, false, timeoutMs),
      {
        unit: `ac-${operation}-${kind}-${safeId}`,
        command: `${rcloneEnvPrefix(kind)}${rcloneCopyCommand(remotePath, localPath, undefined, excludes)}`,
        totalTimeoutMs: commandTimeoutMs,
        pollIntervalMs: PULL_POLL_INTERVAL_MS,
        controlTimeoutMs: PULL_CONTROL_TIMEOUT_MS,
        hasSystemd: await this.useSystemd(),
        logContext: { id: workloadId, ip: vmIp, bucket: bucketName },
      },
    );

    log.info(`${operation} ${kind} sync complete`, {
      id: workloadId,
      ip: vmIp,
      bucket: bucketName,
    });
  }

  /**
   * One-shot best-effort dump of the workload container's current logs into the
   * synced output dir, using the SAME command as the continuous docker-logs
   * unit. Run just before the final output sync so the shipped log is complete
   * even if the continuous unit is a dump-interval behind. Swallows failures — a
   * log dump must never block (or fail) the terminal output flush.
   */
  private async dumpWorkloadLogs(
    workloadId: string,
    outputHostPath: string,
    vmIp?: string,
  ): Promise<void> {
    try {
      await this.ssh.exec(
        SupervisorManager.dockerLogsDumpCommand(
          workloadId,
          vmIp ?? 'vm',
          outputHostPath,
        ),
        1,
        false,
        FINAL_SYNC_TIMEOUT_MS,
      );
    } catch (error) {
      log.warn('Final workload-log dump failed (non-fatal)', {
        id: workloadId,
        error,
      });
    }
  }

  /**
   * Run a one-shot rclone copy to flush the output bucket before VM termination.
   */
  async runFinalOutputSync(
    bucketName: string,
    cloudType: CloudType,
    workloadId?: string,
    vmIp?: string,
    commandTimeoutMs: number = FINAL_SYNC_TIMEOUT_MS,
    localPath = '/mnt/output',
  ): Promise<void> {
    // Flush the container's final logs into the output dir FIRST so this sync
    // ships the complete log — the continuous docker-logs unit may be up to one
    // dump interval stale. Best-effort; never blocks the output flush.
    if (workloadId) {
      await this.dumpWorkloadLogs(workloadId, localPath, vmIp);
    }
    return this.runFinalSync(
      'output',
      bucketName,
      cloudType,
      workloadId,
      vmIp,
      commandTimeoutMs,
      localPath,
    );
  }

  /**
   * Run a one-shot rclone copy to flush the checkpoint bucket before VM termination.
   */
  async runFinalCheckpointSync(
    bucketName: string,
    cloudType: CloudType,
    workloadId?: string,
    vmIp?: string,
    commandTimeoutMs: number = FINAL_SYNC_TIMEOUT_MS,
    localPath = '/mnt/checkpoint',
  ): Promise<void> {
    return this.runFinalSync(
      'checkpoint',
      bucketName,
      cloudType,
      workloadId,
      vmIp,
      commandTimeoutMs,
      localPath,
    );
  }

  /**
   * Stop the VM-side sync services (output, checkpoint, and the docker-logs
   * follower). Used during upgrades to stop them before new VMs initialize.
   */
  async stopRcloneServices(): Promise<void> {
    log.info('Stopping rclone services');

    if (await this.useSystemd()) {
      // Check which services are active before stopping
      const { stdout } = await this.ssh.exec(
        'systemctl is-active rclone-output rclone-checkpoint docker-logs 2>&1 || true',
        1,
      );
      const lines = stdout.trim().split('\n');
      const services = ['rclone-output', 'rclone-checkpoint', 'docker-logs'];
      const activeServices = services.filter(
        (_, i) => lines[i]?.trim() === 'active',
      );

      if (activeServices.length === 0) {
        log.info('No rclone services found - nothing to stop');
        return;
      }

      await this.ssh.exec(
        `systemctl stop ${activeServices.join(' ')} 2>/dev/null || true`,
      );

      log.info('Rclone services stopped successfully', {
        stoppedServices: activeServices,
      });
    } else {
      // `[d]` bracket so the docker-logs pattern can't match the shell running
      // this pkill (which would signal-kill the exec).
      await this.ssh.exec(
        `pkill -x rclone 2>/dev/null || true; pkill -f "[d]ocker logs --tail ${DOCKER_LOG_TAIL_LINES}" 2>/dev/null || true`,
      );
      log.info('Rclone services stopped successfully');
    }
  }
}

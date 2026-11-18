/**
 * VM command execution through the system OpenSSH client.
 *
 * At most two ControlMasters per host/port/user/key multiplex independent
 * command subprocesses: platform operations use one and user-controlled
 * streams use the other. Long-lived streams therefore cannot consume the
 * platform connection's sessions, and OpenSSH owns the protocol and connection
 * lifecycle instead of a process-local refcount pool.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { join, posix as posixPath } from 'node:path';
import { log } from '../logger.js';
import {
  ConcurrencyLimiter,
  shellEscape,
  withRetry,
} from '../../../shared/utils.js';
import config from '../../config.js';
import type {
  ExecStreamOptions,
  VmTransport,
  WriteFileOptions,
} from './transport-contract.js';
import { errorMessage } from '../../../shared/log-diagnostics.js';
import {
  runSshProcess,
  SshProcessError,
  SshProcessTimeoutError,
} from './ssh-process.js';

const SSH_CONNECT_TIMEOUT_SECONDS = 15;
const SSH_MASTER_START_TIMEOUT_MS = 20_000;
const SSH_MASTER_CHECK_TIMEOUT_MS = 3_000;
const SSH_KEYGEN_TIMEOUT_MS = 15_000;
const SSH_CONTROL_PERSIST_SECONDS = 60;
const SSH_KEEPALIVE_SECONDS = 10;
const SSH_KEEPALIVE_COUNT = 3;
const SSH_USER_SESSION_LIMIT = 10;
const TMPFS_MAGIC = 0x01021994;

// Hold slots through temporary-file cleanup so bursts fit the 1 MiB SSH tmpfs.
const keyOperations = new ConcurrencyLimiter(32);

export type SSHConnectionPurpose = 'platform' | 'user';

// Exit codes that indicate transient remote command failures and should use
// the caller's existing retry budget.
const TRANSIENT_EXIT_CODES = new Set([100, 2, 7]);

function formatFileMode(mode: number, label: string): string {
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) {
    throw new Error(`Invalid ${label}: ${mode}`);
  }
  return mode.toString(8).padStart(4, '0');
}

function appendTail(
  value: string,
  chunk: Buffer | string,
  limit = 2_000,
): string {
  return (value + chunk.toString()).slice(-limit);
}

function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/**
 * Vitest exercises key generation directly on macOS and Linux hosts. Test keys
 * are synthetic and use an isolated process directory; production always uses
 * the fixed, validated tmpfs mount.
 */
export function sshRuntimeDirectory(): string {
  return config.sshRuntimeDirectory;
}

function ensureSshRuntimeDirectory(temporaryDirectory?: string): string {
  const directory = temporaryDirectory ?? sshRuntimeDirectory();

  if (temporaryDirectory !== undefined || !config.sshRuntimeRequiresTmpfs) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    return directory;
  }

  let stats;
  try {
    stats = lstatSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `OpenSSH runtime tmpfs is missing at ${directory}; launch the API with --tmpfs ${directory}:rw,noexec,nosuid,nodev,size=1m,mode=0700`,
      );
    }
    throw error;
  }

  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(
      `OpenSSH runtime path is not a private directory: ${directory}`,
    );
  }
  if (stats.uid !== 0 || (stats.mode & 0o777) !== 0o700) {
    throw new Error(
      `OpenSSH runtime directory must be root-owned and mode 0700: ${directory}`,
    );
  }
  if (statfsSync(directory).type !== TMPFS_MAGIC) {
    throw new Error(`OpenSSH runtime directory must be tmpfs: ${directory}`);
  }

  return directory;
}

class OpenSshUnavailableError extends Error {
  constructor() {
    super(
      'OpenSSH client is unavailable; install openssh-client in the API runtime',
    );
    this.name = 'OpenSshUnavailableError';
  }
}

function missingOpenSshBinary(error: unknown): Error | undefined {
  if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') return undefined;
  return new OpenSshUnavailableError();
}

async function runSshKeygen(
  args: string[],
  operation: string,
): Promise<string> {
  const result = await runCapturedProcess(
    args,
    SSH_KEYGEN_TIMEOUT_MS,
    'ssh-keygen',
  );
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().slice(-500);
    throw new Error(`${operation} failed${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout ?? '';
}

function publicKeyIdentity(value: string, label: string): string {
  const fields = value.trim().split(/\s+/);
  if (
    fields.length < 2 ||
    !/^(?:ssh-(?:ed25519|rsa)|ecdsa-sha2-nistp(?:256|384|521))$/.test(
      fields[0],
    ) ||
    !fields[1]
  ) {
    throw new Error(`Invalid ${label} format`);
  }
  return `${fields[0]} ${fields[1]}`;
}

/**
 * The exact bytes OpenSSH will load: LF line endings and one trailing
 * newline after the END marker. A key that lost its final newline in
 * storage or transport otherwise fails with "Load key: error in libcrypto".
 */
export function privateKeyFileContent(privateKey: string): string {
  return `${privateKey.replace(/\r\n?/g, '\n').replace(/\n+$/, '')}\n`;
}

function temporaryPrivateKey(privateKey: string): {
  path: string;
  remove: () => void;
} {
  const path = join(ensureSshRuntimeDirectory(), `identity-${randomUUID()}`);
  try {
    writeFileSync(path, privateKeyFileContent(privateKey), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    chmodSync(path, 0o600);
    return { path, remove: () => unlinkIfPresent(path) };
  } catch (error) {
    unlinkIfPresent(path);
    throw error;
  }
}

/**
 * Error thrown by SSH exec when buffered output is available. Callers use the
 * tails for diagnostics when a remote operation or its transport is cut off.
 */
export class SSHExecError extends Error {
  constructor(
    message: string,
    public readonly stdout: string,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = 'SSHExecError';
  }
}

/**
 * The client exited silently after its control master was gone, which is what
 * a client that never opened a session looks like. Separate from
 * `SSHExecError` because it is the one transport failure a caller's retry
 * budget need not govern: that budget limits how often their command runs, and
 * this attempt almost certainly did not run it. Almost, not certainly — a mute
 * command cut mid-flight is silent too — so acting on it is left to callers
 * that set `rerunOnLostMaster`.
 */
export class SSHMasterUnreachableError extends SSHExecError {
  constructor() {
    super(
      'SSH control master closed before the command produced any output',
      '',
      '',
    );
    this.name = 'SSHMasterUnreachableError';
  }
}

/** Stable, non-retryable error returned before an overloaded user session starts. */
export class SSHUserSessionCapacityError extends Error {
  readonly code = 'SSH_USER_SESSION_CAPACITY' as const;

  constructor() {
    super(
      `SSH user session limit of ${SSH_USER_SESSION_LIMIT} reached; wait for an active user command to finish`,
    );
    this.name = 'SSHUserSessionCapacityError';
  }
}

interface MasterDescriptor {
  key: string;
  controlPath: string;
  host: string;
  port: number;
  username: string;
}

interface CapturedProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface RemoteProcessOptions extends ExecStreamOptions {
  stdin?: Buffer;
  collectOutput?: boolean;
  /**
   * Rebuild a control master lost before the command started and run the
   * command once more. Off by default, because silence is not proof that the
   * command never started: only a caller that already tolerates re-execution
   * may ask for it.
   */
  rerunOnLostMaster?: boolean;
}

interface RemoteProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

function controlCommandArgs(
  master: MasterDescriptor,
  operation: 'check' | 'exit',
): string[] {
  return [
    '-F',
    '/dev/null',
    '-S',
    master.controlPath,
    '-O',
    operation,
    '-p',
    String(master.port),
    '-l',
    master.username,
    '--',
    master.host,
  ];
}

async function runCapturedProcess(
  args: string[],
  timeoutMs: number,
  binary: 'ssh' | 'ssh-keygen' = 'ssh',
): Promise<CapturedProcessResult> {
  let stdout = '';
  let stderr = '';
  // A large legacy RSA public key can exceed the SSH diagnostic tail.
  const outputLimit = binary === 'ssh-keygen' ? 1024 * 1024 : 2_000;
  try {
    const result = await runSshProcess(args, {
      binary,
      ignoreStdin: true,
      deadlineAt: performance.now() + timeoutMs,
      onStdout: (chunk) => {
        stdout = appendTail(stdout, chunk, outputLimit);
      },
      onStderr: (chunk) => {
        stderr = appendTail(stderr, chunk, outputLimit);
      },
    });
    return { ...result, stdout, stderr };
  } catch (error) {
    if (error instanceof SshProcessTimeoutError)
      throw new Error(`${binary} timed out after ${timeoutMs}ms`);
    throw missingOpenSshBinary(error) ?? error;
  }
}

export class SSHManager implements VmTransport {
  private static masters = new Map<string, MasterDescriptor>();
  private static pendingMasters = new Map<string, Promise<MasterDescriptor>>();
  private static userSessions = new Map<string, number>();
  private readonly port: number;

  constructor(
    private readonly host: string,
    private readonly privateKey: string,
    port?: number,
    private readonly username = 'root',
    private readonly purpose: SSHConnectionPurpose = 'platform',
  ) {
    this.port = port ?? config.sshPort;
  }

  /** Generate an unencrypted ED25519 keypair in the existing OpenSSH format. */
  static generateKeypair(temporaryDirectory?: string): Promise<{
    publicKey: string;
    privateKey: string;
  }> {
    return keyOperations.run(async () => {
      const directory = ensureSshRuntimeDirectory(temporaryDirectory);
      const privatePath = join(directory, `generated-${randomUUID()}`);
      const publicPath = `${privatePath}.pub`;

      try {
        await runSshKeygen(
          [
            '-q',
            '-t',
            'ed25519',
            '-N',
            '',
            '-C',
            'anycloud',
            '-f',
            privatePath,
          ],
          'SSH key generation',
        );
        chmodSync(privatePath, 0o600);
        const privateKey = readFileSync(privatePath, 'utf8');
        const publicIdentity = publicKeyIdentity(
          readFileSync(publicPath, 'utf8'),
          'SSH public key',
        );
        return { publicKey: `${publicIdentity} anycloud`, privateKey };
      } finally {
        unlinkIfPresent(publicPath);
        unlinkIfPresent(privatePath);
      }
    });
  }

  /** Derive a stable public key from any stored private-key format OpenSSH accepts. */
  static derivePublicKey(privateKey: string): Promise<string> {
    return keyOperations.run(async () => {
      const keyLen = privateKey?.length ?? 0;
      const hasHeader = privateKey?.includes(
        '-----BEGIN OPENSSH PRIVATE KEY-----',
      );
      const hasFooter = privateKey?.includes(
        '-----END OPENSSH PRIVATE KEY-----',
      );
      let temporary: ReturnType<typeof temporaryPrivateKey> | undefined;

      try {
        if (!privateKey?.trim()) throw new Error('private key is empty');
        temporary = temporaryPrivateKey(privateKey);
        const output = await runSshKeygen(
          ['-y', '-P', '', '-f', temporary.path],
          'SSH public-key derivation',
        );
        return `${publicKeyIdentity(output, 'derived SSH public key')} anycloud`;
      } catch (error) {
        throw new Error(
          `Failed to parse SSH private key: ${errorMessage(error)} (len=${keyLen}, header=${hasHeader}, footer=${hasFooter})`,
        );
      } finally {
        temporary?.remove();
      }
    });
  }

  /** Validate both key encodings and verify that they identify the same key. */
  static async validateKeypair(
    publicKey: string,
    privateKey: string,
  ): Promise<void> {
    if (!publicKey?.trim() || !privateKey?.trim()) {
      throw new Error('SSH keys cannot be empty');
    }
    const supplied = publicKeyIdentity(publicKey, 'SSH public key');
    const derived = publicKeyIdentity(
      await SSHManager.derivePublicKey(privateKey),
      'derived SSH public key',
    );
    if (supplied !== derived) {
      throw new Error('SSH public and private keys do not match');
    }
  }

  private masterDescriptor(): MasterDescriptor {
    const directory = ensureSshRuntimeDirectory();
    const key = createHash('sha256')
      .update(this.host)
      .update('\0')
      .update(String(this.port))
      .update('\0')
      .update(this.username)
      .update('\0')
      .update(this.privateKey)
      .update('\0')
      .update(this.purpose)
      .digest('hex')
      .slice(0, 32);
    return {
      key,
      controlPath: join(directory, `cm-${key}`),
      host: this.host,
      port: this.port,
      username: this.username,
    };
  }

  private commonSshArgs(): string[] {
    return [
      '-F',
      '/dev/null',
      '-T',
      '-p',
      String(this.port),
      '-l',
      this.username,
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=no',
      '-o',
      'UserKnownHostsFile=/dev/null',
      '-o',
      'GlobalKnownHostsFile=/dev/null',
      '-o',
      'LogLevel=ERROR',
      '-o',
      `ConnectTimeout=${SSH_CONNECT_TIMEOUT_SECONDS}`,
      '-o',
      'ConnectionAttempts=1',
      '-o',
      `ServerAliveInterval=${SSH_KEEPALIVE_SECONDS}`,
      '-o',
      `ServerAliveCountMax=${SSH_KEEPALIVE_COUNT}`,
      '-o',
      'PasswordAuthentication=no',
      '-o',
      'KbdInteractiveAuthentication=no',
      '-o',
      'PreferredAuthentications=publickey',
      '-o',
      'IdentityAgent=none',
    ];
  }

  private async masterIsAlive(master: MasterDescriptor): Promise<boolean> {
    try {
      const result = await runCapturedProcess(
        controlCommandArgs(master, 'check'),
        SSH_MASTER_CHECK_TIMEOUT_MS,
      );
      return result.code === 0;
    } catch (error) {
      if (
        error instanceof OpenSshUnavailableError ||
        error instanceof SshProcessError
      )
        throw error;
      return false;
    }
  }

  private async startMaster(
    master: MasterDescriptor,
  ): Promise<MasterDescriptor> {
    const known = SSHManager.masters.get(master.key);
    if (await this.masterIsAlive(master)) {
      // Preserve identity while the daemon is unchanged so an in-flight
      // client's failure can still invalidate its cached descriptor.
      const live = known ?? master;
      SSHManager.masters.set(master.key, live);
      return live;
    }
    unlinkIfPresent(master.controlPath);

    const identity = temporaryPrivateKey(this.privateKey);
    try {
      const result = await runCapturedProcess(
        [
          ...this.commonSshArgs(),
          '-M',
          '-N',
          '-f',
          '-S',
          master.controlPath,
          '-o',
          'ControlMaster=yes',
          '-o',
          `ControlPersist=${SSH_CONTROL_PERSIST_SECONDS}`,
          '-o',
          'IdentitiesOnly=yes',
          '-i',
          identity.path,
          '--',
          this.host,
        ],
        SSH_MASTER_START_TIMEOUT_MS,
      );
      if (result.code !== 0) {
        const detail = (result.stderr || result.stdout).trim().slice(-500);
        throw new Error(
          `OpenSSH master exited with code ${result.code}${detail ? `: ${detail}` : ''}`,
        );
      }
      if (!(await this.masterIsAlive(master))) {
        throw new Error(
          'OpenSSH master did not create a usable control socket',
        );
      }
      SSHManager.masters.set(master.key, master);
      return master;
    } catch (error) {
      SSHManager.masters.delete(master.key);
      unlinkIfPresent(master.controlPath);
      throw error;
    } finally {
      identity.remove();
    }
  }

  private async ensureMaster(reuseKnown = false): Promise<MasterDescriptor> {
    const master = this.masterDescriptor();
    const pending = SSHManager.pendingMasters.get(master.key);
    if (pending) return await pending;
    const known = SSHManager.masters.get(master.key);
    // Retry-eligible platform operations can discover a lost master through
    // their existing failure path instead of forking a preflight every time.
    if (reuseKnown && known) return known;

    const attempt = this.startMaster(master).finally(() => {
      if (SSHManager.pendingMasters.get(master.key) === attempt) {
        SSHManager.pendingMasters.delete(master.key);
      }
    });
    SSHManager.pendingMasters.set(master.key, attempt);
    return await attempt;
  }

  private async ensureMasterForSignal(
    signal?: AbortSignal,
    reuseKnown = false,
  ): Promise<MasterDescriptor> {
    if (!signal) return await this.ensureMaster(reuseKnown);
    if (signal.aborted) throw new Error('SSH command aborted');

    const master = this.ensureMaster(reuseKnown);
    return await new Promise<MasterDescriptor>((resolve, reject) => {
      const onAbort = () => {
        cleanup();
        reject(new Error('SSH command aborted'));
      };
      const cleanup = () => signal.removeEventListener('abort', onAbort);
      signal.addEventListener('abort', onAbort, { once: true });
      master.then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (error) => {
          cleanup();
          reject(error);
        },
      );
    });
  }

  private forgetMaster(master: MasterDescriptor): void {
    if (SSHManager.masters.get(master.key) === master) {
      SSHManager.masters.delete(master.key);
    }
  }

  private clientArgs(master: MasterDescriptor, command: string): string[] {
    return [
      ...this.commonSshArgs(),
      '-S',
      master.controlPath,
      '-o',
      'ControlMaster=no',
      '-o',
      'ControlPersist=no',
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'IdentityFile=none',
      // Never open a connection of our own. Without this, a master that dies
      // between the liveness probe and this connect sends OpenSSH down its
      // fallback path, where a keyless client reports `Permission denied` —
      // an authentication failure for what is really a lost socket. Refusing
      // the fallback also keeps a lost master from reaching the VM
      // unauthenticated. A stale socket can still produce a local diagnostic.
      '-o',
      'ProxyCommand=false',
      '--',
      this.host,
      command,
    ];
  }

  private acquireUserSession(): () => void {
    if (this.purpose !== 'user') return () => undefined;

    const { key } = this.masterDescriptor();
    const active = SSHManager.userSessions.get(key) ?? 0;
    if (active >= SSH_USER_SESSION_LIMIT) {
      throw new SSHUserSessionCapacityError();
    }
    SSHManager.userSessions.set(key, active + 1);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (SSHManager.userSessions.get(key) ?? 1) - 1;
      if (remaining <= 0) SSHManager.userSessions.delete(key);
      else SSHManager.userSessions.set(key, remaining);
    };
  }

  private async runRemoteProcess(
    command: string,
    options: RemoteProcessOptions = {},
  ): Promise<RemoteProcessResult> {
    const releaseSession = this.acquireUserSession();
    try {
      return await this.runAdmittedRemoteProcess(command, options);
    } finally {
      releaseSession();
    }
  }

  private async runAdmittedRemoteProcess(
    command: string,
    options: RemoteProcessOptions,
  ): Promise<RemoteProcessResult> {
    try {
      return await this.attemptRemoteProcess(command, options);
    } catch (error) {
      if (!(error instanceof SSHMasterUnreachableError)) throw error;
      // Losing a master between the liveness probe and the client's connect is
      // ordinary — `ControlPersist` can expire in that window. A caller's retry
      // budget governs how often their command may run, and this attempt did
      // not run it, so rebuild the master and spend an attempt they never lost.
      // Only callers that already re-run on failure opt in: a mute command cut
      // mid-flight reaches here too, and an exactly-once caller — `execStream`
      // has no retry budget at all — cannot absorb running it a second time.
      if (!options.rerunOnLostMaster) throw error;
      log.debug('Rebuilding SSH control master lost before the command ran', {
        host: this.host,
        command: command.slice(0, 100),
      });
      return await this.attemptRemoteProcess(command, options);
    }
  }

  private async attemptRemoteProcess(
    command: string,
    options: RemoteProcessOptions,
  ): Promise<RemoteProcessResult> {
    const master = await this.ensureMasterForSignal(
      options.signal,
      this.purpose === 'platform' && options.rerunOnLostMaster === true,
    );
    if (options.signal?.aborted) throw new Error('SSH command aborted');
    let stdout = '';
    let stderr = '';
    let stdoutTail = '';
    let stderrTail = '';
    let result;
    try {
      result = await runSshProcess(this.clientArgs(master, command), {
        stdin: options.stdin,
        signal: options.signal,
        deadlineAt:
          options.commandTimeoutMs === undefined
            ? undefined
            : performance.now() + options.commandTimeoutMs,
        onStdout: async (chunk) => {
          const text = chunk.toString();
          stdoutTail = appendTail(stdoutTail, text);
          if (options.collectOutput) stdout += text;
          await options.onStdout?.(chunk);
        },
        onStderr: async (chunk) => {
          const text = chunk.toString();
          stderrTail = appendTail(stderrTail, text);
          if (options.collectOutput) stderr += text;
          await options.onStderr?.(chunk);
        },
      });
    } catch (error) {
      if (error instanceof SshProcessTimeoutError) {
        throw new SSHExecError(
          `SSH command timed out after ${options.commandTimeoutMs}ms: ${command.slice(0, 50)}`,
          stdoutTail,
          stderrTail,
        );
      }
      throw missingOpenSshBinary(error) ?? error;
    }
    const { code, signal } = result;
    if (code === null) {
      this.forgetMaster(master);
      throw new SSHExecError(
        `SSH stream closed abnormally${signal ? ` (${signal})` : ''}`,
        stdoutTail,
        stderrTail,
      );
    }
    if (code === 255 && !(await this.masterIsAlive(master))) {
      this.forgetMaster(master);
      // Match only the exact local OpenSSH diagnostic; arbitrary remote output
      // cannot authorize a retry that the caller did not already permit.
      const refusedSocket =
        options.collectOutput &&
        stdout === '' &&
        stderr.trim() ===
          `Control socket connect(${master.controlPath.slice(0, 100)}): Connection refused`;
      throw stdoutTail === '' && (stderrTail === '' || refusedSocket)
        ? new SSHMasterUnreachableError()
        : new SSHExecError(
            'SSH stream closed abnormally before command completed',
            stdoutTail,
            stderrTail,
          );
    }
    return { code, stdout, stderr };
  }

  /** Execute a command with the existing caller-visible retry semantics. */
  async exec(
    command: string,
    maxAttempts = 4,
    exponentialBackoff = false,
    commandTimeoutMs?: number,
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    const result = await withRetry(
      () => this._execInternal(command, commandTimeoutMs),
      `SSH: ${command.slice(0, 50)}`,
      {
        maxAttempts,
        waitMs: 5_000,
        exponentialBackoff,
        onRetry: (attempt, max) =>
          log.info(`Retrying SSH command (${attempt}/${max})`, {
            host: this.host,
            command: command.slice(0, 100),
          }),
        shouldRetry: (error) => !(error instanceof SSHUserSessionCapacityError),
      },
    );

    if (result.code !== 0) {
      throw new Error(
        `Command exited with code ${result.code}: ${result.stderr || result.stdout}`,
      );
    }
    return result;
  }

  /** Atomically write bytes over channel stdin, never argv or environment. */
  async writeFile(
    path: string,
    content: string | Buffer,
    options: WriteFileOptions = {},
  ): Promise<void> {
    if (!path.startsWith('/') || path.endsWith('/') || /[\r\n\0]/.test(path)) {
      throw new Error('SSH writeFile requires an absolute file path');
    }

    const mode = formatFileMode(options.mode ?? 0o600, 'file mode');
    const directoryMode = formatFileMode(
      options.directoryMode ?? 0o700,
      'directory mode',
    );
    const directory = posixPath.dirname(path);
    const temporaryPath = `${path}.tmp.XXXXXX`;
    const payload = Buffer.isBuffer(content)
      ? Buffer.from(content)
      : Buffer.from(content, 'utf8');
    const command = [
      'umask 077',
      `install -d -m ${directoryMode} ${shellEscape(directory)}`,
      `tmp=$(mktemp ${shellEscape(temporaryPath)})`,
      `trap 'rm -f "$tmp"' EXIT HUP INT TERM`,
      `cat > "$tmp"`,
      `chmod ${mode} "$tmp"`,
      `mv -f -- "$tmp" ${shellEscape(path)}`,
      `trap - EXIT HUP INT TERM`,
    ].join(' && ');

    const result = await withRetry(
      () => this._execInternal(command, undefined, payload),
      `SSH file write: ${path}`,
      {
        maxAttempts: options.maxAttempts ?? 4,
        waitMs: 5_000,
        exponentialBackoff: false,
        onRetry: (attempt, max) =>
          log.info(`Retrying SSH file write (${attempt}/${max})`, {
            host: this.host,
            path,
            bytes: payload.length,
          }),
        shouldRetry: (error) => !(error instanceof SSHUserSessionCapacityError),
      },
    );

    if (result.code !== 0) {
      throw new Error(`Remote file write exited with code ${result.code}`);
    }
  }

  /** Stream stdout/stderr and resolve non-zero remote exits as their code. */
  async execStream(
    command: string,
    options: ExecStreamOptions = {},
  ): Promise<number> {
    const result = await this.runRemoteProcess(command, options);
    return result.code;
  }

  /** One command attempt; retained for focused tests and retry composition. */
  async _execInternal(
    command: string,
    commandTimeoutMs?: number,
    stdin?: Buffer,
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    const result = await this.runRemoteProcess(command, {
      commandTimeoutMs,
      stdin,
      collectOutput: true,
      // `exec` and `writeFile` are the callers here, and both wrap this in
      // `withRetry`: re-running a command whose transport was lost is already
      // inside what they accept.
      rerunOnLostMaster: true,
    });
    if (TRANSIENT_EXIT_CODES.has(result.code)) {
      throw new SSHExecError(
        `Command exited with code ${result.code}`,
        result.stdout.slice(-2_000),
        result.stderr.slice(-2_000),
      );
    }
    return result;
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.exec('echo ok', 1)).code === 0;
    } catch (error) {
      log.debug('SSH ping failed', { error, host: this.host });
      return false;
    }
  }

  /** Kernel-level TCP reachability probe used during VM boot. */
  async portReachable(timeoutMs = 5_000): Promise<boolean> {
    return await new Promise((resolve) => {
      const socket = new net.Socket();
      const done = (result: boolean) => {
        socket.destroy();
        resolve(result);
      };
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
      socket.connect(this.port, this.host);
    });
  }

  /**
   * Shut down every master targeting a terminated VM, resolving only once each
   * one's control socket is gone.
   *
   * Awaiting matters because a command client carries no key (`clientArgs`):
   * if a caller starts one while a master is still mid-exit, OpenSSH falls back
   * to a fresh keyless connection and reports a permission failure. Callers
   * that genuinely do not care can `void` the result.
   */
  static async closeConnection(
    host: string,
    port: number,
    username = 'root',
  ): Promise<void> {
    const matches = (master: MasterDescriptor) =>
      master.host === host &&
      master.port === port &&
      master.username === username;

    const closing: Array<Promise<void>> = [];
    for (const master of SSHManager.masters.values()) {
      if (matches(master)) closing.push(SSHManager.closeMaster(master));
    }
    // A master still being started is one this call is also responsible for,
    // so resolving before it exists would leave the endpoint connected.
    for (const pending of SSHManager.pendingMasters.values()) {
      closing.push(
        pending
          .then(async (master) => {
            if (matches(master)) await SSHManager.closeMaster(master);
          })
          .catch(() => undefined),
      );
    }
    await Promise.all(closing);
  }

  private static async closeMaster(master: MasterDescriptor): Promise<void> {
    if (SSHManager.masters.get(master.key) !== master) {
      return;
    }
    SSHManager.masters.delete(master.key);
    try {
      await runSshProcess(controlCommandArgs(master, 'exit'), {
        ignoreStdin: true,
        deadlineAt: performance.now() + SSH_MASTER_CHECK_TIMEOUT_MS,
      }).catch(() => undefined);
    } finally {
      try {
        unlinkIfPresent(master.controlPath);
      } catch {
        // The private runtime directory disappears with the API container.
      }
    }
  }
}

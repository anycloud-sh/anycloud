/** Options for streaming a command over a VM transport. */
export interface ExecStreamOptions {
  /**
   * Aborting terminates the local OpenSSH client. Commands wrapped by
   * `channelBoundCommand` stop when the channel closes; a silent bare command
   * may remain alive on the VM because sshd does not own its process lifecycle.
   */
  signal?: AbortSignal;
  commandTimeoutMs?: number;
  onStdout?: (chunk: Buffer) => void | Promise<void>;
  onStderr?: (chunk: Buffer) => void | Promise<void>;
}

export interface WriteFileOptions {
  mode?: number;
  directoryMode?: number;
  maxAttempts?: number;
}

/** Provider-neutral per-VM command surface. */
export interface VmTransport {
  exec(
    command: string,
    maxAttempts?: number,
    exponentialBackoff?: boolean,
    commandTimeoutMs?: number,
  ): Promise<{ stdout: string; stderr: string; code: number }>;
  execStream(command: string, options?: ExecStreamOptions): Promise<number>;
  /**
   * Write bytes without putting their contents in the remote command. The
   * production SSH transport sends the payload over channel stdin.
   */
  writeFile(
    path: string,
    content: string | Buffer,
    options?: WriteFileOptions,
  ): Promise<void>;
  ping(): Promise<boolean>;
  /**
   * Kernel-level TCP reachability probe of the transport's port. Costs the
   * remote host nothing — the handshake completes in the listener's backlog
   * before userspace wakes — so it is safe to spin on during boot, unlike
   * ping(), whose authenticated exec spawns a full session per attempt.
   * Optional: fake transports omit it and callers fall through to exec.
   */
  portReachable?(timeoutMs?: number): Promise<boolean>;
}

import { SSHManager } from './ssh.js';

/**
 * Host bootstrap needs remote exit codes as data (a booting host answers with
 * a protocol code until it is prepared) and must tell a transport failure from
 * a command that ran. `VmTransport.exec` throws on any non-zero exit, so this
 * narrower surface exposes the single-attempt run instead.
 */
export interface HostCommandTransport {
  /** One remote run; resolves with the remote exit code, throws only when the transport failed. */
  runCommand(
    command: string,
    commandTimeoutMs: number,
  ): Promise<{ stdout: string; stderr: string; code: number }>;
  portReachable(timeoutMs?: number): Promise<boolean>;
  /** Atomic write over channel stdin; the content is never part of argv. */
  writeFile(path: string, content: string, mode: number): Promise<void>;
}

export function createHostCommandTransport(
  host: string,
  privateKey: string,
  port?: number,
  username?: string,
): HostCommandTransport {
  const ssh = new SSHManager(host, privateKey, port, username);
  return {
    runCommand: (command, commandTimeoutMs) =>
      ssh._execInternal(command, commandTimeoutMs),
    portReachable: (timeoutMs) => ssh.portReachable(timeoutMs),
    writeFile: (path, content, mode) =>
      ssh.writeFile(path, content, { mode, directoryMode: 0o700 }),
  };
}

import { spawn } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { type WorkloadSshAccessResponse as SshAccessResponse } from '../../shared/api-contract/workload-management-schemas.js';

export interface RunLocalSshOptions {
  tty?: boolean;
}

export async function runLocalSsh(
  access: SshAccessResponse,
  command?: string,
  options: RunLocalSshOptions = {},
): Promise<number> {
  const keyFile = join(
    tmpdir(),
    `anycloud-ssh-${access.workloadId}-${Date.now()}`,
  );
  writeFileSync(keyFile, access.sshPrivateKey, { mode: 0o600 });

  const cleanup = () => {
    try {
      unlinkSync(keyFile);
    } catch {
      // Best effort: the process is ending or the file was already removed.
    }
  };

  const sshArgs = [
    '-i',
    keyFile,
    '-p',
    String(access.sshPort ?? 22),
    '-o',
    'StrictHostKeyChecking=no',
    '-o',
    'UserKnownHostsFile=/dev/null',
    '-o',
    'LogLevel=ERROR',
    '-o',
    'ConnectTimeout=30',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
  ];

  if (options.tty ?? true) {
    sshArgs.push('-t');
  }

  sshArgs.push(
    `${access.sshUsername ?? 'root'}@${access.sshHost ?? access.vmIp}`,
  );

  if (command) sshArgs.push(command);

  return await new Promise<number>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    const ssh = spawn('ssh', sshArgs, { stdio: 'inherit' });
    ssh.on('close', (code) => settle(() => resolve(code ?? 1)));
    ssh.on('error', (error) => settle(() => reject(error)));
  });
}

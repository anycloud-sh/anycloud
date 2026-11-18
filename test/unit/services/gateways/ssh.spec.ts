import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import config from '../../../../src/api/config';
import * as sshProcesses from '../../../../src/api/services/gateways/ssh-process.js';
import {
  SSHExecError,
  SSHManager,
  SSHMasterUnreachableError,
  SSHUserSessionCapacityError,
  sshRuntimeDirectory,
} from '../../../../src/api/services/gateways/ssh';
import {
  decryptSecret,
  encryptSecret,
} from '../../../../src/api/services/secret-crypto.js';
import { log } from '../../../../src/api/services/logger';

vi.mock('../../../../src/api/services/logger', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../../../src/api/config', () => ({
  default: {
    cipherKey: '',
    sshPort: 2222,
    sshRuntimeDirectory: join(tmpdir(), 'anycloud-ssh-unit'),
    sshRuntimeRequiresTmpfs: false,
  },
}));

const LEGACY_PUBLIC_KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIC1iOUWHzKgHsA2llMZaijbjwbbNpH9TGvkMvOgM4Kjf anycloud';
const LEGACY_PRIVATE_KEY = [
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtz',
  'c2gtZWQyNTUxOQAAACAtYjlFh8yoB7ANpZTGWoo248G2zaR/Uxr5DLzoDOCo3wAA',
  'AJDOQi1HzkItRwAAAAtzc2gtZWQyNTUxOQAAACAtYjlFh8yoB7ANpZTGWoo248G2',
  'zaR/Uxr5DLzoDOCo3wAAAECkmQ3ECsb+MLbjZhAL3GdmMlLYV+UMqgLrIa44zL/J',
  'mi1iOUWHzKgHsA2llMZaijbjwbbNpH9TGvkMvOgM4KjfAAAACGFueWNsb3VkAQID',
  'BAU=',
  '-----END OPENSSH PRIVATE KEY-----',
  '',
].join('\n');

const MALFORMED_LEGACY_PRIVATE_KEY = [
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMgAAAAtz',
  'c2gtZWQyNTUxOQAAAB8+tlYz4adsW9gS1AX7zfXU5/yjB6+J1xDx0FYoUpEbAAAA',
  'kFrjY2pa42NqAAAAC3NzaC1lZDI1NTE5AAAAHz62VjPhp2xb2BLUBfvN9dTn/KMH',
  'r4nXEPHQVihSkRsAAAA/cSROTpU7DAQZI8JBZKt60j+/pRR2n+9ZD7xjeJOTWxQ+',
  'tlYz4adsW9gS1AX7zfXU5/yjB6+J1xDx0FYoUpEbAAAACGFueWNsb3VkAQIDBAUG',
  'Bw==',
  '-----END OPENSSH PRIVATE KEY-----',
  '',
].join('\n');

function createMockSSH(): SSHManager {
  return new SSHManager('1.2.3.4', 'mock-key');
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('SSHManager key handling', () => {
  it('generates unique OpenSSH ED25519 keypairs and removes transient files', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'anycloud-keygen-'));
    try {
      const [first, second] = await Promise.all([
        SSHManager.generateKeypair(directory),
        SSHManager.generateKeypair(directory),
      ]);

      expect(first.publicKey).toMatch(
        /^ssh-ed25519 [A-Za-z0-9+/]+=* anycloud$/,
      );
      expect(first.privateKey).toContain('-----BEGIN OPENSSH PRIVATE KEY-----');
      expect(first.privateKey).toContain('-----END OPENSSH PRIVATE KEY-----');
      expect(first.publicKey).not.toBe(second.publicKey);
      expect(first.privateKey).not.toBe(second.privateKey);
      expect(readdirSync(directory)).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('derives the same public key for a sample of generated keys', async () => {
    for (let sample = 0; sample < 32; sample++) {
      const keypair = await SSHManager.generateKeypair();
      expect(await SSHManager.derivePublicKey(keypair.privateKey)).toBe(
        keypair.publicKey,
      );
    }
  });

  it('derives a public key from the legacy stored OpenSSH format', async () => {
    expect(await SSHManager.derivePublicKey(LEGACY_PRIVATE_KEY)).toBe(
      LEGACY_PUBLIC_KEY,
    );
  });

  it('preserves public-key output larger than the SSH diagnostic tail', async () => {
    const publicKey = `ssh-rsa ${Buffer.alloc(3072, 1).toString('base64')} anycloud`;
    vi.spyOn(sshProcesses, 'runSshProcess').mockImplementation(
      async (_args, options) => {
        expect(options?.binary).toBe('ssh-keygen');
        await options?.onStdout?.(Buffer.from(publicKey + '\n'));
        return { code: 0, signal: null };
      },
    );
    expect(await SSHManager.derivePublicKey(LEGACY_PRIVATE_KEY)).toBe(
      publicKey,
    );
  });

  it('survives the encrypted database round trip', async () => {
    config.cipherKey = randomBytes(32).toString('hex');
    const keypair = await SSHManager.generateKeypair();

    const encrypted = await encryptSecret(keypair.privateKey);
    const decrypted = await decryptSecret(encrypted);

    expect(decrypted).toBe(keypair.privateKey);
    expect(await SSHManager.derivePublicKey(decrypted)).toBe(keypair.publicKey);
  });

  it('deletes a transient identity after public-key derivation', async () => {
    const runtimeDirectory = sshRuntimeDirectory();
    const before = existsSync(runtimeDirectory)
      ? readdirSync(runtimeDirectory).filter((name) =>
          name.startsWith('identity-'),
        )
      : [];

    await SSHManager.derivePublicKey(LEGACY_PRIVATE_KEY);

    const after = readdirSync(runtimeDirectory).filter((name) =>
      name.startsWith('identity-'),
    );
    expect(after).toEqual(before);
  });

  it('rejects invalid, truncated, corrupt, and malformed legacy keys', async () => {
    const runtimeDirectory = sshRuntimeDirectory();
    const identitiesBefore = existsSync(runtimeDirectory)
      ? readdirSync(runtimeDirectory).filter((name) =>
          name.startsWith('identity-'),
        )
      : [];
    const truncated = [
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'AAAA',
      '-----END OPENSSH PRIVATE KEY-----',
    ].join('\n');
    const corrupted =
      LEGACY_PRIVATE_KEY.slice(0, 50) +
      'CORRUPTED' +
      LEGACY_PRIVATE_KEY.slice(59);

    await expect(SSHManager.derivePublicKey('not-a-key')).rejects.toThrow(
      /Failed to parse SSH private key:.*len=9.*header=false.*footer=false/,
    );
    await expect(SSHManager.derivePublicKey(truncated)).rejects.toThrow(
      /Failed to parse SSH private key:.*header=true.*footer=true/,
    );
    await expect(SSHManager.derivePublicKey(corrupted)).rejects.toThrow(
      /Failed to parse SSH private key:.*header=true/,
    );
    await expect(
      SSHManager.derivePublicKey(MALFORMED_LEGACY_PRIVATE_KEY),
    ).rejects.toThrow(/Failed to parse SSH private key/);
    expect(
      readdirSync(runtimeDirectory).filter((name) =>
        name.startsWith('identity-'),
      ),
    ).toEqual(identitiesBefore);
  });

  it('derives the public key from a stored private key that lost its trailing newline', async () => {
    // What the installation store used to do: `.trim()` drops the newline
    // after the END marker and OpenSSH answers "Load key: error in libcrypto"
    // (found by F run 2). The file writer restores it before ssh-keygen -y.
    const { publicKey, privateKey } = await SSHManager.generateKeypair();
    expect(privateKey.endsWith('-----END OPENSSH PRIVATE KEY-----\n')).toBe(
      true,
    );
    await expect(SSHManager.derivePublicKey(privateKey.trim())).resolves.toBe(
      publicKey,
    );
  });

  it('validates key identity, not comments alone', async () => {
    const first = await SSHManager.generateKeypair();
    const second = await SSHManager.generateKeypair();
    const publicWithoutComment = first.publicKey
      .split(' ')
      .slice(0, 2)
      .join(' ');

    await expect(
      SSHManager.validateKeypair(publicWithoutComment, first.privateKey),
    ).resolves.toBeUndefined();
    await expect(
      SSHManager.validateKeypair(second.publicKey, first.privateKey),
    ).rejects.toThrow('SSH public and private keys do not match');
    await expect(
      SSHManager.validateKeypair('', first.privateKey),
    ).rejects.toThrow('SSH keys cannot be empty');
    await expect(
      SSHManager.validateKeypair('not-a-public-key', first.privateKey),
    ).rejects.toThrow('Invalid SSH public key format');
  });
});

describe('SSHManager command semantics', () => {
  it('propagates a queued check failure without treating the master as dead', async () => {
    const error = new sshProcesses.SshLaunchError('SSH launch queue is full');
    const start = vi
      .spyOn(sshProcesses, 'runSshProcess')
      .mockRejectedValue(error);
    await expect(createMockSSH().exec('printf must-not-run', 1)).rejects.toBe(
      error,
    );
    // A false liveness result would try to bootstrap another master.
    expect(start).toHaveBeenCalledOnce();
  });

  it('preserves the configured default SSH port', () => {
    const ssh = createMockSSH() as unknown as {
      masterDescriptor: () => { port: number };
    };
    expect(ssh.masterDescriptor().port).toBe(2222);
  });

  it('returns a successful first attempt', async () => {
    const ssh = createMockSSH();
    const internal = vi.spyOn(ssh, '_execInternal').mockResolvedValue({
      code: 0,
      stdout: 'ok',
      stderr: '',
    });

    await expect(ssh.exec('echo ok')).resolves.toEqual({
      code: 0,
      stdout: 'ok',
      stderr: '',
    });
    expect(internal).toHaveBeenCalledOnce();
  });

  it('retries transport and transient remote failures', async () => {
    vi.useFakeTimers();
    const ssh = createMockSSH();
    const internal = vi
      .spyOn(ssh, '_execInternal')
      .mockRejectedValueOnce(new Error('SSH connection failed'))
      .mockRejectedValueOnce(
        new SSHExecError('Command exited with code 100', '', 'apt lock'),
      )
      .mockResolvedValueOnce({ code: 0, stdout: 'ok', stderr: '' });

    const result = ssh.exec('apt-get update', 3);
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(result).resolves.toMatchObject({ code: 0, stdout: 'ok' });
    expect(internal).toHaveBeenCalledTimes(3);
  });

  it('stops after the requested retry budget', async () => {
    vi.useFakeTimers();
    const ssh = createMockSSH();
    const internal = vi
      .spyOn(ssh, '_execInternal')
      .mockRejectedValue(new Error('SSH connection failed'));

    const result = ssh.exec('echo ok', 2).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(result).resolves.toMatchObject({
      message: 'SSH connection failed',
    });
    expect(internal).toHaveBeenCalledTimes(2);
  });

  it('does not retry a completed nonzero command', async () => {
    const ssh = createMockSSH();
    const internal = vi.spyOn(ssh, '_execInternal').mockResolvedValue({
      code: 1,
      stdout: '',
      stderr: 'command failed',
    });

    await expect(ssh.exec('false')).rejects.toThrow(
      'Command exited with code 1: command failed',
    );
    expect(internal).toHaveBeenCalledOnce();
  });

  it('does not retry a user-session capacity error', async () => {
    const ssh = createMockSSH();
    const internal = vi
      .spyOn(ssh, '_execInternal')
      .mockRejectedValue(new SSHUserSessionCapacityError());

    await expect(ssh.exec('echo never-runs')).rejects.toMatchObject({
      name: 'SSHUserSessionCapacityError',
      code: 'SSH_USER_SESSION_CAPACITY',
    });
    expect(internal).toHaveBeenCalledOnce();
  });

  it('refuses the keyless fallback on command clients but not on masters', () => {
    const ssh = createMockSSH() as unknown as {
      clientArgs: (
        master: { controlPath: string },
        command: string,
      ) => string[];
      commonSshArgs: () => string[];
    };

    // A client that falls back opens an unauthenticated connection to the VM
    // and reports the loss as `Permission denied`. The master must keep the
    // fallback, since establishing the connection is its whole job.
    expect(ssh.clientArgs({ controlPath: '/tmp/cm-x' }, 'echo ok')).toContain(
      'ProxyCommand=false',
    );
    expect(ssh.commonSshArgs()).not.toContain('ProxyCommand=false');
  });

  it('reruns a command whose control master closed before it started', async () => {
    const ssh = createMockSSH();
    const transport = ssh as unknown as {
      attemptRemoteProcess: () => Promise<{
        code: number;
        stdout: string;
        stderr: string;
      }>;
    };
    const attempt = vi
      .spyOn(transport, 'attemptRemoteProcess')
      .mockRejectedValueOnce(new SSHMasterUnreachableError())
      .mockResolvedValueOnce({ code: 0, stdout: 'ok', stderr: '' });

    // maxAttempts 1: the caller forbade running their command twice, and the
    // lost attempt never ran it, so the rebuild is not theirs to pay for.
    await expect(ssh.exec('echo ok', 1)).resolves.toMatchObject({
      code: 0,
      stdout: 'ok',
    });
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('does not rerun a command cut off after its session existed', async () => {
    const ssh = createMockSSH();
    const transport = ssh as unknown as {
      attemptRemoteProcess: () => Promise<never>;
    };
    const attempt = vi
      .spyOn(transport, 'attemptRemoteProcess')
      .mockRejectedValue(
        new SSHExecError(
          'SSH stream closed abnormally before command completed',
          'partial output',
          '',
        ),
      );

    // Output proves the session existed, so the command may already have run.
    await expect(ssh.exec('docker run -d image', 1)).rejects.toThrow(
      'SSH stream closed abnormally before command completed',
    );
    expect(attempt).toHaveBeenCalledOnce();
  });

  it('rebuilds the control master at most once per attempt', async () => {
    const ssh = createMockSSH();
    const transport = ssh as unknown as {
      attemptRemoteProcess: () => Promise<never>;
    };
    const attempt = vi
      .spyOn(transport, 'attemptRemoteProcess')
      .mockRejectedValue(new SSHMasterUnreachableError());

    await expect(ssh.exec('echo ok', 1)).rejects.toMatchObject({
      name: 'SSHMasterUnreachableError',
    });
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('does not rerun a streamed command whose control master was lost', async () => {
    const ssh = createMockSSH();
    const transport = ssh as unknown as {
      attemptRemoteProcess: () => Promise<never>;
    };
    const attempt = vi
      .spyOn(transport, 'attemptRemoteProcess')
      .mockRejectedValue(new SSHMasterUnreachableError());

    // `execStream` has no retry budget, so its callers run a user's command
    // exactly once. A mute command cut mid-flight arrives here as a lost
    // master, and rerunning that would run the command twice.
    await expect(
      ssh.execStream('docker exec -i app place-order'),
    ).rejects.toMatchObject({ name: 'SSHMasterUnreachableError' });
    expect(attempt).toHaveBeenCalledOnce();
  });

  it('classifies the documented transient exit codes for retry', async () => {
    const ssh = createMockSSH();
    const transport = ssh as unknown as {
      runRemoteProcess: () => Promise<{
        code: number;
        stdout: string;
        stderr: string;
      }>;
    };

    for (const code of [2, 7, 100]) {
      vi.spyOn(transport, 'runRemoteProcess').mockResolvedValueOnce({
        code,
        stdout: 'stdout tail',
        stderr: 'stderr tail',
      });
      await expect(ssh._execInternal('transient')).rejects.toMatchObject({
        message: 'Command exited with code ' + code,
        stdout: 'stdout tail',
        stderr: 'stderr tail',
      });
    }
  });
});

describe('SSHManager.writeFile', () => {
  it('sends bytes over stdin and keeps them out of argv and logs', async () => {
    const ssh = createMockSSH();
    const content = 'GITHUB_TOKEN=' + 'a'.repeat(40);
    const encoded = Buffer.from(content).toString('base64');
    const internal = vi.spyOn(ssh, '_execInternal').mockResolvedValue({
      code: 0,
      stdout: '',
      stderr: '',
    });

    await ssh.writeFile('/run/anycloud-secrets/env', content, {
      maxAttempts: 1,
    });

    const [command, timeout, payload] = internal.mock.calls[0];
    expect(command).toContain('cat > "$tmp"');
    expect(command).toContain('chmod 0600 "$tmp"');
    expect(command).toContain("'/run/anycloud-secrets/env'");
    expect(command).not.toContain(content);
    expect(command).not.toContain(encoded);
    expect(timeout).toBeUndefined();
    expect(payload).toEqual(Buffer.from(content));

    const logged = JSON.stringify([
      ...vi.mocked(log.debug).mock.calls,
      ...vi.mocked(log.info).mock.calls,
      ...vi.mocked(log.warn).mock.calls,
      ...vi.mocked(log.error).mock.calls,
    ]);
    expect(logged).not.toContain(content);
    expect(logged).not.toContain(encoded);
  });

  it('reuses the stdin payload on retry without logging it', async () => {
    vi.useFakeTimers();
    const ssh = createMockSSH();
    const content = 'GITHUB_TOKEN=' + 'b'.repeat(40);
    const internal = vi
      .spyOn(ssh, '_execInternal')
      .mockRejectedValueOnce(new Error('SSH connection failed'))
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' });

    const result = ssh.writeFile('/run/anycloud-secrets/env', content, {
      maxAttempts: 2,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(result).resolves.toBeUndefined();

    expect(internal).toHaveBeenCalledTimes(2);
    for (const call of internal.mock.calls) {
      expect(call[2]).toEqual(Buffer.from(content));
    }
  });

  it('does not include remote output in a write failure', async () => {
    const ssh = createMockSSH();
    vi.spyOn(ssh, '_execInternal').mockResolvedValue({
      code: 1,
      stdout: 'GITHUB_TOKEN=secret',
      stderr: 'c2VjcmV0',
    });

    await expect(
      ssh.writeFile('/run/anycloud-secrets/env', 'secret', {
        maxAttempts: 1,
      }),
    ).rejects.toThrow('Remote file write exited with code 1');
  });

  it('does not retry a capacity-limited file write', async () => {
    const ssh = createMockSSH();
    const internal = vi
      .spyOn(ssh, '_execInternal')
      .mockRejectedValue(new SSHUserSessionCapacityError());

    await expect(
      ssh.writeFile('/tmp/capacity', 'never-written'),
    ).rejects.toMatchObject({ code: 'SSH_USER_SESSION_CAPACITY' });
    expect(internal).toHaveBeenCalledOnce();
  });

  it('rejects unsafe paths and invalid modes before connecting', async () => {
    const ssh = createMockSSH();
    const internal = vi.spyOn(ssh, '_execInternal');

    await expect(ssh.writeFile('relative', 'value')).rejects.toThrow(
      'SSH writeFile requires an absolute file path',
    );
    await expect(ssh.writeFile('/tmp/', 'value')).rejects.toThrow(
      'SSH writeFile requires an absolute file path',
    );
    await expect(
      ssh.writeFile('/tmp/file', 'value', { mode: 0o1000 }),
    ).rejects.toThrow('Invalid file mode');
    await expect(
      ssh.writeFile('/tmp/file', 'value', { directoryMode: -1 }),
    ).rejects.toThrow('Invalid directory mode');
    expect(internal).not.toHaveBeenCalled();
  });
});

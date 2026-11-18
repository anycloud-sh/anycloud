import { existsSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const observed = vi.hoisted(() => ({
  contents: '',
  mode: 0,
  path: '',
}));

vi.mock(
  '../../../../src/api/services/gateways/ssh-process.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../../../src/api/services/gateways/ssh-process.js')
      >();
    return {
      ...actual,
      runSshProcess: vi.fn(
        async (
          args: string[],
          options: Parameters<typeof actual.runSshProcess>[1],
        ) => {
          const flagIndex = args.indexOf('-f');
          const keyPath = args[flagIndex + 1];
          observed.path = keyPath;
          observed.contents = readFileSync(keyPath, 'utf8');
          observed.mode = statSync(keyPath).mode & 0o777;
          await options?.onStdout?.(
            Buffer.from(
              'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestOnly anycloud\n',
            ),
          );
          return { code: 0, signal: null };
        },
      ),
    };
  },
);

import {
  privateKeyFileContent,
  SSHManager,
} from '../../../../src/api/services/gateways/ssh';

describe('OpenSSH private-key files', () => {
  it('uses mode 0600 and deletes the identity after ssh-keygen exits', async () => {
    const privateKey = [
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'test-only-sensitive-material',
      '-----END OPENSSH PRIVATE KEY-----',
      '',
    ].join('\n');

    expect(await SSHManager.derivePublicKey(privateKey)).toBe(
      'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestOnly anycloud',
    );
    expect(observed.contents).toBe(privateKey);
    expect(observed.mode).toBe(0o600);
    expect(existsSync(observed.path)).toBe(false);
  });

  it('writes the key OpenSSH can load even when storage trimmed the final newline or added CRLF', async () => {
    // A key stored through `.trim()` lost the newline after its END marker;
    // OpenSSH answers "Load key: error in libcrypto" for that file.
    const trimmed =
      '-----BEGIN OPENSSH PRIVATE KEY-----\nmaterial\n-----END OPENSSH PRIVATE KEY-----';
    await SSHManager.derivePublicKey(trimmed);
    expect(observed.contents).toBe(`${trimmed}\n`);
    expect(
      privateKeyFileContent(
        '-----BEGIN OPENSSH PRIVATE KEY-----\r\nmaterial\r\n-----END OPENSSH PRIVATE KEY-----\r\n\r\n',
      ),
    ).toBe(`${trimmed}\n`);
    expect(privateKeyFileContent(`${trimmed}\n`)).toBe(`${trimmed}\n`);
  });
});

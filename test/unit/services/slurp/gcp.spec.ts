import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { homedir } from 'os';
import { join } from 'path';
import {
  getGCloudDir,
  getADCPath,
  getAllServiceAccountKeyPaths,
  getGCloudInstallCommand,
} from '../../../../src/cli/services/slurp/gcp';
import {
  readServiceAccountKey,
  readServiceAccountKeySummary,
  extractGCPCredentials,
  type GCPServiceAccountKey,
} from '../../../../src/cli/services/credential-onboarding/gcp-key-files';
// Mock fs/promises
vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  mkdir: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
  chmod: vi.fn(),
  copyFile: vi.fn(),
  access: vi.fn(),
  mkdtemp: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn(),
}));

import { readFile, readdir, stat } from 'fs/promises';
import type { Stats } from 'fs';

function fakeStat(mtime: Date): Stats {
  const stub = { mtime };
  return stub as unknown as Stats;
}

describe('GCP Slurp Functions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clear environment variables
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    delete process.env.APPDATA;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe('getGCloudInstallCommand', () => {
    it.each([
      ['linux', 'curl https://sdk.cloud.google.com | bash'],
      ['darwin', 'curl https://sdk.cloud.google.com | bash'],
      ['win32', 'https://cloud.google.com/sdk/docs/install'],
    ])('on %s prints a sudo-free hint: %s', (platform, expected) => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: platform });
      try {
        expect(getGCloudInstallCommand()).toBe(expected);
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform });
      }
    });
  });

  describe('getGCloudDir', () => {
    it('should return gcloud config directory on Unix-like systems', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin' });

      const result = getGCloudDir();

      expect(result).toBe(join(homedir(), '.config', 'gcloud'));

      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });

    it('should return gcloud config directory on Windows', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32' });
      process.env.APPDATA = 'C:\\Users\\TestUser\\AppData\\Roaming';

      const result = getGCloudDir();

      expect(result).toBe(
        join('C:\\Users\\TestUser\\AppData\\Roaming', 'gcloud'),
      );

      Object.defineProperty(process, 'platform', { value: originalPlatform });
      delete process.env.APPDATA;
    });

    it('should fallback to homedir on Windows without APPDATA', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32' });

      const result = getGCloudDir();

      expect(result).toBe(join(homedir(), '.config', 'gcloud'));

      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });
  });

  describe('getADCPath', () => {
    it('should return GOOGLE_APPLICATION_CREDENTIALS env var if set', () => {
      process.env.GOOGLE_APPLICATION_CREDENTIALS = '/custom/path/to/key.json';

      const result = getADCPath();

      expect(result).toBe('/custom/path/to/key.json');
    });

    it('should return default ADC path if env var not set', () => {
      const result = getADCPath();

      expect(result).toBe(
        join(getGCloudDir(), 'application_default_credentials.json'),
      );
    });

    it('should expand a home-relative GOOGLE_APPLICATION_CREDENTIALS path', () => {
      process.env.GOOGLE_APPLICATION_CREDENTIALS = '~/keys/gcp.json';

      expect(getADCPath()).toBe(join(homedir(), 'keys', 'gcp.json'));
    });
  });

  describe('getAllServiceAccountKeyPaths', () => {
    it('should return empty array when no keys exist', async () => {
      vi.mocked(stat).mockRejectedValue(new Error('File not found'));
      vi.mocked(readdir).mockRejectedValue(new Error('Directory not found'));

      const result = await getAllServiceAccountKeyPaths();

      expect(result).toEqual([]);
    });

    it('should return ADC path when it exists', async () => {
      const adcPath = getADCPath();
      vi.mocked(stat).mockResolvedValueOnce(fakeStat(new Date('2025-01-15')));
      vi.mocked(readdir).mockRejectedValue(new Error('Directory not found'));

      const result = await getAllServiceAccountKeyPaths();

      expect(result).toEqual([adcPath]);
    });

    it('should return anycloud keys when they exist', async () => {
      vi.mocked(stat)
        .mockRejectedValueOnce(new Error('ADC not found')) // ADC doesn't exist
        .mockResolvedValueOnce(fakeStat(new Date('2025-01-15'))) // anycloud-test1-key.json
        .mockResolvedValueOnce(fakeStat(new Date('2025-01-16'))); // anycloud-test2-key.json

      vi.mocked(readdir).mockResolvedValue([
        'anycloud-test1-key.json',
        'anycloud-test2-key.json',
        'other-file.txt',
      ] as any);

      const result = await getAllServiceAccountKeyPaths();

      expect(result).toHaveLength(2);
      // Should be sorted by mtime, most recent first
      expect(result[0]).toContain('anycloud-test2-key.json');
      expect(result[1]).toContain('anycloud-test1-key.json');
    });

    it('should return both ADC and anycloud keys sorted by mtime', async () => {
      const adcPath = getADCPath();
      vi.mocked(stat)
        .mockResolvedValueOnce(fakeStat(new Date('2025-01-14'))) // ADC (oldest)
        .mockResolvedValueOnce(fakeStat(new Date('2025-01-16'))) // anycloud-test1 (newest)
        .mockResolvedValueOnce(fakeStat(new Date('2025-01-15'))); // anycloud-test2 (middle)

      vi.mocked(readdir).mockResolvedValue([
        'anycloud-test1-key.json',
        'anycloud-test2-key.json',
      ] as any);

      const result = await getAllServiceAccountKeyPaths();

      expect(result).toHaveLength(3);
      expect(result[0]).toContain('anycloud-test1-key.json'); // newest
      expect(result[1]).toContain('anycloud-test2-key.json'); // middle
      expect(result[2]).toBe(adcPath); // oldest
    });

    it('should skip anycloud keys that cannot be read', async () => {
      vi.mocked(stat)
        .mockRejectedValueOnce(new Error('ADC not found'))
        .mockResolvedValueOnce(fakeStat(new Date('2025-01-15')))
        .mockRejectedValueOnce(new Error('Permission denied'));

      vi.mocked(readdir).mockResolvedValue([
        'anycloud-test1-key.json',
        'anycloud-test2-key.json',
      ] as any);

      const result = await getAllServiceAccountKeyPaths();

      expect(result).toHaveLength(1);
      expect(result[0]).toContain('anycloud-test1-key.json');
    });

    it('should de-duplicate a configured key that is also in the anycloud directory', async () => {
      process.env.GOOGLE_APPLICATION_CREDENTIALS =
        '~/.anycloud/anycloud-test-key.json';
      vi.mocked(stat).mockResolvedValue(fakeStat(new Date('2025-01-15')));
      vi.mocked(readdir).mockResolvedValue(['anycloud-test-key.json'] as any);

      const result = await getAllServiceAccountKeyPaths();

      expect(result).toEqual([
        join(homedir(), '.anycloud', 'anycloud-test-key.json'),
      ]);
      expect(stat).toHaveBeenCalledOnce();
    });
  });

  describe('readServiceAccountKey', () => {
    const validKey: GCPServiceAccountKey = {
      type: 'service_account',
      project_id: 'test-project',
      private_key_id: 'key-id',
      private_key:
        '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----',
      client_email: 'test@test-project.iam.gserviceaccount.com',
      client_id: '123456',
      auth_uri: 'https://accounts.google.com/o/oauth2/auth',
      token_uri: 'https://oauth2.googleapis.com/token',
      auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
      client_x509_cert_url:
        'https://www.googleapis.com/robot/v1/metadata/x509/test',
    };

    it('should read and parse valid service account key', async () => {
      vi.mocked(readFile).mockResolvedValue(JSON.stringify(validKey) as any);

      const result = await readServiceAccountKey('/path/to/key.json');

      expect(result).toEqual(validKey);
    });

    it('should throw error for invalid JSON', async () => {
      vi.mocked(readFile).mockResolvedValue('invalid json' as any);

      await expect(readServiceAccountKey('/path/to/key.json')).rejects.toThrow(
        'Failed to read GCP service account key',
      );
    });

    it('does not include malformed key material in JSON parse errors', async () => {
      vi.mocked(readFile).mockResolvedValue(
        '{"type":"service_account","private_key":LEAKME}' as any,
      );

      const error = await readServiceAccountKey('/path/to/key.json').catch(
        (cause: unknown) => cause,
      );

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('invalid JSON');
      expect((error as Error).message).not.toContain('LEAKME');
    });

    it('should throw error when type is not service_account', async () => {
      const invalidKey = { ...validKey, type: 'authorized_user' };
      vi.mocked(readFile).mockResolvedValue(JSON.stringify(invalidKey) as any);

      await expect(readServiceAccountKey('/path/to/key.json')).rejects.toThrow(
        'Invalid service account key',
      );
    });

    it.each(['project_id', 'client_email', 'private_key'] as const)(
      'should reject a service account key without %s',
      async (field) => {
        const invalidKey = { ...validKey, [field]: '' };
        vi.mocked(readFile).mockResolvedValue(
          JSON.stringify(invalidKey) as any,
        );

        await expect(
          readServiceAccountKey('/path/to/key.json'),
        ).rejects.toThrow(`missing required field: ${field}`);
      },
    );

    it('should expand a home-relative key path before reading it', async () => {
      vi.mocked(readFile).mockResolvedValue(JSON.stringify(validKey) as any);

      await readServiceAccountKey('~/keys/gcp.json');

      expect(readFile).toHaveBeenCalledWith(
        join(homedir(), 'keys', 'gcp.json'),
        'utf-8',
      );
    });

    it('should throw error when file cannot be read', async () => {
      vi.mocked(readFile).mockRejectedValue(new Error('Permission denied'));

      await expect(readServiceAccountKey('/path/to/key.json')).rejects.toThrow(
        'Failed to read GCP service account key',
      );
    });
  });

  describe('readServiceAccountKeySummary', () => {
    it('redacts the private key before parsing discovery metadata', async () => {
      const parseSpy = vi.spyOn(JSON, 'parse');
      vi.mocked(readFile).mockResolvedValue(
        JSON.stringify({
          type: 'service_account',
          project_id: 'summary-project',
          client_email: 'summary@summary-project.iam.gserviceaccount.com',
          private_key: 'PRIVATE-KEY-MUST-NOT-BE-PARSED',
        }) as any,
      );

      await expect(
        readServiceAccountKeySummary('/path/to/key.json'),
      ).resolves.toEqual({
        projectId: 'summary-project',
        clientEmail: 'summary@summary-project.iam.gserviceaccount.com',
      });
      expect(parseSpy).toHaveBeenCalledWith(
        expect.not.stringContaining('PRIVATE-KEY-MUST-NOT-BE-PARSED'),
      );
      expect(parseSpy).toHaveBeenCalledWith(
        expect.stringContaining('"private_key":"<redacted>"'),
      );
    });
  });

  describe('extractGCPCredentials', () => {
    it('should extract credentials from service account key', () => {
      const key: GCPServiceAccountKey = {
        type: 'service_account',
        project_id: 'test-project',
        private_key_id: 'key-id',
        private_key:
          '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----',
        client_email: 'test@test-project.iam.gserviceaccount.com',
        client_id: '123456',
        auth_uri: 'https://accounts.google.com/o/oauth2/auth',
        token_uri: 'https://oauth2.googleapis.com/token',
        auth_provider_x509_cert_url:
          'https://www.googleapis.com/oauth2/v1/certs',
        client_x509_cert_url:
          'https://www.googleapis.com/robot/v1/metadata/x509/test',
      };

      const result = extractGCPCredentials(key);

      expect(result).toEqual({
        projectId: 'test-project',
        privateKey:
          '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----',
        clientEmail: 'test@test-project.iam.gserviceaccount.com',
      });
    });
  });
});

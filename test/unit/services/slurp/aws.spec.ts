import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { homedir } from 'os';
import { join } from 'path';
import { GetCallerIdentityCommand } from '@aws-sdk/client-sts';

const awsReadinessSdk = vi.hoisted(() => ({
  stsSend: vi.fn(),
  stsDestroy: vi.fn(),
  stsConfigs: [] as unknown[],
}));

vi.mock('@aws-sdk/client-sts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-sts')>();
  return {
    ...actual,
    STSClient: class {
      constructor(config: unknown) {
        awsReadinessSdk.stsConfigs.push(config);
      }
      send(...args: unknown[]) {
        return awsReadinessSdk.stsSend(...args);
      }
      destroy() {
        awsReadinessSdk.stsDestroy();
      }
    },
  };
});

import {
  getAWSDir,
  getAWSCredentialsPath,
  getAWSConfigPath,
  readAWSCredentials,
  readAWSConfig,
  listAWSProfileNames,
  listImportableAWSProfileSummaries,
  resolveAWSProfileSource,
  getCurrentAWSProfile,
  getAWSCLIInstallCommand,
} from '../../../../src/cli/services/slurp/aws';
import { validateAWSAccessCredentials } from '../../../../src/cli/services/credential-onboarding/aws-validation';

// Mock fs/promises
vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
}));

// Mock cli-exec
vi.mock('../../../../src/cli/services/slurp/cli-exec', () => ({
  execAsync: vi.fn(),
  isCliInstalled: vi.fn(),
  spawnInteractive: vi.fn(),
}));

// Mock ini parser
vi.mock('ini', () => ({
  default: {
    parse: vi.fn(),
  },
}));

import { readFile } from 'fs/promises';
import ini from 'ini';

describe('AWS Slurp Functions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    awsReadinessSdk.stsConfigs.length = 0;
    awsReadinessSdk.stsSend.mockResolvedValue({
      UserId: 'AIDACKCEVSQ6C2EXAMPLE',
      Account: '123456789012',
      Arn: 'arn:aws:iam::123456789012:user/anycloud-test',
    });
    // Clear environment variables
    delete process.env.AWS_SHARED_CREDENTIALS_FILE;
    delete process.env.AWS_CONFIG_FILE;
    delete process.env.AWS_PROFILE;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  describe('getAWSDir', () => {
    it('should return AWS config directory path', () => {
      const result = getAWSDir();
      expect(result).toBe(join(homedir(), '.aws'));
    });
  });

  describe('getAWSCredentialsPath', () => {
    it('should return AWS_SHARED_CREDENTIALS_FILE env var if set', () => {
      process.env.AWS_SHARED_CREDENTIALS_FILE = '/custom/path/credentials';

      const result = getAWSCredentialsPath();

      expect(result).toBe('/custom/path/credentials');
    });

    it('should return default credentials path if env var not set', () => {
      const result = getAWSCredentialsPath();

      expect(result).toBe(join(homedir(), '.aws', 'credentials'));
    });
  });

  describe('getAWSConfigPath', () => {
    it('should return AWS_CONFIG_FILE env var if set', () => {
      process.env.AWS_CONFIG_FILE = '/custom/path/config';

      const result = getAWSConfigPath();

      expect(result).toBe('/custom/path/config');
    });

    it('should return default config path if env var not set', () => {
      const result = getAWSConfigPath();

      expect(result).toBe(join(homedir(), '.aws', 'config'));
    });
  });

  describe('readAWSCredentials', () => {
    it('should read and parse AWS credentials file', async () => {
      const mockCredentials = {
        default: {
          aws_access_key_id: 'AKIAIOSFODNN7EXAMPLE',
          aws_secret_access_key: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        },
        production: {
          aws_access_key_id: 'AKIAI44QH8DHBEXAMPLE',
          aws_secret_access_key: 'je7MtGbClwBF/2Zp9Utk/h3yCo8nvbEXAMPLEKEY',
        },
      };

      vi.mocked(readFile).mockResolvedValue(
        '[default]\naws_access_key_id=...' as any,
      );
      vi.mocked(ini.parse).mockReturnValue(mockCredentials);

      const result = await readAWSCredentials();

      expect(result).toEqual(mockCredentials);
      expect(readFile).toHaveBeenCalledWith(
        join(homedir(), '.aws', 'credentials'),
        'utf-8',
      );
      expect(ini.parse).toHaveBeenCalled();
    });

    it('should throw error when credentials file cannot be read', async () => {
      vi.mocked(readFile).mockRejectedValue(new Error('Permission denied'));

      await expect(readAWSCredentials()).rejects.toThrow(
        'Failed to read AWS credentials',
      );
    });
  });

  describe('readAWSConfig', () => {
    it('should read and parse AWS config file', async () => {
      const mockConfig = {
        default: {
          region: 'us-east-1',
          output: 'json',
        },
        'profile production': {
          region: 'us-west-2',
          output: 'json',
        },
      };

      vi.mocked(readFile).mockResolvedValue('[default]\nregion=...' as any);
      vi.mocked(ini.parse).mockReturnValue(mockConfig);

      const result = await readAWSConfig();

      expect(result).toEqual({
        default: {
          region: 'us-east-1',
          output: 'json',
        },
        production: {
          region: 'us-west-2',
          output: 'json',
        },
      });
    });

    it('should return empty object when config file does not exist', async () => {
      vi.mocked(readFile).mockRejectedValue(new Error('File not found'));

      const result = await readAWSConfig();

      expect(result).toEqual({});
    });

    it('should normalize profile names by removing "profile " prefix', async () => {
      const mockConfig = {
        'profile dev': { region: 'us-east-1' },
        'profile staging': { region: 'us-west-2' },
        default: { region: 'eu-west-1' },
      };

      vi.mocked(readFile).mockResolvedValue('[default]\n...' as any);
      vi.mocked(ini.parse).mockReturnValue(mockConfig);

      const result = await readAWSConfig();

      expect(result).toEqual({
        dev: { region: 'us-east-1' },
        staging: { region: 'us-west-2' },
        default: { region: 'eu-west-1' },
      });
    });

    it('should ignore IAM Identity Center session metadata sections', async () => {
      vi.mocked(readFile).mockResolvedValue('[default]\n...' as any);
      vi.mocked(ini.parse).mockReturnValue({
        'profile sso-dev': {
          sso_session: 'pty',
          sso_account_id: '123456789012',
          sso_role_name: 'Admin',
        },
        'sso-session pty': {
          sso_start_url: 'https://example.awsapps.com/start',
          sso_region: 'us-east-1',
        },
      });

      const result = await readAWSConfig();

      expect(result).toEqual({
        'sso-dev': {
          sso_session: 'pty',
          sso_account_id: '123456789012',
          sso_role_name: 'Admin',
        },
      });
    });
  });

  describe('resolveAWSProfileSource', () => {
    function mockProfileFiles(
      credentials: Record<string, unknown>,
      config: Record<string, unknown>,
    ): void {
      vi.mocked(readFile).mockResolvedValue('mock' as any);
      vi.mocked(ini.parse)
        .mockReturnValueOnce(credentials)
        .mockReturnValueOnce(config);
    }

    it('prefers durable credentials-file keys over SSO config', async () => {
      mockProfileFiles(
        {
          production: {
            aws_access_key_id: 'AKIA-PRODUCTION',
            aws_secret_access_key: 'SECRET-PRODUCTION',
          },
        },
        {
          'profile production': {
            sso_session: 'production',
            sso_account_id: '123456789012',
            sso_role_name: 'Admin',
            region: 'us-west-2',
          },
        },
      );

      await expect(resolveAWSProfileSource('production')).resolves.toEqual({
        kind: 'static',
        credentials: {
          accessKeyId: 'AKIA-PRODUCTION',
          secretAccessKey: 'SECRET-PRODUCTION',
          region: 'us-west-2',
          profileName: 'production',
        },
      });
    });

    it('classifies profiles through configured credentials and config paths', async () => {
      vi.stubEnv('AWS_SHARED_CREDENTIALS_FILE', '/custom/aws/credentials');
      vi.stubEnv('AWS_CONFIG_FILE', '/custom/aws/config');
      mockProfileFiles(
        {
          production: {
            aws_access_key_id: 'AKIA-PRODUCTION',
            aws_secret_access_key: 'SECRET-PRODUCTION',
          },
        },
        { 'profile production': { region: 'eu-central-1' } },
      );

      await expect(
        resolveAWSProfileSource('production'),
      ).resolves.toMatchObject({
        kind: 'static',
        credentials: { region: 'eu-central-1' },
      });
      expect(readFile).toHaveBeenCalledWith('/custom/aws/credentials', 'utf-8');
      expect(readFile).toHaveBeenCalledWith('/custom/aws/config', 'utf-8');
    });

    it('accepts durable static keys stored in the config file', async () => {
      mockProfileFiles(
        {},
        {
          'profile config-only': {
            aws_access_key_id: 'AKIA-CONFIG',
            aws_secret_access_key: 'SECRET-CONFIG',
          },
        },
      );

      await expect(
        resolveAWSProfileSource('config-only'),
      ).resolves.toMatchObject({
        kind: 'static',
        credentials: {
          accessKeyId: 'AKIA-CONFIG',
          secretAccessKey: 'SECRET-CONFIG',
        },
      });
    });

    it('classifies session credentials as temporary', async () => {
      mockProfileFiles(
        {
          temporary: {
            aws_access_key_id: 'ASIA-TEMPORARY',
            aws_secret_access_key: 'SECRET-TEMPORARY',
            aws_session_token: 'SESSION-TEMPORARY',
          },
        },
        {},
      );

      await expect(resolveAWSProfileSource('temporary')).resolves.toMatchObject(
        {
          kind: 'temporary',
          credentials: { sessionToken: 'SESSION-TEMPORARY' },
        },
      );
    });

    it.each([
      ['sso', { sso_session: 'dev' }],
      ['role', { role_arn: 'arn:aws:iam::123456789012:role/Dev' }],
      ['credential-process', { credential_process: 'fetch-credentials' }],
      ['web-identity', { web_identity_token_file: '/tmp/token' }],
    ] as const)(
      'classifies %s profiles as non-static',
      async (_source, entry) => {
        mockProfileFiles({}, { 'profile dynamic': entry });

        await expect(resolveAWSProfileSource('dynamic')).resolves.toEqual({
          kind: 'non-static',
          profileName: 'dynamic',
        });
      },
    );

    it('reports incomplete static profiles', async () => {
      mockProfileFiles(
        { broken: { aws_access_key_id: 'AKIA-INCOMPLETE' } },
        {},
      );

      await expect(resolveAWSProfileSource('broken')).resolves.toEqual({
        kind: 'incomplete',
        profileName: 'broken',
        missing: ['aws_secret_access_key'],
      });
    });

    it('reports a session-token-only profile as incomplete', async () => {
      mockProfileFiles(
        { broken: { aws_session_token: 'SESSION-WITHOUT-KEYS' } },
        {},
      );

      await expect(resolveAWSProfileSource('broken')).resolves.toEqual({
        kind: 'incomplete',
        profileName: 'broken',
        missing: ['aws_access_key_id', 'aws_secret_access_key'],
      });
    });

    it('does not combine a partial credentials-file entry with config-file keys', async () => {
      mockProfileFiles(
        { mixed: { aws_access_key_id: 'AKIA-CREDENTIALS-FILE' } },
        {
          'profile mixed': {
            aws_secret_access_key: 'SECRET-CONFIG-FILE',
          },
        },
      );

      await expect(resolveAWSProfileSource('mixed')).resolves.toEqual({
        kind: 'incomplete',
        profileName: 'mixed',
        missing: ['aws_secret_access_key'],
      });
    });

    it('treats an absent credentials file as an empty profile set', async () => {
      vi.mocked(readFile).mockRejectedValue(
        Object.assign(new Error('not found'), { code: 'ENOENT' }),
      );

      await expect(resolveAWSProfileSource('missing')).resolves.toEqual({
        kind: 'missing',
        profileName: 'missing',
      });
    });

    it('surfaces credentials-file read failures other than absence', async () => {
      vi.mocked(readFile).mockRejectedValue(
        Object.assign(new Error('permission denied'), { code: 'EACCES' }),
      );

      await expect(resolveAWSProfileSource('production')).rejects.toThrow(
        /permission denied/i,
      );
    });

    it('lists only complete durable profiles from both AWS profile files', async () => {
      mockProfileFiles(
        {
          durable: {
            aws_access_key_id: 'AKIA-DURABLE',
            aws_secret_access_key: 'SECRET-DURABLE',
          },
          temporary: {
            aws_access_key_id: 'ASIA-TEMPORARY',
            aws_secret_access_key: 'SECRET-TEMPORARY',
            aws_session_token: 'SESSION-TEMPORARY',
          },
          incomplete: {
            aws_access_key_id: 'AKIA-INCOMPLETE',
          },
        },
        {
          'profile config-durable': {
            aws_access_key_id: 'AKIA-CONFIG-DURABLE',
            aws_secret_access_key: 'SECRET-CONFIG-DURABLE',
          },
          'profile sso': { sso_session: 'dev' },
        },
      );

      await expect(listImportableAWSProfileSummaries()).resolves.toEqual([
        { profileName: 'durable', accessKeyId: 'AKIA-DURABLE' },
        {
          profileName: 'config-durable',
          accessKeyId: 'AKIA-CONFIG-DURABLE',
        },
      ]);
    });

    it('lists every configured profile name, including non-importable ones, for operator selection', async () => {
      mockProfileFiles(
        {
          default: {
            aws_access_key_id: 'AKIA-DEFAULT',
            aws_secret_access_key: 'SECRET-DEFAULT',
          },
          temporary: {
            aws_access_key_id: 'ASIA-TEMPORARY',
            aws_secret_access_key: 'SECRET-TEMPORARY',
            aws_session_token: 'SESSION-TEMPORARY',
          },
        },
        {
          default: { region: 'us-east-1' },
          'profile sso': { sso_session: 'dev' },
          'sso-session dev': { sso_start_url: 'https://example.com' },
        },
      );

      await expect(listAWSProfileNames()).resolves.toEqual([
        'default',
        'temporary',
        'sso',
      ]);
    });

    it('lists no profile names when neither AWS profile file exists', async () => {
      vi.mocked(readFile).mockRejectedValue(
        Object.assign(new Error('not found'), { code: 'ENOENT' }),
      );

      await expect(listAWSProfileNames()).resolves.toEqual([]);
    });

    it('lists a config-only static profile when the credentials file is absent', async () => {
      vi.mocked(readFile).mockImplementation(async (path) => {
        if (path === getAWSCredentialsPath()) {
          throw Object.assign(new Error('not found'), { code: 'ENOENT' });
        }
        return 'mock' as any;
      });
      vi.mocked(ini.parse).mockReturnValue({
        'profile config-only': {
          aws_access_key_id: 'AKIA-CONFIG-ONLY',
          aws_secret_access_key: 'SECRET-CONFIG-ONLY',
        },
      });

      await expect(listImportableAWSProfileSummaries()).resolves.toEqual([
        {
          profileName: 'config-only',
          accessKeyId: 'AKIA-CONFIG-ONLY',
        },
      ]);
    });

    it('redacts AWS secrets before parsing profile discovery metadata', async () => {
      vi.mocked(readFile).mockImplementation(async (path) => {
        if (path === getAWSCredentialsPath()) {
          return ('[production]\n' +
            'aws_access_key_id = AKIA-PRODUCTION\n' +
            'aws_secret_access_key = SECRET-MUST-NOT-BE-PARSED\n' +
            'aws_session_token = SESSION-MUST-NOT-BE-PARSED\n') as any;
        }
        return ('[profile config-static]\n' +
          'aws_access_key_id = AKIA-CONFIG\n' +
          'aws_secret_access_key = CONFIG-SECRET-MUST-NOT-BE-PARSED\n') as any;
      });
      vi.mocked(ini.parse)
        .mockReturnValueOnce({
          production: {
            aws_access_key_id: 'AKIA-PRODUCTION',
            aws_secret_access_key: '<redacted>',
            aws_session_token: '<redacted>',
          },
        })
        .mockReturnValueOnce({
          'profile config-static': {
            aws_access_key_id: 'AKIA-CONFIG',
            aws_secret_access_key: '<redacted>',
          },
        });

      await listImportableAWSProfileSummaries();

      const parsedContent = vi
        .mocked(ini.parse)
        .mock.calls.map(([content]) => content)
        .join('\n');
      expect(parsedContent).not.toContain('SECRET-MUST-NOT-BE-PARSED');
      expect(parsedContent).not.toContain('SESSION-MUST-NOT-BE-PARSED');
      expect(parsedContent).toContain('aws_secret_access_key = <redacted>');
      expect(parsedContent).toContain('aws_session_token = <redacted>');
    });
  });

  describe('validateAWSAccessCredentials', () => {
    it('uses only the supplied credentials and returns the STS identity', async () => {
      vi.stubEnv('AWS_PROFILE', 'ambient');
      vi.stubEnv('AWS_SESSION_TOKEN', 'ambient-session');
      vi.stubEnv('AWS_REGION', 'eu-west-1');
      vi.stubEnv('AWS_ENDPOINT_URL_STS', 'https://sts.test');

      await expect(
        validateAWSAccessCredentials({
          accessKeyId: 'AKIA-IMPORTED',
          secretAccessKey: 'SECRET-IMPORTED',
        }),
      ).resolves.toEqual({
        account: '123456789012',
        arn: 'arn:aws:iam::123456789012:user/anycloud-test',
        userId: 'AIDACKCEVSQ6C2EXAMPLE',
      });

      expect(awsReadinessSdk.stsConfigs).toEqual([
        {
          credentials: {
            accessKeyId: 'AKIA-IMPORTED',
            secretAccessKey: 'SECRET-IMPORTED',
          },
          region: 'eu-west-1',
          maxAttempts: 1,
          endpoint: 'https://sts.test',
        },
      ]);
      expect(awsReadinessSdk.stsSend.mock.calls[0][0]).toBeInstanceOf(
        GetCallerIdentityCommand,
      );
      expect(awsReadinessSdk.stsDestroy).toHaveBeenCalledOnce();
    });

    it('rejects incomplete STS identity responses', async () => {
      awsReadinessSdk.stsSend.mockResolvedValue({
        Account: '123456789012',
      });

      await expect(
        validateAWSAccessCredentials({
          accessKeyId: 'AKIA-IMPORTED',
          secretAccessKey: 'SECRET-IMPORTED',
        }),
      ).rejects.toThrow(/incomplete STS identity/i);
    });

    it('uses an imported profile region ahead of ambient region settings', async () => {
      vi.stubEnv('AWS_REGION', 'us-east-1');

      await validateAWSAccessCredentials(
        {
          accessKeyId: 'AKIA-GOVCLOUD',
          secretAccessKey: 'SECRET-GOVCLOUD',
        },
        'us-gov-west-1',
      );

      expect(awsReadinessSdk.stsConfigs[0]).toMatchObject({
        region: 'us-gov-west-1',
      });
    });

    it('surfaces STS authentication failures and destroys the client', async () => {
      awsReadinessSdk.stsSend.mockRejectedValue(
        Object.assign(new Error('The security token is invalid'), {
          name: 'InvalidClientTokenId',
        }),
      );

      await expect(
        validateAWSAccessCredentials({
          accessKeyId: 'AKIA-INVALID',
          secretAccessKey: 'SECRET-INVALID',
        }),
      ).rejects.toThrow(/InvalidClientTokenId.*security token is invalid/i);
      expect(awsReadinessSdk.stsDestroy).toHaveBeenCalledOnce();
    });
  });

  describe('getCurrentAWSProfile', () => {
    it('should return AWS_PROFILE env var if set', () => {
      process.env.AWS_PROFILE = 'production';

      const result = getCurrentAWSProfile();

      expect(result).toBe('production');
    });

    it('should return "default" if AWS_PROFILE not set', () => {
      const result = getCurrentAWSProfile();

      expect(result).toBe('default');
    });
  });

  describe('getAWSCLIInstallCommand', () => {
    it.each([
      ['linux', 'curl -fsSL https://awscli.amazonaws.com/v2/install.sh | bash'],
      [
        'darwin',
        'curl -fsSL https://awscli.amazonaws.com/v2/install.sh | bash',
      ],
      ['win32', 'irm https://awscli.amazonaws.com/v2/install.ps1 | iex'],
    ])('on %s prints a sudo-free hint: %s', (platform, expected) => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: platform });
      try {
        expect(getAWSCLIInstallCommand()).toBe(expected);
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform });
      }
    });
  });
});

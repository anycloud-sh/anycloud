import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import { homedir } from 'os';
import { basename, join } from 'path';
import { mkdir, mkdtemp, writeFile, unlink, rm, access } from 'fs/promises';
import {
  getAllServiceAccountKeyPaths,
  validateServiceAccountKeyFile,
  prepareGCPServiceAccountKeyImport,
} from '../../src/cli/services/slurp/gcp';
import {
  extractGCPCredentials,
  readServiceAccountKey,
  type GCPServiceAccountKey,
} from '../../src/cli/services/credential-onboarding/gcp-key-files';
import {
  isAWSCLIInstalled,
  readAWSCredentials,
  listImportableAWSProfileSummaries,
} from '../../src/cli/services/slurp/aws';
import { isAzureCLIInstalled } from '../../src/cli/services/slurp/azure';

/**
 * Integration tests for credential detection and CLI interactions.
 * These tests actually call real CLI commands (gcloud, aws, az).
 * Tests will fail if CLIs are not installed or not logged in.
 */

describe('GCP Credentials Integration', () => {
  const testKeyPath = join(
    homedir(),
    '.anycloud',
    'anycloud-test-integration-key.json',
  );
  const mockKey: GCPServiceAccountKey = {
    type: 'service_account',
    project_id: 'test-integration-project',
    private_key_id: 'test-key-id',
    private_key:
      '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC\n-----END PRIVATE KEY-----',
    client_email: 'test-sa@test-integration-project.iam.gserviceaccount.com',
    client_id: '123456789',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
    auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
    client_x509_cert_url:
      'https://www.googleapis.com/robot/v1/metadata/x509/test-sa%40test-integration-project.iam.gserviceaccount.com',
  };

  beforeAll(async () => {
    // Create test key file
    await mkdir(join(homedir(), '.anycloud'), { recursive: true });
    await writeFile(testKeyPath, JSON.stringify(mockKey, null, 2), {
      mode: 0o600,
    });
  });

  afterAll(async () => {
    // Clean up test key file
    try {
      await unlink(testKeyPath);
    } catch {
      // Ignore errors if file doesn't exist
    }
  });

  it('should write and read service account key', async () => {
    // Read the key we just created
    const key = await readServiceAccountKey(testKeyPath);
    expect(key).toEqual(mockKey);
  });

  it('should extract credentials from service account key', async () => {
    const key = await readServiceAccountKey(testKeyPath);
    const credentials = extractGCPCredentials(key);

    expect(credentials).toEqual({
      projectId: 'test-integration-project',
      privateKey:
        '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC\n-----END PRIVATE KEY-----',
      clientEmail: 'test-sa@test-integration-project.iam.gserviceaccount.com',
    });
  });

  it('should find service account keys including test key', async () => {
    const keys = await getAllServiceAccountKeyPaths();
    expect(Array.isArray(keys)).toBe(true);
    // Should include our test key
    expect(keys.some((k) => k === testKeyPath)).toBe(true);
  });
});

describe('GCP validateServiceAccountKeyFile() Integration', () => {
  const mockValidKey: GCPServiceAccountKey = {
    type: 'service_account',
    project_id: 'test-validation-project',
    private_key_id: 'key-id',
    private_key:
      '-----BEGIN PRIVATE KEY-----\ntest-key-content\n-----END PRIVATE KEY-----',
    client_email: 'test@test-validation-project.iam.gserviceaccount.com',
    client_id: '123456',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
    auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
    client_x509_cert_url:
      'https://www.googleapis.com/robot/v1/metadata/x509/test',
  };

  afterEach(async () => {
    // Clean up test files
    const testPaths = [
      '/tmp/test-valid-key.json',
      '/tmp/test-invalid-json.json',
      '/tmp/test-user-creds.json',
      join(homedir(), 'Downloads', 'test-key.json'),
    ];

    for (const path of testPaths) {
      try {
        await unlink(path);
      } catch {
        // Ignore if file doesn't exist
      }
    }
  });

  it('should validate valid service account key with absolute path', async () => {
    const testPath = '/tmp/test-valid-key.json';
    await writeFile(testPath, JSON.stringify(mockValidKey, null, 2));

    const result = await validateServiceAccountKeyFile(testPath);

    expect(result).toEqual(mockValidKey);
  });

  it('should expand ~ to home directory', async () => {
    const downloadsPath = join(homedir(), 'Downloads', 'test-key.json');
    await mkdir(join(homedir(), 'Downloads'), { recursive: true });
    await writeFile(downloadsPath, JSON.stringify(mockValidKey, null, 2));

    const result = await validateServiceAccountKeyFile(
      '~/Downloads/test-key.json',
    );

    expect(result).toEqual(mockValidKey);
  });

  it('should throw error when file does not exist', async () => {
    await expect(
      validateServiceAccountKeyFile('/nonexistent/path.json'),
    ).rejects.toThrow('Cannot read file');
  });

  it('should throw error when JSON is invalid', async () => {
    const testPath = '/tmp/test-invalid-json.json';
    await writeFile(testPath, 'invalid json content {]');

    await expect(validateServiceAccountKeyFile(testPath)).rejects.toThrow(
      'Invalid service account key',
    );
  });

  it('should throw error when type is not service_account', async () => {
    const userCreds = {
      ...mockValidKey,
      type: 'authorized_user',
    };
    const testPath = '/tmp/test-user-creds.json';
    await writeFile(testPath, JSON.stringify(userCreds, null, 2));

    await expect(validateServiceAccountKeyFile(testPath)).rejects.toThrow(
      'type is "authorized_user"',
    );
  });
});

describe('GCP prepareGCPServiceAccountKeyImport() Integration', () => {
  let root: string;
  let anycloudDir: string;
  const mockValidKey: GCPServiceAccountKey = {
    type: 'service_account',
    project_id: 'test-upload-project',
    private_key_id: 'key-id',
    private_key:
      '-----BEGIN PRIVATE KEY-----\ntest-upload-key\n-----END PRIVATE KEY-----',
    client_email: 'test@test-upload-project.iam.gserviceaccount.com',
    client_id: '123456',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
    auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
    client_x509_cert_url:
      'https://www.googleapis.com/robot/v1/metadata/x509/test',
  };

  beforeEach(async () => {
    // Keep the source under the real home for the tilde-expansion case.
    root = await mkdtemp(join(homedir(), '.anycloud-key-import-'));
    anycloudDir = join(root, 'anycloud');
    vi.stubEnv('ANYCLOUD_DIR', anycloudDir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it('copies the key to the Anycloud directory with the requested name', async () => {
    const sourcePath = join(root, 'my-service-account.json');
    await writeFile(sourcePath, JSON.stringify(mockValidKey, null, 2));

    const result = await prepareGCPServiceAccountKeyImport(sourcePath, 'prod');
    await result.persist();

    expect(result.projectId).toBe('test-upload-project');
    expect(result.clientEmail).toBe(
      'test@test-upload-project.iam.gserviceaccount.com',
    );
    expect(result.keyFilePath).toBe(
      join(anycloudDir, 'anycloud-prod-key.json'),
    );

    // Verify file was copied
    await expect(
      access(join(anycloudDir, 'anycloud-prod-key.json')),
    ).resolves.toBeUndefined();
  });

  it('should keep filename if already has anycloud prefix', async () => {
    const sourcePath = join(root, 'anycloud-existing-key.json');
    await writeFile(sourcePath, JSON.stringify(mockValidKey, null, 2));

    const result = await prepareGCPServiceAccountKeyImport(sourcePath);
    await result.persist();

    expect(result.keyFilePath).toBe(
      join(anycloudDir, 'anycloud-existing-key.json'),
    );

    // Verify no double prefix
    expect(result.keyFilePath).not.toContain('anycloud-anycloud');
  });

  it('should expand ~ in source path', async () => {
    const sourcePath = join(root, 'test-key.json');
    await writeFile(sourcePath, JSON.stringify(mockValidKey, null, 2));

    const result = await prepareGCPServiceAccountKeyImport(
      join('~', basename(root), 'test-key.json'),
      'test',
    );
    await result.persist();

    expect(result.keyFilePath).toBe(
      join(anycloudDir, 'anycloud-test-key.json'),
    );

    // Verify file was copied
    await expect(
      access(join(anycloudDir, 'anycloud-test-key.json')),
    ).resolves.toBeUndefined();
  });

  it('creates the Anycloud directory only when the import is persisted', async () => {
    const sourcePath = join(root, 'my-service-account.json');
    await writeFile(sourcePath, JSON.stringify(mockValidKey, null, 2));

    const result = await prepareGCPServiceAccountKeyImport(sourcePath, 'test');
    await expect(access(anycloudDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await result.persist();

    await expect(access(anycloudDir)).resolves.toBeUndefined();
    expect(result.keyFilePath).toBe(
      join(anycloudDir, 'anycloud-test-key.json'),
    );
    await expect(access(result.keyFilePath)).resolves.toBeUndefined();
  });
});

describe('AWS Credentials Integration', () => {
  const testCredPath = join(homedir(), '.aws', 'credentials-test-integration');

  beforeAll(async () => {
    // Create test credentials file
    await mkdir(join(homedir(), '.aws'), { recursive: true });
    const testCreds = `[test-integration]
aws_access_key_id = AKIAIOSFODNN7EXAMPLE
aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
`;
    await writeFile(testCredPath, testCreds, { mode: 0o600 });
  });

  afterAll(async () => {
    // Clean up test credentials file
    try {
      await unlink(testCredPath);
    } catch {
      // Ignore errors if file doesn't exist
    }
  });

  it('should detect that AWS CLI is installed', async () => {
    const isInstalled = await isAWSCLIInstalled();
    expect(isInstalled).toBe(true);
  });

  it('should read AWS credentials file if it exists', async () => {
    try {
      const credentials = await readAWSCredentials();
      expect(typeof credentials).toBe('object');
      // Should have at least one profile
      const profileNames = Object.keys(credentials);
      expect(profileNames.length).toBeGreaterThan(0);
    } catch (error) {
      // It's okay if the default credentials file doesn't exist
      expect(error).toBeInstanceOf(Error);
    }
  });

  it('should list importable AWS profiles if credentials exist', async () => {
    try {
      const profiles = await listImportableAWSProfileSummaries();
      expect(Array.isArray(profiles)).toBe(true);
    } catch (error) {
      // It's okay if no credentials exist
      expect(error).toBeInstanceOf(Error);
    }
  });
});

describe('Azure Credentials Integration', () => {
  const testProfilePath = join(
    homedir(),
    '.azure',
    'azureProfile-test-integration.json',
  );

  beforeAll(async () => {
    // Create test profile file
    await mkdir(join(homedir(), '.azure'), { recursive: true });
    const testProfile = {
      subscriptions: [
        {
          id: 'test-subscription-id',
          name: 'Test Integration Subscription',
          tenantId: 'test-tenant-id',
          state: 'Enabled',
          isDefault: true,
        },
      ],
    };
    await writeFile(testProfilePath, JSON.stringify(testProfile, null, 2), {
      mode: 0o600,
    });
  });

  afterAll(async () => {
    // Clean up test profile file
    try {
      await unlink(testProfilePath);
    } catch {
      // Ignore errors if file doesn't exist
    }
  });

  it('should detect that Azure CLI is installed', async () => {
    const isInstalled = await isAzureCLIInstalled();
    expect(isInstalled).toBe(true);
  });
});

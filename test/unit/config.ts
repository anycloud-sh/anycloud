import packageJson from '../../package.json' with { type: 'json' };

// Test constants
export const TEST_ID = 'test-workload-123';
export const TEST_USER_ID = 'test-user-456';
// Use the current package version so versionCheck passes after version bumps in CI
export const TEST_DAEMON_VERSION = packageJson.version;

// Mock workload configuration
export const mockCloudConfig = {
  credentials: {
    accessKeyId: 'test-access-key',
    secretAccessKey: 'test-secret-key',
  },
  region: 'us-east-1',
  vmType: 't3.medium',
  cloudProvider: 'AWS',
};

// Mock request payloads
export const mockNewWorkloadPayload = {
  cloudConfig: mockCloudConfig,
  image: 'nginx:alpine',
  id: TEST_ID,
  workloadType: 'job',
  env: {
    TEST_VAR: 'test_value',
    DATABASE_URL: 'postgresql://localhost:5432/test',
  },
};

export const mockClientErrorPayload = {
  err: { message: 'Test error message' },
  id: TEST_ID,
  version: TEST_DAEMON_VERSION,
  accessToken: 'mock-github-token',
};

export const mockDaemonErrorPayload = {
  err: 'Test daemon error',
  version: TEST_DAEMON_VERSION,
  id: TEST_ID,
  accessToken: 'mock-github-token',
};

export const mockInfoPayload = {
  id: TEST_ID,
  credentials: {
    cloudProvider: 'AWS',
    accessKeyId: 'test-access-key',
    secretAccessKey: 'test-secret-key',
  },
  accessToken: 'mock-github-token',
  version: TEST_DAEMON_VERSION,
  status: 'running',
};

export const mockLogsPayload = {
  id: TEST_ID,
  accessToken: 'mock-github-token',
  credentials: {
    cloudProvider: 'AWS',
    accessKeyId: 'test-access-key',
    secretAccessKey: 'test-secret-key',
  },
};

export const mockTerminatePayload = {
  id: TEST_ID,
  apiToken: 'mock-deploy-token',
};

export const mockAckPayload = {
  id: TEST_ID,
  apiToken: 'mock-api-token',
  sshPrivateKey:
    '-----BEGIN OPENSSH PRIVATE KEY-----\nmock-key\n-----END OPENSSH PRIVATE KEY-----',
  version: TEST_DAEMON_VERSION,
  privateIp: '10.0.0.1',
};

export const mockScalePayload = {
  id: TEST_ID,
  apiToken: 'mock-deploy-token',
  vmCount: 3,
};

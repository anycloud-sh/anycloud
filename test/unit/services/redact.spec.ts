import { describe, it, expect } from 'vitest';
import { redactSecrets, redactValue } from '../../../src/api/services/redact';
import { isSecretKey } from '../../../src/shared/secret-keys';

describe('redactSecrets', () => {
  describe('token redaction', () => {
    it('should redact JWT tokens (eyJ...)', () => {
      const log =
        'Authorization: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.long_token_payload_here';
      const redacted = redactSecrets(log);
      expect(redacted).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
      expect(redacted).toContain('Authorization');
    });

    it('should redact Bearer tokens', () => {
      const log = 'Bearer abc123def456ghi789jkl012mno345';
      const redacted = redactSecrets(log);
      expect(redacted).not.toContain('abc123def456ghi789jkl012mno345');
    });

    it('should redact GitHub tokens', () => {
      const log = 'Using token ghp_1234567890abcdefghij';
      const redacted = redactSecrets(log);
      expect(redacted).not.toContain('ghp_1234567890abcdefghij');
    });

    it('should redact user-to-server and fine-grained GitHub tokens', () => {
      const redacted = redactSecrets(
        "printf '%s\\n' 'github_pat_11ABCDEFG0123456789_abcdefghij' | docker login; ghu_1234567890abcdefghij",
      );
      expect(redacted).not.toContain('github_pat_11ABCDEFG');
      expect(redacted).not.toContain('ghu_1234567890');
    });
  });

  describe('key-value pattern redaction', () => {
    it('should redact password in key=value format', () => {
      const log = 'password=supersecret123';
      const redacted = redactSecrets(log);
      expect(redacted).not.toContain('supersecret123');
    });

    it('should redact API_KEY in key=value format', () => {
      const log = 'API_KEY=sk-abc123def456ghi789';
      const redacted = redactSecrets(log);
      expect(redacted).not.toContain('sk-abc123def456ghi789');
    });

    it('should redact key=value secrets containing ampersands', () => {
      const log = 'API_KEY=abc&def configured';
      const redacted = redactSecrets(log);
      expect(redacted).toBe('API_KEY=<REDACTED> configured');
      expect(redacted).not.toContain('abc');
      expect(redacted).not.toContain('def');
    });

    it('should redact secret in key: value format', () => {
      const log = 'secret: my_secret_value_here';
      const redacted = redactSecrets(log);
      expect(redacted).not.toContain('my_secret_value_here');
    });

    it('should redact AWS credentials', () => {
      const log = 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE';
      const redacted = redactSecrets(log);
      expect(redacted).not.toContain('AKIAIOSFODNN7EXAMPLE');
    });

    it('should redact bare AWS access key IDs', () => {
      const log = 'Found key AKIAIOSFODNN7EXAMPLE in config';
      const redacted = redactSecrets(log);
      expect(redacted).not.toContain('AKIAIOSFODNN7EXAMPLE');
      expect(redacted).toContain('<REDACTED_AWS_KEY>');
    });

    it('should redact bare AWS STS access key IDs', () => {
      const log = 'Found key ASIAIOSFODNN7EXAMPLE in config';
      const redacted = redactSecrets(log);
      expect(redacted).not.toContain('ASIAIOSFODNN7EXAMPLE');
      expect(redacted).toContain('<REDACTED_AWS_KEY>');
    });

    it('should redact AWS session tokens in key=value format', () => {
      const log = 'AWS_SESSION_TOKEN=session-token-value';
      const redacted = redactSecrets(log);
      expect(redacted).not.toContain('session-token-value');
      expect(redacted).toContain('AWS_SESSION_TOKEN=<REDACTED>');
    });

    it('should redact AWS presigned URL credentials', () => {
      const log =
        'GET https://bucket.s3.amazonaws.com/file?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=ASIAIOSFODNN7EXAMPLE%2F20260626%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Security-Token=token%2Fwith%2Fslashes&X-Amz-Signature=abcdef1234567890&X-Amz-Expires=900';
      const redacted = redactSecrets(log);

      expect(redacted).not.toContain('ASIAIOSFODNN7EXAMPLE');
      expect(redacted).not.toContain('token%2Fwith%2Fslashes');
      expect(redacted).not.toContain('abcdef1234567890');
      expect(redacted).toContain('X-Amz-Credential=<REDACTED>');
      expect(redacted).toContain('X-Amz-Security-Token=<REDACTED>');
      expect(redacted).toContain('X-Amz-Signature=<REDACTED>');
      expect(redacted).toContain('X-Amz-Algorithm=AWS4-HMAC-SHA256');
      expect(redacted).toContain('X-Amz-Expires=900');
    });

    it('should redact legacy S3 signed URL credentials', () => {
      const log =
        'https://bucket.s3.amazonaws.com/file?AWSAccessKeyId=AKIAIOSFODNN7EXAMPLE&Signature=legacy-signature&SecurityToken=legacy-token&Expires=900';
      const redacted = redactSecrets(log);

      expect(redacted).not.toContain('AKIAIOSFODNN7EXAMPLE');
      expect(redacted).not.toContain('legacy-signature');
      expect(redacted).not.toContain('legacy-token');
      expect(redacted).toContain('AWSAccessKeyId=<REDACTED>');
      expect(redacted).toContain('Signature=<REDACTED>');
      expect(redacted).toContain('SecurityToken=<REDACTED>');
      expect(redacted).toContain('Expires=900');
    });
  });

  describe('SSH private key redaction', () => {
    it('should redact OpenSSH private keys', () => {
      const log =
        'key: -----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\n done';
      const redacted = redactSecrets(log);
      expect(redacted).not.toContain('b3BlbnNzaC1rZXktdjEAAAAA');
      expect(redacted).toContain('<REDACTED_SSH_KEY>');
      expect(redacted).toContain('done');
    });

    it('should redact RSA private keys', () => {
      const log =
        '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
      const redacted = redactSecrets(log);
      expect(redacted).not.toContain('MIIEpAIBAAKCAQEA');
      expect(redacted).toContain('<REDACTED_SSH_KEY>');
    });

    it('should redact EC private keys', () => {
      const log =
        '-----BEGIN EC PRIVATE KEY-----\nMHQCAQEE\n-----END EC PRIVATE KEY-----';
      const redacted = redactSecrets(log);
      expect(redacted).not.toContain('MHQCAQEE');
      expect(redacted).toContain('<REDACTED_SSH_KEY>');
    });

    it('should redact generic private keys', () => {
      const log =
        '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----';
      const redacted = redactSecrets(log);
      expect(redacted).not.toContain('MIIEvQIBADANBg');
      expect(redacted).toContain('<REDACTED_SSH_KEY>');
    });

    it('should redact SSH keys in JSON strings', () => {
      const json = JSON.stringify({
        sshPrivateKey:
          '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\n',
      });
      const redacted = redactSecrets(json);
      expect(redacted).not.toContain('b3BlbnNzaC1rZXktdjEAAAAA');
      expect(redacted).toContain('<REDACTED_SSH_KEY>');
    });
  });

  describe('URL password redaction', () => {
    it('should redact passwords in URLs (://user:pass@host)', () => {
      const log = 'Connecting to https://admin:secret123@example.com/api';
      const redacted = redactSecrets(log);
      expect(redacted).not.toContain('secret123');
      expect(redacted).toContain('example.com'); // Host should remain
    });

    it('should redact database connection strings', () => {
      const log = 'postgres://user:mypassword@localhost:5432/db';
      const redacted = redactSecrets(log);
      expect(redacted).not.toContain('mypassword');
    });
  });

  describe('safe content preservation', () => {
    it('should preserve normal log messages', () => {
      const log = 'Starting server on port 8088';
      const redacted = redactSecrets(log);
      expect(redacted).toBe(log);
    });

    it('should preserve workload IDs (no catch-all pattern)', () => {
      const log = 'Checking workload train-xvi-xxii-p5en-aws-longer-001';
      const redacted = redactSecrets(log);
      expect(redacted).toContain('train-xvi-xxii-p5en-aws-longer-001');
    });

    it('should preserve file paths', () => {
      const log =
        '/mnt/bucket/very_long_file_name_that_exceeds_thirty_characters.txt';
      const redacted = redactSecrets(log);
      expect(redacted).toContain('/mnt/bucket');
    });

    it('should handle empty strings', () => {
      const redacted = redactSecrets('');
      expect(redacted).toBe('');
    });

    it('should preserve dates and times', () => {
      const log = '2025-01-15T10:30:00Z - Server started';
      const redacted = redactSecrets(log);
      // Dates and times should NOT be redacted
      expect(redacted).toContain('2025-01-15');
      expect(redacted).toContain('Server started');
    });
  });

  describe('realistic scenarios', () => {
    it('should redact secrets in Docker logs', () => {
      const realLog = `
        Starting application
        Config loaded: GITHUB_TOKEN=ghp_abc123def456ghi789
        Database: postgres://user:pass123@localhost:5432/db
        Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature
        Ready on port 8088
      `;
      const redacted = redactSecrets(realLog);
      expect(redacted).not.toContain('ghp_abc123def456ghi789');
      expect(redacted).not.toContain('pass123');
      expect(redacted).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
      expect(redacted).toContain('Starting application'); // Normal content preserved
      expect(redacted).toContain('Ready on port 8088');
    });

    it('should handle multiple secrets in one line', () => {
      const log = 'API_KEY=secret123 and PASSWORD=password456 configured';
      const redacted = redactSecrets(log);
      expect(redacted).not.toContain('secret123');
      expect(redacted).not.toContain('password456');
    });
  });
});

describe('redactValue', () => {
  describe('primitive values', () => {
    it('should redact secrets in strings', () => {
      const result = redactValue('password=secret123');
      expect(result).not.toContain('secret123');
    });

    it('should preserve non-secret strings', () => {
      const result = redactValue('normal message');
      expect(result).toBe('normal message');
    });

    it('should preserve numbers', () => {
      expect(redactValue(42)).toBe(42);
      expect(redactValue(3.14)).toBe(3.14);
    });

    it('should preserve booleans', () => {
      expect(redactValue(true)).toBe(true);
      expect(redactValue(false)).toBe(false);
    });

    it('should preserve null and undefined', () => {
      expect(redactValue(null)).toBe(null);
      expect(redactValue(undefined)).toBe(undefined);
    });
  });

  describe('objects', () => {
    it('should redact secrets in object values', () => {
      const result = redactValue({
        password: 'password=secret123',
        normalValue: 'visible',
      }) as Record<string, unknown>;

      expect(result.password).not.toContain('secret123');
      expect(result.normalValue).toBe('visible');
    });

    it('should redact JWT tokens in objects', () => {
      const result = redactValue({
        authorization: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature',
      }) as Record<string, unknown>;

      expect(result.authorization).not.toContain(
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
      );
    });

    it('should redact GitHub tokens in objects', () => {
      const result = redactValue({
        githubToken: 'ghp_1234567890abcdefghij12345',
      }) as Record<string, unknown>;

      expect(result.githubToken).not.toContain('ghp_1234567890abcdefghij12345');
    });

    it('should redact secrets in nested objects', () => {
      const result = redactValue({
        config: {
          database: {
            password: 'password=db-secret-password',
          },
          apiKey: 'api_key=secret-api-key-123',
        },
      });

      expect(JSON.stringify(result)).not.toContain('db-secret-password');
      expect(JSON.stringify(result)).not.toContain('secret-api-key-123');
    });

    it('should preserve normal object values', () => {
      const result = redactValue({
        port: 8088,
        host: 'localhost',
        workloadId: 'test-workload-123',
        status: 'running',
      }) as Record<string, unknown>;

      expect(result.port).toBe(8088);
      expect(result.host).toBe('localhost');
      expect(result.workloadId).toBe('test-workload-123');
      expect(result.status).toBe('running');
    });

    it('should redact passwords in URLs within objects', () => {
      const result = redactValue({
        connectionString: 'postgres://user:secret123@localhost:5432/db',
      }) as Record<string, unknown>;

      expect(result.connectionString).not.toContain('secret123');
      expect(result.connectionString).toContain('localhost');
    });
  });

  describe('arrays', () => {
    it('should redact secrets in arrays', () => {
      const result = redactValue([
        'ghp_token1234567890abcdefgh',
        'ghp_token2345678901bcdefghi',
      ]);

      expect(JSON.stringify(result)).not.toContain(
        'ghp_token1234567890abcdefgh',
      );
      expect(JSON.stringify(result)).not.toContain(
        'ghp_token2345678901bcdefghi',
      );
    });

    it('should preserve normal array values', () => {
      const result = redactValue(['normal', 'values', 123, true]);
      expect(result).toEqual(['normal', 'values', 123, true]);
    });

    it('should redact secrets in nested arrays', () => {
      const result = redactValue([
        ['password=secret1', 'normal'],
        ['password=secret2', 'visible'],
      ]);

      expect(JSON.stringify(result)).not.toContain('secret1');
      expect(JSON.stringify(result)).not.toContain('secret2');
    });

    it('should handle arrays of objects', () => {
      const result = redactValue([
        { token: 'ghp_abc123def456ghi789jkl' },
        { token: 'ghp_mno234pqr567stu890vwx' },
      ]);

      expect(JSON.stringify(result)).not.toContain('ghp_abc123def456ghi789jkl');
      expect(JSON.stringify(result)).not.toContain('ghp_mno234pqr567stu890vwx');
    });
  });

  describe('complex nested structures', () => {
    it('should handle deeply nested objects and arrays', () => {
      const result = redactValue({
        level1: {
          level2: {
            level3: {
              secrets: ['password=secret1', 'token=secret2'],
              config: {
                apiKey: 'api_key=secret3',
              },
            },
          },
        },
      });

      expect(JSON.stringify(result)).not.toContain('secret1');
      expect(JSON.stringify(result)).not.toContain('secret2');
      expect(JSON.stringify(result)).not.toContain('secret3');
    });

    it('should redact Azure storage keys in nested structures', () => {
      const result = redactValue({
        azure: {
          storageKey:
            'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmn==',
        },
      });

      expect(JSON.stringify(result)).not.toContain(
        'abcdefghijklmnopqrstuvwxyz',
      );
    });

    it('should redact GCP service account emails in nested structures', () => {
      const result = redactValue({
        gcp: {
          serviceAccount:
            'my-service-account@project-123.iam.gserviceaccount.com',
        },
      });

      expect(JSON.stringify(result)).not.toContain(
        'my-service-account@project-123.iam.gserviceaccount.com',
      );
    });
  });

  describe('recursion limits', () => {
    it('should handle deep nesting without infinite recursion', () => {
      const deepObject: any = { level: 0 };
      let current = deepObject;
      for (let i = 1; i <= 15; i++) {
        current.nested = { level: i };
        current = current.nested;
      }
      current.secret = 'password=secret123';

      const result = redactValue(deepObject);
      expect(result).toBeDefined();
      // Should include MAX_DEPTH_EXCEEDED for levels beyond depth 10
      expect(JSON.stringify(result)).toContain('[MAX_DEPTH_EXCEEDED]');
    });

    it('should stop recursion at MAX_DEPTH and not throw', () => {
      const deepObject: any = { level: 0 };
      let current = deepObject;
      for (let i = 1; i <= 20; i++) {
        current.nested = { level: i };
        current = current.nested;
      }

      expect(() => redactValue(deepObject)).not.toThrow();
    });
  });

  describe('realistic scenarios', () => {
    it('should redact multiple secrets in same string within object', () => {
      const result = redactValue({
        config: 'API_KEY=secret123 and PASSWORD=password456 configured',
      }) as Record<string, unknown>;

      expect(result.config).not.toContain('secret123');
      expect(result.config).not.toContain('password456');
    });

    it('should preserve timestamps and dates', () => {
      const result = redactValue({
        timestamp: '2025-01-15T10:30:00Z',
        date: '2025-01-15',
        startedAt: '2024-12-10T14:30:45.123456789Z',
      }) as Record<string, unknown>;

      expect(result.timestamp).toBe('2025-01-15T10:30:00Z');
      expect(result.date).toBe('2025-01-15');
      expect(result.startedAt).toBe('2024-12-10T14:30:45.123456789Z');
    });

    it('should handle error metadata with secrets', () => {
      const result = redactValue({
        id: 'test-123',
        error: 'Authentication failed: token ghp_abc123def456ghi789jkl invalid',
        version: '1.0.0',
      }) as Record<string, unknown>;

      expect(result.error).not.toMatch(/ghp_abc123def456ghi789jkl/);
      expect(result.id).toBe('test-123');
      expect(result.version).toBe('1.0.0');
    });

    it('should handle workload metadata with mixed content', () => {
      const result = redactValue({
        workloadId: 'deploy-123',
        state: 'running',
        credentials: {
          githubToken: 'ghp_secret123456789012345',
          azureKey:
            'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmn==',
        },
        vmCount: 3,
        region: 'us-east-1',
      });

      expect(JSON.stringify(result)).not.toContain('ghp_secret123456789012345');
      expect(JSON.stringify(result)).not.toContain(
        'abcdefghijklmnopqrstuvwxyz0123456789AB',
      );
      expect(JSON.stringify(result)).toContain('deploy-123');
      expect(JSON.stringify(result)).toContain('running');
      expect(JSON.stringify(result)).toContain('us-east-1');
    });
  });

  describe('Error objects', () => {
    it('should preserve Error message property (non-enumerable)', () => {
      // Simulate AWS SDK error
      const awsError = Object.assign(new Error('UnknownError'), {
        Code: 'AccessDenied',
        $metadata: { httpStatusCode: 403 },
        $fault: 'client',
      });

      const result = redactValue({ error: awsError }) as Record<
        string,
        unknown
      >;
      const errorObj = result.error as Record<string, unknown>;

      // The message property should be preserved even though it's non-enumerable
      expect(errorObj.message).toBe('UnknownError');
      expect(errorObj.name).toBe('Error');
      // Custom AWS properties should also be preserved
      expect(errorObj.Code).toBe('AccessDenied');
      expect(errorObj.$metadata).toEqual({ httpStatusCode: 403 });
      expect(errorObj.$fault).toBe('client');
    });

    it('should handle Error objects with empty message', () => {
      const error = Object.assign(new Error(''), { Code: 'TestCode' });

      const result = redactValue({ error: error }) as Record<string, unknown>;
      const errorObj = result.error as Record<string, unknown>;

      expect(errorObj.message).toBe('');
      expect(errorObj.Code).toBe('TestCode');
    });

    it('should handle nested Error objects', () => {
      const innerError = new Error('Inner error message');
      const outerError = new Error('Outer error message');
      outerError.cause = innerError;

      const result = redactValue({ error: outerError }) as Record<
        string,
        unknown
      >;
      const errorObj = result.error as Record<string, unknown>;

      expect(errorObj.message).toBe('Outer error message');
      expect(errorObj.cause).toBeDefined();
      const causeObj = errorObj.cause as Record<string, unknown>;
      expect(causeObj.message).toBe('Inner error message');
    });
  });
});

describe('isSecretKey', () => {
  describe('password keys', () => {
    it('should detect password keys', () => {
      expect(isSecretKey('password')).toBe(true);
      expect(isSecretKey('PASSWORD')).toBe(true);
      expect(isSecretKey('user_password')).toBe(true);
      expect(isSecretKey('passwd')).toBe(true);
    });
  });

  describe('token keys', () => {
    it('should detect token keys', () => {
      expect(isSecretKey('token')).toBe(true);
      expect(isSecretKey('TOKEN')).toBe(true);
      expect(isSecretKey('access_token')).toBe(true);
      expect(isSecretKey('github_token')).toBe(true);
      expect(isSecretKey('refresh_token')).toBe(true);
    });
  });

  describe('API key variations', () => {
    it('should detect API key variations', () => {
      expect(isSecretKey('api_key')).toBe(true);
      expect(isSecretKey('apikey')).toBe(true);
      expect(isSecretKey('API-KEY')).toBe(true);
      expect(isSecretKey('API_KEY')).toBe(true);
    });
  });

  describe('secret keys', () => {
    it('should detect secret keys', () => {
      expect(isSecretKey('secret')).toBe(true);
      expect(isSecretKey('SECRET')).toBe(true);
      expect(isSecretKey('client_secret')).toBe(true);
      expect(isSecretKey('app_secret')).toBe(true);
    });
  });

  describe('auth and bearer keys', () => {
    it('should detect auth keys', () => {
      expect(isSecretKey('auth_token')).toBe(true);
      expect(isSecretKey('AUTH_TOKEN')).toBe(true);
      expect(isSecretKey('auth-header')).toBe(true);
      expect(isSecretKey('oauth')).toBe(true);
      expect(isSecretKey('basic_auth')).toBe(true);
    });

    it('should not flag broad auth-like keys', () => {
      expect(isSecretKey('author')).toBe(false);
      expect(isSecretKey('authorization_count')).toBe(false);
    });

    it('should detect bearer keys', () => {
      expect(isSecretKey('bearer')).toBe(true);
      expect(isSecretKey('bearer_token')).toBe(true);
    });
  });

  describe('access keys', () => {
    it('should detect access-related secret keys', () => {
      expect(isSecretKey('access_key')).toBe(true);
      expect(isSecretKey('ACCESS_TOKEN')).toBe(true);
      expect(isSecretKey('access_secret')).toBe(true);
    });

    it('should not flag non-secret access keys', () => {
      expect(isSecretKey('accessed_at')).toBe(false);
      expect(isSecretKey('access_count')).toBe(false);
      expect(isSecretKey('last_access')).toBe(false);
    });
  });

  describe('safe keys', () => {
    it('should not flag safe environment variables', () => {
      expect(isSecretKey('PORT')).toBe(false);
      expect(isSecretKey('HOST')).toBe(false);
      expect(isSecretKey('NODE_ENV')).toBe(false);
      expect(isSecretKey('WORKLOAD_ID')).toBe(false);
      expect(isSecretKey('LOG_LEVEL')).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should handle empty strings', () => {
      expect(isSecretKey('')).toBe(false);
    });

    it('should handle special characters', () => {
      expect(isSecretKey('MY-API-KEY')).toBe(true);
      expect(isSecretKey('my.password')).toBe(true);
    });
  });
});

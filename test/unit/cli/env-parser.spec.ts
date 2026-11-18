import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { parseEnvFile, parseEnvFlags } from '../../../src/cli/utils/env-parser';

const TEST_ENV_FILE = join(process.cwd(), 'test-env-parser.env');

describe('parseEnvFile', () => {
  afterEach(() => {
    // Clean up test file if it exists
    if (existsSync(TEST_ENV_FILE)) {
      unlinkSync(TEST_ENV_FILE);
    }
  });

  it('should parse valid .env file with multiple variables', () => {
    const content = `
DATABASE_URL=postgresql://localhost:5432/test
API_KEY=test-key-12345
DEBUG=true
MAX_WORKERS=10
`;
    writeFileSync(TEST_ENV_FILE, content);

    const result = parseEnvFile(TEST_ENV_FILE);

    expect(result).toEqual({
      DATABASE_URL: 'postgresql://localhost:5432/test',
      API_KEY: 'test-key-12345',
      DEBUG: 'true',
      MAX_WORKERS: '10',
    });
  });

  it('should handle comments and empty lines', () => {
    const content = `
# This is a comment
DATABASE_URL=postgresql://localhost:5432/test

# Another comment
API_KEY=test-key
`;
    writeFileSync(TEST_ENV_FILE, content);

    const result = parseEnvFile(TEST_ENV_FILE);

    expect(result).toEqual({
      DATABASE_URL: 'postgresql://localhost:5432/test',
      API_KEY: 'test-key',
    });
  });

  it('should handle quoted values', () => {
    const content = `
SINGLE_QUOTED='value with spaces'
DOUBLE_QUOTED="another value"
UNQUOTED=simple
`;
    writeFileSync(TEST_ENV_FILE, content);

    const result = parseEnvFile(TEST_ENV_FILE);

    expect(result.SINGLE_QUOTED).toBeDefined();
    expect(result.DOUBLE_QUOTED).toBeDefined();
    expect(result.UNQUOTED).toBe('simple');
  });

  it('should return empty object for file with only comments', () => {
    const content = `
# Comment 1
# Comment 2
# Comment 3
`;
    writeFileSync(TEST_ENV_FILE, content);

    const result = parseEnvFile(TEST_ENV_FILE);

    expect(result).toEqual({});
  });

  it('should return empty object for empty file', () => {
    writeFileSync(TEST_ENV_FILE, '');

    const result = parseEnvFile(TEST_ENV_FILE);

    expect(result).toEqual({});
  });

  it('should handle special characters in values', () => {
    const content = `
URL=https://example.com/path?query=value&other=123
SPECIAL_CHARS=!@#$%^&*()
`;
    writeFileSync(TEST_ENV_FILE, content);

    const result = parseEnvFile(TEST_ENV_FILE);

    expect(result.URL).toBe('https://example.com/path?query=value&other=123');
    expect(result.SPECIAL_CHARS).toBeDefined();
  });

  it('should throw error for non-existent file', () => {
    expect(() => {
      parseEnvFile('non-existent-file.env');
    }).toThrow('Environment file not found');
  });

  it('should parse complex ML workflow env file with bash commands', () => {
    const content = `OUTPUT_DIR=/mnt/example-bucket/run_5_branch_test
CHECKOUT_BRANCH=git config --global url."https://\${GITHUB_TOKEN}@github.com/".insteadOf "git@github.com:" && git fetch && git checkout feature/branch_test && git pull
CONDA_ACTIVATE=source /opt/conda/etc/profile.d/conda.sh && conda activate ml
CORE_CMD=python scripts/train.py output.dir=$OUTPUT_DIR
CMD=mkdir -p "$OUTPUT_DIR" && eval "$CHECKOUT_BRANCH"  && set -o pipefail && eval "$CONDA_ACTIVATE" && ( eval "$CORE_CMD" ) 2>&1 | tee $OUTPUT_DIR/log_$(date +%Y-%m-%d_%H-%M-%S).txt`;
    writeFileSync(TEST_ENV_FILE, content);

    const result = parseEnvFile(TEST_ENV_FILE);

    expect(result.OUTPUT_DIR).toBe('/mnt/example-bucket/run_5_branch_test');
    expect(result.CHECKOUT_BRANCH).toContain('git fetch');
    expect(result.CONDA_ACTIVATE).toContain('conda activate ml');
    expect(result.CORE_CMD).toContain('train.py');
    expect(result.CMD).toContain('tee');
    expect(Object.keys(result)).toHaveLength(5);
  });

  it('should handle relative paths', () => {
    const content = 'TEST_VAR=value';
    writeFileSync(TEST_ENV_FILE, content);

    // Use relative path
    const result = parseEnvFile('test-env-parser.env');

    expect(result).toEqual({ TEST_VAR: 'value' });
  });
});

describe('parseEnvFlags', () => {
  // Save original env
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset process.env to a clean state for testing
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    // Restore original env
    process.env = originalEnv;
  });

  it('should parse single KEY=VALUE format', () => {
    const result = parseEnvFlags(['API_KEY=secret123']);

    expect(result).toEqual({
      API_KEY: 'secret123',
    });
  });

  it('should parse multiple KEY=VALUE formats', () => {
    const result = parseEnvFlags([
      'API_KEY=secret123',
      'DEBUG=true',
      'PORT=8080',
    ]);

    expect(result).toEqual({
      API_KEY: 'secret123',
      DEBUG: 'true',
      PORT: '8080',
    });
  });

  it('should parse KEY format from process.env', () => {
    process.env.TEST_VAR = 'from-shell';

    const result = parseEnvFlags(['TEST_VAR']);

    expect(result).toEqual({
      TEST_VAR: 'from-shell',
    });
  });

  it('should parse mixed KEY and KEY=VALUE formats', () => {
    process.env.SHELL_VAR = 'from-shell';

    const result = parseEnvFlags([
      'SHELL_VAR',
      'EXPLICIT_VAR=explicit-value',
      'ANOTHER=test',
    ]);

    expect(result).toEqual({
      SHELL_VAR: 'from-shell',
      EXPLICIT_VAR: 'explicit-value',
      ANOTHER: 'test',
    });
  });

  it('should handle values with equals signs', () => {
    const result = parseEnvFlags([
      'DATABASE_URL=postgres://user:pass@host/db?key=value',
    ]);

    expect(result.DATABASE_URL).toBe('postgres://user:pass@host/db?key=value');
  });

  it('should handle empty values (for clearing env vars)', () => {
    const result = parseEnvFlags(['EMPTY_VAR=']);

    expect(result).toEqual({
      EMPTY_VAR: '',
    });
  });

  it('should allow empty values to override non-empty values', () => {
    const result = parseEnvFlags(['VAR=initial', 'VAR=']);

    expect(result).toEqual({
      VAR: '',
    });
  });

  it('should handle values with spaces', () => {
    const result = parseEnvFlags(['MESSAGE=Hello World']);

    expect(result).toEqual({
      MESSAGE: 'Hello World',
    });
  });

  it('should collapse newlines to spaces in KEY=VALUE format', () => {
    const result = parseEnvFlags([
      'CMD=mkdir -p /tmp/dir &&\ntouch /tmp/dir/file',
    ]);

    expect(result).toEqual({
      CMD: 'mkdir -p /tmp/dir && touch /tmp/dir/file',
    });
  });

  it('should collapse newlines to spaces in KEY format from process.env', () => {
    process.env.MULTILINE_VAR = 'line1\nline2\nline3';

    const result = parseEnvFlags(['MULTILINE_VAR']);

    expect(result).toEqual({
      MULTILINE_VAR: 'line1 line2 line3',
    });
  });

  it('should handle special characters in values', () => {
    const result = parseEnvFlags([
      'SPECIAL=!@#$%^&*()',
      'URL=https://example.com/path?query=value&other=123',
    ]);

    expect(result.SPECIAL).toBe('!@#$%^&*()');
    expect(result.URL).toBe('https://example.com/path?query=value&other=123');
  });

  it('should throw error for KEY format when variable not in process.env', () => {
    expect(() => {
      parseEnvFlags(['NONEXISTENT_VAR']);
    }).toThrow('Environment variable "NONEXISTENT_VAR" not found');
  });

  it('should throw error for empty key in KEY=VALUE format', () => {
    expect(() => {
      parseEnvFlags(['=value']);
    }).toThrow('Invalid -e flag format: "=value" (missing key)');
  });

  it('should throw error for empty string', () => {
    expect(() => {
      parseEnvFlags(['']);
    }).toThrow('Invalid -e flag: empty key');
  });

  it('should handle later values overriding earlier ones', () => {
    const result = parseEnvFlags(['VAR=first', 'VAR=second', 'VAR=third']);

    expect(result).toEqual({
      VAR: 'third',
    });
  });

  it('should return empty object for empty array', () => {
    const result = parseEnvFlags([]);

    expect(result).toEqual({});
  });

  it('should merge with env file vars (integration test)', () => {
    process.env.SHELL_SECRET = 'secret-from-shell';

    // Simulate env file vars
    const envFileVars = {
      API_KEY: 'from-file',
      DATABASE_URL: 'postgres://from-file',
    };

    // Parse -e flags
    const envFlags = parseEnvFlags([
      'SHELL_SECRET', // Read from shell
      'API_KEY=overridden', // Override file
      'NEW_VAR=only-in-flag', // New var
    ]);

    // Merge with -e taking precedence
    const merged = { ...envFileVars, ...envFlags };

    expect(merged).toEqual({
      DATABASE_URL: 'postgres://from-file', // from file (not overridden)
      API_KEY: 'overridden', // from flag (overridden)
      SHELL_SECRET: 'secret-from-shell', // from flag (new)
      NEW_VAR: 'only-in-flag', // from flag (new)
    });
  });
});

import { describe, expect, it } from 'vitest';
import { errorForDiagnosticMetadata } from '../../../src/shared/log-diagnostics';
import { redactValue } from '../../../src/api/services/redact';

describe('errorForDiagnosticMetadata', () => {
  it('preserves Docker pull diagnostics without copying arbitrary fields', () => {
    const error = Object.assign(new Error('pull failed'), {
      name: 'PullError',
      pullStdout: 'manifest unknown',
      pullStderr: 'denied: requested access to the resource is denied',
      elapsedMs: 1234,
      diskSpace: 'Filesystem Size Used Avail Use%',
      token: 'should-not-be-persisted',
    });

    expect(errorForDiagnosticMetadata(error)).toEqual({
      message: 'pull failed',
      name: 'PullError',
      pullStdout: 'manifest unknown',
      pullStderr: 'denied: requested access to the resource is denied',
      elapsedMs: 1234,
      diskSpace: 'Filesystem Size Used Avail Use%',
    });
  });

  it('preserves command output and low-risk status fields', () => {
    const error = Object.assign(new Error('ssh failed'), {
      name: 'SSHExecError',
      stdout: 'stdout tail',
      stderr: 'stderr tail',
      exitCode: 1,
      code: 'ECONNRESET',
      statusCode: 503,
    });

    expect(errorForDiagnosticMetadata(error)).toEqual({
      message: 'ssh failed',
      name: 'SSHExecError',
      stdout: 'stdout tail',
      stderr: 'stderr tail',
      exitCode: 1,
      code: 'ECONNRESET',
      statusCode: 503,
    });
  });

  it('caps a runaway message so one event cannot bloat the row', () => {
    // The cap exists because unbounded messages once bloated these rows. It
    // belongs here rather than at each call site, so no boundary forgets it.
    const persisted = errorForDiagnosticMetadata(new Error('x'.repeat(50_000)));

    expect(JSON.stringify(persisted).length).toBeLessThan(4_000);
  });

  it('cannot leak a field nobody registered', () => {
    // Allow-list, not deny-list: an error class added later carries whatever
    // its author put on it, and no strip-list gets updated for it.
    class ImagePullError extends Error {
      constructor(
        message: string,
        public manifest: unknown,
      ) {
        super(message);
        this.name = 'ImagePullError';
      }
    }
    const persisted = errorForDiagnosticMetadata(
      new ImagePullError('pull failed', { layers: Array(400).fill('sha256') }),
    );

    expect(persisted).not.toHaveProperty('manifest');
    expect(persisted).not.toHaveProperty('stack');
    expect(JSON.stringify(persisted).length).toBeLessThan(200);
  });

  it('keeps the fields of a thrown value that is not an Error', () => {
    const persisted = errorForDiagnosticMetadata({
      code: 'ECONNRESET',
      detail: 'peer closed connection',
    });

    expect(String(persisted)).toContain('ECONNRESET');
    expect(String(persisted)).not.toBe('[object Object]');
  });

  it('bounds a thrown value that is not an Error', () => {
    // The cap is not just about Error.message: a step may reject with an
    // object, and stringifying it unbounded puts the whole thing in the row.
    const persisted = errorForDiagnosticMetadata({
      detail: 'x'.repeat(60_000),
    });

    expect(JSON.stringify(persisted).length).toBeLessThan(4_000);
  });

  it('bounds a runaway error name as well as its message', () => {
    const persisted = errorForDiagnosticMetadata(
      Object.assign(new Error('short'), { name: 'N'.repeat(5_000) }),
    );

    expect(JSON.stringify(persisted).length).toBeLessThan(1_000);
  });
});

describe('redactValue on errors', () => {
  it('keeps the breadth a log needs, unlike the persisted allow-list', () => {
    // Deliberately different from errorForDiagnosticMetadata. A cloud SDK error
    // carries its diagnosis in fields no allow-list would name — AWS puts it in
    // Code, $fault and $metadata — and a cause chain is an Error, not a scalar.
    // The logging boundary wants those; the persisted one is bounded by its own
    // serializer and does not rely on this.
    const awsError = Object.assign(new Error('UnknownError'), {
      Code: 'AccessDenied',
      $metadata: { httpStatusCode: 403 },
      cause: new Error('inner'),
    });

    const redacted = redactValue({ error: awsError }) as Record<
      string,
      unknown
    >;
    const errorObj = redacted.error as Record<string, unknown>;

    expect(errorObj.Code).toBe('AccessDenied');
    expect(errorObj.$metadata).toEqual({ httpStatusCode: 403 });
    expect(errorObj.cause).toBeDefined();
  });

  it('still redacts secrets inside an error it copies', () => {
    const jwt = `eyJ${'a'.repeat(40)}`;
    const error = Object.assign(new Error(`bearer ${jwt} leaked`), {
      name: 'CredentialError',
    });

    expect(JSON.stringify(redactValue({ error }))).not.toContain(jwt);
  });
});

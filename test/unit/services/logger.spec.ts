import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies before importing logger
vi.mock('../../../src/api/config.js', () => ({
  default: { debug: true },
}));

import { log } from '../../../src/api/services/logger.js';
import {
  MAX_LOGGED_ERROR_MESSAGE_CHARS,
  MAX_LOGGED_ERROR_STACK_CHARS,
} from '../../../src/shared/log-diagnostics.js';

describe('Logger', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleDebugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleDebugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('info', () => {
    it('should log message with INFO level', () => {
      log.info('test message');
      expect(consoleLogSpy).toHaveBeenCalledOnce();
      const output = JSON.parse(String(consoleLogSpy.mock.calls[0][0]));
      expect(output.level).toBe('INFO');
      expect(output.message).toBe('test message');
    });

    it('should include metadata', () => {
      log.info('test message', { foo: 'bar', count: 42 });
      const output = JSON.parse(String(consoleLogSpy.mock.calls[0][0]));
      expect(output.foo).toBe('bar');
      expect(output.count).toBe(42);
    });
  });

  describe('warn', () => {
    it('should log message with WARN level', () => {
      log.warn('warning message');
      expect(consoleWarnSpy).toHaveBeenCalledOnce();
      const output = JSON.parse(String(consoleWarnSpy.mock.calls[0][0]));
      expect(output.level).toBe('WARN');
      expect(output.message).toBe('warning message');
    });
  });

  describe('debug', () => {
    it('should log message with DEBUG level when debug enabled', () => {
      log.debug('debug message');
      expect(consoleDebugSpy).toHaveBeenCalledOnce();
      const output = JSON.parse(String(consoleDebugSpy.mock.calls[0][0]));
      expect(output.level).toBe('DEBUG');
      expect(output.message).toBe('debug message');
    });
  });

  describe('error', () => {
    it('should log message with ERROR level', () => {
      log.error('error message', { id: 'test-123', error: 'something failed' });
      expect(consoleErrorSpy).toHaveBeenCalledOnce();
      const output = JSON.parse(String(consoleErrorSpy.mock.calls[0][0]));
      expect(output.level).toBe('ERROR');
      expect(output.message).toBe('error message');
      expect(output.error).toBe('something failed');
    });

    it('should serialize Error objects', () => {
      const err = new Error('test error');
      err.name = 'TestError';

      log.error('caught error', { id: 'test-123', error: err });

      const output = JSON.parse(String(consoleErrorSpy.mock.calls[0][0]));
      expect(output.error.message).toBe('test error');
      expect(output.error.name).toBe('TestError');
    });

    it('should handle circular references in error objects', () => {
      // Create object with circular reference
      const circular: any = { name: 'circular' };
      circular.self = circular;

      // Should not throw
      expect(() => {
        log.error('circular error', { id: 'test-123', error: circular });
      }).not.toThrow();

      expect(consoleErrorSpy).toHaveBeenCalledOnce();
    });

    it('should preserve string errors as-is', () => {
      log.error('string error', { id: 'test-123', error: 'plain string' });

      const output = JSON.parse(String(consoleErrorSpy.mock.calls[0][0]));
      expect(output.error).toBe('plain string');
    });

    it('should include version when provided', () => {
      log.error('versioned error', {
        id: 'test-123',
        error: 'failed',
        version: '1.2.3',
      });

      const output = JSON.parse(String(consoleErrorSpy.mock.calls[0][0]));
      expect(output.version).toBe('1.2.3');
    });

    it('bounds a pathological stack instead of writing it whole', () => {
      const error = new Error('boom');
      error.stack = 'x'.repeat(MAX_LOGGED_ERROR_STACK_CHARS * 3);

      log.error('deep failure', { id: 'test-123', error });

      const output = JSON.parse(String(consoleErrorSpy.mock.calls[0][0]));
      expect(String(output.error.stack)).toContain('[truncated');
      // A log line is not a place to write a megabyte, and nothing downstream
      // of the logger measures what it is handed.
      expect(String(output.error.stack).length).toBeLessThan(
        MAX_LOGGED_ERROR_STACK_CHARS + 200,
      );
    });

    it('bounds a message built in a retry loop', () => {
      const error = new Error('y'.repeat(MAX_LOGGED_ERROR_MESSAGE_CHARS * 2));

      log.error('long message', { id: 'test-123', error });

      const output = JSON.parse(String(consoleErrorSpy.mock.calls[0][0]));
      expect(String(output.error.message)).toContain('[truncated');
    });

    it('leaves an ordinary error untouched', () => {
      log.error('ordinary', { id: 'test-123', error: new Error('boom') });

      const output = JSON.parse(String(consoleErrorSpy.mock.calls[0][0]));
      expect(output.error.message).toBe('boom');
      expect(String(output.error.stack)).not.toContain('[truncated');
    });

    it('bounds a cause chain as well as the error itself', () => {
      const root = new Error('z'.repeat(MAX_LOGGED_ERROR_MESSAGE_CHARS * 2));
      const wrapper = new Error('wrapper', { cause: root });

      log.error('wrapped', { id: 'test-123', error: wrapper });

      const output = JSON.parse(String(consoleErrorSpy.mock.calls[0][0]));
      expect(String(output.error.cause.message)).toContain('[truncated');
    });
  });
});

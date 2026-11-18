import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import {
  sendError,
  expressErrorHandler,
} from '../../../src/api/middleware/error-handler';
import {
  DeployError,
  ApiVersionMismatchError,
  MissingRequiredFieldsError,
} from '../../../src/shared/errors';

// Mock logger
vi.mock('../../../src/api/services/logger', () => ({
  log: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  },
}));

import { log } from '../../../src/api/services/logger';

describe('error-handler middleware', () => {
  const createMockRes = (): Partial<Response> => {
    const res: Partial<Response> = {
      headersSent: false,
    };
    res.status = vi.fn().mockReturnValue(res);
    res.send = vi.fn().mockReturnValue(res);
    res.json = vi.fn().mockReturnValue(res);
    return res;
  };

  const createMockReq = (path = '/test'): Partial<Request> => ({
    path,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('sendError', () => {
    it('should handle DeployError with correct status code', () => {
      const res = createMockRes();
      const err = new MissingRequiredFieldsError(['id', 'version']);

      sendError(res as Response, err);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        defined: true,
        code: 'REQUEST_FAILED',
        status: 400,
        message: expect.stringContaining('id'),
      });
    });

    it('should handle ApiVersionMismatchError', () => {
      const res = createMockRes();
      const err = new ApiVersionMismatchError('0.0.1', '1.0.0');

      sendError(res as Response, err);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'REQUEST_FAILED',
          message: expect.stringContaining('version mismatch'),
        }),
      );
    });

    it('should log error for non-warning DeployError', () => {
      const res = createMockRes();
      const err = new MissingRequiredFieldsError(['id']);

      sendError(res as Response, err, {
        version: 'v1.0.0',
        id: 'test-id',
      });

      expect(log.error).toHaveBeenCalled();
      expect(log.warn).not.toHaveBeenCalled();
    });

    it('should log warning for warning DeployError', () => {
      const res = createMockRes();
      // Create a warning error
      class WarningError extends DeployError {
        constructor() {
          super('This is a warning', 400, true);
        }
      }
      const err = new WarningError();

      sendError(res as Response, err);

      expect(log.warn).toHaveBeenCalled();
      expect(log.error).not.toHaveBeenCalled();
    });

    it('should handle uncategorized errors with 500', () => {
      const res = createMockRes();
      const err = new Error('Something went wrong');

      sendError(res as Response, err);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        defined: true,
        code: 'INTERNAL_SERVER_ERROR',
        status: 500,
        message: 'Internal server error',
      });
    });

    it('should handle errors with custom statusCode', () => {
      const res = createMockRes();
      const err = { message: 'Custom error', statusCode: 503 };

      sendError(res as Response, err);

      expect(res.status).toHaveBeenCalledWith(503);
    });

    it('should handle errors with status property', () => {
      const res = createMockRes();
      const err = { message: 'Custom error', status: 502 };

      sendError(res as Response, err);

      expect(res.status).toHaveBeenCalledWith(502);
    });

    it('should include version and id in log context', () => {
      const res = createMockRes();
      const err = new MissingRequiredFieldsError(['id']);

      sendError(res as Response, err, {
        version: 'v2.0.0',
        id: 'deploy-123',
      });

      expect(log.error).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          version: 'v2.0.0',
          id: 'deploy-123',
        }),
      );
    });
  });

  describe('expressErrorHandler', () => {
    it('should log error and return 500', () => {
      const req = createMockReq('/v1/workloads');
      const res = createMockRes();
      const next = vi.fn();
      const err = new Error('Unexpected error');

      expressErrorHandler(err, req as Request, res as Response, next);

      expect(log.error).toHaveBeenCalledWith(
        'Unhandled Express error',
        expect.objectContaining({
          error: 'Unexpected error',
          path: '/v1/workloads',
        }),
      );
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        defined: true,
        code: 'INTERNAL_SERVER_ERROR',
        status: 500,
        message: 'Internal server error',
      });
    });

    it('preserves parser status in a structured client error', () => {
      const req = createMockReq('/v1/workloads/id/exec');
      const res = createMockRes();
      const next = vi.fn();
      const err = Object.assign(new Error('Malformed JSON'), { status: 400 });

      expressErrorHandler(err, req as Request, res as Response, next);

      expect(res.json).toHaveBeenCalledWith({
        defined: true,
        code: 'REQUEST_INVALID',
        status: 400,
        message: 'Malformed JSON',
      });
    });

    it('should not send response if headers already sent', () => {
      const req = createMockReq();
      const res = createMockRes();
      (res as any).headersSent = true;
      const next = vi.fn();
      const err = new Error('Error after headers');

      expressErrorHandler(err, req as Request, res as Response, next);

      expect(log.error).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledWith(err);
    });

    it('should include stack trace in log', () => {
      const req = createMockReq();
      const res = createMockRes();
      const next = vi.fn();
      const err = new Error('Error with stack');

      expressErrorHandler(err, req as Request, res as Response, next);

      expect(log.error).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          stack: expect.stringContaining('Error: Error with stack'),
        }),
      );
    });
  });
});

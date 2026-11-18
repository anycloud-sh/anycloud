import type { Request, Response, NextFunction } from 'express';
import { DeployError } from '../../shared/errors.js';
import { log } from '../services/logger.js';
import type { User } from '../services/entities.js';
import { sendNativeApiError } from './native-validation.js';

export interface NativeErrorContext {
  code?: string;
  version?: string;
  id?: string;
  user?: User;
}

function errorDetails(error: unknown): {
  message: string | undefined;
  status: number;
} {
  const candidate =
    typeof error === 'object' && error !== null
      ? (error as {
          message?: unknown;
          status?: unknown;
          statusCode?: unknown;
        })
      : undefined;
  const rawStatus = candidate?.statusCode ?? candidate?.status;
  return {
    message:
      typeof candidate?.message === 'string' ? candidate.message : undefined,
    status:
      typeof rawStatus === 'number' && rawStatus >= 400 && rawStatus <= 599
        ? rawStatus
        : 500,
  };
}

/**
 * Send error response with proper logging and status codes.
 * Handles DeployError subclasses with their specific status codes,
 * and falls back to 500 for uncategorized errors.
 */
export function sendError(
  res: Response,
  err: unknown,
  context: NativeErrorContext = {},
): void {
  const { code, version, id, user } = context;
  if (err instanceof DeployError) {
    if (err.isWarning) {
      log.warn(err.message, { version, id, user, errorType: err.name });
    } else {
      log.error(err.message, {
        id: id || 'system',
        error: err.message,
        version,
        user,
        errorType: err.name,
      });
    }
    if (!res.headersSent) {
      sendNativeApiError(
        res,
        err.statusCode,
        code ?? 'REQUEST_FAILED',
        err.message,
      );
    }
    return;
  }

  const details = errorDetails(err);
  log.error('Uncategorized server error', {
    id: id || 'system',
    error: details.message ?? String(err),
    version,
    user,
    errorType: 'UncategorizedServerError',
  });
  if (!res.headersSent) {
    sendNativeApiError(
      res,
      details.status,
      code ?? 'INTERNAL_SERVER_ERROR',
      details.status >= 500
        ? 'Internal server error'
        : details.message || 'Request failed',
    );
  }
}

/**
 * Express error middleware for unhandled errors.
 * Must be registered last, after all routes.
 */
export function expressErrorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  log.error('Unhandled Express error', {
    id: 'system',
    error: err.message,
    stack: err.stack,
    path: req.path,
  });

  if (res.headersSent) {
    next(err);
    return;
  }

  const { status } = errorDetails(err);
  const code =
    status === 400
      ? 'REQUEST_INVALID'
      : status === 413
        ? 'PAYLOAD_TOO_LARGE'
        : 'INTERNAL_SERVER_ERROR';
  sendNativeApiError(
    res,
    status,
    code,
    status >= 500 ? 'Internal server error' : err.message,
  );
}

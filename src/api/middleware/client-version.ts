import type { Request, Response, NextFunction } from 'express';
import { ANYCLOUD_CLIENT_VERSION_HEADER } from '../../shared/api-version.js';
import { nativeRouteInventory } from '../../shared/api-contract/native-schemas.js';
import { ApiVersionMismatchError } from '../../shared/errors.js';
import {
  clientWindowVersionCheck,
  versionCheck,
} from '../services/api-version.js';
import { sendNativeApiError } from './native-validation.js';

/** Workload logs and exec take the client window; bucket content is exact. */
const CLIENT_WINDOW_ROUTES = [
  nativeRouteInventory.logs,
  nativeRouteInventory.exec,
].map(({ method, expressPath }) => ({
  method,
  path: new RegExp(`^${expressPath.replace(/:[^/]+/g, '[^/]+')}$`),
}));

export function requireCompatibleClientVersion(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const clientVersion = req.get(ANYCLOUD_CLIENT_VERSION_HEADER);
  try {
    if (
      CLIENT_WINDOW_ROUTES.some(
        (route) => route.method === req.method && route.path.test(req.path),
      )
    ) {
      clientWindowVersionCheck(clientVersion);
    } else {
      versionCheck(clientVersion);
    }
    res.locals.clientVersion = clientVersion;
    next();
  } catch (error) {
    if (error instanceof ApiVersionMismatchError) {
      sendNativeApiError(
        res,
        error.statusCode,
        'CLIENT_VERSION_MISMATCH',
        error.message,
      );
      return;
    }
    next(error);
  }
}

export function validatedClientVersion(res: Response): string {
  const version: unknown = res.locals.clientVersion;
  if (typeof version !== 'string') {
    throw new Error('Client version middleware did not run');
  }
  return version;
}

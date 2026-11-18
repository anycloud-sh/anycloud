import { randomBytes } from 'crypto';
import express, { type Request, type Response } from 'express';
import type { Server } from 'node:http';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import config from '../../../src/api/config';
import { createAuthenticationMiddleware } from '../../../src/api/middleware/validation';
import { createApiRequestTracker } from '../../../src/api/services/http-shutdown.js';
import { versionCheck } from '../../../src/api/services/api-version';
import Github from '../../../src/api/services/gateways/github';
import type { GithubSignIn } from '../../../src/api/services/entities';
import { testAuthenticate } from '../../helpers/test-authentication.js';
import {
  ApiAccessDeniedError,
  ApiVersionMismatchError,
  DeployError,
} from '../../../src/shared/errors';

describe('validation middleware', () => {
  beforeAll(() => {
    config.cipherKey = randomBytes(32).toString('hex');
  });

  describe('versionCheck', () => {
    it('does not throw for the current version', () => {
      expect(() => versionCheck(config.currVersion)).not.toThrow();
    });

    it('rejects a newer version', () => {
      const parts = config.currVersion.split('.');
      const newerVersion = `${parts[0]}.${parts[1]}.${parseInt(parts[2]) + 1}`;
      expect(() => versionCheck(newerVersion)).toThrow(ApiVersionMismatchError);
    });

    it('rejects an older version', () => {
      expect(() => versionCheck('0.0.1')).toThrow(ApiVersionMismatchError);
    });

    it('includes both versions in the error', () => {
      try {
        versionCheck('0.0.1');
        expect.fail('Should have thrown');
      } catch (error: any) {
        expect(error.message).toContain('0.0.1');
        expect(error.message).toContain(config.currVersion);
        expect(error.message).toContain('must exactly match');
        expect(error.statusCode).toBe(400);
      }
    });
  });

  describe('authenticate', () => {
    const authenticate = createAuthenticationMiddleware(
      createApiRequestTracker(),
      undefined,
      testAuthenticate,
    );
    const createMockRes = (): Partial<Response> => {
      const res: Partial<Response> = {};
      res.status = vi.fn().mockReturnValue(res);
      res.json = vi.fn().mockReturnValue(res);
      res.setHeader = vi.fn().mockReturnValue(res);
      return res;
    };

    it('rejects a body token when the Bearer header is absent', () => {
      const req: Partial<Request> = {
        headers: {},
        body: { accessToken: 'legacy-body-token' },
        query: {},
      };
      const res = createMockRes();
      const next = vi.fn();

      authenticate(req as Request, res as Response, next);

      expect(next).not.toHaveBeenCalled();
      expect(Github.authenticate).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({
        defined: true,
        code: 'UNAUTHORIZED',
        status: 401,
        message: 'Missing access token',
      });
    });

    it('preserves access-policy status in a structured error', async () => {
      vi.mocked(Github.authenticate).mockRejectedValueOnce(
        new ApiAccessDeniedError(),
      );
      const req: Partial<Request> = {
        headers: { authorization: 'Bearer test-token' },
        body: {},
        query: {},
      };
      const res = createMockRes();
      const next = vi.fn();

      await authenticate(req as Request, res as Response, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        defined: true,
        code: 'FORBIDDEN',
        status: 403,
        message: 'API access denied',
      });
    });

    it('normalizes other authentication failures to unauthorized', async () => {
      vi.mocked(Github.authenticate).mockRejectedValueOnce(
        new DeployError('Authentication request was invalid', 400),
      );
      const req: Partial<Request> = {
        headers: { authorization: 'Bearer test-token' },
        body: {},
        query: {},
      };
      const res = createMockRes();
      const next = vi.fn();

      await authenticate(req as Request, res as Response, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        defined: true,
        code: 'UNAUTHORIZED',
        status: 401,
        message: 'Authentication request was invalid',
      });
    });

    it('does not begin authentication after shutdown starts draining', async () => {
      const requests = createApiRequestTracker();
      requests.beginDrain();
      const middleware = createAuthenticationMiddleware(
        requests,
        undefined,
        testAuthenticate,
      );
      const res = createMockRes();
      const next = vi.fn();
      const req: Partial<Request> = {
        headers: { authorization: 'Bearer test-token' },
      };
      const callsBefore = vi.mocked(Github.authenticate).mock.calls.length;
      await middleware(req as Request, res as Response, next);
      expect(Github.authenticate).toHaveBeenCalledTimes(callsBefore);
      expect(next).not.toHaveBeenCalled();
      expect(requests.pending()).toEqual({});
      expect(res.status).toHaveBeenCalledWith(503);
    });

    it.each(['shutdown', 'disconnect'])(
      'retains raw authentication after %s until its work settles',
      async (kind) => {
        const requests = createApiRequestTracker();
        const shutdown = new AbortController();
        let release!: (user: GithubSignIn) => void;
        let entered!: () => void;
        const started = new Promise<void>((resolve) => {
          entered = resolve;
        });
        vi.mocked(Github.authenticate).mockImplementationOnce(
          (_token, signal) => {
            expect(signal).toBe(shutdown.signal);
            entered();
            return new Promise<GithubSignIn>((resolve) => {
              release = resolve;
            });
          },
        );
        const handler = vi.fn((_req: Request, res: Response) => res.end('ok'));
        const app = express();
        app.use(
          createAuthenticationMiddleware(
            requests,
            shutdown.signal,
            testAuthenticate,
          ),
        );
        app.get('/auth-probe', handler);
        const server = await new Promise<Server>((resolve) => {
          const listening = app.listen(0, '127.0.0.1', () =>
            resolve(listening),
          );
        });
        const address = server.address();
        if (!address || typeof address === 'string')
          throw new Error('No TCP port');
        const response = fetch(`http://127.0.0.1:${address.port}/auth-probe`, {
          headers: { authorization: 'Bearer test-token' },
        }).catch((error: unknown) => error);
        try {
          await started;
          requests.beginDrain();
          if (kind === 'shutdown') {
            shutdown.abort(new Error('API shutdown'));
            expect(await response).toMatchObject({ status: 503 });
          } else {
            server.closeAllConnections();
            await response;
          }
          expect(requests.pending()).toEqual({ authentication: 1 });
          let idle = false;
          const drained = requests.waitForIdle().then(() => {
            idle = true;
          });
          await Promise.resolve();
          expect(idle).toBe(false);
          expect(handler).not.toHaveBeenCalled();
          release({
            id: 'test-user',
            username: 'test-user',
            scopes: [],
          });
          await drained;
          expect(requests.pending()).toEqual({});
          expect(handler).not.toHaveBeenCalled();
        } finally {
          release?.({
            id: 'test-user',
            username: 'test-user',
            scopes: [],
          });
          await requests.waitForIdle();
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      },
    );
  });
});

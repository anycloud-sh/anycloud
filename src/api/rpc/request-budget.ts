import { ORPCError } from '@orpc/server';
import {
  assertRequestActive,
  awaitWithSignal,
  registerRequestDeadline,
  type RequestBudget,
} from '../services/request-budget.js';
import type { ApiContractMeta } from '../../shared/api-contract/base.js';
import type { ApiRpcContext } from './context.js';

export const API_REQUEST_BUDGET_MS = 30_000;

/**
 * A replay-safe query cut off by shutdown changed nothing: answer the declared
 * `API_RESTARTING`, which callers ride out, rather than a 500. A command keeps
 * the shutdown error: it may have acted, so "nothing ran" would be untrue.
 */
function shutdownReason(context: ApiRpcContext, meta: ApiContractMeta) {
  return meta.kind === 'query' && meta.replay === 'safe'
    ? new ORPCError('API_RESTARTING', {
        defined: true,
        status: 503,
        message: 'API server is restarting',
      })
    : context.shutdownSignal?.reason;
}

/** Share transport, authentication, and domain work under one elapsed budget. */
export async function withRequestBudget<T>(
  context: ApiRpcContext,
  signal: AbortSignal | undefined,
  meta: ApiContractMeta,
  execute: (operation: RequestBudget) => T | PromiseLike<T>,
): Promise<T> {
  if (context.operation) {
    assertRequestActive(context.operation.signal);
    return awaitWithSignal(
      Promise.resolve(execute(context.operation)),
      context.operation.signal,
    );
  }
  const startedAt = context.receivedAt ?? performance.now();
  const deadlineAt = startedAt + API_REQUEST_BUDGET_MS;
  const controller = new AbortController();
  const abortFromRequest = () => controller.abort(signal?.reason);
  const abortFromShutdown = () =>
    controller.abort(shutdownReason(context, meta));
  signal?.addEventListener('abort', abortFromRequest, { once: true });
  context.shutdownSignal?.addEventListener('abort', abortFromShutdown, {
    once: true,
  });
  if (signal?.aborted) abortFromRequest();
  if (context.shutdownSignal?.aborted) abortFromShutdown();
  const expire = () =>
    controller.abort(
      new ORPCError('TIMEOUT', {
        status: 504,
        message: 'API request deadline exceeded',
      }),
    );
  registerRequestDeadline(controller.signal, deadlineAt, expire);
  const timer = setTimeout(expire, Math.max(0, deadlineAt - performance.now()));
  const operation = { signal: controller.signal, startedAt, deadlineAt };
  try {
    assertRequestActive(operation.signal);
    return await awaitWithSignal(
      Promise.resolve(execute(operation)),
      operation.signal,
    );
  } finally {
    clearTimeout(timer);
    if (operation.signal.aborted) context.releaseIncompleteBody?.();
    signal?.removeEventListener('abort', abortFromRequest);
    context.shutdownSignal?.removeEventListener('abort', abortFromShutdown);
  }
}

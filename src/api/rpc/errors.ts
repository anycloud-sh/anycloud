import { ORPCError } from '@orpc/server';
import { DeployError } from '../../shared/errors.js';

/**
 * Translation from transport-free domain failures to the declared errors a
 * family exposes. Procedures own this mapping; domain services stay unaware of
 * it, and anything unmapped is rethrown so it remains an internal failure.
 */

/** Statuses the JSON boundary declares for expected domain failures. */
export type DeclaredErrorStatus = 400 | 404 | 409 | 503;

/** Declared error code a family raises for each status it can produce. */
export type DeclaredErrorCodes = Partial<Record<DeclaredErrorStatus, string>>;

/**
 * Fold a status-carrying `DeployError` onto a declared status. Only an explicit
 * conflict or unavailability keeps its own meaning; every other client error is
 * a rejection, and any other server error stays internal.
 */
function deployErrorStatus(
  error: DeployError,
): DeclaredErrorStatus | undefined {
  if (error.statusCode === 409) return 409;
  if (error.statusCode === 503) return 503;
  return error.statusCode >= 400 && error.statusCode < 500 ? 400 : undefined;
}

/** Raise the family's declared error for an already-resolved status. */
export function throwDeclaredError(
  cause: unknown,
  status: DeclaredErrorStatus,
  message: string,
  codes: DeclaredErrorCodes,
): never {
  const code = codes[status];
  if (code === undefined) throw cause;
  throw new ORPCError(code, { defined: true, status, message, cause });
}

/** Raise a family's declared error for a `DeployError`; rethrow anything else. */
export function throwDeclaredDeployError(
  error: unknown,
  codes: DeclaredErrorCodes,
): never {
  if (!(error instanceof DeployError)) throw error;
  const status = deployErrorStatus(error);
  if (status === undefined) throw error;
  throwDeclaredError(error, status, error.message, codes);
}

/** One domain-error class paired with the declared error it becomes. */
export interface DeclaredErrorMapping {
  readonly declaredFor: (error: unknown) => Error | undefined;
}

/**
 * Map a domain error class through an explicit builder, e.g. to attach typed
 * data or to claim only some instances. Returning undefined leaves the error to
 * the remaining mappings.
 */
export function declaredError<E extends Error>(
  ErrorClass: abstract new (...args: never[]) => E,
  toDeclared: (error: E) => Error | undefined,
): DeclaredErrorMapping {
  return {
    declaredFor: (error) =>
      error instanceof ErrorClass ? toDeclared(error) : undefined,
  };
}

/** The common case: a domain error becomes a declared error message verbatim. */
export function declaredAs(
  ErrorClass: abstract new (...args: never[]) => Error,
  factory: (options: { message: string; cause: Error }) => Error,
): DeclaredErrorMapping {
  return declaredError(ErrorClass, (error) =>
    factory({ message: error.message, cause: error }),
  );
}

/** Run a domain call, translating its declared failures on the way out. */
export async function mapDeclaredErrors<T>(
  operation: () => Promise<T>,
  mappings: readonly DeclaredErrorMapping[],
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    for (const mapping of mappings) {
      const declared = mapping.declaredFor(error);
      if (declared) throw declared;
    }
    throw error;
  }
}

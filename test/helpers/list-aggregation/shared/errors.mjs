export function transportError(error, seen = new Set()) {
  if (!error || typeof error !== 'object') return { message: String(error) };
  if (seen.has(error)) return { message: '[circular cause]' };
  seen.add(error);
  return {
    name: error.name,
    message: error.message,
    code: error.code,
    ...(error.cause ? { cause: transportError(error.cause, seen) } : {}),
    ...(Array.isArray(error.errors)
      ? { errors: error.errors.map((e) => transportError(e, seen)) }
      : {}),
  };
}

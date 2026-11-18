function hasKubernetesErrorCode(error: unknown, code: number): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidates: unknown[] = [
    error,
    'response' in error ? error.response : undefined,
    'body' in error ? error.body : undefined,
  ];
  return candidates.some(
    (candidate) =>
      !!candidate &&
      typeof candidate === 'object' &&
      (('statusCode' in candidate && candidate.statusCode === code) ||
        ('code' in candidate && candidate.code === code)),
  );
}

export function isKubernetesNotFoundError(error: unknown): boolean {
  return hasKubernetesErrorCode(error, 404);
}

export function isKubernetesConflictError(error: unknown): boolean {
  return hasKubernetesErrorCode(error, 409);
}

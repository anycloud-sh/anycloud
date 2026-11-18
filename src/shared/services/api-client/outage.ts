const MAX_DIAGNOSTIC_BODY_CHARS = 500;
const DIAGNOSTIC_HEADER_NAMES = [
  'cf-ray',
  'cf-error-type',
  'retry-after',
] as const;

export type ApiUnavailableGuidance = 'retry' | 'verify';

export interface ApiUnavailableDiagnostics {
  body?: string;
  headers?: Record<string, string>;
}

function boundedBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return '';
  return trimmed.length > MAX_DIAGNOSTIC_BODY_CHARS
    ? `${trimmed.slice(0, MAX_DIAGNOSTIC_BODY_CHARS)}… (${trimmed.length} bytes total)`
    : trimmed;
}

export function summarizeErrorBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return '';
  if (/^<!doctype|^<html/i.test(trimmed)) {
    return `<HTML error page (${trimmed.length} bytes) — is your anycloud API URL correct?>`;
  }
  return boundedBody(trimmed);
}

export function temporaryApiUnavailableMessage(
  status: number,
  guidance: ApiUnavailableGuidance,
): string {
  const prefix = `The API is temporarily unavailable (HTTP ${status}). It may be restarting or updating`;
  return guidance === 'retry'
    ? `${prefix}; try again shortly.`
    : `${prefix}. Check whether the operation completed before retrying.`;
}

export function apiUnavailableDiagnostics(
  response: Response,
  body: string,
): ApiUnavailableDiagnostics {
  const headers: Record<string, string> = {};
  for (const name of DIAGNOSTIC_HEADER_NAMES) {
    const value = response.headers.get(name);
    if (value) headers[name] = value;
  }

  const bounded = boundedBody(body);
  return {
    ...(bounded ? { body: bounded } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
}

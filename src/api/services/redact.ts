/**
 * Centralized secret redaction — cloud credentials only.
 * Targets specific, well-known credential formats to avoid
 * false positives on workload IDs, bucket names, etc.
 */

import { SECRET_KEY_PATTERNS } from '../../shared/secret-keys.js';

/** Pre-compiled regex patterns for key=value matching */
const COMPILED_KEY_VALUE_PATTERNS = SECRET_KEY_PATTERNS.map((pattern) => ({
  regex: new RegExp(
    `([\\w-]*${pattern.source}[\\w-]*)\\s*[=:]\\s*['"]?((?:(?![&;][A-Za-z0-9_.-]+=)[^\\s'"])+)['"]?`,
    'gi',
  ),
}));

const SENSITIVE_AWS_QUERY_PARAMS = [
  'AWSAccessKeyId',
  'SecurityToken',
  'Signature',
  'X-Amz-Credential',
  'X-Amz-Security-Token',
  'X-Amz-Signature',
] as const;

const SENSITIVE_AWS_QUERY_PARAM_RE = new RegExp(
  `([?&;](?:${SENSITIVE_AWS_QUERY_PARAMS.join('|')})=)([^\\s&#'"]+)`,
  'gi',
);

const SENSITIVE_AWS_KEY_VALUE_RE = new RegExp(
  `\\b((?:${SENSITIVE_AWS_QUERY_PARAMS.filter((name) => name !== 'Signature').join('|')}))\\s*[=:]\\s*['"]?([^\\s'"&]+)['"]?`,
  'gi',
);

/**
 * Redact cloud credentials from a string.
 * Only targets specific credential formats — no catch-all patterns.
 */
export function redactSecrets(value: string): string {
  let redacted = value;

  // JWT tokens (eyJ...)
  redacted = redacted.replace(/eyJ[A-Za-z0-9_-]{20,}/g, '<REDACTED_JWT>');

  // GitHub tokens (ghp_, gho_, ghr_, ghs_, ghu_, fine-grained github_pat_)
  redacted = redacted.replace(
    /(?:gh[oprsu]|github_pat)_[A-Za-z0-9_]{20,}/g,
    '<REDACTED_GH_TOKEN>',
  );

  // A hosted API's own tokens
  redacted = redacted.replace(
    /acapi_[A-Za-z0-9_-]{20,}/g,
    '<REDACTED_API_TOKEN>',
  );

  // Azure storage keys (88 base64 chars ending in ==)
  redacted = redacted.replace(/[A-Za-z0-9+/]{86}==/g, '<REDACTED_AZURE_KEY>');

  // GCP service account emails
  redacted = redacted.replace(
    /[\w-]+@[\w-]+\.iam\.gserviceaccount\.com/g,
    '<REDACTED_GCP_SA>',
  );

  // AWS access key IDs (AKIA...)
  redacted = redacted.replace(
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
    '<REDACTED_AWS_KEY>',
  );

  // AWS presigned URL params and rclone-emitted key/value diagnostics.
  redacted = redacted.replace(SENSITIVE_AWS_QUERY_PARAM_RE, '$1<REDACTED>');
  redacted = redacted.replace(SENSITIVE_AWS_KEY_VALUE_RE, '$1=<REDACTED>');

  // Bearer tokens
  redacted = redacted.replace(
    /Bearer\s+[A-Za-z0-9_-]{20,}/gi,
    'Bearer <REDACTED>',
  );

  // key=value patterns where key matches secret patterns
  for (const { regex } of COMPILED_KEY_VALUE_PATTERNS) {
    redacted = redacted.replace(regex, '$1=<REDACTED>');
  }

  // SSH private keys (OpenSSH and PEM formats)
  redacted = redacted.replace(
    /-----BEGIN[A-Z ]* PRIVATE KEY-----[\s\S]*?-----END[A-Z ]* PRIVATE KEY-----/g,
    '<REDACTED_SSH_KEY>',
  );

  // Passwords in URLs (://username:password@host)
  redacted = redacted.replace(/:\/\/([^:]+):([^@]+)@/g, '://$1:<REDACTED>@');

  return redacted;
}

/**
 * Recursively redact secrets from any value (strings, objects, arrays).
 * Used for sanitizing metadata before storing or logging.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  const MAX_DEPTH = 10;

  if (depth > MAX_DEPTH) {
    return '[MAX_DEPTH_EXCEEDED]';
  }

  if (typeof value === 'string') {
    return redactSecrets(value);
  }

  if (typeof value === 'object' && value !== null) {
    if (value instanceof Error) {
      // message and name are not own-enumerable, so the loop below never sees
      // them. Redact them explicitly or a secret in an error message is copied
      // out verbatim.
      const errorObj: Record<string, unknown> = {
        message: redactValue(value.message, depth + 1),
        name: redactValue(value.name, depth + 1),
      };
      for (const [key, val] of Object.entries(value)) {
        errorObj[key] = redactValue(val, depth + 1);
      }
      return errorObj;
    }

    if (Array.isArray(value)) {
      return value.map((item) => redactValue(item, depth + 1));
    }
    const redacted: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      redacted[key] = redactValue(val, depth + 1);
    }
    return redacted;
  }

  return value;
}

/**
 * Env-var key classification shared across api/services (for redaction) and
 * cli (for warning users about env vars that look like secrets).
 */

export const SECRET_KEY_PATTERNS = [
  /passw(or)?d/i, // password, passwd
  /^pw$/i, // pw
  /secret/i, // secret, client_secret
  /token/i, // token, access_token, github_token
  /api[._-]?key/i, // api_key, apikey, api-key
  /key$/i, // private_key, encryption_key
  /credential/i, // credentials
  /^auth[_-]/i, // auth_token, auth-header (but not "author")
  /[_-]auth$/i, // basic_auth, session_auth
  /^oauth$/i, // oauth (exact match)
  /bearer/i, // bearer
  /private[_-]key/i, // private_key, private-key (but not just "private")
  /certificate/i, // certificate
  /^ssh[_-]/i, // ssh_key, ssh-key (but not "sshd")
  /sshPrivateKey/i, // sshPrivateKey (camelCase)
  /ssh_private_key/i, // ssh_private_key (snake_case)
  /access[_-](key|token|secret)/i, // access_key, access_token (but not "accessed_at")
  /signing[_-]key/i, // signing_key, signing-key (but not "signing_up")
  /session[_-](id|token|secret)/i, // session_id, session_token (but not "session_count")
];

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

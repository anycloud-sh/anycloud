import { describe, expect, it } from 'vitest';
import {
  looksLikeHtmlBody,
  toGithubAuthError,
} from '../../../../src/api/services/gateways/github';
import { GithubUnavailableError } from '../../../../src/shared/errors';

// The GitHub "Unicorn!" 503 outage page: HTML, not JSON. Octokit surfaces the
// whole page as the RequestError message, which used to leak to the CLI.
const UNICORN_HTML =
  '<!DOCTYPE html>\n<html>\n  <head>\n    <title>Unicorn! &middot; GitHub</title>\n  </head>\n  <body>...</body>\n</html>';

// Minimal stand-in for an Octokit RequestError (name + numeric status + message).
function requestError(status: number, message: string): Error {
  const err = new Error(message);
  err.name = 'HttpError';
  Object.assign(err, { status });
  return err;
}

describe('looksLikeHtmlBody', () => {
  it('detects GitHub HTML outage pages', () => {
    expect(looksLikeHtmlBody(UNICORN_HTML)).toBe(true);
    expect(looksLikeHtmlBody('   <html><body>oops</body></html>')).toBe(true);
  });

  it('does not flag normal JSON-derived messages', () => {
    expect(looksLikeHtmlBody('Bad credentials')).toBe(false);
    expect(looksLikeHtmlBody('API rate limit exceeded')).toBe(false);
  });
});

describe('toGithubAuthError', () => {
  it('converts a 503 HTML outage page into a clean GithubUnavailableError', () => {
    const mapped = toGithubAuthError(requestError(503, UNICORN_HTML));
    expect(mapped).toBeInstanceOf(GithubUnavailableError);
    expect(mapped.message).not.toContain('<');
    expect(mapped.message).toContain('503');
    expect(mapped.message).toContain('GitHub');
  });

  it('converts any 5xx into GithubUnavailableError', () => {
    expect(toGithubAuthError(requestError(500, 'Server Error'))).toBeInstanceOf(
      GithubUnavailableError,
    );
  });

  it('converts a transport failure (Octokit reports status 500) too', () => {
    // Octokit wraps fetch/network failures as a RequestError with status 500.
    const mapped = toGithubAuthError(requestError(500, 'fetch failed'));
    expect(mapped).toBeInstanceOf(GithubUnavailableError);
  });

  it('catches an HTML body even on a non-5xx status (belt-and-suspenders)', () => {
    expect(toGithubAuthError(requestError(403, UNICORN_HTML))).toBeInstanceOf(
      GithubUnavailableError,
    );
  });

  it('passes a clean 4xx credential error through unchanged', () => {
    const original = requestError(401, 'Bad credentials');
    const mapped = toGithubAuthError(original);
    expect(mapped).toBe(original);
    expect(mapped).not.toBeInstanceOf(GithubUnavailableError);
  });

  it.each([
    [403, { 'x-ratelimit-remaining': '0' }, 'Forbidden'],
    [403, { 'retry-after': '60' }, 'Forbidden'],
    [403, {}, 'You have exceeded a secondary rate limit'],
    [429, {}, 'Too Many Requests'],
  ])(
    'turns a rate limit (%i %o %s) into a retryable GitHub unavailability',
    (status, headers, message) => {
      const mapped = toGithubAuthError(
        Object.assign(requestError(status, message), { response: { headers } }),
      );
      expect(mapped).toBeInstanceOf(GithubUnavailableError);
      expect(mapped.message).toContain("GitHub's API rate limit was reached");
    },
  );

  it('passes a 403 that is not a rate limit through', () => {
    const original = requestError(
      403,
      'Resource not accessible by integration',
    );
    expect(toGithubAuthError(original)).toBe(original);
  });

  it('handles non-Error throwables', () => {
    const mapped = toGithubAuthError('boom');
    expect(mapped).toBeInstanceOf(Error);
    expect(mapped.message).toBe('boom');
  });
});

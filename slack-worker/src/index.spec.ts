import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env, escapeHtml } from './index.js';

const ENV: Env = {
  SLACK_CLIENT_ID: 'client-id-123',
  SLACK_CLIENT_SECRET: 'client-secret-456',
};

function request(
  path: string,
  options: RequestInit = {},
  stateCookie?: string,
): Request {
  const headers = new Headers(options.headers);
  if (stateCookie) {
    headers.set('Cookie', `__Host-anycloud_slack_oauth_state=${stateCookie}`);
  }
  return new Request(`https://slack.anycloud.sh${path}`, {
    ...options,
    headers,
  });
}

function stateFromInstall(response: Response): {
  state: string;
  location: URL;
} {
  const location = new URL(response.headers.get('Location')!);
  return { state: location.searchParams.get('state')!, location };
}

function slackOAuthSuccess(
  webhookUrl = 'https://hooks.slack.com/services/T00000000/B00000000/secret_token',
): Response {
  return Response.json({
    ok: true,
    access_token: 'xoxb-must-not-be-rendered',
    incoming_webhook: { url: webhookUrl },
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('HTML rendering', () => {
  it('escapes text before inserting it into a page', () => {
    expect(escapeHtml(`<textarea>&"'`)).toBe(
      '&lt;textarea&gt;&amp;&quot;&#39;',
    );
  });
});

describe('GET /health', () => {
  it('reports readiness without exposing configuration', async () => {
    const response = await worker.fetch(request('/health'), ENV);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(response.headers.get('X-Robots-Tag')).toContain('noindex');
  });

  it('fails when the client secret is not configured', async () => {
    const response = await worker.fetch(request('/health'), {
      ...ENV,
      SLACK_CLIENT_SECRET: '',
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false });
  });
});

describe('GET /install', () => {
  it('redirects to Slack with the exact scope, callback, and fresh state', async () => {
    const response = await worker.fetch(request('/install'), ENV);
    const { state, location } = stateFromInstall(response);

    expect(response.status).toBe(302);
    expect(location.origin + location.pathname).toBe(
      'https://slack.com/oauth/v2/authorize',
    );
    expect(location.searchParams.get('client_id')).toBe(ENV.SLACK_CLIENT_ID);
    expect(location.searchParams.get('scope')).toBe('incoming-webhook');
    expect(location.searchParams.get('redirect_uri')).toBe(
      'https://slack.anycloud.sh/oauth/callback',
    );
    expect(state).toMatch(/^[a-f0-9]{64}$/);

    const cookie = response.headers.get('Set-Cookie')!;
    expect(cookie).toContain(`__Host-anycloud_slack_oauth_state=${state}`);
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Max-Age=600');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(location.toString()).not.toContain(ENV.SLACK_CLIENT_SECRET);
  });

  it('returns a safe 503 when OAuth is not configured', async () => {
    const response = await worker.fetch(request('/install'), {
      ...ENV,
      SLACK_CLIENT_ID: '',
    });
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(body).not.toContain(ENV.SLACK_CLIENT_SECRET);
  });
});

describe('GET /oauth/callback', () => {
  it('rejects a denied installation without contacting Slack', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const state = 'f'.repeat(64);

    const response = await worker.fetch(
      request(`/oauth/callback?error=access_denied&state=${state}`, {}, state),
      ENV,
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('Installation cancelled');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.headers.get('Set-Cookie')).toContain('Max-Age=0');
  });

  it('validates state before rendering a cancellation', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await worker.fetch(
      request('/oauth/callback?error=access_denied&state=forged'),
      ENV,
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('session expired');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['/oauth/callback?code=code-123', undefined],
    ['/oauth/callback?code=code-123&state=provided', undefined],
    ['/oauth/callback?code=code-123&state=provided', 'different'],
  ])('rejects an invalid session for %s', async (path, cookie) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await worker.fetch(request(path, {}, cookie), ENV);

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('session expired');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.headers.get('Set-Cookie')).toContain('Max-Age=0');
  });

  it('exchanges the code and renders a protected copy-and-paste handoff', async () => {
    const fetchMock = vi.fn(
      async (
        _input: string | URL | Request,
        _init?: RequestInit,
      ): Promise<Response> => slackOAuthSuccess(),
    );
    vi.stubGlobal('fetch', fetchMock);
    const state = 'a'.repeat(64);

    const response = await worker.fetch(
      request(`/oauth/callback?code=oauth-code&state=${state}`, {}, state),
      ENV,
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://slack.com/api/oauth.v2.access');
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('manual');
    const oauthBody = init?.body as URLSearchParams;
    expect(oauthBody.get('client_id')).toBe(ENV.SLACK_CLIENT_ID);
    expect(oauthBody.get('client_secret')).toBe(ENV.SLACK_CLIENT_SECRET);
    expect(oauthBody.get('code')).toBe('oauth-code');
    expect(oauthBody.get('redirect_uri')).toBe(
      'https://slack.anycloud.sh/oauth/callback',
    );

    expect(body).toContain('anycloud notifications connect slack');
    expect(body).toContain('anycloud notifications enable slack');
    expect(body).not.toContain('--webhook');
    expect(body).toContain('type="password"');
    expect(body).toContain('data-copy-webhook');
    expect(body).toContain(
      'https://hooks.slack.com/services/T00000000/B00000000/secret_token',
    );
    expect(body).not.toContain('xoxb-must-not-be-rendered');
    expect(body).not.toContain(ENV.SLACK_CLIENT_SECRET);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    const scriptNonce = body.match(/<script nonce="([a-f0-9]{64})">/)?.[1];
    expect(scriptNonce).toBeTruthy();
    const contentSecurityPolicy = response.headers.get(
      'Content-Security-Policy',
    );
    expect(contentSecurityPolicy).toContain("default-src 'none'");
    expect(contentSecurityPolicy).toContain(
      `script-src 'nonce-${scriptNonce}'`,
    );
    expect(contentSecurityPolicy).not.toContain("script-src 'unsafe-inline'");
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    expect(response.headers.get('Cross-Origin-Opener-Policy')).toBe(
      'same-origin',
    );
    expect(response.headers.get('Set-Cookie')).toContain('Max-Age=0');
  });

  it('returns a safe error when Slack cannot be reached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('down'))),
    );
    const state = 'b'.repeat(64);

    const response = await worker.fetch(
      request(`/oauth/callback?code=secret-code&state=${state}`, {}, state),
      ENV,
    );
    const body = await response.text();

    expect(response.status).toBe(502);
    expect(body).not.toContain('secret-code');
    expect(body).not.toContain(ENV.SLACK_CLIENT_SECRET);
  });

  it('returns a safe error for an unsuccessful Slack response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ok: false, error: 'invalid_code' })),
    );
    const state = 'c'.repeat(64);

    const response = await worker.fetch(
      request(`/oauth/callback?code=code&state=${state}`, {}, state),
      ENV,
    );
    const body = await response.text();

    expect(response.status).toBe(502);
    expect(body).not.toContain('invalid_code');
  });

  it('returns a safe error for malformed JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not json', { status: 200 })),
    );
    const state = 'd'.repeat(64);

    const response = await worker.fetch(
      request(`/oauth/callback?code=code&state=${state}`, {}, state),
      ENV,
    );

    expect(response.status).toBe(502);
    expect(await response.text()).toContain('unexpected response');
  });

  it.each([
    'http://hooks.slack.com/services/T/B/token',
    'https://evil.example/services/T/B/token',
    'https://hooks.slack.com.evil.example/services/T/B/token',
    'https://user@hooks.slack.com/services/T/B/token',
    'https://hooks.slack.com/services/T/B/token?leak=true',
    'https://hooks.slack.com/services/T/B',
    'https://hooks.slack.com/services/T//B/token',
    'https://hooks.slack.com/services/T/B/token/',
  ])('rejects an invalid webhook URL: %s', async (webhookUrl) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => slackOAuthSuccess(webhookUrl)),
    );
    const state = 'e'.repeat(64);

    const response = await worker.fetch(
      request(`/oauth/callback?code=code&state=${state}`, {}, state),
      ENV,
    );
    const body = await response.text();

    expect(response.status).toBe(502);
    expect(body).not.toContain(webhookUrl);
  });
});

describe('routing', () => {
  it('rejects non-GET requests', async () => {
    const response = await worker.fetch(
      request('/install', { method: 'POST' }),
      ENV,
    );

    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('GET');
  });

  it('returns a secured 404 page for unknown paths', async () => {
    const response = await worker.fetch(request('/unknown'), ENV);

    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
  });
});

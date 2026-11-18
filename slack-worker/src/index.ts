export interface Env {
  SLACK_CLIENT_ID: string;
  SLACK_CLIENT_SECRET: string;
}

const SLACK_AUTHORIZE_URL = 'https://slack.com/oauth/v2/authorize';
const SLACK_OAUTH_URL = 'https://slack.com/api/oauth.v2.access';
const REDIRECT_URI = 'https://slack.anycloud.sh/oauth/callback';
const STATE_COOKIE = '__Host-anycloud_slack_oauth_state';
const STATE_MAX_AGE_SECONDS = 10 * 60;

const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store, private, max-age=0',
  'Cross-Origin-Resource-Policy': 'same-origin',
  Pragma: 'no-cache',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
};

const HTML_SECURITY_HEADERS = {
  ...NO_STORE_HEADERS,
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'X-Frame-Options': 'DENY',
};

const COPY_SCRIPT = `
const copyButton = document.querySelector('[data-copy-webhook]');
const webhook = document.querySelector('[data-webhook]');
const copyStatus = document.querySelector('[data-copy-status]');

if (copyButton && webhook && copyStatus) {
  copyButton.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(webhook.value);
      copyButton.textContent = 'Copied';
      copyStatus.textContent = 'Webhook copied. Return to the terminal and paste it now.';
    } catch {
      webhook.focus();
      webhook.select();
      copyStatus.textContent = 'Copy the selected webhook, then return to the terminal.';
    }
  });
}
`;

type SlackOAuthResponse = {
  ok?: boolean;
  incoming_webhook?: {
    url?: unknown;
  };
};

function hasConfiguration(env: Env): boolean {
  return Boolean(
    env.SLACK_CLIENT_ID?.trim() && env.SLACK_CLIENT_SECRET?.trim(),
  );
}

function randomState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

function stateCookie(state: string): string {
  return `${STATE_COOKIE}=${state}; Path=/; Max-Age=${STATE_MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

function clearedStateCookie(): string {
  return `${STATE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

function cookieValue(request: Request, name: string): string | null {
  const cookie = request.headers.get('Cookie');
  if (!cookie) return null;

  for (const part of cookie.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return null;
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index++) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function isSlackWebhookUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  return (
    url.protocol === 'https:' &&
    url.hostname === 'hooks.slack.com' &&
    url.port === '' &&
    url.username === '' &&
    url.password === '' &&
    url.search === '' &&
    url.hash === '' &&
    /^\/services\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(
      url.pathname,
    )
  );
}

function page(title: string, content: string, scriptNonce: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)} · Anycloud</title>
    <style>
      :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      * { box-sizing: border-box; }
      body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: #07111f; color: #e2e8f0; padding: 24px; }
      main { width: min(680px, 100%); background: #0f172a; border: 1px solid #29415d; border-radius: 18px; padding: clamp(28px, 7vw, 52px); box-shadow: 0 24px 80px rgba(0, 0, 0, .35); }
      .mark { color: #22d3ee; font: 700 12px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .16em; text-transform: uppercase; }
      h1 { margin: 14px 0 12px; font-size: clamp(30px, 7vw, 46px); line-height: 1.06; letter-spacing: -.035em; }
      p { color: #b8c6d8; font-size: 16px; line-height: 1.65; }
      code { color: #cffafe; font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
      .webhook { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; margin: 18px 0 4px; }
      .webhook input { min-width: 0; padding: 13px 14px; border: 1px solid #3b526d; border-radius: 10px; background: #080d16; color: #cffafe; font: 14px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
      button { padding: 12px 18px; border: 0; border-radius: 10px; background: #22d3ee; color: #07111f; font: inherit; font-weight: 700; cursor: pointer; }
      button:hover { background: #67e8f9; }
      .copy-status { min-height: 24px; margin: 4px 0 14px; font-size: 14px; }
      .warning { padding: 12px 14px; border-left: 3px solid #f59e0b; background: rgba(245, 158, 11, .08); color: #fef3c7; }
      a { color: #67e8f9; }
      a:focus-visible, button:focus-visible, input:focus-visible { outline: 3px solid #22d3ee; outline-offset: 3px; }
      @media (max-width: 540px) { .webhook { grid-template-columns: 1fr; } }
    </style>
  </head>
  <body>
    <main>
      <div class="mark">Anycloud for Slack</div>
      ${content}
    </main>
    <script nonce="${escapeHtml(scriptNonce)}">${COPY_SCRIPT}</script>
  </body>
</html>`;
}

function htmlResponse(
  title: string,
  content: string,
  status = 200,
  clearState = false,
): Response {
  const scriptNonce = randomState();
  const headers = new Headers(HTML_SECURITY_HEADERS);
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.set(
    'Content-Security-Policy',
    `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${scriptNonce}'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  );
  if (clearState) headers.set('Set-Cookie', clearedStateCookie());
  return new Response(page(title, content, scriptNonce), { status, headers });
}

function errorResponse(
  title: string,
  message: string,
  status: number,
  clearState = false,
): Response {
  return htmlResponse(
    title,
    `<h1>${escapeHtml(title)}</h1>
     <p>${escapeHtml(message)}</p>
     <p><a href="/install">Start the installation again</a> or visit <a href="https://anycloud.sh/slack/support/">Anycloud support</a>.</p>`,
    status,
    clearState,
  );
}

function install(request: Request, env: Env): Response {
  if (!hasConfiguration(env)) {
    return errorResponse(
      'Installation temporarily unavailable',
      'The Slack integration is not fully configured. Please try again later.',
      503,
    );
  }

  const state = randomState();
  const authorizeUrl = new URL(SLACK_AUTHORIZE_URL);
  authorizeUrl.searchParams.set('client_id', env.SLACK_CLIENT_ID);
  authorizeUrl.searchParams.set('scope', 'incoming-webhook');
  authorizeUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authorizeUrl.searchParams.set('state', state);

  const headers = new Headers(NO_STORE_HEADERS);
  headers.set('Location', authorizeUrl.toString());
  headers.set('Set-Cookie', stateCookie(state));
  return new Response(null, { status: 302, headers });
}

async function callback(request: Request, env: Env): Promise<Response> {
  if (!hasConfiguration(env)) {
    return errorResponse(
      'Installation temporarily unavailable',
      'The Slack integration is not fully configured. Please try again later.',
      503,
      true,
    );
  }

  const url = new URL(request.url);
  const state = url.searchParams.get('state');
  const expectedState = cookieValue(request, STATE_COOKIE);
  if (!state || !expectedState || !constantTimeEqual(state, expectedState)) {
    return errorResponse(
      'Installation session expired',
      'The installation session is missing or invalid. Start again to request a fresh authorization.',
      400,
      true,
    );
  }

  if (url.searchParams.has('error')) {
    return errorResponse(
      'Installation cancelled',
      'Slack did not authorize the installation. No configuration was changed.',
      400,
      true,
    );
  }

  const code = url.searchParams.get('code');
  if (!code) {
    return errorResponse(
      'Installation session expired',
      'The installation session is missing or invalid. Start again to request a fresh authorization.',
      400,
      true,
    );
  }

  let response: Response;
  try {
    response = await fetch(SLACK_OAUTH_URL, {
      method: 'POST',
      // Never forward the client-secret-bearing body to a redirect target.
      // Cloudflare's production runtime can throw before issuing a request
      // when `redirect: "error"` is used for this endpoint, while `manual`
      // safely returns any 3xx response for the `response.ok` check below.
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.SLACK_CLIENT_ID,
        client_secret: env.SLACK_CLIENT_SECRET,
        code,
        redirect_uri: REDIRECT_URI,
      }),
    });
  } catch {
    return errorResponse(
      'Slack could not be reached',
      'The authorization exchange failed. No webhook was saved; please try again.',
      502,
      true,
    );
  }

  if (!response.ok) {
    return errorResponse(
      'Slack authorization failed',
      'Slack rejected the authorization exchange. No webhook was saved; please try again.',
      502,
      true,
    );
  }

  let payload: SlackOAuthResponse;
  try {
    payload = (await response.json()) as SlackOAuthResponse;
  } catch {
    return errorResponse(
      'Slack authorization failed',
      'Slack returned an unexpected response. No webhook was saved; please try again.',
      502,
      true,
    );
  }

  const webhookUrl = payload.incoming_webhook?.url;
  if (!payload.ok || !isSlackWebhookUrl(webhookUrl)) {
    return errorResponse(
      'Slack authorization failed',
      'Slack did not return a valid incoming webhook. No configuration was saved; please try again.',
      502,
      true,
    );
  }

  return htmlResponse(
    'Installation complete',
    `<h1>Return to your terminal</h1>
     <p>Slack authorized the selected channel. Copy the webhook below, then paste it into the hidden prompt opened by <code>anycloud notifications connect slack</code>.</p>
     <div class="webhook">
       <input type="password" readonly autocomplete="off" spellcheck="false" aria-label="Slack incoming-webhook URL" value="${escapeHtml(webhookUrl)}" data-webhook>
       <button type="button" data-copy-webhook>Copy webhook</button>
     </div>
     <p class="copy-status" aria-live="polite" data-copy-status>The webhook stays hidden on screen.</p>
     <p class="warning"><strong>Keep the webhook secret.</strong> Paste it only into the Anycloud prompt. The CLI validates it with a test message, then stores it locally with restricted file permissions.</p>
     <p>If your terminal is not waiting, run <code>anycloud notifications enable slack</code> and paste the webhook when prompted.</p>
     <p>After setup, your server sends alerts directly to Slack. This installation service does not receive or relay notifications.</p>
     <p><a href="https://anycloud.sh/slack/support/">Setup and support</a></p>`,
    200,
    true,
  );
}

function health(env: Env): Response {
  const ok = hasConfiguration(env);
  return Response.json(
    { ok },
    {
      status: ok ? 200 : 503,
      headers: NO_STORE_HEADERS,
    },
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method !== 'GET') {
      const response = errorResponse(
        'Method not allowed',
        'This endpoint only accepts GET requests.',
        405,
        url.pathname === '/oauth/callback',
      );
      response.headers.set('Allow', 'GET');
      return response;
    }

    if (url.pathname === '/health') return health(env);
    if (url.pathname === '/install') return install(request, env);
    if (url.pathname === '/oauth/callback') return callback(request, env);

    return errorResponse(
      'Page not found',
      'The requested installation page does not exist.',
      404,
    );
  },
};

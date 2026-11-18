export const TEST_SLACK_WEBHOOK =
  'https://hooks.slack.com/services/T_TEST/B_TEST/vm_release_test_token';

export interface FakeSlackPost {
  url: string;
  body: {
    text: string;
    blocks?: unknown[];
  };
}

export interface FakeSlack {
  readonly posts: FakeSlackPost[];
  failNext(status?: number, body?: string, headers?: HeadersInit): void;
  reset(): void;
  restore(): void;
}

/**
 * Intercept only Slack webhooks and delegate every other request to fetch.
 * Unit and integration tests therefore exercise the real notifier transport
 * without accidentally replacing unrelated API requests.
 */
export function installFakeSlack(): FakeSlack {
  const originalFetch = globalThis.fetch;
  const posts: FakeSlackPost[] = [];
  const failures: Array<{
    status: number;
    body: string;
    headers?: HeadersInit;
  }> = [];

  globalThis.fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (!url.startsWith('https://hooks.slack.com/')) {
      return originalFetch(input, init);
    }

    if (typeof init?.body !== 'string') {
      throw new Error('Expected Slack request body to be JSON text');
    }
    posts.push({
      url,
      body: JSON.parse(init.body) as FakeSlackPost['body'],
    });

    const failure = failures.shift();
    return failure
      ? new Response(failure.body, {
          status: failure.status,
          headers: failure.headers,
        })
      : new Response('ok', { status: 200 });
  };

  return {
    posts,
    failNext(status = 500, body = 'synthetic Slack failure', headers) {
      failures.push({ status, body, headers });
    },
    reset() {
      posts.length = 0;
      failures.length = 0;
    },
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

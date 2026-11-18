import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  SlackNotifier,
  isValidSlackWebhookUrl,
} from '../../../src/shared/notifications/slack.js';
import { NotificationRateLimitError } from '../../../src/shared/notifications/contracts.js';
import packageJson from '../../../package.json' with { type: 'json' };

const NOW = Date.UTC(2026, 7, 31, 12, 0, 0);

describe('isValidSlackWebhookUrl', () => {
  it('accepts a complete Slack incoming-webhook URL', () => {
    expect(
      isValidSlackWebhookUrl('https://hooks.slack.com/services/T/B/x'),
    ).toBe(true);
  });

  it('rejects other origins', () => {
    expect(isValidSlackWebhookUrl('https://example.com/webhook')).toBe(false);
    expect(
      isValidSlackWebhookUrl('http://hooks.slack.com/services/T/B/x'),
    ).toBe(false);
    expect(isValidSlackWebhookUrl('')).toBe(false);
  });

  it.each([
    'https://hooks.slack.com.evil.example/services/T/B/x',
    'https://user@hooks.slack.com/services/T/B/x',
    'https://hooks.slack.com/services/T/B',
    'https://hooks.slack.com/services/T/B/x/extra',
    'https://hooks.slack.com/services/T//B/x',
    'https://hooks.slack.com/services/T/B/x/',
    'https://hooks.slack.com/services/T/B/x?leak=true',
    'https://hooks.slack.com/services/T/B/x#fragment',
  ])('rejects malformed or embellished URLs: %s', (url) => {
    expect(isValidSlackWebhookUrl(url)).toBe(false);
  });
});

describe('SlackNotifier.send', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('ANYCLOUD_API_LABEL', '');
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('POSTs JSON {text} to the webhook', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '',
    });
    const n = new SlackNotifier({ webhook: 'https://hooks.slack.com/T/B/x' });
    await n.send('hello');
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://hooks.slack.com/T/B/x');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ text: 'hello' });
  });

  const source = `API: alice@workstation · v${packageJson.version}`;

  it('POSTs Block Kit with a complete text fallback and API label', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '',
    });
    const n = new SlackNotifier(
      { webhook: 'https://hooks.slack.com/T/B/x' },
      'alice@workstation',
    );
    const blocks = [
      {
        type: 'rich_text' as const,
        elements: [
          {
            type: 'rich_text_section' as const,
            elements: [{ type: 'text' as const, text: 'visible message' }],
          },
        ],
      },
    ];

    await n.send({
      text: 'notification fallback',
      slack: { blocks },
    });

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body as string)).toEqual({
      text: `notification fallback\n\n${source}`,
      blocks: [
        ...blocks,
        {
          type: 'context',
          elements: [{ type: 'plain_text', text: source }],
        },
      ],
    });
  });

  it('appends an API label to plain-text messages', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '',
    });
    vi.stubEnv('ANYCLOUD_API_LABEL', 'alice@workstation');
    const n = new SlackNotifier({ webhook: 'https://hooks.slack.com/T/B/x' });

    await n.send('hello');

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body as string)).toEqual({
      text: `hello\n\n${source}`,
    });
  });

  it('throws on non-2xx response', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => 'invalid_token',
    });
    const n = new SlackNotifier({ webhook: 'https://hooks.slack.com/T/B/x' });
    await expect(n.send('hi')).rejects.toThrow(/Slack 403/);
  });

  it('honors Retry-After per webhook and resumes after it expires', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response('rate_limited', {
          status: 429,
          headers: { 'Retry-After': '3' },
        }),
      )
      .mockImplementation(async () => new Response('ok', { status: 200 }));
    const notifier = new SlackNotifier({
      webhook: 'https://hooks.slack.com/services/T/B/rate_limited',
    });

    await expect(notifier.send('first')).rejects.toMatchObject({
      retryAt: NOW + 3_000,
      newlyObserved: true,
    } satisfies Partial<NotificationRateLimitError>);
    await expect(notifier.send('blocked')).rejects.toMatchObject({
      retryAt: NOW + 3_000,
      newlyObserved: false,
    } satisfies Partial<NotificationRateLimitError>);
    expect(fetchMock).toHaveBeenCalledOnce();

    const otherNotifier = new SlackNotifier({
      webhook: 'https://hooks.slack.com/services/T/B/not_blocked',
    });
    await otherNotifier.send('other webhook');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.setSystemTime(NOW + 3_001);
    await notifier.send('retry');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([undefined, 'invalid'])(
    'falls back to one second for a missing or invalid Retry-After: %s',
    async (retryAfter) => {
      fetchMock
        .mockResolvedValueOnce(
          new Response('rate_limited', {
            status: 429,
            headers:
              retryAfter === undefined
                ? undefined
                : { 'Retry-After': retryAfter },
          }),
        )
        .mockResolvedValueOnce(new Response('ok', { status: 200 }));
      const notifier = new SlackNotifier({
        webhook: `https://hooks.slack.com/services/T/B/fallback_${retryAfter ?? 'missing'}`,
      });

      await expect(notifier.send('first')).rejects.toMatchObject({
        retryAt: NOW + 1_000,
        newlyObserved: true,
      } satisfies Partial<NotificationRateLimitError>);
      vi.setSystemTime(NOW + 1_001);
      await notifier.send('retry');
    },
  );
});

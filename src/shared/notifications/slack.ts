import { createHash } from 'node:crypto';
import packageJson from '../../../package.json' with { type: 'json' };
import { NotificationRateLimitError } from './contracts.js';
import type {
  NotificationContent,
  Notifier,
  SlackChannelConfig,
} from './contracts.js';
import { configuredApiNotificationLabel } from './source.js';
import { retryAfterMs } from '../retry-after.js';
import { TemporalGate } from '../utils.js';

const SLACK_POST_TIMEOUT_MS = 15_000;
const SLACK_RATE_LIMIT_FALLBACK_MS = 1_000;
let slackRateLimits: TemporalGate<string> | undefined;

function getSlackRateLimits(): TemporalGate<string> {
  slackRateLimits ??= new TemporalGate<string>();
  return slackRateLimits;
}

function webhookRateLimitKey(webhook: string): string {
  return createHash('sha256').update(webhook).digest('hex');
}

export function isValidSlackWebhookUrl(value: string): boolean {
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

/**
 * Mask the token segments of a webhook for display.
 *
 * The API masks server-side so the raw webhook is never returned over the wire
 * once it has been stored — callers that display it never need to hold it.
 */
export function truncateWebhook(url: string): string {
  // https://hooks.slack.com/services/T.../B.../x... — keep visible structure,
  // mask the token segments.
  if (!isValidSlackWebhookUrl(url)) return 'invalid webhook URL';
  const m = url.match(
    /^(https:\/\/hooks\.slack\.com\/services\/)([^/]+)\/([^/]+)\/(.+)$/,
  );
  if (!m) return 'invalid webhook URL';
  const trunc = (s: string) => `${s.slice(0, 2)}…`;
  return `${m[1]}${trunc(m[2])}/${trunc(m[3])}/${trunc(m[4])}`;
}

export class SlackNotifier implements Notifier {
  readonly name = 'slack' as const;
  constructor(
    private readonly config: SlackChannelConfig,
    private readonly apiLabel = configuredApiNotificationLabel(),
  ) {}

  async send(message: NotificationContent): Promise<void> {
    const rateLimits = getSlackRateLimits();
    const rateLimitKey = webhookRateLimitKey(this.config.webhook);
    const blockedUntil = rateLimits.opensAt(rateLimitKey);
    if (blockedUntil !== undefined) {
      throw new NotificationRateLimitError(blockedUntil, false);
    }

    const text = typeof message === 'string' ? message : message.text;
    const blocks =
      typeof message === 'string' ? undefined : message.slack?.blocks;
    const source = this.apiLabel
      ? `API: ${this.apiLabel} · v${packageJson.version}`
      : undefined;
    const res = await fetch(this.config.webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: source ? `${text}\n\n${source}` : text,
        ...(blocks && blocks.length > 0
          ? {
              blocks: source
                ? [
                    ...blocks,
                    {
                      type: 'context' as const,
                      elements: [{ type: 'plain_text' as const, text: source }],
                    },
                  ]
                : blocks,
            }
          : {}),
      }),
      signal: AbortSignal.timeout(SLACK_POST_TIMEOUT_MS),
    });
    if (res.status === 429) {
      const existingRetryAt = rateLimits.opensAt(rateLimitKey);
      const now = Date.now();
      const responseRetryAt =
        now +
        Math.max(
          SLACK_RATE_LIMIT_FALLBACK_MS,
          retryAfterMs(res.headers, now) ?? 0,
        );
      rateLimits.closeUntil(rateLimitKey, responseRetryAt);
      const retryAt = Math.max(existingRetryAt ?? 0, responseRetryAt);
      const detail = await res.text();
      throw new NotificationRateLimitError(
        retryAt,
        existingRetryAt === undefined,
        `Slack 429${detail ? `: ${detail}` : ''}`,
      );
    }
    if (!res.ok) {
      throw new Error(`Slack ${res.status}: ${await res.text()}`);
    }
  }
}

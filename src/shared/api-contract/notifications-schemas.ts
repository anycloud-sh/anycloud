import { z } from 'zod';
import { isValidSlackWebhookUrl } from '../notifications/slack.js';

const notificationChannelSchema = z.enum(['slack']);

const slackWebhookSchema = z.string().refine(isValidSlackWebhookUrl, {
  message:
    'must be a Slack incoming webhook URL of the form https://hooks.slack.com/services/T.../B.../...',
});

/**
 * Status carries the masked webhook only. The stored value is a bearer token
 * for the channel, so it leaves the API exactly once — when the caller supplies
 * it — and never comes back.
 */
const notificationChannelStatusSchema = z
  .object({
    channel: notificationChannelSchema,
    webhook: z.string().min(1),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();

export const listNotificationsResponseSchema = z.array(
  notificationChannelStatusSchema,
);

export const saveNotificationBodySchema = z
  .object({ webhook: slackWebhookSchema })
  .strict();

export const saveNotificationRequestSchema = z.object({
  params: z.object({ channel: notificationChannelSchema }).strict(),
  body: saveNotificationBodySchema,
});

export const channelParamsRequestSchema = z.object({
  params: z.object({ channel: notificationChannelSchema }).strict(),
});

/**
 * A test may carry a candidate webhook. That lets `enable` prove a webhook
 * works before it is stored, so a webhook that cannot deliver never replaces a
 * working one — the guarantee the CLI had when it held the config itself.
 */
export const testNotificationBodySchema = z
  .object({ webhook: slackWebhookSchema.optional() })
  .strict();

export const testNotificationRequestSchema = z.object({
  params: z.object({ channel: notificationChannelSchema }).strict(),
  body: testNotificationBodySchema,
});

export const removeNotificationResponseSchema = z
  .object({ removed: z.boolean() })
  .strict();

export type NotificationChannelName = z.output<
  typeof notificationChannelSchema
>;
export type NotificationChannelStatus = z.output<
  typeof notificationChannelStatusSchema
>;

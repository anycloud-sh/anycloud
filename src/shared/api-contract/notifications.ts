import { authenticatedEndpoints } from './base.js';
import { noContentSchema, noInputSchema } from './common-schemas.js';
import {
  channelParamsRequestSchema,
  listNotificationsResponseSchema,
  removeNotificationResponseSchema,
  saveNotificationRequestSchema,
  testNotificationRequestSchema,
} from './notifications-schemas.js';

const authenticated = authenticatedEndpoints({}, 'Notifications');

// A Slack post is allowed 15s of its own, so the default 6s envelope would
// abort a healthy delivery before it finished.
const TEST_DELIVERY_TIMEOUT_MS = 20_000;

const channelNotConfiguredErrors = {
  CHANNEL_NOT_CONFIGURED: {
    status: 404,
    message: 'Notification channel is not configured',
  },
} as const;

const list = authenticated
  .query({
    method: 'GET',
    path: '/notifications',
    operationId: 'listNotificationChannels',
    summary: 'List configured notification channels',
  })
  .input(noInputSchema)
  .output(listNotificationsResponseSchema);

const save = authenticated
  .command({
    method: 'PUT',
    path: '/notifications/{channel}',
    operationId: 'saveNotificationChannel',
    summary: 'Enable or replace a notification channel',
    inputStructure: 'detailed',
    successStatus: 204,
  })
  .input(saveNotificationRequestSchema)
  .output(noContentSchema);

const remove = authenticated
  .command({
    method: 'DELETE',
    path: '/notifications/{channel}',
    operationId: 'deleteNotificationChannel',
    summary: 'Disable a notification channel',
    inputStructure: 'detailed',
  })
  .input(channelParamsRequestSchema)
  .output(removeNotificationResponseSchema);

const test = authenticated
  .command(
    {
      method: 'POST',
      path: '/notifications/{channel}/test',
      operationId: 'testNotificationChannel',
      summary: 'Post a test message from this API to the channel',
      inputStructure: 'detailed',
      successStatus: 204,
    },
    { timeoutMs: TEST_DELIVERY_TIMEOUT_MS },
  )
  .input(testNotificationRequestSchema)
  .output(noContentSchema)
  .errors({
    ...channelNotConfiguredErrors,
    DELIVERY_FAILED: {
      status: 502,
      message: 'Notification channel rejected the test message',
    },
  });

export const notificationsContract = { list, save, delete: remove, test };

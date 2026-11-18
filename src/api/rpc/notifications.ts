import {
  NotificationChannelNotConfiguredError,
  NotificationDeliveryError,
} from '../../shared/errors.js';
import { declaredError, mapDeclaredErrors } from './errors.js';
import { authenticatedImplementation as authenticated } from './base.js';

export const notificationsRouter = {
  list: authenticated.notifications.list.handler(({ context, signal }) =>
    context.domains.notifications.list(signal),
  ),
  save: authenticated.notifications.save.handler(
    async ({ context, input, signal }) => {
      await context.domains.notifications.save(
        input.params.channel,
        input.body.webhook,
        signal,
      );
    },
  ),
  delete: authenticated.notifications.delete.handler(
    ({ context, input, signal }) =>
      context.domains.notifications.delete(input.params.channel, signal),
  ),
  test: authenticated.notifications.test.handler(
    async ({ context, input, signal, errors }) => {
      await mapDeclaredErrors(
        () =>
          context.domains.notifications.test(
            input.params.channel,
            input.body.webhook,
            signal,
          ),
        [
          declaredError(NotificationChannelNotConfiguredError, (error) =>
            errors.CHANNEL_NOT_CONFIGURED({
              message: error.message,
              cause: error,
            }),
          ),
          declaredError(NotificationDeliveryError, (error) =>
            errors.DELIVERY_FAILED({ message: error.message, cause: error }),
          ),
        ],
      );
    },
  ),
};

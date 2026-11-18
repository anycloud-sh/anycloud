// Notification channel construction.
//
// Channel configuration lives in the API database, not on disk: the API process
// owns it, and the CLI reads and writes it over the API like every other
// setting. Adding a channel is one new file under this directory plus one entry
// in `loadNotifiers`.

import { SlackNotifier } from './slack.js';
import type { NotificationsConfig, Notifier } from './contracts.js';

export function loadNotifiers(config: NotificationsConfig): Notifier[] {
  const notifiers: Notifier[] = [];
  if (config.slack) notifiers.push(new SlackNotifier(config.slack));
  return notifiers;
}

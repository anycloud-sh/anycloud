import { Command } from 'commander';
import { apiClient } from '../services/auth.js';
import { openInBrowser } from '../utils/browser.js';
import { printError, printInfo, printSuccess } from '../utils/output.js';
import { requireOrPrompt, shouldAllowPrompts } from '../utils/safe-prompts.js';
import { isValidSlackWebhookUrl } from '../../shared/notifications/slack.js';
import { getApiUrl } from '../../shared/config.js';
import { errorMessage } from '../../shared/log-diagnostics.js';

const SLACK_INSTALL_URL = 'https://slack.anycloud.sh/install';

function requireSlackChannel(channel: string): void {
  if (channel === 'slack') return;
  printError(`unsupported channel: ${channel}. only "slack" today.`);
  process.exit(1);
}

async function resolveSlackWebhook(
  provided: string | undefined,
): Promise<string> {
  try {
    return await requireOrPrompt(provided, {
      parse: (raw) => {
        const webhook = raw.trim();
        if (!isValidSlackWebhookUrl(webhook)) {
          throw new Error(
            'Must be a valid https://hooks.slack.com/services/... URL',
          );
        }
        return webhook;
      },
      missingError:
        '--webhook required. Pass an incoming-webhook URL from https://hooks.slack.com/...',
      prompt: {
        type: 'password',
        name: 'value',
        message: 'Slack incoming-webhook URL',
        validate: (value) =>
          isValidSlackWebhookUrl(String(value).trim())
            ? true
            : 'Must be a valid https://hooks.slack.com/services/... URL',
      },
    });
  } catch (error) {
    printError(`invalid webhook: ${errorMessage(error)}`);
    process.exit(1);
  }
}

/**
 * Have the API prove the webhook delivers, then store it.
 *
 * The test deliberately runs server-side. The API is what sends digests and
 * alerts, so a post from this process would prove only that the machine running
 * the CLI can reach Slack — which is true from anywhere, and says nothing about
 * whether notifications will actually arrive. Testing first also means a
 * webhook that cannot deliver never replaces a working one.
 */
async function configureSlack(webhook: string): Promise<void> {
  const client = await apiClient();
  try {
    await client.notifications.test({
      params: { channel: 'slack' },
      body: { webhook },
    });
  } catch (error) {
    printError(`test post failed (not saving): ${errorMessage(error)}`);
    process.exit(1);
  }

  try {
    await client.notifications.save({
      params: { channel: 'slack' },
      body: { webhook },
    });
  } catch (error) {
    printError(`could not save the webhook: ${errorMessage(error)}`);
    process.exit(1);
  }

  printSuccess(
    `slack notifications enabled on ${getApiUrl()} — daily digests, alerts, and release updates are active`,
  );
}

async function openSlackInstallPage(): Promise<void> {
  printInfo(`Slack installation: ${SLACK_INSTALL_URL}`);
  await openInBrowser(SLACK_INSTALL_URL, {
    unavailable: 'Open the URL above in a browser to continue.',
    failed: 'The browser did not open; use the URL above.',
  });
}

export function createNotificationsCommand(): Command {
  const notifications = new Command('notifications')
    .description('🔔 Slack usage digests, alerts, and release updates')
    .addHelpText(
      'after',
      `
Notification settings belong to the API that sends them, so these commands
act on the active API.  Check which one that is with "anycloud api status",
and switch with "anycloud api use <target>".

Examples:
  $ anycloud notifications connect slack        (opens Slack and prompts securely)
  $ anycloud notifications enable slack         (prompts for webhook URL)
  $ anycloud notifications enable slack --webhook https://hooks.slack.com/...
  $ anycloud notifications status
  $ anycloud notifications test
  $ anycloud notifications disable
`,
    );

  notifications
    .command('connect')
    .description('connect a notification channel interactively')
    .argument('<channel>', 'channel name (only "slack" supported today)')
    .action(async (channel: string) => {
      requireSlackChannel(channel);
      if (!shouldAllowPrompts()) {
        printError(
          'slack connection requires an interactive terminal. For automation, use `anycloud notifications enable slack --webhook <url>`.',
        );
        process.exit(1);
      }

      await openSlackInstallPage();
      printInfo(
        'Authorize Slack, click “Copy webhook”, then paste it into the hidden prompt below.',
      );
      const webhook = await resolveSlackWebhook(undefined);
      await configureSlack(webhook);
    });

  notifications
    .command('enable')
    .description('enable a notification channel')
    .argument('<channel>', 'channel name (only "slack" supported today)')
    .option('--webhook <url>', 'incoming webhook URL')
    .action(async (channel: string, opts: { webhook?: string }) => {
      requireSlackChannel(channel);
      const webhook = await resolveSlackWebhook(opts.webhook);
      await configureSlack(webhook);
    });

  notifications
    .command('status')
    .description('show configured notification channels')
    .action(async () => {
      const channels = await (await apiClient()).notifications.list();
      const apiUrl = getApiUrl();
      if (channels.length === 0) {
        printInfo(
          `no channels configured on ${apiUrl}. run \`anycloud notifications connect slack\``,
        );
        return;
      }
      printInfo(`API: ${apiUrl}`);
      for (const entry of channels) {
        printInfo(`${entry.channel}: ${entry.webhook}`);
      }
    });

  notifications
    .command('disable')
    .description('disable a notification channel (or all)')
    .argument('[channel]', 'channel name (omit to disable all)')
    .action(async (channel: string | undefined) => {
      if (channel !== undefined) requireSlackChannel(channel);
      const { removed } = await (
        await apiClient()
      ).notifications.delete({ params: { channel: 'slack' } });
      if (!removed) {
        printInfo(
          channel
            ? 'slack was not configured.'
            : 'no channels were configured.',
        );
        return;
      }
      printSuccess('slack notifications disabled.');
    });

  notifications
    .command('test')
    .description('post a test message from the API to the configured channel')
    .argument('[channel]', 'channel name (defaults to slack)')
    .action(async (channel: string | undefined) => {
      requireSlackChannel(channel ?? 'slack');
      try {
        await (
          await apiClient()
        ).notifications.test({
          params: { channel: 'slack' },
          body: {},
        });
        printSuccess(`test message posted from ${getApiUrl()}.`);
      } catch (error) {
        printError(`test post failed: ${errorMessage(error)}`);
        process.exit(1);
      }
    });

  return notifications;
}

# Slack Marketplace release

This file is the release checklist for the production Anycloud Slack app. It
contains no credentials or webhook URLs.

## Production app

- Owner workspace: `anycloud-sh`
- App ID: `A0BNLSHGJTH`
- Client ID: `11424593176448.11768901562935`
- Install URL: `https://slack.anycloud.sh/install`
- Landing page: `https://anycloud.sh/slack/`
- Privacy policy: `https://anycloud.sh/slack/privacy/`
- Support page: `https://anycloud.sh/slack/support/`
- OAuth callback: `https://slack.anycloud.sh/oauth/callback`
- Requested scope: `incoming-webhook`

The Worker and website are live, and the owner-workspace installation passed on
2026-08-09. Submit this App ID for review; do not create another Marketplace
app.

Owner-workspace validation completed on 2026-08-09:

- Slack completed the OAuth exchange and returned an incoming webhook.
- The success page rendered the one-time local webhook handoff.
- The Anycloud server accepted the configuration and posted its immediate test
  message to the selected Slack channel.

Unlisted public distribution was activated for `A0BNLSHGJTH` on 2026-08-09 so
the same production app can be installed in external pilot workspaces.

## Listing copy

- Category: Developer Tools
- Language: English
- Pricing: Free Slack integration; Anycloud and cloud usage priced separately.
- Short description: GPU cost alerts and daily summaries in Slack.

Suggested long description:

> Anycloud sends GPU spend-cap alerts and daily cloud activity summaries to a
> Slack channel your team chooses. During installation, Slack creates a
> channel-specific incoming webhook. The guided Anycloud CLI opens Slack, then
> accepts that webhook in a hidden local prompt. Notifications travel directly
> from that server to Slack; Anycloud does not host a notification relay or read
> workspace messages.

Scope justification:

> Anycloud requests `incoming-webhook` only so the user's Anycloud server can
> post operational alerts to the channel selected during installation. The app
> does not request permission to read messages, users, files, or channels.

## Reviewer instructions

1. On a machine hosting the Anycloud API, run
   `anycloud notifications connect slack`.
2. Use the URL printed by the CLI, choose a test workspace and destination
   channel, then approve the single
   `incoming-webhook` permission.
3. Confirm the success page displays a hidden webhook field and **Copy webhook**
   button without placing the webhook in a shell command.
4. Copy the webhook, paste it into the waiting CLI prompt, and confirm Anycloud
   immediately posts `anycloud notifications enabled`.
5. Run `anycloud notifications test slack` to post another test message and
   `anycloud notifications status` to verify local configuration.
6. Run `anycloud notifications disable slack`, then uninstall the app from the
   test workspace and confirm the old webhook no longer accepts messages.

Never paste the webhook into the Marketplace review form, screenshots, logs, or
support messages.

## Pilot gate

Slack's [distribution requirements](https://docs.slack.dev/slack-marketplace/distributing-your-app-in-the-slack-marketplace/)
say apps installed on fewer than five active workspaces and having fewer than
ten weekly active users are not suitable for Marketplace submission. An active
workspace must have used the app within the preceding 28 days and must not be a
sandbox. Target at least five active non-sandbox workspaces and ten weekly
active users before submission. Record only non-secret evidence here or in the
release ticket.

| Workspace | Installed  | Test message     | Spend-cap alert | Daily digest | Uninstall tested |
| --------- | ---------- | ---------------- | --------------- | ------------ | ---------------- |
| Pilot 1   | 2026-08-09 | 2026-08-09 (CLI) | Pending         | Pending      | Pending          |
| Pilot 2   |            |                  |                 |              |                  |
| Pilot 3   |            |                  |                 |              |                  |
| Pilot 4   |            |                  |                 |              |                  |
| Pilot 5   |            |                  |                 |              |                  |

Following explicit approval on 2026-08-09, the two legacy per-customer app
definitions were permanently deleted. Both IDs return `app_not_found`;
production app `A0BNLSHGJTH` still resolves and a subsequent webhook test from
the first pilot's API host succeeded.

## Submission assets

- A square Anycloud app icon between 512×512 and 2000×2000 pixels.
- A real screenshot of the Slack channel-selection installation step.
- A real daily-digest message from the production App ID.
- A real spend-cap alert from the production App ID.

Capture screenshots only after the production installation is working. Crop
workspace or channel details where appropriate and verify that no webhook URL,
OAuth code, or access token is visible.

## Release order

1. Merge and deploy the Worker and website from `main`.
2. Set `SLACK_CLIENT_SECRET` with Wrangler and smoke-test `/health` and
   `/install`.
3. Install into the owner workspace and test the guided CLI handoff.
4. Enable unlisted public distribution and migrate the first pilot.
5. Complete the five-workspace pilot within 28 days.
6. Upload the icon and real screenshots, complete Slack's security and privacy
   questionnaire, and submit `A0BNLSHGJTH` for review.

If Slack rejects the one-time webhook handoff, stop the release and revisit the
handoff design. Do not introduce a hosted notification relay as a shortcut.

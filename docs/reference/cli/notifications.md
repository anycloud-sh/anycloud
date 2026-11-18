---
title: notifications
description: Exact syntax for enabling, testing, inspecting, and disabling alerts, digests, and release updates.
---

# `anycloud notifications`

```bash
anycloud notifications connect slack
anycloud notifications enable slack [--webhook URL]
anycloud notifications status
anycloud notifications test [channel]
anycloud notifications disable [channel]
```

| Option          | Description                                                       |
| --------------- | ----------------------------------------------------------------- |
| `--webhook URL` | Slack incoming-webhook URL for non-interactive or automated setup |

All of these act on your active API, which is what sends the notifications.
`test` defaults to Slack. `disable` without a channel removes every configured
channel.

`connect slack` opens the [Anycloud Slack app](/slack/), then waits for the
channel-specific webhook in a hidden terminal prompt. It validates the URL and
has the API post a test before saving, so an invalid or revoked webhook is not
stored. The installation URL is always printed when a browser cannot be opened.

`enable slack` retains the direct setup path. Without `--webhook`, it uses the
same hidden prompt; with the flag, it works in non-interactive environments.
Treat the webhook as a secret. See [Notifications](/platform/notifications) for
alert, digest, and release-update content and timing.

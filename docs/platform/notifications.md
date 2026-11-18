---
title: Notifications
description: Send Slack alerts, daily usage summaries, and new-release notices from your Anycloud API.
---

import SlackVmReleaseAlert from '@site/src/components/SlackVmReleaseAlert';

# Notifications

Notifications send operational summaries without changing whether work runs.
They are separate from [Spend Controls](/platform/spend-controls), which can
keep queued workloads from dispatching.

Today, Anycloud supports Slack notifications for daily usage, blocking spend
controls, delayed VM cleanup, and new releases.

## Enable Slack

Notification settings belong to the API that sends them, so these commands act
on your active API. Check which one that is with `anycloud api status`, and switch
with `anycloud api use <target>`. Settings apply to everyone sharing that API.

```bash
anycloud notifications connect slack
```

The CLI prints the installation URL and opens it when a browser is available.
Choose the Slack workspace and destination channel, authorize the installation,
then click **Copy webhook** and paste it into the hidden terminal prompt. The URL
is validated, the API posts a test message from where notifications actually
originate, and the webhook is stored only after that message is delivered.

Treat the webhook URL as a secret. The guided flow keeps it out of shell history
and terminal output. For non-interactive automation, the existing direct command
remains available:

```bash
anycloud notifications enable slack --webhook "$SLACK_WEBHOOK_URL"
```

Notification delivery goes directly from the Anycloud API to Slack; the
installation service does not relay messages or store the webhook.

Every API-generated Slack message identifies its source. A local API uses the
operating-system account and host that started it, such as
`alice@workstation`; a non-default API port is appended when needed. A hosted
API uses its URL host and GitHub owner, such as
`<cluster-id>.anycloud.sh · @alice`. Set `ANYCLOUD_API_LABEL` when starting a
local API to replace its automatically derived label. The line ends with the
API's version, such as `· v0.1.71`.

Source labels distinguish APIs that share a Slack channel; they do not
coordinate delivery between those APIs. Each API keeps its own digest and
release-notification history and can therefore post its own copy.

```bash
anycloud notifications status
anycloud notifications test slack
anycloud notifications disable slack
```

## Digest timing

The API checks every 15 minutes. Once per UTC day after midnight, it summarizes
the previous UTC calendar day when there was relevant activity. The first check
after you first enable Slack marks earlier days as handled, so the first digest
normally arrives after the next UTC midnight and covers the day you enabled it.
After a disable and re-enable, digests resume from the last day posted: if the
previous UTC day was not yet posted, the next check posts it, including activity
while Slack was disabled.

The digest starts with compute spend tracked for Jobs, Services, and VMs, then
gives each contributing user a separate section. A local API has one owner, so
its digest has a single section without a user heading; the API label names it.
These Workload types are reported separately with that user's compute spend,
provisioned VM hours, and distinct VMs:

- Jobs report initial submissions, resubmissions, terminal results,
  preemptions, and median duration.
- Services use service-specific launch wording and omit median duration because
  they are long-running.
- VMs use creation wording, report terminal outcomes directly without a
  separate ended total, and omit median duration because they are long-running.

Users are sorted by username. Inactive user sections and lines with a zero count
are omitted. Activity rows and their outcome details use Slack's structured
nested lists, so the hierarchy does not depend on leading whitespace.

Submission, VM usage, resubmission, and terminal-state counts independently use
the day named in the digest. A workload can therefore be submitted one day,
resubmitted another, and finish later.

Terminal outcomes are counted on the day a workload reached its outcome. VM
usage and spend are independent: each VM contributes its own lifetime, up to its
`endedAt` spend cutoff, clipped to the digest day.

### Spend alerts

Waiting-on-spend-cap alerts are also sent when a
[Spend Control](/platform/spend-controls) begins blocking queued work, then at
most once every six hours while it remains blocked. When a cap involves multiple
GitHub accounts, the alert names who has work waiting. A budget alert also shows
how spend in that budget window divides between users; a throttle has no window
spend breakdown. Attribution is omitted when only one account is involved. A cap
triggers one alert regardless of how many people it affects.

## VM cleanup alerts

When a cloud provider has not released a VM within five minutes of Anycloud
requesting its removal, Slack sends one aggregate **VM release delayed** alert.
It reports the total VMs and workloads affected, the oldest wait, and a
bounded sample of workload IDs while warning that the provider may continue
billing. Anycloud keeps retrying cleanup.

<SlackVmReleaseAlert />

_Illustrative alert; counts, elapsed time, workload IDs, and API source vary
by incident._

Additional delayed VMs join the same active alert instead of producing more
messages. If any remain unresolved, Slack sends **VM release still delayed** at
most once every six hours with current totals. When none remain, Anycloud
silently resets the alert; a later delay starts a new alert after five minutes.
No recovery message is sent.

The successful-alert timestamp survives API restarts. A rejected webhook stays
due and is retried after any provider-requested backoff; it is never recorded as
sent. The notification monitor discovers delays independently from cleanup
work, including failed provisioning attempts without an assigned IP address.

## API health alerts

The API watches itself once a minute for the failures that leave it running but
unable to do its job: freezing for seconds at a time so commands time out,
approaching the memory limit where it is killed and restarted, falling far
behind on tracking workloads so finished work keeps billing, and background
checks that have stopped running altogether.

Alerts describe what stopped working and what it costs you. The underlying
measurements are written to the API's log for anyone diagnosing the cause.

An alert is recorded only after a problem persists across several consecutive
checks, so a single slow provider call or pause for memory housekeeping is
never reported. Each signal alerts at most once an hour while it lasts, then
posts one notice when it clears.

These alerts are currently written to the log of the API that raised them and
are not yet sent to Slack; delivery stays off while the detection thresholds
are calibrated against real workloads. Read a local API's log with
`anycloud api logs`.

These alerts come from the affected API itself, so a process that is fully
wedged or already gone cannot raise one. Treat them as early warning rather
than as an uptime check.

## Release updates

The API checks for a new public Anycloud release when it starts and once per
hour afterward. When the newest release is newer than the running API, Slack
receives a short notice with the `anycloud update` command and a link to the
GitHub release, which lists what changed. Each version is posted once; if the API
misses several releases while offline, it posts only the newest one.

Successful delivery is recorded, so neither an API restart nor an upgrade posts
the same release again. A failed delivery is not recorded, so the next hourly
check retries it.

## Where settings live

The webhook and the delivery history are stored by the API, encrypted at rest
alongside your credentials and secrets. They survive restarts and upgrades, and
they follow the API rather than the machine you ran the command from — so
`anycloud notifications status` always describes the API it is pointed at.

Run `anycloud notifications disable slack` to remove the configuration.
Disabling Slack does not clear release-notification history, so re-enabling the
same channel does not replay an already delivered release. Uninstalling
Anycloud from Slack separately revokes the workspace webhook.

Slack is currently the only channel. See
[`notifications` reference](/reference/cli/notifications) for exact syntax.

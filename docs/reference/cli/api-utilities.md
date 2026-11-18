---
title: api and utilities
description: Exact syntax for API targets, authentication, updates, docs output, and read-only database inspection.
---

# `api` and utilities

## `anycloud api`

Manage the active API target:

```bash
anycloud api list|ls [--json]
anycloud api use [target]
anycloud api status|describe [--watch [--interval <seconds>]] [--json]
anycloud api upgrade|update [--image <reference>] [--force] [--json]
anycloud api start [options]
anycloud api stop
anycloud api logs [-f]
anycloud api access add <github-user> | --service <name> [--json]
anycloud api access remove|rm <github-user-or-id> | --service <name>
anycloud api access list|ls [--json]
anycloud api token [rotate [--service <name>] [--json]]
```

| Option              | Description                                            |
| ------------------- | ------------------------------------------------------ |
| `--json`            | JSON output for API status, targets, access or upgrade |
| `--port PORT`       | Local API port; default `8080`                         |
| `--version VERSION` | API image version; defaults to the CLI version         |
| `-f, --follow`      | Follow local API logs                                  |

The default API URL is `http://localhost:8080`. `api use` persists a target in
`~/.anycloud/api-url`; `API_URL` is a one-command override. `api use local`
saves the default local target. With no target in a TTY, `api use` opens a
picker of healthy compatible APIs.

`api status` shows the active API, local or hosted: its URL, where the
selection comes from, its version, and whether this CLI is compatible with it.
A local API adds its database and any crash restarts. A hosted API adds its
schema version and its latest upgrade as `Upgrade N · <version>` with one
`✓`/`◌`/`✗` line, in the same way `status` shows a Service upgrade.
`--watch` refreshes, printing each change, until that upgrade is `running` or
`failed`, then prints the status; with `--json` it prints one document per
read. Ctrl-C stops it with exit code 130.

The local API binds `127.0.0.1` and admits only its own token. `api start`
writes that token to `$ANYCLOUD_DIR/local-api-token`, readable only by you
(mode `0600`), and the CLI and Python SDK send it to loopback API URLs only. A
local API needs no GitHub sign-in for public images. It also refuses requests
addressed to any host but `localhost`, `127.0.0.1` or `[::1]`, so run the CLI
on the machine that runs it. For remote access, use a hosted API.

`api start` waits up to 120 seconds for the local API to answer, printing
progress every 15 seconds; a large database can take minutes to migrate.

| Code | Meaning                                                              |
| ---- | -------------------------------------------------------------------- |
| `0`  | The local API is running and answering                               |
| `1`  | The start failed, or the container exited before it answered         |
| `4`  | The container is still starting after 120 seconds and keeps starting |

`api upgrade` and `anycloud update` exit `4` in the same case. A container that
is still starting already has automatic restarts; follow it with
`anycloud api status` and `docker logs anycloud-api`.

Create a hosted API with [`anycloud cluster create`](/reference/cli/cluster),
then select its URL with `anycloud api use https://<cluster-id>.anycloud.sh`.
`api serve` and VM-hosted API upgrades have been removed. See
[the migration steps](/platform/hosted-apis#migrate-an-existing-vm-hosted-api)
for existing installations.

### Upgrade the API

First update the CLI, then upgrade the active API:

```bash
anycloud update
anycloud api upgrade [--image ghcr.io/anycloud-sh/api:<version>@sha256:<digest>] [--force]
```

`api upgrade` (alias `update`) upgrades the active API. A local API is
started or restarted on `ghcr.io/anycloud-sh/api:<installed-cli-version>`. A
cluster-hosted API is asked directly, without Docker or the local API: it
backs up its database and patches its own
Helm release, and keeps running while it is replaced. The command prints
`Hosted API upgrade N started`, or an unchanged or refused verdict;
`anycloud api status --watch` follows the upgrade. `--image` selects an exact official,
digest-pinned image. With `--json` it prints one result naming the API's old
and new versions, or the refusal's error code; see
[Results for scripts](/reference/cli/cluster#results-for-scripts). See
[Hosted APIs](/platform/hosted-apis#upgrade-a-hosted-api).

Before it replaces an API, `api upgrade` holds its
[Jobs on a node pool](/platform/jobs#jobs-on-a-node-pool): no new one starts
until the new API is up. Jobs running on this release's or the previous
release's runner keep running through the upgrade, and are listed. It waits
for older ones, and for every Job when `--image` names another release,
listing them as they change. `--force` stops those instead; each retries after
the upgrade.

After an upgrade that changes how node pool VMs join, such as adding the
instance-metadata block, the API replaces each node pool VM that joined before
it. It does this one VM per pool at a time, each once its pool Jobs finish. A
pool with one VM is unavailable while its replacement boots, and a pool whose
replacement can't launch stays one VM short until it can.

The active API selection is not changed. When a stopped active local API has a saved loopback URL with a custom port,
`api upgrade` starts it again on that port.

### Give someone access

The owner of a hosted API can share it with more GitHub accounts:

```bash
anycloud api use https://YOUR-HOSTED-API
anycloud api access add octocat
anycloud api access remove octocat
anycloud api access list
```

`add` resolves the supplied GitHub username to an immutable GitHub account ID
and accepts individual user accounts only, not organizations. `remove` accepts
either a username from the current access list or its displayed immutable ID.
Access commands operate on the active API and are unavailable on a local API.
Only the owner can run `add` and `remove`; any member can run `list`.

Added users sign in with `anycloud login <api-url>` and become equal peers:
they share the hosted API's workloads, credentials, secrets, spend controls, and
read-only database inspection. Any of them can operate on another creator's
workload when its type and state support the requested command. Removing access
deletes the user's API token, so
their next request is refused. It does not stop existing workloads;
remaining members can review them with `anycloud list --user <github-user-or-id>`
and terminate them when needed. `anycloud list` covers everyone's workloads
and names each creator whenever the result includes another account's work,
including a result containing only that teammate's workloads. See [Hosted
APIs](/platform/hosted-apis) for the complete setup, lifecycle, and trust model.

`list` shows each entry's `KIND` (`github` or `service`); `--json` adds
`kind`.

### Service tokens

The owner issues a token for a program that isn't a person, such as a CI
system or a listener running on a VM:

```bash
anycloud api access add --service ci
anycloud api token rotate --service ci
anycloud api access remove --service ci
```

`add --service` prints the token once; the API keeps only its SHA-256. With
`--json` it prints `{"kind":"service","userId":"service:ci","username":"ci","token":"acapi_…"}`.
`rotate --service` prints a new token and the old one is refused on its next
request; `remove --service` ends access at once. Only the owner issues,
rotates or removes service tokens. A name is 1–63 lowercase letters, digits
and hyphens, and can't be the GitHub login of anyone with access. The program
sets the token as `ANYCLOUD_API_TOKEN` beside `API_URL`, like a member's token;
see [Service tokens](/platform/hosted-apis#service-tokens).

### API tokens

A hosted API accepts only the API tokens it issues, never a GitHub token.
`anycloud login <api-url>` exchanges your GitHub sign-in for your token and
saves it in `$ANYCLOUD_DIR/api-tokens.json` (mode `0600`). The first command
to a hosted API without a saved token does the same. Every machine you sign in
from gets the same token, so `anycloud api token` prints it for CI:

```bash
anycloud api token
anycloud api token rotate
```

In CI or an agent, set `ANYCLOUD_API_TOKEN` to the token together with
`API_URL`. The CLI and the Python SDK ignore `ANYCLOUD_API_TOKEN` unless
`API_URL` names the same API, so the token never reaches another API. Use a
separate GitHub account for shared CI and add it (the owner runs
`api access add`); a CI secret that holds your token acts as you.

`rotate` replaces your token. The old one stops working on its next request,
on every machine and in CI: run `anycloud login <api-url>` on each machine and
update `ANYCLOUD_API_TOKEN`. A refused token names that command.

If a GitHub sign-in or a machine leaks:

1. Revoke anycloud's access in GitHub (Settings → Applications → Authorized
   OAuth Apps), so the sign-in can't fetch your token again.
2. From a clean machine, run `anycloud login` and `anycloud login <api-url>`,
   then `anycloud api token rotate`, for each hosted API.
3. Update `ANYCLOUD_API_TOKEN` wherever CI sets it.

The owner's `api access remove` deletes another member's token. The owner
can't be removed and revokes only by rotating; a member who wants out rotates
and asks the owner to remove them. After a hosted API's database is restored
from a backup, everyone rotates: the backup holds the tokens it had when it was
taken.

A hosted API older than API tokens has no exchange route, and the CLI sends it
your GitHub sign-in instead, so `api upgrade` keeps working. An older CLI
can't sign in to a hosted API that issues tokens: update the CLI first. The
Python SDK has no such fallback: upgrade a hosted API with
`anycloud api upgrade` before upgrading the SDK.

The hosted API also keeps the GitHub sign-in from your last login, for private
images, Service URLs and clusters. When GitHub stops accepting it,
`anycloud login <api-url>` gives the API your current sign-in. A command that
gets `GITHUB_SIGN_IN_REQUIRED` from the API, such as `api access add`, does the
same and retries once, except with `ANYCLOUD_API_TOKEN`, whose account may not
be this machine's.

## `anycloud login`

```bash
anycloud login
anycloud login <api-url>
```

Authenticate with GitHub OAuth. Login requests only `read:org` and
`read:packages`: enough to identify you and to run private GHCR images owned by
you or your organizations. A local API runs public images without it. Private
GHCR images, Services (their public URLs), clusters and hosted APIs need it;
without it they stop with `GITHUB_SIGN_IN_REQUIRED` or the image error, naming
`anycloud login`. It doesn't set up Docker to push images; see
[Build and publish](/platform/container-images#build-and-publish).

When an agent runs it (its marker variable, such as `CLAUDECODE`, is set) or
stdout isn't a terminal, login doesn't wait. It prints the device URL and code
as JSON on one line (shown formatted) and exits with status 1:

```json
{
  "actionRequired": {
    "code": "GITHUB_SIGN_IN_REQUIRED",
    "message": "GitHub sign-in required. Ask the user to open https://github.com/login/device?user_code=XXXX-XXXX and enter the code XXXX-XXXX to approve it; the next anycloud command completes the sign-in.",
    "url": "https://github.com/login/device?user_code=XXXX-XXXX",
    "userCode": "XXXX-XXXX",
    "expiresAt": "2026-10-09T20:15:00.000Z"
  }
}
```

Approve the code in a browser; the next `anycloud` command, or `anycloud login`
again, completes the sign-in. Until the code expires, repeated runs print the
same code; an expired or refused code is replaced. If you are already signed
in, login checks the sign-in with GitHub and exits 0, or relays a new code if
GitHub rejects it. A command that needs the sign-in prints the same JSON instead of failing and exits `1` (`2` for the [lifecycle commands](/reference/cli/cluster#results-for-scripts)); `credentials new --generate` prints one with the code
`CLOUD_ADMIN_REQUIRED` when the cloud account needs an administrator. The
pending code is kept in `$ANYCLOUD_DIR/github-device.json`, readable only by
you.

Login saves the token in `$ANYCLOUD_DIR/.token` (default `~/.anycloud/.token`),
readable only by you (mode `0600`). Commands use that saved token, then
`GITHUB_TOKEN`. A local API takes it beside its own token. A hosted API
exchanges it once for your [API token](#api-tokens), and only the token
`anycloud login` gets qualifies: a personal access token, a GitHub Actions
token or another app's token is refused. With an API URL, login also makes that
exchange and saves the API token.

Workloads don't receive the login token. For Git access from a workload, see
[Git access from workloads](/platform/secrets-environment#git-access-from-workloads).

## `anycloud update`

```bash
anycloud update
```

Installer-script installations are replaced in place from `get.anycloud.sh`,
wherever the running binary lives; Homebrew installations update through
Homebrew. Running from a source checkout is refused. A running local API is restarted when
its image is stale relative to the installed CLI.

## `anycloud docs`

```bash
anycloud docs [--all] [--url]
```

| Option  | Description                               |
| ------- | ----------------------------------------- |
| `--all` | Full Markdown corpus from `llms-full.txt` |
| `--url` | Print the source URL instead of fetching  |

The default prints the short `llms.txt` index.

## `anycloud db query`

Run read-only SQL against the active API database:

```bash
anycloud db query "<sql>" [--json]
```

Only `SELECT`, `WITH`, `EXPLAIN`, and `PRAGMA` are allowed; writes are refused
at the SQLite engine. Results stop at 10,000 rows. JSON is:

```json
{ "rows": [], "rowCount": 0, "truncated": false }
```

## `anycloud db schema`

```bash
anycloud db schema [table] [--json]
```

With no table, list all user tables and views. With a table, return its
columns, foreign keys, and indexes. Agents should inspect the JSON schema before
constructing an ad-hoc query.

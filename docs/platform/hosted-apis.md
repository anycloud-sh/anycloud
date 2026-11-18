---
title: Hosted APIs
description: Deploy, select, share, update, and retire an Anycloud API running in your cloud account.
---

# Hosted APIs

Every Anycloud command talks to one active API. A local API runs in Docker on
your machine. A hosted API runs in your cloud account and has a stable public
URL, so you can use it from multiple machines or share it with trusted
teammates.

A hosted API runs on the installation's Kubernetes cluster. The
[Clusters](/platform/clusters) guide covers its creation, upgrade and
deletion. The local Docker API remains the installer that
manages the cluster's lifecycle.

An existing VM-hosted API, created by the removed `anycloud api serve`, can
only be terminated; [migrate it](#migrate-an-existing-vm-hosted-api) to a
cluster-hosted API.

Hosting changes where the API runs; it does not create tenant isolation.
Everyone admitted to one hosted API shares its operational resources and trust
boundary.

## Create a hosted API on the cluster

Start the local API if it is not already running, make it active, and add the
cloud credential the cluster will use:

```bash
anycloud api start
anycloud api use local
anycloud credentials new my-aws
```

Create the cluster. The command creates a management VM, starts a pinned
Kubernetes control plane on it and installs the API as a Helm-managed release;
it prints each completed step, then the API's URL and the next command:

```bash
anycloud cluster create prod \
  --credentials my-aws \
  --region us-east-2 \
  --vm-type t3.medium
```

```text
✓ Cluster prod creation started.
ID: <cluster-id>
Watch it with: anycloud cluster status prod --watch
```

`anycloud cluster status prod --watch` follows it through `provisioning`,
`initializing` and `starting` to `running`, then prints the next command:

```text
Next: anycloud api use https://<cluster-id>.anycloud.sh
```

Point the CLI at it:

```bash
anycloud api use https://<cluster-id>.anycloud.sh
```

The hosted API starts with an empty database; the cluster record, its ledger
and the cluster's credential stay on the local API that created it (the
**installer**). Add the credentials you want your Workloads to use against the
hosted API, then run Jobs, Services and VMs against it. Pass `--checkpoint-bucket <name>` to back the hosted
API's database up to a bucket you own; without it `cluster create` creates a
managed one. A bucket that already holds a backup (`anycloud-api/backup.json`)
makes `create` a [restore](#back-up-and-restore) that keeps the cluster id and
URL. See [`anycloud cluster`](/reference/cli/cluster) for every flag,
the creation steps and how a failed creation resumes.

## Select an API

Show the local API and the active target:

```bash
anycloud api list
anycloud api status
```

Switch by public URL or the `local` alias:

```bash
anycloud api use https://<cluster-id>.anycloud.sh
anycloud api use local
```

Running `anycloud api use` without a target opens a picker of healthy,
compatible APIs in an interactive terminal. The saved target lives in
`~/.anycloud/api-url`; `API_URL` overrides it for one command.

## Give someone access

A hosted API initially accepts only its owner, the GitHub account that created
it. The owner can add or remove other GitHub users, without requiring everyone
to belong to the same GitHub organization. Members can view the list but not
change it.

Only add people you trust with the API's cloud access. Everyone with access is
an equal peer. They can use credentials and secrets, inspect the database,
manage spend controls, and operate everyone else's workloads just as they can
their own. Apart from managing access, there is no admin role inside the hosted
API. The account that created it controls the cluster through the installer API
that created it.

First make the hosted API the active target, then add a GitHub username:

```bash
anycloud api use https://<cluster-id>.anycloud.sh
anycloud api access add octocat
```

Anycloud resolves the supplied username to GitHub's immutable account ID and
stores that ID in the hosted API. A later username change does not remove the
person's access, and a different account that acquires the old username does
not inherit it. Only individual GitHub user accounts can be added; passing an
organization name is rejected, since an organization cannot sign in.

A member can't add or remove anyone, so they can't add another account to keep
access after removal. Still, treat adding someone as handing over the API's
cloud access, not lending it. The owner cannot be removed.

List everyone with access at any time:

```bash
anycloud api access list
anycloud api access list --json
```

The access commands always operate on the active API shown by
`anycloud api status`, and only apply to a hosted API — on a local API they
report that sharing is unavailable.

## Service tokens

A program that isn't a person, such as a CI system or a listener on a VM, gets
its own token from the owner instead of borrowing someone's:

```bash
anycloud api access add --service ci
anycloud api access list
anycloud api token rotate --service ci
anycloud api access remove --service ci
```

`add --service` prints the token once; the API stores only its SHA-256, so a
lost token is replaced with `rotate --service`, which refuses the old one on
its next request. The program sets the token as `ANYCLOUD_API_TOKEN` beside
`API_URL`, or sends it as `Authorization: Bearer <token>`. Only the owner
issues, rotates and removes service tokens.

A service is a full peer, like a member, and appears under its name where
listings name a creator. A service named like a GitHub member with access is
refused, but adding a member later whose login matches a service isn't. It
has no GitHub sign-in, so it submits public images only, and Service URLs
answer `GITHUB_SIGN_IN_REQUIRED`. A restored backup brings back every service
token it held, including ones rotated or removed since: after a restore the
owner rotates every service token and removes again any service removed since
the backup, which `api access list` shows.

## Connect as a teammate

The teammate authenticates with their own GitHub account and selects the URL
shared with them:

```bash
anycloud login https://<cluster-id>.anycloud.sh
anycloud api use https://<cluster-id>.anycloud.sh
anycloud api status
anycloud list
```

No invitation token or organization check is involved. The GitHub account used
by `anycloud login` must be the same account that was added. Login exchanges
that sign-in for the teammate's own API token; the hosted API accepts nothing
else. See [API tokens](/reference/cli/api-utilities#api-tokens) for CI and for
rotating a token.

## What is shared

| Resource or capability              | Behavior                                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------ |
| Jobs, Services, and VMs             | Shared API-wide; anyone can operate on any creator's workload when its type and state support it |
| API access list                     | Anyone with access can read it; only the owner adds or removes members                           |
| Cloud credentials and named secrets | Shared; anyone can use and manage them                                                           |
| Spend controls                      | Shared API-wide; alerts attribute multi-account waiting and budget spend                         |
| `anycloud db` inspection            | Read-only, but covers the API-wide database rather than only the caller's rows                   |

`anycloud list` covers everyone's workloads on a shared API. When the
returned rows include another account's work, it adds a `USER` column naming
who created each one, even if that account is the only creator in the result.
Narrow to one person with `--user`; the interactive summary also offers "by
user" when several creators are present. Agent invocations continue to scope
themselves to their own session automatically, so parallel agents still do not
see each other's work.

```bash
anycloud list --user octocat
anycloud cost --user octocat
```

`anycloud cost` reports the whole API's spend and breaks it down per user, so a
shared total is never mistaken for one person's. The breakdown appears even
when one teammate accounts for the entire result and is omitted only when all
reported spend belongs to the caller.

The GitHub account that created each workload is recorded permanently and is
never rewritten.

This is a trusted-team access model, not tenant isolation. If users need
separate credentials, secrets, or administrative boundaries, run separate
hosted APIs.

## Remove access

The owner removes a member by the GitHub username or immutable account ID shown
by the access list:

```bash
anycloud api access remove octocat
anycloud api access remove 583231
```

Removal blocks the account's next authenticated request, including when its
GitHub identity was already cached. A request admitted before removal may still
finish.

Removal does not stop or transfer work the member already submitted. Queued,
running, retrying, and cleaning workloads continue to be managed by the hosted
API, retain their original creator attribution, and remain visible and
terminable by every remaining member. Review them deliberately after removal:

```bash
anycloud list --user 583231
```

Workloads belong to the hosted API; membership only controls who can reach
that API. This separation prevents a departing member's live workloads from
becoming orphaned and continuing to spend without anyone being able to stop
them.

Removing API access cannot revoke copies of cloud credentials or named secrets
the member may already have seen. Rotate sensitive shared credentials and
secrets as part of security-related offboarding.

GitHub organization membership is not consulted, so removing a person from an
organization does not affect their Anycloud access.

## Upgrade a hosted API

Update the CLI first, then upgrade the hosted API:

```bash
anycloud update
anycloud api upgrade
```

With a hosted API active, `api upgrade` (alias `update`) asks the
cluster-hosted API to upgrade, without Docker or the local API. It refuses
while the hosted API still has node pools, Deployments or node pool Services,
naming each; see [`api upgrade`](/reference/cli/cluster). From any machine, the
hosted API first brings the cluster's K3s configuration to the new release's from a Job
on the management Node, briefly restarting the Kubernetes API server when it
changed, and labels the management Node with the label that the API and its
Traefik select. See [`api upgrade`](/reference/cli/cluster).

The hosted API is asked directly for this CLI's release. It refuses an image that is not the
official digest-pinned API image, or one older than the version its database
was last used by (the same rule the API applies to itself at startup). It then
**backs its database up** to the cluster's checkpoint bucket (see
[Back up and restore](#back-up-and-restore)), records the
upgrade, and patches its own Helm release through its in-cluster
ServiceAccount, against the cluster record it wrote on its first start. The
patch moves the release to the new image and the chart published with it, so
new chart templates and permissions arrive in the same Helm run.
helm-controller recreates the API Deployment with the new image; the chart's
pre-upgrade guard refuses stale revisions. An image released before 0.1.68
names no chart, so the API refuses to upgrade to it.

Upgrading from 0.1.67 or earlier takes a second Helm run: that release patches
only the image, and the new API then applies its own chart. That run repeats
the ready check, so `anycloud api status` can briefly show `Upgrade N` as
`starting` again, or `failed` if it does not pass. The API stays `running`
throughout.

The API Pod is replaced, so the API is unavailable for a short while, and
when upgrading from 0.1.67 or earlier once more if the chart run restarts it.
A stopping API answers `API_RESTARTING` (HTTP 503). The CLI retries through the gap
for about two minutes; the CLI prints `API restarting, waiting…` once. Commands
that may have taken effect, such as `api access add`, still fail and ask you to
check the result before retrying.

The command returns once the upgrade is recorded, and prints `Hosted API
upgrade N started`. Follow it with:

```bash
anycloud api status --watch
```

It prints each change until the upgrade is `running` or `failed`, then shows the served version and the schema version, then `Upgrade N ·
<version>` with one line: `◌ starting` until the new release's ready check
passes, `✓ running` after that, or `✗ failed` with the reason. It also shows
how many replicas of the native Deployment are ready. `anycloud api upgrade --image
ghcr.io/anycloud-sh/api:<version>@sha256:<digest>` pins an exact image
instead of this CLI's release. An image **older** than the served one is
refused: each start stamps the database with its version, and an older image
would refuse to run against it. To go back, restore the pre-release backup,
the previous object version in the bucket; see
[Recover after losing the management VM](/reference/cli/cluster#recover-after-losing-the-management-vm).
These two calls and the token exchange accept the previous release's CLI or
any newer one. Workload and credential read, quota status, cost
and token rotation requests accept this release's or the previous release's
CLI, so a CLI pinned to one release keeps working through the next upgrade.
Upgrade the Python SDK together with the API. Every
other request needs this release's, so run `anycloud update` first.

The active target does not change.

## Back up and restore

The hosted API keeps its database on the cluster and backs it up hourly and
before every update to the checkpoint bucket, as `anycloud-api/database.sqlite`
with the cipher key (`anycloud-api/cipher.key`) and a manifest
(`anycloud-api/backup.json`). History is the bucket's object versioning; on a
bucket you supplied, the hourly backup starts only once versioning is on and
the API restarts. **Anyone
who can read the bucket can decrypt every stored credential, secret and API
token**, so keep it private.

If the management VM is lost, run the same `anycloud cluster create` with
`--checkpoint-bucket` set to that bucket. The restored API keeps the cluster id
and URL and adopts the new cluster; up to one backup interval of changes is
lost. The
installer that created the cluster, or a fresh one, can restore; either is
refused while the cloud still shows the lost management VM, so two APIs never
write the same bucket. See
[Recover after losing the management VM](/reference/cli/cluster#recover-after-losing-the-management-vm).
After a restore, every member runs `anycloud api token rotate`, and the owner
rotates every service token and removes again any service removed since the
backup: the backup brings back the API tokens it held. Restoring the backup taken by
`api upgrade` also drops what the new API recorded.

## Retire a hosted API

Retire the workloads it runs, then the cluster — the first step against the
hosted API, the last on the installer API that created the cluster:

```bash
anycloud api use https://<cluster-id>.anycloud.sh
anycloud terminate <id>                # every Job, Service and VM
anycloud api use local
anycloud cluster delete prod
```

`cluster delete` asks the hosted API what it still manages and is refused,
naming each, while an API from an earlier release still has node pools; see
[`anycloud cluster`](/reference/cli/cluster#inspect-and-delete) for what delete
removes and what to do when the hosted API is unreachable. Delete keeps the
checkpoint bucket, with the database and its cipher key, so the cluster can be
restored; run `anycloud cluster delete <cluster-id> --delete-buckets` (it asks
you to type the cluster name) to delete it too.

## Migrate an existing VM-hosted API

Create a successor with `anycloud cluster create`, then select its URL with
`anycloud api use`. The new API starts with an empty database: add its cloud
credentials with `anycloud credentials new` and restore team access with
`anycloud api access add`. Workloads and access entries are not transferred
from the old API automatically. Hosting the API without Kubernetes, including
on Lambda, is no longer offered.

Before retiring the old API, use its compatible CLI version to review and
terminate the workloads it manages:

```bash
anycloud api use https://team-api.anycloud.sh
anycloud list
anycloud terminate <workload-id>
```

Then return to the installer API and terminate the old hosted Service, which
also removes its public API record:

```bash
anycloud api use local
anycloud terminate team-api
anycloud status team-api --watch
```

Termination stops the hosted API and completes a final checkpoint upload before
removing its VM. Check `anycloud status team-api --json` and wait for
`workload.cleanedAt` before deleting the state bucket. Bucket deletion is
separate and permanently removes the hosted API's retained database and key:

```bash
anycloud bucket delete my-api-state \
  --credentials my-aws \
  --region us-east-1
```

`anycloud api stop` stops only the local Docker API; it does not stop a hosted
API. To replace the original owner or rotate the entire trust boundary, deploy
a fresh hosted API and retire the old one.

## Troubleshooting

- Run `anycloud api status` and confirm the intended hosted URL is active.
- Run `anycloud cluster status <name>` against the installer API to inspect
  the cluster that hosts the API.
- Run `anycloud login <api-url>` again if a teammate authenticated with a
  different GitHub account, or after a token was rotated.
- Confirm an access entry with `anycloud api access list`.
- Update the CLI and hosted API if a CLI/API version mismatch is reported:
  `anycloud update`, then `anycloud api upgrade`.

See [`api` and utilities](/reference/cli/api-utilities) for exact command syntax
and options.

---
title: Hosted APIs
description: Create, select, share, upgrade, restore, and delete an Anycloud API running in your cloud account.
---

# Hosted APIs

Every Anycloud command talks to one active API. A local API runs in Docker on
your machine. A hosted API runs in your cloud account and has a stable public
URL, so you can use it from multiple machines or share it with trusted
teammates.

A hosted API runs on its own Kubernetes cluster: a management VM in your cloud
account running a pinned K3s server, with the API installed on it as a Helm
release. The VMs, VM Jobs and VM Services you run through it each get VMs of
their own, as they do through a local API.

An existing VM-hosted API, created by the removed `anycloud api serve`, can
only be terminated; [migrate it](#migrate-an-existing-vm-hosted-api) to a
cluster-hosted API.

Hosting changes where the API runs; it does not create tenant isolation.
Everyone admitted to one hosted API shares its operational resources and trust
boundary.

## Create a hosted API

You need the cloud's own CLI on this machine, signed in to the account that
will run the management VM: `aws` for AWS, `gcloud` with a project set for
GCP, or `az` for Azure. The signed-in identity needs the
[cloud rights](/reference/cli/api-utilities#cloud-rights) create checks.
Lambda can't host an API. Run `anycloud login` too: the hosted API requires
GitHub authentication. Create needs no Docker, no local API and no saved cloud
credential.

```bash
anycloud api create prod \
  --cloud aws \
  --region us-east-2 \
  --vm-type t3.medium
```

`create` checks the identity's rights, creates the management VM through the
cloud CLI, publishes the API's DNS record once the VM has an address, and
returns once the API answers at its URL and its first backup has landed:

```text
[12:00:00] Using aws account 123456789012 as arn:aws:iam::123456789012:user/ops
[12:00:01] Creating cluster prod (ID: <cluster-id>)
[12:00:02] Deploying the management VM in us-east-2
[12:02:40] Published <cluster-id>.anycloud.sh at <management-vm-ip>
[12:02:51] Waiting for the API and its first backup
✓ Cluster prod is running.
Next: anycloud api use https://<cluster-id>.anycloud.sh
```

Creation takes a few minutes. If it stops, **re-running the same `create`
resumes** it, from this machine or another. Pass `--checkpoint-bucket <name>`
to back the database up to a bucket you own; without it a managed bucket is
created. A bucket that already holds a backup makes `create` a
[restore](#back-up-and-restore). See
[`api create`](/reference/cli/api-utilities#create-a-hosted-api) for every
flag.

Point the CLI at it:

```bash
anycloud api use https://<cluster-id>.anycloud.sh
anycloud credentials new aws
```

Unless it was restored, the hosted API starts with an empty database: add the
credentials your Workloads will use, then run [Jobs](/platform/jobs),
[Services](/platform/services) and [VMs](/platform/vms) as you would against a
local API. `anycloud cluster status <name>` shows the cluster it runs on.

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
their own. Apart from managing access and deleting the hosted API, which only its owner
can do, there is no admin role inside it.

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

```text
✓ Hosted API upgrade 1 started: <old-version> → <version>.
```

With a hosted API active, `api upgrade` (alias `update`) asks it directly for
this CLI's release, without Docker or the local API, from any machine. It
refuses while the hosted API still has node pools, Deployments or node pool
Services, naming each. An older CLI skips that check, so the release's
pre-upgrade hook repeats it against the running API's database and fails the
upgrade before the API Pod is replaced: the hosted API keeps serving on its
release. That CLI reports only `BackoffLimitExceeded`; the reason is in
`kubectl logs job/anycloud-api-guard-<revision>` on the management VM, and this
release's `api upgrade` names each one. Remove them, then upgrade again. The hosted API first brings the cluster's K3s
configuration to the new release's, briefly restarting the Kubernetes API
server when it changed. It refuses an image that is not the official
digest-pinned API image, or one older than the version its database was last
used by. It then **backs its database up** to the checkpoint bucket, records
the upgrade, and patches its own Helm release to the new image and its chart.
An API already on that release answers
`Hosted API <url> already matches anycloud <version>.`; a refused upgrade
prints `Hosted API upgrade refused: <reason>` and exits 1.

The API stays `running` while its Pod is replaced, but is unavailable for a
short while. A stopping API answers `API_RESTARTING` (HTTP 503); the CLI
prints `API restarting, waiting…` once and retries for about two minutes.
Commands that may have taken effect, such as `api access add`, still fail and
ask you to check the result before retrying. Upgrading from 0.1.67 or earlier
takes a second Helm run, so the upgrade can briefly show `starting` again.

Follow the upgrade:

```bash
anycloud api status --watch
```

```text
⚡  running

   URL      https://<cluster-id>.anycloud.sh
   Source   ~/.anycloud/api-url
   Version  <version>
   Schema   <version>

   Upgrade 1 · <version>
   ✓ api  running · 1/1 ready
```

The upgrade line reads `◌ starting` until the new release's ready check
passes, then `✓ running`, or `✗ failed` with the reason. `--watch` prints each
change until then; without it, `api status` reads once.

`anycloud api upgrade --image ghcr.io/anycloud-sh/api:<version>@sha256:<digest>`
pins an exact image instead of this CLI's release. An image **older** than the
served one is refused: each start stamps the database with its version, and an
older image would refuse to run against it. To go back, restore the
pre-upgrade backup, the previous object version in the bucket.

`api upgrade`, `api status` and the token exchange accept the previous
release's CLI or any newer one. Workload and credential reads, quota status,
cost and token rotation accept this release's or the previous release's CLI,
so a CLI pinned to one release keeps working through the next upgrade. Every
other request needs this release's, so run `anycloud update` first. Upgrade
the Python SDK together with the API. See
[`api upgrade`](/reference/cli/api-utilities#upgrade-the-api) for the details
and its JSON result.

## Back up and restore

The hosted API backs its database up hourly and before every upgrade to the
checkpoint bucket, as `anycloud-api/database.sqlite` with the cipher key
(`anycloud-api/cipher.key`) and a manifest (`anycloud-api/backup.json`).
History is the bucket's object versioning; on a bucket you supplied, the
hourly backup starts only once versioning is on and the API restarts.
**Anyone who can read the bucket can decrypt every stored credential, secret
and API token**, so keep it private.

If the management VM is lost, run the same `anycloud api create` with
`--checkpoint-bucket` set to the cluster's bucket (its ID for a managed
bucket). The restored API keeps the cluster ID and URL and adopts the new
cluster; up to an hour of changes is lost. Restore is refused while the cloud
still shows the lost management VM, so two APIs never write the same bucket.
See [Back up and restore](/reference/cli/api-utilities#back-up-and-restore).

After a restore, every member runs `anycloud api token rotate`, and the owner
rotates every service token and removes again any service removed since the
backup: the backup brings back the API tokens it held. Restoring the backup
taken by `api upgrade` also drops what the new API recorded.

A backup that still has live node pools, Deployments or node pool Services
can't be restored by this release: the API refuses to start and names them.
Restore it with the release that took it, remove them there, then upgrade.

## Delete a hosted API

Terminate its Workloads, then delete it, both against the hosted API. Only the
owner can delete it:

```bash
anycloud api use https://<cluster-id>.anycloud.sh
anycloud terminate <id>                # every Job, Service and VM
anycloud api delete prod
```

The API refuses while a Job, Service or VM still runs, naming each. Otherwise
it takes a final backup, deletes its Workloads' leftovers and asks its cloud
to delete its own stack, group or instance; the CLI follows it until your
cloud CLI shows it gone, then removes the DNS record. The checkpoint bucket is
kept with its backups, and the result prints its restore command and the
command that deletes it later: `anycloud api delete <cluster-id>
--delete-buckets` (it asks you to type the cluster ID).

If the hosted API is **gone**, run `anycloud api delete <cluster-id> --cloud
<cloud> --region <region>` from any machine whose cloud CLI is signed in to
the cluster's account. It lists what it would delete, and deletes only what
`--delete-vms` and `--delete-buckets` name; see
[Delete with the hosted API gone](/reference/cli/api-utilities#delete-with-the-hosted-api-gone).

## Migrate an existing VM-hosted API

Create a successor with `anycloud api create`, then select its URL with
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

Then return to the local API that created it and terminate the old hosted
Service, which also removes its public API record:

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
- Run `anycloud cluster status <name>` to inspect the cluster that hosts the
  API.
- Run `anycloud login <api-url>` again if a teammate authenticated with a
  different GitHub account, or after a token was rotated.
- Confirm an access entry with `anycloud api access list`.
- Update the CLI and hosted API if a CLI/API version mismatch is reported:
  `anycloud update`, then `anycloud api upgrade`.

See [`api` and utilities](/reference/cli/api-utilities) for exact command syntax
and options.

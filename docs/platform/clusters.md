---
title: Clusters
description: Create the installation's Kubernetes cluster, point the CLI at the API it hosts, upgrade it, and take it down.
---

# Clusters

An Anycloud installation has **one Kubernetes cluster**: a management VM in
your cloud account running a pinned K3s control plane, with the Anycloud API
installed on it as a Helm-managed release. The cluster is the hosted API's
home. The Jobs, Services and VMs you run through the hosted API each get VMs of
their own in your cloud account, as they do through a local API.

This guide walks the path the live AWS runs prove, in order: create the
cluster, point the CLI at the API it hosts, update the hosted API, and take
everything down. Each command's output below is what the CLI prints; ids and
addresses are placeholders.

Terminology: the **cluster** is the installation's Kubernetes cluster.
**Workload** is a Job, Service or VM.

## Before you start

- The cloud's own CLI on this machine, signed in to the account that will run
  the management VM: `aws` for AWS, `gcloud` with a project set for GCP, or
  `az` for Azure. Lambda does not support cluster creation. The signed-in
  identity needs the [cloud rights](/reference/cli/cluster#cloud-rights)
  create checks.
- `anycloud login`, because the hosted API requires GitHub authentication.

Create needs no Docker, no local API and no saved cloud credential.

## 1. Create the cluster

```bash
anycloud cluster create prod \
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

A live AWS creation takes a few minutes. If it stops, **re-running the same
`create` resumes** the cluster, from this machine or another. Pass
`--checkpoint-bucket <name>` to back the hosted API's database up to a bucket
you own; without it a managed bucket is created, and `cluster delete` keeps it
with its backups unless you pass `--delete-buckets`. A bucket that already holds a backup
(`anycloud-api/backup.json`) makes `create` a [restore](#recover-a-lost-cluster)
that keeps the cluster ID and URL. See [`anycloud cluster`](/reference/cli/cluster)
for every flag.

## 2. Point the CLI at the hosted API

```bash
anycloud api use https://<cluster-id>.anycloud.sh
```

From here every command runs against the API on the cluster. Unless it was
restored from a backup, it starts with an empty database: add the credentials
your Workloads will use, and share the API with teammates if you want to
([Hosted APIs](/platform/hosted-apis#give-someone-access)).

```bash
anycloud credentials new aws
```

Then run [Jobs](/platform/jobs) (`anycloud job`),
[Services](/platform/services) (`anycloud service`) and [VMs](/platform/vms)
(`anycloud vm`) as you would against a local API.

## 3. Upgrade the hosted API

When a new CLI release is installed, upgrade the API it talks to. Against the
cluster-hosted API the command asks the API for this CLI's release, backs the
database up to the checkpoint bucket and patches the API's own Helm release:

```bash
anycloud update
anycloud api upgrade
```

```text
✓ Hosted API upgrade 1 started: <old-version> → <version>.
```

An API already on that release answers
`Hosted API <url> already matches anycloud <version>.`; a
refused upgrade prints `Hosted API upgrade refused: <reason>` and exits 1.
The API stays `running` while it is replaced. Follow the upgrade:

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

The upgrade line reads `◌ starting` until the new release's ready check passes,
then `✓ running`, or `✗ failed` with the reason. `--watch` prints each change
until then; without it, `api status` reads once.

See [Hosted APIs](/platform/hosted-apis#upgrade-a-hosted-api) for backups,
`--image`, and why an older image is refused.

## 4. Take it down

Teardown runs against the hosted API, and the cluster's own delete goes
through it too. The API refuses while a Job, Service or VM still runs, naming
each, and while an API from an earlier release still has node pools.

```bash
anycloud api use https://<cluster-id>.anycloud.sh
anycloud terminate <id>
anycloud cluster delete prod
```

The hosted API takes a final backup, deletes its Workloads' leftovers and
asks its cloud to delete its own stack, group or instance; the CLI follows it
until your cloud CLI shows it gone, then removes the DNS record. The
checkpoint bucket is kept with its backups unless you pass `--delete-buckets`,
and the result prints its restore command and the command that deletes it
later.

If the hosted API is **gone**, run `anycloud cluster delete <cluster-id>
--cloud <cloud> --region <region>` from any machine whose cloud CLI is signed
in to the cluster's account: it lists what it would delete, and deletes only
what `--delete-vms` and `--delete-buckets` name (see
[Delete with the hosted API gone](/reference/cli/cluster#delete-with-the-hosted-api-gone)).

## Recover a lost cluster

If the management VM is lost, run the same `anycloud cluster create` with
`--checkpoint-bucket` set to the cluster's bucket (its id for a managed
bucket). The restored API keeps the cluster id and URL; up to an hour of
changes is lost, and the hourly backup needs bucket versioning
(see [Back up and restore](/platform/hosted-apis#back-up-and-restore)).
Restore is refused while the cloud still shows the lost management VM. See
[Recover after losing the management VM](/reference/cli/cluster#recover-after-losing-the-management-vm).

## What runs where

| Concern                                             | Where it lives                                                                                                                         |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Cluster record, creation ledger, cluster credential | The installer API (`anycloud cluster list` there)                                                                                      |
| Hosted API database and encryption key              | The `anycloud-api-state` volume on the cluster; hourly backups in the checkpoint bucket, read only by a restore                        |
| Workloads and their credentials                     | The hosted API                                                                                                                         |
| Authority over the cluster                          | The hosted API's own ServiceAccount; nothing is stored or exported — see [Cluster authority](/reference/cli/cluster#cluster-authority) |
| Public entry                                        | `https://<cluster-id>.anycloud.sh` (Cloudflare → management VM → Traefik → API)                                                        |

---
title: cluster
description: Inspect the Kubernetes cluster a hosted API runs on.
---

# `anycloud cluster`

A hosted API runs on its own Kubernetes cluster: a management VM in your cloud
running a pinned K3s server and the Anycloud API released onto it as a Helm
chart. [`anycloud api create`](/reference/cli/api-utilities#create-a-hosted-api)
builds it and
[`anycloud api delete`](/reference/cli/api-utilities#delete-a-hosted-api)
deletes it; `cluster` inspects it.

```bash
anycloud cluster list|ls|get [--json]
anycloud cluster status|describe <id-or-name> [--watch] [--interval <seconds>] [--json]
```

`list` shows the clusters this API knows with their location, VM type, age,
address, installed API version and state; `status` shows one in the Workload
status layout (state, cloud, VM, address, Kubernetes and API versions, URL,
age and last error), and `--watch` refreshes it until the cluster
is `running`, `failed` or fully `terminated`. Against a hosted API, its own
cluster shows the cloud, account, region and VM type from its record, and the
address, API version and URL it knows of itself.

`--json` reports these fields:

| Field                                                   | Meaning                                                                                              |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `id`, `name`, `state`, `releasing`                      | Record identity, the Workload state, and whether the management VM is still being released           |
| `cloudProvider`, `region`, `zone`, `vmType`             | Where the management VM runs (null on a hosted API's record from before 0.1.74)                      |
| `cloudAccount`                                          | The AWS account, GCP project or Azure subscription; on the hosted API's record only                  |
| `managementVmId`, `networkScope`                        | The management VM's provider ID and the `anycloud-cluster-<id>` name of its network resources        |
| `k3sVersion`, `apiVersion`, `apiImage`, `chartVersion`  | The pinned control plane, the installed API and its chart                                            |
| `connected`, `kubernetesIdentity`, `connectionRevision` | Whether the installer can reach the cluster, the observed `kube-system` UID, the connection revision |
| `address`                                               | The management VM's public address                                                                   |
| `managementApiUrl`                                      | `https://<cluster-id>.anycloud.sh`, the `anycloud api use` target; an installer's once released      |
| `release`                                               | The installed API release: `apiVersion`, `apiImage`, `chartVersion`; null until it is installed      |
| `checkpointBucket`                                      | `name` and `managed` of the hosted API's backup bucket; null once `--delete-buckets` deleted it      |
| `lastError`                                             | The last reconciliation error, or null                                                               |

## Lifecycle states

The Workload states: `provisioning`, `initializing` and `starting` while it is
created, `failed` (a failed create or delete; a failed delete's `Last error:` starts
with `Delete failed:`), and `terminated` (with the "releasing" label while the management VM
is still being released). The
record is removed only by `anycloud api delete`.

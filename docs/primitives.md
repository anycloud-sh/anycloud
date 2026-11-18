---
slug: /primitives
title: Primitives
description: Choose Jobs, Services, VMs, Kubernetes Deployments, and Buckets based on workload lifecycle, access, and persistence.
---

# Primitives

Jobs, Services, and VMs are the three Workload types. Kubernetes Deployments
provide reusable applications that accept Jobs, and Buckets provide storage
that persists independently of compute. Choose the resources that match your
workload's lifecycle and access needs.

| Primitive                                           | Choose it when                             | Lifetime                     | Primary access                             |
| --------------------------------------------------- | ------------------------------------------ | ---------------------------- | ------------------------------------------ |
| [Job](/platform/jobs)                               | Work should run to completion              | Until a terminal outcome     | Status; logs and `exec` for VM-backed Jobs |
| [Service](/platform/services)                       | An HTTP workload should stay online        | Until upgrade or termination | Stable public URL                          |
| [VM](/platform/vms)                                 | You need direct, interactive control       | Until termination            | SSH to the container or host               |
| [Kubernetes Deployment](/reference/cli/deployments) | Jobs should share a persistent application | Until deletion               | Targeted Jobs and Deployment status        |
| [Bucket](/platform/buckets)                         | Data must outlive its compute              | Until the bucket is deleted  | Mounted files in supported workloads       |

Jobs are the default for finite work such as training, evaluation, and batch
inference. Services manage long-running HTTP workloads and give them a stable
public URL. VMs provide an interactive shell and direct host control without a
managed HTTP endpoint. Buckets complement supported Jobs and Services with
durable object storage; they are not a compute environment.

Jobs run on dedicated VMs or target Kubernetes Deployments on shared
[node pool](/reference/cli/node-pools) capacity. A targeted Job runs inside the
Deployment's existing application container; the application remains available
after that Job ends. Services run on VMs or on node pools. Workload remains the shared record
for Jobs, Services, and VMs; each Deployment has its own record and lifecycle.
